// OEM warranty evaluator + auto-built claim packet.
const { round } = require('../util');
const ERR = (y, mi) => ({ years: y, miles: mi });
const OEM = {
  Freightliner: { bumper_to_bumper: ERR(2, 250000), powertrain: ERR(5, 500000), emissions: ERR(5, 150000) },
  Peterbilt: { bumper_to_bumper: ERR(2, 200000), powertrain: ERR(3, 350000), emissions: ERR(5, 150000) },
  Kenworth: { bumper_to_bumper: ERR(2, 200000), powertrain: ERR(3, 350000), emissions: ERR(5, 150000) },
  Volvo: { bumper_to_bumper: ERR(2, 250000), powertrain: ERR(5, 400000), emissions: ERR(5, 150000) },
  Ford: { bumper_to_bumper: ERR(3, 36000), powertrain: ERR(5, 60000), emissions: ERR(8, 80000) },
  'Mercedes-Benz': { bumper_to_bumper: ERR(3, 36000), powertrain: ERR(5, 100000), emissions: ERR(8, 80000) },
};
const DEFAULT = OEM.Freightliner;
const LABEL = { bumper_to_bumper: 'Bumper-to-Bumper', powertrain: 'Powertrain', emissions: 'Emissions' };

function inServiceDate(year) { return new Date(Date.UTC(year, 3, 1)); } // assume Apr 1 of model year

function windows(oem, year, odo, at) {
  const terms = OEM[oem] || DEFAULT;
  const start = inServiceDate(year);
  const out = {};
  for (const [k, t] of Object.entries(terms)) {
    const expDate = new Date(start); expDate.setUTCFullYear(expDate.getUTCFullYear() + t.years);
    const active = at <= expDate && odo <= t.miles;
    out[k] = { active, expiresAt: expDate.toISOString().slice(0, 10), milesRemaining: Math.max(0, t.miles - odo), termYears: t.years, termMiles: t.miles, label: LABEL[k] };
  }
  return out;
}

function evaluate(inc, vinDecoded) {
  const v = inc.vehicle || {};
  const oem = v.oem || (vinDecoded && vinDecoded.oem);
  if (!oem || !v.year) return null;
  const at = new Date(inc.timestamp || Date.now());
  const odo = v.odometer_mi || 0;
  const w = windows(oem, v.year, odo, at);
  const activeKeys = Object.keys(w).filter((k) => w[k].active);
  const dtcs = (inc.diagnostics && inc.diagnostics.dtcs) || [];
  const cats = dtcs.map((d) => d.warrantyCategory).filter(Boolean);
  const isFailure = dtcs.length > 0 && inc.category !== 'collision';

  let coverage = 'none', applicable = null, reason;
  if (isFailure) {
    // The failure is covered if its own category or the broader bumper-to-bumper term is active.
    const order = [...new Set(cats)];
    applicable = order.find((c) => w[c] && w[c].active) || (w.bumper_to_bumper.active && order.length ? 'bumper_to_bumper' : null);
    // powertrain parts failure may also be covered by B2B if still active
    if (applicable) { coverage = applicable; reason = `${LABEL[applicable]} coverage active (${w[applicable].milesRemaining.toLocaleString('en-US')} mi remaining)`; }
    else reason = `${order.map((c) => LABEL[c] || c).join('/')} coverage expired (${v.year} ${oem}, ${Math.round(odo).toLocaleString('en-US')} mi)`;
  } else {
    coverage = activeKeys.includes('bumper_to_bumper') ? 'bumper_to_bumper' : (activeKeys[0] || 'none');
    reason = inc.category === 'collision' ? 'Collision damage is not an OEM warranty item - refer to insurance claim' : 'No component failure on this event';
  }
  const ref = w[coverage] || null;
  const claimEligible = !!(isFailure && applicable);
  const warranty = {
    oem, vinDecoded: vinDecoded || null, inWarranty: activeKeys.length > 0, coverage,
    expiresAt: ref ? ref.expiresAt : (Object.values(w).map((x) => x.expiresAt).sort().pop() || null),
    milesRemaining: ref ? ref.milesRemaining : 0,
    claimEligible, claimId: null, reason, activeCoverages: activeKeys,
    windows: w, claimPacket: null,
  };
  return warranty;
}

function buildClaimPacket(inc, w, claimNum) {
  const dtcs = inc.diagnostics.dtcs;
  const cost = dtcs.reduce((s, d) => s + (d.estCostUsd || 0), 0);
  const tow = inc.roadside && /^tow/.test(inc.roadside.serviceType) ? (inc.roadside.serviceType === 'tow_heavy' ? 650 : 280) : 0;
  const evidence = [
    `Fault code snapshot: ${dtcs.map((d) => `${d.code} (${d.desc})`).join('; ')}`,
    `Telematics event record from ${inc.provider} (${inc.providerEventId}) at ${inc.timestamp}`,
    `Odometer ${Math.round(inc.vehicle.odometer_mi).toLocaleString('en-US')} mi${inc.diagnostics.engineHours ? ` / ${inc.diagnostics.engineHours} engine hrs` : ''} at time of failure`,
    `GPS location ${inc.location.lat.toFixed(4)}, ${inc.location.lng.toFixed(4)} (${inc.location.address})`,
    `VIN-decoded coverage verification: ${w.reason}`,
  ];
  if (inc.diagnostics.faultLampOn) evidence.push('Malfunction indicator lamp ON at time of event');
  if (inc.camera && inc.camera.snapshots && inc.camera.snapshots.length) evidence.push('Dashcam snapshot at time of event');
  if (tow) evidence.push('Roadside recovery invoice (pending completion)');
  return {
    status: evidence.length >= 6 ? 'ready' : 'draft',
    summary: `${inc.vehicle.year} ${inc.vehicle.make} ${inc.vehicle.model} (${inc.vehicle.vin}) - ${dtcs[0].desc}. ${LABEL[w.coverage]} warranty applies through ${w.expiresAt}. Recommended repair: ${dtcs[0].recommendedAction}`,
    evidence,
    estimatedValueUsd: round(cost + tow, 0),
    laborParts: dtcs.map((d) => ({ code: d.code, parts: d.partsHint, estimateUsd: d.estCostUsd })),
    towEstimateUsd: tow,
  };
}

module.exports = { evaluate, buildClaimPacket, OEM, windows };
