// Data layer for predict: loads incidents/roster, keeps a frozen portfolio calibration + per-fleet analysis cache,
// invalidates on new incidents (by wrapping stream.publish), delivers `alert` SSE events (by wrapping stream.subscribe).
const db = require('../../db');
const roster = require('../roster');
const stream = require('../stream');
const A = require('./analyze');
const alerts = require('./alerts');

const DAY = 86400000;
const state = {
  calib: null, calibCount: 0, ctx: new Map(), analysis: new Map(), inflight: new Map(), version: 0, count: -1, fleetSig: '',
  lastSeen: -1, newestId: null, lastNewest: null, expected: -1, seenNew: new Set(), sse: new Set(), started: false, timer: null, evalTimers: new Map(), lastRefresh: 0, bootAlertsDone: false, now: null,
};
const TTL_MS = 5 * 60 * 1000;
const clock = () => (state.now != null ? state.now : Date.now());
// Deterministic model clock: all windows (backtest, EWMA, projections) are anchored to the newest live event rounded up to the
// hour, NOT to wall-clock time, so repeated calls on the same store state give identical numbers regardless of cache TTL.
let anchorCache = { n: -1, newest: null, t: 0 };
async function anchor() {
  if (state.now != null) return state.now;
  const n = await db.countIncidents();
  const newest = n ? (await db.listIncidents({ limit: 1, clone: false, notSource: 'historical_import' }))[0] : null;
  const key = newest ? newest.id + '|' + newest.timestamp : null;
  if (anchorCache.n === n && anchorCache.newest === key) return anchorCache.t;
  const ts = newest ? Date.parse(newest.timestamp) : NaN;
  const t = Number.isFinite(ts) ? Math.ceil(ts / 3600000) * 3600000 : Date.now();
  anchorCache = { n, newest: key, t };
  return t;
}

// ---------- fleets / ctx ----------
async function listFleetMeta() {
  const out = new Map();
  for (const f of roster.all()) out.set(f.id, { id: f.id, name: f.name, vendor: f.vendor, roster: f });
  try { for (const f of await db.listFleets()) if (!out.has(f.id)) out.set(f.id, { id: f.id, name: f.name, vendor: f.vendor, roster: null, doc: f }); } catch (e) { /* ignore */ }
  return out;
}
async function loadCtx(fleetId, fleetsMeta) {
  const meta = (fleetsMeta || (await listFleetMeta())).get(fleetId);
  const incs = await db.listIncidents({ fleetId, limit: 1000000, clone: false }); // shared refs, read-only
  if (!meta && !incs.length) return null;
  const r = meta && meta.roster;
  const fleet = { id: fleetId, name: (meta && meta.name) || (incs[0] && incs[0].fleetName) || fleetId, vendor: (meta && meta.vendor) || (incs[0] && incs[0].provider) || 'unknown', vehicles: meta && meta.doc ? meta.doc.vehicles : undefined };
  const last = incs.reduce((m, i) => Math.max(m, Date.parse(i.timestamp) || 0), 0);
  const now = await anchor();
  const asOf = last && now - last > 14 * DAY ? last + 3600000 : now; // historical imports: project from the end of the data
  const ctx = { fleet, drivers: r ? r.drivers : [], vehicles: r ? r.vehicles : [], incidents: incs, asOf };
  state.ctx.set(fleetId, ctx);
  return ctx;
}
async function ensureCalib(force = false) {
  const n = await db.countIncidents();
  const drift = state.calibCount ? Math.abs(n - state.calibCount) / state.calibCount : 1;
  if (state.calib && !force && drift < 0.15) return state.calib;
  const meta = await listFleetMeta();
  const ctxs = [];
  for (const id of meta.keys()) ctxs.push(await loadCtx(id, meta));
  const live = ctxs.filter(Boolean);
  const asOf = live.length ? Math.max(...live.map((c) => c.asOf)) : await anchor();
  state.calib = A.calibrate(live.map((c) => A.buildIndex({ ...c, asOf })), asOf);
  state.calibCount = n;
  state.analysis.clear();
  return state.calib;
}

