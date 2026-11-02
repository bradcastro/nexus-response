// Historical import: templates, preview/mapping, async jobs, data quality. Imported incidents NEVER create alerts/SSE/dispatch.
const express = require('express');
const crypto = require('crypto');
const roster = require('./roster');
const db = require('../db');
const onboarding = require('./onboarding');
const { parseCsv } = require('./csv');
const { decode } = require('./enrich/vin');
const risk = require('./enrich/risk');
const dtcLib = require('./enrich/dtc');
const { round, clamp } = require('./util');

const VENDORS = ['motive', 'samsara', 'geotab', 'lytx', 'mantis', 'nexus'];
const norm = (h) => String(h).toLowerCase().replace(/[^a-z0-9]/g, '');

// canonical import field -> accepted header synonyms (normalized)
const SYN = {
  externalId: ['eventid', 'id', 'externalid', 'exceptionid', 'uuid', 'eventuuid', 'recordid'],
  eventType: ['eventtype', 'type', 'behavior', 'behaviors', 'behaviour', 'rule', 'eventname', 'event', 'category', 'alerttype', 'behaviorlabel', 'safetyevent'],
  timestamp: ['timestamp', 'time', 'starttime', 'datetime', 'eventdate', 'occurredat', 'eventtime', 'activefrom', 'start', 'eventdatetime'],
  date: ['date', 'day', 'tripdate'],
  vin: ['vin', 'vehicleidentificationnumber'],
  unit: ['vehicle', 'vehiclename', 'unit', 'unitnumber', 'device', 'vehicleunit', 'vehicleid', 'assetname', 'truck', 'assetid'],
  plate: ['plate', 'licenseplate', 'registration', 'registrationnumber', 'tag'],
  driver: ['driver', 'drivername', 'employee', 'operator', 'employeename'],
  lat: ['latitude', 'lat'], lng: ['longitude', 'lng', 'lon', 'long'],
  speed: ['speed', 'speedmph', 'speedmilesperhour', 'speedkmh', 'speedkph', 'speedmphhr'],
  severity: ['severity', 'risklevel', 'priority', 'score'],
  address: ['address', 'location', 'formattedaddress', 'place', 'locationname'],
  video: ['videourl', 'video', 'mediaurl', 'clipurl', 'dashcamurl', 'clip', 'forwardvideourl'],
  dtc: ['dtc', 'faultcode', 'faultcodes', 'dtcs', 'codes', 'faults'],
  miles: ['miles', 'distance', 'distancemi', 'mileage', 'tripmiles', 'milesdriven', 'distancemiles'],
  hours: ['hours', 'enginehours', 'drivinghours', 'durationhours'],
  odometer: ['odometer', 'odometermi', 'odometermiles'],
  followingDistance: ['followingdistances', 'followingdistance', 'followdistances', 'headway'],
  drowsiness: ['drowsinessscore', 'drowsiness', 'fatiguescore'],
  phoneUse: ['phoneuse', 'phone', 'cellphone'],
  seatbelt: ['seatbelton', 'seatbelt'],
  aiClassification: ['aiclassification', 'aiverdict', 'classification'],
  aiConfidence: ['aiconfidence', 'confidence'],
  weight: ['weight', 'loadweight', 'grossweight', 'loadlb'],
};
// vendor export column names (exact headers) per template
const TPL = {
  nexus: { cols: ['externalId', 'eventType', 'timestamp', 'vin', 'unit', 'plate', 'driver', 'lat', 'lng', 'speed_mph', 'severity', 'address', 'video_url', 'dtc', 'odometer'], rows: [
    ['evt-1001', 'harsh_brake', '2026-09-03T14:22:10Z', '3AKJHHDR3PA000042', 'T-101', 'AL-GCF-101', 'Marcus Johnson', '30.6954', '-88.0399', '58', 'medium', 'I-10 EB, Mobile, AL', '', '', '214330'],
    ['evt-1002', 'collision', '2026-09-04T09:05:44Z', '3AKJHHDR3PA000042', 'T-101', 'AL-GCF-101', 'Marcus Johnson', '31.3152', '-85.8552', '41', 'critical', 'US-84 E, Enterprise, AL', 'https://example.com/clip.mp4', '', '214512'],
    ['evt-1003', 'fault_code', '2026-09-05T18:40:00Z', '1XPBDP9X7RA018815', 'T-102', 'NC-PLG-102', 'Keith Jones', '35.2271', '-80.8431', '0', 'high', 'Charlotte, NC', '', 'SPN 3251 FMI 0;SPN 4364 FMI 18', '98233']] },
  motive: { cols: ['Event ID', 'Event Type', 'Start Time', 'Vehicle', 'VIN', 'Driver', 'Latitude', 'Longitude', 'Speed (mph)', 'Severity', 'Video URL', 'Location'], rows: [['m-501', 'Hard Brake', '09/03/2026 02:22 PM', 'T-101', '3AKJHHDR3PA000042', 'Marcus Johnson', '30.6954', '-88.0399', '58', 'medium', '', 'I-10 EB, Mobile, AL'], ['m-502', 'Collision', '09/04/2026 09:05 AM', 'T-101', '3AKJHHDR3PA000042', 'Marcus Johnson', '31.3152', '-85.8552', '41', 'critical', 'https://example.com/m502.mp4', 'US-84 E, Enterprise, AL']] },
  samsara: { cols: ['Event ID', 'Behavior', 'Time', 'Vehicle Name', 'VIN', 'Driver Name', 'Latitude', 'Longitude', 'Speed (mph)', 'Severity', 'Media URL'], rows: [['s-9001', 'Harsh Braking', '2026-09-03T14:22:10Z', 'T-201', '4V4NC9EH5PN000123', 'Dana Reyes', '35.2271', '-80.8431', '61', 'medium', ''], ['s-9002', 'Mobile Usage', '2026-09-03T22:12:00Z', 'T-201', '4V4NC9EH5PN000123', 'Dana Reyes', '35.3392', '-80.8527', '57', 'high', 'https://example.com/s9002.mp4']] },
  geotab: { cols: ['Exception Id', 'Rule', 'DateTime', 'Device', 'VIN', 'Driver', 'Latitude', 'Longitude', 'Speed (km/h)'], rows: [['b1A2', 'Harsh Braking', '2026-09-03T14:22:10Z', 'Truck 11', '1XPBDP9X7RA018815', 'Sam Lee', '38.0406', '-84.459', '96'], ['b1A3', 'Possible Accident', '2026-09-08T06:10:00Z', 'Truck 11', '1XPBDP9X7RA018815', 'Sam Lee', '38.2098', '-84.5588', '72']] },
  lytx: { cols: ['Event ID', 'Behaviors', 'Event Date', 'Vehicle', 'VIN', 'Employee', 'Lat', 'Lon', 'Speed MPH', 'Score', 'Video'], rows: [['L-77001', 'Following Distance', '2026-09-03T14:22:10Z', 'V-31', '1FTBR2X85PKA00123', 'Pat Kim', '33.8003', '-84.3963', '55', 'medium', 'https://example.com/l77001.mp4'], ['L-77002', 'Cell Phone', '2026-09-03T16:45:10Z', 'V-31', '1FTBR2X85PKA00123', 'Pat Kim', '33.9201', '-84.5502', '48', 'high', 'https://example.com/l77002.mp4']] },
  mantis: { cols: ['event_id', 'event_type', 'occurred_at', 'vehicle_unit', 'vin', 'driver_name', 'lat', 'lng', 'speed_mph', 'following_distance_s', 'drowsiness_score', 'phone_use', 'seatbelt_on', 'ai_classification', 'ai_confidence', 'clip_url'], rows: [['mtx-1', 'tailgating', '2026-09-03T14:22:10Z', 'R-301', '3AKJHHDR3PA000042', 'Lee Ortiz', '36.1627', '-86.7816', '62', '0.7', '0.1', 'false', 'true', 'near_miss', '0.94', 'https://example.com/mtx1.mp4'], ['mtx-2', 'drowsiness', '2026-09-03T23:50:10Z', 'R-301', '3AKJHHDR3PA000042', 'Lee Ortiz', '36.0726', '-79.792', '60', '2.1', '0.82', 'false', 'true', 'distraction', '0.96', 'https://example.com/mtx2.mp4']] },
  mileage: { cols: ['vin', 'date', 'miles', 'hours'], rows: [['3AKJHHDR3PA000042', '2026-09-03', '412', '9.5'], ['3AKJHHDR3PA000042', '2026-09-04', '388', '9.1'], ['1XPBDP9X7RA018815', '2026-09-03', '355', '8.2']] },
};
const DOCS = {
  externalId: 'Unique event id from the source system (used for de-duplication)', eventType: 'Event/behavior label (e.g. Hard Brake, Collision, Following Distance, Mobile Usage, Fault Code) - REQUIRED',
  timestamp: 'Event time: ISO-8601, MM/DD/YYYY hh:mm AM/PM, or epoch seconds/ms - REQUIRED', vin: 'Vehicle VIN (strongly recommended - enables make/model/warranty lookups)', unit: 'Vehicle/unit name', plate: 'License plate', driver: 'Driver name',
  lat: 'Latitude', lng: 'Longitude', speed: 'Speed (mph; columns named km/h are converted)', severity: 'critical|high|medium|low (optional)', address: 'Free-text location', video: 'Clip URL (counts toward camera coverage)', dtc: 'Fault codes, separated by ; or |',
  miles: 'MILEAGE rows: miles driven that day', hours: 'MILEAGE rows: engine/drive hours', date: 'MILEAGE rows: date (YYYY-MM-DD)',
};
const VENDOR_COLS = {
  motive: { externalId: 'Event ID', eventType: 'Event Type', timestamp: 'Start Time', unit: 'Vehicle', vin: 'VIN', driver: 'Driver', lat: 'Latitude', lng: 'Longitude', speed: 'Speed (mph)', severity: 'Severity', video: 'Video URL', address: 'Location' },
  samsara: { externalId: 'Event ID', eventType: 'Behavior', timestamp: 'Time', unit: 'Vehicle Name', vin: 'VIN', driver: 'Driver Name', lat: 'Latitude', lng: 'Longitude', speed: 'Speed (mph)', severity: 'Severity', video: 'Media URL' },
  geotab: { externalId: 'Exception Id', eventType: 'Rule', timestamp: 'DateTime', unit: 'Device', vin: 'VIN', driver: 'Driver', lat: 'Latitude', lng: 'Longitude', speed: 'Speed (km/h)' },
  lytx: { externalId: 'Event ID', eventType: 'Behaviors', timestamp: 'Event Date', unit: 'Vehicle', vin: 'VIN', driver: 'Employee', lat: 'Lat', lng: 'Lon', speed: 'Speed MPH', severity: 'Score', video: 'Video' },
  mantis: { externalId: 'event_id', eventType: 'event_type', timestamp: 'occurred_at', unit: 'vehicle_unit', vin: 'vin', driver: 'driver_name', lat: 'lat', lng: 'lng', speed: 'speed_mph', video: 'clip_url', followingDistance: 'following_distance_s', drowsiness: 'drowsiness_score', phoneUse: 'phone_use', seatbelt: 'seatbelt_on', aiClassification: 'ai_classification', aiConfidence: 'ai_confidence' },
};

