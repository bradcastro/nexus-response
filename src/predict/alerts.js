// Proactive alert generation + store + lifecycle. Pure logic; SSE delivery is injected by data.js.
const crypto = require('crypto');
const { ALERT, IND, INTERVENTIONS, MODEL } = require('./config');
const { driverImpact } = require('./analyze');

const store = new Map(); // id -> alert
const listeners = new Set();
const onChange = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = (alert, change) => { for (const fn of listeners) { try { fn(alert, change); } catch (e) { /* listener errors must not break evaluation */ } } };

const SEV = { critical: 4, high: 3, medium: 2, low: 1 };
const pct = (p, d = 1) => `${(p * 100).toFixed(d)}%`;
const usd = (n) => '$' + Math.round(n / 100) * 100;
const idFor = (kind, fleetId, subjectId) => 'PA-' + crypto.createHash('sha1').update(`${kind}|${fleetId}|${subjectId}`).digest('hex').slice(0, 8).toUpperCase();
const sevFromP = (p) => (p >= MODEL.BASE_P30 * 5 ? 'critical' : p >= MODEL.BASE_P30 * 3.2 ? 'high' : 'medium');

function backtestLine(bt) {
  if (!bt || !bt.collisions) return null;
  return `Backtest: this fleet's model flagged ${bt.caught} of ${bt.collisions} past collisions in advance${bt.medianLeadDays != null ? ` (median ${bt.medianLeadDays} days warning)` : ''}.`;
}

