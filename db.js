// db.js — Data layer for Nexus Response
// Currently uses in-memory storage so the POC runs with zero database setup.
// PostgreSQL is wired in and ready — just set DATABASE_URL in your environment
// variables on Render and it switches automatically.

const { Pool } = require('pg');

let pool = null;
const inMemoryStore = { incidents: [] };

function getPool() {
  if (process.env.DATABASE_URL && !pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes('render.com')
        ? { rejectUnauthorized: false }
        : false
    });
    initSchema().catch(err =>
      console.error('[NEXUS] DB schema init failed:', err.message)
    );
  }
  return pool;
}

async function initSchema() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS incidents (
        id           TEXT PRIMARY KEY,
        source       TEXT,
        event_type   TEXT,
        severity     TEXT,
        status       TEXT DEFAULT 'pending',
        received_at  TIMESTAMPTZ DEFAULT NOW(),
        timestamp    TIMESTAMPTZ,
        vehicle      JSONB,
        driver       JSONB,
        location     JSONB,
        video_url    TEXT,
        fleet_id     TEXT,
        raw_payload  JSONB
      );
    `);
    console.log('[NEXUS] PostgreSQL schema ready');
  } finally {
    client.release();
  }
}

// ─── Save Incident ─────────────────────────────────────────────────────────────
async function saveIncident(incident) {
  const db = getPool();

  if (db) {
    await db.query(
      `INSERT INTO incidents
        (id, source, event_type, severity, status, received_at, timestamp,
         vehicle, driver, location, video_url, fleet_id, raw_payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (id) DO NOTHING`,
      [
        incident.id,
        incident.source || 'motive',
        incident.eventType,
        incident.severity,
        incident.status || 'pending',
        incident.receivedAt,
        incident.timestamp,
        JSON.stringify(incident.vehicle),
        JSON.stringify(incident.driver),
        JSON.stringify(incident.location),
        incident.videoUrl,
        incident.fleetId,
        JSON.stringify(incident.rawPayload || incident)
      ]
    );
  } else {
    // In-memory fallback
    inMemoryStore.incidents.unshift({ ...incident });
    // Keep last 100 incidents in memory
    if (inMemoryStore.incidents.length > 100) {
      inMemoryStore.incidents = inMemoryStore.incidents.slice(0, 100);
    }
  }
}

// ─── Get Incidents ─────────────────────────────────────────────────────────────
async function getIncidents(status = null) {
  const db = getPool();

  if (db) {
    const query = status
      ? `SELECT * FROM incidents WHERE status = $1 ORDER BY received_at DESC LIMIT 50`
      : `SELECT * FROM incidents ORDER BY received_at DESC LIMIT 50`;
    const params = status ? [status] : [];
    const result = await db.query(query, params);
    return result.rows.map(normalizeDbRow);
  } else {
    return status
      ? inMemoryStore.incidents.filter(i => i.status === status)
      : inMemoryStore.incidents;
  }
}

// ─── Update Incident Status ────────────────────────────────────────────────────
async function updateIncidentStatus(id, status) {
  const db = getPool();

  if (db) {
    await db.query(
      `UPDATE incidents SET status = $1 WHERE id = $2`,
      [status, id]
    );
  } else {
    const incident = inMemoryStore.incidents.find(i => i.id === id);
    if (incident) incident.status = status;
  }
}

function normalizeDbRow(row) {
  return {
    id: row.id,
    source: row.source,
    eventType: row.event_type,
    severity: row.severity,
    status: row.status,
    receivedAt: row.received_at,
    timestamp: row.timestamp,
    vehicle: row.vehicle,
    driver: row.driver,
    location: row.location,
    videoUrl: row.video_url,
    fleetId: row.fleet_id
  };
}

module.exports = { saveIncident, getIncidents, updateIncidentStatus };
