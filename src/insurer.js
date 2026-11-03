// Usage-based insurance ("Nexus Drive Score"), exceptions-only digest, shareable read-only reports.
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const roster = require('./roster');
const A = require('./analytics');
const D = require('./data/ops');
const ingestLog = require('./ingest/log');
const { round, clamp, hashStr, redactPII } = require('./util');

const DAY = 86400000;
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const isFP = (i) => i.camera && i.camera.aiVerdict === 'false_positive';
const isDrowsy = (i) => (i.signals || []).some((s) => s.key === 'drowsiness_score' && s.triggered) || (i.camera.signals || []).some((s) => /drows|fatigue/i.test(s));
const isNight = (i) => { const h = (new Date(i.timestamp).getUTCHours() + 19) % 24; return h >= 22 || h < 5; };
const WEIGHTS = { followingDistance: 0.14, braking: 0.12, acceleration: 0.06, cornering: 0.06, speeding: 0.14, distraction: 0.16, fatigue: 0.10, nightDriving: 0.06, collisionHistory: 0.16 };
const PEN = { followingDistance: 12, braking: 10, acceleration: 8, cornering: 8, speeding: 9, distraction: 14, fatigue: 14, nightDriving: 7, collisionHistory: 35 };
const bandOf = (s) => (s >= 88 ? 'excellent' : s >= 75 ? 'good' : s >= 60 ? 'fair' : 'poor');
const LABEL = { followingDistance: 'Following distance', braking: 'Braking', acceleration: 'Acceleration', cornering: 'Cornering', speeding: 'Speeding', distraction: 'Distraction', fatigue: 'Fatigue', nightDriving: 'Night driving', collisionHistory: 'Collision history' };

function components(evs, coll90) {
  const c = (t) => evs.filter((i) => i.eventType === t).length;
  const cnt = {
    followingDistance: c('following_distance'), braking: c('harsh_brake'), acceleration: c('harsh_accel'), cornering: c('harsh_turn'), speeding: c('speeding'),
    distraction: evs.filter((i) => i.eventType === 'distracted' && !isDrowsy(i)).length, fatigue: evs.filter((i) => isDrowsy(i)).length, nightDriving: evs.filter(isNight).length, collisionHistory: coll90,
  };
  const out = {}; let score = 0;
  for (const k of Object.keys(WEIGHTS)) { out[k] = clamp(Math.round(100 - cnt[k] * PEN[k]), 0, 100); score += out[k] * WEIGHTS[k]; }
  return { components: out, score: Math.round(score), counts: cnt };
}
async function loadAll() { return db.listIncidents({ since: new Date(Date.now() - 100 * DAY).toISOString(), limit: 500000, clone: false }); }

function driverRows(fleets, incs, nowMs) {
  const byDrv = new Map();
  for (const i of incs) { if (!i.driver || !i.driver.id || isFP(i)) continue; (byDrv.get(i.driver.id) || byDrv.set(i.driver.id, []).get(i.driver.id)).push(i); }
  const rows = [];
  for (const f of fleets) {
    const end = nowMs(f);
    for (const d of f.drivers) {
      const all = byDrv.get(d.id) || [];
      const win = (e, days) => all.filter((i) => { const t = +new Date(i.timestamp); return t > e - days * DAY && t <= e; });
      const now30 = win(end, 30), prev30 = win(end - 30 * DAY, 30);
      const coll = (e) => win(e, 90).filter((i) => ['collision', 'rollover'].includes(i.eventType)).length;
      const cur = components(now30, coll(end)), prev = components(prev30, coll(end - 30 * DAY));
      rows.push({
        driverId: d.id, name: d.name, fleetId: f.id, fleetName: f.name, vehicle: d.vehicleId, driveScore: cur.score, band: bandOf(cur.score), components: cur.components,
        trend30d: cur.score - prev.score, milesLast30d: f.exposure && f.exposure.milesTotal ? Math.round(f.exposure.milesTotal / Math.max(1, f.vehicles.length)) : null,
        events30d: now30.length, collisions90d: cur.counts.collisionHistory, cameraVerifiedPct: now30.length ? Math.round((100 * now30.filter((i) => i.camera.verified).length) / now30.length) : null,
        topIssue: Object.entries(cur.components).sort((a, b) => a[1] - b[1])[0][1] < 100 ? LABEL[Object.entries(cur.components).sort((a, b) => a[1] - b[1])[0][0]] : null,
      });
    }
  }
  return rows;
}
const fleetEnd = (incs) => (f) => { const t = incs.filter((i) => i.fleetId === f.id).map((i) => +new Date(i.timestamp)); const m = t.length ? Math.max(...t) : Date.now(); return Date.now() - m > 40 * DAY ? m : Date.now(); };
const liveFleets = () => roster.all().filter((f) => !f.prospect);

