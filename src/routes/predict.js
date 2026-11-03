// Express router for /api/predict (mounted by server.js / backend-ingest). Default export is the router.
const express = require('express');
const data = require('../predict/data');
const alerts = require('../predict/alerts');
const portfolio = require('../predict/portfolio');
const { publicFleet } = require('../predict');
const { whatIf } = require('../predict/analyze');
const { INTERVENTIONS, ALERT, INDICATORS, MODEL } = require('../predict/config');

const { provenance, DISCLAIMER } = require('../predict/provenance');
const router = express.Router();
data.start();
router.use((req, res, next) => { res.set('X-Nexus-Data', 'synthetic-illustrative'); next(); });

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => { console.error('[PREDICT]', e); res.status(500).json({ error: 'predict_failed', message: e.message }); });
const int = (v, d, lo, hi) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const stripDriver = ({ _p, _score, ...r }) => r;
async function analysesFor(fleetId) {
  if (fleetId) { const a = await data.getAnalysis(fleetId); return a ? [a] : null; }
  return data.getAllAnalyses();
}

router.get('/fleet/:id', wrap(async (req, res) => {
  const a = await data.getAnalysis(req.params.id);
  if (!a) return res.status(404).json({ error: 'Unknown fleet', fleetId: req.params.id });
  res.json(publicFleet(a, int(req.query.horizonDays, 90, 7, 90)));
}));

router.get('/drivers', wrap(async (req, res) => {
  const as = await analysesFor(req.query.fleetId);
  if (!as) return res.status(404).json({ error: 'Unknown fleet', fleetId: req.query.fleetId });
  const limit = int(req.query.limit, 25, 1, 1000);
  const rows = as.flatMap((a) => a._.drivers).sort((x, y) => y.riskNow - x.riskNow || y.collisionProb30d - x.collisionProb30d).slice(0, limit).map(stripDriver);
  res.json(rows);
}));

router.get('/vehicles', wrap(async (req, res) => {
  const as = await analysesFor(req.query.fleetId);
  if (!as) return res.status(404).json({ error: 'Unknown fleet', fleetId: req.query.fleetId });
  const limit = int(req.query.limit, 50, 1, 2000);
  const rows = as.flatMap((a) => a._.vehicles).sort((x, y) => y.breakdownProb30d - x.breakdownProb30d || y.collisionProb30d - x.collisionProb30d).slice(0, limit);
  res.json(rows);
}));

router.get('/alerts', wrap(async (req, res) => {
  await data.getAllAnalyses().catch(() => {}); // make sure alerts exist even if the boot pass has not run yet
  if (!data.state.bootAlertsDone && (await require('../../db').countIncidents()) > 0) { await data.evaluateAll({ silent: true }); data.state.bootAlertsDone = true; }
  res.json(alerts.list({ fleetId: req.query.fleetId, status: req.query.status, kind: req.query.kind, severity: req.query.severity, limit: int(req.query.limit, 50, 1, 500) }));
}));
router.post('/alerts/:id/:action(ack|action|dismiss)', wrap(async (req, res) => {
  const b = req.body || {};
  const r = alerts.transition(req.params.id, req.params.action, { note: typeof b.note === 'string' ? b.note.slice(0, 500) : '', actor: typeof b.actor === 'string' ? b.actor.slice(0, 80) : undefined, detail: typeof b.action === 'string' ? b.action.slice(0, 60) : undefined });
  if (r.error === 'not_found') return res.status(404).json({ error: 'Alert not found' });
  if (r.error) return res.status(409).json({ error: r.error, message: r.message });
  res.json(alerts.get(req.params.id));
}));

router.get('/backtest', wrap(async (req, res) => {
  const as = await analysesFor(req.query.fleetId);
  if (!as) return res.status(404).json({ error: 'Unknown fleet', fleetId: req.query.fleetId });
  if (!req.query.fleetId) return res.json(portfolio.aggregateBacktest(as));
  const b = as[0]._.backtest;
  res.json({ ...b, basis: { population: 'this fleet only', aggregation: 'single fleet; lead time pooled over its flagged-ahead collisions', period: 'walk-forward backtest window', n: { collisions: b.collisions, caught: b.caught, leadSamples: (b.leadDaysAll || []).length } }, illustrative: true, label: 'Illustrative backtest on synthetic data (in-sample tuned)', disclaimer: DISCLAIMER, provenance: provenance() });
}));

router.get('/portfolio', wrap(async (req, res) => {
  const as = await data.getAllAnalyses();
  res.json(portfolio.build(as));
}));

router.get('/interventions', (req, res) => res.json(INTERVENTIONS.map(({ key, label, target, effects, costPerDriverUsd, assumption }) => ({ key, label, target, effects, costPerDriverUsd, assumption }))));

router.get('/model', (req, res) => res.json({
  label: 'demo-calibrated', illustrative: true, provenance: provenance(), indicators: INDICATORS.map(({ key, label, beta, camera }) => ({ key, label, weight: beta, cameraDerived: !!camera })),
  escalationWeight: MODEL.BETA_ESCALATION, referenceP30: MODEL.BASE_P30, flagThresholdP30: ALERT.P_FLAG, halfLifeDays: MODEL.HALF_LIFE_DAYS,
  note: 'Weights are hand-set and demo-calibrated, not fitted to real loss data. See docs/PREDICT.md.',
}));

router.post('/simulate-what-if', wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.fleetId) return res.status(400).json({ error: 'fleetId is required' });
  const keys = Array.isArray(b.interventions) ? b.interventions : [];
  const known = INTERVENTIONS.map((i) => i.key);
  const bad = keys.filter((k) => !known.includes(k));
  if (!keys.length || bad.length) return res.status(400).json({ error: bad.length ? `Unknown interventions: ${bad.join(', ')}` : 'interventions[] is required', available: known });
  const a = await data.getAnalysis(b.fleetId);
  if (!a) return res.status(404).json({ error: 'Unknown fleet', fleetId: b.fleetId });
  const r = whatIf(a._.wctx, [...new Set(keys)]);
  delete r.single;
  res.json({ fleetId: b.fleetId, interventions: [...new Set(keys)], projectedRisk90d: r.projected.riskProjected90d, baselineRisk90d: r.baseline.riskProjected90d, expectedAvoidedIncidents90d: r.avoidedIncidents90d, expectedSavingsUsd: r.savingsUsd, generatedAt: new Date().toISOString(), horizonDays: 90, ...r, illustrative: true, label: 'Illustrative what-if on synthetic data; effects are literature-style assumptions', disclaimer: DISCLAIMER, provenance: provenance(), assumptions: keys.map((k) => ({ key: k, assumption: INTERVENTIONS.find((i) => i.key === k).assumption })), note: 'Effects ramp in over ~30 days; savings use demo loss assumptions (collision ~$62k + cargo share, other incident ~$300, maintenance event ~$950).' });
}));

module.exports = router;
module.exports.default = router;
