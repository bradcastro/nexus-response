// Aggregations for fleet portal + insurer portal. All computed on the fly from stored incidents.
const db = require('../db');
const roster = require('./roster');
const { round, clamp } = require('./util');

const DAY = 86400000;
const OPEN = ['pending', 'validating', 'dispatched', 'en_route', 'on_scene'];
const HARSH = ['harsh_brake', 'harsh_accel', 'harsh_turn'];
const DISTRACT = ['distracted', 'following_distance'];
const MAINT = ['fault_code', 'breakdown', 'tire', 'battery'];
const isFP = (i) => i.camera && i.camera.aiVerdict === 'false_positive';
const midVal = (i) => (i.load && i.load.contents && i.load.contents.estimatedValueUsd ? (i.load.contents.estimatedValueUsd[0] + i.load.contents.estimatedValueUsd[1]) / 2 : 0);
const CARGO_EVENTS = ['collision', 'rollover', 'breakdown'];
function cargoExposure(incs) {
  const withLoad = incs.filter((i) => i.load && !isFP(i) && i.load.estimatedWeightLb > 300);
  const exp = withLoad.filter((i) => CARGO_EVENTS.includes(i.eventType));
  const by = {};
  exp.forEach((i) => { const c = i.load.contents.category; const e = (by[c] = by[c] || { category: c, incidents: 0, estValueUsd: 0 }); e.incidents++; e.estValueUsd += Math.round(midVal(i)); });
  const pct = withLoad.filter((i) => i.load.payloadPctOfMax != null);
  return {
    avgLoadLb: withLoad.length ? Math.round(withLoad.reduce((s, i) => s + i.load.estimatedWeightLb, 0) / withLoad.length) : 0,
    avgLoadPctOfMax: pct.length ? Math.round(pct.reduce((s, i) => s + i.load.payloadPctOfMax, 0) / pct.length) : 0,
    byContent: Object.values(by).sort((a, b) => b.estValueUsd - a.estValueUsd),
    hazmatEvents: exp.filter((i) => i.load.contents.hazmat).length, perishableEvents: exp.filter((i) => i.load.contents.temperatureSensitive).length,
    highValueEvents: exp.filter((i) => i.load.contents.estimatedValueUsd[1] >= 50000).length, overweightEvents: withLoad.filter((i) => i.load.overweightRisk).length,
    incidentsWithLoadContext: withLoad.length, totalEstCargoExposureUsd: Math.round(exp.reduce((s, i) => s + midVal(i), 0)),
  };
}
const mins = (a, b) => (new Date(b) - new Date(a)) / 60000;

const COMPONENTS = [
  { key: 'collisions', label: 'Collisions', weight: 0.35, cap: 14, types: ['collision', 'rollover'], unit: 'confirmed collisions / 100 vehicles / 30d' },
  { key: 'harsh_events', label: 'Harsh driving events', weight: 0.2, cap: 40, types: HARSH, unit: 'harsh brake/accel/turn events / 100 vehicles / 30d' },
  { key: 'speeding', label: 'Speeding', weight: 0.15, cap: 18, types: ['speeding'], unit: 'speeding events / 100 vehicles / 30d' },
  { key: 'distraction', label: 'Distraction & following distance', weight: 0.15, cap: 30, types: DISTRACT, unit: 'distraction events / 100 vehicles / 30d' },
  { key: 'maintenance', label: 'Maintenance / DTC backlog', weight: 0.15, cap: 30, types: MAINT, unit: 'fault & breakdown events / 100 vehicles / 30d' },
];
const TIERS = [[0, 'low'], [30, 'moderate'], [44, 'elevated'], [60, 'high']];
const tierOf = (s) => TIERS.filter(([t]) => s >= t).pop()[1];

async function all30(now = Date.now()) {
  const since = new Date(now - 30 * DAY).toISOString();
  return db.listIncidents({ since, limit: 100000 });
}