async function getAnalysis(fleetId, { force = false } = {}) {
  const hit = state.analysis.get(fleetId);
  if (hit && !force && Date.now() - hit.at < TTL_MS) return hit.a;
  if (state.inflight.has(fleetId)) return state.inflight.get(fleetId);
  const p = (async () => {
    const calib = await ensureCalib();
    let ctx = state.ctx.get(fleetId);
    if (!ctx || force || (hit && Date.now() - hit.at >= TTL_MS)) ctx = await loadCtx(fleetId);
    if (!ctx) return null;
    { const an = await anchor(); ctx.asOf = ctx.incidents.length && an - ctx.incidents.reduce((m, i) => Math.max(m, Date.parse(i.timestamp) || 0), 0) > 14 * DAY ? ctx.asOf : an; }
    const a = A.analyzeFleet(ctx, calib, { horizonDays: 90 });
    state.analysis.set(fleetId, { a, at: Date.now() });
    return a;
  })().finally(() => state.inflight.delete(fleetId));
  state.inflight.set(fleetId, p);
  return p;
}
async function allFleetIds() { return [...(await listFleetMeta()).keys()]; }
async function getAllAnalyses() {
  const ids = await allFleetIds();
  const out = [];
  for (const id of ids) { const a = await getAnalysis(id); if (a) out.push(a); }
  return out;
}

// ---------- alerts evaluation ----------
async function evaluateFleet(fleetId, { silent = false } = {}) {
  const a = await getAnalysis(fleetId);
  if (!a || a._.importedOnly) return null; // historical-import-only fleets never raise live predictive alerts
  return alerts.reconcile(a, { silent });
}
async function evaluateAll({ silent = false } = {}) {
  for (const id of await allFleetIds()) { try { await evaluateFleet(id, { silent }); } catch (e) { console.error('[PREDICT] alert evaluation failed for', id, e.message); } }
}

// ---------- invalidation ----------
function invalidateFleet(fleetId) { state.analysis.delete(fleetId); state.ctx.delete(fleetId); state.version++; }
function scheduleEval(fleetId) {
  if (state.evalTimers.has(fleetId)) return;
  const t = setTimeout(async () => {
    state.evalTimers.delete(fleetId);
    try { await evaluateFleet(fleetId); } catch (e) { console.error('[PREDICT] re-evaluation failed:', e.stack); }
  }, 400);
  if (t.unref) t.unref();
  state.evalTimers.set(fleetId, t);
}
// public hook for explicit calls (backend may call predict.onIncident(inc))
function onIncident(inc, change) {
  if (!inc || !inc.fleetId) return;
  if ((change === 'new' || change === undefined) && inc.id && !state.seenNew.has(inc.id)) { state.seenNew.add(inc.id); state.expected++; if (state.seenNew.size > 5000) state.seenNew.clear(); }
  invalidateFleet(inc.fleetId);
  if (inc.source === 'historical_import') return;
  scheduleEval(inc.fleetId);
}

