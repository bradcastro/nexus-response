// Incident context intelligence: trip + equipment + load (inferred from telemetry) + OEM warranty dealer + tow destination.
const roster = require('../roster');
const M = require('./model');
const sim = require('./simulate');
const { inferLoad } = require('./infer');
const dealers = require('./dealers');
const { PLACES } = require('./places');
const risk = require('../enrich/risk');
const { rngFrom, hashStr, haversineMi, round, int, range, pick } = require('../util');

const YARDS = {
  fleet_gulfcoast: { name: 'Gulf Coast Freight Yard', address: '2400 Dauphin Island Pkwy, Mobile, AL', lat: 30.6602, lng: -88.0802 },
  fleet_elite: { name: 'Elite Towing Yard', address: 'Enterprise, AL', lat: 31.3152, lng: -85.8552 },
  fleet_piedmont: { name: 'Piedmont Logistics Terminal', address: '5100 Statesville Rd, Charlotte, NC', lat: 35.2702, lng: -80.8502 },
  fleet_bluegrass: { name: 'Bluegrass Dairy Transport Terminal', address: 'Lexington, KY', lat: 38.0406, lng: -84.5037 },
  fleet_redline: { name: 'Redline Regional Terminal', address: 'Nashville, TN', lat: 36.16, lng: -86.78 },
  fleet_magnolia: { name: 'Magnolia Beverage Distribution Center', address: 'Jackson, MS', lat: 32.3, lng: -90.18 },
  fleet_summit: { name: 'Summit Last-Mile Hub', address: 'Atlanta, GA', lat: 33.8, lng: -84.4 },
};
const iso = (ms) => new Date(ms).toISOString();
const stopOut = (p, arr, dep) => ({ name: p.businessName, placeType: p.placeType, businessName: p.businessName, lat: p.lat, lng: p.lng, address: p.address, arrivedAt: iso(arr), departedAt: iso(dep), dwellMin: Math.round((dep - arr) / 60000), contentHint: p.contentHint || null });

function windowStats(samples, from, to) {
  const w = samples.filter((s) => s.t >= from && s.t <= to && s.speedMph > 20);
  const m = (k) => (w.length ? w.reduce((a, s) => a + s[k], 0) / w.length : 0);
  return { avgEngineLoadPct: round(m('engineLoadPct'), 1), avgFuelMpg: round(m('fuelMpg'), 2), avgSpeedMph: round(m('speedMph'), 1), avgRpm: Math.round(m('rpm')), sampleCount: w.length };
}

function buildCamVisual(truth, camVerified, rng) {
  if (!camVerified) return null;
  const t = truth.trailerType, prof = truth.prof;
  if (t === 'flatbed' && prof.unitName) {
    const n = Math.max(1, truth.units + (rng() < 0.06 ? (rng() < 0.5 ? -1 : 1) : 0));
    const word = prof.unitName === 'steel coils' ? 'steel coils' : 'lumber bundles';
    return { cargoVisible: true, description: `Flatbed with ${n} ${word} visible${prof.unitName === 'steel coils' ? ', chain-strapped' : ''}`, confidence: round(range(rng, 0.8, 0.93), 2), unitCount: n, unitName: word, unitNominalLb: prof.unitLb };
  }
  if (t === 'flatbed') return { cargoVisible: true, description: 'Flatbed with palletized building materials visible', confidence: round(range(rng, 0.7, 0.85), 2) };
  if (t === 'reefer') return { cargoVisible: false, description: 'Reefer box sealed; refrigeration unit visible on nose', confidence: round(range(rng, 0.85, 0.95), 2) };
  if (t === 'tanker') return { cargoVisible: false, description: truth.prof.cat === 'fuel_liquid' ? 'Tank trailer with flammable-liquid placard visible' : 'Insulated stainless tank trailer visible', confidence: round(range(rng, 0.8, 0.92), 2) };
  if (t === 'dry_van') return { cargoVisible: false, description: 'Enclosed dry van; cargo not visible', confidence: round(range(rng, 0.85, 0.95), 2) };
  if (t === 'car_hauler' || t === 'lowboy') return { cargoVisible: true, description: t === 'lowboy' ? 'Lowboy with heavy equipment on deck' : 'Car carrier with vehicles on deck', confidence: round(range(rng, 0.8, 0.92), 2) };
  return null;
}

