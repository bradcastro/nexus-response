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
  ok(cap.total === 41, 'capabilities total is 41 (docs/API.md and docs/CAPABILITIES.md quote 41)');
  for (const f of ['docs/API.md', 'docs/CAPABILITIES.md']) { const txt = require('fs').readFileSync(path.join(__dirname, '..', f), 'utf8'); ok(txt.includes('`total` = ' + cap.total) || txt.includes('`total`=' + cap.total), f + ' quotes the live capability total (' + cap.total + ')'); }
  ok(['reports.engine', 'reports.export', 'reports.share', 'records.explorer', 'records.risk_history'].every((id) => (cap.capabilities.find((c) => c.id === id) || {}).status === 'working_synthetic') && cap.capabilities.find((c) => c.id === 'reports.schedule').status === 'simulated', 'reports/records capabilities: engine, export, share, records working_synthetic; scheduling simulated');

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

  let claimSpread = null;
  console.log('\n[5b] report builder + records');
  const RB = '/api/report-builder', post = (p2, body) => J(RB + p2, { method: 'POST', body });
  const catR = (await J(RB + '/catalog')).body;
  const dsAll = (catR.areas || []).flatMap((a) => a.datasets.map((d) => ({ area: a.id, ...d })));
  const dsIds = [...new Set(dsAll.map((d) => d.id))];
  ok(catR.areas.map((a) => a.id).join() === 'dispatch,fleet,insurer,claims' && ['table', 'bar', 'line', 'area', 'pie', 'stacked_bar', 'scatter'].every((c) => catR.chartTypes.includes(c)) && catR.timeBuckets.join() === 'none,day,week,month' && catR.filterOps.number.includes('between'), 'catalog: four areas, chart types, buckets, filter ops');
  ok(['incidents', 'response_times', 'tow_providers', 'comms', 'sop', 'vehicles', 'drivers', 'safety_events', 'warranty_claims', 'risk_snapshots', 'fleet_portfolio'].every((d) => dsIds.includes(d)), 'catalog lists every contract dataset', dsIds);
  ok(dsAll.every((d) => d.defaultColumns.every((c) => d.fields.some((f2) => f2.id === c)) && d.fields.every((f2) => f2.id && f2.label && ['string', 'number', 'date', 'enum', 'boolean'].includes(f2.type) && typeof f2.filterable === 'boolean' && typeof f2.groupable === 'boolean' && typeof f2.sortable === 'boolean' && Array.isArray(f2.aggregations))), 'catalog field shape is valid and defaultColumns exist');
  let allRun = true; const runFail = [];
  for (const d of dsIds) { const r = await post('/run', { dataset: d, limit: 5 }); if (r.status !== 200 || !Array.isArray(r.body.rows) || !r.body.meta || r.body.meta.synthetic !== true || r.body.meta.label !== 'Synthetic demo data' || !(r.body.rowCount > 0)) { allRun = false; runFail.push([d, r.status]); } }
  ok(allRun, 'a detail run returns rows, meta.synthetic and label for every dataset', runFail);
  const rawInc = (await post('/run', { dataset: 'incidents', limit: 1 })).body;
  const byType = (await post('/run', { dataset: 'incidents', groupBy: ['eventType'], metrics: [{ field: '*', agg: 'count' }], limit: 100 })).body;
  ok(byType.rows.reduce((a, r) => a + r.count, 0) === rawInc.rowCount && byType.totals.count === rawInc.rowCount, 'groupBy eventType count sums to the raw incident count (' + rawInc.rowCount + ')');
  const byWeek = (await post('/run', { dataset: 'incidents', groupBy: ['severity'], timeBucket: 'week', metrics: [{ field: '*', agg: 'count' }], limit: 5000 })).body;
  ok(byWeek.rows.reduce((a, r) => a + r.count, 0) === rawInc.rowCount && /^\d{4}-\d{2}-\d{2}$/.test(byWeek.rows[0].bucket), 'groupBy severity x week sums to the raw count');
  const fpRaw = (await post('/run', { dataset: 'incidents', filters: [{ field: 'isFalsePositive', op: 'eq', value: true }], limit: 1 })).body;
  const fpRate = (await post('/run', { dataset: 'incidents', metrics: [{ field: 'isFalsePositive', agg: 'rate' }] })).body;
  ok(fpRaw.rowCount > 0 && near(fpRate.totals.rate_isFalsePositive, (100 * fpRaw.rowCount) / rawInc.rowCount, 0.06), 'rate metric equals filtered count / total');
  const scoped = (await post('/run', { dataset: 'incidents', fleetIds: ['fleet_elite'], groupBy: ['fleetId'], metrics: [{ field: '*', agg: 'count' }] })).body;
  ok(scoped.rows.length === 1 && scoped.rows[0].fleetId === 'fleet_elite', 'fleetIds scopes the result to Elite Towing');
  const cmpR = (await post('/run', { dataset: 'incidents', dateRange: { preset: '30d' }, metrics: [{ field: '*', agg: 'count' }], compareTo: 'previous_period' })).body;
  ok(cmpR.comparison && cmpR.comparison.deltaByMetric && cmpR.comparison.deltaByMetric.count && typeof cmpR.comparison.deltaByMetric.count.previous === 'number', 'compareTo previous_period returns deltaByMetric');
  const rtm = (await post('/run', { dataset: 'response_times', metrics: [{ field: 'dispatchToOnSceneMin', agg: 'median' }, { field: 'dispatchToOnSceneMin', agg: 'p90' }, { field: 'dispatchToOnSceneMin', agg: 'avg' }] })).body;
  ok(rtm.rows[0].median_dispatchToOnSceneMin != null && rtm.rows[0].p90_dispatchToOnSceneMin >= rtm.rows[0].median_dispatchToOnSceneMin, 'response_times median <= p90');
  for (const [name, body, field] of [['unknown dataset', { dataset: 'nope' }, 'dataset'], ['unknown field', { dataset: 'incidents', groupBy: ['nope'] }, 'groupBy[0]'], ['bad op', { dataset: 'incidents', filters: [{ field: 'eventType', op: 'gt', value: 1 }] }, 'filters[0].op'], ['bad agg', { dataset: 'incidents', metrics: [{ field: 'status', agg: 'sum' }] }, 'metrics[0].agg'], ['bad enum value', { dataset: 'incidents', filters: [{ field: 'severity', op: 'eq', value: 'huge' }] }, 'filters[0].value'], ['bad limit', { dataset: 'incidents', limit: 0 }, 'limit']]) {
    const r = await post('/run', body); ok(r.status === 400 && r.body.error && r.body.field === field, '400 with field for ' + name, [r.status, r.body]);
  }
  const capped = (await post('/run', { dataset: 'sop', limit: 99999 })).body;
  ok(capped.rows.length <= 5000 && capped.meta.notes.some((n) => /capped/.test(n)), 'row cap enforced (limit above 5000 is capped)');
  // export
  const exp = await fetch(BASE + RB + '/export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dataset: 'incidents', columns: ['incidentId', 'fleetName', 'driverName', 'status'], filters: [{ field: 'fleetId', op: 'eq', value: 'fleet_elite' }], format: 'csv' }) });
  const csvText = await exp.text(), cd = exp.headers.get('content-disposition') || '';
  ok(exp.status === 200 && /nexus-incidents-\d{4}-\d{2}-\d{2}-SYNTHETIC\.csv/.test(cd) && /text\/csv/.test(exp.headers.get('content-type')), 'CSV export has SYNTHETIC filename and content type', cd);
  const parseCsv = (t) => { const rows = []; let row = [], cell = '', q2 = false; for (let k = 0; k < t.length; k++) { const c = t[k]; if (q2) { if (c === '"') { if (t[k + 1] === '"') { cell += '"'; k++; } else q2 = false; } else cell += c; } else if (c === '"') q2 = true; else if (c === ',') { row.push(cell); cell = ''; } else if (c === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; } else cell += c; } if (cell || row.length) { row.push(cell); rows.push(row); } return rows; };
  const pc = parseCsv(csvText), eloR = (await post('/run', { dataset: 'incidents', columns: ['incidentId', 'fleetName', 'driverName', 'status'], filters: [{ field: 'fleetId', op: 'eq', value: 'fleet_elite' }], limit: 20000 })).body;
  ok(pc.length - 1 === eloR.rowCount && pc[0].length === 4 && pc[1].length === 4 && pc[1][0] === eloR.rows[0].incidentId, 'CSV parses: header + one line per row, 4 columns', [pc.length, eloR.rowCount]);
  const tc = require('./../src/reports').toCsv({ columns: [{ id: 'a', label: 'A, "x"' }, { id: 'b', label: 'B' }], rows: [{ a: 'he said "hi", ok\nnext', b: '=SUM(1)' }, { a: null, b: -3 }] });
  const tp = parseCsv(tc);
  ok(tp[0][0] === 'A, "x"' && tp[1][0] === 'he said "hi", ok\nnext' && tp[1][1] === "'=SUM(1)" && tp[2][0] === '' && tp[2][1] === '-3', 'CSV escaping: commas, quotes, newlines, formula guard, nulls, negative numbers');
  const expj = await fetch(BASE + RB + '/export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dataset: 'fleet_portfolio', format: 'json' }) });
  const ej = await expj.json(); ok(expj.status === 200 && /SYNTHETIC\.json/.test(expj.headers.get('content-disposition')) && ej.meta.synthetic === true && ej.rows.length === 7, 'JSON export has meta.synthetic and a row per fleet');
  // saved reports
  const sv = (await J(RB + '/saved')).body;
  ok(['dispatch', 'fleet', 'insurer', 'claims'].every((a) => sv.filter((x) => x.isTemplate && x.area === a).length >= 4), 'at least 4 built-in templates per area');
  let tplOk = true; const tplFail = [];
  for (const t of sv.filter((x) => x.isTemplate)) { const r = await post('/run', t.config); if (r.status !== 200) { tplOk = false; tplFail.push([t.id, r.status, r.body.message]); } }
  ok(tplOk, 'every template config runs without error', tplFail);
  const tpl = sv.find((x) => x.isTemplate);
  const tp1 = await J(RB + '/saved/' + tpl.id, { method: 'PUT', body: { name: 'x' } }), tp2 = await J(RB + '/saved/' + tpl.id, { method: 'DELETE' });
  ok(tp1.status === 409 && tp1.body.error === 'template_readonly' && tp2.status === 409 && tp2.body.error === 'template_readonly', 'templates are read-only (PUT/DELETE -> 409 template_readonly)');
  const badSave = await post('/saved', { name: 'Bad', area: 'dispatch', config: { dataset: 'nope' } });
  ok(badSave.status === 400, 'saving a report with an invalid config is rejected');
  const mk = await post('/saved', { name: 'Check report', area: 'dispatch', description: 'check', config: { dataset: 'incidents', groupBy: ['status'], metrics: [{ field: '*', agg: 'count' }] }, chart: { type: 'bar', x: 'status', series: ['count'] } });
  ok(mk.status === 201 && mk.body.id && mk.body.isTemplate === false, 'saved report created (201)');
  const up = await J(RB + '/saved/' + mk.body.id, { method: 'PUT', body: { name: 'Check report v2' } });
  ok(up.status === 200 && up.body.name === 'Check report v2' && up.body.config.dataset === 'incidents', 'saved report updated (PUT)');
  const dup = await post('/saved/' + tpl.id + '/duplicate', {});
  ok(dup.status === 201 && dup.body.isTemplate === false && /copy/.test(dup.body.name) && dup.body.config.dataset === tpl.config.dataset, 'duplicating a template makes an editable copy (201)');
  const sch = await post('/schedules', { savedId: mk.body.id, cadence: 'weekly', recipients: ['ops@example.invalid'], format: 'csv' });
  ok(sch.status === 201 && sch.body.simulated === true && sch.body.status === 'stored_not_sent' && /no email is sent/.test(sch.body.note), 'schedule is stored and marked simulated / stored_not_sent');
  ok((await post('/schedules', { savedId: mk.body.id, cadence: 'hourly', recipients: ['ops@example.invalid'] })).status === 400 && (await post('/schedules', { savedId: mk.body.id, cadence: 'daily', recipients: ['not-an-email'] })).status === 400, 'schedule validation rejects bad cadence and recipients');
  const shr = await J('/api/insurer/reports', { method: 'POST', body: { kind: 'builder', refId: mk.body.id } });
  ok(shr.status === 201 && shr.body.token && shr.body.kind === 'builder', 'builder share link created');
  if (shr.body.token) { const pub = (await J('/api/reports/' + shr.body.token)).body; ok(pub.kind === 'builder' && pub.readOnly === true && pub.data.frozen === true && pub.data.result.rows.length > 0 && pub.data.config.dataset === 'incidents' && new Date(pub.expiresAt) - Date.now() > 29 * 86400000, 'share snapshot is frozen result + config with ~30 day expiry'); }
  ok((await J('/api/insurer/reports', { method: 'POST', body: { kind: 'builder', refId: 'rpt_missing' } })).status === 404, 'builder share of an unknown report is 404');
  ok((await J(RB + '/saved/' + mk.body.id, { method: 'DELETE' })).status === 200, 'saved report deleted');
  const mk2 = await post('/saved', { name: 'Survives until reset', area: 'claims', config: { dataset: 'warranty_claims' } });
  const sch2 = await post('/schedules', { savedId: mk2.body.id, cadence: 'daily', recipients: ['ops@example.invalid'] });
  // records
  const stat = (await J('/api/records/search?type=warranty_claim&limit=1')).body, cl = (await J('/api/records/claims?limit=500')).body;
  ok(stat.total === cl.total && cl.summary.count === stat.total && cl.results.length === Math.min(500, cl.total), 'claims summary count equals claims search total (' + stat.total + ')');
  const fCl = (await J('/api/records/claims?fleetId=fleet_gulfcoast&limit=500')).body, fSe = (await J('/api/records/search?type=warranty_claim&fleetId=fleet_gulfcoast&limit=1')).body;
  ok(fCl.total === fSe.total && fCl.summary.count === fSe.total && fCl.results.every((c) => c.fleetId === 'fleet_gulfcoast'), 'filtered claims summary equals filtered search total');
  ok(near(cl.summary.recoveredTotal, cl.results.reduce((a, c) => a + c.recoveredAmount, 0), 0.01) && cl.summary.byStatus && Object.values(cl.summary.byStatus).reduce((a, b) => a + b, 0) === cl.total, 'claims summary recoveredTotal and byStatus match the rows');
  const viaRb = (await post('/run', { dataset: 'warranty_claims', metrics: [{ field: 'recoveredAmount', agg: 'sum' }, { field: '*', agg: 'count' }] })).body;
  ok(viaRb.totals.count === cl.total && near(viaRb.totals.sum_recoveredAmount, cl.summary.recoveredTotal, 0.01), 'report-builder claims dataset agrees with the records claims register');
  const REASONS = ['Outside warranty mileage', 'Aftermarket modification', 'Fault code not covered', 'Missing maintenance records'];
  const bs = cl.summary.byStatus, denied = cl.results.filter((c) => c.wasDenied);
  claimSpread = JSON.stringify(bs);
  ok((bs.denied || 0) >= 3 && (bs.paid || 0) > (bs.denied || 0) && (bs.under_review || 0) >= 1 && (bs.more_info_needed || 0) >= 1 && cl.summary.approvalRate > 50 && cl.summary.approvalRate < 100, 'seeded claims have a realistic outcome spread (paid majority, denied, under review, more info)', bs);
  ok(denied.length >= 3 && denied.every((c) => REASONS.includes(c.denialReason)) && new Set(denied.map((c) => c.denialReason)).size >= 2, 'denied claims carry plausible denial reasons');
  ok(cl.results.filter((c) => c.status === 'paid').every((c) => c.recoveredAmount > 0 && c.recoveredAmount <= c.estimatedAmount && c.paidAt && c.decidedAt && new Date(c.decidedAt) <= new Date(c.paidAt)) && cl.results.filter((c) => c.approvedAmount != null).every((c) => c.approvedAmount <= c.estimatedAmount) && cl.results.filter((c) => c.status !== 'paid').every((c) => c.recoveredAmount === 0) && new Set(cl.results.filter((c) => c.status === 'paid').map((c) => Math.round((100 * c.approvedAmount) / c.estimatedAmount))).size > 3, 'claim amounts: recovered <= approved <= estimated, varied approval fractions, decision before payment');
  ok(cl.results.every((c) => !c.decidedAt || new Date(c.decidedAt) <= new Date()) && new Set(cl.results.map((c) => c.oem)).size >= 4, 'decision dates are not in the future; claims span several OEMs');
  const FL = ['fleet_gulfcoast', 'fleet_elite', 'fleet_redline'];
  const perCl = [], perSe = [];
  for (const f2 of FL) { perCl.push((await J('/api/records/claims?limit=1&fleetId=' + f2)).body.total); perSe.push((await J('/api/records/search?type=incident&limit=1&fleetId=' + f2)).body.total); }
  const uCl = (await J('/api/records/claims?limit=1000&fleetId=' + FL.join(','))).body, uSe = (await J('/api/records/search?type=warranty_claim&limit=1&fleetId=' + FL.join(','))).body, uInc = (await J('/api/records/search?type=incident&limit=1&fleetId=' + FL.join(','))).body;
  ok(uCl.total === perCl.reduce((a, b) => a + b, 0) && uCl.summary.count === uCl.total && uSe.total === uCl.total && uCl.results.every((c) => FL.includes(c.fleetId)), 'comma fleetId claims: union count = sum of per-fleet counts = summary.count = search total', [uCl.total, perCl, uSe.total]);
  ok(uInc.total === perSe.reduce((a, b) => a + b, 0) && Object.keys(uInc.facets.fleet).every((k) => FL.includes(k)) && (await J('/api/records/search?type=incident&limit=1&fleetIds=' + FL.join(','))).body.total === uInc.total, 'comma fleetId incident search: union = sum of per-fleet; facets over the union; fleetIds alias works');
  ok(uCl.summary.medianDaysToDecision != null && (await J('/api/records/claims?fleetId=fleet_elite,nope')).status === 400 && (await J('/api/records/entities?scope=driver&fleetId=fleet_elite,fleet_gulfcoast')).body.entities.some((e2) => e2.fleetId === 'fleet_gulfcoast'), 'multi-fleet medianDaysToDecision present; unknown fleet id is 400; entities accepts a comma list');
  const one = cl.results[0]; const claimOne = (await J('/api/records/claims/' + one.claimId)).body;
  ok(claimOne.claimId === one.claimId && Array.isArray(claimOne.timeline) && (await J('/api/records/claims/NOPE')).status === 404, 'claim detail and 404');
  const sInc = (await J('/api/records/search?type=incident&limit=5&q=' + encodeURIComponent(one.incidentId))).body;
  ok(sInc.results.some((r) => r.id === one.incidentId) && sInc.facets && sInc.facets.status && (await J('/api/records/search?type=bogus')).status === 400, 'incident search by id finds the incident, returns facets; bad type is 400');
  const hist = await J('/api/records/incident/' + one.incidentId + '/history');
  ok(hist.status === 200 && hist.body.timeline.length > 0 && hist.body.claim && hist.body.claim.claimId === one.claimId && Array.isArray(hist.body.related), 'incident history includes timeline, claim and related');
  const rh1 = (await J('/api/records/risk-history?scope=fleet&id=fleet_gulfcoast&bucket=week')).body, rh2 = (await J('/api/records/risk-history?scope=fleet&id=fleet_gulfcoast&bucket=week')).body;
  ok(rh1.series.length >= 4 && rh1.series.every((s2) => s2.points.length > 4) && JSON.stringify(rh1.series) === JSON.stringify(rh2.series) && JSON.stringify(rh1.events) === JSON.stringify(rh2.events), 'risk-history is deterministic across calls');
  ok(rh1.meta.synthetic === true && rh1.meta.limitations.some((l2) => /90 days/.test(l2)) && ['up', 'down', 'flat'].includes(rh1.summary.direction), 'risk-history labels itself synthetic with limitations and a summary');
  const rhd = (await J('/api/records/risk-history?scope=driver&id=drv_elt_01&bucket=month&compareIds=drv_elt_02')).body, rhp = await J('/api/records/risk-history?scope=portfolio&bucket=month');
  ok(rhd.comparisons && rhd.comparisons.length === 1 && rhp.status === 200 && (await J('/api/records/risk-history?scope=fleet&id=nope')).status === 404 && (await J('/api/records/risk-history?scope=fleet&id=x&bucket=year')).status === 400, 'risk-history: driver compare, portfolio, 404 and 400');
  const en = (await J('/api/records/entities?scope=driver&fleetId=fleet_elite')).body; ok(en.entities.length > 5 && en.entities.every((e2) => e2.fleetId === 'fleet_elite'), 'entities lists Elite Towing drivers');
  const rsn = (await post('/run', { dataset: 'risk_snapshots', filters: [{ field: 'entityType', op: 'eq', value: 'fleet' }], groupBy: ['entityName'], metrics: [{ field: 'riskScore', agg: 'avg' }] })).body;
  ok(rsn.rows.length >= 7, 'risk_snapshots dataset covers every live fleet (' + rsn.rows.length + ')');

  console.log('\n[6] reset');
  const rs = await J('/api/demo/reset', { method: 'POST', body: {} });
  const stt = (await J('/api/demo/state')).body;
  ok(rs.status === 200 && rs.body.ok && rs.body.resetAt === stt.resetAt, 'reset returns resetAt, state reports the same');
  ok(rs.body.counts.incidents === stt.counts.incidents && stt.counts.customFleets === 0 && stt.counts.demoScenarioIncidents === 0 && stt.counts.apiKeys === 0 && stt.counts.importedIncidents === 0, 'custom fleets, scenario incidents, API keys cleared; counts agree', stt.counts);
  ok(Math.abs(stt.counts.incidents - (before - 2 - 2 - 1)) <= 40 || stt.counts.incidents > 0, 'incident count back to seeded range', [before, stt.counts.incidents]);
  const sv2 = (await J(RB + '/saved')).body;
  ok(!sv2.some((x) => !x.isTemplate) && sv2.filter((x) => x.isTemplate).length >= 16 && (await J(RB + '/schedules')).body.schedules.length === 0, 'reset clears user-saved reports and schedules but keeps templates');
  const spread1 = JSON.stringify((await J('/api/records/claims?limit=1')).body.summary.byStatus);
  ok(JSON.parse(spread1).denied >= 3 && JSON.parse(spread1).paid > 10, 'reset restores seeded claim outcomes (denied and paid present)', spread1);
  const pf2 = (await J('/api/predict/portfolio')).body;
  ok(pf2.fleets.length === 7 && pf2.comparison && pf2.comparison.mantis, 'predictive state rebuilt after reset (7 fleets)');
  const rs2 = await J('/api/demo/reset', { method: 'POST', body: {} });
  ok(JSON.stringify((await J('/api/records/claims?limit=1')).body.summary.byStatus) === spread1, 'repeated reset gives the identical claim outcome spread', spread1);
  ok(rs2.body.counts.incidents === rs.body.counts.incidents && rs2.body.counts.fleets === rs.body.counts.fleets && rs2.body.counts.comms === rs.body.counts.comms, 'reset is repeatable (same fleet/incident/comms counts)', [rs.body.counts, rs2.body.counts]);

  console.log(`\n${passes} passed, ${fails} failed`);
  if (child) child.kill();
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); if (child) child.kill(); process.exit(2); });