// ---------- SSE (wrap stream without editing it) ----------
function wrapStream() {
  if (stream.__predictWrapped) return;
  stream.__predictWrapped = true;
  const origPublish = stream.publish, origSubscribe = stream.subscribe;
  try { require('../pipeline').onIncident((inc) => { try { onIncident(inc, 'new'); } catch (e) { /* ignore */ } }); } catch (e) { /* pipeline hook optional */ }
  stream.publish = function (incident, change) {
    const r = origPublish.apply(this, arguments);
    try { onIncident(incident, change); } catch (e) { /* never break the SSE hub */ }
    return r;
  };
  if (typeof stream.publishEvent !== 'function') { // fallback for an older hub: capture subscribers ourselves
    stream.subscribe = function (req, res, filter = {}) {
      const c = { res, filter: filter || {} };
      state.sse.add(c);
      req.on('close', () => state.sse.delete(c));
      return origSubscribe.apply(this, arguments);
    };
  }
}
let alertSeq = 0;
function sendAlertSSE(alert, change) {
  persist(alert);
  if (typeof stream.publishEvent === 'function') { try { stream.publishEvent('alert', { ...stripInternal(alert), _change: change }, { fleetId: alert.fleetId }); return; } catch (e) { /* fall through */ } }
  alertSeq++;
  const payload = JSON.stringify({ ...stripInternal(alert), _change: change });
  for (const c of state.sse) {
    if (c.filter && c.filter.fleetId && c.filter.fleetId !== alert.fleetId) continue;
    try { c.res.write(`id: a${alertSeq}\nevent: alert\ndata: ${payload}\n\n`); } catch (e) { state.sse.delete(c); }
  }
}
const stripInternal = (a) => { const { _key, ...r } = a; return r; };
function persist(alert) { try { if (db.put) Promise.resolve(db.put('alert', stripInternal({ ...alert }))).catch(() => {}); } catch (e) { /* best effort */ } }
async function hydrateSaved() {
  try { if (db.list) { const saved = await db.list('alert', {}); if (Array.isArray(saved) && saved.length) alerts.hydrate(saved); } } catch (e) { /* ignore */ }
}

// ---------- lifecycle ----------
async function refreshIfChanged() {
  try {
    const n = await db.countIncidents();
    const sig = [...roster.all()].map((f) => f.id).join(',');
    const newest = n ? (await db.listIncidents({ limit: 1, clone: false }))[0] : null;
    const nid = newest ? newest.id : null;
    const sameNewest = nid === state.newestId || (nid && state.seenNew.has(nid));
    if (n === state.count && sig === state.fleetSig && sameNewest) return;
    if (state.bootAlertsDone && sig === state.fleetSig && n === state.expected && sameNewest) { state.count = n; state.newestId = nid; return; } // growth fully explained by live incidents we already handled
    if (n === state.lastSeen && nid !== state.lastNewest) { state.lastNewest = nid; return; } // still changing (seed running)
    state.lastNewest = nid;
    if (n !== state.lastSeen) { state.lastSeen = n; return; } // wait until the count is stable (seed may still be running)
    const wasEmpty = state.count <= 0;
    const reset = state.count > 0 && n < state.count * 0.8;
    state.count = n; state.expected = n; state.fleetSig = sig; state.newestId = nid;
    if (n === 0) return;
    state.analysis.clear(); state.ctx.clear(); state.version++;
    if (reset) { alerts.clear(); await ensureCalib(true); }
    if (wasEmpty || reset || !state.bootAlertsDone) {
      if (!state.bootAlertsDone && !reset) await hydrateSaved();
      await ensureCalib(wasEmpty || reset);
      await evaluateAll({ silent: true }); // boot / reseed: build alert set from history without flooding SSE
      state.bootAlertsDone = true;
      console.log(`[PREDICT] model ready: ${alerts.counts().open} open predictive alerts from ${n} incidents`);
    } else {
      // external bulk change (batch ingest / import): re-evaluate quietly-ish but publish genuinely new alerts
      await evaluateAll({ silent: false });
    }
  } catch (e) { console.error('[PREDICT] refresh failed:', e.message); }
}
function start() {
  if (state.started) return; state.started = true;
  wrapStream();
  alerts.onChange(sendAlertSSE);
  const kick = () => refreshIfChanged();
  state.timer = setInterval(kick, 1500); if (state.timer.unref) state.timer.unref();
}
function reset() { anchorCache = { n: -1, newest: null, t: 0 };  state.analysis.clear(); state.ctx.clear(); state.calib = null; state.calibCount = 0; state.count = -1; state.bootAlertsDone = false; alerts.clear(); }

module.exports = { start, getAnalysis, getAllAnalyses, allFleetIds, evaluateFleet, evaluateAll, onIncident, ensureCalib, reset, state, listFleetMeta, setClock: (n) => { state.now = n; } };
