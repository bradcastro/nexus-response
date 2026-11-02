// Ingest pipeline: adapter.normalize -> resolve roster -> enrich -> save -> SSE publish.
const adapters = require('./adapters');
const roster = require('./roster');
const { enrich } = require('./enrich');
const context = require('./context');
const db = require('../db');
const stream = require('./stream');
const { rngFrom, round } = require('./util');

const listeners = [];
const onIncident = (fn) => { listeners.push(fn); };
function deriveSignals(inc) {
  const h = inc._hints || {}, t = inc.eventType, out = [];
  const push = (key, label, value, unit) => out.push({ key, label, value: value == null ? null : value, unit: unit || null, triggered: true });
  if (t === 'following_distance') push('following_distance_s', 'Tailgating / following distance', null, 's');
  else if (t === 'distracted') push('phone_use', 'Distraction (phone / inattention)', null, null);
  else if (t === 'harsh_brake') push('harsh_braking', 'Harsh braking', h.gForce, 'g');
  else if (t === 'harsh_accel') push('harsh_acceleration', 'Harsh acceleration', h.gForce, 'g');
  else if (t === 'harsh_turn') push('harsh_cornering', 'Harsh cornering', h.gForce, 'g');
  else if (t === 'speeding') push('speeding', 'Speeding', inc.location && inc.location.speed_mph, 'mph');
  else if (t === 'collision' || t === 'rollover') push('impact', 'Impact', h.gForce, 'g');
  else if (t === 'fault_code' || t === 'breakdown') push('dtc_active', 'Active fault code', inc.diagnostics ? inc.diagnostics.dtcs.length : null, 'codes');
  return out;
}
let counter = 10000;
const nextId = () => 'NX-' + ++counter;
function seedCounter(n) { if (n > counter) counter = n; }

function makeTrail(inc, rng) {
  const l = inc.location;
  if (l.lat == null) return [];
  const sp = l.speed_mph != null ? l.speed_mph : 50;
  const hdg = ((l.heading != null ? l.heading : 90) * Math.PI) / 180;
  const t0 = new Date(inc.timestamp).getTime();
  const pts = [];
  const step = (mph, secs, sign) => { const d = (mph * secs) / 3600; return [sign * d * Math.cos(hdg) / 69, sign * d * Math.sin(hdg) / (69 * Math.cos((l.lat * Math.PI) / 180))]; };
  let lat = l.lat, lng = l.lng;
  const back = [];
  for (let i = 0; i < 10; i++) {
    const s = Math.max(5, sp * (0.85 + rng() * 0.3));
    const [dl, dg] = step(s, 30, -1);
    lat += dl; lng += dg;
    back.push({ lat: round(lat, 5), lng: round(lng, 5), t: new Date(t0 - (i + 1) * 30000).toISOString(), speed_mph: Math.round(s) });
  }
  pts.push(...back.reverse());
  pts.push({ lat: l.lat, lng: l.lng, t: inc.timestamp, speed_mph: Math.round(sp) });
  const stopped = ['collision', 'rollover', 'breakdown', 'fault_code', 'tire', 'battery'].includes(inc.eventType);
  lat = l.lat; lng = l.lng;
  for (let i = 1; i <= 3; i++) {
    const s = stopped ? 0 : sp * (0.9 + rng() * 0.2);
    const [dl, dg] = step(s, 30, 1);
    lat += dl; lng += dg;
    pts.push({ lat: round(lat, 5), lng: round(lng, 5), t: new Date(t0 + i * 30000).toISOString(), speed_mph: Math.round(s) });
  }
  return pts;
}

