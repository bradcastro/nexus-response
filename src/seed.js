// Deterministic demo data: 7 fleets, rosters, GPS positions, 90 days of history (~600 incidents) with precursor patterns before many collisions.
const { FLEETS, MODELS, FIRST, LAST, LOCATIONS, PROVIDERS } = require('./data/ref');
const { rngFrom, pick, int, range, weighted, round, clamp } = require('./util');
const roster = require('./roster');
const db = require('../db');
const pipeline = require('./pipeline');
const fixtures = require('./fixtures');
const { buildVin } = require('./enrich/vin');
const { makeSpec, pickType, pickLoc } = require('./scenarios');
const roadside = require('./enrich/roadside');
const claims = require('./claims');
const { windows: warrantyWindows } = require('./enrich/warranty');

const TREND_P = { fleet_gulfcoast: 1.0, fleet_elite: 0.9, fleet_piedmont: 1.55, fleet_bluegrass: 0.65, fleet_summit: 1.25, fleet_redline: 0.55, fleet_magnolia: 0.6 };
// share of the 90-day events falling in [last 30d, 30-60d, 60-90d] (trend shape)
const SHARES = { fleet_gulfcoast: [0.34, 0.33, 0.33], fleet_elite: [0.34, 0.33, 0.33], fleet_piedmont: [0.46, 0.30, 0.24], fleet_bluegrass: [0.24, 0.33, 0.43], fleet_summit: [0.40, 0.33, 0.27], fleet_redline: [0.19, 0.33, 0.48], fleet_magnolia: [0.19, 0.33, 0.48] };
// how much driver-behaviour signal each vendor's gear captures before a collision (drives precursor density)
const CAPTURE = { mantis: 1.0, lytx: 0.85, samsara: 0.7, motive: 0.55, geotab: 0.3 };
const LEAD_TYPES = ['following_distance', 'harsh_brake', 'harsh_turn', 'harsh_accel', 'distracted', 'speeding'];
const ABBR = { fleet_gulfcoast: 'GCF', fleet_elite: 'ELT', fleet_piedmont: 'PLG', fleet_bluegrass: 'BDT', fleet_summit: 'SLM', fleet_redline: 'RRC', fleet_magnolia: 'MBD' };
const STATE = { fleet_gulfcoast: 'AL', fleet_elite: 'AL', fleet_piedmont: 'NC', fleet_bluegrass: 'KY', fleet_summit: 'GA', fleet_redline: 'TN', fleet_magnolia: 'MS' };
const YEARS = [[2020, 6], [2021, 10], [2022, 16], [2023, 20], [2024, 20], [2025, 18], [2026, 10]];

