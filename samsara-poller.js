// samsara-poller.js — Polls Samsara Safety Events API for Elite Wrecker Service
// Endpoint: GET /fleet/safety-events
// Auth: Bearer token (API token from Samsara dashboard)

const { saveIncident, getIncidents } = require('./db');

const SAMSARA_BASE = 'https://api.samsara.com';
const POLL_INTERVAL_MS = 60 * 1000;

let pollTimer = null;
let knownEventIds = new Set();
let startTime = null;

const driverCache = new Map();
const vehicleCache = new Map();

async function startSamsaraPoller() {
  const apiKey = process.env.SAMSARA_API_KEY;
  if (!apiKey) {
    console.log('[SAMSARA] SAMSARA_API_KEY not set — poller not started');
    return;
  }
  console.log('[SAMSARA] Starting safety event poller for Elite Wrecker Service');

  const monthAgo = new Date();
  monthAgo.setDate(monthAgo.getDate() - 14);
  startTime = monthAgo.toISOString();

  try {
    const existing = await getIncidents();
    existing.forEach(i => { if (i.id) knownEventIds.add(i.id); });
  } catch (e) {}

  await poll();
  pollTimer = setInterval(poll, POLL_INTERVAL_MS);
}

function stopSamsaraPoller() {
  if (pollTimer) clearInterval(pollTimer);
}

// ── Driver Lookup ──────────────────────────────────────────────────────────────
async function fetchSamsaraDriver(driverId) {
  if (!driverId) return null;
  if (driverCache.has(driverId)) return driverCache.get(driverId);
  const apiKey = process.env.SAMSARA_API_KEY;
  try {
    const res = await fetch(`${SAMSARA_BASE}/fleet/drivers/${driverId}`, {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
    });
    if (!res.ok) return null;
    const data = await res.json();
    const d = data.data || data;
    const details = {
      name: d.name || null,
      phone: d.phone || null,
      email: d.username || d.email || null
    };
    driverCache.set(driverId, details);
    return details;
  } catch (err) {
    console.error('[SAMSARA] Driver fetch error:', err.message);
    return null;
  }
}

// ── Vehicle Lookup ─────────────────────────────────────────────────────────────
async function fetchSamsaraVehicle(vehicleId) {
  if (!vehicleId) return null;
  if (vehicleCache.has(vehicleId)) return vehicleCache.get(vehicleId);
  const apiKey = process.env.SAMSARA_API_KEY;
  try {
    const res = await fetch(`${SAMSARA_BASE}/fleet/vehicles/${vehicleId}`, {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
    });
    if (!res.ok) return null;
    const data = await res.json();
    const v = data.data || data;
    const details = {
      vin: v.vin || null,
      make: v.make || null,
      model: v.model || null,
      year: v.year || null,
      plate: v.licensePlate || null,
      odometer: v.staticAssignedDriver ? null : null, // odometer comes from separate stats endpoint
    };
    vehicleCache.set(vehicleId, details);
    return details;
  } catch (err) {
    console.error('[SAMSARA] Vehicle fetch error:', err.message);
    return null;
  }
}

// ── Poll ──────────────────────────────────────────────────────────────────────
async function poll() {
  const apiKey = process.env.SAMSARA_API_KEY;
  if (!apiKey) return;

  try {
    const params = new URLSearchParams({
      startTime: startTime,
      endTime: new Date().toISOString()
    });
    const url = `${SAMSARA_BASE}/fleet/safety-events?${params}`;
    console.log('[SAMSARA] Polling:', url);

    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
    });

    if (!res.ok) {
      const err = await res.text();
      console.error(`[SAMSARA] API error ${res.status}:`, err.substring(0, 300));
      return;
    }

    const data = await res.json();
    const events = data.data || [];

    if (!events.length) {
      console.log('[SAMSARA] No new safety events');
      return;
    }

    console.log(`[SAMSARA] ${events.length} event(s) received`);
    let saved = 0;

    for (const event of events) {
      const incidentId = `SAMSARA-${event.id || Date.now()}`;
      if (knownEventIds.has(incidentId)) continue;
      knownEventIds.add(incidentId);

      const incident = await normalizeSamsaraEvent(event, incidentId);
      await saveIncident(incident);
      console.log(`[SAMSARA] ✓ ${incident.id} | ${incident.eventType} | ${incident.severity} | ${incident.driver?.name||'?'} | video:${incident.videoUrl?'✓':'✗'}`);
      saved++;
    }

    if (saved > 0) {
      startTime = new Date().toISOString();
      console.log(`[SAMSARA] ${saved} incident(s) added to dashboard`);
    }
  } catch (err) {
    console.error('[SAMSARA] Poll error:', err.message);
  }
}