function localizeMedia(inc) {
  const fix = (arr, kind) => (arr || []).map((m) => (/\.invalid\//.test(m.url) ? { ...m, vendorUrl: m.url, url: `/media/snap/${inc.id}/${m.type || 'road'}.svg`, placeholder: true } : m));
  inc.camera.clips = fix(inc.camera.clips);
  inc.camera.snapshots = fix(inc.camera.snapshots);
}

async function processIncident(inc, opts = {}) {
  const now = opts.now || new Date();
  inc.id = opts.id || nextId();
  inc.receivedAt = opts.receivedAt || now.toISOString();
  if (opts.timestamp) inc.timestamp = opts.timestamp;
  const provider = inc.provider;

  // --- resolve roster ---
  let rv = roster.findVehicle(provider, inc.vehicle.vin, inc.vehicle.providerVehicleId);
  if (rv && opts.fleetId && rv.fleetId !== opts.fleetId) rv = null; // vehicle belongs to another fleet: treat as unmapped for this client
  const fleet = (opts.fleetId && roster.getFleet(opts.fleetId)) || (rv && roster.getFleet(rv.fleetId)) || roster.fleetByCompany(inc._companyId) || roster.defaultFleetForProvider(provider);
  inc.fleetId = fleet ? fleet.id : 'fleet_unknown';
  inc.fleetName = fleet ? fleet.name : 'Unknown Fleet';
  const iv = inc.vehicle;
  inc.vehicle = {
    id: rv ? rv.id : iv.providerVehicleId || null, vin: iv.vin || (rv && rv.vin) || null,
    year: (rv && rv.year) || iv.year || null, make: (rv && rv.make) || iv.make || null, model: (rv && rv.model) || iv.model || null,
    plate: iv.plate || (rv && rv.plate) || null, odometer_mi: iv.odometer_mi != null ? iv.odometer_mi : rv ? rv.odometer_mi : null,
    engine: (rv && rv.engine) || null, oem: (rv && rv.oem) || null, unit: iv.unit || (rv && rv.unit) || null,
  };
  const rd = roster.findDriver(provider, inc.driver.providerDriverId, inc.driver.name) || (rv && rv.driverId && roster.getDriver(rv.driverId));
  inc.driver = { id: rd ? rd.id : inc.driver.providerDriverId || null, name: inc.driver.name || (rd && rd.name) || 'Unknown Driver', phone: inc.driver.phone || (rd && rd.phone) || null, safetyScore: rd ? rd.safetyScore : null };
  const l = inc.location;
  inc.location = { lat: l.lat, lng: l.lng, address: l.address || (l.lat != null ? `${l.lat.toFixed(4)}, ${l.lng.toFixed(4)}` : null), speed_mph: l.speed_mph, heading: l.heading, road: l.road || (l.address ? String(l.address).split(',')[0].replace(/ near.*/, '') : null) };

  localizeMedia(inc);
  inc.trail = inc.trail && inc.trail.length ? inc.trail : makeTrail(inc, rngFrom(inc.id));
  await enrich(inc, opts);
  await context.attach(inc, opts);

  // --- timeline + status ---
  const t0 = new Date(inc.receivedAt).getTime();
  const tl = [];
  const T = (i) => new Date(t0 + i * 400).toISOString();
  tl.push({ t: T(0), actor: 'system', action: 'received', note: `Webhook received from ${inc.provider} (event ${inc.providerEventId})` });
  tl.push({ t: T(1), actor: 'system', action: 'normalized', note: `Normalized ${inc.provider} payload to canonical ${inc.eventType} incident` });
  if (inc.vehicle.vin) tl.push({ t: T(2), actor: 'system', action: 'vin_decoded', note: `VIN ${inc.vehicle.vin}: ${inc.vehicle.year} ${inc.vehicle.make} ${inc.vehicle.model}` });
  if (inc.camera.aiVerdict !== 'no_video') tl.push({ t: T(3), actor: 'system', action: 'camera_verified', note: `Camera AI: ${inc.camera.aiVerdict.replace(/_/g, ' ')} (${Math.round(inc.camera.confidence * 100)}% confidence)` });
  if (inc.diagnostics) tl.push({ t: T(4), actor: 'system', action: 'dtc_decoded', note: `${inc.diagnostics.dtcs.length} fault code(s): ${inc.diagnostics.dtcs.map((d) => d.code).join(', ')}; drivable: ${inc.diagnostics.drivable}` });
  if (inc.roadside.needed) tl.push({ t: T(5), actor: 'system', action: 'roadside_recommended', note: `${inc.roadside.serviceType}${inc.roadside.recommendedProvider ? ` via ${inc.roadside.recommendedProvider.name}, ETA ${inc.roadside.etaMin} min` : ''}` });
  if (inc.warranty && inc.warranty.claimPacket) tl.push({ t: T(6), actor: 'system', action: 'warranty_packet', note: `${inc.warranty.coverage} claim packet ${inc.warranty.claimPacket.status}; est. $${inc.warranty.claimPacket.estimatedValueUsd}` });
  if (inc.load) tl.push({ t: T(6.5), actor: 'system', action: 'context_inferred', note: `Trip & load context: ${inc.load.estimatedWeightLb > 300 ? `~${inc.load.estimatedWeightLb.toLocaleString('en-US')} lb ${inc.load.contents.label.replace(' (likely)', '')}` : 'trailer appears empty'} (${Math.round(inc.load.confidence * 100)}% confidence); last stop ${inc.trip.lastStop.businessName}` });
  if (inc.warrantyDealer) tl.push({ t: T(6.8), actor: 'system', action: 'warranty_dealer', note: `Nearest ${inc.warrantyDealer.oem} dealer: ${inc.warrantyDealer.nearest.name}, ${inc.warrantyDealer.nearest.distanceMi} mi` });
  inc.timeline = tl;
  inc.status = 'pending';
  if (inc.camera.aiVerdict === 'false_positive' && inc.camera.confidence >= 0.8) {
    inc.status = 'dismissed';
    inc.timeline.push({ t: T(7), actor: 'system', action: 'auto_dismissed', note: 'Camera AI classified event as false positive - auto-dismissed' });
  }

  if (!inc.signals) inc.signals = deriveSignals(inc);
  if (opts.test) inc.test = true;
  // strip internals
  for (const k of Object.keys(inc)) if (k.startsWith('_')) delete inc[k];
  if (opts.save === false) return inc;
  await db.saveIncident(inc);
  if (!opts.silent) {
    stream.publish(inc, 'new');
    for (const fn of listeners) { try { fn(inc); } catch (e) { console.error('[NEXUS] onIncident listener failed:', e.message); } }
  }
  return inc;
}

async function ingest(provider, payload, opts = {}) {
  const adapter = adapters[provider];
  if (!adapter) throw Object.assign(new Error(`Unknown provider '${provider}'`), { status: 404 });
  const inc = adapter.normalize(payload);
  // enrich needs hints; processIncident strips them
  return processIncident(inc, opts);
}

module.exports = { processIncident, onIncident, ingest, nextId, seedCounter, makeTrail };
