// db.js - Data layer for Nexus Response.
// In-memory by default (zero setup). Set DATABASE_URL to use PostgreSQL (full-fidelity schema, idempotent migrations at boot):
//   incidents_v2 (canonical incident as JSONB + indexed columns), fleets, vehicles, drivers, providers, api_keys,
//   ingest_log, import_jobs, alerts, assessments (uniform columns + JSONB `data`).
// Generic document API for other modules: put(kind, doc) / get(kind, id) / list(kind, filter) / del(kind, id) / findByKey(kind, ukey).
const { Pool } = require('pg');

let pool = null;
let pgReady = null;
const KINDS = { fleet: 'fleets', vehicle: 'vehicles', driver: 'drivers', provider: 'providers', api_key: 'api_keys', ingest_log: 'ingest_log', import_job: 'import_jobs', alert: 'alerts', assessment: 'assessments', comms: 'comms_log', template: 'comms_templates', report: 'reports', job: 'jobs' };
const mem = { incidents: new Map(), byEvent: new Map(), docs: {} };
for (const k of Object.keys(KINDS)) mem.docs[k] = new Map();
const MEM_CAP = { ingest_log: 40000, comms: 60000 };

// ---- migrations (idempotent; safe to run on every boot) ----
const MIGRATIONS = [
  { version: 1, name: 'incidents_v2 base', sql: [
    `CREATE TABLE IF NOT EXISTS incidents_v2 (id TEXT PRIMARY KEY, fleet_id TEXT, status TEXT, category TEXT, event_type TEXT, severity TEXT, ts TIMESTAMPTZ, received_at TIMESTAMPTZ, data JSONB NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS incidents_v2_fleet ON incidents_v2 (fleet_id, ts DESC)`,
  ] },
  { version: 2, name: 'v3 full-fidelity schema', sql: [
    `ALTER TABLE incidents_v2 ADD COLUMN IF NOT EXISTS provider TEXT`,
    `ALTER TABLE incidents_v2 ADD COLUMN IF NOT EXISTS provider_event_id TEXT`,
    `ALTER TABLE incidents_v2 ADD COLUMN IF NOT EXISTS source TEXT`,
    `ALTER TABLE incidents_v2 ADD COLUMN IF NOT EXISTS import_job_id TEXT`,
    `CREATE UNIQUE INDEX IF NOT EXISTS incidents_v2_event ON incidents_v2 (provider, provider_event_id) WHERE provider_event_id IS NOT NULL`,
    `CREATE INDEX IF NOT EXISTS incidents_v2_status ON incidents_v2 (status)`,
    `CREATE INDEX IF NOT EXISTS incidents_v2_import ON incidents_v2 (import_job_id) WHERE import_job_id IS NOT NULL`,
    ...Object.values(KINDS).flatMap((t) => [
      `CREATE TABLE IF NOT EXISTS ${t} (id TEXT PRIMARY KEY, fleet_id TEXT, status TEXT, ukey TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), data JSONB NOT NULL)`,
      `CREATE INDEX IF NOT EXISTS ${t}_fleet ON ${t} (fleet_id, created_at DESC)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS ${t}_ukey ON ${t} (ukey) WHERE ukey IS NOT NULL`,
    ]),
  ] },
  { version: 3, name: 'v4 ops tables (comms, templates, reports, tow jobs)', sql: ['comms_log', 'comms_templates', 'reports', 'jobs'].flatMap((t) => [
    `CREATE TABLE IF NOT EXISTS ${t} (id TEXT PRIMARY KEY, fleet_id TEXT, status TEXT, ukey TEXT, created_at TIMESTAMPTZ DEFAULT NOW(), data JSONB NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS ${t}_fleet ON ${t} (fleet_id, created_at DESC)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS ${t}_ukey ON ${t} (ukey) WHERE ukey IS NOT NULL`,
  ]) },
];