// Build candidate alerts for a fleet analysis. factor<1 loosens thresholds (hysteresis for keep-alive).
function candidates(A, factor = 1) {
  const out = [];
  const bt = A._.backtest;
  const btLine = backtestLine(bt);
  const asOf = Date.parse(A.asOf);
  const wc = A._.wctx;
  const pFlag = ALERT.P_FLAG * factor;
  const mkDriver = (d, kind, sev, headline, rationale, action, horizonHours, extraImpactKey, probability) => {
    const imp = driverImpact(wc, d.driverId, extraImpactKey || d.recommendedInterventionKey);
    const flagStart = A._.flagStart.get(d.driverId);
    const created = flagStart && asOf - flagStart <= 14 * 86400000 ? flagStart : asOf;
    out.push({
      key: `${kind}|${d.driverId}`, kind, severity: sev, subject: { type: 'driver', id: d.driverId, name: d.name }, headline,
      rationale: [...rationale, d.daysSinceLastCoaching != null ? `Last coaching ${d.daysSinceLastCoaching} days ago.` : 'No coaching on record in the available history.', ...(btLine ? [btLine] : [])],
      probability: Math.round(probability * 1000) / 1000, horizonHours, recommendedAction: action,
      expectedImpact: imp ? `${imp.intervention.label}: this driver's 30-day modeled collision-risk indicator (illustrative) ${pct(imp.before)} -> ${pct(imp.after)} (-${Math.round(imp.reductionPct)}%), about ${usd(imp.avoidedLossUsd90d)} expected loss avoided over 90 days (demo assumptions).` : 'Impact not estimated.',
      createdAt: created, lat: d.lat, lng: d.lng, evidence: { collisionProb30d: d.collisionProb30d, riskNow: d.riskNow, escalation: d.escalation },
    });
  };
  for (const d of A._.drivers) {
    const sig = Object.fromEntries(d.signals.map((s) => [s.key, s]));
    const cnt = (k) => (sig[k] ? sig[k].value : 0);
    const trendTxt = (s) => `${s.label}: ${s.value} event${s.value === 1 ? '' : 's'} in 30d (${s.trendPct >= 0 ? '+' : ''}${s.trendPct}% vs 14 days ago)`;
    const rel = d.relativeRisk;
    // 1. overall risk spike
    if ((d.collisionProb30d >= pFlag || (d.escalation >= ALERT.ESC_FLAG * factor && d.collisionProb30d >= ALERT.ESC_MIN_P * factor)) && d.eventsLast30d >= 2) {
      mkDriver(d, 'driver_risk_spike', sevFromP(d.collisionProb30d), `${d.name}: collision risk ${pct(d.collisionProb30d)} next 30 days (${rel}x reference)${d.trend === 'up' ? ', rising' : ''}`,
        [`Modeled collision-risk indicator (illustrative) ${pct(d.collisionProb30d)} (${rel}x the ${pct(MODEL.BASE_P30)} reference driver).`, ...d.signals.slice(0, 3).map(trendTxt), ...(d.escalation >= 1 ? ['Escalation pattern: risky events accelerating compared with the prior 4 weeks (the typical pre-collision signature).'] : [])],
        `Coach ${d.name.split(' ')[0]} now: ${d.recommendedIntervention}.`, 720, null, d.collisionProb30d);
    }
    // 2. fatigue pattern
    const drowsy = cnt('drowsiness'), night = cnt('night_hours'), lane = cnt('lane_departure');
    if ((drowsy >= 2 * factor || (night >= 3 && (lane >= 1 || drowsy >= 1 || cnt('harsh_braking') >= 1))) && d.collisionProb30d >= MODEL.BASE_P30 * 1.5 * factor) {
      const why = [];
      if (drowsy) why.push(`${drowsy} driver-drowsiness event${drowsy > 1 ? 's' : ''} in 30d (driver-facing camera)`);
      if (night) why.push(`${night} risky events during night hours (22:00-05:59)`);
      if (lane) why.push(`${lane} lane departure${lane > 1 ? 's' : ''}`);
      mkDriver(d, 'fatigue_pattern', drowsy >= 3 ? 'high' : 'medium', `${d.name}: fatigue pattern - ${why[0]}`, [...why, `Combined modeled collision-risk indicator ${pct(d.collisionProb30d)} next 30 days.`],
        'Review duty-hour logs, adjust dispatch away from late-night legs, and run a fatigue check-in.', 336, 'fatigue_program', Math.min(0.95, Math.max(d.collisionProb30d, MODEL.BASE_P30 * 2)));
    }
    // 3. following distance trend
    const fd = sig.following_distance;
    if (fd && (fd.value >= 3 * factor || (fd.f >= 2 && fd.trendPct >= 50)) && d.collisionProb30d >= MODEL.BASE_P30 * 1.5 * factor) {
      mkDriver(d, 'following_distance_trend', fd.f >= 2.5 ? 'high' : 'medium', `${d.name}: tailgating trend ${fd.trendPct >= 0 ? '+' : ''}${fd.trendPct}% (${fd.value} events in 30d)`,
        [trendTxt(fd), `Rear-end collisions are the most common outcome of persistent short following distance; combined modeled collision-risk indicator ${pct(d.collisionProb30d)}.`],
        'Enable in-cab following-distance alerts and coach on 6-second spacing.', 504, 'following_distance_alerts', d.collisionProb30d);
    }
  }
  // vehicle alerts
  for (const v of A._.vehicles) {
    const label = v.unit || v.vehicleId;
    if (v.breakdownProb30d >= 0.2 * factor && (v.openDtcs > 0 || v.recurringCodes > 0)) {
      out.push({
        key: `vehicle_breakdown_risk|${v.vehicleId}`, kind: 'vehicle_breakdown_risk', severity: v.breakdownProb30d >= 0.45 ? 'critical' : v.breakdownProb30d >= 0.3 ? 'high' : 'medium',
        subject: { type: 'vehicle', id: v.vehicleId, name: `${label}${v.driverName ? ' (' + v.driverName + ')' : ''}` }, headline: `${label}: ${Math.round(v.breakdownProb30d * 100)}% chance of breakdown in 30 days`,
        rationale: [...v.topFactors, ...(v.topDtc ? [`Latest fault: ${v.topDtc}.`] : [])], probability: v.breakdownProb30d, horizonHours: v.openCriticalDtcs ? 168 : 720, recommendedAction: v.recommendedAction,
        expectedImpact: `A planned shop visit avoids an unplanned roadside event (~$1,900 average breakdown cost incl. tow and downtime, demo assumption).`, createdAt: Date.parse(v.lastIncidentAt || A.asOf) || asOf, lat: v.lat, lng: v.lng, evidence: { openDtcs: v.openDtcs, recurringCodes: v.recurringCodes },
      });
    }
    if (v.openDtcs > 0 && v.daysSinceFirstOpenDtc >= 5 * factor) {
      out.push({
        key: `maintenance_overdue|${v.vehicleId}`, kind: 'maintenance_overdue', severity: v.openCriticalDtcs ? 'high' : 'medium', subject: { type: 'vehicle', id: v.vehicleId, name: label },
        headline: `${label}: fault code unresolved for ${Math.round(v.daysSinceFirstOpenDtc)} days`, rationale: [`${v.openDtcs} open fault code${v.openDtcs > 1 ? 's' : ''}${v.faultLampOn ? ', fault lamp on' : ''}.`, ...(v.topDtc ? [`Latest fault: ${v.topDtc}.`] : []), `Breakdown probability ${Math.round(v.breakdownProb30d * 100)}% next 30 days.`],
        probability: v.breakdownProb30d, horizonHours: 168, recommendedAction: 'Book maintenance and close the open diagnostic incident.', expectedImpact: 'Clearing the backlog removes the vehicle from the elevated breakdown cohort.', createdAt: asOf, lat: v.lat, lng: v.lng, evidence: { daysOpen: v.daysSinceFirstOpenDtc },
      });
    }
  }
  // hotspots
  for (const h of A.hotspots) {
    if (h.forming && h.riskScore >= 25 * factor) {
      out.push({
        key: `hotspot_forming|${h.id || h.label}`, kind: 'hotspot_forming', severity: h.collisions ? 'high' : 'medium', subject: { type: 'route', id: h.id || h.label, name: h.label }, headline: `Hotspot forming near ${h.label}: ${h.recentIncidents14d} events in 14 days`,
        rationale: [`${h.incidents} weighted events clustered within 6 miles in 60 days (${h.recentIncidents14d} in the last 14).`, `Dominant event type: ${String(h.topEventType).replace('_', ' ')}.`, ...(h.collisions ? [`${h.collisions} collision(s) in the cluster.`] : [])],
        probability: Math.round(Math.min(0.95, 1 - Math.exp(-h.recentIncidents14d * 0.35)) * 100) / 100, // P(>=1 more event in the corridor within 14 days)
        horizonHours: 336, recommendedAction: 'Brief drivers on this corridor, consider an alternate route or schedule shift, and review the clips.', expectedImpact: 'Route briefings typically reduce exposure-driven events at a hotspot by ~8-10% (demo assumption).', createdAt: asOf, lat: h.lat, lng: h.lng, radiusM: 9500, evidence: { lat: h.lat, lng: h.lng },
      });
    }
  }
  return out;
}

