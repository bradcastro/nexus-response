// node src/predict/selftest.js  -- runs the engine against the synthetic fixture and prints summary numbers.
const { generate } = require('./fixture');
const A = require('./analyze');
const t0 = Date.now();
const SEED = process.env.SEED || 'predict-fixture';
const ctxs = generate({ seed: SEED });
console.log('fixture ms', Date.now() - t0, ctxs.map((c) => `${c.fleet.id}:${c.vehicles.length}v/${c.incidents.length}i/${c.incidents.filter((i) => i.eventType === 'collision').length}c`).join('  '));
const idxs = ctxs.map(A.buildIndex);
const calib = A.calibrate(idxs, ctxs[0].asOf);
console.log('calib beta0', calib.beta0.toFixed(2), Object.fromEntries(Object.entries(calib.norm).map(([k, v]) => [k, +v.toFixed(3)])));
let tc = 0, tk = 0;
for (const c of ctxs) {
  const t1 = Date.now();
  const a = A.analyzeFleet(c, calib);
  const b = a._.backtest;
  tc += b.caught; tk += b.collisions;
  console.log(`${c.fleet.id.padEnd(16)} ${c.fleet.vendor.padEnd(7)} risk ${a.risk.current}->${a.risk.projected30d}->${a.risk.projected90d} ${a.risk.direction.padEnd(9)} conf ${a._.confidence.toFixed(2)} recall ${b.caught}/${b.collisions}=${b.recallPct}% lead ${b.medianLeadDays} FA/100v ${b.falseAlertsPer100Veh} prec ${b.precisionPct}% loss$${a.expected.expectedLossUsd90d} coll30 ${a.expected.collisions30d} ${Date.now() - t1}ms`);
}
console.log('overall recall', tc, tk, (100 * tc / tk).toFixed(0) + '%');

// ---- invariants ----
const assert = require('assert');
for (const c of ctxs) {
  const a = A.analyzeFleet(c, calib);
  assert(a.risk.current >= 0 && a.risk.current <= 100, 'risk range');
  assert(a.risk.band90d[0] <= a.risk.projected90d + 0.01 && a.risk.band90d[1] >= a.risk.projected90d - 0.01, 'band brackets projection');
  assert(a._.drivers.every((d) => d.collisionProb30d >= 0 && d.collisionProb30d <= 0.6), 'driver p range');
  assert(a.series.every((s) => s.lo == null || s.lo <= s.hi), 'series band order');
  const dates = a.series.map((s) => s.date); assert(dates.every((d, i) => i === 0 || d >= dates[i - 1]), 'dates ascending');
  assert(a.patterns.byHour.length === 24 && a.patterns.byDow.length === 7, 'patterns shape');
  assert(a._.backtest.recallPct == null || a._.backtest.recallPct < 100 || a._.backtest.collisions < 4, 'recall not trivially 100%');
  const contrib = a.leadingIndicators.reduce((s, l) => s + l.contributionToRisk, 0); assert(Math.abs(contrib - 100) < 1, 'contributions sum to 100');
}
// roster-less fleet (imported history): drivers/vehicles derived from incidents
const stripped = { ...ctxs[0], drivers: [], vehicles: [] };
const a2 = A.analyzeFleet(stripped, calib); assert(a2._.driverCount > 0 && a2._.vehicleCount > 0, 'derived roster');
// what-if monotonic
const w = A.whatIf(A.analyzeFleet(ctxs[2], calib)._.wctx, ['targeted_coaching', 'phone_policy']);
assert(w.projected.collisions90d <= w.baseline.collisions90d, 'what-if reduces');
console.log('invariants OK');
for (const c of ctxs) {
  const a = A.analyzeFleet(c, calib);
  assert(a.expected.collisionProb30d >= 0.02 && a.expected.collisionProb30d <= 0.9, 'fleet prob never 0% or 100%');
  assert(a._.drivers.every((d) => d.collisionProb30d >= 0.01 && d.collisionProb30d < 0.95), 'driver prob within (1%, 95%)');
}
console.log('probability bounds OK');