function trailerOut(truth, veh, rng, hint) {
  const tt = truth.trailerType;
  if (tt === 'none') return { attached: false, type: 'none', lengthFt: null, unitId: null, tareLb: 0, maxPayloadLb: truth.maxPayload, reefer: null, detectedBy: 'inferred', cameraVerified: false, cameraBasis: null };
  const hasCam = !!(veh && veh.hasCamera);
  const camVerified = hasCam && (hint.cameraTrailer || rng() < 0.82);
  const len = M.TRAILERS[tt].lengthFt;
  const names = { reefer: 'refrigerated box with refrigeration unit', dry_van: 'enclosed dry van', flatbed: 'flatbed deck', tanker: 'tank trailer', lowboy: 'lowboy deck', dump: 'dump body', car_hauler: 'car-hauler deck', container_chassis: 'container chassis' };
  const detectedBy = camVerified ? 'camera' : tt === 'reefer' ? 'telematics_aux' : rng() < 0.7 ? 'gps_pairing' : 'inferred';
  const r = truth.reefer;
  return {
    attached: true, type: tt, lengthFt: len, unitId: `TRL-${String(2000 + (hashStr((veh && veh.id) || 'x') % 7000))}`, tareLb: truth.trailerTare, maxPayloadLb: Math.round(truth.maxPayload),
    reefer: r ? { setpointF: r.setpointF, returnAirF: round(r.setpointF + (r.unitRunning ? range(rng, 1.5, 4.5) : range(rng, 9, 18)), 1), unitRunning: r.unitRunning, fuelPct: r.fuelPct } : null,
    detectedBy, cameraVerified: camVerified, cameraBasis: camVerified ? `Rear/road cam sees ${len}ft ${names[tt]}` : null,
  };
}

function warrantyDealerFor(inc, heavy) {
  const w = inc.warranty;
  if (!w || !w.inWarranty || !w.claimEligible) return null;
  const list = dealers.list({ oem: w.oem, lat: inc.location.lat, lng: inc.location.lng, limit: 5, heavyOnly: heavy });
  if (!list.length) return null;
  const slim = (d) => ({ id: d.id, name: d.name, brand: d.brand, type: d.type, address: d.address, lat: d.lat, lng: d.lng, distanceMi: d.distanceMi, driveEtaMin: d.driveEtaMin, phone: d.phone, hours: d.hours, open24x7: d.open24x7, heavyDutyBays: d.heavyDutyBays, hasPartsInStock: d.hasPartsInStock });
  const est = w.claimPacket ? w.claimPacket.estimatedValueUsd : 0;
  const auth = est > 2500;
  const n = list[0];
  const reasons = [`Nearest in-network ${w.oem} ${n.type.replace('_', ' ')}`, heavy ? 'with heavy-duty bays' : null, n.open24x7 ? 'open 24/7' : null, n.hasPartsInStock ? 'parts in stock' : null].filter(Boolean);
  return {
    oem: w.oem, coverage: w.coverage, nearest: slim(n), alternates: list.slice(1, 4).map(slim), authorizationRequired: auth,
    preAuthNumber: auth && w.claimPacket && w.claimPacket.status !== 'draft' ? `PA-${w.oem.slice(0, 3).toUpperCase()}-${String(inc.id).replace(/\D/g, '')}` : null,
    reason: reasons.join(', ') + `; ${w.coverage.replace(/_/g, '-')} coverage applies`,
  };
}

function towDestination(inc, dealer) {
  const rs = inc.roadside;
  if (!rs || !rs.needed) return null;
  const tow = /^tow/.test(rs.serviceType);
  const dx = inc.diagnostics;
  if (dealer && (tow || (dx && dx.drivable !== 'yes'))) {
    const d = dealer.nearest;
    return { kind: 'oem_dealer', name: d.name, address: d.address, lat: d.lat, lng: d.lng, distanceMi: d.distanceMi };
  }
  if (!tow) return null;
  const y = YARDS[inc.fleetId];
  const yd = y ? haversineMi(inc.location.lat, inc.location.lng, y.lat, y.lng) : 1e9;
  if (y && yd <= 70) return { kind: 'fleet_yard', name: y.name, address: y.address, lat: y.lat, lng: y.lng, distanceMi: round(yd, 1) };
  const p = require('../enrich/roadside').listNear(inc.location.lat, inc.location.lng, rs.serviceType)[0];
  return p ? { kind: 'nearest_shop', name: `${p.name} Yard & Shop`, address: `${p.city}, ${p.st}`, lat: p.lat, lng: p.lng, distanceMi: p.distanceMi } : null;
}

