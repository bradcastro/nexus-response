// Records / history explorer: search across incidents, warranty claims, risk snapshots and comms; claims register; risk history; entity pickers;
// per-incident history. Mounted at /api/records. Everything is derived from the existing store (synthetic demo data).
const express = require('express');
const db = require('../db');
const roster = require('./roster');
const DS = require('./datasets');
const H = require('./history');
const { round } = require('./util');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const DAY = 86400000;
const LABEL = 'Synthetic demo data';
class ApiError extends Error { constructor(status, error, message, field) { super(message); this.status = status; this.error = error; this.field = field; } }
const bad = (field, message, error = 'invalid_request') => new ApiError(400, error, message, field);
const meta = (extra) => ({ synthetic: true, label: LABEL, generatedAt: new Date().toISOString(), ...(extra || {}) });
const TYPES = ['incident', 'warranty_claim', 'risk_snapshot', 'comm'];
const SEV_RANK = { low: 1, medium: 2, high: 3, critical: 4 };
const pretty = (s) => String(s || '').replace(/_/g, ' ');
const inc = (v, d, lo, hi, field) => { if (v == null || v === '') return d; const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) throw bad(field, `${field} must be an integer between ${lo} and ${hi}`); return n; };
const dateQ = (v, field, end) => { if (v == null || v === '') return null; const s = String(v); const t = +new Date(s); if (Number.isNaN(t)) throw bad(field, `${field} must be an ISO date`); return /^\d{4}-\d{2}-\d{2}$/.test(s) && end ? t + DAY - 1 : t; };
const list = (v) => (v == null || v === '' ? null : String(v).split(',').map((x) => x.trim().toLowerCase()).filter(Boolean));
const links = (id, fleetId, extra) => ({ ...(id ? { dispatch: `/dispatch/#${id}`, fleet: `/fleet/?fleet=${fleetId}#incident=${id}` } : {}), ...(extra || {}) });
const facet = (rows, fn) => { const m = {}; for (const r of rows) { const v = fn(r); if (v != null && v !== '') m[v] = (m[v] || 0) + 1; } return Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))); };
const ts = (r) => (r.timestamp ? +new Date(r.timestamp) : 0);

// ---------- record builders ----------
function incidentRecord(i, claim) {
  const cl = claim || null;
  const tags = [i.severity, i.category, i.provider];
  if (i.camera && i.camera.verified) tags.push('camera_verified'); if (i.camera && i.camera.aiVerdict === 'false_positive') tags.push('false_positive');
  if (i.roadside && i.roadside.needed) tags.push('roadside'); if (cl) tags.push('warranty_claim'); if (i.fnol) tags.push('fnol');
  if (i.source === 'historical_import') tags.push('imported');
  return {
    id: i.id, type: 'incident', fleetId: i.fleetId, fleetName: i.fleetName, timestamp: i.timestamp, title: `${pretty(i.eventType)} - ${(i.driver && i.driver.name) || 'unknown driver'} - ${(i.vehicle && i.vehicle.unit) || ''}`.trim(),
    summary: `${pretty(i.eventType)} at ${(i.location && i.location.address) || 'unknown location'}`, status: i.status, category: i.category, severity: i.severity, eventType: i.eventType, oem: (i.vehicle && i.vehicle.oem) || null,
    vehicleId: i.vehicle && i.vehicle.id, vehicleUnit: i.vehicle && i.vehicle.unit, vin: i.vehicle && i.vehicle.vin, driverId: (i.driver && i.driver.id) || null, driverName: (i.driver && i.driver.name) || null,
    claimId: cl ? cl.claimId : null, tags: tags.filter(Boolean), links: links(i.id, i.fleetId, { api: `/api/records/incident/${i.id}/history` }),
  };
}
function claimPublic(c) {
  const { timeline, incidentAt, firstDecision, ...rest } = c;
  return { ...rest, incidentAt, firstDecision, timeline };
}
function claimRecord(c) {
  return {
    ...claimPublic(c), id: c.claimId, type: 'warranty_claim', title: `${c.oem || 'OEM'} claim ${c.claimNumber || c.claimId} - ${c.unit || ''}`.trim(), summary: `${c.status.replace(/_/g, ' ')}; est. $${c.estimatedAmount != null ? c.estimatedAmount : 'n/a'}; recovered $${c.recoveredAmount}`,
    category: c.warrantyBasis, severity: null, tags: [c.status, c.oem, c.warrantyBasis, c.isOpen ? 'open' : 'closed'].filter(Boolean), links: links(c.incidentId, c.fleetId, { api: `/api/records/claims/${c.claimId}` }),
  };
}
function snapshotRecord(r) {
  return {
    id: r.snapshotId, type: 'risk_snapshot', fleetId: r.fleetId, fleetName: r.fleetName, timestamp: r.timestamp, title: `${r.entityType === 'fleet' ? 'Fleet' : 'Driver'} ${r.entityName} - week of ${r.weekStart}`, summary: `risk ${r.riskScore}, Drive Score ${r.driveScore}, ${r.events} events, ${r.collisions} collisions`,
    status: r.riskTier || r.driveBand, category: r.entityType, severity: null, entityType: r.entityType, entityId: r.entityId, entityName: r.entityName, vendor: r.vendor, driverId: r.entityType === 'driver' ? r.entityId : null,
    riskScore: r.riskScore, driveScore: r.driveScore, events: r.events, collisions: r.collisions, eventsPer1kMi: r.eventsPer1kMi, cameraVerifiedShare: r.cameraVerifiedShare, partial: !r.windowComplete,
    tags: [r.entityType, r.riskTier || r.driveBand, ...(r.windowComplete ? [] : ['partial_window'])].filter(Boolean), links: { api: `/api/records/risk-history?scope=${r.entityType}&id=${encodeURIComponent(r.entityId)}&bucket=week` },
  };
}
function commRecord(c) {
  return {
    id: c.commId, type: 'comm', incidentId: c.incidentId, fleetId: c.fleetId, fleetName: c.fleetName, timestamp: c.timestamp, title: `${c.channel.toUpperCase()} to ${c.recipientName || c.recipientType || 'recipient'}${c.template ? ' (' + c.template + ')' : ''}`,
    summary: c.body || '', status: c.status, category: c.channel, severity: null, recipientType: c.recipientType, tags: [c.channel, c.recipientType, 'simulated'].filter(Boolean), links: links(c.incidentId, c.fleetId, { api: c.incidentId ? `/api/records/incident/${c.incidentId}/history` : undefined }),
  };
}

