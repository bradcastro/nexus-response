// Risk history engine shared by /api/records/risk-history and the `risk_snapshots` report-builder dataset.
// Everything is derived from the stored incident history (seeded ~90 days; imported history extends it) by REUSING
// analytics.fleetMetrics (fleet risk score) and insurer.components (driver Drive Score). No new scoring model is introduced.
const db = require('../db');
const roster = require('./roster');
const A = require('./analytics');
const I = require('./insurer');
const { round, clamp } = require('./util');

const DAY = 86400000;
const BUCKETS = ['day', 'week', 'month'];
const METRICS = {
  riskScore: { label: 'Risk score', unit: 'points (0-100, higher is riskier)', rolling: true },
  driveScore: { label: 'Drive Score', unit: 'points (0-100, higher is safer)', rolling: true },
  eventsPer1kMi: { label: 'Events per 1,000 miles', unit: 'events / 1,000 mi (estimated exposure)', rolling: false },
  collisions: { label: 'Collisions', unit: 'count', rolling: false },
  cameraVerifiedShare: { label: 'Camera-verified share', unit: '% of events', rolling: false },
};
const COLL = ['collision', 'rollover'];
const isFP = I.isFP;
const day0 = (ms) => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };
function bucketStart(ms, bucket) {
  const d = new Date(ms);
  if (bucket === 'month') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  if (bucket === 'week') { const s = day0(ms); return s - ((new Date(s).getUTCDay() + 6) % 7) * DAY; } // Monday
  return day0(ms);
}
function nextBucket(ms, bucket) { if (bucket === 'month') { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1); } return ms + (bucket === 'week' ? 7 : 1) * DAY; }
function bucketList(fromMs, toMs, bucket) {
  const out = []; let s = bucketStart(fromMs, bucket);
  while (s <= toMs && out.length < 800) { out.push({ start: s, end: nextBucket(s, bucket) }); s = nextBucket(s, bucket); }
  return out;
}
const clock = () => day0(Date.now()) + DAY - 1; // end of the current UTC day: keeps repeated calls identical within a day
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

async function loadIncidents() { return db.listIncidents({ limit: 1e7, clone: false }); }
const liveFleets = () => roster.all().filter((f) => !f.prospect);
const perDay = (f) => { if (f.exposure && f.exposure.milesTotal && f.exposure.from && f.exposure.to) { const days = Math.max(1, (+new Date(f.exposure.to) - +new Date(f.exposure.from)) / DAY); return f.exposure.milesTotal / Math.max(1, (f.exposure.vehicles || f.vehicles.length)) / days; } return f.vehicles[0] && f.vehicles[0].cls === 'light' ? 90 : 250; };
const reportedExposure = (f) => !!(f.exposure && f.exposure.milesTotal && f.exposure.from && f.exposure.to);

// ---- entity resolution ----
function resolveEntity(scope, id) {
  if (scope === 'portfolio') { const fl = liveFleets(); return { scope, id: 'portfolio', name: 'All fleets (portfolio)', fleets: fl, fleetId: null, vehicleCount: fl.reduce((s, f) => s + f.vehicles.length, 0), test: () => true }; }
  if (scope === 'fleet') { const f = roster.getFleet(id); if (!f) return null; return { scope, id, name: f.name, fleets: [f], fleetId: f.id, vehicleCount: f.vehicleCount || f.vehicles.length, test: (i) => i.fleetId === id }; }
  if (scope === 'driver') { const d = roster.getDriver(id); if (!d) return null; const f = roster.getFleet(d.fleetId); return { scope, id, name: d.name, fleets: f ? [f] : [], fleetId: d.fleetId, vehicleCount: 1, test: (i) => !!(i.driver && i.driver.id === id) }; }
  if (scope === 'vehicle') { const v = roster.getVehicle(id); if (!v) return null; const f = roster.getFleet(v.fleetId); return { scope, id, name: v.unit || v.id, fleets: f ? [f] : [], fleetId: v.fleetId, vehicleCount: 1, test: (i) => !!(i.vehicle && i.vehicle.id === id) }; }
  return null;
}
function milesFor(ent, fromMs, toMs) {
  const days = Math.max(0, (toMs - fromMs) / DAY);
  if (ent.scope === 'fleet' || ent.scope === 'portfolio') return ent.fleets.reduce((s, f) => s + (f.vehicleCount || f.vehicles.length) * perDay(f) * days, 0);
  return ent.fleets.length ? perDay(ent.fleets[0]) * days : 0;
}