function getPool() {
  if (process.env.DATABASE_URL && !pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: /render\.com|amazonaws|neon\.tech|supabase/.test(process.env.DATABASE_URL) ? { rejectUnauthorized: false } : false,
    });
    pgReady = migrate().catch((e) => { console.error('[NEXUS] DB migration failed:', e.message); throw e; });
  }
  return pool;
}
async function migrate() {
  await pool.query(`CREATE TABLE IF NOT EXISTS nx_migrations (version INT PRIMARY KEY, name TEXT, applied_at TIMESTAMPTZ DEFAULT NOW())`);
  const done = new Set((await pool.query('SELECT version FROM nx_migrations')).rows.map((r) => r.version));
  for (const m of MIGRATIONS) {
    if (done.has(m.version)) continue;
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      for (const q of m.sql) await c.query(q);
      await c.query('INSERT INTO nx_migrations (version, name) VALUES ($1,$2) ON CONFLICT DO NOTHING', [m.version, m.name]);
      await c.query('COMMIT');
      console.log(`[NEXUS] migration ${m.version} applied (${m.name})`);
    } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }
  console.log('[NEXUS] PostgreSQL schema ready');
}
async function ready() { const p = getPool(); if (p) await pgReady; return p; }

// Make legacy-shaped objects (from the old pollers) look enough like the canonical schema.
function ensureCanonical(i) {
  if (i.provider && i.timeline) return i;
  i.provider = i.provider || i.source || 'motive';
  i.fleetId = i.fleetId || 'fleet_goodyear';
  i.fleetName = i.fleetName || i.customerName || 'Goodyear Towing';
  i.category = i.category || 'safety';
  i.status = i.status || 'pending';
  i.receivedAt = i.receivedAt || new Date().toISOString();
  i.timestamp = i.timestamp || i.receivedAt;
  i.timeline = i.timeline || [{ t: i.receivedAt, actor: 'system', action: 'received', note: `Legacy ${i.provider} poller` }];
  i.raw = i.raw || i.rawPayload || null;
  return i;
}
const evKey = (p, e) => `${p}\u0001${e}`;

const INS_COLS = '(id, fleet_id, status, category, event_type, severity, ts, received_at, provider, provider_event_id, source, import_job_id, data)';
const INS_UPSERT = ' ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, category=EXCLUDED.category, event_type=EXCLUDED.event_type, severity=EXCLUDED.severity, data=EXCLUDED.data';
const insRow = (i) => [i.id, i.fleetId, i.status, i.category, i.eventType, i.severity, i.timestamp, i.receivedAt, i.provider, i.providerEventId || null, i.source || null, (i.import && i.import.jobId) || null, JSON.stringify(i)];

async function saveIncident(incident) {
  ensureCanonical(incident);
  const p = await ready();
  if (p) await p.query(`INSERT INTO incidents_v2 ${INS_COLS} VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)${INS_UPSERT}`, insRow(incident));
  else {
    mem.incidents.set(incident.id, incident);
    if (incident.providerEventId) mem.byEvent.set(evKey(incident.provider, incident.providerEventId), incident.id);
  }
  return incident;
}
async function saveIncidentsBulk(list) {
  const p = await ready();
  if (!p) { for (const i of list) await saveIncident(i); return list.length; }
  for (let o = 0; o < list.length; o += 200) {
    const chunk = list.slice(o, o + 200).map(ensureCanonical);
    const args = []; const ph = chunk.map((i, n) => { args.push(...insRow(i)); return `(${Array.from({ length: 13 }, (_, k) => `$${n * 13 + k + 1}`).join(',')})`; });
    await p.query(`INSERT INTO incidents_v2 ${INS_COLS} VALUES ${ph.join(',')}${INS_UPSERT}`, args);
  }
  return list.length;
}

async function getIncident(id) {
  const p = await ready();
  if (p) { const r = await p.query('SELECT data FROM incidents_v2 WHERE id=$1', [id]); return r.rows[0] ? r.rows[0].data : null; }
  const i = mem.incidents.get(id);
  return i ? JSON.parse(JSON.stringify(i)) : null;
}
// Idempotency lookup on (provider, providerEventId)
async function findByProviderEvent(provider, eventId) {
  if (eventId == null) return null;
  const p = await ready();
  if (p) { const r = await p.query('SELECT data FROM incidents_v2 WHERE provider=$1 AND provider_event_id=$2 LIMIT 1', [provider, String(eventId)]); return r.rows[0] ? r.rows[0].data : null; }
  const id = mem.byEvent.get(evKey(provider, String(eventId)));
  return id ? JSON.parse(JSON.stringify(mem.incidents.get(id))) : null;
}