function buildRoster(now = new Date()) {
  const fleets = [];
  for (const f of FLEETS) {
    const rng = rngFrom('roster:' + f.id);
    const ab = ABBR[f.id], st = STATE[f.id];
    const vehicles = [], drivers = [];
    const nDrivers = Math.round(f.vehicles * 1.12);
    const used = new Set();
    for (let i = 0; i < nDrivers; i++) {
      let name; do { name = `${pick(rng, FIRST)} ${pick(rng, LAST)}`; } while (used.has(name)); used.add(name);
      const base = clamp(Math.round(93 - f.bias * 15 + (rng() - 0.5) * 28), 48, 99);
      drivers.push({ id: `drv_${ab.toLowerCase()}_${String(i + 1).padStart(2, '0')}`, fleetId: f.id, name, phone: `+1${pick(rng, ['251', '334', '256', '704', '859', '404', '678', '910'])}555${String(int(rng, 100, 999)).padStart(4, '0')}`, providerDriverId: f.vendor === 'samsara' ? String(int(rng, 4000000, 4999999)) : f.vendor === 'geotab' ? 'b' + int(rng, 100, 9999).toString(16).toUpperCase() : f.vendor === 'lytx' ? 'E' + int(rng, 10000, 99999) : 'drv_' + int(rng, 1000, 9999), safetyScore: base, vehicleId: null });
    }
    for (let i = 0; i < f.vehicles; i++) {
      const mk = weighted(rng, f.models); const m = MODELS[mk];
      const year = weighted(rng, YEARS);
      const age = Math.max(0.15, now.getUTCFullYear() + now.getUTCMonth() / 12 - (year + 0.3));
      const odo = Math.round(Math.max(1500, age * m.mpy * range(rng, 0.7, 1.3)));
      const loc = pickLoc(rng, f.regions);
      const drv = drivers[i % drivers.length];
      const unit = `${ab}-${String(100 + i + 1)}`;
      const v = {
        id: `veh_${ab.toLowerCase()}_${String(i + 1).padStart(3, '0')}`, fleetId: f.id, unit, modelKey: mk, vin: buildVin(mk, year, 10000 + int(rng, 0, 89999)), year, make: m.make, model: m.model, oem: m.oem, engine: m.engine, cls: m.cls,
        plate: `${st}-${ab}-${String(100 + i + 1)}`, odometer_mi: odo, hasCamera: rng() < f.cameraPct, driverId: drv.id,
        providerVehicleId: f.vendor === 'geotab' ? 'b' + int(rng, 100, 9999).toString(16).toUpperCase() : String(int(rng, 100000, 99999999)),
        position: { lat: round(loc.lat + range(rng, -0.25, 0.25), 5), lng: round(loc.lng + range(rng, -0.25, 0.25), 5), speed_mph: rng() < 0.7 ? int(rng, 20, 68) : 0, heading: (loc.h + int(rng, -20, 20) + 360) % 360, road: loc.road, city: `${loc.city}, ${loc.st}` },
      };
      v.position.status = v.position.speed_mph > 0 ? 'moving' : 'idle';
      drv.vehicleId = v.id;
      vehicles.push(v);
    }
    fleets.push({ id: f.id, name: f.name, vendor: f.vendor, region: f.region, home: f.home, regions: f.regions, companyId: `co_${f.vendor}_${f.id.replace('fleet_', '')}`, cameraPct: f.cameraPct, vehicles, drivers, onboarding: { status: 'demo', createdAt: new Date(now.getTime() - 120 * 86400000).toISOString() } });
  }
  return fleets;
}

// Walk a vehicle's GPS trail around its position (for fleet map).
function vehicleTrail(v, points = 18) {
  const rng = rngFrom('trail:' + v.id);
  const out = []; let { lat, lng } = v.position; const h = (v.position.heading * Math.PI) / 180;
  const sp = Math.max(v.position.speed_mph, 8);
  for (let i = 0; i < points; i++) {
    const d = (sp * 60) / 3600;
    lat -= (d * Math.cos(h)) / 69 + range(rng, -0.0005, 0.0005); lng -= (d * Math.sin(h)) / (69 * Math.cos((lat * Math.PI) / 180)) + range(rng, -0.0005, 0.0005);
    out.push({ lat: round(lat, 5), lng: round(lng, 5), t: new Date(Date.now() - (i + 1) * 60000).toISOString(), speed_mph: Math.round(sp * range(rng, 0.8, 1.15)) });
  }
  return out.reverse();
}