const DEFAULT_SUPPRESS = { dismissed: 14, actioned: 10 };

// Reconcile candidates against the store. Returns {created, updated, closed}.
function reconcile(A, { silent = false } = {}) {
  const fleetId = A.fleetId;
  const now = Date.now();
  const strong = candidates(A, 1);
  const keep = new Set(candidates(A, 0.8).map((c) => c.key));
  strong.forEach((c) => keep.add(c.key));
  const res = { created: [], updated: [], closed: [] };
  const seen = new Set();
  for (const c of strong) {
    const id = idFor(c.kind, fleetId, c.subject.id);
    seen.add(id);
    const ex = store.get(id);
    if (!ex) {
      const a = { id, createdAt: new Date(c.createdAt).toISOString(), fleetId, fleetName: A.fleetName, kind: c.kind, severity: c.severity, subject: c.subject, headline: c.headline, rationale: c.rationale, probability: c.probability, horizonHours: c.horizonHours, recommendedAction: c.recommendedAction, expectedImpact: c.expectedImpact, lat: c.lat != null ? c.lat : null, lng: c.lng != null ? c.lng : null, radiusM: c.radiusM || null, status: 'open', history: [{ t: new Date(now).toISOString(), actor: 'system', action: 'created', note: 'Generated by predictive model' }], updatedAt: new Date(now).toISOString(), evidence: c.evidence, _key: c.key };
      store.set(id, a); res.created.push(a); if (!silent) emit(a, 'new');
    } else if (ex.status === 'open' || ex.status === 'acknowledged') {
      const sevUp = SEV[c.severity] > SEV[ex.severity];
      const dP = Math.abs(c.probability - ex.probability);
      const pChanged = dP >= 0.01;
      Object.assign(ex, { headline: c.headline, rationale: c.rationale, recommendedAction: c.recommendedAction, expectedImpact: c.expectedImpact, evidence: c.evidence, lat: c.lat != null ? c.lat : ex.lat, lng: c.lng != null ? c.lng : ex.lng });
      if (sevUp) { ex.history.push({ t: new Date(now).toISOString(), actor: 'system', action: 'escalated', note: `Severity ${ex.severity} -> ${c.severity}` }); ex.severity = c.severity; }
      if (pChanged || sevUp) { ex.probability = c.probability; ex.updatedAt = new Date(now).toISOString(); res.updated.push(ex); if (!silent && (sevUp || dP >= 0.03)) emit(ex, 'update'); }
    } else {
      const last = ex.history[ex.history.length - 1];
      const ageDays = (now - Date.parse(last.t)) / 86400000;
      if (ageDays >= (DEFAULT_SUPPRESS[ex.status] || 14)) {
        Object.assign(ex, { status: 'open', severity: c.severity, probability: c.probability, headline: c.headline, rationale: c.rationale, updatedAt: new Date(now).toISOString() });
        ex.history.push({ t: new Date(now).toISOString(), actor: 'system', action: 'reopened', note: 'Condition persists after suppression window' });
        res.created.push(ex); if (!silent) emit(ex, 'new');
      }
    }
  }
  // auto-close open alerts whose condition has cleared
  for (const a of store.values()) {
    if (a.fleetId !== fleetId || seen.has(a.id) || !(a.status === 'open' || a.status === 'acknowledged')) continue;
    if (keep.has(a._key)) continue;
    a.status = 'dismissed'; a.autoClosed = true; a.updatedAt = new Date(now).toISOString();
    a.history.push({ t: a.updatedAt, actor: 'system', action: 'dismissed', note: 'Auto-closed: risk condition cleared' });
    res.closed.push(a); if (!silent) emit(a, 'update');
  }
  return res;
}