function driverScores(incs) {
  const pen = { collision: 12, rollover: 18, distracted: 5, harsh_brake: 3, harsh_accel: 2, harsh_turn: 2, speeding: 3, following_distance: 2, fault_code: 0, breakdown: 0, tire: 0, battery: 0, other: 0 };
  const m = new Map();
  for (const i of incs) {
    if (isFP(i) || !i.driver || !i.driver.id) continue;
    const e = m.get(i.driver.id) || { events: 0, collisions: 0, penalty: 0, byType: {} };
    e.events++; if (['collision', 'rollover'].includes(i.eventType)) e.collisions++;
    e.penalty += pen[i.eventType] || 0; e.byType[i.eventType] = (e.byType[i.eventType] || 0) + 1;
    m.set(i.driver.id, e);
  }
  return m;
}
function driverRows(fleet, incs) {
  const m = driverScores(incs);
  return fleet.drivers.map((d) => {
    const e = m.get(d.id) || { events: 0, collisions: 0, penalty: 0, byType: {} };
    const top = Object.entries(e.byType).sort((a, b) => b[1] - a[1])[0];
    return { id: d.id, name: d.name, vehicleId: d.vehicleId, safetyScore: clamp(Math.round(d.safetyScore - e.penalty), 20, 100), events30d: e.events, collisions30d: e.collisions, topBehavior: top ? top[0] : null };
  });
}

function fleetMetrics(fleet, incs, now = Date.now()) {
  const mine = incs.filter((i) => i.fleetId === fleet.id);
  const real = mine.filter((i) => !isFP(i));
  const nVeh = fleet.vehicles.length;
  const per100 = (n) => round((n / nVeh) * 100, 1);
  const comps = COMPONENTS.map((c) => {
    const n = real.filter((i) => c.types.includes(i.eventType)).length;
    const rate = per100(n);
    return { key: c.key, label: c.label, weight: c.weight, count: n, rate, unit: c.unit, score: Math.round(clamp((rate / c.cap) * 100, 0, 100)) };
  });
  const riskScore = Math.round(comps.reduce((s, c) => s + c.score * c.weight, 0));
  const half = (from, to) => real.filter((i) => { const age = (now - new Date(i.timestamp)) / DAY; return age >= from && age < to; }).reduce((s, i) => s + (i.risk ? i.risk.eventScore : 30), 0);
  const recent = half(0, 15), prior = half(15, 30);
  const ratio = prior === 0 ? (recent > 0 ? 2 : 1) : recent / prior;
  const trend = ratio > 1.18 ? 'up' : ratio < 0.85 ? 'down' : 'flat';
  const withCam = mine.filter((i) => i.camera && i.camera.aiVerdict !== 'no_video');
  const cameraCoveragePct = Math.round((100 * fleet.vehicles.filter((v) => v.hasCamera).length) / nVeh);
  const verifiedEventPct = mine.length ? Math.round((100 * mine.filter((i) => i.camera && i.camera.verified).length) / mine.length) : 0;
  const collisions = comps[0].count;
  const sev = fleet.vehicles[0] && fleet.vehicles[0].cls === 'heavy' ? 14000 : 5500;
  const estLoss = collisions * sev * 0.55;
  const premiumMonthly = nVeh * (fleet.vehicles[0] && fleet.vehicles[0].cls === 'heavy' ? 9800 : 6400) / 12;
  return {
    id: fleet.id, name: fleet.name, vendor: fleet.vendor, vehicles: nVeh, riskScore, riskTier: tierOf(riskScore), components: comps,
    events30d: mine.length, events30dPer100veh: per100(mine.length), collisionRate: comps[0].rate, trend, cameraCoveragePct, verifiedEventPct,
    falsePositivesFiltered: mine.length - real.length, estLossUsd: Math.round(estLoss), estMonthlyPremiumUsd: Math.round(premiumMonthly), cargo: cargoExposure(mine),
  };
}

function topFactors(m, portfolioAvgByKey) {
  return [...m.components].sort((a, b) => b.score * b.weight - a.score * a.weight).slice(0, 3).map((c) => {
    const avg = portfolioAvgByKey ? portfolioAvgByKey[c.key] : null;
    return `${c.label}: ${c.rate} per 100 vehicles${avg != null ? ` (portfolio ${avg})` : ''}`;
  });
}

