// Client onboarding: create fleet + API key, checklist, test event, key rotation, roster upload, alert config.
const express = require('express');
const roster = require('./roster');
const db = require('../db');
const keys = require('./ingest/keys');
const ingest = require('./ingest');
const ingestLog = require('./ingest/log');
const fixtures = require('./fixtures');
const { buildVin, decode } = require('./enrich/vin');
const { parseCsv } = require('./csv');
const { MODELS, LOCATIONS } = require('./data/ref');
const { rngFrom, round } = require('./util');

const VENDORS = ['motive', 'samsara', 'geotab', 'lytx', 'mantis', 'other'];
const HEAVY_OEM = ['Freightliner', 'Peterbilt', 'Kenworth', 'Volvo', 'International', 'Mack'];
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 14) || 'fleet';
const prov = (v) => (v === 'other' ? 'generic' : v);

function setupSteps(vendor, url, batchUrl) {
  const hdr = 'Add the header  x-nexus-key: <your API key>  (or  Authorization: Bearer <key>).';
  const common = [`Webhook URL: ${url}`, hdr, `Backfill/bulk: POST arrays of events to ${batchUrl}`, 'Upload your vehicle roster (unit, VIN, plate, make, model, year, driver) so events map to vehicles.', 'Click "Send test event" - you should see it arrive live within a second.'];
  const by = {
    motive: ['In Motive: Admin > Settings > Integrations > Webhooks > Add webhook.', 'Select events: driver safety events (harsh braking/accel/cornering, speeding, distracted, collision), fault codes.', 'Optional: set a signing secret and send it to us - we verify the x-motive-signature HMAC-SHA256 header.'],
    samsara: ['In Samsara: Settings > Developer > Webhooks > Add webhook (alerts: Safety events, Harsh events, DTC / Fault codes).', 'Paste the webhook URL; add the custom header with your Nexus key.', 'Optional: share your signing secret to enable x-samsara-signature verification.'],
    geotab: ['In MyGeotab: use the Data Feed / Add-In webhook relay (ExceptionEvent + FaultData) pointing at the webhook URL.', 'Map rules: Harsh Braking, Harsh Cornering, Possible Accident, Speeding. Speeds are km/h and odometer in meters - Nexus converts.', 'Camera partner (e.g. Surfsight) clip URLs can be included in the camera block.'],
    lytx: ['In Lytx: contact support or use the Event Notification service to register the webhook URL for DriveCam events.', 'Include forward/driver video URLs and ML results (mlResult) so camera verification works.', 'Vehicle Gateway diagnostics (vehicleGateway.dtcs) enable fault-code decoding.'],
    mantis: ['In Mantis (ASSUMED - confirm with Mantis docs): Integrations > Outbound webhooks > Add endpoint, schema mantis.event.v1.', 'Enable driver-facing and road-facing signals plus clip URLs: this unlocks camera verification and richer prediction.', 'Optional: share the signing secret to enable x-mantis-signature verification. See docs/MANTIS.md.'],
    other: ['Use the generic JSON format (event_type, timestamp, vin, lat, lng, speed_mph, g_force, dtcs[], video_url, driver_name).', 'Example payload: GET /api/demo/sample/generic.'],
  };
  return [...(by[vendor] || by.other), ...common];
}

async function persistFleet(f) {
  await db.saveFleet({ ...roster.publicFleet(f), id: f.id, custom: !!f.custom, prospect: !!f.prospect, contact: f.contact, alertConfig: f.alertConfig, onboarding: f.onboarding, companyId: f.companyId, regions: f.regions, home: f.home, vehicleCount: f.vehicleCount, exposure: f.exposure, ...(f.custom ? { vehicles: f.vehicles, drivers: f.drivers } : {}) });
  if (db.usingPostgres()) { for (const v of f.vehicles) await db.put('vehicle', { ...v, id: v.id, fleetId: f.id }); for (const d of f.drivers) await db.put('driver', { ...d, id: d.id, fleetId: f.id }); }
}
async function loadPersisted() {
  const docs = await db.listFleets();
  let n = 0;
  for (const d of docs) if (d.custom && d.vehicles && !roster.getFleet(d.id)) { roster.addFleet({ ...d, vehicles: d.vehicles || [], drivers: d.drivers || [] }); n++; }
  return n;
}