// opts.clone=false returns shared references (read-only use, much faster for analytics)
async function listIncidents({ fleetId, status, category, limit = 100, since, until, provider, source, notSource, importJobId, clone = true } = {}) {
  const p = await ready();
  const statuses = status ? String(status).split(',') : null;
  if (p) {
    const w = [], args = [];
    if (fleetId) { args.push(fleetId); w.push(`fleet_id=$${args.length}`); }
    if (statuses) { args.push(statuses); w.push(`status = ANY($${args.length})`); }
    if (category) { args.push(category); w.push(`category=$${args.length}`); }
    if (since) { args.push(since); w.push(`ts >= $${args.length}`); }
    if (until) { args.push(until); w.push(`ts <= $${args.length}`); }
    if (provider) { args.push(provider); w.push(`provider=$${args.length}`); }
    if (source) { args.push(source); w.push(`source=$${args.length}`); }
    if (notSource) { args.push(notSource); w.push(`(source IS NULL OR source<>$${args.length})`); }
    if (importJobId) { args.push(importJobId); w.push(`import_job_id=$${args.length}`); }
    args.push(limit);
    const r = await p.query(`SELECT data FROM incidents_v2 ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY ts DESC LIMIT $${args.length}`, args);
    return r.rows.map((x) => x.data);
  }
  const sinceT = since ? +new Date(since) : null, untilT = until ? +new Date(until) : null;
  let rows = [];
  for (const i of mem.incidents.values()) {
    if (fleetId && i.fleetId !== fleetId) continue;
    if (statuses && !statuses.includes(i.status)) continue;
    if (category && i.category !== category) continue;
    if (provider && i.provider !== provider) continue;
    if (source && i.source !== source) continue;
    if (notSource && i.source === notSource) continue;
    if (importJobId && !(i.import && i.import.jobId === importJobId)) continue;
    if (sinceT != null || untilT != null) { const t = +new Date(i.timestamp); if ((sinceT != null && t < sinceT) || (untilT != null && t > untilT)) continue; }
    rows.push(i);
  }
  rows.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));
  rows = rows.slice(0, limit);
  return clone ? rows.map((i) => JSON.parse(JSON.stringify(i))) : rows;
}

async function updateIncident(id, mutator) {
  const inc = await getIncident(id);
  if (!inc) return null;
  const out = (await mutator(inc)) || inc;
  await saveIncident(out);
  return out;
}
function addTimeline(inc, actor, action, note, t) {
  (inc.timeline = inc.timeline || []).push({ t: t || new Date().toISOString(), actor, action, note: note || '' });
  return inc;
}
async function countIncidents(filter = {}) {
  const p = await ready();
  if (p) { const r = await p.query('SELECT COUNT(*)::int AS n FROM incidents_v2' + (filter.fleetId ? ' WHERE fleet_id=$1' : ''), filter.fleetId ? [filter.fleetId] : []); return r.rows[0].n; }
  if (!filter.fleetId) return mem.incidents.size;
  let n = 0; for (const i of mem.incidents.values()) if (i.fleetId === filter.fleetId) n++; return n;
}
async function clearIncidents({ keepImported = false } = {}) {
  const p = await ready();
  if (p) await p.query(keepImported ? `DELETE FROM incidents_v2 WHERE source IS DISTINCT FROM 'historical_import'` : 'TRUNCATE incidents_v2');
  else {
    for (const [id, i] of mem.incidents) if (!(keepImported && i.source === 'historical_import')) mem.incidents.delete(id);
    mem.byEvent.clear();
    for (const i of mem.incidents.values()) if (i.providerEventId) mem.byEvent.set(evKey(i.provider, i.providerEventId), i.id);
  }
}
async function deleteIncidentsByJob(jobId) {
  const p = await ready();
  if (p) { await p.query('DELETE FROM incidents_v2 WHERE import_job_id=$1', [jobId]); return; }
  for (const [id, i] of mem.incidents) if (i.import && i.import.jobId === jobId) { mem.incidents.delete(id); if (i.providerEventId) mem.byEvent.delete(evKey(i.provider, i.providerEventId)); }
}

async function deleteIncidentsByFleet(fleetId) {
  const p = await ready();
  if (p) { await p.query('DELETE FROM incidents_v2 WHERE fleet_id=$1', [fleetId]); return; }
  for (const [id, i] of mem.incidents) if (i.fleetId === fleetId) { mem.incidents.delete(id); if (i.providerEventId) mem.byEvent.delete(evKey(i.provider, i.providerEventId)); }
}