// ── Normalize Samsara event → Nexus incident ──────────────────────────────────
async function normalizeSamsaraEvent(event, incidentId) {
  const vehicleId = event.vehicle?.id || event.vehicleId;
  const driverId = event.driver?.id || event.driverId;

  const driverDetails = await fetchSamsaraDriver(driverId);
  const vehicleDetails = await fetchSamsaraVehicle(vehicleId);

  const behavior = event.behaviorLabels?.[0]?.label || event.behaviorLabel || 'unknown';
  const location = event.location || {};
  const media = event.mediaUrls || event.media || [];
  const videoMedia = media.find(m => m.type === 'video' || m.mediaType === 'video' || m.url?.includes('.mp4'));
  const forwardImg = media.find(m => (m.type === 'image' || m.mediaType === 'image') && (m.label?.includes('forward') || m.label?.includes('road') || m.cameraLabel?.includes('forward')));
  const driverImg  = media.find(m => (m.type === 'image' || m.mediaType === 'image') && (m.label?.includes('driver') || m.label?.includes('inward') || m.cameraLabel?.includes('driver')));
  const rearImg    = media.find(m => (m.type === 'image' || m.mediaType === 'image') && m.label?.includes('rear'));
  const cargoImg   = media.find(m => (m.type === 'image' || m.mediaType === 'image') && m.label?.includes('cargo'));

  return {
    id: incidentId,
    source: 'samsara',
    rawPayload: event,
    eventType: mapSamsaraBehavior(behavior),
    severity: classifySamsaraSeverity(behavior, event.severity),
    status: 'pending',
    receivedAt: new Date().toISOString(),
    timestamp: event.time || event.startTime || new Date().toISOString(),
    vehicle: {
      vin: vehicleDetails?.vin || event.vehicle?.vin || null,
      make: vehicleDetails?.make || null,
      model: vehicleDetails?.model || null,
      year: vehicleDetails?.year || null,
      licensePlate: vehicleDetails?.plate || null,
      id: vehicleId || null
    },
    driver: {
      id: driverId || null,
      name: driverDetails?.name || event.driver?.name || null,
      phone: driverDetails?.phone || null,
      email: driverDetails?.email || null
    },
    location: {
      lat: location.latitude || event.latitude || null,
      lng: location.longitude || event.longitude || null,
      address: location.formattedAddress || event.formattedLocation || null,
      speed_mph: event.speed ? Math.round(event.speed) : null
    },
    videoUrl: videoMedia?.url || null,
    snapshots: {
      forward: forwardImg?.url || null,
      driver:  driverImg?.url  || null,
      rear:    rearImg?.url    || null,
      cargo:   cargoImg?.url   || null,
    },
    fleetId: 'ELITE-WRECKER',
    customerName: 'Elite Wrecker Service',
    customerLocation: 'Lake Charles, LA'
  };
}

function mapSamsaraBehavior(label) {
  const l = (label || '').toLowerCase();
  if (l.includes('harsh_brake') || l.includes('hard_brake')) return 'hard_brake';
  if (l.includes('harsh_accel') || l.includes('hard_accel')) return 'hard_accel';
  if (l.includes('harsh_turn') || l.includes('hard_corner')) return 'hard_corner';
  if (l.includes('collision') || l.includes('crash')) return 'collision';
  if (l.includes('following') || l.includes('tailgating')) return 'tailgating';
  if (l.includes('distraction') || l.includes('phone')) return 'distraction';
  return label || 'unknown';
}

function classifySamsaraSeverity(behavior, severity) {
  const l = (behavior || '').toLowerCase();
  if (severity) {
    const s = severity.toLowerCase();
    if (s.includes('severe') || s.includes('critical')) return 'critical';
    if (s.includes('moderate')) return 'medium';
  }
  if (l.includes('collision') || l.includes('crash')) return 'critical';
  if (l.includes('harsh_brake') || l.includes('hard_brake')) return 'high';
  if (l.includes('harsh_accel') || l.includes('hard_accel')) return 'medium';
  return 'medium';
}

module.exports = { startSamsaraPoller, stopSamsaraPoller };