async function claimsOf(ctx) { return DS.claimRecords(ctx.incidents, ctx.now); }
const hit = (q, ...vals) => !q || vals.some((v) => v != null && String(v).toLowerCase().includes(q));

function parseCommon(qs) {
  const o = {
    q: qs.q ? String(qs.q).trim().toLowerCase().slice(0, 200) : '', fleetId: fleetSetOf(qs), from: dateQ(qs.from, 'from'), to: dateQ(qs.to, 'to', true),
    status: list(qs.status), category: list(qs.category), severity: list(qs.severity), oem: list(qs.oem), vehicleId: qs.vehicleId ? String(qs.vehicleId) : null, driverId: qs.driverId ? String(qs.driverId) : null,
    dir: qs.dir == null ? 'desc' : String(qs.dir).toLowerCase(), sort: qs.sort ? String(qs.sort) : null, limit: inc(qs.limit, 25, 1, 1000, 'limit'), offset: inc(qs.offset, 0, 0, 1e7, 'offset'),
  };
  if (!['asc', 'desc'].includes(o.dir)) throw bad('dir', 'dir must be asc or desc');
  if (o.from != null && o.to != null && o.from > o.to) throw bad('from', 'from is after to');
  return o;
}
// fleetId / fleetIds accept one id or a comma list (union). Unknown ids are a 400 for every records route.
function fleetSetOf(qs) {
  const raw = [qs.fleetId, qs.fleetIds].flatMap((v) => (Array.isArray(v) ? v : [v])).filter((v) => v != null && v !== '').flatMap((v) => String(v).split(',')).map((x) => x.trim()).filter(Boolean);
  if (!raw.length) return null;
  if (raw.length > 50) throw bad('fleetId', 'At most 50 fleet ids');
  const known = new Set(roster.all().map((f) => f.id));
  const miss = raw.find((x) => !known.has(x)); if (miss) throw bad('fleetId', `Unknown fleet id "${miss}"`, 'invalid_fleet');
  return new Set(raw);
}
const inFleet = (o, id) => !o.fleetId || o.fleetId.has(id);
const inRange = (o, t) => (o.from == null || t >= o.from) && (o.to == null || t <= o.to);
const oneOf = (arr, v) => !arr || (v != null && arr.includes(String(v).toLowerCase()));