// rolling 30-day score at `endMs` for an entity; `mine` = incidents already filtered to the entity
function windowScore(ent, mine, endMs) {
  const win = mine.filter((i) => { const t = +new Date(i.timestamp); return t >= endMs - 30 * DAY && t < endMs; });
  if (ent.scope === 'fleet' || ent.scope === 'portfolio') {
    let w = 0, rs = 0;
    for (const f of ent.fleets) {
      const m = A.fleetMetrics(f, win.filter((i) => i.fleetId === f.id), endMs, 30);
      rs += m.riskScore * m.vehicles; w += m.vehicles;
    }
    const risk = w ? Math.round(rs / w) : null;
    return { riskScore: risk, driveScore: risk == null ? null : I.driveScoreOf(risk), n: win.filter((i) => !isFP(i)).length };
  }
  const real = win.filter((i) => !isFP(i));
  const coll90 = mine.filter((i) => { const t = +new Date(i.timestamp); return t >= endMs - 90 * DAY && t < endMs && !isFP(i) && COLL.includes(i.eventType); }).length;
  const c = I.components(real, coll90);
  return { riskScore: clamp(Math.round((100 - c.score) / 0.85), 0, 100), driveScore: c.score, n: real.length };
}
function bucketStats(ent, mine, startMs, endMs, clipFrom, clipTo) {
  const a = Math.max(startMs, clipFrom), b = Math.min(endMs, clipTo);
  const evs = mine.filter((i) => { const t = +new Date(i.timestamp); return t >= startMs && t < endMs && !isFP(i); });
  const miles = milesFor(ent, a, b);
  return {
    n: evs.length, collisions: evs.filter((i) => COLL.includes(i.eventType)).length, miles: Math.round(miles),
    eventsPer1kMi: miles > 0 ? round((evs.length / miles) * 1000, 2) : null,
    cameraVerifiedShare: evs.length ? round((100 * evs.filter((i) => i.camera && i.camera.verified).length) / evs.length, 1) : null,
  };
}

// Series for one entity. incs = all incidents. Returns {series, summary, events, earliest}
function entitySeries(ent, incs, { fromMs, toMs, bucket, metrics, nowMs }) {
  const mine = incs.filter(ent.test);
  const earliest = incs.length ? Math.min(...incs.map((i) => +new Date(i.timestamp))) : null;
  const bl = bucketList(fromMs, toMs, bucket);
  const rows = bl.map((b) => {
    const end = Math.min(b.end, nowMs + 1);
    const stats = bucketStats(ent, mine, b.start, b.end, fromMs, Math.min(toMs, nowMs));
    const needScore = metrics.includes('riskScore') || metrics.includes('driveScore');
    const sc = needScore ? windowScore(ent, mine, end) : null;
    return { b, stats, sc, partial: earliest != null && end - 30 * DAY < earliest };
  });
  const series = metrics.map((m) => ({
    metric: m, label: METRICS[m].label, unit: METRICS[m].unit,
    points: rows.map((r) => {
      if (m === 'riskScore' || m === 'driveScore') return { t: ymd(r.b.start), value: r.sc[m], n: r.sc.n, ...(r.partial ? { partial: true } : {}) };
      return { t: ymd(r.b.start), value: m === 'collisions' ? r.stats.collisions : r.stats[m], n: r.stats.n };
    }),
  }));
  const events = mine.filter((i) => { const t = +new Date(i.timestamp); return t >= fromMs && t <= toMs && !isFP(i) && (COLL.includes(i.eventType) || i.severity === 'critical'); })
    .sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : a.id < b.id ? -1 : 1)).slice(0, 300)
    .map((i) => ({ t: i.timestamp, type: i.eventType, severity: i.severity, incidentId: i.id, label: `${i.eventType.replace(/_/g, ' ')} (${i.severity})${i.driver && i.driver.name ? ' - ' + i.driver.name : ''}` }));
  return { series, events, earliest, mine };
}
function summarize(series, prefer) {
  const s = series.find((x) => x.metric === prefer) || series[0];
  if (!s) return { metric: null, first: null, last: null, change: null, direction: 'flat' };
  const pts = s.points.filter((p) => p.value != null);
  const first = pts.length ? pts[0].value : null, last = pts.length ? pts[pts.length - 1].value : null;
  const change = first != null && last != null ? round(last - first, 2) : null;
  const tol = Math.max(0.5, Math.abs(first || 0) * 0.03);
  return { metric: s.metric, first, last, change, direction: change == null ? 'flat' : Math.abs(change) <= tol ? 'flat' : change > 0 ? 'up' : 'down', interpretation: s.metric === 'driveScore' || s.metric === 'cameraVerifiedShare' ? 'higher_is_better' : 'higher_is_worse' };
}

