// Insurer assessments: risk report for a fleet (typically from imported history). Printable HTML available.
const express = require('express');
const crypto = require('crypto');
const roster = require('./roster');
const db = require('../db');
const A = require('./analytics');
const { round, clamp } = require('./util');

const DAY = 86400000;
const isFP = (i) => i.camera && i.camera.aiVerdict === 'false_positive';
const LEAD = ['following_distance', 'harsh_brake', 'harsh_accel', 'harsh_turn', 'distracted', 'speeding'];
const PROGRAM = {
  collisions: ['Forward-collision warning + road-facing camera program', 0.28], harsh_events: ['In-cab coaching with video review (AI-triggered)', 0.25],
  speeding: ['Speed policy: governor + geofenced speed alerts', 0.22], distraction: ['Driver-facing camera with phone-use / fatigue alerts', 0.3], maintenance: ['Preventive maintenance with DTC alerting', 0.2],
};

async function run({ fleetId, jobId }) {
  let job = null;
  if (jobId) { job = await db.get('import_job', jobId); if (!job) throw Object.assign(new Error('job not found'), { status: 404 }); fleetId = fleetId || job.fleetId; }
  const fleet = roster.getFleet(fleetId);
  if (!fleet) throw Object.assign(new Error('fleet not found'), { status: 404 });
  const incs = await db.listIncidents({ fleetId, limit: 500000, clone: false });
  if (!incs.length) throw Object.assign(new Error('fleet has no incident history to assess'), { status: 422 });
  const times = incs.map((i) => +new Date(i.timestamp));
  const end = Math.max(...times), start = Math.min(...times);
  const days = Math.max(1, Math.round((end - start) / DAY) + 1);
  const windowDays = Math.max(7, Math.min(days, 365));
  const inWin = incs.filter((i) => +new Date(i.timestamp) >= end - windowDays * DAY);
  const m = A.fleetMetrics(fleet, inWin, end, windowDays);
  const real = inWin.filter((i) => !isFP(i));
  // portfolio comparison (live fleets, last 30d)
  const port = await A.portfolio();
  const peers = port.fleets.filter((f) => f.id !== fleet.id);
  const avgAll = peers.length ? peers.reduce((s, f) => s + f.riskScore, 0) / peers.length : null;
  const vendorPeers = peers.filter((f) => f.vendor === fleet.vendor);
  const peerVendorAvg = vendorPeers.length ? vendorPeers.reduce((s, f) => s + f.riskScore, 0) / vendorPeers.length : null;
  const pctile = peers.length ? Math.round((100 * peers.filter((f) => f.riskScore >= m.riskScore).length) / peers.length) : null; // % of portfolio that is riskier
  // data quality
  let dq = job && job.dataQuality ? job.dataQuality : null;
  if (!dq) {
    const n = real.length || 1; const pc = (f) => Math.round((100 * real.filter(f).length) / n);
    const fc = { vin: pc((i) => i.vehicle && i.vehicle.vin), driver: pc((i) => i.driver && i.driver.id), gps: pc((i) => i.location && i.location.lat != null), speed: pc((i) => i.location && i.location.speed_mph != null), video: pc((i) => i.camera && i.camera.clips && i.camera.clips.length), dtc: pc((i) => i.diagnostics), load: pc((i) => i.load) };
    dq = { dateRange: { from: new Date(start).toISOString().slice(0, 10), to: new Date(end).toISOString().slice(0, 10) }, days, vehicles: fleet.vehicles.length, drivers: fleet.drivers.length, fieldCoverage: fc, duplicates: 0, qualityScore: Math.round(0.2 * fc.vin + 0.2 * fc.driver + 0.2 * fc.gps + 0.1 * fc.speed + 0.1 * fc.video + 15 + 5 * Math.min(1, days / 60)), notes: [] };
  }
  const nVeh = Math.max(1, fleet.vehicleCount || fleet.vehicles.length);
  // exposure
  let milesTotal, basis;
  if (fleet.exposure && fleet.exposure.milesTotal) { milesTotal = fleet.exposure.milesTotal; basis = 'reported'; }
  else { const perDay = fleet.vehicles[0] && fleet.vehicles[0].cls === 'light' ? 90 : 250; milesTotal = Math.round(nVeh * windowDays * perDay); basis = 'estimated'; }
  const epmm = milesTotal ? round((real.length / milesTotal) * 1e6, 1) : null;
  // drivers
  const drivers = A.driverRows(fleet, real);
  const band = (s) => (s >= 85 ? 'low' : s >= 70 ? 'moderate' : s >= 55 ? 'elevated' : 'high');
  const withEvents = drivers.filter((d) => d.events30d > 0 || true);
  const dist = { low: 0, moderate: 0, elevated: 0, high: 0 }; withEvents.forEach((d) => dist[band(d.safetyScore)]++);
  const noDriverPct = real.length ? Math.round((100 * real.filter((i) => !(i.driver && i.driver.id)).length) / real.length) : 0;
  // pre-accident indicators: drivers whose leading indicators accelerate in the last 21d vs the prior 21d
  const ind = [];
  const byDrv = new Map();
  for (const i of real) if (i.driver && i.driver.id && LEAD.includes(i.eventType)) { const e = byDrv.get(i.driver.id) || { name: i.driver.name, recent: 0, prior: 0 }; const age = (end - +new Date(i.timestamp)) / DAY; if (age < 21) e.recent++; else if (age < 42) e.prior++; byDrv.set(i.driver.id, e); }
  const esc = [...byDrv.entries()].filter(([, e]) => e.recent >= 3 && e.recent >= 2 * Math.max(1, e.prior)).sort((a, b) => b[1].recent - a[1].recent).slice(0, 8);
  for (const [id, e] of esc) ind.push({ key: 'driver_escalation', severity: e.recent >= 6 ? 'high' : 'medium', label: `${e.name || id}: leading-indicator events up ${e.prior ? Math.round((e.recent / e.prior - 1) * 100) + '%' : 'from none'}`, detail: `${e.recent} tailgating/harsh/phone/speeding events in the last 21 days vs ${e.prior} in the prior 21`, driverId: id });
  const night = real.filter((i) => { const h = (new Date(i.timestamp).getUTCHours() + 19) % 24; return h >= 22 || h < 5; });
  if (real.length >= 20 && night.length / real.length > 0.18) ind.push({ key: 'night_exposure', severity: 'medium', label: `${Math.round((100 * night.length) / real.length)}% of events occur 10pm-5am`, detail: 'Elevated night-time event share is a fatigue indicator' });
  const dist2 = real.filter((i) => i.eventType === 'distracted' || i.eventType === 'following_distance').length;
  if (real.length >= 20 && dist2 / real.length > 0.3) ind.push({ key: 'distraction_share', severity: 'medium', label: `${Math.round((100 * dist2) / real.length)}% of events are distraction / tailgating`, detail: 'Behavioural events dominate; strongest short-term collision predictor' });
  // recommended programs
  const programs = [...m.components].sort((a, b) => b.score * b.weight - a.score * a.weight).slice(0, 3).map((c) => ({ key: c.key, label: PROGRAM[c.key][0], expectedRiskReductionPct: round(c.score * c.weight * PROGRAM[c.key][1] / Math.max(1, m.riskScore) * 100, 1), rationale: `${c.label}: ${c.rate} per 100 vehicles / 30d (score ${c.score})` }));
  if (m.cameraCoverage < 50 || m.cameraCoveragePct < 50) programs.push({ key: 'camera_first', label: 'Camera-first telematics rollout (e.g. Mantis) for driver-facing signals + AI verification', expectedRiskReductionPct: 15, rationale: `Only ${m.cameraCoveragePct}% camera coverage; camera-verified fleets show higher prediction confidence and faster claim triage` });
  // pricing
  const base = avgAll != null ? avgAll : 45;
  const rawAdj = clamp(round((m.riskScore - base) * 0.4, 1), -15, 25);
  // credibility: short histories / very few events cannot support a confident price signal
  const lowReasons = [];
  if (days < 30) lowReasons.push(`only ${days} day${days === 1 ? '' : 's'} of history (under 30)`);
  if (real.length < 15) lowReasons.push(`only ${real.length} event${real.length === 1 ? '' : 's'} (under 15)`);
  const lowConfidence = lowReasons.length > 0;
  const cred = lowConfidence ? Math.min(1, days / 30, real.length / 15) : 1;
  const adj = lowConfidence ? round(rawAdj * cred * cred, 1) : rawAdj;
  const conf0 = round(clamp(0.3 + 0.4 * (dq.qualityScore / 100) + 0.3 * Math.min(1, real.length / 150), 0.2, 0.95), 2);
  const conf = lowConfidence ? Math.min(conf0, 0.35) : conf0;
  const pricing = { suggestedPremiumAdjustmentPct: adj, direction: adj > 1 ? 'surcharge' : adj < -1 ? 'credit' : 'neutral', baselineRiskScore: round(base, 1), indicative: lowConfidence, lowConfidence, confidenceLabel: lowConfidence ? 'low' : conf >= 0.7 ? 'high' : 'moderate', ...(lowConfidence ? { unclampedAdjustmentPct: rawAdj, lowConfidenceReasons: lowReasons } : {}), rationale: [...(lowConfidence ? [`INDICATIVE ONLY: ${lowReasons.join(' and ')}. The adjustment is damped toward 0% (unadjusted signal ${rawAdj}%) and should not be used for pricing.`] : []), `Risk score ${m.riskScore} vs portfolio baseline ${round(base, 1)}`, `${real.length} events over ${windowDays} days across ${nVeh} vehicles`, ...(m.falsePositivesFiltered ? [`${m.falsePositivesFiltered} camera-identified false positives excluded`] : []), `Data quality ${dq.qualityScore}/100 limits confidence to ${Math.round(conf * 100)}%`] };
  // projection
  let projection = null;
  try { const pr = require('./predict'); if (pr && typeof pr.fleetProjection === 'function') projection = await pr.fleetProjection(fleetId); } catch (e) { /* predict module optional */ }
  if (!projection) {
    const ratio = m.trend === 'up' ? 1.2 : m.trend === 'down' ? 0.82 : 1;
    const half = Math.max(2, 8 + (100 - dq.qualityScore) / 8);
    const p30 = clamp(Math.round(m.riskScore * (1 + (ratio - 1) * 0.35)), 0, 100), p90 = clamp(Math.round(m.riskScore * (1 + (ratio - 1) * 0.8)), 0, 100);
    const coll30 = m.components[0].count * (30 / windowDays);
    projection = {
      source: 'assessment-fallback', fleetId, horizonDays: 90,
      risk: { current: m.riskScore, projected30d: p30, projected90d: p90, band90d: [clamp(Math.round(p90 - half), 0, 100), clamp(Math.round(p90 + half), 0, 100)], direction: m.trend === 'up' ? 'worsening' : m.trend === 'down' ? 'improving' : 'stable' },
      expected: { incidents30d: Math.round(m.events30d), collisions30d: round(coll30, 1), collisionProb30d: round(1 - Math.exp(-coll30), 2), expectedLossUsd90d: Math.round(m.estLossUsd * 3) },
      modelNotes: ['Trend extrapolation from the imported window (EWMA-style, demo-calibrated). The predictive module gives a fuller projection once connected.'],
    };
  }
  const limitations = [];
  if (basis === 'estimated') limitations.push('No mileage rows were supplied: events-per-million-miles uses an estimated exposure (vehicles x days x typical daily miles).');
  if (dq.fieldCoverage.video < 20) limitations.push('Little or no video: events are not camera-verified and false positives cannot be filtered.');
  if (days < 60) limitations.push(`Only ${days} days of history: seasonality and trend cannot be assessed reliably.`);
  if (noDriverPct > 30) limitations.push(`${noDriverPct}% of events have no driver attribution: driver-level distribution is incomplete.`);
  if (dq.qualityScore < 60) limitations.push('Data quality score is below 60: treat the score as indicative only.');
  if (lowConfidence) limitations.unshift(`Low confidence: ${lowReasons.join(' and ')}. Pricing adjustment is indicative only and damped toward 0%.`);
  limitations.push('Scores are demo-calibrated and not actuarial; pricing adjustment is a signal, not a rate filing.');
  const a = {
    id: 'asm_' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex'), fleetId, fleetName: fleet.name, vendor: fleet.vendor, jobId: jobId || null, createdAt: new Date().toISOString(),
    window: { from: new Date(Math.max(start, end - windowDays * DAY)).toISOString().slice(0, 10), to: new Date(end).toISOString().slice(0, 10), days: windowDays }, events: real.length, vehicles: nVeh,
    riskScore: m.riskScore, riskTier: m.riskTier, trend: m.trend, confidence: conf, lowConfidence, indicative: lowConfidence, lowConfidenceReasons: lowReasons, dataQualityScore: dq.qualityScore, dataQuality: dq,
    eventsPerMillionMiles: epmm, exposure: { milesTotal, basis }, collisionRate: m.collisionRate, cameraCoveragePct: m.cameraCoveragePct, verifiedEventPct: m.verifiedEventPct,
    scoreBreakdown: m.components.map((c) => ({ key: c.key, label: c.label, score: c.score, weight: c.weight, contribution: round(c.score * c.weight, 1), count: c.count, ratePer100Veh: c.rate })),
    topRiskFactors: A.topFactors(m, null), driverRiskDistribution: { ...dist }, unattributedEventsPct: noDriverPct,
    benchmark: { vsPortfolio: { portfolioAvgRiskScore: avgAll != null ? round(avgAll, 1) : null, delta: avgAll != null ? round(m.riskScore - avgAll, 1) : null, percentileRiskier: pctile, peers: peers.length }, vsVendorPeers: { vendor: fleet.vendor, peerAvgRiskScore: peerVendorAvg != null ? round(peerVendorAvg, 1) : null, delta: peerVendorAvg != null ? round(m.riskScore - peerVendorAvg, 1) : null, peers: vendorPeers.length } },
    pricing, projection, preAccidentIndicators: ind, recommendedPrograms: programs, limitations,
  };
  await db.put('assessment', a);
  return a;
}

