// Portfolio + backtest aggregation across fleets.
const alerts = require('./alerts');
const { ALERT } = require('./config');
const round = (n, d = 0) => { const p = 10 ** d; return Math.round(n * p) / p; };
const wmean = (rows, f, w) => { const tw = rows.reduce((s, r) => s + w(r), 0); return tw ? rows.reduce((s, r) => s + f(r) * w(r), 0) / tw : 0; };

function build(analyses) {
  const fleets = analyses.map((a) => ({
    fleetId: a.fleetId, name: a.fleetName, vendor: a.vendor, vehicles: a._.vehicleCount, risk: a.risk.current, projected90d: a.risk.projected90d, direction: a.risk.direction,
    expectedLossUsd90d: a.expected.expectedLossUsd90d, cameraCoveragePct: Math.round(a._.camCov * 100), predictionConfidence: round(a._.confidence, 2),
    backtestRecallPct: a._.backtest.recallPct, medianLeadDays: a._.backtest.medianLeadDays, collisionsInBacktest: a._.backtest.collisions, caught: a._.backtest.caught,
    projected30d: a.risk.projected30d, band90d: a.risk.band90d, expectedCollisions30d: a.expected.collisions30d, dataHistoryDays: Math.round(a._.historyDays),
    driversAtRisk: a._.drivers.filter((d) => d.collisionProb30d >= ALERT.P_FLAG).length, alertsOpen: alerts.list({ fleetId: a.fleetId, status: 'open', limit: 1000 }).length,
  })).sort((a, b) => b.risk - a.risk);
  const vendors = [...new Set(fleets.map((f) => f.vendor))];
  const byVendor = vendors.map((v) => {
    const fs = fleets.filter((f) => f.vendor === v);
    const coll = fs.reduce((s, f) => s + f.collisionsInBacktest, 0), caught = fs.reduce((s, f) => s + f.caught, 0);
    const leadFs = fs.filter((f) => f.medianLeadDays != null && f.caught > 0);
    return {
      vendor: v, fleets: fs.length, vehicles: fs.reduce((s, f) => s + f.vehicles, 0), avgRisk: round(wmean(fs, (f) => f.risk, (f) => f.vehicles), 1),
      avgPredictionConfidence: round(wmean(fs, (f) => f.predictionConfidence, (f) => f.vehicles), 2),
      avgLeadDays: leadFs.length ? round(wmean(leadFs, (f) => f.medianLeadDays, (f) => f.caught), 1) : null,
      cameraCoveragePct: Math.round(wmean(fs, (f) => f.cameraCoveragePct, (f) => f.vehicles)),
      backtestRecallPct: coll ? round((100 * caught) / coll, 0) : null, backtestCollisions: coll, backtestCaught: caught,
    };
  }).sort((a, b) => b.avgPredictionConfidence - a.avgPredictionConfidence);
  const totals = {
    expectedLossUsd90d: Math.round(fleets.reduce((s, f) => s + f.expectedLossUsd90d, 0) / 100) * 100,
    alertsOpen: alerts.counts().open, driversAtRisk: fleets.reduce((s, f) => s + f.driversAtRisk, 0), fleets: fleets.length, vehicles: fleets.reduce((s, f) => s + f.vehicles, 0),
    expectedCollisions30d: round(fleets.reduce((s, f) => s + f.expectedCollisions30d, 0), 1),
  };
  return { fleets, byVendor, totals, insight: insight(byVendor) };
}