function order(rows, o, keyFns, def) {
  const key = o.sort || def;
  const fn = keyFns[key]; if (!fn) throw bad('sort', `sort must be one of ${Object.keys(keyFns).join(', ')}`);
  const sgn = o.dir === 'asc' ? 1 : -1;
  return rows.sort((a, b) => { const x = fn(a), y = fn(b); const c = x == null && y == null ? 0 : x == null ? 1 : y == null ? -1 : x < y ? -1 : x > y ? 1 : 0; return c ? c * sgn : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0); });
}

async function search(type, qs) {
  const o = parseCommon(qs);
  const ctx = await DS.loadCtx();
  let recs;
  if (type === 'incident') {
    const claims = new Map((await claimsOf(ctx)).map((c) => [c.incidentId, c]));
    recs = ctx.incidents.filter((i) => inFleet(o, i.fleetId) && inRange(o, ts(i)) && oneOf(o.status, i.status) && oneOf(o.category, i.category) && oneOf(o.severity, i.severity) && oneOf(o.oem, i.vehicle && i.vehicle.oem)
      && (!o.vehicleId || (i.vehicle && i.vehicle.id === o.vehicleId)) && (!o.driverId || (i.driver && i.driver.id === o.driverId))
      && hit(o.q, i.id, i.vehicle && i.vehicle.vin, i.vehicle && i.vehicle.unit, i.vehicle && i.vehicle.plate, i.driver && i.driver.name, i.eventType, i.location && i.location.address, i.fleetName, claims.get(i.id) && claims.get(i.id).claimNumber, claims.get(i.id) && claims.get(i.id).claimId))
      .map((i) => incidentRecord(i, claims.get(i.id)));
    recs = order(recs, o, { timestamp: ts, severity: (r) => SEV_RANK[r.severity] || 0, status: (r) => r.status, fleetName: (r) => r.fleetName, id: (r) => r.id }, 'timestamp');
  } else if (type === 'warranty_claim') {
    recs = filterClaims(await claimsOf(ctx), o).map(claimRecord);
    recs = order(recs, o, { timestamp: ts, status: (r) => r.status, estimatedAmount: (r) => r.estimatedAmount, recoveredAmount: (r) => r.recoveredAmount, ageDays: (r) => r.ageDays, id: (r) => r.id }, 'timestamp');
  } else if (type === 'risk_snapshot') {
    const snaps = H.snapshotRows(ctx.incidents, H.clock());
    recs = snaps.filter((r) => inFleet(o, r.fleetId) && inRange(o, ts(r)) && oneOf(o.status, r.riskTier || r.driveBand) && oneOf(o.category, r.entityType) && (!o.driverId || r.entityId === o.driverId)
      && hit(o.q, r.entityName, r.entityId, r.fleetName, r.weekStart, r.vendor)).map(snapshotRecord);
    recs = order(recs, o, { timestamp: ts, riskScore: (r) => r.riskScore, driveScore: (r) => r.driveScore, entityName: (r) => r.entityName, id: (r) => r.id }, 'timestamp');
  } else {
    const cm = await require('./datasets').DATASETS.comms.rows(ctx);
    const bodies = new Map((await db.list('comms', { limit: 1e6 })).map((c) => [c.id, c]));
    recs = cm.filter((c) => inFleet(o, c.fleetId) && inRange(o, ts(c)) && oneOf(o.status, c.status) && oneOf(o.category, c.channel) && (!qs.incidentId || c.incidentId === qs.incidentId)
      && hit(o.q, c.commId, c.incidentId, c.recipientName, c.template, c.fleetName, (bodies.get(c.commId) || {}).body, (bodies.get(c.commId) || {}).subject))
      .map((c) => commRecord({ ...c, body: ((bodies.get(c.commId) || {}).body || '').slice(0, 280) }));
    recs = order(recs, o, { timestamp: ts, channel: (r) => r.category, status: (r) => r.status, id: (r) => r.id }, 'timestamp');
  }
  const facets = {
    status: facet(recs, (r) => r.status), category: facet(recs, (r) => r.category), severity: facet(recs, (r) => r.severity), fleet: facet(recs, (r) => r.fleetId), oem: facet(recs, (r) => r.oem),
    fleetLabels: Object.fromEntries([...new Map(recs.map((r) => [r.fleetId, r.fleetName]))].filter(([k]) => k)),
  };
  return { type, total: recs.length, limit: o.limit, offset: o.offset, results: recs.slice(o.offset, o.offset + o.limit), facets, meta: meta({ query: { q: o.q, fleetId: o.fleetId ? [...o.fleetId] : null, sort: o.sort || 'timestamp', dir: o.dir } }) };
}
function filterClaims(claims, o) {
  return claims.filter((c) => inFleet(o, c.fleetId) && oneOf(o.status, c.status) && oneOf(o.oem, c.oem) && oneOf(o.category, c.warrantyBasis) && inRange(o, ts(c))
    && hit(o.q, c.claimId, c.claimNumber, c.incidentId, c.vin, c.unit, c.oem, c.dealer, c.denialReason, (c.faultCodes || []).join(' '), c.fleetName));
}
const median = (a) => { const s = a.filter((x) => x != null).sort((x, y) => x - y); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
function claimsSummary(rows) {
  const byStatus = {}; rows.forEach((c) => { byStatus[c.status] = (byStatus[c.status] || 0) + 1; });
  const decided = rows.filter((c) => c.firstDecision), approved = decided.filter((c) => c.firstDecision === 'approved');
  const sum = (k) => round(rows.reduce((s, c) => s + (c[k] || 0), 0), 2);
  const md = median(rows.map((c) => c.daysToDecision));
  return {
    count: rows.length, byStatus, openCount: rows.filter((c) => c.isOpen).length, estimatedTotal: sum('estimatedAmount'), approvedTotal: sum('approvedAmount'), recoveredTotal: sum('recoveredAmount'),
    decidedCount: decided.length, approvalRate: decided.length ? round((100 * approved.length) / decided.length, 1) : null, medianDaysToDecision: md == null ? null : round(md, 2),
    basis: 'approvalRate = claims whose first OEM decision was approval / claims with a decision, in percent; medianDaysToDecision = submission to first decision; recoveredTotal = amounts marked paid. OEM responses are simulated.',
  };
}

// ---------- risk history ----------
async function riskHistory(qs) {
  const scope = String(qs.scope || 'fleet');
  if (!['fleet', 'driver', 'vehicle', 'portfolio'].includes(scope)) throw bad('scope', 'scope must be fleet, driver, vehicle or portfolio');
  const bucket = String(qs.bucket || 'week'); if (!H.BUCKETS.includes(bucket)) throw bad('bucket', 'bucket must be day, week or month');
  const metrics = qs.metrics ? String(qs.metrics).split(',').map((s) => s.trim()).filter(Boolean) : ['riskScore', 'eventsPer1kMi', 'collisions', 'cameraVerifiedShare', 'driveScore'];
  const badM = metrics.find((m) => !H.METRICS[m]); if (badM) throw bad('metrics', `Unknown metric "${badM}"; expected ${Object.keys(H.METRICS).join(', ')}`);
  if (scope !== 'portfolio' && !qs.id) throw bad('id', `id is required for scope ${scope}`);
  const ids = scope === 'portfolio' ? ['portfolio'] : [String(qs.id)];
  const cmpIds = qs.compareIds ? String(qs.compareIds).split(',').map((s) => s.trim()).filter(Boolean).filter((x) => !ids.includes(x)) : [];
  if (scope === 'portfolio' && cmpIds.length) throw bad('compareIds', 'compareIds is not supported for scope portfolio');
  if (cmpIds.length > 5) throw bad('compareIds', 'At most 5 compareIds');
  const incs = await H.loadIncidents();
  const nowMs = H.clock();
  const toMs = Math.min(qs.to ? dateQ(qs.to, 'to', true) : nowMs, nowMs);
  const fromMs = qs.from ? dateQ(qs.from, 'from') : toMs - 90 * DAY;
  if (fromMs > toMs) throw bad('from', 'from is after to');
  if (bucket === 'day' && toMs - fromMs > 400 * DAY) throw bad('from', 'Daily buckets are limited to a 400 day range');
  if ((toMs - fromMs) / DAY > 3700) throw bad('from', 'Range too long');
  const mk = (id) => { const ent = H.resolveEntity(scope, id); if (!ent) throw new ApiError(404, 'not_found', `${scope} "${id}" not found`, 'id'); return ent; };
  const ents = [...ids, ...cmpIds].map(mk);
  const built = ents.map((ent) => ({ ent, r: H.entitySeries(ent, incs, { fromMs, toMs, bucket, metrics, nowMs }) }));
  const main = built[0];
  const prefer = metrics.includes('riskScore') ? 'riskScore' : metrics[0];
  const imported = incs.filter((i) => i.source === 'historical_import');
  const annotations = [];
  if (main.r.earliest != null) annotations.push({ t: new Date(main.r.earliest).toISOString(), label: 'Earliest stored incident for this dataset; rolling scores before 30 days after this are partial', kind: 'history_start' });
  if (imported.length) { const first = Math.min(...imported.map((i) => +new Date(i.timestamp))); annotations.push({ t: new Date(first).toISOString(), label: `Imported history begins (${imported.length} incidents)`, kind: 'import_start' }); }
  return {
    scope, id: main.ent.id, name: main.ent.name, fleetId: main.ent.fleetId, bucket, range: { from: new Date(fromMs).toISOString(), to: new Date(toMs).toISOString() }, series: main.r.series, events: main.r.events, annotations,
    summary: H.summarize(main.r.series, prefer),
    ...(cmpIds.length ? { comparisons: built.slice(1).map((b) => ({ id: b.ent.id, name: b.ent.name, fleetId: b.ent.fleetId, series: b.r.series, events: b.r.events, summary: H.summarize(b.r.series, prefer) })) } : {}),
    meta: meta({ label: LABEL, limitations: H.limitations(incs, main.ent, bucket), metrics: Object.fromEntries(metrics.map((m) => [m, H.METRICS[m]])), historyDays: main.r.earliest != null ? Math.round((nowMs - main.r.earliest) / DAY) : 0, importedIncidents: imported.length }),
  };
}

function entities(qs) {
  const scope = String(qs.scope || 'fleet');
  if (!['fleet', 'driver', 'vehicle', 'portfolio'].includes(scope)) throw bad('scope', 'scope must be fleet, driver, vehicle or portfolio');
  const q = qs.q ? String(qs.q).toLowerCase() : '';
  const limit = inc(qs.limit, 500, 1, 2000, 'limit');
  let fleets = H.liveFleets();
  const fs = fleetSetOf(qs); if (fs) fleets = fleets.filter((f) => fs.has(f.id));
  let rows;
  if (scope === 'portfolio') rows = [{ id: 'portfolio', name: 'All fleets (portfolio)', fleetId: null }];
  else if (scope === 'fleet') rows = fleets.map((f) => ({ id: f.id, name: f.name, fleetId: f.id, vendor: f.vendor, vehicles: f.vehicleCount || f.vehicles.length }));
  else if (scope === 'driver') rows = fleets.flatMap((f) => f.drivers.map((d) => ({ id: d.id, name: d.name, fleetId: f.id, fleetName: f.name, vehicleId: d.vehicleId || null })));
  else rows = fleets.flatMap((f) => f.vehicles.map((v) => ({ id: v.id, name: v.unit, fleetId: f.id, fleetName: f.name, vin: v.vin, plate: v.plate })));
  rows = rows.filter((r) => !q || [r.id, r.name, r.vin, r.plate].some((x) => x && String(x).toLowerCase().includes(q))).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { scope, total: rows.length, entities: rows.slice(0, limit), meta: meta() };
}

// ---------- incident history ----------
async function incidentHistory(id) {
  const i = await db.getIncident(id); if (!i) throw new ApiError(404, 'not_found', 'Incident not found');
  const { raw, ...rest } = i;
  const ctx = await DS.loadCtx();
  const claim = (await claimsOf(ctx)).find((c) => c.incidentId === id) || null;
  const comms = (await db.list('comms', { fleetId: i.fleetId, limit: 1e6 })).filter((c) => c.incidentId === id).sort((a, b) => (a.at < b.at ? -1 : 1));
  const jobs = (await db.list('job', { fleetId: i.fleetId, limit: 1e6 })).filter((j) => j.incidentId === id).map((j) => ({ providerId: j.providerId, providerName: j.providerName, status: j.status, createdAt: j.createdAt, events: j.events }));
  let sop = null; try { sop = require('./ops').sop(i); } catch (e) { /* optional */ }
  const t0 = +new Date(i.timestamp);
  const related = ctx.incidents.filter((o) => o.id !== id && Math.abs(+new Date(o.timestamp) - t0) <= 90 * DAY && ((i.vehicle && o.vehicle && o.vehicle.id === i.vehicle.id) || (i.driver && i.driver.id && o.driver && o.driver.id === i.driver.id)))
    .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1)).slice(0, 25)
    .map((o) => ({ id: o.id, timestamp: o.timestamp, eventType: o.eventType, severity: o.severity, status: o.status, relation: [i.vehicle && o.vehicle && o.vehicle.id === i.vehicle.id ? 'same_vehicle' : null, i.driver && i.driver.id && o.driver && o.driver.id === i.driver.id ? 'same_driver' : null].filter(Boolean), links: links(o.id, o.fleetId) }));
  const cam = i.camera || {};
  return {
    incident: rest, record: incidentRecord(i, claim), timeline: (i.timeline || []).slice().sort((a, b) => (a.t < b.t ? -1 : 1)), comms, jobs, claim: claim ? claimPublic(claim) : null, fnol: i.fnol || null, sop,
    camera: { provider: cam.provider, verified: !!cam.verified, aiVerdict: cam.aiVerdict, confidence: cam.confidence, clips: (cam.clips || []).map(({ vendorUrl, ...c }) => c), snapshots: cam.snapshots || [], signals: cam.signals || [] },
    related, links: links(i.id, i.fleetId, { api: `/api/incidents/${i.id}` }), meta: meta({ relatedWindowDays: 90 }),
  };
}