function labelToType(l = '') {
  l = String(l).toLowerCase();
  if (/rollover/.test(l)) return 'rollover';
  if (/collision|crash|accident|impact/.test(l)) return 'collision';
  if (/brak/.test(l)) return 'harsh_brake';
  if (/accel/.test(l)) return 'harsh_accel';
  if (/corner|turn|swerv/.test(l)) return 'harsh_turn';
  if (/speed/.test(l)) return 'speeding';
  if (/phone|cell|distract|drows|fatigue|smok|inattent|eyes|mobile/.test(l)) return 'distracted';
  if (/follow|tailgat|headway/.test(l)) return 'following_distance';
  if (/breakdown/.test(l)) return 'breakdown';
  if (/fault|dtc|diagnostic|check engine|mil/.test(l)) return 'fault_code';
  if (/tire|tyre/.test(l)) return 'tire';
  if (/battery|voltage/.test(l)) return 'battery';
  return 'other';
}
const CAT = { collision: 'collision', rollover: 'collision', fault_code: 'diagnostic', breakdown: 'roadside', tire: 'roadside', battery: 'roadside' };
const SEV = { collision: 'critical', rollover: 'critical', breakdown: 'high', tire: 'medium', battery: 'medium', distracted: 'medium', harsh_brake: 'medium', harsh_accel: 'low', harsh_turn: 'low', speeding: 'low', following_distance: 'low', fault_code: 'medium', other: 'low' };

