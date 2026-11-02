// Inference engine: estimates payload weight + contents ONLY from observable data
// (telemetry windows, equipment, stops, reefer state, camera). See docs/INFERENCE.md.
const M = require('./model');
const { round, clamp } = require('../util');

const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((x) => (x - m) ** 2))); };
const k = (n) => `${Math.round(n / 100) / 10}k`;
const SOURCE_TYPES = ['food_distributor', 'cold_storage', 'steel_yard', 'lumber_yard', 'port', 'quarry', 'manufacturer', 'farm', 'parcel_hub', 'grocery_dc', 'building_supply', 'retail_dc'];

function weightFromTelemetry(input) {
  const { tractor, trailer, telemetry: t, lastStop } = input;
  const cls = tractor.class;
  const tareGross = tractor.tareLb + (trailer && trailer.attached ? trailer.tareLb : 0) + M.MISC_LB;
  const maxPayload = tractor.gvwrLb - tareGross;
  const a = t.after, b = t.before;
  const nl = (w) => w.avgEngineLoadPct / M.speedLoadF(w.avgSpeedMph);
  const nm = (w) => w.avgFuelMpg / M.speedMpgF(w.avgSpeedMph);
  const basis = [];
  const est = []; // {name, payload, weight}
  const absAfterLoad = M.gFromLoadNorm(cls, nl(a)) - tareGross;
  const absAfterMpg = M.gFromMpgNorm(cls, nm(a)) - tareGross;
  const absBeforeLoad = M.gFromLoadNorm(cls, nl(b)) - tareGross;
  const absBeforeMpg = M.gFromMpgNorm(cls, nm(b)) - tareGross;
  const dLoadLb = (nl(a) - nl(b)) * M.dgPerLoadPt(cls);
  const dMpgLb = (1 / nm(a) - 1 / nm(b)) * M.dgPerInvMpg(cls);
  const change = (dLoadLb + dMpgLb) / 2;
  const thr = 0.06 * (M.coeffs(cls).r.g2 - M.coeffs(cls).r.g1);
  const dl = round(a.avgEngineLoadPct - b.avgEngineLoadPct, 1), dm = round(a.avgFuelMpg - b.avgFuelMpg, 2);
  let kind = 'steady';
  if (change > thr) kind = 'added'; else if (change < -thr) kind = 'dropped';
  let method = 'mpg_vs_empty_baseline';
  let weights = { absL: 0.5, absM: 0.5, delta: 0 };
  let deltaPayload = null;
  if (kind === 'added') {
    const beforeAbs = Math.max(0, mean([absBeforeLoad, absBeforeMpg]));
    const beforeUsed = beforeAbs < 0.08 * maxPayload ? 0 : beforeAbs;
    deltaPayload = beforeUsed + change;
    weights = { absL: 0.2, absM: 0.2, delta: 0.6 };
    method = 'combined';
    basis.push(`Engine load ${dl >= 0 ? '+' : ''}${dl} pts (${round(b.avgEngineLoadPct, 0)}% -> ${round(a.avgEngineLoadPct, 0)}%) and fuel economy ${dm >= 0 ? '+' : ''}${dm} mpg (${round(b.avgFuelMpg, 1)} -> ${round(a.avgFuelMpg, 1)}) after departure => ~${k(change * 0.9)}-${k(change * 1.1)} lb added`);
    basis.push(beforeUsed === 0 ? `Arrived at stop near empty (baseline ${round(b.avgFuelMpg, 1)} mpg at ${round(b.avgEngineLoadPct, 0)}% load)` : `Arrived with ~${k(beforeUsed)} lb already aboard`);
  } else if (kind === 'dropped') {
    weights = { absL: 0.5, absM: 0.5, delta: 0 };
    method = 'combined';
    basis.push(`Engine load ${dl} pts and fuel economy +${dm} mpg after departure => ~${k(-change)} lb removed (delivery)`);
  } else {
    basis.push(`No significant load change across last stop (engine load ${dl >= 0 ? '+' : ''}${dl} pts, ${dm >= 0 ? '+' : ''}${dm} mpg) - load carried through the stop`);
  }
  est.push({ name: 'load_abs', v: absAfterLoad, w: weights.absL });
  est.push({ name: 'mpg_abs', v: absAfterMpg, w: weights.absM });
  if (deltaPayload != null) est.push({ name: 'delta', v: deltaPayload, w: weights.delta });
  basis.push(`Post-departure cruise: ${round(a.avgFuelMpg, 1)} mpg @ ${round(a.avgSpeedMph, 0)} mph, ${round(a.avgEngineLoadPct, 0)}% load vs empty baseline ~${round(M.mpgAt(cls, tractor.tareLb + (trailer && trailer.attached ? trailer.tareLb : 0) + M.MISC_LB) * M.speedMpgF(a.avgSpeedMph), 1)} mpg for this tractor/trailer`);
  return { est, change, kind, method, basis, tareGross, maxPayload };
}

