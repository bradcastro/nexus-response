// Portfolio + backtest aggregation across fleets.
const alerts = require('./alerts');
const { ALERT } = require('./config');
const { provenance, DISCLAIMER } = require('./provenance');
const round = (n, d = 0) => { const p = 10 ** d; return Math.round(n * p) / p; };
const wmean = (rows, f, w) => { const tw = rows.reduce((s, r) => s + w(r), 0); return tw ? rows.reduce((s, r) => s + f(r) * w(r), 0) / tw : 0; };

// ---- ONE calculation source for every vendor/group comparison metric -------------------------------
// All endpoints (/portfolio byVendor + comparison + insight, /backtest overall, /fleet/:id backtest) derive
// from statsFor(). Aggregation rules (documented in docs/PREDICT.md):
//   cameraCoveragePct, predictionConfidence, avgRisk : vehicle-weighted mean of fleet values (unrounded inputs)
//   recallPct                                        : pooled (sum caught / sum collisions) over all fleets in the group
//   leadDays mean / median                           : pooled over every caught collision's lead time (not mean-of-medians)
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
function statsFor(analyses) {
  const vehicles = analyses.reduce((s, a) => s + a._.vehicleCount, 0);
  const vw = (f) => (vehicles ? analyses.reduce((s, a) => s + f(a) * a._.vehicleCount, 0) / vehicles : null);
  const collisions = analyses.reduce((s, a) => s + a._.backtest.collisions, 0), caught = analyses.reduce((s, a) => s + a._.backtest.caught, 0);
  const leads = analyses.flatMap((a) => a._.backtest.leadDaysAll || []);
  return {
    n: { fleets: analyses.length, vehicles, backtestCollisions: collisions, backtestCaught: caught, leadSamples: leads.length },
    avgRisk: vehicles ? round(vw((a) => a.risk.current), 1) : null,
    predictionConfidence: vehicles ? round(vw((a) => a._.confidence), 2) : null,
    cameraCoveragePct: vehicles ? Math.round(vw((a) => a._.camCov) * 100) : null,
    recallPct: collisions ? Math.round((100 * caught) / collisions) : null,
    meanLeadDays: leads.length ? round(leads.reduce((s, x) => s + x, 0) / leads.length, 1) : null,
    medianLeadDays: leads.length ? round(median(leads), 1) : null,
  };
}
const METRIC_BASIS = {
  cameraCoveragePct: { aggregation: 'vehicle-weighted mean of fleet camera coverage', population: 'all vehicles in the group' },
  predictionConfidence: { aggregation: 'vehicle-weighted mean of fleet prediction confidence (0-1)', population: 'all fleets in the group' },
  avgRisk: { aggregation: 'vehicle-weighted mean of fleet predicted risk score (0-100)', population: 'all fleets in the group' },
  recallPct: { aggregation: 'pooled: collisions with a prior flag / all collisions', population: 'all backtest collisions in the group', period: 'walk-forward backtest window (see backtest.window)' },
  warningLeadDays: { aggregation: 'pooled over every flagged-ahead collision (mean = avgLeadDays, median = medianLeadDays); NOT a mean of fleet medians', population: 'collisions that were flagged ahead (flagged-only; misses excluded)', period: 'capped at 30 days by construction of the backtest' },
};

function build(analyses) {
  const fleets = analyses.map((a) => ({
    fleetId: a.fleetId, name: a.fleetName, vendor: a.vendor, vehicles: a._.vehicleCount, risk: a.risk.current, projected90d: a.risk.projected90d, direction: a.risk.direction,
    expectedLossUsd90d: a.expected.expectedLossUsd90d, cameraCoveragePct: Math.round(a._.camCov * 100), predictionConfidence: round(a._.confidence, 2),
    backtestRecallPct: a._.backtest.recallPct, medianLeadDays: a._.backtest.medianLeadDays, collisionsInBacktest: a._.backtest.collisions, caught: a._.backtest.caught,
    projected30d: a.risk.projected30d, band90d: a.risk.band90d, expectedCollisions30d: a.expected.collisions30d, dataHistoryDays: Math.round(a._.historyDays),
    driversAtRisk: a._.drivers.filter((d) => d.collisionProb30d >= ALERT.P_FLAG).length, alertsOpen: alerts.list({ fleetId: a.fleetId, status: 'open', limit: 1000 }).length,
    illustrative: true,
  })).sort((a, b) => b.risk - a.risk);
  const vendors = [...new Set(analyses.map((a) => a.vendor))];
  const byVendor = vendors.map((v) => {
    const st = statsFor(analyses.filter((a) => a.vendor === v));
    return {
      vendor: v, fleets: st.n.fleets, vehicles: st.n.vehicles, avgRisk: st.avgRisk, avgPredictionConfidence: st.predictionConfidence,
      avgLeadDays: st.meanLeadDays, medianLeadDays: st.medianLeadDays, cameraCoveragePct: st.cameraCoveragePct,
      backtestRecallPct: st.recallPct, backtestCollisions: st.n.backtestCollisions, backtestCaught: st.n.backtestCaught, leadSamples: st.n.leadSamples,
      basis: { population: 'all fleets of this vendor (n = fleets/vehicles)', aggregation: 'see portfolio.comparison.metrics', illustrative: true },
    };
  }).sort((a, b) => b.avgPredictionConfidence - a.avgPredictionConfidence);
  const totals = {
    expectedLossUsd90d: Math.round(fleets.reduce((s, f) => s + f.expectedLossUsd90d, 0) / 100) * 100,
    alertsOpen: alerts.counts().open, driversAtRisk: fleets.reduce((s, f) => s + f.driversAtRisk, 0), fleets: fleets.length, vehicles: fleets.reduce((s, f) => s + f.vehicles, 0),
    expectedCollisions30d: round(fleets.reduce((s, f) => s + f.expectedCollisions30d, 0), 1),
  };
  const comparison = buildComparison(analyses);
  return { fleets, byVendor, totals, comparison, insight: insight(comparison), illustrative: true, label: 'Illustrative risk indicators (synthetic demo data)', disclaimer: DISCLAIMER, provenance: provenance() };
}