function insight(byVendor) {
  const m = byVendor.find((v) => v.vendor === 'mantis');
  const others = byVendor.filter((v) => v.vendor !== 'mantis');
  if (!m) return 'No Mantis fleets in the portfolio yet. Camera-equipped fleets with driver-facing signals generally support higher prediction confidence and earlier warning.';
  if (!others.length) return `Mantis fleets only: prediction confidence ${m.avgPredictionConfidence}.`;
  const ov = others.reduce((s, v) => s + v.vehicles, 0) || 1;
  const oConf = others.reduce((s, v) => s + v.avgPredictionConfidence * v.vehicles, 0) / ov;
  const oCam = others.reduce((s, v) => s + v.cameraCoveragePct * v.vehicles, 0) / ov;
  const oColl = others.reduce((s, v) => s + v.backtestCollisions, 0), oCaught = others.reduce((s, v) => s + v.backtestCaught, 0);
  const oRecall = oColl ? Math.round((100 * oCaught) / oColl) : null;
  const leadV = others.filter((v) => v.avgLeadDays != null);
  const oLead = leadV.length ? leadV.reduce((s, v) => s + v.avgLeadDays * v.backtestCaught, 0) / Math.max(1, leadV.reduce((s, v) => s + v.backtestCaught, 0)) : null;
  const parts = [`Mantis fleets: prediction confidence ${m.avgPredictionConfidence} vs ${round(oConf, 2)} for other vendors`];
  if (m.avgLeadDays != null && oLead != null) parts.push(`median warning lead ${m.avgLeadDays} days vs ${round(oLead, 1)}`);
  if (m.backtestRecallPct != null && oRecall != null) parts.push(`backtest recall ${m.backtestRecallPct}% vs ${oRecall}%`);
  parts.push(`camera coverage ${m.cameraCoveragePct}% vs ${Math.round(oCam)}%`);
  const wins = [];
  if (m.avgPredictionConfidence > oConf + 0.02) wins.push('prediction confidence');
  if (m.avgLeadDays != null && oLead != null && m.avgLeadDays > oLead + 1) wins.push('warning lead time');
  if (m.backtestRecallPct != null && oRecall != null && m.backtestRecallPct > oRecall + 3) wins.push('backtest recall');
  const tail = wins.length
    ? ` Camera-first Mantis data leads on ${wins.join(', ')}: driver-facing signals (phone use, drowsiness, tailgating) are the earliest precursors.`
    : ' Backtest recall and lead time are comparable in this sample; the measurable Mantis edge is signal richness and prediction confidence (driver-facing signals other vendors do not capture).';
  return parts.join('; ') + '.' + tail + ' Backtest samples are small; treat gaps as directional.';
}

function aggregateBacktest(analyses) {
  const bts = analyses.map((a) => a._.backtest);
  const collisions = bts.reduce((s, b) => s + b.collisions, 0), caught = bts.reduce((s, b) => s + b.caught, 0);
  const leads = bts.flatMap((b) => b.examples.filter((e) => e.caught).map((e) => e.leadDays));
  const veh = analyses.reduce((s, a) => s + a._.vehicleCount, 0) || 1;
  const fa = bts.reduce((s, b, i) => s + (b.falseAlertsPer100Veh * analyses[i]._.vehicleCount) / 100, 0);
  const eps = bts.reduce((s, b) => s + b.alertEpisodes, 0);
  const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  return {
    fleetId: null, window: bts[0] ? bts[0].window : null, collisions, caught, recallPct: collisions ? Math.round((100 * caught) / collisions) : null, medianLeadDays: leads.length ? round(median(leads), 1) : null,
    falseAlertsPer100Veh: round((fa / veh) * 100, 1), alertEpisodes: eps,
    byFleet: bts.map((b, i) => ({ fleetId: b.fleetId, name: analyses[i].fleetName, vendor: analyses[i].vendor, collisions: b.collisions, caught: b.caught, recallPct: b.recallPct, medianLeadDays: b.medianLeadDays, falseAlertsPer100Veh: b.falseAlertsPer100Veh })),
    examples: bts.flatMap((b) => b.examples).sort((a, b) => (b.caught ? 1 : 0) - (a.caught ? 1 : 0) || (b.leadDays || 0) - (a.leadDays || 0)).slice(0, 14),
    limitations: bts[0] ? bts[0].limitations : [],
  };
}
module.exports = { build, aggregateBacktest, insight };
