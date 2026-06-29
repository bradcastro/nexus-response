// motive-poller.js — Polls Motive Safety Events API every 60 seconds
// Uses OAuth 2.0 client credentials to authenticate, then fetches
// driver_safety_events and feeds them into the Nexus incident pipeline.

const { saveIncident, getIncidents } = require('./db');

const MOTIVE_TOKEN_URL = 'https://api.gomotive.com/oauth/token';
const MOTIVE_SAFETY_URL = 'https://api.gomotive.com/v1/driver_safety_events';
const MOTIVE_VEHICLES_URL = 'https://api.gomotive.com/v1/vehicles';
const POLL_INTERVAL_MS = 60 * 1000; // 60 seconds

let accessToken = null;
let tokenExpiresAt = 0;
let pollTimer = null;
let lastEventTimestamp = null; // track so we don't re-import duplicates
let knownEventIds = new Set();

// ── Boot ──────────────────────────────────────────────────────────────────────
async function startPoller() {
  if (!process.env.MOTIVE_CLIENT_ID || !process.env.MOTIVE_CLIENT_SECRET) {
    console.log('[MOTIVE] Client ID or Secret not configured — poller not started');
    return;
  }
  console.log('[MOTIVE] Starting safety event poller (60s interval)');

  // Seed lastEventTimestamp to now so we only pull new events going forward
  lastEventTimestamp = new Date().toISOString();

  // Load existing incident IDs to avoid duplicates on restart
  try {
    const existing = await getIncidents();
    existing.forEach(i => {
      if (i.id) knownEventIds.add(i.id);
    });
  } catch (e) { /* ok if empty */ }

  await poll(); // run immediately on boot
  pollTimer = setInterval(poll, POLL_INTERVAL_MS);
}

function stopPoller() {
  if (pollTimer) clearInterval(pollTimer);
}

// ── OAuth Token ───────────────────────────────────────────────────────────────
async function getAccessToken() {
  const now = Date.now();
  if (accessToken && now < tokenExpiresAt - 30000) {
    return accessToken; // reuse existing token
  }

  console.log('[MOTIVE] Fetching new OAuth access token...');
  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: process.env.MOTIVE_CLIENT_ID,
    client_secret: process.env.MOTIVE_CLIENT_SECRET,
  });

  const res = await fetch(MOTIVE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token fetch failed: ${res.status} — ${err}`);
  }

  const data = await res.json();
  accessToken = data.access_token;
  tokenExpiresAt = now + (data.expires_in || 3600) * 1000;
  console.log('[MOTIVE] Access token obtained, expires in', data.expires_in || 3600, 'seconds');
  return accessToken;
}

// ── Poll Safety Events ────────────────────────────────────────────────────────
async function poll() {
  try {
    const token = await getAccessToken();

    const params = new URLSearchParams({
      per_page: 25,
      expand: 'driver,vehicle'
    });

    // Only fetch events since last poll
    if (lastEventTimestamp) {
      params.set('start_time', lastEventTimestamp);
    }

    const url = `${MOTIVE_SAFETY_URL}?${params.toString()}`;
    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });

    if (res.status === 401) {
      // Token expired — clear and retry next cycle
      accessToken = null;
      console.warn('[MOTIVE] Token expired, will refresh next poll');
      return;
    }

    if (!res.ok) {
      const err = await res.text();
      console.error('[MOTIVE] Safety events API error:', res.status, err);
      return;
    }

    const data = await res.json();
    const events = data.driver_safety_events || data.safety_events || data.events || [];

    if (events.length === 0) {
      console.log('[MOTIVE] Poll complete — no new safety events');
      return;
    }

    console.log(`[MOTIVE] ${events.length} safety event(s) received`);

    let newest = lastEventTimestamp;
    for (const event of events) {
      const incident = normalizeMotiveSafetyEvent(event);

      // Skip duplicates
      if (knownEventIds.has(incident.id)) continue;
      knownEventIds.add(incident.id);

      await saveIncident(incident);
      console.log(`[MOTIVE] Saved incident: ${incident.id} | ${incident.eventType} | ${incident.severity}`);

      // Track newest timestamp
      if (incident.timestamp && incident.timestamp > newest) {
        newest = incident.timestamp;
      }
    }

    // Advance the window so next poll only gets newer events
    if (newest !== lastEventTimestamp) {
      lastEventTimestamp = newest;
    }

  } catch (err) {
    console.error('[MOTIVE] Poll error:', err.message);
  }
}

// ── Normalize Motive Safety Event → Nexus Incident ───────────────────────────
function normalizeMotiveSafetyEvent(event) {
  const eventType = event.event_type || event.type || 'unknown';
  const vehicle = event.vehicle || {};
  const driver = event.driver || {};
  const location = event.location || {};

  return {
    id: `MOTIVE-${event.id || Date.now()}`,
    source: 'motive',
    rawPayload: event,
    eventType: eventType,
    severity: classifySeverity(eventType),
    status: 'pending',
    receivedAt: new Date().toISOString(),
    timestamp: event.occurred_at || event.created_at || new Date().toISOString(),
    vehicle: {
      vin: vehicle.vin || null,
      make: vehicle.make || null,
      model: vehicle.model || null,
      year: vehicle.year || null,
      licensePlate: vehicle.license_plate_number || vehicle.license_plate || null,
      id: vehicle.id || null
    },
    driver: {
      id: driver.id || null,
      name: driver.name ? `${driver.first_name || ''} ${driver.last_name || ''}`.trim() : null,
      phone: driver.phone_number || null
    },
    location: {
      lat: location.lat || event.lat || null,
      lng: location.lon || location.lng || event.lon || null,
      address: location.formatted_address || null,
      speed_mph: event.speed_mph || event.speed || null
    },
    videoUrl: event.video_url || event.dashcam_clip_url || null,
    fleetId: event.fleet_id || vehicle.fleet_id || null
  };
}

function classifySeverity(type) {
  const t = (type || '').toLowerCase();
  if (t.includes('collision') || t.includes('accident') || t.includes('crash') || t.includes('rollover')) return 'critical';
  if (t.includes('harsh_brake') || t.includes('hard_brake') || t.includes('first_responder')) return 'high';
  if (t.includes('harsh_accel') || t.includes('harsh_turn') || t.includes('distraction')) return 'medium';
  if (t.includes('speeding') || t.includes('following')) return 'low';
  return 'medium';
}

module.exports = { startPoller, stopPoller };
