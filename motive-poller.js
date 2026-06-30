const { saveIncident, getIncidents } = require('./db');

const MOTIVE_BASE = 'https://api.gomotive.com';
const POLL_INTERVAL_MS = 60 * 1000;

let pollTimer = null;
let knownEventIds = new Set();
let startDate = null;

// Driver cache so we don't re-fetch the same driver record every poll
let driverCache = new Map(); // driver.id -> { name, phone, email }
let vehicleCache = new Map(); // vehicle.id -> { odometer, fuel, faultCodes }

async function startPoller() {
  const apiKey = process.env.MOTIVE_API_KEY;
  if (!apiKey) {
    console.log('[MOTIVE] MOTIVE_API_KEY not set — poller not started');
    return;
  }
  console.log('[MOTIVE] Starting performance event poller');
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 30);
  startDate = weekAgo.toISOString().split('T')[0];

  try {
    const existing = await getIncidents();
    existing.forEach(i => { if (i.id) knownEventIds.add(i.id); });
  } catch (e) {}

  await poll();
  pollTimer = setInterval(poll, POLL_INTERVAL_MS);
}

function stopPoller() {
  if (pollTimer) clearInterval(pollTimer);
}

// ── Driver Lookup ──────────────────────────────────────────────────────────────
async function fetchDriverDetails(driverId) {
  if (!driverId) return null;
  if (driverCache.has(driverId)) return driverCache.get(driverId);

  const apiKey = process.env.MOTIVE_API_KEY;
  try {
    const res = await fetch(`${MOTIVE_BASE}/v1/users/${driverId}`, {
      headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' }
    });
    if (!res.ok) {
      console.warn(`[MOTIVE] Driver lookup failed for ${driverId}: ${res.status}`);
      return null;
    }
    const data = await res.json();
    const user = data.user || data;
    const details = {
      name: user.first_name ? `${user.first_name} ${user.last_name || ''}`.trim() : null,
      phone: user.phone_number || user.phone || null,
      email: user.email || null,
      driverId: user.driver_company_id || user.id || driverId
    };
    driverCache.set(driverId, details);
    return details;
  } catch (err) {
    console.error('[MOTIVE] Driver fetch error:', err.message);
    return null;
  }
}

// ── Vehicle Lookup (for diagnostics) ──────────────────────────────────────────
async function fetchVehicleDetails(vehicleId) {
  if (!vehicleId) return null;
  if (vehicleCache.has(vehicleId)) return vehicleCache.get(vehicleId);

  const apiKey = process.env.MOTIVE_API_KEY;
  try {
    const res = await fetch(`${MOTIVE_BASE}/v1/vehicles/${vehicleId}`, {
      headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' }
    });
    if (!res.ok) return null;
    const data = await res.json();
    const v = data.vehicle || data;
    const details = {
      odometer: v.current_odometer || v.odometer || null,
      fuelLevel: v.current_fuel_percentage || v.fuel_level_percentage || null,
      engineHours: v.current_engine_hours || null,
      faultCodes: v.fault_codes || v.active_fault_codes || [],
      vin: v.vin || null,
      year: v.year || null,
      make: v.make || null,
      model: v.model || null,
      plate: v.license_plate_number || null
    };
    vehicleCache.set(vehicleId, details);
    return details;
  } catch (err) {
    console.error('[MOTIVE] Vehicle fetch error:', err.message);
    return null;
  }
}

// ── Poll ──────────────────────────────────────────────────────────────────────
async function poll() {
  const apiKey = process.env.MOTIVE_API_KEY;
  if (!apiKey) return;

  try {
    const url = `${MOTIVE_BASE}/v1/driver_performance_events?per_page=25&start_date=${startDate}`;
    console.log('[MOTIVE] Polling:', url);
    const res = await fetch(url, {
      headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' }
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
      const incidentId = `MOTIVE-${event.id || Date.now()}`;
      if (knownEventIds.has(incidentId)) continue;
      knownEventIds.add(incidentId);

      const incident = await normalizeEvent(event, incidentId);
      await saveIncident(incident);
      console.log(`[MOTIVE] Saved: ${incident.id} | ${incident.eventType} | ${incident.severity} | driver: ${incident.driver?.name || 'unknown'} | phone: ${incident.driver?.phone || 'none'}`);
      saved++;
    }

    if (saved > 0) {
      startDate = new Date().toISOString().split('T')[0];
      console.log(`[MOTIVE] ${saved} incident(s) added to dashboard`);
    }
  } catch (err) {
    console.error('[MOTIVE] Poll error:', err.message);
  }
}

// ── Normalize (now async — enriches driver + vehicle) ─────────────────────────
async function normalizeEvent(event, incidentId) {
  const vehicle = event.vehicle || {};
  const driver = event.driver || {};

  // Enrich driver with real contact info from Motive Users API
  const driverDetails = await fetchDriverDetails(driver.id);
  // Enrich vehicle with diagnostic data from Motive Vehicles API
  const vehicleDetails = await fetchVehicleDetails(vehicle.id);

  return {
    id: incidentId,
    source: 'motive',
    rawPayload: { ...event, _vehicleDetails: vehicleDetails },
    eventType: event.type || 'unknown',
    severity: classifySeverity(event.type, event.intensity),
    status: 'pending',
    receivedAt: new Date().toISOString(),
    timestamp: event.start_time || new Date().toISOString(),
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
    videoUrl: event.video_url || null,
    fleetId: vehicle.number || null,
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
  if (t === 'hard_brake' && val >= 15) return 'critical';
  if (t === 'hard_brake') return 'high';
  if (t === 'hard_accel' && val >= 18) return 'high';
  if (t === 'hard_accel') return 'medium';
  if (t === 'hard_corner') return 'medium';
  return 'medium';
}

module.exports = { startPoller, stopPoller };