function inferLoad(input) {
  const { tractor, trailer, camVisual, lastStop, recentStops, reefer, telemetry } = input;
  const w = weightFromTelemetry(input);
  const est = [...w.est];
  let method = w.method;
  const basis = [];
  if (input.dwellMin != null && lastStop) basis.push(`Last stop: ${lastStop.businessName} (${lastStop.placeType}), dwell ${input.dwellMin} min, departed ${input.minutesBeforeIncident} min before event`);
  basis.push(...w.basis);
  let camBonus = 0;
  if (camVisual && camVisual.unitCount && camVisual.unitNominalLb) {
    est.push({ name: 'camera', v: camVisual.unitCount * camVisual.unitNominalLb, w: 0.25 });
    basis.push(`Camera sees ${camVisual.unitCount} ${camVisual.unitName} (~${k(camVisual.unitNominalLb)} lb each) => ~${k(camVisual.unitCount * camVisual.unitNominalLb)} lb`);
    camBonus = 0.1;
    if (trailer && trailer.type === 'flatbed') method = 'camera_flatbed_visual';
  }
  const tw = est.reduce((s, e) => s + e.w, 0);
  let payload = Math.max(0, est.reduce((s, e) => s + e.v * e.w, 0) / tw);
  const vals = est.map((e) => e.v);
  const spread = vals.length > 1 ? sd(vals) : 0;
  const ref = Math.max(payload, 0.15 * w.maxPayload);
  const agree = clamp(1 - (spread / ref) * 3, 0, 1);
  const samples = Math.min(telemetry.before.sampleCount, telemetry.after.sampleCount);
  const conf = clamp(0.48 + 0.27 * agree + (samples >= 20 ? 0.08 : 0) + camBonus + (w.kind === 'added' ? 0.07 : 0), 0.3, 0.95);
  const half = Math.max(0.06 * payload, 1.4 * spread, 900) * (1.15 + (1 - conf));
  const lo = Math.max(0, payload - half), hi = payload + half;
  const gross = w.tareGross + payload;
  const overweight = payload > 0.99 * w.maxPayload || hi > 1.06 * w.maxPayload;
  // contents
  const contents = inferContents({ ...input, loadKind: w.kind, payload, w });
  basis.push(...contents.basis);
  const val = [Math.round((lo * contents.rate[0]) / 500) * 500, Math.round((hi * contents.rate[1]) / 500) * 500];
  const spoil = contents.temperatureSensitive ? (contents.reeferRunning === false ? (contents.category === 'frozen_food' ? 10 : 6) : contents.category === 'frozen_food' ? 36 : contents.milk ? 12 : 24) : null;
  const empty = payload < 0.04 * w.maxPayload + 150;
  return {
    estimatedWeightLb: Math.round(payload / 50) * 50, weightRangeLb: [Math.round(lo / 50) * 50, Math.round(hi / 50) * 50],
    payloadPctOfMax: Math.round((payload / w.maxPayload) * 100), grossVehicleWeightLb: Math.round(gross / 50) * 50, overweightRisk: overweight,
    method, contents: empty
      ? { category: 'unknown', label: 'Empty / deadheading (likely)', examples: [], estimatedValueUsd: [0, 0], hazmat: false, temperatureSensitive: false, spoilageRiskHours: null, confidence: 0.7 }
      : { category: contents.category, label: M.CONTENT[contents.category].label, examples: M.CONTENT[contents.category].examples, estimatedValueUsd: val, hazmat: !!M.CONTENT[contents.category].hazmat, temperatureSensitive: contents.temperatureSensitive, spoilageRiskHours: spoil, confidence: round(contents.conf, 2) },
    confidence: round(conf, 2), basis: empty ? [...basis.slice(0, 3), 'Estimated payload ~0 lb - trailer appears empty'] : basis,
    cameraVisual: camVisual ? { cargoVisible: camVisual.cargoVisible, description: camVisual.description, confidence: camVisual.confidence } : null,
  };
}