function newFleet({ name, vendor, vehicles, contactName, contactEmail, region }) {
  const id = 'fleet_' + slug(name) + Math.random().toString(36).slice(2, 5);
  return {
    id, name, vendor, region: region || 'Unspecified', home: region || '', regions: [], companyId: `co_${vendor}_${slug(name)}`, cameraPct: 0, custom: true,
    vehicles: [], drivers: [], vehicleCount: vehicles || 0, contact: { name: contactName || null, email: contactEmail || null },
    onboarding: { status: 'setup', createdAt: new Date().toISOString() },
  };
}

function baseUrl(req) { return (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, ''); }

async function checklist(f) {
  const ks = await keys.listKeys(f.id);
  const log = (await db.list('ingest_log', { fleetId: f.id, limit: 100000 })).filter((e) => e.status === 'accepted' || e.status === 'duplicate');
  const first = log.length ? log.map((e) => e.receivedAt).sort()[0] : null;
  const jobs = (await db.list('import_job', { fleetId: f.id, limit: 100 })).filter((j) => j.status === 'completed');
  const ob = f.onboarding || {};
  const steps = [
    { key: 'account_created', label: 'Account created', done: true, doneAt: ob.createdAt || null },
    { key: 'api_key_issued', label: 'API key issued', done: ks.length > 0, doneAt: ks.length ? ks[ks.length - 1].createdAt : null },
    { key: 'first_event_received', label: 'First event received', done: !!first, doneAt: first },
    { key: 'vehicles_mapped', label: 'Vehicles mapped', done: f.vehicles.length > 0, doneAt: f.vehicles.length ? (ob.rosterAt || ob.createdAt) : null },
    { key: 'history_imported', label: 'Historical data imported', done: jobs.length > 0, doneAt: jobs.length ? jobs[0].finishedAt : null },
    { key: 'alerts_configured', label: 'Alerts configured', done: !!f.alertConfig, doneAt: f.alertConfig ? f.alertConfig.configuredAt : null },
  ];
  if (f.onboarding && f.onboarding.status === 'demo') steps.forEach((s) => { s.done = true; s.doneAt = s.doneAt || ob.createdAt; });
  return { fleetId: f.id, status: (f.onboarding || {}).status || 'demo', steps, percent: Math.round((100 * steps.filter((s) => s.done).length) / steps.length) };
}

function parseRoster(body) {
  let rows = null;
  if (Array.isArray(body)) rows = body;
  else if (body && Array.isArray(body.vehicles)) rows = body.vehicles;
  else if (body && typeof body.csv === 'string') {
    const { headers, rows: r } = parseCsv(body.csv);
    const hk = headers.map((h) => h.toLowerCase().replace(/[^a-z]/g, ''));
    rows = r.map((cells) => Object.fromEntries(hk.map((k, i) => [k, (cells[i] || '').trim()])));
  }
  return rows;
}
const pickF = (r, ...ks) => { for (const k of ks) { const v = r[k] ?? r[k.toLowerCase()]; if (v != null && String(v).trim() !== '') return String(v).trim(); } return null; };