// Mantis fleets vs ALL other-vendor fleets pooled (one group, not an average of vendor averages).
function buildComparison(analyses) {
  const m = analyses.filter((a) => a.vendor === 'mantis'), o = analyses.filter((a) => a.vendor !== 'mantis');
  const ms = m.length ? statsFor(m) : null, os = o.length ? statsFor(o) : null;
  const d = (k) => (ms && os && ms[k] != null && os[k] != null ? round(ms[k] - os[k], 2) : null);
  return {
    basis: 'Mantis fleets vs all other-vendor fleets pooled, one calculation shared by byVendor, insight and /backtest',
    population: 'synthetic demo fleets only', aggregation: 'see metrics', period: 'walk-forward backtest over the synthetic history (~90 days)',
    illustrative: true, significant: false,
    significanceNote: 'Small synthetic sample; differences are directional only and are not evidence of real-world superiority.',
    metrics: METRIC_BASIS,
    mantis: ms, otherVendors: os,
    delta: ms && os ? { predictionConfidence: d('predictionConfidence'), cameraCoveragePct: d('cameraCoveragePct'), recallPct: d('recallPct'), meanLeadDays: d('meanLeadDays'), medianLeadDays: d('medianLeadDays') } : null,
  };
}

function insight(cmp) {
  const m = cmp && cmp.mantis, o = cmp && cmp.otherVendors;
  if (!m) return 'No Mantis fleets in the portfolio yet. In this synthetic demo, camera-equipped fleets with driver-facing signals support higher model confidence; no real-world performance is implied.';
  if (!o) return `Mantis fleets only: model confidence ${m.predictionConfidence} (synthetic demo data).`;
  const parts = [`Synthetic demo data - Mantis fleets: model confidence ${m.predictionConfidence} vs ${o.predictionConfidence} for other vendors pooled`];
  if (m.meanLeadDays != null && o.meanLeadDays != null) parts.push(`mean warning lead ${m.meanLeadDays} days vs ${o.meanLeadDays} (median ${m.medianLeadDays} vs ${o.medianLeadDays}; flagged-ahead collisions only)`);
  if (m.recallPct != null && o.recallPct != null) parts.push(`backtest recall ${m.recallPct}% vs ${o.recallPct}%`);
  parts.push(`camera coverage ${m.cameraCoveragePct}% vs ${o.cameraCoveragePct}%`);
  const wins = [];
  if (m.predictionConfidence > o.predictionConfidence + 0.02) wins.push('model confidence');
  if (m.meanLeadDays != null && o.meanLeadDays != null && m.meanLeadDays > o.meanLeadDays + 1) wins.push('warning lead time');
  if (m.recallPct != null && o.recallPct != null && m.recallPct > o.recallPct + 3) wins.push('backtest recall');
  const tail = wins.length
    ? ` In this sample Mantis fleets score higher on ${wins.join(', ')}; driver-facing camera signals are richer inputs to the model.`
    : ' Recall and lead time are comparable in this sample; the visible difference is input richness and model confidence from driver-facing signals.';
  return parts.join('; ') + '.' + tail + ' Synthetic, small-sample, in-sample tuned: directional only, not evidence of real-world performance.';
}

function aggregateBacktest(analyses) {
  const bts = analyses.map((a) => a._.backtest);
  const st = statsFor(analyses);
  const veh = analyses.reduce((s, a) => s + a._.vehicleCount, 0) || 1;
  const fa = bts.reduce((s, b, i) => s + (b.falseAlertsPer100Veh * analyses[i]._.vehicleCount) / 100, 0);
  const eps = bts.reduce((s, b) => s + b.alertEpisodes, 0);
  return {
    fleetId: null, window: bts[0] ? bts[0].window : null, collisions: st.n.backtestCollisions, caught: st.n.backtestCaught, recallPct: st.recallPct,
    medianLeadDays: st.medianLeadDays, meanLeadDays: st.meanLeadDays, leadSamples: st.n.leadSamples,
    falseAlertsPer100Veh: round((fa / veh) * 100, 1), alertEpisodes: eps,
    basis: { population: 'all fleets pooled (flagged-ahead collisions for lead time; all collisions for recall)', aggregation: 'pooled over collisions, not mean of fleet values', period: 'walk-forward backtest window', n: st.n },
    byFleet: bts.map((b, i) => ({ fleetId: b.fleetId, name: analyses[i].fleetName, vendor: analyses[i].vendor, collisions: b.collisions, caught: b.caught, recallPct: b.recallPct, medianLeadDays: b.medianLeadDays, falseAlertsPer100Veh: b.falseAlertsPer100Veh })),
    examples: bts.flatMap((b) => b.examples).sort((a, b) => (b.caught ? 1 : 0) - (a.caught ? 1 : 0) || (b.leadDays || 0) - (a.leadDays || 0)).slice(0, 14),
    limitations: bts[0] ? bts[0].limitations : [],
    illustrative: true, label: 'Illustrative backtest on synthetic data (in-sample tuned)', disclaimer: DISCLAIMER, provenance: provenance(),
  };
}
module.exports = { build, aggregateBacktest, insight, statsFor, buildComparison, METRIC_BASIS };