function parseTime(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' || /^\d{9,13}(\.\d+)?$/.test(String(v).trim())) { let n = +v; if (n < 1e11) n *= 1000; const d = new Date(n); return isNaN(d) ? null : d; }
  let s = String(v).trim();
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$/i);
  if (m) {
    let h = m[4] ? +m[4] : 0; if (m[7]) { if (/pm/i.test(m[7]) && h < 12) h += 12; if (/am/i.test(m[7]) && h === 12) h = 0; }
    const d = new Date(Date.UTC(+m[3], +m[1] - 1, +m[2], h, m[5] ? +m[5] : 0, m[6] ? +m[6] : 0)); return isNaN(d) ? null : d;
  }
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? s + 'T00:00:00Z' : (/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : s.replace(' ', 'T') + (/T/.test(s.replace(' ', 'T')) ? 'Z' : '')));
  return isNaN(d) ? null : d;
}
const numOrNull = (v) => { if (v == null || v === '') return null; const n = parseFloat(String(v).replace(/,/g, '')); return Number.isFinite(n) ? n : null; };
const boolOrNull = (v) => (v == null || v === '' ? null : /^(1|true|yes|y)$/i.test(String(v).trim()) ? true : /^(0|false|no|n)$/i.test(String(v).trim()) ? false : null);

function flatten(o, pre = '', out = {}) {
  for (const [k, v] of Object.entries(o || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, pre + k + '.', out); else out[pre + k] = Array.isArray(v) ? v.map((x) => (typeof x === 'object' ? JSON.stringify(x) : x)).join(';') : v;
  }
  return out;
}
function loadRows(body) {
  const fmt = (body.format || (body.csv ? 'csv' : 'json')).toLowerCase();
  if (fmt === 'csv') {
    const text = body.csv != null ? body.csv : body.data;
    if (typeof text !== 'string' || !text.trim()) throw Object.assign(new Error('csv text is empty'), { status: 422 });
    const { headers, rows } = parseCsv(text);
    if (!headers.length) throw Object.assign(new Error('could not read CSV header row'), { status: 422 });
    return { headers, objs: rows.map((r) => { const o = {}; headers.forEach((h, i) => { o[h] = r[i]; }); return o; }) };
  }
  let d = body.data;
  if (typeof d === 'string') { try { d = JSON.parse(d); } catch { throw Object.assign(new Error('data is not valid JSON'), { status: 422 }); } }
  if (d && !Array.isArray(d) && (Array.isArray(d.events) || Array.isArray(d.trips))) d = [...(d.events || []), ...(d.trips || [])];
  if (!Array.isArray(d) || !d.length) throw Object.assign(new Error('data must be a non-empty JSON array of rows (or {events:[],trips:[]})'), { status: 422 });
  const objs = d.map((r) => flatten(r));
  const hs = new Set(); for (const o of objs.slice(0, 200)) Object.keys(o).forEach((k) => hs.add(k));
  return { headers: [...hs], objs };
}