async function attach(inc, opts = {}) {
  if (!inc.location || inc.location.lat == null || inc.camera.aiVerdict === 'false_positive') { inc.trip = inc.trip || null; inc.equipment = inc.equipment || null; inc.load = inc.load || null; inc.warrantyDealer = null; return inc; }
  const veh = roster.getVehicle(inc.vehicle.id);
  const rng = rngFrom('ctx:' + inc.id);
  const hint = opts.contextHint || {};
  const tractor = sim.tractorSpec(veh, inc);
  const truth = sim.genTruth(inc, veh, tractor, rng, hint);
  const s = sim.simulate(inc, truth, rng);
  const tInc = new Date(inc.timestamp).getTime();
  const { A, D } = s;
  // ---- equipment ----
  const trailer = trailerOut(truth, veh, rng, hint);
  const equipment = { tractor: { class: tractor.class, make: inc.vehicle.make, model: inc.vehicle.model, year: inc.vehicle.year, engine: inc.vehicle.engine, gvwrLb: tractor.gvwrLb, tareLb: tractor.tareLb, axles: tractor.axles, fuelType: tractor.fuelType }, trailer };
  // ---- stops ----
  const lastP = truth.lastStop;
  const stopsBack = []; // earlier stops, most recent first
  let arrivalNext = A;
  const nEarlier = int(rng, 1, 3);
  const earlierPlaces = [];
  if (truth.kind !== 'pickup' && truth.pickupPlace) earlierPlaces.push(truth.pickupPlace);
  while (earlierPlaces.length < nEarlier) {
    const cand = PLACES.filter((p) => p.id !== lastP.id && !earlierPlaces.includes(p) && (truth.kind === 'pickup' ? ['retail_dc', 'grocery_dc', 'building_supply', 'food_distributor'].includes(p.placeType) : true));
    earlierPlaces.push(pick(rng, cand));
  }
  const legs = [];
  for (const p of earlierPlaces) {
    const legMi = int(rng, 45, 170), legMin = Math.round((legMi / range(rng, 50, 58)) * 60);
    const dep = arrivalNext - legMin * 60000, dwell = int(rng, 14, 45), arr = dep - dwell * 60000;
    stopsBack.push({ p, arr, dep, legMi, legMin }); arrivalNext = arr;
  }
  const yard = YARDS[inc.fleetId] || YARDS.fleet_gulfcoast;
  const firstLegMi = int(rng, 30, 120), firstLegMin = Math.round((firstLegMi / 54) * 60);
  const startedAt = arrivalNext - firstLegMin * 60000;
  const lastLegMi = round(s.distMi * 1.25, 1);
  const prior = stopsBack.reduce((a, x) => a + x.legMi, 0);
  const distanceMi = Math.round(firstLegMi + prior + lastLegMi);
  const dwellTotal = stopsBack.reduce((a, x) => a + (x.dep - x.arr) / 60000, 0) + s.dwellMin;
  const lastStop = { ...stopOut(lastP, A, D), minutesBeforeIncident: Math.round((tInc - D) / 60000), milesSinceStop: lastLegMi };
  const recentStops = [{ name: lastStop.name, placeType: lastStop.placeType, arrivedAt: lastStop.arrivedAt, departedAt: lastStop.departedAt, dwellMin: lastStop.dwellMin, businessName: lastStop.businessName }, ...stopsBack.map((x) => ({ name: x.p.businessName, placeType: x.p.placeType, arrivedAt: iso(x.arr), departedAt: iso(x.dep), dwellMin: Math.round((x.dep - x.arr) / 60000), businessName: x.p.businessName, contentHint: x.p.contentHint || null }))];
  const tl = [];
  tl.push({ t: iso(startedAt - 8 * 60000), kind: 'idle', label: `Pre-trip / yard idle at ${yard.name}` });
  tl.push({ t: iso(startedAt), kind: 'drive', label: `Left ${yard.name}` });
  for (const x of [...stopsBack].reverse()) {
    tl.push({ t: iso(x.arr), kind: 'stop', label: `Stop: ${x.p.businessName} (${x.p.placeType}), ${Math.round((x.dep - x.arr) / 60000)} min` });
    tl.push({ t: iso(x.dep), kind: 'drive', label: `Departed ${x.p.businessName}` });
  }
  tl.push({ t: iso(A), kind: 'stop', label: `Stop: ${lastStop.businessName} (${lastStop.placeType}), ${lastStop.dwellMin} min` });
  tl.push({ t: iso(D), kind: 'drive', label: `Departed ${lastStop.businessName} - ${lastLegMi} mi to event` });
  tl.push({ t: iso(tInc), kind: 'event', label: `Incident: ${inc.eventType.replace(/_/g, ' ')} at ${inc.location.road || inc.location.address}` });
  // ---- telemetry (from simulated samples) ----
  const before = windowStats(s.samples, A - 14 * 60000, A - 2 * 60000);
  const after = windowStats(s.samples, D + 4 * 60000, D + 16 * 60000);
  const N = 60, step = (s.samples.length - 1) / (N - 1);
  const series = Array.from({ length: N }, (_, i) => s.samples[Math.round(i * step)]).map((x) => ({ t: iso(x.t), engineLoadPct: round(x.engineLoadPct, 1), fuelMpg: round(x.fuelMpg, 2), speedMph: round(x.speedMph, 1) }));
  const telemetry = { before, after, deltaEngineLoadPct: round(after.avgEngineLoadPct - before.avgEngineLoadPct, 1), deltaFuelMpg: round(after.avgFuelMpg - before.avgFuelMpg, 2), series };
  const trip = {
    tripId: 'TRP-' + (hashStr(inc.id) % 900000 + 100000), startedAt: iso(startedAt), startLocation: { lat: yard.lat, lng: yard.lng, address: yard.address },
    distanceMi, durationMin: Math.round((tInc - startedAt) / 60000), idleMin: Math.round(dwellTotal + 8), lastStop, recentStops, timeline: tl, telemetry,
  };
  // ---- load inference (observables only) ----
  const camVisual = buildCamVisual(truth, trailer.cameraVerified, rng);
  const obsStops = recentStops.slice(1).map((r) => ({ ...r }));
  const load = inferLoad({
    tractor: { ...equipment.tractor }, trailer: { ...trailer }, telemetry, lastStop: { ...lastStop, contentHint: lastP.contentHint || null }, recentStops: obsStops, camVisual,
    dwellMin: lastStop.dwellMin, minutesBeforeIncident: lastStop.minutesBeforeIncident,
  });
  load._truth = undefined;
  if (opts.debugTruth) load.truthPayloadLb = Math.round(truth.payAfter);
  inc.trip = trip; inc.equipment = equipment; inc.load = load;
  // ---- warranty dealer + tow destination ----
  const heavy = tractor.class.startsWith('class8') || tractor.class === 'class6_boxtruck';
  inc.warrantyDealer = warrantyDealerFor(inc, heavy);
  const td = towDestination(inc, inc.warrantyDealer);
  if (td && inc.roadside) inc.roadside.towDestination = td;
  // ---- risk tags + packet ----
  const base = risk.score(inc);
  inc.risk = base;
  // ---- claim packet additions ----
  const cp = inc.warranty && inc.warranty.claimPacket;
  if (cp) {
    cp.evidence.push(`Trip context: ${distanceMi} mi trip, last stop ${lastStop.businessName} (${lastStop.placeType}) ${lastStop.minutesBeforeIncident} min / ${lastStop.milesSinceStop} mi before failure`);
    if (load.estimatedWeightLb > 300) cp.evidence.push(`Load context: ~${load.estimatedWeightLb.toLocaleString('en-US')} lb ${load.contents.label.replace(' (likely)', '')} (${Math.round(load.confidence * 100)}% confidence; ${load.method.replace(/_/g, ' ')})`);
    if (load.estimatedWeightLb > 300 && load.contents.estimatedValueUsd[1] > 0) cp.summary += ` Cargo exposure: $${load.contents.estimatedValueUsd[0].toLocaleString('en-US')}-$${load.contents.estimatedValueUsd[1].toLocaleString('en-US')} (${load.contents.label.replace(' (likely)', '')}).`;
    if (inc.warrantyDealer) cp.evidence.push(`Routed to OEM dealer: ${inc.warrantyDealer.nearest.name}, ${inc.warrantyDealer.nearest.distanceMi} mi`);
    cp.cargoExposureUsd = load.contents.estimatedValueUsd;
  }
  return inc;
}

module.exports = { attach, YARDS };
