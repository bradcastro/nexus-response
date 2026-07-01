// motive-poller.js — Polls Motive Driver Safety Events API (with dashcam clips)
// Endpoint: GET /v1/driver_safety_events
// Auth: x-api-key header

const { saveIncident, getIncidents } = require('./db');

const MOTIVE_BASE = 'https://api.gomotive.com';
const POLL_INTERVAL_MS = 60 * 1000;

let pollTimer = null;
let knownEventIds = new Set();
let startDate = null;

const driverCache = new Map();
const vehicleCache = new Map();

async function startPoller() {
  const apiKey = process.env.MOTIVE_API_KEY;
  if (!apiKey) {
    console.log('[MOTIVE] MOTIVE_API_KEY not set — poller not started');
    return;
  }
  console.log('[MOTIVE] Starting safety event poller (with dashcam)');

  const monthAgo = new Date();
  monthAgo.setDate(monthAgo.getDate() - 30);
  startDate = monthAgo.toISOString().split('T')[0];

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

// ── Driver enrichment ─────────────────────────────────────────────────────────
async function fetchDriverDetails(driverId) {
  if (!driverId) return null;
  if (driverCache.has(driverId)) return driverCache.get(driverId);
  const apiKey = process.env.MOTIVE_API_KEY;
  try {
    const res = await fetch(`${MOTIVE_BASE}/v1/users/${driverId}`, {
      headers: { 'x-api-key': apiKey }
    });
    if (!res.ok) return null;
    const data = await res.json();
    const u = data.user || data;
    const details = {
      name: u.first_name ? `${u.first_name} ${u.last_name || ''}`.trim() : null,
      phone: u.phone_number || u.phone || null,
      email: u.email || null
    };
    driverCache.set(driverId, details);
    console.log(`[MOTIVE] Driver enriched: ${details.name} | ${details.phone}`);
    return details;
  } catch (e) { return null; }
}

// ── Vehicle enrichment ────────────────────────────────────────────────────────
async function fetchVehicleDetails(vehicleId) {
  if (!vehicleId) return null;
  if (vehicleCache.has(vehicleId)) return vehicleCache.get(vehicleId);
  const apiKey = process.env.MOTIVE_API_KEY;
  try {
    const res = await fetch(`${MOTIVE_BASE}/v1/vehicles/${vehicleId}`, {
      headers: { 'x-api-key': apiKey }
    });
    if (!res.ok) return null;
    const data = await res.json();
    const v = data.vehicle || data;
    const details = {
      vin: v.vin || null,
      make: v.make || null,
      model: v.model || null,
      year: v.year || null,
      plate: v.license_plate_number || v.number || null,
      odometer: v.current_odometer || null,
      fuelLevel: v.current_fuel_percentage || null,
      engineHours: v.current_engine_hours || null,
      faultCodes: v.fault_codes || []
    };
    vehicleCache.set(vehicleId, details);
    return details;
  } catch (e) { return null; }
}

// ── Poll safety events ────────────────────────────────────────────────────────
async function poll() {
  const apiKey = process.env.MOTIVE_API_KEY;
  if (!apiKey) return;

  try {
    // Try safety events endpoint first (has dashcam clips)
    const safetyUrl = `${MOTIVE_BASE}/v1/driver_safety_events?per_page=25&start_date=${startDate}`;
    console.log('[MOTIVE] Polling safety events:', safetyUrl);

    const safetyRes = await fetch(safetyUrl, {
      headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' }
    });

    if (safetyRes.ok) {
      const data = await safetyRes.json();
      const events = data.driver_safety_events || [];
      console.log(`[MOTIVE] Safety events: ${events.length} found`);
      await processEvents(events, 'safety');
    } else {
      console.warn(`[MOTIVE] Safety events ${safetyRes.status} — falling back to performance events`);
      await pollPerformanceEvents(apiKey);
    }

  } catch (err) {
    console.error('[MOTIVE] Poll error:', err.message);
  }
}

async function pollPerformanceEvents(apiKey) {
  const url = `${MOTIVE_BASE}/v1/driver_performance_events?per_page=25&start_date=${startDate}`;
  console.log('[MOTIVE] Polling performance events:', url);
  const res = await fetch(url, {
    headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' }
  });
  if (!res.ok) {
    console.error(`[MOTIVE] Performance events also failed: ${res.status}`);
    return;
  }
  const data = await res.json();
  const events = data.driver_performance_events || [];
  console.log(`[MOTIVE] Performance events: ${events.length} found`);
  await processEvents(events, 'performance');
}

async function processEvents(events, type) {
  if (!events.length) {
    console.log(`[MOTIVE] No new ${type} events`);
    return;
  }
  let saved = 0;
  for (const wrapper of events) {
    const event = wrapper.driver_safety_event || wrapper.driver_performance_event || wrapper;
    const incidentId = `MOTIVE-${event.id || Date.now()}`;
    if (knownEventIds.has(incidentId)) continue;
    knownEventIds.add(incidentId);
    const incident = await normalizeEvent(event, incidentId, type);
    await saveIncident(incident);
    const hasVideo = !!incident.videoUrl;
    const hasPhone = !!incident.driver?.phone;
    console.log(`[MOTIVE] ✓ ${incident.id} | ${incident.eventType} | ${incident.severity} | driver: ${incident.driver?.name || 'unknown'} | phone: ${hasPhone ? '✓' : '✗'} | video: ${hasVideo ? '✓' : '✗'}`);
    saved++;
  }
  if (saved > 0) {
    startDate = new Date().toISOString().split('T')[0];
    console.log(`[MOTIVE] ${saved} incident(s) added to dashboard`);
  } else {
    console.log('[MOTIVE] No new incidents (all already known)');
  }
}

// ── Normalize ─────────────────────────────────────────────────────────────────
async function normalizeEvent(event, incidentId, type) {
  const vehicle = event.vehicle || {};
  const driver = event.driver || {};

  const driverDetails = await fetchDriverDetails(driver.id);
  const vehicleDetails = await fetchVehicleDetails(vehicle.id);

  // Safety events have richer media fields
  const videoUrl = event.video_url
    || event.dashcam_url
    || event.clip_url
    || event.media_url
    || event.dashcam_clip_url
    || null;

  // Camera snapshots
  const snapshots = event.snapshots || event.images || {};

  return {
    id: incidentId,
    source: 'motive',
    rawPayload: { ...event, _vehicleDetails: vehicleDetails },
    eventType: event.type || event.event_type || 'unknown',
    severity: classifySeverity(event.type || event.event_type, event.intensity),
    status: 'pending',
    receivedAt: new Date().toISOString(),
    timestamp: event.occurred_at || event.start_time || new Date().toISOString(),
    vehicle: {
      vin: vehicleDetails?.vin || vehicle.vin || null,
      make: vehicleDetails?.make || vehicle.make || null,
      model: vehicleDetails?.model || vehicle.model || null,
      year: vehicleDetails?.year || vehicle.year || null,
      licensePlate: vehicleDetails?.plate || vehicle.number || null,
      id: vehicle.id || null
    },
    driver: {
      id: driver.id || null,
      name: driverDetails?.name || (driver.first_name ? `${driver.first_name} ${driver.last_name || ''}`.trim() : null),
      phone: driverDetails?.phone || driver.phone_number || null,
      email: driverDetails?.email || null
    },
    location: {
      lat: event.lat || null,
      lng: event.lon || null,
      address: event.location || null,
      speed_mph: event.start_speed ? Math.round(event.start_speed * 0.621371) : null
    },
    videoUrl,
    snapshots: {
      forward: snapshots.road_facing || snapshots.forward || null,
      driver: snapshots.driver_facing || snapshots.driver || null,
      rear: snapshots.rear || null,
      cargo: snapshots.cargo || null
    },
    fleetId: vehicle.number || null,
    customerName: 'Goodyear Towing',
    customerLocation: 'Enterprise, AL',
    diagnostics: vehicleDetails ? {
      odometer: vehicleDetails.odometer,
      fuelLevel: vehicleDetails.fuelLevel,
      engineHours: vehicleDetails.engineHours,
      faultCodes: vehicleDetails.faultCodes
    } : null
  };
}

function classifySeverity(type, intensity) {
  const t = (type || '').toLowerCase();
  const val = intensity ? Math.abs(parseFloat(intensity)) : 0;
  if (t.includes('collision') || t.includes('crash') || t.includes('rollover')) return 'critical';
  if (t === 'hard_brake' && val >= 15) return 'critical';
  if (t === 'hard_brake' || t === 'harsh_brake') return 'high';
  if (t === 'hard_accel' && val >= 18) return 'high';
  if (t === 'hard_accel' || t === 'hard_corner') return 'medium';
  return 'medium';
}

module.exports = { startPoller, stopPoller };