function suggestMapping(headers, vendor) {
  const taken = new Set(); const map = {};
  const pref = VENDOR_COLS[vendor] || {};
  for (const [f, col] of Object.entries(pref)) { const h = headers.find((x) => norm(x) === norm(col)); if (h) { map[f] = h; taken.add(h); } }
  for (const [f, syns] of Object.entries(SYN)) {
    if (map[f]) continue;
    const h = headers.find((x) => !taken.has(x) && syns.includes(norm(x)));
    if (h) { map[f] = h; taken.add(h); }
  }
  // nexus template uses speed_mph / video_url
  return map;
}

// Normalise one source row. Returns {kind:'event'|'mileage'|'invalid', ...}
function normalizeRow(o, map, vendor) {
  const g = (f) => { const c = map[f]; if (!c) return null; const v = o[c]; return v == null || (typeof v === 'string' && v.trim() === '') ? null : (typeof v === 'string' ? v.trim() : v); };
  const typeV = g('eventType');
  const miles = numOrNull(g('miles'));
  const when = g('timestamp') != null ? g('timestamp') : g('date');
  const warnings = [];
  if (typeV == null) {
    if (miles != null && when != null) {
      const d = parseTime(when); if (!d) return { kind: 'invalid', error: `invalid date: ${when}` };
      return { kind: 'mileage', vin: g('vin'), unit: g('unit'), date: d.toISOString().slice(0, 10), miles, hours: numOrNull(g('hours')) };
    }
    return { kind: 'invalid', error: 'row has no event type and no mileage' };
  }
  const d = parseTime(when);
  if (!d) return { kind: 'invalid', error: when == null ? 'timestamp missing' : `invalid timestamp: ${when}` };
  if (d > Date.now() + 86400000) return { kind: 'invalid', error: 'timestamp is in the future' };
  let lat = numOrNull(g('lat')), lng = numOrNull(g('lng'));
  if ((lat != null && (lat < -90 || lat > 90)) || (lng != null && (lng < -180 || lng > 180))) { lat = lng = null; warnings.push('gps out of range'); }
  if ((lat === 0 && lng === 0)) { lat = lng = null; }
  let speed = numOrNull(g('speed'));
  const speedCol = map.speed ? norm(map.speed) : '';
  if (speed != null && (/kmh|kph|km/.test(speedCol) || (vendor === 'geotab' && !/mph/.test(speedCol)))) speed = speed * 0.621371;
  if (speed != null && (speed < 0 || speed > 220)) { speed = null; warnings.push('speed out of range'); }
  const vin = g('vin') ? String(g('vin')).toUpperCase() : null;
  const dtcRaw = g('dtc');
  const sev = g('severity') ? String(g('severity')).toLowerCase() : null;
  const eventType = ['collision', 'rollover', 'harsh_brake', 'harsh_accel', 'harsh_turn', 'speeding', 'distracted', 'following_distance', 'fault_code', 'breakdown', 'tire', 'battery', 'other'].includes(String(typeV).toLowerCase()) ? String(typeV).toLowerCase() : labelToType(typeV);
  return {
    kind: 'event', warnings,
    ev: {
      externalId: g('externalId') != null ? String(g('externalId')) : null, eventType, timestamp: d.toISOString(), vin: vin && /^[A-HJ-NPR-Z0-9]{17}$/.test(vin) ? vin : (vin ? null : null), badVin: vin && !/^[A-HJ-NPR-Z0-9]{17}$/.test(vin) ? vin : null,
      unit: g('unit') != null ? String(g('unit')) : null, plate: g('plate'), driver: g('driver'), lat, lng, speed_mph: speed != null ? round(speed, 1) : null,
      severity: ['critical', 'high', 'medium', 'low'].includes(sev) ? sev : null, address: g('address'), video: g('video'), dtc: dtcRaw ? String(dtcRaw).split(/[;|]/).map((x) => x.trim()).filter(Boolean) : [], odometer: numOrNull(g('odometer')), weight: numOrNull(g('weight')),
      followS: numOrNull(g('followingDistance')), drowsiness: numOrNull(g('drowsiness')), phoneUse: boolOrNull(g('phoneUse')), seatbelt: boolOrNull(g('seatbelt')), aiClass: g('aiClassification'), aiConf: numOrNull(g('aiConfidence')),
    },
  };
}

