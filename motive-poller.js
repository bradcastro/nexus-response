// motive-poller.js
// Primary: GET /v1/driver_safety_events (includes dashcam clips)
// Fallback: GET /v1/driver_performance_events
const { saveIncident, getIncidents } = require('./db');

const MOTIVE_BASE = 'https://api.gomotive.com';
const POLL_INTERVAL_MS = 60 * 1000;

let pollTimer = null;
let knownEventIds = new Set();
let windowStart = null;

const driverCache = new Map();
const vehicleCache = new Map();

async function startPoller() {
  const apiKey = process.env.MOTIVE_API_KEY;
  if (!apiKey) { console.log('[MOTIVE] MOTIVE_API_KEY not set'); return; }
  console.log('[MOTIVE] Starting poller — safety events with dashcam clips');

  // 30 days back, full ISO format required by safety events endpoint
  const d = new Date();
  d.setDate(d.getDate() - 30);
  windowStart = d.toISOString();

  try {
    const existing = await getIncidents();
    existing.forEach(i => { if (i.id) knownEventIds.add(i.id); });
    console.log(`[MOTIVE] Tracking ${knownEventIds.size} existing incidents`);
  } catch(e) {}

  await poll();
  pollTimer = setInterval(poll, POLL_INTERVAL_MS);
}

function stopPoller() { if (pollTimer) clearInterval(pollTimer); }

// ── Driver enrichment ─────────────────────────────────────────────────────────
async function fetchDriver(driverId) {
  if (!driverId) return null;
  if (driverCache.has(driverId)) return driverCache.get(driverId);
  try {
    const res = await fetch(`${MOTIVE_BASE}/v1/users/${driverId}`, {
      headers: { 'x-api-key': process.env.MOTIVE_API_KEY }
    });
    if (!res.ok) return null;
    const data = await res.json();
    const u = data.user || data;
    const d = {
      name: u.first_name ? `${u.first_name} ${u.last_name||''}`.trim() : null,
      phone: u.phone_number || u.phone || null,
      email: u.email || null
    };
    driverCache.set(driverId, d);
    console.log(`[MOTIVE] Driver enriched: ${d.name} | phone: ${d.phone||'none'}`);
    return d;
  } catch(e) { return null; }
}

