// Fleet analysis: pure function of (ctx, calib). No I/O. ctx = {fleet, drivers, vehicles, incidents, asOf}
const { DAY, INDICATORS, IND, MODEL, ALERT, COST, INTERVENTIONS } = require('./config');
const F = require('./features');
const M = require('./model');
const { haversineMi } = require('../util');

const { clamp, round } = M;
const iso = (ms) => new Date(ms).toISOString();
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

// ---------- indexing ----------
function buildIndex(ctx) {
  const asOf = ctx.asOf;
  const events = ctx.incidents.map(F.prepare).filter((e) => e && e.ts <= asOf).sort((a, b) => a.ts - b.ts);
  const byDriver = new Map(), byVeh = new Map();
  for (const e of events) {
    if (e.driverId && !e.maint) (byDriver.get(e.driverId) || byDriver.set(e.driverId, []).get(e.driverId)).push(e);
    if (e.vehicleId && e.maint) (byVeh.get(e.vehicleId) || byVeh.set(e.vehicleId, []).get(e.vehicleId)).push(e);
  }
  // roster; derive from incidents when the fleet has no roster (imported histories)
  const vehicles = (ctx.vehicles && ctx.vehicles.length) ? ctx.vehicles : derive(ctx.incidents, 'vehicle');
  const drivers = (ctx.drivers && ctx.drivers.length) ? ctx.drivers : derive(ctx.incidents, 'driver');
  const vehById = new Map(vehicles.map((v) => [v.id, v]));
  const dlist = drivers.map((d) => {
    const v = vehById.get(d.vehicleId) || vehicles.find((x) => x.driverId === d.id) || null;
    const evs = byDriver.get(d.id) || [];
    const cam = v ? !!v.hasCamera : evs.some((e) => e.hasCamera);
    return { d, v, evs, mEvs: v ? (byVeh.get(v.id) || []) : [], cam };
  });
  const firstTs = events.length ? events[0].ts : asOf - 30 * DAY;
  return { ctx, events, byDriver, byVeh, vehicles, drivers, dlist, firstTs };
}
function derive(incs, kind) {
  const m = new Map();
  for (const i of incs) {
    const o = i[kind]; if (!o || !o.id || m.has(o.id)) continue;
    if (kind === 'driver') m.set(o.id, { id: o.id, name: o.name || o.id, vehicleId: i.vehicle && i.vehicle.id, safetyScore: o.safetyScore });
    else m.set(o.id, { id: o.id, unit: o.unit, plate: o.plate, make: o.make, model: o.model, year: o.year, odometer_mi: o.odometer_mi, vin: o.vin, hasCamera: !!(i.camera && i.camera.aiVerdict !== 'no_video'), driverId: i.driver && i.driver.id });
  }
  return [...m.values()];
}
const spanAt = (idx, t) => clamp((t - idx.firstTs) / DAY, 7, MODEL.LOOKBACK_DAYS);

// ---------- calibration (portfolio-wide, frozen) ----------
function calibrate(indexes, asOf) {
  const sums = {}, cnt = {};
  const rawStates = [];
  for (const idx of indexes) {
    const span = spanAt(idx, asOf);
    const dummy = Object.fromEntries(INDICATORS.map((k) => [k.key, 1]));
    for (const x of idx.dlist) {
      const st = F.driverState(x.evs, x.mEvs, asOf, span, dummy);
      rawStates.push({ st, cam: x.cam });
      for (const k of INDICATORS) {
        if (k.camera && !x.cam) continue; // norm over drivers that can observe the indicator
        sums[k.key] = (sums[k.key] || 0) + st.raw[k.key]; cnt[k.key] = (cnt[k.key] || 0) + 1;
      }
    }
  }
  const norm = {};
  for (const k of INDICATORS) norm[k.key] = Math.max(1e-3, cnt[k.key] ? sums[k.key] / cnt[k.key] : k.ref);
  // floors: avoid hyper-sensitivity when a signal is nearly absent portfolio-wide
  for (const k of INDICATORS) norm[k.key] = Math.max(norm[k.key], k.ref * 0.08);
  const states = rawStates.map(({ st }) => {
    const f = {}; for (const k of INDICATORS) f[k.key] = F.toF(st.raw[k.key], norm[k.key]);
    return { ...st, f };
  });
  // re-base the reference collision probability to the portfolio's observed rate (Poisson-gamma shrinkage to a 1.2% prior)
  let C = 0, driverMonths = 0;
  for (const idx of indexes) {
    const span = spanAt(idx, asOf);
    C += idx.events.filter((e) => e.coll && e.ts > asOf - span * DAY && e.ts <= asOf).length;
    driverMonths += (idx.dlist.length * span) / 30;
  }
  const base = clamp((C + MODEL.BASE_PRIOR * MODEL.BASE_PRIOR_WEIGHT) / (driverMonths + MODEL.BASE_PRIOR_WEIGHT), 0.006, 0.015); // plausibility ceiling: the demo seed's raw collision frequency is several times industry norms
  M.setBase(base);
  const beta0 = M.solveBeta0(states);
  return { norm, beta0, base, asOf, drivers: states.length, collisions: C, createdAt: Date.now() };
}

