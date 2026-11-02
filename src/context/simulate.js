// Ground-truth generator: picks what the truck was hauling and produces the telemetry that load would cause.
const M = require('./model');
const { PLACES } = require('./places');
const { haversineMi, round, hashStr, rngFrom, pick, int, range, weighted } = require('../util');

const g = (rng) => (rng() + rng() + rng() - 1.5) * 2; // ~N(0, ~1)
const P = (o) => o;
const PROFILES = {
  reefer_perishable: P({ trailer: 'reefer', pickup: (p) => ['food_distributor', 'cold_storage'].includes(p.placeType), frac: [0.78, 0.97], reefer: [34, 38], cat: 'perishable_food' }),
  reefer_frozen: P({ trailer: 'reefer', pickup: (p) => p.placeType === 'cold_storage', frac: [0.78, 0.97], reefer: [-8, 0], cat: 'frozen_food' }),
  reefer_dairy: P({ trailer: 'reefer', pickup: (p) => ['cold_storage', 'food_distributor'].includes(p.placeType), frac: [0.8, 0.96], reefer: [33, 36], cat: 'perishable_food' }),
  tanker_milk: P({ trailer: 'tanker', pickup: (p) => p.placeType === 'farm', frac: [0.9, 1.0], cat: 'perishable_food', milk: true }),
  tanker_fuel: P({ trailer: 'tanker', trailerTare: 15000, pickup: (p) => p.placeType === 'port' && p.contentHint === 'fuel', frac: [0.9, 1.0], cat: 'fuel_liquid' }),
  dry_grocery: P({ trailer: 'dry_van', pickup: (p) => p.placeType === 'grocery_dc' && !p.contentHint, frac: [0.55, 0.9], cat: 'dry_grocery' }),
  reefer_beverage: P({ trailer: 'reefer', pickup: (p) => p.contentHint === 'beverage', frac: [0.75, 0.95], reefer: [36, 44], cat: 'beverage' }),
  box_beverage: P({ trailer: 'none', pickup: (p) => p.contentHint === 'beverage', frac: [0.5, 0.9], cat: 'beverage' }),
  dry_beverage: P({ trailer: 'dry_van', pickup: (p) => p.contentHint === 'beverage', frac: [0.8, 0.98], cat: 'beverage' }),
  dry_general: P({ trailer: 'dry_van', pickup: (p) => p.placeType === 'retail_dc', frac: [0.5, 0.88], cat: 'unknown' }),
  dry_machinery: P({ trailer: 'dry_van', pickup: (p) => p.placeType === 'manufacturer' && !p.contentHint, frac: [0.5, 0.85], cat: 'machinery' }),
  flatbed_steel: P({ trailer: 'flatbed', pickup: (p) => p.placeType === 'steel_yard', frac: [0.85, 1.0], cat: 'steel', unitLb: 14000, unitName: 'steel coils' }),
  flatbed_lumber: P({ trailer: 'flatbed', pickup: (p) => p.placeType === 'lumber_yard', frac: [0.7, 0.95], cat: 'lumber', unitLb: 3500, unitName: 'lumber bundles' }),
  flatbed_building: P({ trailer: 'flatbed', pickup: (p) => p.placeType === 'building_supply', frac: [0.55, 0.9], cat: 'building_materials' }),
  dump_aggregate: P({ trailer: 'dump', pickup: (p) => p.placeType === 'quarry', frac: [0.85, 1.0], cat: 'aggregate' }),
  lowboy_equipment: P({ trailer: 'lowboy', pickup: (p) => ['quarry', 'manufacturer'].includes(p.placeType), synthetic: { placeType: 'unknown', businessName: 'Equipment yard pickup (customer site)' }, frac: [0.5, 0.9], cat: 'machinery' }),
  car_hauler: P({ trailer: 'car_hauler', synthetic: { placeType: 'unknown', businessName: 'Roadside recovery scene (customer vehicles)' }, frac: [0.5, 0.9], cat: 'vehicles' }),
  box_grocery: P({ trailer: 'none', pickup: (p) => p.placeType === 'grocery_dc' && !p.contentHint, frac: [0.5, 0.9], cat: 'dry_grocery' }),
  box_building: P({ trailer: 'none', pickup: (p) => p.placeType === 'building_supply', frac: [0.4, 0.85], cat: 'building_materials' }),
  tow_vehicle: P({ trailer: 'none', synthetic: { placeType: 'unknown', businessName: 'Roadside recovery scene (customer vehicle)' }, frac: [0.3, 0.7], cat: 'vehicles' }),
  van_parcel: P({ trailer: 'none', pickup: (p) => p.placeType === 'parcel_hub', frac: [0.25, 0.9], cat: 'parcel' }),
};
const FLEET_MIX = {
  fleet_gulfcoast: { class8: [['reefer_perishable', 3], ['reefer_frozen', 0.8], ['dry_grocery', 3], ['dry_beverage', 1], ['flatbed_steel', 2], ['flatbed_lumber', 2], ['flatbed_building', 1], ['tanker_fuel', 1.2], ['dump_aggregate', 1]], box: [['box_grocery', 3], ['box_building', 2]] },
  fleet_goodyear: { class8: [['lowboy_equipment', 2], ['car_hauler', 3]], box: [['tow_vehicle', 1]] },
  fleet_piedmont: { class8: [['dry_general', 3], ['reefer_perishable', 2], ['reefer_frozen', 0.7], ['flatbed_lumber', 1.2], ['flatbed_steel', 1], ['dry_machinery', 1.2], ['dry_grocery', 1.5]], box: [['box_grocery', 1]] },
  fleet_bluegrass: { class8: [['tanker_milk', 4], ['reefer_dairy', 3], ['reefer_frozen', 0.8]], box: [['box_grocery', 1]] },
  fleet_redline: { class8: [['dry_general', 3], ['reefer_perishable', 2], ['flatbed_steel', 1], ['dry_machinery', 1.5], ['dry_grocery', 1.5]], box: [['box_grocery', 1]] },
  fleet_magnolia: { class8: [['reefer_beverage', 3], ['dry_beverage', 4]], box: [['box_beverage', 1]] },
  fleet_summit: { van: [['van_parcel', 1]], class8: [['dry_general', 1]], box: [['box_grocery', 1]] },
};

