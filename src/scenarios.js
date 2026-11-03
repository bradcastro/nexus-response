// Builds realistic event "specs" (fed to vendor fixture builders -> real adapters) for seed + live simulation.
const { LOCATIONS } = require('./data/ref');
const { pick, int, range, weighted, round, clamp } = require('./util');
const fixtures = require('./fixtures');
const roster = require('./roster');
const warranty = require('./enrich/warranty');

const HEAVY_GROUPS = {
  aftertreatment: ['3251:0', '4364:18', '3719:16', '3226:2', '5246:0', '1761:1'],
  cooling: ['110:0', '110:15', '111:1'], fuel: ['157:1', '94:1', '157:18'], air: ['102:1', '102:2', '105:0'],
  electrical: ['168:4', '639:2', '628:12'], brakes: ['116:1', '117:1', '904:2'], trans: ['127:1', '177:0'], oil: ['100:1', '175:0'], engine: ['1323:2', '190:0', '91:2'],
};
const LIGHT_GROUPS = {
  aftertreatment: ['P2002', 'P20EE', 'P0420', 'P0401'], fuel: ['P0087', 'P0171'], engine: ['P0300', 'P0299', 'P0524'], trans: ['P0700', 'P0218'], electrical: ['P0562', 'C0035'], cooling: ['P0128'],
};
const toDtc = (k) => (k.includes(':') ? { spn: +k.split(':')[0], fmi: +k.split(':')[1] } : { code: k });

function pickDtcs(rng, cls, group) {
  const groups = cls === 'heavy' ? HEAVY_GROUPS : LIGHT_GROUPS;
  const names = Object.keys(groups);
  const g = group && groups[group] ? group : weighted(rng, names.map((n) => [n, n === 'aftertreatment' ? 4 : n === 'electrical' ? 2 : 3]));
  const pool = [...groups[g]];
  const n = Math.min(pool.length, weighted(rng, [[1, 5], [2, 4], [3, 1]]));
  const out = [];
  while (out.length < n) out.push(toDtc(pool.splice(Math.floor(rng() * pool.length), 1)[0]));
  return out;
}

const TYPE_W = [['collision', 19, 'collision'], ['rollover', 0.35, 'collision'], ['harsh_brake', 16, 'harsh'], ['harsh_accel', 6, 'harsh'], ['harsh_turn', 7, 'harsh'], ['speeding', 14, 'speeding'], ['distracted', 10, 'distraction'], ['following_distance', 8, 'distraction'], ['fault_code', 16, 'diag'], ['breakdown', 4, 'diag'], ['tire', 6, 'diag'], ['battery', 4, 'diag']];
const pickType = (rng, profile) => weighted(rng, TYPE_W.map(([t, w, k]) => [t, w * (profile[k] || 1)]));

const pickLoc = (rng, regions) => { const pool = LOCATIONS.filter((l) => l.r.some((x) => regions.includes(x))); return pick(rng, pool.length ? pool : LOCATIONS); };