// ---------- preview ----------
function preview(body) {
  const vendor = VENDORS.includes(body.vendor) ? body.vendor : 'nexus';
  const { headers, objs } = loadRows(body);
  const map = { ...suggestMapping(headers, vendor), ...(body.mapping || {}) };
  const warnings = [];
  for (const [f, c] of Object.entries(body.mapping || {})) if (c && !headers.includes(c)) warnings.push(`mapping for '${f}' points at unknown column '${c}'`);
  const hasMileCols = !!(map.miles && (map.date || map.timestamp));
  if (!map.eventType && !hasMileCols) warnings.push("No event type column detected - map 'eventType' (or provide mileage columns miles + date)");
  if (!map.timestamp && !map.date) warnings.push("No timestamp column detected - map 'timestamp'");
  if (!map.vin && !map.unit && !map.plate) warnings.push('No VIN/unit/plate column - vehicles cannot be identified');
  if (!map.lat || !map.lng) warnings.push('No GPS columns - hotspot analysis and location data will be unavailable');
  if (!map.driver) warnings.push('No driver column - driver-level risk ranking will be unavailable');
  if (!map.vin) warnings.push('No VIN column - warranty/make-model enrichment will be skipped');
  const sample = []; const kinds = { events: 0, mileage: 0, invalid: 0 }; const errCount = {};
  const head = objs.slice(0, 500);
  for (const o of head) {
    const r = normalizeRow(o, map, vendor);
    if (r.kind === 'event') { kinds.events++; if (sample.length < 5) sample.push({ kind: 'event', ...r.ev }); } else if (r.kind === 'mileage') { kinds.mileage++; if (sample.length < 5) sample.push(r); } else { kinds.invalid++; errCount[r.error] = (errCount[r.error] || 0) + 1; }
  }
  if (kinds.invalid) warnings.push(`${kinds.invalid} of the first ${head.length} rows could not be parsed (${Object.entries(errCount).slice(0, 3).map(([k, v]) => `${k} x${v}`).join('; ')})`);
  if (objs.length > 50000) warnings.push('Very large file: processing runs in chunks and may take a minute');
  return { vendor, detectedColumns: headers, suggestedMapping: suggestMapping(headers, vendor), mapping: map, sample, warnings, rows: objs.length, kinds };
}

// ---------- jobs ----------
let seq = 0;
async function createJob(body) {
  const vendor = VENDORS.includes(body.vendor) ? body.vendor : 'nexus';
  const purpose = ['underwriting', 'onboarding'].includes(body.purpose) ? body.purpose : 'underwriting';
  const { headers, objs } = loadRows(body);
  const map = { ...suggestMapping(headers, vendor), ...(body.mapping || {}) };
  if (!map.eventType && !(map.miles && (map.date || map.timestamp))) throw Object.assign(new Error("Cannot import: no event type column mapped. Run /api/import/preview and pass a mapping."), { status: 422 });
  if (!map.timestamp && !map.date) throw Object.assign(new Error("Cannot import: no timestamp column mapped."), { status: 422 });
  let fleet = body.fleetId ? roster.getFleet(body.fleetId) : null;
  if (body.fleetId && !fleet) throw Object.assign(new Error('fleet not found'), { status: 404 });
  if (!fleet) {
    const nf = body.newFleet;
    if (!nf || !nf.name) throw Object.assign(new Error('provide fleetId or newFleet:{name,vendor,vehicles?}'), { status: 422 });
    if (roster.all().some((f) => f.name.toLowerCase() === nf.name.trim().toLowerCase())) throw Object.assign(new Error('a fleet with this name already exists; pass its fleetId'), { status: 422 });
    fleet = onboarding.newFleet({ name: nf.name.trim(), vendor: nf.vendor || (vendor === 'nexus' ? 'other' : vendor), vehicles: nf.vehicles != null ? +nf.vehicles : 0, contactName: nf.contactName, contactEmail: nf.contactEmail, region: nf.region });
    fleet.onboarding.source = 'historical_import';
    fleet.prospect = purpose === 'underwriting'; // assessed prospects are not part of the live insurer portfolio
    roster.addFleet(fleet); await onboarding.persistFleet(fleet);
  }
  const job = {
    id: 'job_' + Date.now().toString(36) + (++seq).toString(36), status: 'queued', progress: 0, rowsTotal: objs.length, rowsOk: 0, rowsSkipped: 0, errors: [], dataQuality: null, fleetId: fleet.id, assessmentId: null,
    vendor, purpose, mapping: map, createdAt: new Date().toISOString(), startedAt: null, finishedAt: null,
  };
  await db.put('import_job', job);
  setImmediate(() => runJob(job, objs, map, fleet).catch(async (e) => { job.status = 'failed'; job.errors.push({ row: null, message: e.message }); job.finishedAt = new Date().toISOString(); console.error('[NEXUS] import job failed:', e.stack); await db.put('import_job', job); }));
  return job;
}