// ---------- router ----------
const router = express.Router();
router.use((req, res, next) => { res.set('X-Nexus-Data', 'synthetic'); next(); });
router.get('/search', wrap(async (req, res) => {
  const type = req.query.type == null || req.query.type === '' ? 'incident' : String(req.query.type);
  if (!TYPES.includes(type)) throw bad('type', `type must be one of ${TYPES.join(', ')}`);
  res.json(await search(type, req.query));
}));
router.get('/claims', wrap(async (req, res) => {
  const o = parseCommon(req.query);
  const ctx = await DS.loadCtx();
  const rows = filterClaims(await claimsOf(ctx), o);
  const sorters = { timestamp: ts, submittedAt: (r) => r.submittedAt && +new Date(r.submittedAt), status: (r) => r.status, estimatedAmount: (r) => r.estimatedAmount, recoveredAmount: (r) => r.recoveredAmount, ageDays: (r) => r.ageDays, claimId: (r) => r.claimId };
  const wrapR = rows.map((r) => ({ ...r, id: r.claimId }));
  order(wrapR, o, sorters, 'timestamp');
  res.json({
    total: rows.length, limit: o.limit, offset: o.offset, results: wrapR.slice(o.offset, o.offset + o.limit).map(({ id, ...r }) => ({ ...claimPublic(r), links: links(r.incidentId, r.fleetId, { api: `/api/records/claims/${r.claimId}` }) })),
    summary: claimsSummary(rows), facets: { status: facet(rows, (r) => r.status), oem: facet(rows, (r) => r.oem), fleet: facet(rows, (r) => r.fleetId), fleetLabels: Object.fromEntries([...new Map(rows.map((r) => [r.fleetId, r.fleetName]))]) }, meta: meta(),
  });
}));
router.get('/claims/:claimId', wrap(async (req, res) => {
  const ctx = await DS.loadCtx();
  const c = (await claimsOf(ctx)).find((x) => x.claimId === req.params.claimId || x.claimNumber === req.params.claimId);
  if (!c) throw new ApiError(404, 'not_found', 'Claim not found');
  const i = ctx.incidents.find((x) => x.id === c.incidentId); const cp = i && i.warranty && i.warranty.claimPacket;
  res.json({ ...claimPublic(c), links: links(c.incidentId, c.fleetId, { api: `/api/records/claims/${c.claimId}`, history: `/api/records/incident/${c.incidentId}/history` }),
    packet: cp ? { summary: cp.summary, evidence: cp.evidence, laborParts: cp.laborParts, towEstimateUsd: cp.towEstimateUsd, oemDesk: cp.oemDesk && { oem: cp.oemDesk.oem, name: cp.oemDesk.name, portal: cp.oemDesk.portal } } : null, simulated: true, meta: meta({ note: 'OEM responses in this lifecycle are simulated.' }) });
}));
router.get('/risk-history', wrap(async (req, res) => res.json(await riskHistory(req.query))));
router.get('/entities', wrap(async (req, res) => res.json(entities(req.query))));
router.get('/incident/:id/history', wrap(async (req, res) => res.json(await incidentHistory(req.params.id))));

router.use((req, res) => res.status(404).json({ error: 'not_found', message: `No records route ${req.method} ${req.originalUrl}` }));
router.use((err, req, res, next) => {
  if (err instanceof ApiError) return res.status(err.status).json({ error: err.error, message: err.message, ...(err.field ? { field: err.field } : {}) });
  next(err);
});

module.exports = { router, search, riskHistory, claimsSummary };