// ---- generic documents ----
const tsOf = (d) => d.createdAt || d.receivedAt || d.generatedAt || new Date().toISOString();
async function put(kind, doc, { ukey } = {}) {
  const t = KINDS[kind]; if (!t) throw new Error('unknown kind ' + kind);
  const p = await ready();
  if (p) {
    await p.query(`INSERT INTO ${t} (id, fleet_id, status, ukey, created_at, data) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (id) DO UPDATE SET fleet_id=EXCLUDED.fleet_id, status=EXCLUDED.status, ukey=EXCLUDED.ukey, data=EXCLUDED.data`,
    [doc.id, doc.fleetId || null, doc.status || null, ukey !== undefined ? ukey : (doc.ukey || null), tsOf(doc), JSON.stringify(doc)]);
  } else {
    const m = mem.docs[kind]; m.set(doc.id, doc);
    const cap = MEM_CAP[kind];
    if (cap && m.size > cap) { let n = m.size - cap; for (const k of m.keys()) { m.delete(k); if (--n <= 0) break; } }
  }
  return doc;
}
async function get(kind, id) {
  const p = await ready();
  if (p) { const r = await p.query(`SELECT data FROM ${KINDS[kind]} WHERE id=$1`, [id]); return r.rows[0] ? r.rows[0].data : null; }
  return mem.docs[kind].get(id) || null;
}
async function findByKey(kind, ukey) {
  const p = await ready();
  if (p) { const r = await p.query(`SELECT data FROM ${KINDS[kind]} WHERE ukey=$1`, [ukey]); return r.rows[0] ? r.rows[0].data : null; }
  for (const d of mem.docs[kind].values()) if ((d.ukey || d.hash) === ukey) return d;
  return null;
}
async function list(kind, { fleetId, status, limit = 100, since } = {}) {
  const p = await ready();
  if (p) {
    const w = [], args = [];
    if (fleetId) { args.push(fleetId); w.push(`fleet_id=$${args.length}`); }
    if (status) { args.push(status); w.push(`status=$${args.length}`); }
    if (since) { args.push(since); w.push(`created_at >= $${args.length}`); }
    args.push(limit);
    return (await p.query(`SELECT data FROM ${KINDS[kind]} ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY created_at DESC LIMIT $${args.length}`, args)).rows.map((r) => r.data);
  }
  let rows = [...mem.docs[kind].values()];
  if (fleetId) rows = rows.filter((d) => d.fleetId === fleetId);
  if (status) rows = rows.filter((d) => d.status === status);
  if (since) rows = rows.filter((d) => tsOf(d) >= since);
  rows.sort((a, b) => (tsOf(a) < tsOf(b) ? 1 : tsOf(a) > tsOf(b) ? -1 : 0));
  return rows.slice(0, limit);
}
async function del(kind, id) {
  const p = await ready();
  if (p) await p.query(`DELETE FROM ${KINDS[kind]} WHERE id=$1`, [id]); else mem.docs[kind].delete(id);
}
async function clearKind(kind, fleetId) {
  const p = await ready();
  if (p) await p.query(`DELETE FROM ${KINDS[kind]}${fleetId ? ' WHERE fleet_id=$1' : ''}`, fleetId ? [fleetId] : []);
  else for (const [id, d] of mem.docs[kind]) if (!fleetId || d.fleetId === fleetId) mem.docs[kind].delete(id);
}

// back-compat helpers
const saveFleet = (f) => put('fleet', f);
const listFleets = () => list('fleet', { limit: 1000 });
const saveProvider = (pr) => put('provider', pr);
const listProviders = () => list('provider', { limit: 1000 });
const getIncidents = (status = null) => listIncidents({ status, limit: 500 });
async function updateIncidentStatus(id, status) { await updateIncident(id, (i) => { i.status = status; }); }
const usingPostgres = () => !!process.env.DATABASE_URL;

module.exports = {
  saveIncident, saveIncidentsBulk, getIncident, findByProviderEvent, listIncidents, updateIncident, addTimeline, countIncidents, clearIncidents, deleteIncidentsByJob, deleteIncidentsByFleet,
  put, get, list, del, findByKey, clearKind, saveFleet, listFleets, saveProvider, listProviders, getIncidents, updateIncidentStatus, usingPostgres, KINDS,
};
