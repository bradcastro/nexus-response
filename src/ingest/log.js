// Ingest log + dead letter + health. Every inbound request/event is recorded; failures keep their raw payload for replay.
const db = require('../../db');
const roster = require('../roster');
let n = 0;
const rid = () => 'ing_' + Date.now().toString(36) + (++n).toString(36).padStart(4, '0');

async function record(e) {
  const entry = {
    id: e.id || rid(), receivedAt: e.receivedAt || new Date().toISOString(), createdAt: e.receivedAt || new Date().toISOString(), provider: e.provider || null, fleetId: e.fleetId || null,
    status: e.status, error: e.error || null, latencyMs: e.latencyMs != null ? Math.round(e.latencyMs * 10) / 10 : null, payloadBytes: e.payloadBytes != null ? e.payloadBytes : null, incidentId: e.incidentId || null,
    batchId: e.batchId || null, auth: e.auth || null, statusCode: e.statusCode || null,
  };
  if (e.status === 'rejected' || e.status === 'failed') { entry.payload = e.payload !== undefined ? e.payload : null; entry.rawBody = e.rawBody || null; }
  await db.put('ingest_log', entry);
  return entry;
}
const strip = (e, inc) => { if (inc) return e; const { payload, rawBody, ...rest } = e; return { ...rest, hasPayload: payload != null || rawBody != null, replayed: !!e.replayedAt }; };
async function list({ fleetId, status, provider, limit = 100, includePayload = false } = {}) {
  let rows = await db.list('ingest_log', { fleetId, limit: 100000 });
  if (status) rows = rows.filter((r) => String(status).split(',').includes(r.status));
  if (provider) rows = rows.filter((r) => r.provider === provider);
  return rows.slice(0, limit).map((r) => strip(r, includePayload));
}
const get = (id) => db.get('ingest_log', id);
const update = (e) => db.put('ingest_log', e);

const STALE_MS = 24 * 3600 * 1000;
async function health() {
  const rows = await db.list('ingest_log', { limit: 100000 });
  const now = Date.now();
  const by = new Map();
  for (const r of rows) {
    if (!r.fleetId) continue;
    const k = r.fleetId + '|' + r.provider;
    const e = by.get(k) || { fleetId: r.fleetId, provider: r.provider, lastEventAt: null, events24h: 0, errors24h: 0, lat: [], total: 0 };
    const t = +new Date(r.receivedAt);
    if (r.status === 'accepted' || r.status === 'duplicate') { if (!e.lastEventAt || t > +new Date(e.lastEventAt)) e.lastEventAt = r.receivedAt; e.total++; }
    if (now - t <= STALE_MS) { if (r.status === 'accepted' || r.status === 'duplicate') { e.events24h++; if (r.latencyMs != null) e.lat.push(r.latencyMs); } else if ((r.status === 'rejected' || r.status === 'failed') && !(r.replayStatus === 'accepted' || r.replayStatus === 'duplicate')) e.errors24h++; }
    by.set(k, e);
  }
  const out = [];
  for (const f of roster.all()) {
    const rowsF = [...by.values()].filter((e) => e.fleetId === f.id);
    const list = rowsF.length ? rowsF : [{ fleetId: f.id, provider: f.vendor, lastEventAt: null, events24h: 0, errors24h: 0, lat: [], total: 0 }];
    for (const e of list) {
      let status;
      const tot = e.events24h + e.errors24h;
      if (!e.lastEventAt && e.errors24h === 0) status = 'never_connected';
      else if (e.errors24h >= 2 && e.errors24h / Math.max(1, tot) >= 0.3) status = 'failing';
      else if (!e.lastEventAt || now - +new Date(e.lastEventAt) > STALE_MS) status = 'stale';
      else status = 'healthy';
      out.push({ fleetId: e.fleetId, fleetName: f.name, provider: e.provider, lastEventAt: e.lastEventAt, events24h: e.events24h, errors24h: e.errors24h, avgLatencyMs: e.lat.length ? Math.round((e.lat.reduce((a, b) => a + b, 0) / e.lat.length) * 10) / 10 : null, status });
    }
  }
  return out;
}
module.exports = { record, list, get, update, health };