async function projectedRisk(fleetId, cur, prev) {
  try { const pr = require('./predict'); if (pr && pr.fleetProjection) { const p = await pr.fleetProjection(fleetId); if (p && p.risk) return p.risk.projected90d; } } catch (e) { /* optional */ }
  return clamp(cur + (cur - prev) * 0.6, 0, 100);
}

async function usageBased(fleetId) {
  const fleet = roster.getFleet(fleetId); if (!fleet) return null;
  const incs = await loadAll();
  const mine = incs.filter((i) => i.fleetId === fleetId);
  const end = fleetEnd(incs)(fleet);
  const mt = (e) => A.fleetMetrics(fleet, mine.filter((i) => { const t = +new Date(i.timestamp); return t > e - 30 * DAY && t <= e; }), e, 30);
  const m = mt(end), prevM = mt(end - 30 * DAY);
  const ds = (r) => Math.round(clamp(100 - 0.85 * r, 0, 100));
  const history = [];
  for (let w = 8; w >= 0; w--) { const e = end - w * 7 * DAY; history.push({ date: new Date(e).toISOString().slice(0, 10), score: ds(mt(e).riskScore) }); }
  const port = await A.portfolio();
  const avgRisk = port.totals.avgRiskScore;
  const nVeh = Math.max(1, fleet.vehicleCount || fleet.vehicles.length);
  const base = Math.round(nVeh * (fleet.vehicles[0] && fleet.vehicles[0].cls === 'light' ? 6400 : 9800));
  const cur = clamp(round((m.riskScore - avgRisk) * 0.4, 1), -15, 25);
  const projRisk = await projectedRisk(fleetId, m.riskScore, prevM.riskScore);
  const proj = clamp(round((projRisk - avgRisk) * 0.4, 1), -15, 25);
  const changed = m.components.map((c) => { const p = prevM.components.find((x) => x.key === c.key); return { key: c.key, label: c.label, deltaPts: round(p.score - c.score, 1), direction: p.score - c.score > 1 ? 'improved' : p.score - c.score < -1 ? 'worsened' : 'flat', now: c.score, before: p.score }; }).sort((a, b) => Math.abs(b.deltaPts) - Math.abs(a.deltaPts)).slice(0, 5);
  const PROG = { collisions: 'Forward-collision warning + road-facing camera coaching', harsh_events: 'AI-triggered in-cab coaching on harsh braking/accel/cornering', speeding: 'Speed policy: governor + geofenced speed alerts', distraction: 'Driver-facing camera alerts for phone use and drowsiness', maintenance: 'Preventive maintenance with DTC alerting' };
  const levers = m.components.map((c) => { const pts = round(c.score * c.weight * 0.3 * 0.85, 1); return { key: c.key, label: PROG[c.key], area: c.label, potentialPts: pts, potentialSavingsUsd: Math.round(base * ((pts * 0.4) / 100)) }; }).sort((a, b) => b.potentialPts - a.potentialPts).slice(0, 4);
  const rows = driverRows([fleet], mine, () => end).sort((a, b) => b.driveScore - a.driveScore || a.events30d - b.events30d);
  const startOfPolicy = new Date(end - (120 + (hashStr(fleetId) % 180)) * DAY); startOfPolicy.setUTCDate(1);
  const endOfPolicy = new Date(startOfPolicy); endOfPolicy.setUTCFullYear(endOfPolicy.getUTCFullYear() + 1);
  const driveScore = ds(m.riskScore);
  return {
    fleetId, fleetName: fleet.name, vendor: fleet.vendor, carrier: D.carrierOf(fleetId).name, policyNo: D.policyNo(fleetId),
    policyPeriod: { start: startOfPolicy.toISOString().slice(0, 10), end: endOfPolicy.toISOString().slice(0, 10) },
    driveScore, band: bandOf(driveScore), trend30d: driveScore - ds(prevM.riskScore), scoreHistory: history,
    pricing: { basePremiumUsd: base, currentAdjustmentPct: cur, projectedRenewalAdjustmentPct: proj, monthlyAdjustmentUsd: Math.round(((base / 12) * cur) / 100), portfolioBaselineRisk: avgRisk, note: 'Illustrative behaviour-based signal, not a rate filing' },
    whatChanged30d: changed, topImprovementLevers: levers,
    drivers: { best: rows.slice(0, 5), worst: [...rows].reverse().slice(0, 5) }, driverCount: rows.length,
  };
}