// ---------- main ----------
function analyzeFleet(ctx, calib, opts = {}) {
  const t0 = Date.now();
  const idx = buildIndex(ctx);
  const { asOf } = ctx;
  const { norm, beta0 } = calib;
  if (calib.base) M.setBase(calib.base);
  const nDrv = idx.dlist.length, nVeh = Math.max(1, idx.vehicles.length || ctx.fleet.vehicles || 1);
  const historyDays = clamp((asOf - idx.firstTs) / DAY, 0, 1000);
  const span = spanAt(idx, asOf);

  // --- states now & 14d ago, p now
  const rows = idx.dlist.map((x) => {
    const s0 = F.driverState(x.evs, x.mEvs, asOf, span, norm);
    const s14 = F.driverState(x.evs, x.mEvs, asOf - MODEL.TREND_WINDOW * DAY, spanAt(idx, asOf - MODEL.TREND_WINDOW * DAY), norm);
    return { x, s0, s14, p0: M.prob(s0, beta0), p14: M.prob(s14, beta0) };
  });

  // --- Poisson-gamma calibration of fleet level vs observed collisions
  const collisions = idx.events.filter((e) => e.coll);
  const histWin = Math.min(MODEL.LOOKBACK_DAYS, Math.max(14, historyDays));
  const cObs = collisions.filter((e) => e.ts > asOf - histWin * DAY).length;
  const sumP0 = rows.reduce((s, r) => s + r.p0, 0);
  const cPred = sumP0 * (histWin / 30);
  const gamma = clamp((cObs + MODEL.GAMMA_PRIOR) / (cPred + MODEL.GAMMA_PRIOR), MODEL.GAMMA_MIN, MODEL.GAMMA_MAX);
  const pg = (p) => clamp(p * gamma, 0.01, 0.85);
  const fleetProb = (e) => clamp(1 - Math.exp(-e), 0.02, 0.9);

  // --- confidence
  const camCov = idx.vehicles.length ? idx.vehicles.filter((v) => v.hasCamera).length / idx.vehicles.length : (idx.events.length ? idx.events.filter((e) => e.hasCamera).length / idx.events.length : 0);
  const behEvents = idx.events.filter((e) => e.tags.length && e.ts > asOf - 90 * DAY);
  const camDrivers = Math.max(1, idx.dlist.filter((x) => x.cam).length);
  const seenKey = (k) => new Set(behEvents.filter((e) => e.tags.includes(k) && e.driverId).map((e) => e.driverId)).size / camDrivers; // share of camera drivers with >=1 such event
  const betaSum = INDICATORS.reduce((s, k) => s + k.beta, 0);
  const obsOf = {};
  for (const k of INDICATORS) obsOf[k.key] = k.camera ? camCov * Math.min(1, seenKey(k.key) / k.minShare) : 1;
  const richness = INDICATORS.reduce((s, k) => s + k.beta * obsOf[k.key], 0) / betaSum;
  const diagFree = idx.events.filter((e) => !e.maint);
  const verifiedPct = diagFree.length ? diagFree.filter((e) => e.verified).length / diagFree.length : 0;
  const volume = clamp(behEvents.length / Math.max(1, 0.9 * nDrv), 0, 1);
  const histScore = clamp(historyDays / 75, 0, 1);
  const confidence = clamp(0.40 * richness + 0.22 * histScore + 0.13 * volume + 0.25 * verifiedPct, 0.12, 0.96);

  // --- daily scan: p per driver at each day end
  const scanStartMs = Math.max(idx.firstTs + ALERT.MIN_HISTORY_DAYS * DAY, asOf - MODEL.LOOKBACK_DAYS * DAY);
  const dayTs = [];
  for (let t = asOf; t >= scanStartMs; t -= DAY) dayTs.unshift(t);
  const scan = rows.map((r) => dayTs.map((t) => { const s = F.driverState(r.x.evs, r.x.mEvs, t, spanAt(idx, t), norm); return { p: M.prob(s, beta0), esc: s.esc }; }));
  const flagged = (c) => c.p >= ALERT.P_FLAG || (c.esc >= ALERT.ESC_FLAG && c.p >= ALERT.ESC_MIN_P);
  // debounce: a driver is "flagged" only after 2 consecutive daily evaluations above threshold (cuts one-day noise)
  scan.forEach((row) => row.forEach((c, i) => { c.raw = flagged(c); c.fl = c.raw && (i === 0 || row[i - 1].raw); }));

  const flagStart = new Map();
  rows.forEach((r, ri) => {
    const row = scan[ri]; let i = row.length - 1;
    if (i < 0 || !row[i].fl) return;
    while (i > 0 && row[i - 1].fl) i--;
    flagStart.set(r.x.d.id, dayTs[i]);
  });

  // --- fleet score history
  const scoreAt = (meanP) => M.scoreFromRatio((meanP * gamma) / MODEL.BASE_P30);
  const actualSeries = dayTs.map((t, di) => ({ t, score: scoreAt(mean(rows.map((_, ri) => scan[ri][di].p))) }));
  const riskNow = scoreAt(mean(rows.map((r) => r.p0)));

  // --- projections (daily to 90d)
  const projP = []; // projP[delta-1] = per-driver p array
  const fleetPByDelta = [];
  for (let dlt = 1; dlt <= 90; dlt++) {
    const arr = rows.map((r) => M.prob(M.projectState(r.s0, r.s14, dlt), beta0));
    projP.push(arr);
    fleetPByDelta.push(mean(arr));
  }
  const expCollisionsBetween = (a, b) => { // Δ in (a, b]
    let s = 0; for (let d = a + 1; d <= b; d++) s += (fleetPByDelta[d - 1] * nDrv * gamma) / 30; return s;
  };
  const coll30 = expCollisionsBetween(0, 30), coll90 = expCollisionsBetween(0, 90);
  const proj30 = scoreAt(fleetPByDelta[29]), proj90 = scoreAt(fleetPByDelta[89]);
  const bm90 = M.bandMultiplier(coll90, confidence, 90);
  const rate90 = fleetPByDelta[89] * gamma;
  const band90d = [round(M.scoreFromRatio((rate90 * bm90.lo) / MODEL.BASE_P30), 1), round(M.scoreFromRatio((rate90 * bm90.hi) / MODEL.BASE_P30), 1)];
  const back30 = actualSeries.length > 31 ? actualSeries[actualSeries.length - 1 - 30].score : riskNow;
  const dscore = proj30 - riskNow + 0.7 * (riskNow - back30); // forward projection + 70% of the trailing 30-day change
  const direction = dscore >= 2.5 ? 'worsening' : dscore <= -2.5 ? 'improving' : 'stable';
  const dirParts = { fwd: round(proj30 - riskNow, 1), trailing30d: round(riskNow - back30, 1) };

  // --- non-collision incident expectation (behavior event rate = f * norm)
  const evRate = (states) => states.reduce((s, st) => s + INDICATORS.reduce((a, k) => a + (k.key === 'night_hours' ? 0 : F.fromF(st.f[k.key], norm[k.key])), 0), 0); // events / week
  const weeklyNow = evRate(rows.map((r) => r.s0));
  const weeklyAt = (dlt) => evRate(rows.map((r) => M.projectState(r.s0, r.s14, dlt)));
  // observed incident level (EWMA, all non-collision incidents) scaled by the projected change in indicator rates
  const dn = F.decayNorm(span);
  let baseDaily = 0;
  for (const e of idx.events) { const age = (asOf - e.ts) / DAY; if (!e.coll && age >= 0 && age <= MODEL.LOOKBACK_DAYS) baseDaily += Math.exp(-age / F.TAU); }
  baseDaily /= dn;
  const ratioAt = (dlt) => (weeklyNow > 0 ? weeklyAt(dlt) / weeklyNow : 1);
  const inc30 = baseDaily * (ratioAt(7) * 14 + ratioAt(22) * 16);
  const inc90 = baseDaily * (ratioAt(7) * 14 + ratioAt(22) * 16 + ratioAt(45) * 30 + ratioAt(75) * 30);
  const dedupe = weeklyNow > 0 ? clamp((baseDaily * 7) / weeklyNow, 0.05, 1) : 1; // an event can carry several indicator tags

  // --- vehicles
  const vehOut = vehicleRisk(idx, rows, asOf, gamma);
  const breakdown90 = vehOut.reduce((s, v) => s + v.breakdownProb30d, 0) * 3;

  // --- loss
  const collVals = collisions.filter((e) => e.cargoMid > 0).map((e) => e.cargoMid);
  const lossPerCollision = COST.collisionUsd + COST.cargoShare * (collVals.length >= 2 ? mean(collVals) : 0);
  const expectedLoss90 = coll90 * lossPerCollision + inc90 * COST.nonCollisionIncidentUsd + breakdown90 * COST.breakdownUsd;

  // --- leading indicators (fleet level)
  const sumRaw = (key, which) => rows.reduce((s, r) => s + (which === 'prev' ? r.s14 : r.s0).raw[key], 0);
  const leading = INDICATORS.map((k) => {
    const nowWk = sumRaw(k.key, 'now'), prevWk = sumRaw(k.key, 'prev');
    const per100 = (wk) => (wk * 30 / 7 / nVeh) * 100;
    const now100 = per100(nowWk), prev100 = per100(prevWk);
    const eps = 0.5;
    const trendPct = ((now100 + eps) / (prev100 + eps) - 1) * 100;
    const contrib = rows.reduce((s, r) => s + k.beta * r.s0.f[k.key], 0);
    return {
      key: k.key, label: k.label, value: round(now100, 1), unit: 'events per 100 vehicles / 30d', trendPct: round(trendPct, 0),
      direction: trendPct > 10 ? 'up' : trendPct < -10 ? 'down' : 'flat', weight: k.beta, _c: contrib,
      observable: round(obsOf[k.key], 2), source: k.camera ? 'camera' : 'telematics',
    };
  });
  const cSum = leading.reduce((s, l) => s + l._c, 0) || 1;
  leading.forEach((l) => { l.contributionToRisk = round((100 * l._c) / cSum, 1); delete l._c; });
  leading.sort((a, b) => b.contributionToRisk - a.contributionToRisk);

  // --- drivers output
  const drivers = rows.map((r, ri) => driverOut(ctx, idx, r, ri, scan, pg, projP, asOf, norm)).sort((a, b) => b.riskNow - a.riskNow || b.collisionProb30d - a.collisionProb30d);

  // --- backtest
  const backtest = runBacktest(ctx, idx, rows, scan, dayTs, (c) => c.fl, norm, asOf, scanStartMs, nVeh);

  // --- hotspots + patterns
  const hotspots = findHotspots(idx.events, asOf);
  const patterns = buildPatterns(idx.events, asOf);

  // --- interventions (standalone)
  const wctx = { dedupe, rows, gamma, beta0, norm, nDrv, lossPerCollision, fleetPByDelta, coll90, inc90, proj90, asOf, confidence, scoreAt, drivers: rows.map((r) => r.x.d) };
  const interventions = INTERVENTIONS.map((iv) => whatIf(wctx, [iv.key]).single).filter(Boolean).sort((a, b) => b.expectedSavingsUsd - a.expectedSavingsUsd);

  // --- series
  const horizon = clamp(opts.horizonDays || 90, 7, 90);
  const series = [];
  for (const a of actualSeries) series.push({ date: iso(a.t).slice(0, 10), actual: round(a.score, 1) });
  if (series.length) { const last = series[series.length - 1]; last.projected = last.actual; last.lo = last.actual; last.hi = last.actual; }
  for (let dlt = 1; dlt <= horizon; dlt++) {
    const rate = fleetPByDelta[dlt - 1] * gamma;
    const bm = M.bandMultiplier(expCollisionsBetween(0, dlt) + 0.5, confidence, dlt);
    series.push({ date: iso(asOf + dlt * DAY).slice(0, 10), projected: round(scoreAt(fleetPByDelta[dlt - 1]), 1), lo: round(M.scoreFromRatio((rate * bm.lo) / MODEL.BASE_P30), 1), hi: round(M.scoreFromRatio((rate * bm.hi) / MODEL.BASE_P30), 1) });
  }

  const recentInc = idx.events.filter((e) => e.ts > asOf - 30 * DAY && !e.maint).length;
  const modelNotes = [
    'DEMO-CALIBRATED model: transparent weighted-logistic collision-risk indicator on EWMA leading indicators; weights are hand-set, not fitted to real loss data.',
    `Fleet risk-indicator level is shrunk toward observed collisions (Poisson-gamma): gamma=${round(gamma, 2)} from ${cObs} collisions in ${round(histWin, 0)}d vs ${round(cPred, 1)} predicted.`,
    `Indicators are relative to portfolio norms (f=1 = as frequent as the average portfolio driver); camera-derived indicators are normalised only over camera-equipped vehicles.`,
    `Prediction confidence ${round(confidence, 2)} = 0.40 signal richness (${round(richness, 2)}) + 0.22 history (${round(histScore, 2)}) + 0.13 volume (${round(volume, 2)}) + 0.25 camera-verified share (${round(verifiedPct, 2)}).`,
    `Camera coverage ${Math.round(camCov * 100)}%: ${camCov < 0.6 ? 'driver-facing signals (phone, drowsiness, tailgating) are mostly unobserved here, so risk may be understated; band widened.' : 'driver-facing signals are well observed.'}`,
    `Projection extrapolates each indicator's 14-day slope with ${MODEL.PROJ_DAMP_DAYS}-day damping; bands are 80% intervals combining Poisson noise and model uncertainty.`,
    `Backtest: ${backtest.caught}/${backtest.collisions} collisions had a warning (recall ${backtest.recallPct}%); ${backtest.collisions - backtest.caught} were not predictable from available signals.`,
  ];

  return {
    fleetId: ctx.fleet.id, fleetName: ctx.fleet.name, vendor: ctx.fleet.vendor, generatedAt: iso(Date.now()), asOf: iso(asOf), horizonDays: horizon,
    risk: { current: round(riskNow, 1), projected30d: round(proj30, 1), projected90d: round(proj90, 1), band90d, direction },
    series,
    expected: { incidents30d: round(inc30, 1), collisions30d: round(coll30, 2), collisionProb30d: round(fleetProb(coll30), 3), expectedLossUsd90d: Math.round(expectedLoss90 / 100) * 100 },
    leadingIndicators: leading,
    interventions,
    hotspots, patterns, modelNotes,
    // extras used by other endpoints
    _: { drivers, vehicles: vehOut, backtest, confidence, camCov, verifiedPct, richness, gamma, vehicleCount: nVeh, driverCount: nDrv, historyDays, loss: { lossPerCollision, coll90, inc90, breakdown90 }, wctx, collisionsInWindow: cObs, recentInc, lastEventAt: idx.events.length ? iso(idx.events[idx.events.length - 1].ts) : null, dirParts, flagStart, importedOnly: idx.events.length > 0 && idx.events.every((e) => e.imported), obs: obsOf },
    computeMs: Date.now() - t0,
  };
}