const HEAVY = ['Freightliner', 'Peterbilt', 'Kenworth', 'Volvo', 'International', 'Mack'];
async function runJob(job, objs, map, fleet) {
  job.status = 'running'; job.startedAt = new Date().toISOString(); await db.put('import_job', job);
  const vendor = job.vendor === 'nexus' ? 'generic' : job.vendor;
  const vehMap = new Map(); for (const v of fleet.vehicles) { if (v.vin) vehMap.set('vin:' + v.vin, v); vehMap.set('unit:' + v.unit, v); }
  const drvMap = new Map(fleet.drivers.map((d) => [d.name, d]));
  const seen = new Set();
  const cov = { n: 0, vin: 0, driver: 0, gps: 0, speed: 0, video: 0, dtc: 0, load: 0 };
  const dates = new Set(); let minT = Infinity, maxT = -Infinity;
  let dup = 0, badVin = 0, mileRows = 0, milesTotal = 0, noTs = 0;
  const mileByVeh = new Map();
  let buf = [];
  const decCache = new Map();
  const CH = 500;
  for (let i = 0; i < objs.length; i++) {
    const r = normalizeRow(objs[i], map, job.vendor);
    if (r.kind === 'invalid') { job.rowsSkipped++; if (job.errors.length < 200) job.errors.push({ row: i + 2, message: r.error }); }
    else if (r.kind === 'mileage') {
      const key = `${r.vin || r.unit}|${r.date}`; if (seen.has('m' + key)) { dup++; job.rowsSkipped++; continue; } seen.add('m' + key);
      mileRows++; milesTotal += r.miles; job.rowsOk++;
      const mv = mileByVeh.get(r.vin || r.unit) || { miles: 0, days: new Set() }; mv.miles += r.miles; mv.days.add(r.date); mileByVeh.set(r.vin || r.unit, mv);
      const t = +new Date(r.date); minT = Math.min(minT, t); maxT = Math.max(maxT, t); dates.add(r.date);
      if (r.vin && !vehMap.has('vin:' + r.vin)) await getVehicle(r.vin, r.unit);
    } else {
      const ev = r.ev;
      const key = ev.externalId ? `id:${ev.externalId}` : `${ev.vin || ev.unit || ''}|${ev.timestamp}|${ev.eventType}`;
      if (seen.has(key) || await db.findByProviderEvent(vendor, ev.externalId || ('imp_' + key))) { dup++; job.rowsSkipped++; continue; }
      seen.add(key);
      if (ev.badVin) badVin++;
      const t = +new Date(ev.timestamp); minT = Math.min(minT, t); maxT = Math.max(maxT, t); dates.add(ev.timestamp.slice(0, 10));
      cov.n++; if (ev.vin) cov.vin++; if (ev.driver) cov.driver++; if (ev.lat != null) cov.gps++; if (ev.speed_mph != null) cov.speed++; if (ev.video) cov.video++; if (ev.dtc.length) cov.dtc++; if (ev.weight != null) cov.load++;
      const veh = await getVehicle(ev.vin, ev.unit, ev.plate, ev);
      const drv = ev.driver ? getDriver(ev.driver, veh) : null;
      buf.push(buildIncident(ev, job, fleet, veh, drv, vendor, i + 2));
      job.rowsOk++;
    }
    if ((i + 1) % CH === 0 || i === objs.length - 1) {
      if (buf.length) { await db.saveIncidentsBulk(buf); buf = []; }
      job.progress = round((i + 1) / objs.length, 3);
      await db.put('import_job', job);
      await new Promise((rr) => setImmediate(rr));
    }
  }
  if (buf.length) { await db.saveIncidentsBulk(buf); buf = []; }
  async function getVehicle(vin, unit, plate, ev) {
    const key = vin ? 'vin:' + vin : 'unit:' + (unit || plate || 'unknown');
    let v = vehMap.get(key) || (unit && vehMap.get('unit:' + unit));
    if (!v) {
      let dec = null; if (vin) { if (!decCache.has(vin)) decCache.set(vin, await decode(vin)); dec = decCache.get(vin); }
      v = { id: `veh_${fleet.id.slice(6, 12)}_${String(fleet.vehicles.length + 1).padStart(4, '0')}`, fleetId: fleet.id, unit: unit || (vin ? vin.slice(-6) : 'unknown'), vin: vin || null, plate: plate || null, make: dec && dec.make, model: dec && dec.model, year: dec && dec.year, oem: dec && dec.oem, engine: dec && dec.engine, cls: dec && HEAVY.includes(dec.oem) ? 'heavy' : (dec && dec.oem ? 'light' : 'heavy'), hasCamera: false, odometer_mi: ev && ev.odometer || 0, providerVehicleId: unit || vin, position: { lat: null, lng: null, speed_mph: 0, status: 'unknown' } };
      fleet.vehicles.push(v); vehMap.set(key, v); if (unit) vehMap.set('unit:' + unit, v);
    }
    if (ev) { if (ev.video) v.hasCamera = true; if (ev.odometer) v.odometer_mi = Math.max(v.odometer_mi || 0, ev.odometer); if (ev.lat != null) v.position = { lat: ev.lat, lng: ev.lng, speed_mph: ev.speed_mph || 0, status: 'unknown', t: ev.timestamp }; }
    return v;
  }
  function getDriver(name, veh) {
    let d = drvMap.get(name);
    if (!d) { d = { id: `drv_${fleet.id.slice(6, 12)}_${String(fleet.drivers.length + 1).padStart(3, '0')}`, fleetId: fleet.id, name, phone: null, providerDriverId: name, safetyScore: 90, vehicleId: veh ? veh.id : null }; fleet.drivers.push(d); drvMap.set(name, d); }
    if (veh && !veh.driverId) veh.driverId = d.id;
    return d;
  }
  // finalize
  const nEv = cov.n;
  const days = isFinite(minT) ? Math.max(1, Math.round((maxT - minT) / 86400000) + 1) : 0;
  const pc = (n) => (nEv ? Math.round((100 * n) / nEv) : 0);
  const fieldCoverage = { vin: pc(cov.vin), driver: pc(cov.driver), gps: pc(cov.gps), speed: pc(cov.speed), video: pc(cov.video), dtc: pc(cov.dtc), load: pc(cov.load) };
  const parseRate = job.rowsTotal ? (job.rowsOk + dup) / job.rowsTotal : 0;
  const dupRate = job.rowsTotal ? dup / job.rowsTotal : 0;
  const score = clamp(Math.round(0.2 * fieldCoverage.vin + 0.2 * fieldCoverage.driver + 0.2 * fieldCoverage.gps + 0.1 * fieldCoverage.speed + 0.1 * fieldCoverage.video + 15 * parseRate + 5 * Math.min(1, days / 60) - Math.min(10, dupRate * 100)), 0, 100);
  const notes = [];
  if (fieldCoverage.vin < 80) notes.push(`Only ${fieldCoverage.vin}% of events carry a VIN - vehicle-level analysis and warranty lookups are limited.`);
  if (fieldCoverage.driver < 70) notes.push(`${100 - fieldCoverage.driver}% of events have no driver - driver risk ranking is partial.`);
  if (fieldCoverage.gps < 70) notes.push(`${100 - fieldCoverage.gps}% of events have no GPS - hotspot analysis is limited.`);
  if (fieldCoverage.video === 0) notes.push('No video/clip references - camera verification and driver-facing signals unavailable (lower prediction confidence).');
  if (days < 30) notes.push(`Only ${days} day(s) of history - projections are low confidence (90+ days recommended).`);
  if (!mileRows) notes.push('No mileage/trip rows - exposure (events per million miles) will be estimated.');
  if (badVin) notes.push(`${badVin} events had malformed VINs (ignored).`);
  if (dup) notes.push(`${dup} duplicate rows were skipped.`);
  job.dataQuality = { dateRange: isFinite(minT) ? { from: new Date(minT).toISOString().slice(0, 10), to: new Date(maxT).toISOString().slice(0, 10) } : null, days, vehicles: fleet.vehicles.length, drivers: fleet.drivers.length, fieldCoverage, duplicates: dup, mileageRows: mileRows, milesTotal: Math.round(milesTotal), qualityScore: score, notes };
  fleet.vehicleCount = Math.max(fleet.vehicleCount || 0, fleet.vehicles.length);
  if (mileRows) fleet.exposure = { milesTotal: Math.round(milesTotal), basis: 'reported', from: job.dataQuality.dateRange.from, to: job.dataQuality.dateRange.to, vehicles: mileByVeh.size };
  fleet.cameraPct = fleet.vehicles.length ? fleet.vehicles.filter((v) => v.hasCamera).length / fleet.vehicles.length : 0;
  fleet.onboarding = { ...(fleet.onboarding || {}), historyImportedAt: new Date().toISOString() };
  roster.reindex();
  await onboarding.persistFleet(fleet);
  job.status = 'completed'; job.progress = 1; job.finishedAt = new Date().toISOString();
  await db.put('import_job', job);
  try { const assess = require('./assess'); const a = await assess.run({ fleetId: fleet.id, jobId: job.id }); job.assessmentId = a.id; await db.put('import_job', job); } catch (e) { console.error('[NEXUS] auto-assessment failed:', e.stack); job.errors.push({ row: null, message: 'assessment failed: ' + e.message }); await db.put('import_job', job); }
}