// ---------- digest ----------
async function digest({ carrier, period = 'weekly' }) {
  const days = { daily: 1, weekly: 7, monthly: 30 }[period] || 7;
  const car = carrier ? D.CARRIERS.find((c) => c.id === carrier || c.name.toLowerCase().includes(String(carrier).toLowerCase())) : null;
  let fleets = liveFleets().filter((f) => !f.onboarding || f.onboarding.status !== 'setup');
  if (car) fleets = fleets.filter((f) => D.carrierOf(f.id).id === car.id);
  const incs = (await loadAll()).filter((i) => i.source !== 'historical_import');
  const since = Date.now() - days * DAY;
  const port = await A.portfolio();
  const pf = new Map(port.fleets.map((f) => [f.id, f]));
  const attention = [], improvements = [], actions = [];
  const health = await ingestLog.health();
  for (const f of fleets) {
    const p = pf.get(f.id); if (!p) continue;
    const mine = incs.filter((i) => i.fleetId === f.id);
    const openCrit = mine.filter((i) => i.severity === 'critical' && A.OPEN.includes(i.status) && !isFP(i)).length;
    const alerts = (await db.list('alert', { fleetId: f.id, status: 'open', limit: 500 })).length;
    const why = [];
    const failing = health.some((h) => h.fleetId === f.id && h.status === 'failing');
    const rising = p.trend === 'up' && ['elevated', 'high'].includes(p.riskTier);
    if (p.riskTier === 'high' || rising) why.push(`risk ${p.riskScore} (${p.riskTier})${rising ? ', trend worsening' : ''}`);
    if (openCrit >= 3) why.push(`${openCrit} open critical incidents`);
    if (alerts >= 5) why.push(`${alerts} open predictive alerts`);
    if (failing) why.push('data feed failing');
    if (why.length) attention.push({ fleetId: f.id, name: f.name, why: why.join('; '), severity: p.riskTier === 'high' || openCrit >= 3 ? 'high' : 'medium', riskScore: p.riskScore, riskTier: p.riskTier });
    if (p.trend === 'down' && p.riskScore < 50) improvements.push({ fleetId: f.id, name: f.name, detail: `Risk trend improving (score ${p.riskScore}, ${p.verifiedEventPct}% camera-verified events)` });
    const worst = [...(A.COMPONENTS)].map((c) => ({ c, v: (mine.filter((i) => !isFP(i) && c.types.includes(i.eventType)).length) })).sort((a, b) => b.v - a.v)[0];
    if (why.length && worst && worst.v) actions.push(`${f.name}: prioritise ${worst.c.label.toLowerCase()} coaching (${worst.v} events in 30d)${p.cameraCoveragePct < 60 ? `; camera coverage only ${p.cameraCoveragePct}% - consider camera-first telematics` : ''}`);
  }
  attention.sort((a, b) => (a.severity === b.severity ? b.riskScore - a.riskScore : a.severity === 'high' ? -1 : 1));
  const fset = new Set(fleets.map((f) => f.id));
  const recent = incs.filter((i) => fset.has(i.fleetId) && +new Date(i.timestamp) >= since && !isFP(i));
  const high = recent.filter((i) => ['critical', 'high'].includes(i.severity) && i.category !== 'diagnostic').sort((a, b) => b.risk.eventScore - a.risk.eventScore).slice(0, 10)
    .map((i) => ({ incidentId: i.id, fleetId: i.fleetId, fleetName: i.fleetName, eventType: i.eventType, severity: i.severity, timestamp: i.timestamp, summary: `${i.eventType.replace(/_/g, ' ')} - ${i.driver.name} - ${i.location.address}`, cameraVerified: !!i.camera.verified, status: i.status }));
  const colls = recent.filter((i) => ['collision', 'rollover'].includes(i.eventType));
  const fnols = incs.filter((i) => fset.has(i.fleetId) && i.fnol && +new Date(i.fnol.submittedAt) >= since).length;
  const noFnol = colls.filter((i) => !i.fnol && ['critical', 'high'].includes(i.severity)).length;
  if (noFnol) actions.push(`${noFnol} confirmed collision${noFnol > 1 ? 's' : ''} without a first notice of loss - confirm with the fleet`);
  const drivers = driverRows(fleets, incs, () => Date.now()).filter((d) => d.trend30d >= 8 && d.events30d > 0).sort((a, b) => b.trend30d - a.trend30d).slice(0, 3);
  drivers.forEach((d) => improvements.push({ fleetId: d.fleetId, name: d.name, detail: `Driver Drive Score +${d.trend30d} pts in 30d (now ${d.driveScore}, ${d.band})` }));
  const label = period === 'daily' ? 'Last 24 hours' : period === 'monthly' ? 'Last 30 days' : 'Last 7 days';
  return {
    period, periodLabel: label, generatedAt: new Date().toISOString(), carrier: car ? { id: car.id, name: car.name } : null, fleetsReviewed: fleets.length,
    headline: `${label}: ${attention.length} fleet${attention.length === 1 ? '' : 's'} need attention, ${high.length} new high-severity event${high.length === 1 ? '' : 's'}, ${improvements.length} notable improvement${improvements.length === 1 ? '' : 's'}.`,
    fleetsNeedingAttention: attention, newHighSeverity: high, notableImprovements: improvements, claimsOpened: colls.length, fnolsSent: fnols,
    recommendedActions: actions.slice(0, 8), exceptionsOnly: true,
  };
}