function lifecycle(inc, rng, ageDays, force, mantis) {
  const rcv = new Date(inc.receivedAt).getTime();
  const min = (m) => new Date(rcv + m * 60000).toISOString();
  const needsRoadside = inc.roadside.needed;
  const tl = inc.timeline;
  if (inc.status === 'dismissed') return inc;
  let target;
  const pOpen = ageDays < 0.5 ? 0.92 : ageDays < 1.6 ? 0.45 : 0;
  if (rng() >= pOpen) target = rng() < 0.93 ? 'resolved' : 'dismissed';
  else target = weighted(rng, [['pending', 3], ['dispatched', 2], ['en_route', 2], ['on_scene', 1.5], ['resolved', 1.5]]);
  if (force) target = force;
  if (inc.severity === 'low' && target !== 'resolved' && target !== 'dismissed' && ageDays > 0.6) target = 'resolved';
  const order = ['pending', 'dispatched', 'en_route', 'on_scene', 'resolved'];
  if (target === 'dismissed') { inc.status = 'dismissed'; tl.push({ t: min(int(rng, 5, 90)), actor: 'dispatcher', action: 'dismissed', note: 'Reviewed - no action required' }); return inc; }
  const idx = order.indexOf(target);
  let t = int(rng, 2, 7);
  if (idx >= 1) {
    if (needsRoadside) {
      inc.roadside.assignedProvider = { ...(inc.roadside.recommendedProvider || {}) };
      tl.push({ t: min(t), actor: 'dispatcher', action: 'dispatched', note: `Dispatched ${inc.roadside.assignedProvider.name || 'provider'} (${inc.roadside.serviceType})` });
    } else tl.push({ t: min(t), actor: 'dispatcher', action: 'reviewed', note: inc.category === 'safety' ? 'Reviewed event video; coaching assigned' : 'Reviewed; fleet manager notified' });
    inc.status = needsRoadside ? 'dispatched' : (idx >= 4 ? 'resolved' : 'dispatched');
  }
  if (idx >= 2 && needsRoadside) { t += 1; tl.push({ t: min(t), actor: 'provider', action: 'en_route', note: `Provider en route, ETA ${inc.roadside.etaMin} min` }); inc.status = 'en_route'; }
  if (idx >= 3 && needsRoadside) { t += inc.roadside.etaMin || 30; tl.push({ t: min(t), actor: 'provider', action: 'on_scene', note: 'Provider on scene' }); inc.status = 'on_scene'; }
  if (idx >= 4) {
    t += needsRoadside ? (inc.roadside.serviceType.startsWith('tow') ? int(rng, 30, 80) : int(rng, 18, 55)) : int(rng, 15, 140);
    tl.push({ t: min(t), actor: needsRoadside ? 'provider' : 'fleet', action: 'resolved', note: needsRoadside ? 'Service complete' : 'Coaching logged; event closed' });
    inc.status = 'resolved'; inc.resolvedAt = min(t);
    if (inc.category === 'safety' && (mantis || rng() < 0.3)) tl.push({ t: min(t + int(rng, 20, 360)), actor: 'fleet', action: 'coaching', note: mantis ? 'Auto-coaching clip delivered to driver in Mantis app; supervisor notified' : 'Coaching session scheduled with driver' });
    if (inc.warranty && inc.warranty.claimPacket && rng() < 0.75) {
      inc.warranty.claimPacket.status = 'submitted';
      tl.push({ t: min(t + int(rng, 20, 240)), actor: 'fleet', action: 'warranty_submitted', note: `Warranty claim ${inc.warranty.claimId} submitted to ${inc.warranty.oem} ($${inc.warranty.claimPacket.estimatedValueUsd})` });
    }
  }
  return inc;
}

