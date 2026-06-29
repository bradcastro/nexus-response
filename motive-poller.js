// motive-poller.js — Polls Motive Driver Performance Events API every 60 seconds
// Auth: x-api-key header using MOTIVE_API_KEY from Render environment

const { saveIncident, getIncidents } = require('./db');

const MOTIVE_BASE = 'https://api.gomotive.com';
const POLL_INTERVAL_MS = 60 * 1000;

let pollTimer = null;
let knownEventIds = new Set();
let startDate = null;

// ── Boot ──────────────────────────────────────────────────────────────────────
async function startPoller() {
  const apiKey = process.env.MOTIVE_API_KEY;
  if (!apiKey) {
    console.log('[MOTIVE] MOTIVE_API_KEY not set — poller not started');
    return;
  }

  console.log('[MOTIVE] Starting performance event poller (60s interval)');

  // Pull last 7 days on first run
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  startDate = weekAgo.toISOString().split('T')[0];

  try {
    const existing = await getIncidents();
    existing.forEach(i => { if (i.id) knownEventIds.add(i.id); });
    console.log(`[MOTIVE] Tracking ${knownEventIds.size} existing incidents`);
  } catch (e) {}

  await poll();
  pollTimer = setInterval(poll, POLL_INTERVAL_MS);
}

function stopPoller() {
  if (pollTimer) clearInterval(pollTimer);
}

// ── Poll ──────────────────────────────────────────────────────────────────────
async function poll() {
  const apiKey = process.env.MOTIVE_API_KEY;
  if (!apiKey) return;

  try {
    const params = new URLSearchParams({
      per_page: 25,
      start_date: startDate,
      event_types: ["hard_brake", "hard_accel", "hard_corner"]
    });

    const url = `${MOTIVE_BASE}/v1/driver_performance_events?${params}`;
    console.log(`[MOTIVE] Polling performance events from ${startDate}...`);

    const res = await fetch(url, {
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json'
      }
    });

    if (!res.ok) {
      const err = await res.text();
      console.error(`[MOTIVE] API error ${res.status}:`, err.substring(0, 300));
      return;
    }

    const data = await res.json();
    const events = data.driver_performance_events || [];

    if (!events.length) {
      console.log('[MOTIVE] No new performance events');
      return;
    }

    console.log(`[MOTIVE] ${events.length} event(s) received`);
    let saved = 0;

    for (const wrapper of events) {
      const event = wrapper.driver_performance_event || wrapper;
      const incident = normalizeEvent(event);

      if (knownEventIds.has(incident.id)) continue;
      knownEventIds.add(incident.id);
      await saveIncident(incident);
      console.log(`[MOTIVE] ✓ ${incident.id} | ${incident.eventType} | ${incident.severity} | ${incident.location?.address || 'no location'}`);
      saved++;
    }

    if (saved > 0) {
      console.log(`[MOTIVE] ${saved} new incident(s) added to dashboard`);
      startDate = new Date().toISOString().split('T')[0];
    }

  } catch (err) {
    console.error('[MOTIVE] Poll error:', err.message);
  }
}

// ── Normalize Motive event → Nexus incident ───────────────────────────────────
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
  const val = intensity ? Math.abs(parseFloat(intensity)) : 0;
  if (t === 'hard_brake' && val >= 15) return 'critical';
  if (t === 'hard_brake') return 'high';
  if (t === 'hard_accel' && val >= 18) return 'high';
  if (t === 'hard_accel') return 'medium';
  if (t === 'hard_corner') return 'medium';
  return 'medium';
}

module.exports = { startPoller, stopPoller };
