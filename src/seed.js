// Deterministic demo data: fleets, rosters, GPS positions, ~150 historical incidents over 30 days.
const { FLEETS, MODELS, FIRST, LAST, LOCATIONS, PROVIDERS } = require('./data/ref');
const { rngFrom, pick, int, range, weighted, round, clamp } = require('./util');
const roster = require('./roster');
const db = require('../db');
const pipeline = require('./pipeline');
const fixtures = require('./fixtures');
const { buildVin } = require('./enrich/vin');
const { makeSpec, pickType, pickLoc } = require('./scenarios');
const roadside = require('./enrich/roadside');
const { windows: warrantyWindows } = require('./enrich/warranty');

const TREND_P = { fleet_gulfcoast: 1.0, fleet_goodyear: 0.9, fleet_piedmont: 1.55, fleet_bluegrass: 0.65, fleet_summit: 1.25 };
const ABBR = { fleet_gulfcoast: 'GCF', fleet_goodyear: 'GYT', fleet_piedmont: 'PLG', fleet_bluegrass: 'BDT', fleet_summit: 'SLM' };
const STATE = { fleet_gulfcoast: 'AL', fleet_goodyear: 'AL', fleet_piedmont: 'NC', fleet_bluegrass: 'KY', fleet_summit: 'GA' };
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
    fleets.push({ id: f.id, name: f.name, vendor: f.vendor, region: f.region, home: f.home, regions: f.regions, companyId: `co_${f.vendor}_${f.id.replace('fleet_', '')}`, cameraPct: f.cameraPct, vehicles, drivers });
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

function lifecycle(inc, rng, ageDays, force) {
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
    if (inc.warranty && inc.warranty.claimPacket && rng() < 0.75) {
      inc.warranty.claimPacket.status = 'submitted';
      tl.push({ t: min(t + int(rng, 20, 240)), actor: 'fleet', action: 'warranty_submitted', note: `Warranty claim ${inc.warranty.claimId} submitted to ${inc.warranty.oem} ($${inc.warranty.claimPacket.estimatedValueUsd})` });
    }
  }
  return inc;
}