function transition(id, action, { note, actor, detail } = {}) {
  const a = store.get(id);
  if (!a) return { error: 'not_found' };
  const map = { ack: 'acknowledged', action: 'actioned', dismiss: 'dismissed' };
  const to = map[action];
  if (!to) return { error: 'bad_action' };
  if (a.status === to) return { alert: a };
  if (a.status === 'dismissed' || (a.status === 'actioned' && action !== 'dismiss')) return { error: 'invalid_transition', message: `Alert is already ${a.status}` };
  a.status = to; a.autoClosed = false; a.updatedAt = new Date().toISOString();
  if (detail) a.actionTaken = detail;
  a.history.push({ t: a.updatedAt, actor: actor || 'dispatcher', action: to === 'acknowledged' ? 'acknowledged' : to, note: [detail, note].filter(Boolean).join(': ') });
  emit(a, 'update');
  return { alert: a };
}

const pub = (a) => { const { _key, evidence, ...rest } = a; return { ...rest, evidence, illustrative: true, label: 'Illustrative risk indicator (synthetic demo data)', disclaimer: 'Demo-calibrated indicator, not a prediction of a specific event.' }; };
function list({ fleetId, status, kind, severity, limit = 50 } = {}) {
  const st = status ? String(status).split(',') : null;
  let rows = [...store.values()];
  if (fleetId) rows = rows.filter((a) => a.fleetId === fleetId);
  if (st) rows = rows.filter((a) => st.includes(a.status));
  if (kind) rows = rows.filter((a) => a.kind === kind);
  if (severity) rows = rows.filter((a) => a.severity === severity);
  rows.sort((a, b) => SEV[b.severity] - SEV[a.severity] || b.probability - a.probability || Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return rows.slice(0, limit).map(pub);
}
const get = (id) => (store.get(id) ? pub(store.get(id)) : null);
const counts = () => { const c = { open: 0, acknowledged: 0, actioned: 0, dismissed: 0 }; for (const a of store.values()) c[a.status]++; return c; };
const clear = () => store.clear();
const hydrate = (arr) => { for (const a of arr) store.set(a.id, { ...a, _key: a._key || `${a.kind}|${a.subject.id}` }); };

module.exports = { candidates, reconcile, transition, list, get, counts, clear, hydrate, onChange, idFor };
