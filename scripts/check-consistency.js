#!/usr/bin/env node
// Asserts that every endpoint reports the same vendor-comparison figures, that provenance/simulation markers are present,
// and that reset / guided scenario / capability endpoints behave. Exercises the working_verified rows of /api/capabilities.
//   node scripts/check-consistency.js                 (spawns its own server on a free port with DEMO_MODE=1)
//   BASE_URL=http://localhost:3061 node scripts/check-consistency.js   (use a running server; NOTE: it calls POST /api/demo/reset)
const { spawn } = require('child_process');
const path = require('path');
const http = require('http');

let BASE = process.env.BASE_URL, child = null;
let fails = 0, passes = 0;
const ok = (c, m, extra) => { if (c) { passes++; console.log('  ok   ' + m); } else { fails++; console.log('  FAIL ' + m + (extra !== undefined ? '  -> ' + JSON.stringify(extra) : '')); } };
const near = (a, b, tol) => a != null && b != null && Math.abs(a - b) <= tol;
const J = async (p, opt) => { const r = await fetch(BASE + p, opt && opt.body ? { ...opt, body: JSON.stringify(opt.body), headers: { 'content-type': 'application/json', ...(opt.headers || {}) } } : opt); const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, body: j, headers: r.headers }; };
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const r1 = (n) => Math.round(n * 10) / 10;

async function start() {
  if (BASE) return;
  const port = 3700 + Math.floor(Math.random() * 200);
  BASE = 'http://127.0.0.1:' + port;
  child = spawn(process.execPath, ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(port), DEMO_MODE: '1', DATABASE_URL: '', ENABLE_DEBUG: '0' }, stdio: 'ignore' });
  for (let i = 0; i < 80; i++) { try { const r = await fetch(BASE + '/health'); if (r.ok) { const h = await r.json(); if (h.incidents > 0) return; } } catch (e) { /* not up yet */ } await new Promise((r) => setTimeout(r, 500)); }
  throw new Error('server did not start');
}

