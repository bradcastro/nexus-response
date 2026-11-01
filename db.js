// db.js - Data layer for Nexus Response.
// In-memory by default (zero setup). Set DATABASE_URL to use PostgreSQL: the full canonical incident is stored
// as JSONB (column `data`) with a few indexed scalar columns for filtering. Fleets + providers are JSONB docs.
const { Pool } = require('pg');

let pool = null;
let pgReady = null;
const mem = { incidents: new Map(), docs: { fleet: new Map(), provider: new Map() } };

function getPool() {
  if (process.env.DATABASE_URL && !pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: /render\.com|amazonaws|neon\.tech|supabase/.test(process.env.DATABASE_URL) ? { rejectUnauthorized: false } : false,
    });
    pgReady = initSchema().catch((e) => { console.error('[NEXUS] DB schema init failed:', e.message); });
  }
  return pool;
}
async function ready() { const p = getPool(); if (p) await pgReady; return p; }

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS incidents_v2 (
      id TEXT PRIMARY KEY, fleet_id TEXT, status TEXT, category TEXT, event_type TEXT, severity TEXT,
      ts TIMESTAMPTZ, received_at TIMESTAMPTZ, data JSONB NOT NULL
    );
    CREATE INDEX IF NOT EXISTS incidents_v2_fleet ON incidents_v2 (fleet_id, ts DESC);
    CREATE TABLE IF NOT EXISTS nx_docs (kind TEXT, id TEXT, data JSONB NOT NULL, PRIMARY KEY (kind, id));
  `);
  console.log('[NEXUS] PostgreSQL schema ready');
}

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

async function saveIncident(incident) {
  ensureCanonical(incident);
  const p = await ready();
  if (p) {
    await p.query(
      `INSERT INTO incidents_v2 (id, fleet_id, status, category, event_type, severity, ts, received_at, data)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, category=EXCLUDED.category, event_type=EXCLUDED.event_type,
         severity=EXCLUDED.severity, data=EXCLUDED.data`,
      [incident.id, incident.fleetId, incident.status, incident.category, incident.eventType, incident.severity, incident.timestamp, incident.receivedAt, JSON.stringify(incident)]
    );
  } else {
    mem.incidents.set(incident.id, incident);
  }
  return incident;
}

async function getIncident(id) {
  const p = await ready();
  if (p) { const r = await p.query('SELECT data FROM incidents_v2 WHERE id=$1', [id]); return r.rows[0] ? r.rows[0].data : null; }
  const i = mem.incidents.get(id);
  return i ? JSON.parse(JSON.stringify(i)) : null;
}

async function listIncidents({ fleetId, status, category, limit = 100, since, provider } = {}) {
  const p = await ready();
  const statuses = status ? String(status).split(',') : null;
  if (p) {
    const w = [], args = [];
    if (fleetId) { args.push(fleetId); w.push(`fleet_id=$${args.length}`); }
    if (statuses) { args.push(statuses); w.push(`status = ANY($${args.length})`); }
    if (category) { args.push(category); w.push(`category=$${args.length}`); }
    if (since) { args.push(since); w.push(`ts >= $${args.length}`); }
    args.push(limit);
    const r = await p.query(`SELECT data FROM incidents_v2 ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY ts DESC LIMIT $${args.length}`, args);
    return r.rows.map((x) => x.data).filter((i) => !provider || i.provider === provider);
  }
  let rows = [...mem.incidents.values()];
  if (fleetId) rows = rows.filter((i) => i.fleetId === fleetId);
  if (statuses) rows = rows.filter((i) => statuses.includes(i.status));
  if (category) rows = rows.filter((i) => i.category === category);
  if (provider) rows = rows.filter((i) => i.provider === provider);
  if (since) rows = rows.filter((i) => new Date(i.timestamp) >= new Date(since));
  rows.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  return rows.slice(0, limit).map((i) => JSON.parse(JSON.stringify(i)));
}

// mutator(incident) mutates in place (or returns a replacement). Saved and returned. Returns null if not found.
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

async function countIncidents() {
  const p = await ready();
  if (p) { const r = await p.query('SELECT COUNT(*)::int AS n FROM incidents_v2'); return r.rows[0].n; }
  return mem.incidents.size;
}
async function clearIncidents() {
  const p = await ready();
  if (p) await p.query('TRUNCATE incidents_v2'); else mem.incidents.clear();
}

async function saveDoc(kind, doc) {
  const p = await ready();
  if (p) await p.query(`INSERT INTO nx_docs (kind,id,data) VALUES ($1,$2,$3) ON CONFLICT (kind,id) DO UPDATE SET data=EXCLUDED.data`, [kind, doc.id, JSON.stringify(doc)]);
  else mem.docs[kind].set(doc.id, doc);
  return doc;
}
async function listDocs(kind) {
  const p = await ready();
  if (p) return (await p.query('SELECT data FROM nx_docs WHERE kind=$1', [kind])).rows.map((r) => r.data);
  return [...mem.docs[kind].values()];
}
// Fleets (with rosters) and providers
const saveFleet = (f) => saveDoc('fleet', f);
const listFleets = () => listDocs('fleet');
const saveProvider = (pr) => saveDoc('provider', pr);
const listProviders = () => listDocs('provider');

// ---- Legacy API used by motive-poller.js / samsara-poller.js ----
const getIncidents = (status = null) => listIncidents({ status, limit: 500 });
async function updateIncidentStatus(id, status) { await updateIncident(id, (i) => { i.status = status; }); }
const usingPostgres = () => !!process.env.DATABASE_URL;

module.exports = {
  saveIncident, getIncident, listIncidents, updateIncident, addTimeline, countIncidents, clearIncidents,
  saveFleet, listFleets, saveProvider, listProviders, getIncidents, updateIncidentStatus, usingPostgres,
};