async function upsertRoster(f, rows) {
  let added = 0, updated = 0; const warnings = [];
  const byVin = new Map(f.vehicles.map((v) => [v.vin, v])), byUnit = new Map(f.vehicles.map((v) => [v.unit, v]));
  for (const [i, r0] of rows.entries()) {
    const r = Object.fromEntries(Object.entries(r0).map(([k, v]) => [k.toLowerCase().replace(/[^a-z]/g, ''), v]));
    const vin = (pickF(r, 'vin') || '').toUpperCase() || null;
    const unit = pickF(r, 'unit', 'unitnumber', 'vehicle', 'truck') || (vin ? vin.slice(-6) : `U${f.vehicles.length + 1}`);
    if (vin && !/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) warnings.push(`row ${i + 1}: VIN '${vin}' is not 17 valid characters`);
    let v = (vin && byVin.get(vin)) || byUnit.get(unit);
    const isNew = !v;
    if (!v) { v = { id: `veh_${f.id.slice(6, 12)}_${String(f.vehicles.length + 1).padStart(3, '0')}`, fleetId: f.id, providerVehicleId: pickF(r, 'vehicleid', 'id') || unit, hasCamera: f.vendor === 'mantis', odometer_mi: 0, position: { lat: null, lng: null, speed_mph: 0, status: 'unknown' } }; f.vehicles.push(v); }
    v.unit = unit; if (vin) v.vin = vin;
    v.plate = pickF(r, 'plate', 'licenseplate') || v.plate || null;
    const dec = vin ? await decode(vin) : null;
    v.make = pickF(r, 'make') || v.make || (dec && dec.make) || null; v.model = pickF(r, 'model') || v.model || (dec && dec.model) || null;
    v.year = parseInt(pickF(r, 'year'), 10) || v.year || (dec && dec.year) || null; v.oem = (dec && dec.oem) || v.make; v.engine = v.engine || (dec && dec.engine) || null;
    v.cls = HEAVY_OEM.includes(v.oem) ? 'heavy' : 'light';
    const dn = pickF(r, 'driver', 'drivername');
    if (dn) {
      let d = f.drivers.find((x) => x.name === dn);
      if (!d) { d = { id: `drv_${f.id.slice(6, 12)}_${String(f.drivers.length + 1).padStart(2, '0')}`, fleetId: f.id, name: dn, phone: null, providerDriverId: dn, safetyScore: 88, vehicleId: v.id }; f.drivers.push(d); }
      v.driverId = d.id; d.vehicleId = v.id;
    }
    byVin.set(v.vin, v); byUnit.set(v.unit, v);
    isNew ? added++ : updated++;
  }
  f.vehicleCount = Math.max(f.vehicleCount || 0, f.vehicles.length);
  f.onboarding = { ...(f.onboarding || {}), rosterAt: new Date().toISOString() };
  roster.reindex();
  await persistFleet(f);
  return { added, updated, vehicles: f.vehicles.length, drivers: f.drivers.length, warnings: warnings.slice(0, 50) };
}

const router = express.Router();
const getFleetOr404 = (req, res) => { const f = roster.getFleet(req.params.id); if (!f) { res.status(404).json({ error: 'Fleet not found' }); return null; } return f; };

router.get('/api/onboarding/fleets', async (req, res) => {
  const out = [];
  for (const f of roster.all()) out.push({ ...roster.publicFleet(f), contact: f.contact || null, keys: await keys.listKeys(f.id), custom: !!f.custom });
  res.json(out);
});

router.post('/api/onboarding/fleets', async (req, res) => {
  const b = req.body || {};
  const errs = [];
  if (!b.name || typeof b.name !== 'string' || b.name.trim().length < 2) errs.push('name is required (min 2 chars)');
  if (!VENDORS.includes(b.vendor)) errs.push(`vendor must be one of ${VENDORS.join(', ')}`);
  if (!b.contactEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.contactEmail)) errs.push('contactEmail must be a valid email');
  if (!b.contactName) errs.push('contactName is required');
  if (b.vehicles != null && (!Number.isFinite(+b.vehicles) || +b.vehicles < 0 || +b.vehicles > 100000)) errs.push('vehicles must be a number 0-100000');
  if (roster.all().some((f) => f.name.toLowerCase() === String(b.name).trim().toLowerCase())) errs.push('a fleet with this name already exists');
  if (errs.length) return res.status(422).json({ error: 'validation_failed', details: errs });
  const f = newFleet({ ...b, name: b.name.trim(), vehicles: b.vehicles != null ? +b.vehicles : 0 });
  roster.addFleet(f);
  await persistFleet(f);
  const k = await keys.issueKey(f.id);
  const base = baseUrl(req);
  const url = `${base}/webhook/${prov(f.vendor)}`;
  res.status(201).json({ fleet: roster.publicFleet(f), apiKey: k.key, apiKeyInfo: k.record, note: 'Store the API key now - it is shown only once.', webhookUrl: url, batchUrl: url + '/batch', setupSteps: setupSteps(f.vendor, url, url + '/batch') });
});

router.get('/api/onboarding/fleets/:id/checklist', async (req, res) => { const f = getFleetOr404(req, res); if (f) res.json(await checklist(f)); });

router.post('/api/onboarding/fleets/:id/rotate-key', async (req, res) => {
  const f = getFleetOr404(req, res); if (!f) return;
  const k = await keys.rotateKey(f.id);
  res.json({ apiKey: k.key, apiKeyInfo: k.record, note: 'Previous keys are revoked. Store this key now - it is shown only once.' });
});