async function portfolio() {
  const incs = await all30();
  const metrics = roster.all().map((f) => fleetMetrics(f, incs));
  const avgByKey = {};
  for (const c of COMPONENTS) avgByKey[c.key] = round(metrics.reduce((s, m) => s + m.components.find((x) => x.key === c.key).rate, 0) / metrics.length, 1);
  const fleets = metrics.map((m) => ({
    id: m.id, name: m.name, vendor: m.vendor, vehicles: m.vehicles, riskScore: m.riskScore, riskTier: m.riskTier, events30dPer100veh: m.events30dPer100veh,
    collisionRate: m.collisionRate, avgLoadPctOfMax: m.cargo.avgLoadPctOfMax, cargoExposureUsd: m.cargo.totalEstCargoExposureUsd, topRiskFactors: topFactors(m, avgByKey), trend: m.trend, cameraCoveragePct: m.cameraCoveragePct, verifiedEventPct: m.verifiedEventPct,
  }));
  const totalVeh = metrics.reduce((s, m) => s + m.vehicles, 0);
  const loss = metrics.reduce((s, m) => s + m.estLossUsd, 0), prem = metrics.reduce((s, m) => s + m.estMonthlyPremiumUsd, 0);
  const vendors = {};
  for (const m of metrics) { const v = (vendors[m.vendor] = vendors[m.vendor] || { vendor: m.vendor, fleets: 0, vehicles: 0, riskSum: 0 }); v.fleets++; v.vehicles += m.vehicles; v.riskSum += m.riskScore; }
  const distribution = { low: 0, moderate: 0, elevated: 0, high: 0 };
  metrics.forEach((m) => distribution[m.riskTier]++);
  const avgRisk = round(metrics.reduce((s, m) => s + m.riskScore * m.vehicles, 0) / totalVeh, 1);
  return {
    totals: {
      fleets: metrics.length, vehicles: totalVeh, events30d: incs.length, lossRatioProxy: round(loss / prem, 2), avgRiskScore: avgRisk,
      verifiedEventPct: Math.round(metrics.reduce((s, m) => s + m.verifiedEventPct * m.events30d, 0) / Math.max(1, incs.length)),
      falsePositivesFiltered: metrics.reduce((s, m) => s + m.falsePositivesFiltered, 0), estLossUsd: loss, vendors: Object.keys(vendors).length,
    },
    fleets, byVendor: Object.values(vendors).map((v) => ({ vendor: v.vendor, fleets: v.fleets, vehicles: v.vehicles, avgRisk: round(v.riskSum / v.fleets, 1) })), distribution,
    portfolioAvgByComponent: avgByKey,
  };
}