function modelKeyOf(veh) {
  const { MODELS } = require('../data/ref');
  return Object.keys(MODELS).find((k) => MODELS[k].make === veh.make && MODELS[k].model === veh.model) || null;
}
function tractorSpec(veh, inc) {
  const mk = veh && modelKeyOf(veh) || modelKeyOf(inc.vehicle);
  const mc = (mk && M.MODEL_CLASS[mk]) || { cls: (inc.vehicle.oem && ['Ford', 'Mercedes-Benz'].includes(inc.vehicle.oem)) ? 'van' : 'class8_sleeper' };
  const base = M.CLASSES[mc.cls];
  return { class: mc.cls, gvwrLb: mc.gvwr || base.gvwr, tareLb: mc.tare || base.tare, axles: base.axles, fuelType: mc.fuelType || base.fuelType };
}
const groupOf = (cls) => (cls.startsWith('class8') ? 'class8' : cls === 'van' ? 'van' : 'box');

const synthPlace = (s, inc, rng, dist = 40) => {
  const hdg = (((inc.location.heading || 90) + 180) % 360) * Math.PI / 180;
  const lat = inc.location.lat + (dist * Math.cos(hdg)) / 69, lng = inc.location.lng + (dist * Math.sin(hdg)) / (69 * Math.cos(inc.location.lat * Math.PI / 180));
  return { id: null, name: s.businessName, businessName: s.businessName, placeType: s.placeType, lat: round(lat, 4), lng: round(lng, 4), address: `near ${inc.location.road || 'highway'}, ${String(inc.location.address || '').split(', ').slice(-2).join(', ')}`, contentHint: null };
};
function nearPlaces(inc, filter, lo = 22, hi = 120) {
  const withD = PLACES.filter(filter).map((p) => ({ p, d: haversineMi(inc.location.lat, inc.location.lng, p.lat, p.lng) })).sort((a, b) => a.d - b.d);
  const inBand = withD.filter((x) => x.d >= lo && x.d <= hi);
  return inBand.length ? inBand : [];
}

