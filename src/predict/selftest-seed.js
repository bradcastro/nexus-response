// node src/predict/selftest-seed.js -- seeds in-process (resets the in-memory store) and checks the real demo seed outputs.
const assert = require('assert');
const seeder = require('../seed'); const data = require('./data');
(async () => {
  await seeder.seed({ reset: true });
  const as = await data.getAllAnalyses();
  const dirs = new Set(as.map((a) => a.risk.direction));
  as.forEach((a) => {
    assert(a.expected.collisionProb30d >= 0.02 && a.expected.collisionProb30d <= 0.9, a.fleetId + ' fleet prob');
    assert(a._.drivers.every((d) => d.collisionProb30d >= 0.01 && d.collisionProb30d < 0.95), a.fleetId + ' driver prob');
    assert(a._.backtest.recallPct == null || a._.backtest.recallPct <= 100);
    console.log(a.fleetName.padEnd(32), a.risk.direction.padEnd(9), 'fleetP', a.expected.collisionProb30d, 'maxDrv', a._.drivers[0].collisionProb30d, 'loss$', a.expected.expectedLossUsd90d);
  });
  assert(dirs.size > 1, 'direction must not be identical for all fleets on the seed');
  console.log('seed invariants OK; directions:', [...dirs].join(','));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