// Weekly risk snapshots (per fleet and per driver) for the report builder / records search
function snapshotRows(incs, nowMs) {
  const earliest = incs.length ? Math.min(...incs.map((i) => +new Date(i.timestamp))) : nowMs;
  const fromMs = Math.max(bucketStart(earliest, 'week'), bucketStart(nowMs, 'week') - 52 * 7 * DAY);
  const rows = [];
  const byFleet = new Map(), byDriver = new Map();
  for (const i of incs) {
    (byFleet.get(i.fleetId) || byFleet.set(i.fleetId, []).get(i.fleetId)).push(i);
    if (i.driver && i.driver.id) (byDriver.get(i.driver.id) || byDriver.set(i.driver.id, []).get(i.driver.id)).push(i);
  }
  const bl = bucketList(fromMs, nowMs, 'week');
  const push = (ent, mine, vendor, tier) => {
    for (const b of bl) {
      const end = Math.min(b.end, nowMs + 1);
      const st = bucketStats(ent, mine, b.start, b.end, fromMs, nowMs);
      const sc = windowScore(ent, mine, end);
      const key = `${ent.scope}:${ent.id}:${ymd(b.start)}`;
      rows.push({
        snapshotId: key, timestamp: new Date(b.start).toISOString(), weekStart: ymd(b.start), entityType: ent.scope, entityId: ent.id, entityName: ent.name,
        fleetId: ent.fleetId, fleetName: (ent.fleets[0] && ent.fleets[0].name) || null, vendor,
        riskScore: sc.riskScore, riskTier: sc.riskScore == null ? null : (ent.scope === 'fleet' ? A.tierOf(sc.riskScore) : null), driveScore: sc.driveScore,
        driveBand: sc.driveScore == null ? null : I.bandOf(sc.driveScore), events: st.n, collisions: st.collisions, estMiles: st.miles, eventsPer1kMi: st.eventsPer1kMi,
        cameraVerifiedShare: st.cameraVerifiedShare, windowEvents30d: sc.n, windowComplete: end - 30 * DAY >= earliest,
      });
    }
  };
  for (const f of liveFleets()) push(resolveEntity('fleet', f.id), byFleet.get(f.id) || [], f.vendor);
  for (const f of liveFleets()) for (const d of f.drivers) push(resolveEntity('driver', d.id), byDriver.get(d.id) || [], f.vendor);
  return rows;
}

function limitations(incs, ent, bucket) {
  const imported = incs.filter((i) => i.source === 'historical_import').length;
  const ts = incs.map((i) => +new Date(i.timestamp));
  const lim = [
    `Derived from ${ts.length ? Math.round((Math.max(...ts) - Math.min(...ts)) / DAY) : 0} days of stored history (${ts.length ? ymd(Math.min(...ts)) + ' to ' + ymd(Math.max(...ts)) : 'none'}); seeded history is about 90 days and imported history extends it${imported ? ` (${imported} imported incidents are in the store)` : ' (no imported history is loaded right now)'}.`,
    'Risk score and Drive Score use a rolling 30-day window ending at the end of each bucket (fleet: Nexus event-based fleet risk score; driver/vehicle: Nexus Drive Score components). Points whose window starts before the earliest stored incident are flagged partial and understate risk.',
    'Events per 1,000 miles uses ESTIMATED exposure (vehicles x days x typical daily miles) unless the fleet supplied reported mileage on import. Collisions, events and camera-verified share are counted inside each bucket and exclude camera-classified false positives.',
    'Illustrative scores on synthetic demo data; they are not actuarial rates or a pricing filing.',
  ];
  if (ent && ent.scope === 'vehicle') lim.push('Vehicle scope applies the driver Drive Score components to the vehicle\'s own events.');
  if (ent && ent.scope === 'driver') lim.push('Driver exposure assumes one vehicle per driver.');
  if (bucket === 'day') lim.push('Daily points show the rolling 30-day score, so they move slowly; day-level counts are small and noisy.');
  return lim;
}

module.exports = { METRICS, BUCKETS, loadIncidents, resolveEntity, entitySeries, summarize, snapshotRows, limitations, bucketStart, bucketList, ymd, liveFleets, reportedExposure, clock, DAY };