// Returns the hidden ground truth for a trip. hint: {profile, payloadLb, tripKind, cameraTrailer}
function genTruth(inc, veh, tractor, rng, hint = {}) {
  const group = groupOf(tractor.class);
  const mix = (FLEET_MIX[inc.fleetId] || FLEET_MIX.fleet_gulfcoast)[group] || FLEET_MIX.fleet_gulfcoast[group] || [['dry_general', 1]];
  let cands = hint.profile ? [[hint.profile, 1]] : [...mix];
  // try profiles in weighted random order until one has a pickup place in range
  const order = [];
  const tmp = cands.map((c) => [...c]);
  while (tmp.length) { const k = weighted(rng, tmp); order.push(k); tmp.splice(tmp.findIndex((t) => t[0] === k), 1); }
  let prof = null, profKey = null, pickupPlace = null;
  for (const k of order) {
    const pf = PROFILES[k];
    if (pf.synthetic) { prof = pf; profKey = k; pickupPlace = synthPlace(pf.synthetic, inc, rng, int(rng, 25, 70)); break; }
    const c = nearPlaces(inc, pf.pickup);
    if (c.length) { prof = pf; profKey = k; pickupPlace = pick(rng, c.slice(0, 4)).p; break; }
  }
  if (!prof) { // fall back: nearest place of any pickup type
    const k = order[0]; prof = PROFILES[k]; profKey = k;
    const c = PLACES.filter(prof.pickup || (() => true)).map((p) => ({ p, d: haversineMi(inc.location.lat, inc.location.lng, p.lat, p.lng) })).sort((a, b) => a.d - b.d)[0];
    pickupPlace = c ? c.p : synthPlace({ placeType: 'unknown', businessName: 'Customer site' }, inc, rng, 40);
  }
  const trailerType = prof.trailer;
  const tr = M.TRAILERS[trailerType];
  const trailerTare = trailerType === 'none' ? 0 : (prof.trailerTare || tr.tare);
  const tractorTare = tractor.tareLb;
  const maxPayload = tractor.gvwrLb - tractorTare - trailerTare - M.MISC_LB;
  let payload = hint.payloadLb != null ? hint.payloadLb : maxPayload * range(rng, prof.frac[0], prof.frac[1]);
  if (hint.payloadLb == null && trailerType !== 'none' && rng() < 0.05) payload = maxPayload * range(rng, 1.01, 1.05); // occasional overweight
  const kindW = hint.tripKind ? [[hint.tripKind, 1]] : (prof.synthetic ? [['pickup', 1]] : [['pickup', 0.74], ['transit', 0.2], ['delivery', 0.06]]);
  const kind = weighted(rng, kindW);
  let lastStop = pickupPlace, role = 'pickup';
  if (kind === 'transit') {
    const c = nearPlaces(inc, (p) => p.placeType === 'truck_stop', 10, 90);
    lastStop = c.length ? pick(rng, c.slice(0, 3)).p : synthPlace({ placeType: 'fuel_stop', businessName: 'Interstate Fuel Stop' }, inc, rng, int(rng, 18, 40));
    role = 'fuel';
  } else if (kind === 'delivery') {
    const c = nearPlaces(inc, (p) => ['retail_dc', 'building_supply', 'grocery_dc'].includes(p.placeType) && p.id !== pickupPlace.id, 15, 100);
    lastStop = c.length ? pick(rng, c.slice(0, 3)).p : synthPlace({ placeType: 'retail_dc', businessName: 'Customer receiving dock' }, inc, rng, 30);
    role = 'delivery';
  }
  const payBefore = kind === 'pickup' ? (tractor.class === 'van' ? 0 : 0) : payload;
  const payAfter = kind === 'delivery' ? 0 : payload;
  const reefer = prof.reefer ? { setpointF: Math.round(range(rng, prof.reefer[0], prof.reefer[1])), unitRunning: rng() > 0.2, fuelPct: Math.round(range(rng, 35, 92)) } : null;
  const units = prof.unitLb ? Math.max(1, Math.round(payload / (prof.unitLb * range(rng, 0.92, 1.08)))) : null;
  return { profKey, prof, kind, role, pickupPlace, lastStop, trailerType, trailerTare, maxPayload, payload, payBefore, payAfter, reefer, units, tractor,
    biasL: 1 + g(rng) * 0.035, biasM: 1 + g(rng) * 0.03, gross: (p) => tractorTare + trailerTare + M.MISC_LB + p };
}

