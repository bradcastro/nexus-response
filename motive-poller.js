// motive-poller.js — Polls Motive Driver Performance Events API every 60 seconds
// Endpoint: GET /v1/driver_performance_events
// Auth: x-api-key header (use Client Secret as API key)

const { saveIncident, getIncidents } = require('./db');

const MOTIVE_BASE = 'https://api.gomotive.com';
const POLL_INTERVAL_MS = 60 * 1000;

let pollTimer = null;
let knownEventIds = new Set();
let lastPollTime = null;

// ── Boot ──────────────────────────────────────────────────────────────────────
async function startPoller() {
  const apiKey = process.env.MOTIVE_CLIENT_SECRET || process.env.MOTIVE_API_KEY;
  if (!apiKey) {
    console.log('[MOTIVE] No API key configured — poller not started');
    return;
  }

  console.log('[MOTIVE] Starting driver performance event poller (60s interval)');

  // Seed lastPollTime to 24 hours ago to catch recent events on first run
  const yesterday = new Date();
  yesterday.setHours(yesterday.getHours() - 24);
  lastPollTime = yesterday.toISOString().split('T')[0]; // YYYY-MM-DD format

  // Load existing IDs to avoid duplicates on restart
  try {
    const existing = await getIncidents();
    existing.forEach(i => { if (i.id) knownEventIds.add(i.id); });
    console.log(`[MOTIVE] Loaded ${knownEventIds.size} existing incident IDs`);
  } catch (e) { /* ok if empty */ }

  await poll();
  pollTimer = setInterval(poll, POLL_INTERVAL_MS);
}

function stopPoller() {
  if (pollTimer) clearInterval(pollTimer);
}

// ── Poll ──────────────────────────────────────────────────────────────────────
async function poll() {
  const apiKey = process.env.MOTIVE_CLIENT_SECRET || process.env.MOTIVE_API_KEY;
  if (!apiKey) return;

  try {
    const params = new URLSearchParams({
      per_page: 25,
      start_date: lastPollTime,
      event_types: 'hard_brake,hard_accel,hard_corner'
    });

    const url = `${MOTIVE_BASE}/v1/driver_performance_events?${params.toString()}`;
    console.log(`[MOTIVE] Polling: ${url}`);

    const res = await fetch(url, {
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json'
      }
    });

    if (!res.ok) {
      const err = await res.text();
      console.error(`[MOTIVE] API error ${res.status}:`, err.substring(0, 200));
      return;
    }

    const data = await res.json();
    const events = data.driver_performance_events || [];

    if (events.length === 0) {
      console.log('[MOTIVE] Poll complete — no new performance events');
      return;
    }

    console.log(`[MOTIVE] ${events.length} performance event(s) found`);

    for (const wrapper of events) {
      // Motive wraps each event: { driver_performance_event: { ... } }
      const event = wrapper.driver_performance_event || wrapper;
      const incident = normalizeEvent(event);

      if (knownEventIds.has(incident.id)) continue;
      knownEventIds.add(incident.id);

      await saveIncident(incident);
      console.log(`[MOTIVE] ✓ Saved: ${incident.id} | ${incident.eventType} | ${incident.severity} | ${incident.location?.address || 'no location'}`);
    }

    // Advance window to today so we don't re-fetch old events
    lastPollTime = new Date().toISOString().split('T')[0];

  } catch (err) {
    console.error('[MOTIVE] Poll error:', err.message);
  }
}

// ── Normalize ─────────────────────────────────────────────────────────────────
function normalizeEvent(event) {
  const vehicle = event.vehicle || {};
  const driver = event.driver || {};

  return {
    id: `MOTIVE-${event.id || Date.now()}`,
    source: 'motive',
    rawPayload: event,
    eventType: event.type || 'unknown',
    severity: classifySeverity(event.type, event.intensity),
    status: 'pending',
    receivedAt: new Date().toISOString(),
    timestamp: event.start_time || new Date().toISOString(),
    vehicle: {
      vin: vehicle.vin || null,
      make: vehicle.make || null,
      model: vehicle.model || null,
      year: vehicle.year || null,
      licensePlate: vehicle.number || null,
      id: vehicle.id || null
    },
    driver: {
      id: driver.id || null,
      name: driver.first_name ? `${driver.first_name} ${driver.last_name || ''}`.trim() : null,
      phone: driver.phone_number || null
    },
    location: {
      lat: event.lat || null,
      lng: event.lon || null,
      address: event.location || null,
      speed_mph: event.start_speed ? Math.round(event.start_speed * 0.621371) : null
    },
    videoUrl: event.video_url || null,
    fleetId: vehicle.number || null
  };
}

function classifySeverity(type, intensity) {
  const t = (type || '').toLowerCase();
  // Parse intensity value e.g. "-19.1 kph/s" or "16.0 kph/s"
  const intensityVal = intensity ? Math.abs(parseFloat(intensity)) : 0;

  if (t === 'hard_brake' && intensityVal >= 15) return 'critical';
  if (t === 'hard_brake') return 'high';
  if (t === 'hard_accel' && intensityVal >= 18) return 'high';
  if (t === 'hard_accel') return 'medium';
  if (t === 'hard_corner') return 'medium';
  return 'medium';
}

module.exports = { startPoller, stopPoller };