async function fleetDeepDive(fleetId) {
  const fleet = roster.getFleet(fleetId);
  if (!fleet) return null;
  const incs = await all30();
  const metrics = roster.all().map((f) => fleetMetrics(f, incs));
  const m = metrics.find((x) => x.id === fleetId);
  const avgScore = round(metrics.reduce((s, x) => s + x.riskScore * x.vehicles, 0) / metrics.reduce((s, x) => s + x.vehicles, 0), 1);
  const avgByKey = {};
  for (const c of COMPONENTS) avgByKey[c.key] = round(metrics.reduce((s, x) => s + x.components.find((y) => y.key === c.key).rate, 0) / metrics.length, 1);
  const mine = incs.filter((i) => i.fleetId === fleetId);
  const drivers = driverRows(fleet, mine).filter((d) => d.events30d > 0).sort((a, b) => a.safetyScore - b.safetyScore || b.events30d - a.events30d);
  const adj = clamp(round((m.riskScore - avgScore) * 0.4, 1), -15, 25);
  const rationale = [];
  const worst = [...m.components].sort((a, b) => (b.rate / avgByKey[b.key] || 0) - (a.rate / avgByKey[a.key] || 0));
  for (const c of worst.slice(0, 2)) if (avgByKey[c.key] > 0) rationale.push(`${c.label} ${c.rate}/100 veh vs portfolio ${avgByKey[c.key]} (${c.rate >= avgByKey[c.key] ? '+' : ''}${round(((c.rate - avgByKey[c.key]) / avgByKey[c.key]) * 100, 0)}%)`);
  rationale.push(`${m.verifiedEventPct}% of events camera-verified; ${m.falsePositivesFiltered} false positives filtered out of the score`);
  if (m.trend !== 'flat') rationale.push(`Risk trend is ${m.trend === 'up' ? 'worsening' : 'improving'} (last 15d vs prior 15d)`);
  const rankPct = (key) => { const vals = metrics.map((x) => x.components.find((y) => y.key === key).rate).sort((a, b) => a - b); const mine = m.components.find((y) => y.key === key).rate; return Math.round((100 * vals.filter((v) => v <= mine).length) / vals.length); };
  const weekly = [];
  for (let w = 3; w >= 0; w--) {
    const from = Date.now() - (w + 1) * 7 * DAY, to = Date.now() - w * 7 * DAY;
    const c = mine.filter((i) => { const t = +new Date(i.timestamp); return t >= from && t < to && !isFP(i); });
    weekly.push({ weekStart: new Date(from).toISOString().slice(0, 10), events: c.length, collisions: c.filter((i) => ['collision', 'rollover'].includes(i.eventType)).length, avgEventRisk: c.length ? Math.round(c.reduce((s, i) => s + i.risk.eventScore, 0) / c.length) : 0 });
  }
  const verified = mine.filter((i) => i.camera && i.camera.verified && !isFP(i) && i.severity !== 'low').sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)).slice(0, 8)
    .map((i) => ({ id: i.id, timestamp: i.timestamp, eventType: i.eventType, severity: i.severity, driver: i.driver.name, vehicle: i.vehicle.plate, address: i.location.address, aiVerdict: i.camera.aiVerdict, confidence: i.camera.confidence, signals: i.camera.signals, clip: i.camera.clips[0] ? i.camera.clips[0].url : null, snapshot: i.camera.snapshots[0] ? i.camera.snapshots[0].url : null, eventScore: i.risk.eventScore }));
  const openDtc = mine.filter((i) => i.diagnostics && OPEN.includes(i.status)).length;
  return {
    fleet: roster.publicFleet(fleet),
    riskScore: m.riskScore, riskTier: m.riskTier, trend: m.trend, weights: COMPONENTS.map((c) => ({ key: c.key, weight: c.weight })),
    scoreBreakdown: m.components.map((c) => ({ key: c.key, label: c.label, score: c.score, weight: c.weight, contribution: round(c.score * c.weight, 1), count: c.count, ratePer100Veh: c.rate, portfolioRatePer100Veh: avgByKey[c.key], detail: c.unit })),
    kpis: { events30d: m.events30d, events30dPer100veh: m.events30dPer100veh, collisionRate: m.collisionRate, cameraCoveragePct: m.cameraCoveragePct, verifiedEventPct: m.verifiedEventPct, falsePositivesFiltered: m.falsePositivesFiltered, openMaintenanceItems: openDtc },
    cargoExposure: (() => { const c = m.cargo; return { avgLoadLb: c.avgLoadLb, avgLoadPctOfMax: c.avgLoadPctOfMax, byContent: c.byContent, hazmatEvents: c.hazmatEvents, perishableEvents: c.perishableEvents, highValueEvents: c.highValueEvents, overweightEvents: c.overweightEvents, incidentsWithLoadContext: c.incidentsWithLoadContext, totalEstCargoExposureUsd: c.totalEstCargoExposureUsd }; })(),
    driversRanked: drivers.slice(0, 12), recentVerifiedIncidents: verified, weeklyTrend: weekly,
    pricingSignal: {
      suggestedPremiumAdjustmentPct: adj, direction: adj > 1 ? 'surcharge' : adj < -1 ? 'credit' : 'neutral',
      confidence: m.verifiedEventPct >= 65 && m.cameraCoveragePct >= 70 ? 'high' : m.verifiedEventPct >= 40 ? 'medium' : 'low', rationale,
      estMonthlyPremiumUsd: m.estMonthlyPremiumUsd, estAdjustmentUsdPerMonth: Math.round((m.estMonthlyPremiumUsd * adj) / 100),
    },
    benchmark: { portfolioAvgRiskScore: avgScore, riskScoreDelta: round(m.riskScore - avgScore, 1), riskRank: [...metrics].sort((a, b) => a.riskScore - b.riskScore).findIndex((x) => x.id === fleetId) + 1, of: metrics.length,
      metrics: m.components.map((c) => ({ key: c.key, label: c.label, fleet: c.rate, portfolio: avgByKey[c.key], deltaPct: avgByKey[c.key] ? round(((c.rate - avgByKey[c.key]) / avgByKey[c.key]) * 100, 0) : null, percentileLowerIsBetter: rankPct(c.key) })) },
  };
}

