// Enrichment pipeline: VIN -> camera -> DTC -> severity/category -> roadside -> warranty -> risk.
const vin = require('./vin');
const dtc = require('./dtc');
const camera = require('./camera');
const roadside = require('./roadside');
const warranty = require('./warranty');
const risk = require('./risk');
const { MODELS } = require('../data/ref');

const SEV_RANK = dtc.SEV_RANK;
const BASE_SEV = { collision: 'critical', rollover: 'critical', breakdown: 'high', tire: 'medium', battery: 'medium', distracted: 'medium', harsh_brake: 'medium', harsh_accel: 'low', harsh_turn: 'low', speeding: 'low', following_distance: 'low', fault_code: 'low', other: 'low' };
const CATEGORY = { collision: 'collision', rollover: 'collision', fault_code: 'diagnostic', breakdown: 'roadside', tire: 'roadside', battery: 'roadside' };

function vehicleClass(inc) {
  const spec = Object.values(MODELS).find((m) => m.make === inc.vehicle.make && inc.vehicle.model && m.model === inc.vehicle.model);
  if (spec) return spec.cls;
  return ['Freightliner', 'Peterbilt', 'Kenworth', 'Volvo', 'Mack', 'International'].includes(inc.vehicle.oem) ? 'heavy' : 'light';
}

async function enrich(inc, opts = {}) {
  // 1. VIN
  const decoded = await vin.decode(inc.vehicle.vin);
  if (decoded && decoded.valid) {
    inc.vehicle.make = inc.vehicle.make || decoded.make;
    inc.vehicle.model = inc.vehicle.model || decoded.model;
    inc.vehicle.year = inc.vehicle.year || decoded.year;
    inc.vehicle.engine = inc.vehicle.engine || decoded.engine;
    inc.vehicle.oem = inc.vehicle.oem || decoded.oem;
  }
  // 2. Diagnostics
  const dtcs = dtc.decodeAll(inc._dtcRaw || []);
  if (dtcs.length) {
    const sum = dtc.summarize(dtcs);
    inc.diagnostics = { dtcs, drivable: sum.drivable, engineHours: inc._engineHours || null, faultLampOn: !!inc._faultLamp };
    if (['fault_code', 'other'].includes(inc.eventType)) inc.eventType = sum.drivable === 'no' || (sum.drivable === 'limp' && sum.severity === 'critical') ? 'breakdown' : 'fault_code';
  } else inc.diagnostics = null;
  // 3. Camera
  inc.camera = camera.verify(inc);
  // 4. Category / severity
  inc.category = CATEGORY[inc.eventType] || 'safety';
  let sev = BASE_SEV[inc.eventType] || 'low';
  if (inc.diagnostics) { const ds = dtc.summarize(inc.diagnostics.dtcs).severity; if (SEV_RANK[ds] > SEV_RANK[sev]) sev = ds; }
  if (inc.eventType === 'speeding' && (inc.location.speed_mph || 0) >= 80) sev = 'medium';
  if (inc.eventType === 'harsh_brake' && inc.camera.aiVerdict === 'near_miss' && (inc._hints.gForce || 0) >= 0.6) sev = 'high';
  if (inc.camera.aiVerdict === 'false_positive') sev = 'low';
  if (inc._severityHint && SEV_RANK[inc._severityHint] && inc.camera.aiVerdict !== 'false_positive' && !inc.diagnostics) sev = inc._severityHint;
  inc.severity = sev;
  // 5. Roadside
  inc.roadside = roadside.recommend(inc, vehicleClass(inc));
  // 6. Warranty
  inc.warranty = warranty.evaluate(inc, decoded && decoded.valid ? decoded : null);
  if (inc.warranty && inc.warranty.claimEligible) {
    inc.warranty.claimId = 'WC-' + String(inc.id).replace(/^NX-/, '');
    inc.warranty.claimPacket = warranty.buildClaimPacket(inc, inc.warranty, inc.warranty.claimId);
  }
  // 7. Risk
  inc.risk = risk.score(inc);
  return inc;
}
module.exports = { enrich, vehicleClass };