function inferContents(input) {
  const { trailer, lastStop, recentStops, reefer, camVisual, loadKind, tractor } = input;
  const basis = []; let conf = 0.3; let cat = 'unknown'; let milk = false; let tempSens = false; let reeferRunning = null;
  // supplier stop: last stop if load was added there, else most recent source-type stop
  let src = null;
  if (loadKind === 'added' && lastStop) src = lastStop;
  else src = (recentStops || []).find((s) => SOURCE_TYPES.includes(s.placeType) || s.placeType === 'unknown') || null;
  const via = src && src === lastStop ? 'Last stop' : 'Earlier stop';
  const sType = src && src.placeType;
  const tt = trailer && trailer.type;
  if (tt === 'reefer' && trailer.reefer) {
    const sp = trailer.reefer.setpointF;
    cat = sp <= 10 ? 'frozen_food' : 'perishable_food'; tempSens = true; reeferRunning = trailer.reefer.unitRunning; conf += 0.4;
    basis.push(`Reefer unit ${trailer.reefer.unitRunning ? 'running' : 'NOT running'} at ${sp}F => ${cat === 'frozen_food' ? 'frozen' : 'chilled'} product`);
    if (sType && ['food_distributor', 'cold_storage'].includes(sType)) { conf += 0.2; basis.push(`${via}: ${src.businessName} (${sType}) => food cold chain`); }
  } else if (tt === 'tanker') {
    if (sType === 'farm') { cat = 'perishable_food'; milk = true; tempSens = true; conf += 0.5; basis.push(`${via}: ${src.businessName} (farm) + insulated tanker => raw milk`); }
    else if (sType === 'port' && src.contentHint === 'fuel') { cat = 'fuel_liquid'; conf += 0.55; basis.push(`${via}: ${src.businessName} (port/fuel terminal) + tanker => flammable liquid cargo (placarded hazmat likely)`); }
    else if (sType === 'manufacturer' && src.contentHint === 'hazmat') { cat = 'hazmat'; conf += 0.5; basis.push(`${via}: ${src.businessName} (chemical terminal) + tanker => hazardous materials`); }
    else { cat = 'unknown'; basis.push('Tanker with no identifiable loading terminal'); conf += 0.1; }
  } else if (tt === 'flatbed') {
    if (camVisual && /coil/i.test(camVisual.description || '')) { cat = 'steel'; conf += 0.55; basis.push(`Camera: ${camVisual.description}`); }
    else if (sType === 'steel_yard') { cat = 'steel'; conf += 0.4; basis.push(`${via}: ${src.businessName} (steel_yard) + flatbed => steel product`); }
    else if (sType === 'lumber_yard') { cat = 'lumber'; conf += 0.4; basis.push(`${via}: ${src.businessName} (lumber_yard) + flatbed => lumber`); }
    else if (sType === 'building_supply') { cat = 'building_materials'; conf += 0.35; basis.push(`${via}: ${src.businessName} (building_supply) + flatbed => building materials`); }
    if (camVisual && cat === 'lumber') { conf += 0.15; basis.push(`Camera: ${camVisual.description}`); }
  } else if (tt === 'dump') { cat = 'aggregate'; conf += sType === 'quarry' ? 0.5 : 0.25; if (sType === 'quarry') basis.push(`${via}: ${src.businessName} (quarry) + dump trailer => aggregate`); }
  else if (tt === 'lowboy') { cat = 'machinery'; conf += 0.4; basis.push('Lowboy trailer => heavy equipment/machinery'); }
  else if (tt === 'car_hauler') { cat = 'vehicles'; conf += 0.45; basis.push('Car-hauler/rollback deck => vehicles'); }
  else {
    if (sType === 'parcel_hub') { cat = 'parcel'; conf += 0.55; basis.push(`${via}: ${src.businessName} (parcel_hub) + cargo van => parcels`); }
    else if (src && src.contentHint === 'beverage') { cat = 'beverage'; conf += 0.5; basis.push(`${via}: ${src.businessName} (beverage bottler/distributor) + dry van => bottled beverages`); }
    else if (sType === 'grocery_dc') { cat = 'dry_grocery'; conf += 0.45; basis.push(`${via}: ${src.businessName} (grocery_dc) + enclosed box => packaged grocery`); }
    else if (sType === 'manufacturer') { cat = 'machinery'; conf += 0.35; basis.push(`${via}: ${src.businessName} (manufacturer) + dry van => manufactured goods/machinery`); }
    else if (sType === 'building_supply') { cat = 'building_materials'; conf += 0.4; basis.push(`${via}: ${src.businessName} (building_supply) => building materials`); }
    else if (sType === 'unknown' && tractor.class !== 'van') { cat = 'vehicles'; conf += 0.4; basis.push(`${via}: ${src.businessName} => vehicle recovery`); }
    else if (sType === 'retail_dc') { cat = 'unknown'; conf += 0.2; basis.push(`${via}: ${src.businessName} (retail_dc) + dry van => general retail freight`); }
    else basis.push('No identifiable supplier stop for enclosed cargo');
  }
  if (loadKind !== 'added' && src) conf -= 0.1;
  if (tt === 'dry_van' && loadKind === 'added' && sType === 'retail_dc') conf += 0.05;
  const rate = M.CONTENT[cat].rate;
  return { category: cat, conf: clamp(conf, 0.2, 0.95), basis, rate, temperatureSensitive: tempSens, reeferRunning, milk };
}

module.exports = { inferLoad };