router.post('/api/onboarding/fleets/:id/test-event', async (req, res) => {
  const f = getFleetOr404(req, res); if (!f) return;
  const rng = rngFrom('test:' + Date.now());
  const provider = prov(f.vendor);
  const v = f.vehicles[0] || { providerVehicleId: 'TEST-1', unit: 'TEST-1', vin: buildVin('fcascadia', 2024, 99001), make: 'Freightliner', model: 'Cascadia 126', year: 2024, plate: 'TEST-001' };
  const d = f.drivers[0] || { providerDriverId: 'test_driver', name: 'Test Driver', phone: '+15555550100' };
  const loc = LOCATIONS[Math.floor(rng() * LOCATIONS.length)];
  const spec = {
    eventId: `test_${Date.now().toString(36)}`, eventType: req.body && req.body.eventType || 'harsh_brake', timestamp: new Date().toISOString(), companyId: f.companyId,
    vehicle: { providerVehicleId: v.providerVehicleId, unit: v.unit, vin: v.vin, make: v.make, model: v.model, year: v.year, plate: v.plate },
    driver: { providerDriverId: d.providerDriverId, name: d.name, phone: d.phone },
    location: { lat: round(loc.lat, 5), lng: round(loc.lng, 5), address: `${loc.road}, ${loc.city}, ${loc.st}`, speed_mph: 58, heading: loc.h },
    gForce: 0.62, airbag: false, aiLabel: 'near_miss', aiConfidence: 0.9, facingForward: true, hasCamera: true, driverFacing: true, odometer_mi: v.odometer_mi || 100000, engineHours: 2600,
    mantis: { followS: 0.8, fcw: true, drowsiness: 0.1, seatbelt: true, eyesOff: 0.5 },
  };
  const payload = fixtures.build(provider, spec);
  const r = await ingest.handleEvent(provider, payload, { fleetId: f.id, auth: 'test', test: true });
  res.status(r.status === 'accepted' ? 200 : 422).json({ status: r.status, incidentId: r.incident ? r.incident.id : null, error: r.error || null, logId: r.logId, incident: r.incident || null, payloadSent: payload });
});

router.post('/api/onboarding/fleets/:id/vehicles', async (req, res) => {
  const f = getFleetOr404(req, res); if (!f) return;
  const rows = parseRoster(req.body);
  if (!rows || !rows.length) return res.status(422).json({ error: 'validation_failed', details: ['Send a JSON array, {"vehicles":[...]}, or {"csv":"unit,vin,plate,make,model,year,driver\\n..."}'] });
  if (rows.length > 20000) return res.status(413).json({ error: 'too_many_rows' });
  res.json(await upsertRoster(f, rows));
});

router.put('/api/onboarding/fleets/:id/alerts', async (req, res) => {
  const f = getFleetOr404(req, res); if (!f) return;
  const b = req.body || {};
  f.alertConfig = { emails: b.emails || [], sms: b.sms || [], minSeverity: b.minSeverity || 'high', configuredAt: new Date().toISOString() };
  await persistFleet(f);
  res.json({ alertConfig: f.alertConfig });
});

// Remove an onboarded/imported (custom or prospect) fleet and everything hanging off it. Seeded demo fleets are protected.
router.delete('/api/onboarding/fleets/:id', async (req, res) => {
  const f = getFleetOr404(req, res); if (!f) return;
  if (!f.custom && !f.prospect) return res.status(409).json({ error: 'protected_fleet', message: 'Seeded demo fleets cannot be removed; only onboarded or imported fleets.' });
  const out = { deleted: true, id: f.id, assessments: 0, reports: 0, importJobs: 0, apiKeys: 0 };
  await db.deleteIncidentsByFleet(f.id);
  for (const kind of ['assessment', 'report', 'import_job', 'api_key', 'alert', 'job']) {
    const rows = await db.list(kind, { fleetId: f.id, limit: 100000 });
    for (const r of rows) await db.del(kind, r.id);
    const k = { assessment: 'assessments', report: 'reports', import_job: 'importJobs', api_key: 'apiKeys' }[kind]; if (k) out[k] = rows.length;
  }
  await db.del('fleet', f.id);
  roster.removeFleet(f.id);
  res.json(out);
});

module.exports = { router, loadPersisted, persistFleet, newFleet, upsertRoster, checklist, prov };