function buildIncident(ev, job, fleet, veh, drv, vendor, rowNo) {
  const id = `IMP-${job.id.slice(-6)}-${String(rowNo).padStart(6, '0')}`;
  const type = ev.eventType;
  const dtcs = dtcLib.decodeAll(ev.dtc);
  const hasVideo = !!ev.video;
  const aiVerdict = hasVideo ? (/false/i.test(ev.aiClass || '') ? 'false_positive' : type === 'collision' ? 'confirmed_collision' : type === 'distracted' ? 'distraction' : 'confirmed_event') : 'no_video';
  const signals = [];
  if (ev.followS != null) signals.push({ key: 'following_distance_s', label: 'Following distance', value: ev.followS, unit: 's', triggered: ev.followS < 1.0 });
  if (ev.drowsiness != null) signals.push({ key: 'drowsiness_score', label: 'Drowsiness score', value: ev.drowsiness, unit: 'score', triggered: ev.drowsiness >= 0.6 });
  if (ev.phoneUse != null) signals.push({ key: 'phone_use', label: 'Phone use', value: ev.phoneUse ? 1 : 0, unit: null, triggered: ev.phoneUse });
  if (ev.seatbelt === false) signals.push({ key: 'seatbelt_unbuckled', label: 'Seatbelt', value: 1, unit: null, triggered: true });
  if (!signals.length) signals.push({ key: { collision: 'impact', harsh_brake: 'harsh_braking', harsh_accel: 'harsh_acceleration', harsh_turn: 'harsh_cornering', speeding: 'speeding', distracted: 'phone_use', following_distance: 'following_distance_s', fault_code: 'dtc_active' }[type] || 'event', label: type.replace(/_/g, ' '), value: null, unit: null, triggered: true });
  const inc = {
    id, provider: vendor, providerEventId: ev.externalId || ('imp_' + crypto.createHash('sha1').update(`${ev.vin || ev.unit || ''}|${ev.timestamp}|${type}`).digest('hex').slice(0, 14)),
    source: 'historical_import', import: { jobId: job.id, row: rowNo }, fleetId: fleet.id, fleetName: fleet.name,
    eventType: type, category: CAT[type] || 'safety', severity: ev.severity || (dtcs.length ? dtcLib.summarize(dtcs).severity || SEV[type] : SEV[type]), status: 'resolved',
    timestamp: ev.timestamp, receivedAt: ev.timestamp, resolvedAt: ev.timestamp,
    vehicle: { id: veh.id, vin: veh.vin, year: veh.year || null, make: veh.make || null, model: veh.model || null, plate: veh.plate || ev.plate || null, odometer_mi: ev.odometer || veh.odometer_mi || null, engine: veh.engine || null, oem: veh.oem || null, unit: veh.unit },
    driver: { id: drv ? drv.id : null, name: drv ? drv.name : null, phone: null, safetyScore: null },
    location: { lat: ev.lat, lng: ev.lng, address: ev.address || (ev.lat != null ? `${ev.lat.toFixed(4)}, ${ev.lng.toFixed(4)}` : null), speed_mph: ev.speed_mph, heading: null, road: ev.address ? String(ev.address).split(',')[0] : null },
    trail: [],
    camera: { provider: vendor, verified: hasVideo, aiVerdict, confidence: hasVideo ? (ev.aiConf != null ? ev.aiConf : 0.8) : 0, clips: hasVideo ? [{ url: ev.video, type: 'road', durationSec: null }] : [], snapshots: [], signals: signals.filter((s) => s.triggered).map((s) => s.label + (s.value != null ? ` ${s.value}${s.unit ? s.unit : ''}` : '')) },
    diagnostics: dtcs.length ? { dtcs, drivable: dtcLib.summarize(dtcs).drivable, engineHours: null, faultLampOn: true } : null,
    roadside: { needed: false, serviceType: 'none', recommendedProvider: null, assignedProvider: null, etaMin: null, rationale: 'Historical record', alternatives: [] },
    warranty: null, trip: null, equipment: null, load: ev.weight != null ? { estimatedWeightLb: ev.weight, weightRangeLb: [ev.weight, ev.weight], method: 'reported', confidence: 1, basis: ['Reported in import file'], contents: null, cameraVisual: null } : null, warrantyDealer: null,
    signals, timeline: [{ t: ev.timestamp, actor: 'system', action: 'imported', note: `Historical import ${job.id} (row ${rowNo})` }], raw: null,
  };
  const rs = risk.score(inc);
  inc.risk = rs; inc.risk.tags = [...rs.tags, 'historical_import'];
  return inc;
}