// ---------- drivers ----------
function recommend(r) {
  const c = M.contributions(r.s0).filter((x) => x.key !== 'prior_collision');
  const top = c[0];
  const map = {
    following_distance: 'following_distance_alerts', phone_use: 'phone_policy', drowsiness: 'fatigue_program', speeding: 'speed_governance',
    night_hours: 'night_dispatch_limits', maintenance_backlog: 'preventive_maintenance', lane_departure: 'fatigue_program',
  };
  const key = map[top.key] || 'targeted_coaching';
  const iv = INTERVENTIONS.find((i) => i.key === key);
  return { key, text: `${iv.label}${top.key !== 'escalation' && IND[top.key] ? ` (driver's top factor: ${IND[top.key].label.toLowerCase()})` : ''}`, top: c.slice(0, 3) };
}
function driverOut(ctx, idx, r, ri, scan, pg, projP, asOf, norm) {
  const { x, s0, s14 } = r;
  const d = x.d;
  const p30 = pg(r.p0), pProj = pg(projP[29][ri]);
  const rec = recommend(r);
  const contrib = M.contributions(s0).filter((c) => IND[c.key] && c.contrib > 0.05);
  const signals = contrib.slice(0, 4).map((c) => {
    const nowWk = s0.raw[c.key], prevWk = s14.raw[c.key];
    return { key: c.key, label: c.label, value: s0.counts30[c.key] || 0, unit: 'events / 30d', trendPct: round(((nowWk + 0.1) / (prevWk + 0.1) - 1) * 100, 0), f: round(s0.f[c.key], 2) };
  });
  const coachTs = x.evs.flatMap((e) => e.coachT || []);
  const last = x.evs.length ? x.evs[x.evs.length - 1] : null;
  const lastColl = [...x.evs].reverse().find((e) => e.coll);
  const lastLoc = [...x.evs].reverse().find((e) => e.lat != null && e.lng != null);
  const dScore = M.driverScore(pg(r.p0)) - M.driverScore(pg(r.p14));
  const rel = p30 / MODEL.BASE_P30;
  return {
    driverId: d.id, name: d.name, fleetId: ctx.fleet.id, fleetName: ctx.fleet.name, vehicleId: x.v ? x.v.id : null, unit: x.v ? x.v.unit || null : null,
    riskNow: round(M.driverScore(p30), 1), riskProjected30d: round(M.driverScore(pProj), 1), collisionProb30d: round(p30, 4), relativeRisk: round(rel, 2),
    trend: dScore > 4 ? 'up' : dScore < -4 ? 'down' : 'flat', escalation: round(s0.esc, 2),
    signals, daysSinceLastCoaching: coachTs.length ? round((asOf - Math.max(...coachTs)) / DAY, 0) : null,
    recommendedIntervention: rec.text, recommendedInterventionKey: rec.key,
    lastIncidentAt: last ? iso(last.ts) : null, lat: lastLoc ? lastLoc.lat : null, lng: lastLoc ? lastLoc.lng : null, lastCollisionAt: lastColl ? iso(lastColl.ts) : null, cameraEquipped: x.cam,
    eventsLast30d: Object.values(s0.counts30).reduce((a, b) => a + b, 0),
    topFactors: rec.top.filter((c) => c.contrib > 0.05).map((c) => ({ key: c.key, label: c.label, contribution: round(c.contrib, 2) })),
    _p: p30, _score: M.driverScore(p30),
  };
}

// ---------- vehicles ----------
function vehicleRisk(idx, rows, asOf, gamma) {
  const drvRow = new Map(rows.map((r) => [r.x.d.id, r]));
  return idx.vehicles.map((v) => {
    const evs = (idx.byVeh.get(v.id) || []).filter((e) => e.ts > asOf - 90 * DAY);
    const open = evs.filter((e) => e.open);
    const crit = open.filter((e) => e.dtc && (e.dtc.maxSev >= 3 || e.dtc.drivable === 'limp' || e.dtc.drivable === 'no'));
    const codes = {}; evs.forEach((e) => (e.dtc ? e.dtc.codes : []).forEach((c) => (codes[c] = (codes[c] || 0) + 1)));
    const recurring = Object.values(codes).filter((n) => n >= 2).length;
    const ageOpen = open.length ? (asOf - Math.min(...open.map((e) => e.ts))) / DAY : 0;
    const recent30 = evs.filter((e) => e.ts > asOf - 30 * DAY).length;
    const lamp = open.some((e) => e.dtc && e.dtc.lamp);
    const heavyOdo = (v.odometer_mi || 0) > 450000;
    const z = -3.9 + 1.0 * Math.min(crit.length, 2) + 0.35 * Math.min(open.length, 4) + 0.5 * Math.min(recurring, 3) + 0.06 * Math.min(ageOpen, 20) + 0.25 * Math.min(recent30, 4) + 0.4 * lamp + 0.3 * heavyOdo;
    const bp = M.sigmoid(z);
    const r = v.driverId ? drvRow.get(v.driverId) : null;
    const cp = clamp(r ? r.p0 * gamma : MODEL.BASE_P30, 0.01, 0.85);
    const factors = [];
    if (crit.length) factors.push(`${crit.length} open high-severity fault code${crit.length > 1 ? 's' : ''}${lamp ? ' (fault lamp on)' : ''}`);
    else if (open.length) factors.push(`${open.length} open fault code${open.length > 1 ? 's' : ''}`);
    if (recurring) factors.push(`${recurring} recurring code${recurring > 1 ? 's' : ''} in 90d`);
    if (ageOpen >= 3) factors.push(`oldest open code ${round(ageOpen, 0)}d old`);
    if (recent30 >= 3) factors.push(`${recent30} diagnostic events in 30d`);
    if (heavyOdo) factors.push(`${Math.round((v.odometer_mi || 0) / 1000)}k mi odometer`);
    const lastEv = evs.length ? evs[evs.length - 1] : null;
    const topDesc = (open[0] || lastEv) && (open[0] || lastEv).dtc ? (open[0] || lastEv).dtc.desc : null;
    const ageOld = ageOpen >= 7;
    const action = crit.length ? 'Schedule service within 48h; pre-stage parts and avoid long-haul assignments until cleared.' : open.length ? (ageOld ? 'Fault code unresolved for over a week: book maintenance now.' : 'Add to next preventive-maintenance slot; monitor for escalation.') : recurring ? 'Investigate root cause of recurring fault codes.' : 'No action needed.';
    return {
      vehicleId: v.id, unit: v.unit || null, plate: v.plate || null, vin: v.vin || null, make: v.make, model: v.model, year: v.year, odometerMi: v.odometer_mi || null,
      fleetId: idx.ctx.fleet.id, fleetName: idx.ctx.fleet.name, driverId: v.driverId || null, driverName: r ? r.x.d.name : null,
      breakdownProb30d: round(bp, 3), collisionProb30d: round(cp, 4), riskNow: round(Math.max(M.scoreFromRatio(bp / 0.03), M.driverScore(cp) * 0.9), 1), band: bp >= 0.25 ? 'high' : bp >= 0.1 ? 'elevated' : 'normal',
      openDtcs: open.length, openCriticalDtcs: crit.length, recurringCodes: recurring, daysSinceFirstOpenDtc: open.length ? round(ageOpen, 1) : null, faultLampOn: lamp,
      topDtc: topDesc, topFactors: factors, recommendedAction: action, lastIncidentAt: lastEv ? iso(lastEv.ts) : null, lat: lastEv && lastEv.lat != null ? lastEv.lat : (v.position ? v.position.lat : null), lng: lastEv && lastEv.lng != null ? lastEv.lng : (v.position ? v.position.lng : null), hasCamera: !!v.hasCamera,
    };
  }).sort((a, b) => b.breakdownProb30d - a.breakdownProb30d || b.collisionProb30d - a.collisionProb30d);
}

// ---------- backtest ----------
function runBacktest(ctx, idx, rows, scan, dayTs, flagged, norm, asOf, scanStartMs, nVeh) {
  const rowIdx = new Map(rows.map((r, i) => [r.x.d.id, i]));
  const colls = idx.events.filter((e) => e.coll && e.ts >= scanStartMs && e.ts <= asOf);
  const examples = [], misses = [];
  let caught = 0; const leads = [];
  for (const c of colls) {
    const ri = c.driverId != null ? rowIdx.get(c.driverId) : undefined;
    let warnDi = -1;
    if (ri != null) {
      for (let di = 0; di < dayTs.length; di++) {
        const t = dayTs[di];
        if (t > c.ts - 0.5 * DAY) break;
        if (t < c.ts - ALERT.LEAD_WINDOW_DAYS * DAY) continue;
        if (flagged(scan[ri][di])) { warnDi = di; break; }
      }
    }
    if (warnDi >= 0) {
      caught++;
      const lead = (c.ts - dayTs[warnDi]) / DAY; leads.push(lead);
      const x = rows[ri].x;
      const st = F.driverState(x.evs, x.mEvs, dayTs[warnDi], spanAt(idx, dayTs[warnDi]), norm);
      const sig = M.contributions(st).filter((s) => s.contrib > 0.15).slice(0, 4).map((s) => s.label + ` (${round(s.contrib, 1)})`);
      examples.push({ incidentId: c.id, driverName: c.driverName || x.d.name, fleetId: ctx.fleet.id, warningAt: iso(dayTs[warnDi]), incidentAt: iso(c.ts), leadDays: round(lead, 1), caught: true, signals: sig });
    } else {
      let reason = 'Driver could not be matched to history';
      if (ri != null) {
        const x = rows[ri].x;
        const prior = x.evs.filter((e) => e.ts < c.ts && e.ts > c.ts - 30 * DAY && e.tags.length);
        reason = prior.length === 0 ? 'No precursor behavior events in the prior 30 days (not predictable from available signals)' : `Precursor signals present (${prior.length} events) but below alert threshold`;
        if (!x.cam) reason += '; driver vehicle has no camera, so driver-facing signals were unobserved';
      }
      misses.push({ incidentId: c.id, driverName: c.driverName || null, fleetId: ctx.fleet.id, warningAt: null, incidentAt: iso(c.ts), leadDays: null, caught: false, missReason: reason, signals: [] });
    }
  }
  // episodes -> false alerts
  const judgeBefore = asOf - (dayTs.length * 1 >= 60 ? 30 : 14) * DAY;
  let episodes = 0, falseEps = 0, trueEps = 0;
  rows.forEach((r, ri) => {
    let last = -1e18, prevF = false;
    scan[ri].forEach((c, di) => {
      const f = flagged(c);
      if (f && (!prevF || dayTs[di] - last >= ALERT.COOLDOWN_DAYS * DAY) && dayTs[di] - last >= ALERT.COOLDOWN_DAYS * DAY) {
        last = dayTs[di];
        if (dayTs[di] <= judgeBefore) {
          episodes++;
          const hit = r.x.evs.some((e) => e.coll && e.ts > dayTs[di] && e.ts <= dayTs[di] + 30 * DAY);
          if (hit) trueEps++; else falseEps++;
        }
      }
      prevF = f;
    });
  });
  const judgedDays = Math.max(1, (judgeBefore - scanStartMs) / DAY);
  const recall = colls.length ? caught / colls.length : null;
  examples.sort((a, b) => b.leadDays - a.leadDays);
  return {
    fleetId: ctx.fleet.id, window: { from: iso(scanStartMs).slice(0, 10), to: iso(asOf).slice(0, 10), days: Math.round((asOf - scanStartMs) / DAY) },
    collisions: colls.length, caught, leadDaysAll: leads.map((l) => round(l, 1)), recallPct: recall == null ? null : round(recall * 100, 0), medianLeadDays: median(leads) == null ? null : round(median(leads), 1),
    falseAlertsPer100Veh: round((falseEps / nVeh) * 100, 1), falseAlertsPer100VehPer30d: round(((falseEps / nVeh) * 100 * 30) / judgedDays, 1),
    alertEpisodes: episodes, precisionPct: episodes ? round((trueEps / episodes) * 100, 0) : null,
    examples: [...examples.slice(0, 8), ...misses.slice(0, 5)],
    limitations: [
      'Walk-forward replay: each day uses only events before that day; alert thresholds and portfolio norms are fixed constants, but they were tuned on this same demo data (in-sample).',
      `A collision counts as "caught" if its driver was flagged at least 12h and at most ${ALERT.LEAD_WINDOW_DAYS} days beforehand; flagged = 30-day modeled collision-risk indicator (illustrative) >= ${round(ALERT.P_FLAG * 100, 1)}% (${ALERT.FLAG_MULT}x the portfolio-average driver) or sharp escalation.`,
      'Collisions with no precursor behavior (random, other-party fault, mechanical) cannot be predicted and are reported as misses.',
      'False alerts = flag episodes (14-day cooldown) with no collision by that driver in the next 30 days; recent episodes still inside the 30-day window are excluded from the count.',
      'Small samples: with few collisions the recall figure has a wide confidence interval; treat as indicative, not guaranteed; synthetic data, not validated.',
    ],
  };
}

// ---------- hotspots ----------
function findHotspots(events, asOf) {
  const W = { collision: 5, rollover: 5, harsh_brake: 1.2, harsh_turn: 1, harsh_accel: 0.8, following_distance: 1.2, distracted: 1.2, speeding: 0.8 };
  const pts = events.filter((e) => e.lat != null && e.lng != null && e.ts > asOf - 60 * DAY && W[e.type] != null)
    .map((e) => ({ e, w: W[e.type] * Math.exp(-((asOf - e.ts) / DAY) / 40) }));
  const used = new Set(); const out = [];
  const RADIUS = 6;
  const cells = new Map();
  pts.forEach((p, i) => { const k = `${Math.round(p.e.lat / 0.1)}:${Math.round(p.e.lng / 0.1)}`; (cells.get(k) || cells.set(k, []).get(k)).push(i); });
  const order = [...cells.values()].sort((a, b) => b.reduce((s, i) => s + pts[i].w, 0) - a.reduce((s, i) => s + pts[i].w, 0));
  for (const c of order) {
    const seeds = c.filter((i) => !used.has(i)); if (!seeds.length) continue;
    let lat = mean(seeds.map((i) => pts[i].e.lat)), lng = mean(seeds.map((i) => pts[i].e.lng));
    const mem = pts.map((p, i) => i).filter((i) => !used.has(i) && haversineMi(lat, lng, pts[i].e.lat, pts[i].e.lng) <= RADIUS);
    if (mem.length < 3) continue;
    mem.forEach((i) => used.add(i));
    const wsum = mem.reduce((s, i) => s + pts[i].w, 0);
    lat = mem.reduce((s, i) => s + pts[i].e.lat * pts[i].w, 0) / wsum; lng = mem.reduce((s, i) => s + pts[i].e.lng * pts[i].w, 0) / wsum;
    const types = {}; mem.forEach((i) => (types[pts[i].e.type] = (types[pts[i].e.type] || 0) + 1));
    const top = Object.entries(types).sort((a, b) => b[1] - a[1])[0][0];
    const roads = {}; mem.forEach((i) => { const r = pts[i].e.road; if (r) roads[r] = (roads[r] || 0) + 1; });
    const road = (Object.entries(roads).sort((a, b) => b[1] - a[1])[0] || [null])[0];
    const near = mem.map((i) => pts[i].e).filter((e) => e.address).sort((a, b) => haversineMi(lat, lng, a.lat, a.lng) - haversineMi(lat, lng, b.lat, b.lng))[0];
    const recent = mem.filter((i) => pts[i].e.ts > asOf - 14 * DAY).length;
    const prior = mem.length - recent;
    const priorPer14 = prior / ((60 - 14) / 14);
    out.push({ lat: round(lat, 4), lng: round(lng, 4), label: near ? near.address : road || 'Cluster', riskScore: 0, incidents: mem.length, collisions: mem.filter((i) => pts[i].e.coll).length, topEventType: top, recentIncidents14d: recent, forming: recent >= 3 && recent >= 2 * Math.max(priorPer14, 0.5), _w: wsum, id: `hs_${Math.round(lat * 100)}_${Math.round(Math.abs(lng) * 100)}` });
    if (out.length >= 12) break;
  }
  const mx = Math.max(1, ...out.map((o) => o._w));
  out.forEach((o) => { o.riskScore = round(100 * Math.sqrt(o._w / mx) * Math.min(1, 0.35 + o.incidents / 8), 0); delete o._w; });
  return out.sort((a, b) => b.riskScore - a.riskScore).slice(0, 8);
}

// ---------- patterns ----------
function buildPatterns(events, asOf) {
  const byHour = new Array(24).fill(0), byDow = new Array(7).fill(0);
  for (const e of events) {
    if (e.maint || e.ts < asOf - 90 * DAY) continue;
    const w = e.coll ? 5 : e.sevRank >= 3 ? 2 : 1;
    byHour[e.hour] += w; byDow[e.dow] += w;
  }
  const r1 = (a) => a.map((x) => round(x, 1));
  const norm = (a) => { const m = mean(a) || 1; return a.map((x) => round(x / m, 2)); };
  const top = (a, n, lab) => a.map((v, i) => [v, i]).sort((x, y) => y[0] - x[0]).slice(0, n).map((x) => lab(x[1]));
  return {
    byHour: r1(byHour), byDow: r1(byDow), byHourIndex: norm(byHour), byDowIndex: norm(byDow),
    peakHours: top(byHour, 3, (h) => `${String(h).padStart(2, '0')}:00`), peakDays: top(byDow, 2, (d) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d]),
    basis: 'risk-weighted event counts, 90d, local time (UTC-5); collisions x5, high-severity x2, other x1; dow 0=Sunday',
  };
}

// ---------- what-if ----------
const QUAD = [[7, 14], [22, 16], [45, 30], [75, 30]];
function targetSet(iv, rows, wc) {
  const n = rows.length;
  const idxs = rows.map((_, i) => i);
  if (iv.target === 'all') return idxs;
  if (iv.target === 'top_drivers') { const k = Math.max(3, Math.ceil(n * (iv.topN || 0.1))); return idxs.sort((a, b) => rows[b].p0 - rows[a].p0).slice(0, k); }
  if (iv.target.startsWith('indicator:')) { const key = iv.target.slice(10); return idxs.filter((i) => rows[i].s0.f[key] >= 0.8 || rows[i].s14.f[key] >= 1.2); }
  if (iv.target === 'vehicles_with_dtc') return idxs.filter((i) => rows[i].s0.f.maintenance_backlog >= 0.5);
  return idxs;
}
// effect of one intervention on a single driver's 30d collision probability
function driverImpact(wc, driverId, key) {
  const iv = INTERVENTIONS.find((i) => i.key === key); const ri = wc.rows.findIndex((r) => r.x.d.id === driverId);
  if (!iv || ri < 0) return null;
  const r = wc.rows[ri];
  const before = Math.min(MODEL.P_HARD, M.prob(r.s0, wc.beta0) * wc.gamma);
  const after = Math.min(MODEL.P_HARD, M.prob(M.applyEffects(r.s0, iv.effects), wc.beta0) * wc.gamma);
  return { before, after, reductionPct: before > 0 ? (1 - after / before) * 100 : 0, avoidedLossUsd90d: (before - after) * 3 * wc.lossPerCollision, intervention: iv };
}
function whatIf(wc, keys) {
  const { rows, gamma, beta0, lossPerCollision } = wc;
  const ivs = keys.map((k) => INTERVENTIONS.find((i) => i.key === k)).filter(Boolean);
  if (!ivs.length) return { single: null };
  const targets = ivs.map((iv) => new Set(targetSet(iv, rows, wc)));
  const collisions = (applied) => {
    let c = 0, ev = 0, evUsd = 0;
    for (const [dlt, w] of QUAD) {
      const ramp = applied ? Math.min(1, dlt / 30) : 0;
      for (let ri = 0; ri < rows.length; ri++) {
        let st = M.projectState(rows[ri].s0, rows[ri].s14, dlt);
        if (applied) ivs.forEach((iv, j) => { if (targets[j].has(ri)) { const eff = {}; for (const [k, e] of Object.entries(iv.effects)) eff[k] = e * ramp; st = M.applyEffects(st, eff); } });
        c += (Math.min(MODEL.P_HARD, M.prob(st, beta0) * gamma) * w) / 30;
        for (const k of INDICATORS) {
          if (k.key === 'night_hours') continue;
          const n = (F.fromF(st.f[k.key], wc.norm[k.key]) * w * wc.dedupe) / 7;
          ev += n; evUsd += n * (k.key === 'maintenance_backlog' ? COST.maintenanceEventUsd : COST.nonCollisionIncidentUsd);
        }
      }
    }
    return { c, ev, evUsd };
  };
  const base = collisions(false), after = collisions(true);
  const avoidedColl = Math.max(0, base.c - after.c), avoidedEv = Math.max(0, base.ev - after.ev);
  const savings = avoidedColl * lossPerCollision + Math.max(0, base.evUsd - after.evUsd);
  const allTargets = new Set(); targets.forEach((s) => s.forEach((i) => allTargets.add(i)));
  const programCost = [...targets.reduce((acc, s, j) => { s.forEach((i) => acc.add(i)); return acc; }, new Set())].length * ivs.reduce((s, iv) => s + iv.costPerDriverUsd, 0) / Math.max(1, 1);
  const tgtDrivers = [...allTargets].map((i) => rows[i].x.d.id);
  // projected 90d score with full effect
  const pAfter90 = mean(rows.map((r, ri) => { let st = M.projectState(r.s0, r.s14, 90); ivs.forEach((iv, j) => { if (targets[j].has(ri)) st = M.applyEffects(st, iv.effects); }); return Math.min(MODEL.P_HARD, M.prob(st, beta0) * gamma); }));
  const pBase90 = mean(rows.map((r) => Math.min(MODEL.P_HARD, M.prob(M.projectState(r.s0, r.s14, 90), beta0) * gamma)));
  const red = base.c > 0 ? (avoidedColl / base.c) * 100 : 0;
  const series = [];
  for (let dlt = 0; dlt <= 90; dlt += 10) {
    const ramp = Math.min(1, dlt / 30); const d2 = Math.max(dlt, 0.0001);
    const pa = mean(rows.map((r, ri) => { let st = M.projectState(r.s0, r.s14, d2); ivs.forEach((iv, j) => { if (targets[j].has(ri)) { const eff = {}; for (const [k, e] of Object.entries(iv.effects)) eff[k] = e * ramp; st = M.applyEffects(st, eff); } }); return Math.min(MODEL.P_HARD, M.prob(st, beta0) * gamma); }));
    const pb = mean(rows.map((r) => Math.min(MODEL.P_HARD, M.prob(M.projectState(r.s0, r.s14, d2), beta0) * gamma)));
    series.push({ day: dlt, baseline: round(wc.scoreAt(pb / gamma), 1), withInterventions: round(wc.scoreAt(pa / gamma), 1) });
  }
  const single = ivs.length === 1 ? {
    key: ivs[0].key, label: ivs[0].label, expectedRiskReductionPct: round(red, 1), expectedAvoidedIncidents90d: round(avoidedEv + avoidedColl, 1), expectedAvoidedCollisions90d: round(avoidedColl, 2),
    expectedSavingsUsd: Math.round(savings / 100) * 100, programCostUsd: Math.round(programCost), netBenefitUsd: Math.round((savings - programCost) / 100) * 100, targets: tgtDrivers.slice(0, 40), targetCount: tgtDrivers.length, assumption: ivs[0].assumption,
  } : null;
  return {
    single,
    baseline: { collisions90d: round(base.c, 2), incidents90d: round(base.ev, 1), riskProjected90d: round(wc.scoreAt(pBase90 / gamma), 1), expectedLossUsd90d: Math.round((base.c * lossPerCollision + base.evUsd) / 100) * 100 },
    projected: { collisions90d: round(after.c, 2), incidents90d: round(after.ev, 1), riskProjected90d: round(wc.scoreAt(pAfter90 / gamma), 1), expectedLossUsd90d: Math.round((after.c * lossPerCollision + after.evUsd) / 100) * 100 },
    series, riskReductionPct: round(red, 1), avoidedCollisions90d: round(avoidedColl, 2), avoidedIncidents90d: round(avoidedEv + avoidedColl, 1), savingsUsd: Math.round(savings / 100) * 100, programCostUsd: Math.round(programCost), netBenefitUsd: Math.round((savings - programCost) / 100) * 100, targets: tgtDrivers, targetCount: tgtDrivers.length,
  };
}

module.exports = { analyzeFleet, calibrate, buildIndex, whatIf, driverImpact, spanAt };