function makeSpec(rng, fleet, vehicle, type, o = {}) {
  const driver = o.driver || roster.getDriver(vehicle.driverId) || fleet.drivers[0];
  const loc = o.loc || pickLoc(rng, fleet.regions);
  const heavy = vehicle.cls === 'heavy';
  const stationary = ['fault_code', 'breakdown', 'tire', 'battery'].includes(type);
  let speed;
  if (o.speed != null) speed = o.speed;
  else if (type === 'speeding') speed = int(rng, heavy ? 72 : 76, heavy ? 82 : 91);
  else if (type === 'collision' || type === 'rollover') speed = int(rng, 28, 68);
  else if (stationary) speed = type === 'breakdown' ? int(rng, 0, 12) : int(rng, 0, 62);
  else speed = int(rng, 34, 66);
  const hasCamera = o.hasCamera != null ? o.hasCamera : vehicle.hasCamera && (!stationary || fleet.vendor === 'mantis');
  let gForce = o.gForce, airbag = o.airbag, aiLabel = o.aiLabel, aiConfidence = o.aiConfidence, roadSurface = o.roadSurface;
  const mlVendor = fleet.vendor === 'lytx' ? 1 : fleet.vendor === 'samsara' ? 0.6 : fleet.vendor === 'motive' ? 0.5 : 0.3;
  if (gForce === undefined) {
    if (type === 'collision' || type === 'rollover') {
      const r = rng();
      if (r < 0.12 && hasCamera) { gForce = round(range(rng, 0.9, 1.8), 1); aiLabel = 'false_positive'; aiConfidence = round(range(rng, 0.86, 0.96), 2); roadSurface = pick(rng, ['railroad crossing', 'pothole', 'speed bump', 'rough pavement']); }
      else if (r < 0.8) { gForce = round(range(rng, 3.2, 6.4), 1); airbag = gForce > 4.8 && rng() < 0.55; if (rng() < mlVendor) { aiLabel = 'collision'; aiConfidence = round(range(rng, 0.88, 0.98), 2); } }
      else gForce = round(range(rng, 2.6, 3.4), 1);
    } else if (type === 'harsh_brake') { const fp = rng() < 0.08 && hasCamera; gForce = fp ? round(range(rng, 0.15, 0.28), 2) : round(range(rng, 0.45, 0.95), 2); if (fp) { aiLabel = 'false_positive'; aiConfidence = round(range(rng, 0.85, 0.94), 2); roadSurface = 'pothole'; } }
    else if (type === 'harsh_turn') gForce = round(range(rng, 0.4, 0.75), 2);
    else if (type === 'harsh_accel') gForce = round(range(rng, 0.35, 0.6), 2);
    else gForce = null;
  }
  const isMantis = fleet.vendor === 'mantis';
  const distractionKind = type === 'distracted' ? (o.distractionKind || pick(rng, ['phone', 'phone', 'drowsy', 'drowsy', 'smoking'])) : undefined;
  const otherKind = type === 'other' ? (o.otherKind || pick(rng, ['seatbelt', 'lane'])) : undefined;
  let mantis;
  if (isMantis && hasCamera) {
    const fp = aiLabel === 'false_positive';
    mantis = {
      followS: round(type === 'following_distance' ? range(rng, 0.4, 0.95) : type === 'harsh_brake' ? range(rng, 0.7, 1.4) : range(rng, 1.6, 3.4), 1),
      drowsiness: round(distractionKind === 'drowsy' ? range(rng, 0.65, 0.97) : range(rng, 0.02, 0.28), 2),
      phone: distractionKind === 'phone', smoking: distractionKind === 'smoking', seatbelt: otherKind !== 'seatbelt',
      laneDeparture: otherKind === 'lane' || (type === 'collision' && !fp && rng() < 0.25),
      fcw: !fp && (type === 'collision' || (type === 'following_distance' && rng() < 0.5) || (type === 'harsh_brake' && rng() < 0.55)),
      eyesOff: round(distractionKind === 'phone' ? range(rng, 2.2, 5.5) : distractionKind === 'drowsy' ? range(rng, 1.5, 3.5) : range(rng, 0.2, 1.1), 1),
    };
    if (aiLabel == null || !['false_positive'].includes(aiLabel)) {
      aiLabel = type === 'collision' || type === 'rollover' ? 'confirmed_collision' : type === 'distracted' ? 'distraction' : (type === 'harsh_brake' || type === 'following_distance') ? 'near_miss' : 'confirmed_event';
    }
    aiConfidence = aiConfidence != null && aiLabel === 'false_positive' ? aiConfidence : round(range(rng, 0.9, 0.99), 2);
  }
  let dtcs = o.dtcs;
  if (!dtcs && (type === 'fault_code' || type === 'breakdown')) {
    dtcs = pickDtcs(rng, vehicle.cls, o.dtcGroup || (type === 'breakdown' ? weighted(rng, [['oil', 1], ['cooling', 2], ['trans', 1], ['brakes', 1], ['aftertreatment', 2], ['engine', 2], ['fuel', 1]]) : undefined));
  }
  const ageDays = o.ageDays || 0;
  const mpd = (heavy ? 280 : 90);
  return {
    eventId: o.eventId || `${fleet.vendor}_evt_${int(rng, 100000, 999999)}`, eventType: type, timestamp: o.timestamp,
    companyId: fleet.companyId,
    vehicle: { providerVehicleId: vehicle.providerVehicleId, unit: vehicle.unit, vin: vehicle.vin, make: vehicle.make, model: vehicle.model, year: vehicle.year, plate: vehicle.plate },
    driver: { providerDriverId: driver.providerDriverId, name: driver.name, phone: driver.phone },
    location: { lat: round(loc.lat + range(rng, -0.04, 0.04), 5), lng: round(loc.lng + range(rng, -0.04, 0.04), 5), address: `${loc.road}, ${loc.city}, ${loc.st}`, speed_mph: speed, heading: (loc.h + int(rng, -12, 12) + 360) % 360 },
    gForce, airbag: !!airbag, aiLabel, aiConfidence, roadSurface, facingForward: o.facingForward != null ? o.facingForward : rng() > 0.18, postedLimit: type === 'speeding' ? pick(rng, [55, 65]) : undefined,
    hasCamera, driverFacing: hasCamera,
    odometer_mi: o.odometer_mi != null ? o.odometer_mi : Math.max(1000, Math.round(vehicle.odometer_mi - ageDays * mpd)),
    engineHours: Math.round((o.odometer_mi != null ? o.odometer_mi : vehicle.odometer_mi - ageDays * mpd) / (heavy ? 38 : 28)),
    dtcs, faultLamp: dtcs ? true : false, mantis, distractionKind, otherKind,
  };
}