async function seed({ reset = false, now = new Date() } = {}) {
  const seedFleets = buildRoster(now);
  const custom = roster.all().filter((f) => f.custom);
  roster.set([...seedFleets, ...custom]);
  const fleets = seedFleets;
  for (const f of roster.all()) await db.saveFleet({ ...roster.publicFleet(f), id: f.id, custom: !!f.custom });
  for (const p of roadside.getProviders()) await db.saveProvider(p);

  if (reset) { await db.clearIncidents({ keepImported: true }); await db.clearKind('ingest_log'); await db.clearKind('alert'); await db.clearKind('comms'); await db.clearKind('job'); }
  else if ((await db.countIncidents()) > 0) {
    const all = await db.listIncidents({ limit: 100000, clone: false });
    pipeline.seedCounter(Math.max(10000, ...all.map((i) => { const m = /^NX-(\d+)$/.exec(i.id); return m ? +m[1] : 0; })));
    return { fleets: fleets.length, incidents: all.length, skipped: true };
  }
  const ingestLog = require('./ingest/log');
  // ---------- plan ----------
  const plan = [];
  const byFleet = {};
  for (const f of fleets) {
    const def = FLEETS.find((x) => x.id === f.id);
    const rng = rngFrom('events:' + f.id);
    const sh = SHARES[f.id] || [0.34, 0.33, 0.33];
    const N = Math.round(def.events / sh[0]);
    byFleet[f.id] = [];
    const wv = f.vehicles.map((x) => [x, 1 + (100 - roster.getDriver(x.driverId).safetyScore) / 18]);
    for (let i = 0; i < N; i++) {
      const seg = weighted(rng, [[0, sh[0]], [1, sh[1]], [2, sh[2]]]);
      const offset = seg === 0 ? 30 * Math.pow(rng(), TREND_P[f.id]) : 30 * seg + 30 * rng();
      let type = pickType(rng, def.profile);
      let otherKind;
      if (f.vendor === 'mantis' && ['harsh_turn', 'following_distance'].includes(type) && rng() < 0.2) { type = 'other'; otherKind = pick(rng, ['seatbelt', 'lane']); }
      const it = { f, def, rng, offset, type, otherKind, v: weighted(rng, wv), locked: false };
      plan.push(it); byFleet[f.id].push(it);
    }
  }
  // precursor patterns: 2-4 weeks of escalating leading indicators on the collision driver (about 70% of collisions)
  let precursorCollisions = 0;
  for (const f of fleets) {
    const rng = rngFrom('precursor:' + f.id);
    const cap = CAPTURE[f.vendor] || 0.5;
    const colls = byFleet[f.id].filter((x) => ['collision', 'rollover'].includes(x.type));
    for (const c of colls) {
      if (rng() > 0.7) continue; // some collisions have no precursor
      const k = Math.max(2, Math.round((4 + int(rng, 0, 5)) * cap));
      let made = 0;
      for (let j = 0; j < k; j++) {
        const daysBefore = 0.6 + 27 * Math.pow(rng(), 1.6);
        const target = c.offset + daysBefore;
        if (target > 89) continue;
        const x = daysBefore / 27; // 1 = far, 0 = near
        const menu = cap < 0.5 ? [['speeding', 3], ['harsh_brake', 2], ['harsh_accel', 1]]
          : x > 0.6 ? [['speeding', 3.5], ['harsh_brake', 3], ['following_distance', 2], ['harsh_turn', 1.5]]
            : x > 0.3 ? [['following_distance', 3.5], ['harsh_brake', 2.5], ['distracted', 2.5], ['speeding', 1.5]]
              : [['distracted', 3.5], ['following_distance', 3], ['harsh_brake', 2.5], ['speeding', 1]];
        const type = weighted(rng, menu);
        let it = byFleet[f.id].find((y) => !y.locked && y !== c && LEAD_TYPES.includes(y.type) && Math.abs(y.offset - target) <= 1.3);
        if (!it) { it = { f, def: c.def, rng, offset: target, type, v: c.v, locked: true }; plan.push(it); byFleet[f.id].push(it); }
        it.v = c.v; it.type = type; it.locked = true; it.offset = target; it.night = rng() < 0.4; it.precursor = true;
        if (type === 'distracted') it.distractionKind = x < 0.5 && rng() < 0.55 ? 'drowsy' : 'phone';
        made++;
      }
      if (made) precursorCollisions++;
    }
  }
  plan.sort((a, b) => b.offset - a.offset); // oldest first so ids ascend with time
  // ---------- generate ----------
  let n = 0;
  const logs = [];
  for (const p of plan) {
    const { f, def, rng, offset, type, v } = p;
    const hourLocal = p.night ? pick(rng, [22, 23, 0, 1, 2, 3, 4]) : weighted(rng, [[5, 1], [6, 3], [7, 5], [8, 6], [9, 6], [10, 6], [11, 6], [12, 6], [13, 6], [14, 6], [15, 6], [16, 6], [17, 5], [18, 4], [19, 3], [20, 2], [22, 1.5], [1, 1], [3, 0.7]]);
    let t = new Date(now.getTime() - offset * 86400000);
    t.setUTCHours((hourLocal + 5) % 24, int(rng, 0, 59), int(rng, 0, 59), 0);
    if (t > now) t = new Date(now.getTime() - int(rng, 20, 300) * 60000);
    if (now - t < 20 * 60000) t = new Date(now.getTime() - 20 * 60000);
    const ageDays = (now - t) / 86400000;
    const spec = makeSpec(rng, f, v, type, { timestamp: t.toISOString(), ageDays, distractionKind: p.distractionKind, otherKind: p.otherKind });
    const payload = fixtures.build(f.vendor, spec);
    n++;
    const t0 = process.hrtime.bigint();
    const inc = await pipeline.ingest(f.vendor, payload, { id: 'NX-' + (10000 + n), receivedAt: new Date(t.getTime() + int(rng, 1, 6) * 1000).toISOString(), now, save: false });
    lifecycle(inc, rng, ageDays, ageDays < 2 ? undefined : undefined, f.vendor === 'mantis');
    await db.saveIncident(inc);
    logs.push({ receivedAt: inc.receivedAt, provider: f.vendor, fleetId: f.id, status: 'accepted', latencyMs: 18 + rng() * 60, payloadBytes: JSON.stringify(payload).length, incidentId: inc.id, auth: 'hmac' });
  }
  // ---------- guaranteed demo content: warranty claims + open DTC incidents for every fleet ----------
  const inWar = (v) => { const w = warrantyWindows(v.oem, v.year, v.odometer_mi, now); return w.emissions.active && w.powertrain.active; };
  const claimPlan = ['paid', 'under_review', 'ready', 'more_info_needed'];
  const openPlan = ['pending', 'dispatched', 'en_route'];
  for (const f of fleets) {
    const rng = rngFrom('extras:' + f.id);
    const cands = f.vehicles.filter(inWar);
    const pool = (cands.length ? cands : [...f.vehicles].sort((a, b) => b.year - a.year).slice(0, 6));
    const used = new Set();
    const nClaims = f.id === 'fleet_gulfcoast' ? 4 : 3;
    for (let k = 0; k < nClaims; k++) {
      const v = pool.filter((x) => !used.has(x.id))[0] || pool[k % pool.length]; used.add(v.id);
      const st = claimPlan[k % claimPlan.length];
      const ageDays = st === 'ready' ? range(rng, 0.3, 1.2) : st === 'submitted' ? range(rng, 2, 8) : range(rng, 9, 27);
      const t = new Date(now.getTime() - ageDays * 86400000);
      const dtcs = v.cls === 'heavy' ? pick(rng, [[{ spn: 3251, fmi: 0 }, { spn: 4364, fmi: 18 }], [{ spn: 102, fmi: 1 }], [{ spn: 3226, fmi: 2 }, { spn: 5246, fmi: 0 }], [{ spn: 157, fmi: 1 }]]) : [{ code: 'P2002' }, { code: 'P20EE' }];
      const spec = makeSpec(rng, f, v, 'fault_code', { timestamp: t.toISOString(), dtcs, ageDays, hasCamera: f.vendor === 'mantis' ? undefined : false, speed: int(rng, 35, 60), odometer_mi: Math.min(v.odometer_mi, 140000) });
      n++;
      const inc = await pipeline.ingest(f.vendor, fixtures.build(f.vendor, spec), { id: 'NX-' + (10000 + n), receivedAt: t.toISOString(), now, save: false });
      lifecycle(inc, rng, ageDays, ageDays < 1.5 ? 'on_scene' : 'resolved');
      const cp = inc.warranty && inc.warranty.claimPacket;
      if (cp) {
        const at = (m) => new Date(new Date(inc.receivedAt).getTime() + m * 60000).toISOString();
        if (st !== 'ready') {
          claims.ensureMeta(inc); cp.claimNumber = claims.claimNumber(inc); cp.status = 'submitted'; cp.submittedAt = at(300); cp.submittedTo = cp.oemDesk.portal; cp.confirmation = inc.warranty.claimId;
          cp.history.push({ t: cp.submittedAt, status: 'submitted', by: 'fleet', note: 'Submitted (simulated)' });
          inc.timeline.push({ t: at(300), actor: 'fleet', action: 'warranty_submitted', note: `Warranty claim ${inc.warranty.claimId} submitted to ${cp.oemDesk.portal}: claim # ${cp.claimNumber}, est. $${cp.estimatedValueUsd} (simulated)` });
          if (st !== 'submitted') claims.advanceTo(inc, st, +new Date(at(300)), rng);
          inc.timeline.sort((x, y) => (x.t < y.t ? -1 : x.t > y.t ? 1 : 0));
        }
        if (st === 'ready') cp.status = 'ready';
      }
      await db.saveIncident(inc);
      logs.push({ receivedAt: inc.receivedAt, provider: f.vendor, fleetId: f.id, status: 'accepted', latencyMs: 20 + rng() * 50, payloadBytes: 1200, incidentId: inc.id, auth: 'hmac' });
    }
    const pool2 = f.vehicles.filter((x) => !used.has(x.id));
    for (let k = 0; k < 3; k++) {
      const v = pool2[int(rng, 0, pool2.length - 1)];
      const ageDays = range(rng, 0.05, 0.6);
      const t = new Date(now.getTime() - ageDays * 86400000);
      const spec = makeSpec(rng, f, v, 'fault_code', { timestamp: t.toISOString(), ageDays, hasCamera: f.vendor === 'mantis' ? undefined : false, dtcGroup: k === 0 ? 'aftertreatment' : undefined, speed: int(rng, 0, 55) });
      n++;
      const inc = await pipeline.ingest(f.vendor, fixtures.build(f.vendor, spec), { id: 'NX-' + (10000 + n), receivedAt: t.toISOString(), now, save: false });
      lifecycle(inc, rng, ageDays, openPlan[k]);
      await db.saveIncident(inc);
      logs.push({ receivedAt: inc.receivedAt, provider: f.vendor, fleetId: f.id, status: 'accepted', latencyMs: 22 + rng() * 40, payloadBytes: 1100, incidentId: inc.id, auth: 'hmac' });
    }
  }
  pipeline.seedCounter(10000 + n);
  // ---------- ingest log (so the integration-health view has history) + a few dead letters to replay ----------
  const lrng = rngFrom('ingestlog');
  for (const l of logs) await ingestLog.record(l);
  const bad = fixtures.build('geotab', makeSpec(lrng, fleets.find((x) => x.id === 'fleet_bluegrass'), fleets.find((x) => x.id === 'fleet_bluegrass').vehicles[0], 'harsh_brake', { timestamp: new Date(now.getTime() - 3 * 3600000).toISOString() }));
  for (let i = 0; i < 3; i++) {
    const pl = JSON.parse(JSON.stringify(bad)); pl.data.id = `gtb_dl_${i + 1}`; if (i === 0) delete pl.data.latitude; else if (i === 1) pl.data.latitude = 123.4; else pl.data.activeFrom = 'not-a-date';
    await ingestLog.record({ receivedAt: new Date(now.getTime() - (4 - i) * 3600000 + 60000).toISOString(), provider: 'geotab', fleetId: 'fleet_bluegrass', status: 'rejected', error: i === 0 ? 'location.lat/lng missing' : i === 1 ? 'location.lat out of range (-90..90): 123.4' : 'timestamp is not a valid date: "not-a-date"', latencyMs: 3, payloadBytes: JSON.stringify(pl).length, payload: pl, auth: 'hmac', statusCode: 422 });
  }
  const opsRes = await require('./ops').seedOps({ now });
  // deterministic spread of claim outcomes (approved/paid majority, some under review / more info / denied)
  for (const inc of await db.listIncidents({ limit: 1e6, clone: false })) { if (!process.env.NX_NO_SPREAD && claims.spreadOutcome(inc, now.getTime())) await db.saveIncident(inc); }
  return { fleets: fleets.length, incidents: n, skipped: false, precursorCollisions, ops: opsRes };
}

module.exports = { seed, buildRoster, vehicleTrail };