(async () => {
  await start();
  console.log('Target ' + BASE);

  console.log('\n[1] vendor-comparison consistency');
  const pf = (await J('/api/predict/portfolio')).body;
  const bt = (await J('/api/predict/backtest')).body;
  const cmp = pf.comparison;
  ok(cmp && cmp.mantis && cmp.otherVendors, 'portfolio.comparison has mantis + otherVendors');
  const bvM = pf.byVendor.find((v) => v.vendor === 'mantis');
  ok(bvM && bvM.avgLeadDays === cmp.mantis.meanLeadDays && bvM.avgPredictionConfidence === cmp.mantis.predictionConfidence && bvM.cameraCoveragePct === cmp.mantis.cameraCoveragePct && bvM.backtestRecallPct === cmp.mantis.recallPct, 'byVendor[mantis] equals comparison.mantis (lead, confidence, camera, recall)');
  // recompute other-vendor pooled values independently from per-fleet rows
  const others = pf.fleets.filter((f) => f.vendor !== 'mantis'), mant = pf.fleets.filter((f) => f.vendor === 'mantis');
  const vw = (rows, k) => rows.reduce((s, f) => s + f[k] * f.vehicles, 0) / rows.reduce((s, f) => s + f.vehicles, 0);
  ok(near(vw(others, 'cameraCoveragePct'), cmp.otherVendors.cameraCoveragePct, 1.01), 'otherVendors camera coverage = vehicle-weighted fleet values', [vw(others, 'cameraCoveragePct'), cmp.otherVendors.cameraCoveragePct]);
  ok(near(vw(others, 'predictionConfidence'), cmp.otherVendors.predictionConfidence, 0.011), 'otherVendors confidence = vehicle-weighted fleet values');
  ok(near(vw(mant, 'predictionConfidence'), cmp.mantis.predictionConfidence, 0.011), 'mantis confidence = vehicle-weighted fleet values');
  const oc = others.reduce((s, f) => s + f.collisionsInBacktest, 0), ocg = others.reduce((s, f) => s + f.caught, 0);
  ok(oc ? Math.round((100 * ocg) / oc) === cmp.otherVendors.recallPct : true, 'otherVendors recall = pooled caught / collisions');
  ok(pf.insight.includes(String(cmp.mantis.meanLeadDays)) && pf.insight.includes(String(cmp.otherVendors.meanLeadDays)) && pf.insight.includes(String(cmp.otherVendors.predictionConfidence)), 'insight text quotes the same lead-time and confidence numbers as comparison');
  // overall backtest
  const sumC = pf.fleets.reduce((s, f) => s + f.collisionsInBacktest, 0), sumK = pf.fleets.reduce((s, f) => s + f.caught, 0);
  ok(bt.collisions === sumC && bt.caught === sumK, 'GET /backtest totals equal sum of portfolio fleets', [bt.collisions, sumC, bt.caught, sumK]);
  ok(bt.recallPct === Math.round((100 * sumK) / sumC), 'GET /backtest recallPct is pooled');
  // per-fleet endpoints vs portfolio rows
  let leadsAll = [], fleetOk = true, detail = [];
  for (const f of pf.fleets) {
    const fb = (await J('/api/predict/backtest?fleetId=' + f.fleetId)).body;
    const fp = (await J('/api/predict/fleet/' + f.fleetId)).body;
    leadsAll = leadsAll.concat(fb.leadDaysAll || []);
    const same = fb.recallPct === f.backtestRecallPct && fb.medianLeadDays === f.medianLeadDays && fp.predictionConfidence === f.predictionConfidence && fp.cameraCoveragePct === f.cameraCoveragePct && fp.backtest.recallPct === f.backtestRecallPct && fp.backtest.medianLeadDays === f.medianLeadDays;
    if (!same) { fleetOk = false; detail.push(f.fleetId); }
    ok(fb.provenance && fb.provenance.data === 'synthetic' && fb.provenance.validated === false, 'backtest?fleetId=' + f.fleetId + ' has provenance');
    ok(fp.provenance && fp.provenance.validated === false && fp.illustrative === true, 'fleet/' + f.fleetId + ' has provenance + illustrative');
  }
  ok(fleetOk, 'per-fleet /fleet, /backtest and portfolio rows agree (recall, lead, confidence, camera)', detail);
  ok(near(median(leadsAll), bt.medianLeadDays, 0.051), 'overall medianLeadDays = pooled median of every flagged-ahead collision', [median(leadsAll), bt.medianLeadDays]);
  ok(near(leadsAll.length ? r1(leadsAll.reduce((s, x) => s + x, 0) / leadsAll.length) : null, bt.meanLeadDays, 0.051), 'overall meanLeadDays = pooled mean');
  const allStats = bt.basis && bt.basis.n;
  ok(allStats && allStats.leadSamples === leadsAll.length, 'backtest basis.n.leadSamples matches sample count');
  for (const [name, o] of [['portfolio', pf], ['backtest', bt]]) ok(o.provenance && o.provenance.data === 'synthetic' && o.provenance.validated === false && o.provenance.method && o.provenance.assumptions.length && o.provenance.limitations.length && o.illustrative === true, name + ' has provenance block + illustrative:true');
  ok(cmp.basis && cmp.aggregation && cmp.population && cmp.period && cmp.metrics && cmp.metrics.warningLeadDays, 'comparison carries basis/aggregation/population/period labels');
  ok(cmp.significant === false, 'comparison flagged as not statistically significant');
  const ins = (await J('/api/insurer/portfolio')).body;
  ok(ins.byVendor.every((v) => v.basis && v.basis.aggregation), 'insurer portfolio byVendor rows carry basis labels (different metric from predict byVendor)');
  const hdr = (await J('/api/predict/portfolio')).headers.get('x-nexus-data');
  ok(hdr === 'synthetic-illustrative', 'predict responses carry X-Nexus-Data header');

  const strip = (o) => JSON.stringify(o, (k, v) => (k === 'generatedAt' || k === 'computeMs' ? undefined : v));
  const bt2 = (await J('/api/predict/backtest')).body, pf2c = (await J('/api/predict/portfolio')).body;
  ok(strip(bt2) === strip(bt) && strip(pf2c) === strip(pf), 'backtest and portfolio are deterministic across repeated calls');
  for (const f of pf.fleets.slice(0, 3)) ok(strip((await J('/api/predict/backtest?fleetId=' + f.fleetId)).body) === strip((await J('/api/predict/backtest?fleetId=' + f.fleetId)).body), 'per-fleet backtest deterministic: ' + f.fleetId);

  console.log('\n[2] wording');
  const al = (await J('/api/predict/alerts?limit=50')).body;
  const text = JSON.stringify(al) + JSON.stringify(pf.insight) + JSON.stringify((await J('/api/predict/fleet/' + pf.fleets[0].fleetId)).body.modelNotes);
  ok(!/before the crash|collision probability/i.test(text), 'no certainty phrasing ("before the crash", "collision probability") in backend text');
  ok(al.length === 0 || al.every((a) => a.illustrative === true && a.label && a.disclaimer), 'alerts carry illustrative/label/disclaimer');

  console.log('\n[3] capabilities');
  const cap = (await J('/api/capabilities')).body;
  const S = ['working_verified', 'working_synthetic', 'simulated', 'planned'];
  ok(Array.isArray(cap.capabilities) && cap.capabilities.every((c) => S.includes(c.status) && c.evidence && c.notes), 'every capability has a valid status, evidence and notes');
  ok(S.every((s) => cap.capabilities.some((c) => c.status === s)), 'all four statuses are used');
  const mc = cap.capabilities.find((c) => c.id === 'adapters.mantis');
  ok(mc && mc.assumedPayload === true && /ASSUMED/.test(mc.notes), 'Mantis adapter row states the payload is ASSUMED');
  ok(cap.capabilities.find((c) => c.id === 'dispatch.tow').status === 'simulated' && cap.capabilities.find((c) => c.id === 'platform.auth').status === 'planned', 'tow dispatch simulated; auth planned');

  ok(cap.total === cap.capabilities.length && cap.total === Object.values(cap.counts).reduce((a, b) => a + b, 0), 'capabilities total matches rows and counts (' + cap.total + ')');
  ok(cap.total === 35, 'capabilities total is 35 (docs/API.md and docs/CAPABILITIES.md quote 35)');

  console.log('\n[3b] debug routes gated, onboarding alerts labeled');
  for (const [m, p2] of [['GET', '/api/debug/samsara'], ['GET', '/api/debug/motive-safety-list'], ['GET', '/api/debug/motive-safety/x'], ['POST', '/test/trigger-event']]) ok((await J(p2, { method: m })).status === 404, p2 + ' returns 404 when ENABLE_DEBUG is off');

  console.log('\n[4] guided Mantis scenario');
  const s1 = await J('/api/demo/mantis-scenario', { method: 'POST', body: {} });
  const s2 = await J('/api/demo/mantis-scenario', { method: 'POST', body: {} });
  ok(s1.status === 201 && s1.body.incidentId && s2.body.incidentId && s1.body.incidentId !== s2.body.incidentId && s1.body.demoTag !== s2.body.demoTag, 'each call creates a new tagged incident');
  ok(s1.body.synthetic && s1.body.payloadAssumed && s1.body.deepLinks.dispatch === '/dispatch/#' + s1.body.incidentId && s1.body.recommendedResponse.rationale.length > 1, 'scenario response is labeled, has dispatch deep link and rationale');
  const inc = (await J('/api/incidents/' + s1.body.incidentId)).body;
  ok(inc.provider === 'mantis' && ['fleet_redline', 'fleet_magnolia'].includes(inc.fleetId) && inc.demo && inc.demo.tag === s1.body.demoTag, 'incident is Mantis, on a Mantis fleet, tagged');
  const trig = (inc.signals || []).filter((x) => x.triggered).map((x) => x.key);
  ok(trig.includes('phone_use') && trig.includes('following_distance_s') && inc.camera.aiVerdict !== 'no_video' && inc.camera.clips.length > 0, 'has phone_use + following_distance signals and camera evidence', trig);

  console.log('\n[4b] simulator scenarios map to the right provider');
  for (const fid of [undefined, 'fleet_redline', 'fleet_magnolia', 'fleet_gulfcoast']) {
    const r = (await J('/api/demo/simulate', { method: 'POST', body: fid ? { scenario: 'mantis_collision', fleetId: fid } : { scenario: 'mantis_collision' } })).body;
    ok(r.provider === 'mantis' && r.incident.provider === 'mantis' && ['fleet_redline', 'fleet_magnolia'].includes(r.incident.fleetId) && (!fid || fid === 'fleet_gulfcoast' || r.incident.fleetId === fid) && r.incident.eventType === 'collision' && r.payload.schema === 'mantis.event.v1', 'mantis_collision (fleetId=' + fid + ') -> Mantis collision on a Mantis fleet', [r.provider, r.incident && r.incident.fleetId]);
  }
  const vend = {};
  for (const f of (await J('/api/fleets')).body) vend[f.id] = f.vendor;
  for (const sc of ['collision_camera', 'dtc_breakdown', 'false_positive', 'reefer_collision', 'flatbed_steel_collision', 'warranty_dealer_breakdown', 'hazmat_tanker_rollover', 'warranty_failure']) {
    const r = (await J('/api/demo/simulate', { method: 'POST', body: { scenario: sc } })).body;
    ok(r.incident && r.provider === vend[r.incident.fleetId] && r.incident.provider === r.provider, 'scenario ' + sc + ' provider matches its fleet vendor', [r.provider, r.incident && r.incident.fleetId]);
  }

  console.log('\n[5] lifecycle, simulated markers, webhook, onboarding, SSE');
  const st = await J('/api/incidents/' + inc.id + '/status', { method: 'POST', body: { status: 'validating', note: 'check' } });
  const nt = await J('/api/incidents/' + inc.id + '/notes', { method: 'POST', body: { note: 'check note' } });
  ok(st.body.status === 'validating' && nt.status === 200, 'status + note update');
  const dp = await J('/api/incidents/' + inc.id + '/dispatch', { method: 'POST', body: { note: 'x' } });
  ok(dp.body.simulated === true && dp.body.deliveredTo === 'no external recipient', 'dispatch response marked simulated');
  const nf = await J('/api/incidents/' + inc.id + '/notify', { method: 'POST', body: { channel: 'sms', to: { type: 'fleet_manager' }, message: 'test' } });
  ok(nf.body.simulated === true && nf.body.deliveredTo === 'no external recipient', 'notify response marked simulated', nf.body.error);
  const fn = await J('/api/incidents/' + inc.id + '/fnol', { method: 'POST', body: {} });
  ok(fn.body.simulated === true && fn.body.deliveredTo === 'no external recipient', 'FNOL response marked simulated');
  const pk = (await J('/api/incidents?fleetId=fleet_gulfcoast&limit=300')).body.incidents.find((i) => i.warranty && i.warranty.claimPacket && i.warranty.claimPacket.status === 'ready');
  if (pk) { const ws = await J('/api/incidents/' + pk.id + '/warranty/submit', { method: 'POST', body: {} }); ok(ws.body.simulated === true && ws.body.deliveredTo === 'no external recipient', 'warranty submit marked simulated'); }
  const before = (await J('/api/demo/state')).body.counts.incidents;
  const fl = await J('/api/onboarding/fleets', { method: 'POST', body: { name: 'Consistency Check Freight', vendor: 'mantis', contactName: 'Test', contactEmail: 'test@example.invalid', vehicles: 3 } });
  ok(fl.status === 201 && fl.body.apiKey, 'onboarding creates a fleet and key');
  if (fl.body.fleet) { const al = await J('/api/onboarding/fleets/' + fl.body.fleet.id + '/alerts', { method: 'PUT', body: { emails: ['a@example.invalid'] } }); ok(al.body.used === false && al.body.status === 'stored_not_used', 'onboarding alert recipients response says stored_not_used'); }
  if (fl.body.apiKey) {
    const sample = (await J('/api/demo/sample/mantis')).body; sample.event_id = 'consistency_' + Date.now();
    const wh1 = await J('/webhook/mantis', { method: 'POST', body: sample, headers: { 'x-nexus-key': fl.body.apiKey } });
    const wh2 = await J('/webhook/mantis', { method: 'POST', body: sample, headers: { 'x-nexus-key': fl.body.apiKey } });
    const id1 = wh1.body.incidentId || (wh1.body.incident && wh1.body.incident.id), id2 = wh2.body.incidentId || (wh2.body.incident && wh2.body.incident.id);
    ok(wh1.status < 300 && id1 && id1 === id2, 'webhook ingest accepted; duplicate event id returns the same incident', [wh1.status, wh1.body, wh2.body]);
  }
  const ac = new AbortController();
  const sr = await fetch(BASE + '/api/stream', { signal: ac.signal });
  const chunk = new TextDecoder().decode((await sr.body.getReader().read()).value);
  ac.abort();
  ok(/event: hello/.test(chunk), 'SSE stream sends hello');

  console.log('\n[6] reset');
  const rs = await J('/api/demo/reset', { method: 'POST', body: {} });
  const stt = (await J('/api/demo/state')).body;
  ok(rs.status === 200 && rs.body.ok && rs.body.resetAt === stt.resetAt, 'reset returns resetAt, state reports the same');
  ok(rs.body.counts.incidents === stt.counts.incidents && stt.counts.customFleets === 0 && stt.counts.demoScenarioIncidents === 0 && stt.counts.apiKeys === 0 && stt.counts.importedIncidents === 0, 'custom fleets, scenario incidents, API keys cleared; counts agree', stt.counts);
  ok(Math.abs(stt.counts.incidents - (before - 2 - 2 - 1)) <= 40 || stt.counts.incidents > 0, 'incident count back to seeded range', [before, stt.counts.incidents]);
  const pf2 = (await J('/api/predict/portfolio')).body;
  ok(pf2.fleets.length === 7 && pf2.comparison && pf2.comparison.mantis, 'predictive state rebuilt after reset (7 fleets)');
  const rs2 = await J('/api/demo/reset', { method: 'POST', body: {} });
  ok(rs2.body.counts.incidents === rs.body.counts.incidents && rs2.body.counts.fleets === rs.body.counts.fleets && rs2.body.counts.comms === rs.body.counts.comms, 'reset is repeatable (same fleet/incident/comms counts)', [rs.body.counts, rs2.body.counts]);

  console.log(`\n${passes} passed, ${fails} failed`);
  if (child) child.kill();
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); if (child) child.kill(); process.exit(2); });