async function seed({ reset = false, now = new Date() } = {}) {
  const fleets = buildRoster(now);
  roster.set(fleets);
  // persist fleets/providers
  for (const f of fleets) await db.saveFleet({ ...roster.publicFleet(roster.getFleet(f.id)), id: f.id });
  for (const p of roadside.getProviders()) await db.saveProvider(p);

  if (reset) await db.clearIncidents();
  else if ((await db.countIncidents()) > 0) {
    const all = await db.listIncidents({ limit: 100000 });
    pipeline.seedCounter(Math.max(10000, ...all.map((i) => parseInt(String(i.id).replace(/\D/g, ''), 10) || 0)));
    return { fleets: fleets.length, incidents: all.length, skipped: true };
  }
  const rngAll = rngFrom('history:v1');
  const plan = [];
  for (const f of fleets) {
    const def = FLEETS.find((x) => x.id === f.id);
    const rng = rngFrom('events:' + f.id);
    for (let i = 0; i < def.events; i++) {
      const offset = 30 * Math.pow(rng(), TREND_P[f.id]); // days ago
      plan.push({ f, def, rng, offset });
    }
  }
  plan.sort((a, b) => b.offset - a.offset); // oldest first so ids ascend with time
  let n = 0;
  for (const p of plan) {
    const { f, def, rng, offset } = p;
    const type = pickType(rng, def.profile);
    // weight vehicles by driver safety: lower-scoring drivers have more events
    const vehicles = f.vehicles;
    const v = weighted(rng, vehicles.map((x) => [x, 1 + (100 - (roster.getDriver(x.driverId).safetyScore)) / 18]));
    const hourLocal = weighted(rng, [[5, 1], [6, 3], [7, 5], [8, 6], [9, 6], [10, 6], [11, 6], [12, 6], [13, 6], [14, 6], [15, 6], [16, 6], [17, 5], [18, 4], [19, 3], [20, 2], [22, 1.5], [1, 1], [3, 0.7]]);
    let t = new Date(now.getTime() - offset * 86400000);
    t.setUTCHours((hourLocal + 5) % 24, int(rng, 0, 59), int(rng, 0, 59), 0);
    if (t > now) t = new Date(now.getTime() - int(rng, 20, 300) * 60000);
    if (now - t < 20 * 60000) t = new Date(now.getTime() - 20 * 60000);
    const ageDays = (now - t) / 86400000;
    const spec = makeSpec(rng, f, v, type, { timestamp: t.toISOString(), ageDays });
    const payload = fixtures.build(f.vendor, spec);
    n++;
    const inc = await pipeline.ingest(f.vendor, payload, { id: 'NX-' + (10000 + n), receivedAt: new Date(t.getTime() + int(rng, 1, 6) * 1000).toISOString(), now, save: false });
    lifecycle(inc, rng, ageDays);
    await db.saveIncident(inc);
  }
  // ---- guaranteed demo content: warranty claims + open DTC incidents for every fleet ----
  const inWar = (v) => { const w = warrantyWindows(v.oem, v.year, v.odometer_mi, now); return w.emissions.active && w.powertrain.active; };
  const claimPlan = ['paid', 'paid', 'submitted', 'ready'];
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
      const dtcs = v.cls === 'heavy' ? [pick(rng, [[{ spn: 3251, fmi: 0 }, { spn: 4364, fmi: 18 }], [{ spn: 102, fmi: 1 }], [{ spn: 3226, fmi: 2 }, { spn: 5246, fmi: 0 }], [{ spn: 157, fmi: 1 }]])][0] : [{ code: 'P2002' }, { code: 'P20EE' }];
      const spec = makeSpec(rng, f, v, 'fault_code', { timestamp: t.toISOString(), dtcs: dtcs.flat ? dtcs.flat() : dtcs, ageDays, hasCamera: false, speed: int(rng, 35, 60), odometer_mi: Math.min(v.odometer_mi, 140000) });
      n++;
      const inc = await pipeline.ingest(f.vendor, fixtures.build(f.vendor, spec), { id: 'NX-' + (10000 + n), receivedAt: t.toISOString(), now, save: false });
      lifecycle(inc, rng, ageDays, ageDays < 1.5 ? 'on_scene' : 'resolved');
      const cp = inc.warranty && inc.warranty.claimPacket;
      if (cp) {
        const at = (m) => new Date(new Date(inc.receivedAt).getTime() + m * 60000).toISOString();
        if (st === 'submitted' || st === 'paid') { cp.status = 'submitted'; inc.timeline.push({ t: at(300), actor: 'fleet', action: 'warranty_submitted', note: `Warranty claim ${inc.warranty.claimId} submitted to ${inc.warranty.oem} ($${cp.estimatedValueUsd})` }); }
        if (st === 'paid') { cp.status = 'paid'; inc.timeline.push({ t: at(60 * 24 * 5), actor: 'fleet', action: 'warranty_paid', note: `${inc.warranty.oem} approved and paid $${cp.estimatedValueUsd}` }); }
        if (st === 'ready') cp.status = 'ready';
      }
      await db.saveIncident(inc);
    }
    const pool2 = f.vehicles.filter((x) => !used.has(x.id));
    for (let k = 0; k < 3; k++) {
      const v = pool2[int(rng, 0, pool2.length - 1)];
      const ageDays = range(rng, 0.05, 0.6);
      const t = new Date(now.getTime() - ageDays * 86400000);
      const spec = makeSpec(rng, f, v, 'fault_code', { timestamp: t.toISOString(), ageDays, hasCamera: false, dtcGroup: k === 0 ? 'aftertreatment' : undefined, speed: int(rng, 0, 55) });
      n++;
      const inc = await pipeline.ingest(f.vendor, fixtures.build(f.vendor, spec), { id: 'NX-' + (10000 + n), receivedAt: t.toISOString(), now, save: false });
      lifecycle(inc, rng, ageDays, openPlan[k]);
      await db.saveIncident(inc);
    }
  }
  pipeline.seedCounter(10000 + n);
  return { fleets: fleets.length, incidents: n, skipped: false };
}

module.exports = { seed, buildRoster, vehicleTrail };