const router = express.Router();
router.get('/api/import/templates/:vendor', (req, res) => {
  const v = req.params.vendor;
  if (!TPL[v]) return res.status(404).json({ error: 'Unknown template', available: Object.keys(TPL) });
  const { toCsv } = require('./csv');
  const csv = toCsv(TPL[v].cols, TPL[v].rows);
  if (req.query.format === 'json') {
    const m = suggestMapping(TPL[v].cols, v);
    return res.json({ vendor: v, columns: TPL[v].cols.map((c) => { const f = Object.keys(m).find((k) => m[k] === c); return { column: c, mapsTo: f || null, description: f ? DOCS[f] || null : null }; }), requiredFields: v === 'mileage' ? ['vin (or unit)', 'date', 'miles'] : ['eventType', 'timestamp', 'vin or unit'], notes: 'Mileage/trip rows (vin,date,miles,hours) may be uploaded alongside events to compute events per million miles.', csv });
  }
  res.type('text/csv').set('Content-Disposition', `attachment; filename="nexus-import-${v}.csv"`).send(csv);
});
router.post('/api/import/preview', (req, res) => {
  try { res.json(preview(req.body || {})); } catch (e) { res.status(e.status || 422).json({ error: 'validation_failed', message: e.message }); }
});
router.post('/api/import/jobs', async (req, res) => {
  try { const job = await createJob(req.body || {}); res.status(202).json({ job }); } catch (e) { res.status(e.status || 422).json({ error: 'validation_failed', message: e.message }); }
});
router.get('/api/import/jobs', async (req, res) => res.json({ jobs: (await db.list('import_job', { fleetId: req.query.fleetId, limit: 200 })).map(({ errors, ...j }) => ({ ...j, errorCount: errors.length })) }));
router.get('/api/import/jobs/:id', async (req, res) => { const j = await db.get('import_job', req.params.id); if (!j) return res.status(404).json({ error: 'Job not found' }); res.json(j); });
router.delete('/api/import/jobs/:id', async (req, res) => { const j = await db.get('import_job', req.params.id); if (!j) return res.status(404).json({ error: 'Job not found' }); await db.deleteIncidentsByJob(j.id); await db.del('import_job', j.id); res.json({ deleted: true }); });

async function bootRecover() { // jobs left 'running' by a previous process cannot continue
  for (const j of await db.list('import_job', { limit: 500 })) if (j.status === 'running' || j.status === 'queued') { j.status = 'failed'; j.errors.push({ row: null, message: 'server restarted during import' }); await db.put('import_job', j); }
}
module.exports = { router, preview, createJob, bootRecover, labelToType, TPL };