// ---------- reports ----------
const router = express.Router();
router.get('/api/insurer/drivers', wrap(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 2000);
  let fleets = req.query.fleetId ? [roster.getFleet(req.query.fleetId)].filter(Boolean) : liveFleets();
  if (req.query.fleetId && !fleets.length) return res.status(404).json({ error: 'Fleet not found' });
  const incs = await loadAll(); const fe = fleetEnd(incs);
  let rows = driverRows(fleets, incs, fe);
  rows.sort((a, b) => (req.query.order === 'best' ? b.driveScore - a.driveScore : a.driveScore - b.driveScore) || b.events30d - a.events30d);
  res.json(rows.slice(0, limit));
}));
router.get('/api/insurer/fleets/:id/usage-based', wrap(async (req, res) => { const r = await usageBased(req.params.id); if (!r) return res.status(404).json({ error: 'Fleet not found' }); res.json(r); }));
router.get('/api/insurer/digest', wrap(async (req, res) => res.json(await digest({ carrier: req.query.carrier, period: req.query.period }))));

router.post('/api/insurer/reports', wrap(async (req, res) => {
  const { kind, refId } = req.body || {};
  if (!['fleet', 'assessment', 'incident', 'digest', 'builder'].includes(kind)) return res.status(422).json({ error: 'validation_failed', message: 'kind must be fleet|assessment|incident|digest|builder' });
  let data, title, fleetId = null;
  if (kind === 'fleet') { if (!roster.getFleet(refId)) return res.status(404).json({ error: 'Fleet not found' }); fleetId = refId; data = { deepDive: await A.fleetDeepDive(refId), usageBased: await usageBased(refId) }; title = `Fleet risk report - ${roster.getFleet(refId).name}`; }
  else if (kind === 'assessment') { const a = await db.get('assessment', refId); if (!a) return res.status(404).json({ error: 'Assessment not found' }); fleetId = a.fleetId; data = a; title = `Risk assessment - ${a.fleetName}`; }
  else if (kind === 'incident') { const i = await db.getIncident(refId); if (!i) return res.status(404).json({ error: 'Incident not found' }); fleetId = i.fleetId; const { raw, ...rest } = i; data = rest; title = `Incident ${i.id} - ${i.fleetName}`; }
  else if (kind === 'builder') {
    // frozen snapshot of a report-builder result + its config (no live link back to the data); same redaction + 30-day expiry as every kind
    const b = await require('./reports').freeze(refId, req.body || {});
    if (b.error) return res.status(b.status || 400).json({ error: b.error, message: b.message, field: b.field });
    data = b.snapshot; title = b.title; fleetId = b.fleetId;
  }
  else { data = await digest({ carrier: refId, period: (req.body.period) || 'weekly' }); title = 'Exceptions digest'; }
  const token = crypto.randomBytes(12).toString('hex');
  const now = Date.now();
  const doc = { id: token, token, kind, refId: refId || null, fleetId, title, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 30 * DAY).toISOString(), status: 'active', snapshot: redactPII(data) };
  await db.put('report', doc);
  res.status(201).json({ token, url: '/report/' + token, apiUrl: '/api/reports/' + token, title, kind, expiresAt: doc.expiresAt });
}));
router.get('/api/insurer/reports', wrap(async (req, res) => res.json({ reports: (await db.list('report', { fleetId: req.query.fleetId, limit: 200 })).filter((r) => !req.query.kind || r.kind === req.query.kind).map(({ snapshot, ...r }) => r) })));
router.get('/api/reports/:token', wrap(async (req, res) => {
  const r = await db.get('report', req.params.token);
  if (!r || r.status === 'revoked') return res.status(404).json({ error: 'Report not found' });
  if (new Date(r.expiresAt) < new Date()) return res.status(410).json({ error: 'Report link expired' });
  res.set('Cache-Control', 'private, max-age=60').json({ token: r.token, kind: r.kind, title: r.title, createdAt: r.createdAt, expiresAt: r.expiresAt, readOnly: true, data: redactPII(r.snapshot) });
}));
router.delete('/api/insurer/reports/:token', wrap(async (req, res) => { const r = await db.get('report', req.params.token); if (!r) return res.status(404).json({ error: 'Report not found' }); r.status = 'revoked'; await db.put('report', r); res.json({ revoked: true }); }));

const ds = (r) => Math.round(clamp(100 - 0.85 * r, 0, 100));
module.exports = { router, usageBased, digest, components, bandOf, driverRows, fleetEnd, liveFleets, driveScoreOf: ds, isFP };