// Dense 30s telemetry from before-approach to incident time.
function simulate(inc, truth, rng) {
  const cls = truth.tractor.class;
  const tInc = new Date(inc.timestamp).getTime();
  const dist = haversineMi(inc.location.lat, inc.location.lng, truth.lastStop.lat, truth.lastStop.lng);
  const cruise = cls === 'van' ? range(rng, 54, 62) : range(rng, 57, 64);
  const minsSince = Math.max(26, Math.round(((dist * 1.25) / cruise) * 60));
  const dwell = truth.kind === 'pickup' ? int(rng, 18, 52) : truth.kind === 'transit' ? int(rng, 8, 19) : int(rng, 25, 55);
  const D = tInc - minsSince * 60000;
  const A = D - dwell * 60000;
  const start = A - 16 * 60000;
  const phase = range(rng, 0, 6.28);
  const out = [];
  const incSpeed = inc.location.speed_mph != null ? inc.location.speed_mph : cruise;
  for (let t = start; t <= tInc; t += 30000) {
    let v, gross, stage;
    if (t < A) { stage = 'approach'; v = cruise * (t > A - 150000 ? Math.max(0.15, (A - t) / 150000) : 1); gross = truth.gross(truth.payBefore); }
    else if (t < D) { stage = 'stop'; v = 0; gross = truth.gross(truth.payAfter); }
    else { stage = t < D + 3 * 60000 ? 'ramp' : 'cruise'; v = stage === 'ramp' ? cruise * ((t - D) / 180000) : cruise; gross = truth.gross(truth.payAfter); if (t > tInc - 90000) v = cruise + (incSpeed - cruise) * ((t - (tInc - 90000)) / 90000); }
    v = Math.max(0, v + (v > 0 ? g(rng) * 1.2 : 0));
    const grade = Math.sin(phase + (t - start) / 420000) * 1.1;
    let load, mpg, rpm;
    if (v === 0) { load = 9 + g(rng) * 1.2; mpg = 0; rpm = 650; }
    else {
      load = M.loadAt(cls, gross) * M.speedLoadF(v) * truth.biasL + grade + g(rng) * 1.1;
      mpg = M.mpgAt(cls, gross) * M.speedMpgF(v) * truth.biasM * (1 - grade * 0.012) * (1 + g(rng) * 0.018);
      if (stage === 'ramp') { load *= 1.25; mpg *= 0.7; }
      rpm = 1050 + v * 6.2 + (load - 30) * 4 + g(rng) * 15;
    }
    out.push({ t, stage, speedMph: v, engineLoadPct: Math.min(99, Math.max(5, load)), fuelMpg: Math.max(0, mpg), rpm });
  }
  return { samples: out, A, D, dwellMin: dwell, minsSince, distMi: dist, cruise };
}

module.exports = { PROFILES, FLEET_MIX, genTruth, simulate, tractorSpec, modelKeyOf, synthPlace, g };