async function fleetSummary(fleetId) {
  const fleet = roster.getFleet(fleetId);
  if (!fleet) return null;
  const now = Date.now();
  const incs = (await all30()).filter((i) => i.fleetId === fleetId);
  const open = incs.filter((i) => OPEN.includes(i.status));
  const resolved = incs.filter((i) => i.status === 'resolved' && i.resolvedAt);
  const mttr = resolved.length ? Math.round(resolved.reduce((s, i) => s + mins(i.receivedAt, i.resolvedAt), 0) / resolved.length) : 0;
  const rows = driverRows(fleet, incs);
  const fleetScore = Math.round(rows.reduce((s, d) => s + d.safetyScore, 0) / rows.length);
  const trend = [];
  for (let d = 29; d >= 0; d--) {
    const day = new Date(now - d * DAY).toISOString().slice(0, 10);
    trend.push({ date: day, count: incs.filter((i) => i.timestamp.slice(0, 10) === day).length });
  }
  const byType = {};
  incs.forEach((i) => { byType[i.eventType] = (byType[i.eventType] || 0) + 1; });
  const openByVeh = new Map();
  open.forEach((i) => { const e = openByVeh.get(i.vehicle.id) || { n: 0, dtc: 0, loc: i.location, sev: i.severity }; e.n++; e.dtc += i.diagnostics ? i.diagnostics.dtcs.length : 0; openByVeh.set(i.vehicle.id, e); });
  const recovered = incs.filter((i) => i.warranty && i.warranty.claimPacket && ['paid', 'approved'].includes(i.warranty.claimPacket.status)).reduce((s, i) => s + i.warranty.claimPacket.estimatedValueUsd, 0);
  const pendingClaims = incs.filter((i) => i.warranty && i.warranty.claimPacket && ['draft', 'ready', 'submitted'].includes(i.warranty.claimPacket.status));
  return {
    fleet: roster.publicFleet(fleet),
    kpis: {
      openIncidents: open.length, mttrMin: mttr, eventsLast30d: incs.length, roadsideCalls: incs.filter((i) => i.roadside && i.roadside.needed && i.roadside.assignedProvider).length,
      warrantyRecoveredUsd: Math.round(recovered), warrantyPendingUsd: Math.round(pendingClaims.reduce((s, i) => s + i.warranty.claimPacket.estimatedValueUsd, 0)), warrantyClaimsPending: pendingClaims.length,
      cargoAtRiskUsd: Math.round(open.filter((i) => !isFP(i) && CARGO_EVENTS.includes(i.eventType)).reduce((s, i) => s + midVal(i), 0)), incidentsWithLoadContext: incs.filter((i) => i.load).length,
      safetyScore: fleetScore, cameraVerifiedPct: incs.length ? Math.round((100 * incs.filter((i) => i.camera.verified).length) / incs.length) : 0,
    },
    trend, byType,
    byContent: (() => { const b = {}; incs.filter((i) => i.load && !isFP(i) && i.load.estimatedWeightLb > 300).forEach((i) => { const c = i.load.contents.category; b[c] = (b[c] || 0) + 1; }); return b; })(),
    topDrivers: [...rows].sort((a, b) => a.safetyScore - b.safetyScore).slice(0, 5),
    bestDrivers: [...rows].sort((a, b) => b.safetyScore - a.safetyScore).slice(0, 5),
    vehicles: fleet.vehicles.map((v) => {
      const o = openByVeh.get(v.id);
      return { id: v.id, unit: v.unit, plate: v.plate, year: v.year, make: v.make, model: v.model, status: o ? (o.sev === 'critical' || o.sev === 'high' ? 'incident' : 'attention') : 'ok', lat: o ? o.loc.lat : v.position.lat, lng: o ? o.loc.lng : v.position.lng, speed_mph: o ? 0 : v.position.speed_mph, openDtcs: o ? o.dtc : 0, openIncidents: o ? o.n : 0, hasCamera: v.hasCamera, driverId: v.driverId };
    }),
  };
}

module.exports = { portfolio, fleetDeepDive, fleetSummary, driverRows, OPEN };