// ── Vehicle enrichment ────────────────────────────────────────────────────────
async function fetchVehicle(vehicleId) {
  if (!vehicleId) return null;
  if (vehicleCache.has(vehicleId)) return vehicleCache.get(vehicleId);
  try {
    const res = await fetch(`${MOTIVE_BASE}/v1/vehicles/${vehicleId}`, {
      headers: { 'x-api-key': process.env.MOTIVE_API_KEY }
    });
    if (!res.ok) return null;
    const data = await res.json();
    const v = data.vehicle || data;
    const d = {
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
    vehicleCache.set(vehicleId, d);
    return d;
  } catch(e) { return null; }
}

// ── Poll ──────────────────────────────────────────────────────────────────────
async function poll() {
  const apiKey = process.env.MOTIVE_API_KEY;
  if (!apiKey) return;

  // Try safety events first — includes video clips
  try {
    // Safety events uses start_time with full ISO timestamp
    const safetyUrl = `${MOTIVE_BASE}/v1/driver_safety_events?per_page=25&start_time=${encodeURIComponent(windowStart)}`;
    console.log('[MOTIVE] Polling safety events...');
    const res = await fetch(safetyUrl, {
      headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' }
    });

    if (res.ok) {
      const data = await res.json();
      const events = data.driver_safety_events || [];
      console.log(`[MOTIVE] Safety events: ${events.length} found`);
      if (events.length) await processEvents(events, 'safety');
      else console.log('[MOTIVE] No new safety events');
      return;
    }

    const errText = await res.text();
    console.warn(`[MOTIVE] Safety events ${res.status} — ${errText.substring(0,150)}`);
    console.log('[MOTIVE] Falling back to performance events...');
  } catch(e) {
    console.error('[MOTIVE] Safety events error:', e.message);
  }

  // Fallback — performance events (no video, but proven to work)
  try {
    const startDate = windowStart.split('T')[0];
    const perfUrl = `${MOTIVE_BASE}/v1/driver_performance_events?per_page=25&start_date=${startDate}`;
    console.log('[MOTIVE] Polling performance events...');
    const res = await fetch(perfUrl, {
      headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' }
    });
    if (!res.ok) {
      console.error(`[MOTIVE] Performance events ${res.status}`);
      return;
    }
    const data = await res.json();
    const events = data.driver_performance_events || [];
    console.log(`[MOTIVE] Performance events: ${events.length} found`);
    if (events.length) await processEvents(events, 'performance');
    else console.log('[MOTIVE] No new performance events');
  } catch(e) {
    console.error('[MOTIVE] Performance events error:', e.message);
  }
}

// ── Process events ────────────────────────────────────────────────────────────
async function processEvents(events, type) {
  let saved = 0;
  for (const wrapper of events) {
    const event = wrapper.driver_safety_event || wrapper.driver_performance_event || wrapper;
    const id = `MOTIVE-${event.id || Date.now()}`;
    if (knownEventIds.has(id)) continue;
    knownEventIds.add(id);

    const incident = await normalize(event, id, type);
    await saveIncident(incident);

    const hasVideo = !!incident.videoUrl;
    const hasPhone = !!incident.driver?.phone;
    console.log(`[MOTIVE] ✓ ${id} | ${incident.eventType} | ${incident.severity} | ${incident.driver?.name||'?'} | phone:${hasPhone?'✓':'✗'} | video:${hasVideo?'✓ '+incident.videoUrl.substring(0,40):'✗'}`);
    saved++;
  }
  if (saved > 0) {
    windowStart = new Date().toISOString();
    console.log(`[MOTIVE] ${saved} new incident(s) saved`);
  } else {
    console.log(`[MOTIVE] All ${events.length} events already known`);
  }
}

// ── Normalize ─────────────────────────────────────────────────────────────────
async function normalize(event, id, type) {
  const vehicle = event.vehicle || {};
  const driver  = event.driver  || {};

  const driverDetails  = await fetchDriver(driver.id);
  const vehicleDetails = await fetchVehicle(vehicle.id);

  // Safety events video fields — Motive uses several possible keys
  const videoUrl =
    event.video_url ||
    event.dashcam_url ||
    event.dashcam_clip_url ||
    event.clip_url ||
    event.media_url ||
    event.video ||
    null;

  // Snapshot image fields
  const snaps = event.snapshots || event.images || {};
  const snapshots = {
    forward: snaps.road_facing  || snaps.forward  || event.road_facing_image  || null,
    driver:  snaps.driver_facing || snaps.driver  || event.driver_facing_image || null,
    rear:    snaps.rear          || event.rear_image    || null,
    cargo:   snaps.cargo         || event.cargo_image   || null,
  };

  return {
    id,
    source: 'motive',
    rawPayload: { ...event, _vehicleDetails: vehicleDetails },
    eventType: event.type || event.event_type || 'unknown',
    severity: classify(event.type || event.event_type, event.intensity),
    status: 'pending',
    receivedAt: new Date().toISOString(),
    timestamp: event.occurred_at || event.start_time || new Date().toISOString(),
    vehicle: {
      vin:          vehicleDetails?.vin   || vehicle.vin    || null,
      make:         vehicleDetails?.make  || vehicle.make   || null,
      model:        vehicleDetails?.model || vehicle.model  || null,
      year:         vehicleDetails?.year  || vehicle.year   || null,
      licensePlate: vehicleDetails?.plate || vehicle.number || null,
      id:           vehicle.id || null
    },
    driver: {
      id:    driver.id || null,
      name:  driverDetails?.name  || (driver.first_name ? `${driver.first_name} ${driver.last_name||''}`.trim() : null),
      phone: driverDetails?.phone || driver.phone_number || null,
      email: driverDetails?.email || driver.email || null
    },
    location: {
      lat:       event.lat || null,
      lng:       event.lon || null,
      address:   event.location || null,
      speed_mph: event.start_speed ? Math.round(event.start_speed * 0.621371) : null
    },
    videoUrl,
    snapshots,
    // Pass through GPS trail for map animation
    gpsTrail: event.m_gps_lat && event.m_gps_lon ? {
      lat:     event.m_gps_lat,
      lng:     event.m_gps_lon,
      speed:   event.m_gps_spd,
      heading: event.m_gps_heading
    } : null,
    fleetId: vehicle.number || null,
    customerName: 'Goodyear Towing',
    customerLocation: 'Enterprise, AL',
    diagnostics: vehicleDetails ? {
      odometer:    vehicleDetails.odometer,
      fuelLevel:   vehicleDetails.fuelLevel,
      engineHours: vehicleDetails.engineHours,
      faultCodes:  vehicleDetails.faultCodes
    } : null
  };
}

function classify(type, intensity) {
  const t = (type||'').toLowerCase();
  const v = intensity ? Math.abs(parseFloat(intensity)) : 0;
  if (t.includes('collision') || t.includes('crash') || t.includes('rollover')) return 'critical';
  if (t === 'hard_brake' && v >= 15) return 'critical';
  if (t === 'hard_brake'  || t === 'harsh_brake') return 'high';
  if (t === 'hard_accel'  && v >= 18) return 'high';
  if (t === 'hard_accel'  || t === 'hard_corner') return 'medium';
  return 'medium';
}

module.exports = { startPoller, stopPoller };