function html(a) {
  const e = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const li = (arr) => arr.map((x) => `<li>${e(typeof x === 'string' ? x : x.label + (x.detail ? ' - ' + x.detail : ''))}</li>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Risk Assessment - ${e(a.fleetName)}</title><style>
body{font:14px/1.45 -apple-system,Segoe UI,Arial,sans-serif;max-width:860px;margin:24px auto;padding:0 20px;color:#111}h1{margin:0}h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;border-bottom:2px solid #ff6a1a;padding-bottom:3px;margin-top:22px}
table{border-collapse:collapse;width:100%}td,th{border:1px solid #d0d5dd;padding:4px 8px;text-align:left}th{background:#f2f4f7}.big{font-size:40px;font-weight:800}.hd{border-bottom:3px solid #0b1b33;padding-bottom:8px}.muted{color:#667085}</style></head><body>
<div class="hd"><b>NEXUS <span style="color:#ff6a1a">RESPONSE</span></b><h1>Fleet Risk Assessment: ${e(a.fleetName)}</h1><div class="muted">${e(a.window.from)} to ${e(a.window.to)} | ${a.events} events | ${a.vehicles} vehicles | vendor ${e(a.vendor)} | generated ${e(a.createdAt)}</div></div>
<p><span class="big">${a.riskScore}</span> / 100 &nbsp; <b>${e(a.riskTier.toUpperCase())}</b> &nbsp; confidence ${Math.round(a.confidence * 100)}% &nbsp; data quality ${a.dataQualityScore}/100</p>
<p>Events per million miles: <b>${a.eventsPerMillionMiles == null ? 'n/a' : a.eventsPerMillionMiles}</b> (${e(a.exposure.basis)} exposure, ${a.exposure.milesTotal.toLocaleString('en-US')} mi). Collision rate ${a.collisionRate} per 100 vehicles / 30d.</p>
<h2>Score breakdown</h2><table><tr><th>Factor</th><th>Rate /100 veh</th><th>Score</th><th>Weight</th></tr>${a.scoreBreakdown.map((c) => `<tr><td>${e(c.label)}</td><td>${c.ratePer100Veh}</td><td>${c.score}</td><td>${Math.round(c.weight * 100)}%</td></tr>`).join('')}</table>
<h2>Pricing signal</h2>${a.pricing.indicative ? '<p style="background:#fff4e5;border:1px solid #ff6a1a;padding:6px 10px"><b>Indicative only - low confidence.</b> Insufficient history to support a pricing adjustment.</p>' : ''}<p><b>${a.pricing.suggestedPremiumAdjustmentPct > 0 ? '+' : ''}${a.pricing.suggestedPremiumAdjustmentPct}%</b> (${e(a.pricing.direction)})</p><ul>${li(a.pricing.rationale)}</ul>
<h2>Projection (90 days)</h2><p>Risk ${a.projection.risk.current} now, ${a.projection.risk.projected30d} in 30d, ${a.projection.risk.projected90d} in 90d (band ${a.projection.risk.band90d.join('-')}), direction <b>${e(a.projection.risk.direction)}</b>. Expected collisions/30d: ${a.projection.expected ? a.projection.expected.collisions30d : 'n/a'}.</p>
<h2>Pre-accident indicators</h2><ul>${li(a.preAccidentIndicators) || '<li>None detected</li>'}</ul>
<h2>Recommended programs</h2><ul>${a.recommendedPrograms.map((p) => `<li>${e(p.label)} - est. -${p.expectedRiskReductionPct}% risk (${e(p.rationale)})</li>`).join('')}</ul>
<h2>Benchmark</h2><p>Portfolio avg ${a.benchmark.vsPortfolio.portfolioAvgRiskScore} (delta ${a.benchmark.vsPortfolio.delta}); ${e(a.benchmark.vsVendorPeers.vendor)} peers avg ${a.benchmark.vsVendorPeers.peerAvgRiskScore}.</p>
<h2>Limitations</h2><ul>${li(a.limitations)}</ul></body></html>`;
}

const router = express.Router();
router.post('/api/insurer/assessments', async (req, res) => {
  try { const a = await run({ fleetId: req.body && req.body.fleetId, jobId: req.body && req.body.jobId }); res.status(201).json(a); }
  catch (e) { res.status(e.status || 422).json({ error: 'assessment_failed', message: e.message }); }
});
router.get('/api/insurer/assessments', async (req, res) => res.json({ assessments: (await db.list('assessment', { fleetId: req.query.fleetId, limit: 200 })).map(({ projection, scoreBreakdown, preAccidentIndicators, recommendedPrograms, limitations, dataQuality, pricing, benchmark, driverRiskDistribution, topRiskFactors, ...s }) => ({ ...s, pricing: { suggestedPremiumAdjustmentPct: pricing.suggestedPremiumAdjustmentPct, indicative: !!pricing.indicative } })) }));
router.get('/api/insurer/assessments/:id', async (req, res) => {
  const a = await db.get('assessment', req.params.id);
  if (!a) return res.status(404).json({ error: 'Assessment not found' });
  if (req.query.format === 'html') return res.type('html').send(html(a));
  res.json(a);
});
router.delete('/api/insurer/assessments/:id', async (req, res) => {
  const a = await db.get('assessment', req.params.id);
  if (!a) return res.status(404).json({ error: 'Assessment not found' });
  await db.del('assessment', a.id);
  let revoked = 0;
  for (const r of await db.list('report', { limit: 100000 })) if (r.kind === 'assessment' && r.refId === a.id) { await db.del('report', r.id); revoked++; }
  res.json({ deleted: true, id: a.id, reportsDeleted: revoked });
});

module.exports = { run, router };
