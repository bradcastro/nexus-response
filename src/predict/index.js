// Public API of the predict engine (for other backend modules, e.g. insurer assessments).
const data = require('./data');
const alerts = require('./alerts');
const A = require('./analyze');
module.exports = {
  start: data.start,
  onBoot: () => { data.start(); },            // server.js calls this after seeding (optional)
  onIncident: data.onIncident,                 // call after a live incident is saved (stream.publish is also auto-hooked)
  fleetProjection: async (fleetId, opts) => { const a = await data.getAnalysis(fleetId, opts); return a ? publicFleet(a, 90) : null; },
  fleetAnalysis: data.getAnalysis,
  alerts,
  engine: A,
  publicFleet,
};
function publicFleet(a, horizonDays) {
  const h = Math.min(90, Math.max(7, horizonDays || 90));
  const hist = a.series.filter((s) => s.actual != null);
  const fut = a.series.filter((s) => s.actual == null).slice(0, h);
  return {
    fleetId: a.fleetId, generatedAt: a.generatedAt, horizonDays: h, risk: a.risk, series: [...hist, ...fut], expected: a.expected, leadingIndicators: a.leadingIndicators, interventions: a.interventions,
    hotspots: a.hotspots, patterns: a.patterns, modelNotes: a.modelNotes,
    fleetName: a.fleetName, vendor: a.vendor, predictionConfidence: Math.round(a._.confidence * 100) / 100, cameraCoveragePct: Math.round(a._.camCov * 100), dataHistoryDays: Math.round(a._.historyDays),
    backtest: { recallPct: a._.backtest.recallPct, collisions: a._.backtest.collisions, caught: a._.backtest.caught, medianLeadDays: a._.backtest.medianLeadDays },
  };
}