// ---- live scenarios ----
const sample = (rng, arr) => arr[Math.floor(rng() * arr.length)];
function vehiclesOf(fl, pred) { return fl.vehicles.filter(pred || (() => true)); }

function inWarrantyFor(v, cat, at = new Date()) {
  const w = warranty.windows(v.oem, v.year, v.odometer_mi, at);
  return w[cat] && w[cat].active;
}

function scenarioSpec(name, rng, o = {}) {
  const fleets = roster.all().filter((f) => !f.custom && f.vehicles.length);
  let fleet = o.fleetId ? roster.getFleet(o.fleetId) : null;
  const withVeh = (f, pred) => vehiclesOf(f, pred);
  const ts = o.timestamp || new Date().toISOString();
  const pickFleet = (pred) => {
    const c = fleets.filter((f) => !pred || withVeh(f, pred).length);
    return sample(rng, c);
  };
  const choose = (pred) => { fleet = fleet || pickFleet(pred); const c = withVeh(fleet, pred); return c.length ? sample(rng, c) : sample(rng, fleet.vehicles); };
  let v = o.vehicleId ? roster.getVehicle(o.vehicleId) : null;
  if (v) fleet = roster.getFleet(v.fleetId);
  if (name === 'random') {
    name = weighted(rng, [['collision_camera', 2], ['dtc_breakdown', 2], ['warranty_failure', 1], ['false_positive', 1], ['reefer_collision', 0.8], ['flatbed_steel_collision', 0.6], ['warranty_dealer_breakdown', 0.8], ['hazmat_tanker_rollover', 0.3], ['speeding', 1.2], ['harsh_brake', 1.5], ['harsh_turn', 0.6], ['distracted', 1.2], ['following_distance', 0.8], ['tire', 0.7], ['battery', 0.5]]);
  }
  switch (name) {
    case 'mantis_collision': {
      if (v && v.fleetId && roster.getFleet(v.fleetId).vendor !== 'mantis') { v = null; fleet = null; }
      if (fleet && fleet.vendor !== 'mantis') fleet = null;
      fleet = fleet || sample(rng, fleets.filter((f) => f.vendor === 'mantis' && f.vehicles.some((x) => x.hasCamera)));
      v = v || sample(rng, fleet.vehicles.filter((x) => x.hasCamera));
      return { name, fleet, spec: makeSpec(rng, fleet, v, 'collision', { timestamp: ts, hasCamera: true, gForce: round(range(rng, 4.2, 5.9), 1), airbag: rng() < 0.7, aiLabel: 'collision', aiConfidence: round(range(rng, 0.9, 0.97), 2), speed: int(rng, 52, 68), facingForward: true }) };
    }
    case 'collision_camera': {
      v = v || choose((x) => x.hasCamera);
      return { name, fleet, spec: makeSpec(rng, fleet, v, 'collision', { timestamp: ts, hasCamera: true, gForce: round(range(rng, 4.2, 5.9), 1), airbag: rng() < 0.7, aiLabel: 'collision', aiConfidence: round(range(rng, 0.9, 0.97), 2), speed: int(rng, 52, 68), facingForward: true }) };
    }
    case 'dtc_breakdown': {
      v = v || choose((x) => x.cls === 'heavy');
      const grp = sample(rng, v.cls === 'heavy' ? ['oil', 'cooling', 'trans', 'aftertreatment'] : ['engine', 'trans', 'aftertreatment']);
      return { name, fleet, spec: makeSpec(rng, fleet, v, 'breakdown', { timestamp: ts, dtcGroup: grp, speed: int(rng, 0, 6) }) };
    }
    case 'warranty_failure': {
      v = v || (() => {
        fleet = fleet || null;
        const pool = [];
        for (const f of fleets) if (!o.fleetId || f.id === o.fleetId) for (const x of f.vehicles) if (inWarrantyFor(x, 'emissions') && inWarrantyFor(x, 'powertrain')) pool.push(x);
        const pref = pool.filter((x) => x.cls === 'heavy');
        if (!pool.length && o.fleetId && fleet) return sample(rng, fleet.vehicles);
        return sample(rng, pref.length ? pref : pool.length ? pool : fleets[0].vehicles);
      })();
      fleet = roster.getFleet(v.fleetId);
      const grp = v.cls === 'heavy' ? 'aftertreatment' : 'aftertreatment';
      const dtcs = v.cls === 'heavy' ? [{ spn: 3251, fmi: 0 }, { spn: 4364, fmi: 18 }] : [{ code: 'P2002' }, { code: 'P20EE' }];
      return { name, fleet, spec: makeSpec(rng, fleet, v, 'fault_code', { timestamp: ts, dtcs, speed: int(rng, 38, 58), hasCamera: false }) };
    }
    case 'false_positive': {
      v = v || choose((x) => x.hasCamera);
      const coll = rng() < 0.6;
      return { name, fleet, spec: makeSpec(rng, fleet, v, coll ? 'collision' : 'harsh_brake', { timestamp: ts, hasCamera: true, gForce: coll ? round(range(rng, 1.0, 1.6), 1) : 0.22, airbag: false, aiLabel: 'false_positive', aiConfidence: round(range(rng, 0.9, 0.96), 2), roadSurface: sample(rng, ['railroad crossing', 'pothole', 'speed bump']), speed: int(rng, 28, 55) }) };
    }
    case 'reefer_collision': case 'flatbed_steel_collision': case 'hazmat_tanker_rollover': {
      const wantFleets = name === 'hazmat_tanker_rollover' ? ['fleet_gulfcoast'] : name === 'reefer_collision' ? ['fleet_gulfcoast', 'fleet_piedmont', 'fleet_bluegrass'] : ['fleet_gulfcoast', 'fleet_piedmont'];
      const sleeperKeys = ['fcascadia', 'vnl', 'p579', 'kt680'];
      if (!v) {
        if (!fleet || (!o.fleetId && !wantFleets.includes(fleet.id))) fleet = roster.getFleet(sample(rng, wantFleets));
        const pool = fleet.vehicles.filter((x) => sleeperKeys.includes(x.modelKey) && (name === 'hazmat_tanker_rollover' || x.hasCamera));
        const heavy = fleet.vehicles.filter((x) => x.cls === 'heavy');
        v = pool.length ? sample(rng, pool) : sample(rng, heavy.length ? heavy : fleet.vehicles);
      }
      const fleetProfile = { reefer_collision: fleet.id === 'fleet_bluegrass' ? 'reefer_dairy' : 'reefer_perishable', flatbed_steel_collision: 'flatbed_steel', hazmat_tanker_rollover: 'tanker_fuel' }[name];
      const hint = { profile: fleetProfile, tripKind: 'pickup', cameraTrailer: name !== 'hazmat_tanker_rollover', payloadLb: name === 'reefer_collision' ? int(rng, 38000, 44000) : name === 'flatbed_steel_collision' ? int(rng, 40500, 44500) : int(rng, 40000, 45000) };
      const isRoll = name === 'hazmat_tanker_rollover';
      const spec = makeSpec(rng, fleet, v, isRoll ? 'rollover' : 'collision', { timestamp: ts, hasCamera: v.hasCamera, gForce: round(range(rng, isRoll ? 4.8 : 4.0, isRoll ? 6.2 : 5.6), 1), airbag: isRoll || rng() < 0.6, aiLabel: 'collision', aiConfidence: round(range(rng, 0.9, 0.97), 2), speed: int(rng, isRoll ? 38 : 50, isRoll ? 56 : 66), facingForward: true });
      return { name, fleet, spec, contextHint: hint };
    }
    case 'warranty_dealer_breakdown': {
      if (!v) {
        const pool = [];
        for (const f of fleets) if (!o.fleetId || f.id === o.fleetId) for (const x of f.vehicles) if (['Freightliner', 'Volvo'].includes(x.oem) && x.cls === 'heavy' && inWarrantyFor(x, 'emissions') && inWarrantyFor(x, 'powertrain')) pool.push(x);
        v = pool.length ? sample(rng, pool) : sample(rng, fleets[0].vehicles.filter((x) => x.oem === 'Freightliner'));
      }
      fleet = roster.getFleet(v.fleetId);
      const dtcs = rng() < 0.5 ? [{ spn: 102, fmi: 1 }, { spn: 100, fmi: 1 }] : [{ spn: 4364, fmi: 18 }, { spn: 5246, fmi: 0 }, { spn: 3251, fmi: 0 }];
      return { name, fleet, spec: makeSpec(rng, fleet, v, 'fault_code', { timestamp: ts, dtcs, speed: int(rng, 30, 55), hasCamera: false, odometer_mi: Math.min(v.odometer_mi, 120000) }), contextHint: { tripKind: 'pickup' } };
    }
    default: {
      const type = ['speeding', 'harsh_brake', 'harsh_turn', 'harsh_accel', 'distracted', 'following_distance', 'tire', 'battery', 'collision', 'fault_code', 'breakdown'].includes(name) ? name : 'harsh_brake';
      v = v || choose();
      return { name: type, fleet, spec: makeSpec(rng, fleet, v, type, { timestamp: ts }) };
    }
  }
}

module.exports = { makeSpec, scenarioSpec, pickType, pickLoc, pickDtcs, SCENARIOS: ['mantis_collision', 'collision_camera', 'dtc_breakdown', 'warranty_failure', 'false_positive', 'reefer_collision', 'flatbed_steel_collision', 'warranty_dealer_breakdown', 'hazmat_tanker_rollover', 'random'] };
