// Report-builder datasets. Every dataset is DERIVED from the existing in-memory/Postgres store at run time (incidents, comms,
// jobs, rosters, risk history). Nothing here is stored separately, and everything is synthetic demo data.
const db = require('../db');
const roster = require('./roster');
const A = require('./analytics');
const I = require('./insurer');
const H = require('./history');
const D = require('./data/ops');
const { round } = require('./util');

const DAY = 86400000, HOUR = 3600000;
const isFP = I.isFP;
const mins = (a, b) => (a == null || b == null ? null : (b - a) / 60000);
const ms = (t) => (t ? +new Date(t) : null);
const iso = (t) => (t == null ? null : new Date(t).toISOString());
const med = (a) => { const s = a.filter((x) => x != null).sort((x, y) => x - y); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

const EVENT_TYPES = ['collision', 'rollover', 'distracted', 'following_distance', 'harsh_brake', 'harsh_accel', 'harsh_turn', 'speeding', 'fault_code', 'breakdown', 'tire', 'battery', 'other'];
const SAFETY_TYPES = ['collision', 'rollover', 'distracted', 'following_distance', 'harsh_brake', 'harsh_accel', 'harsh_turn', 'speeding', 'other'];
const SEVERITIES = ['low', 'medium', 'high', 'critical'];
const STATUSES = ['pending', 'validating', 'dispatched', 'en_route', 'on_scene', 'resolved', 'dismissed'];
const CATEGORIES = ['safety', 'collision', 'roadside', 'diagnostic'];
const CLAIM_STATUSES = ['draft', 'ready', 'submitted', 'under_review', 'more_info_needed', 'approved', 'denied', 'paid'];
const OPEN_STATUSES = A.OPEN;

// ---------- field helpers ----------
const NUM = ['count', 'sum', 'avg', 'min', 'max', 'median', 'p90'];
function f(id, label, type, o = {}) {
  const fld = { id, label, type, filterable: o.filterable !== false, groupable: o.groupable !== undefined ? o.groupable : (type === 'enum' || type === 'boolean'), sortable: o.sortable !== false };
  if (o.enumValues) fld.enumValues = o.enumValues;
  if (o.unit) fld.unit = o.unit;
  fld.aggregations = o.aggregations || (type === 'number' ? NUM : type === 'boolean' ? ['count', 'rate'] : type === 'date' ? ['count', 'min', 'max'] : ['count']);
  if (type === 'enum' || type === 'string') fld.rateByValue = true; // metric {agg:'rate', value:<v>} = share of rows equal to v
  return fld;
}
const S = (id, label, o) => f(id, label, 'string', o);
const E = (id, label, enumValues, o = {}) => f(id, label, 'enum', { ...o, enumValues });
const N = (id, label, unit, o = {}) => f(id, label, 'number', { ...o, unit });
const B = (id, label, o) => f(id, label, 'boolean', o);
const T = (id, label, o) => f(id, label, 'date', { groupable: false, ...o });

// ---------- context ----------
async function loadCtx(scope) {
  const incidents = await H.loadIncidents();
  const ctx = { now: Date.now(), incidents, scope: scope || null, _c: {} };
  ctx.fleets = roster.all().filter((x) => !x.prospect);
  ctx.memo = (k, fn) => (k in ctx._c ? ctx._c[k] : (ctx._c[k] = fn()));
  return ctx;
}
const tl = (i, re) => { const e = (i.timeline || []).find((x) => re.test(x.action)); return e ? ms(e.t) : null; };
const claimPacket = (i) => (i.warranty && i.warranty.claimPacket) || null;
const closedMs = (i) => tl(i, /^resolved$/);

// ---------- incidents ----------
function ageBucket(h) { return h == null ? null : h < 1 ? '<1h' : h < 4 ? '1-4h' : h < 24 ? '4-24h' : h < 72 ? '1-3d' : '>3d'; }
function incidentRow(i, ctx) {
  const open = OPEN_STATUSES.includes(i.status);
  const rcv = ms(i.receivedAt) || ms(i.timestamp);
  const disp = tl(i, /^dispatched$/), resv = closedMs(i);
  const cp = claimPacket(i);
  const ageH = open ? round((ctx.now - ms(i.timestamp)) / HOUR, 1) : null;
  return {
    incidentId: i.id, timestamp: i.timestamp, fleetId: i.fleetId, fleetName: i.fleetName, vendor: i.provider, category: i.category, eventType: i.eventType, severity: i.severity, status: i.status,
    source: i.source === 'historical_import' ? 'imported' : i.demo ? 'demo_scenario' : 'seeded_or_live',
    aiVerdict: (i.camera && i.camera.aiVerdict) || null, cameraVerified: !!(i.camera && i.camera.verified), hasVideo: !!(i.camera && i.camera.aiVerdict && i.camera.aiVerdict !== 'no_video'), isFalsePositive: !!isFP(i),
    isOpen: open, openAgeHours: ageH, ageBucket: ageBucket(ageH), eventScore: i.risk && i.risk.eventScore != null ? i.risk.eventScore : null, speedMph: i.location && i.location.speed_mph != null ? i.location.speed_mph : null,
    vehicleId: i.vehicle && i.vehicle.id, vehicleUnit: i.vehicle && i.vehicle.unit, oem: (i.vehicle && i.vehicle.oem) || null, driverId: (i.driver && i.driver.id) || null, driverName: (i.driver && i.driver.name) || null,
    roadsideNeeded: !!(i.roadside && i.roadside.needed), serviceType: (i.roadside && i.roadside.serviceType) || null, providerName: (i.roadside && i.roadside.assignedProvider && i.roadside.assignedProvider.name) || null,
    dispatchMin: disp != null ? round(mins(rcv, disp), 1) : null, resolutionMin: resv != null ? round(mins(rcv, resv), 1) : null,
    warrantyEligible: !!(i.warranty && i.warranty.claimEligible), claimStatus: cp ? cp.status : null, fnolSent: !!i.fnol,
  };
}
const INCIDENT_FIELDS = [
  S('incidentId', 'Incident ID'), T('timestamp', 'Event time'), S('fleetId', 'Fleet ID', { groupable: true }), S('fleetName', 'Fleet', { groupable: true }), E('vendor', 'Telematics vendor', ['motive', 'samsara', 'geotab', 'lytx', 'mantis', 'generic']),
  E('category', 'Category', CATEGORIES), E('eventType', 'Event type', EVENT_TYPES), E('severity', 'Severity', SEVERITIES), E('status', 'Status', STATUSES), E('source', 'Data source', ['seeded_or_live', 'imported', 'demo_scenario']),
  E('aiVerdict', 'Camera AI verdict'), B('cameraVerified', 'Camera verified'), B('hasVideo', 'Has video'), B('isFalsePositive', 'False positive'), B('isOpen', 'Open'),
  N('openAgeHours', 'Open age', 'h'), E('ageBucket', 'Open age bucket', ['<1h', '1-4h', '4-24h', '1-3d', '>3d']), N('eventScore', 'Event risk score', 'pts'), N('speedMph', 'Speed', 'mph'),
  S('vehicleId', 'Vehicle ID'), S('vehicleUnit', 'Vehicle unit', { groupable: true }), E('oem', 'OEM'), S('driverId', 'Driver ID'), S('driverName', 'Driver', { groupable: true }),
  B('roadsideNeeded', 'Roadside needed'), E('serviceType', 'Service type'), S('providerName', 'Assigned provider', { groupable: true }), N('dispatchMin', 'Minutes to dispatch', 'min'), N('resolutionMin', 'Minutes to resolve', 'min'),
  B('warrantyEligible', 'Warranty eligible'), E('claimStatus', 'Claim status', CLAIM_STATUSES), B('fnolSent', 'FNOL sent'),
];

// ---------- response_times ----------
function responseRow(i, ctx) {
  const rcv = ms(i.receivedAt) || ms(i.timestamp);
  const validated = tl(i, /^(camera_verified|reviewed)$/), dispatched = tl(i, /^dispatched$/), enRoute = tl(i, /^en_route$/), onScene = tl(i, /^on_scene$/), resolved = tl(i, /^resolved$/);
  const m = (a, b) => (a != null && b != null && b >= a ? round(mins(a, b), 1) : null);
  return {
    incidentId: i.id, timestamp: i.timestamp, fleetId: i.fleetId, fleetName: i.fleetName, eventType: i.eventType, severity: i.severity, status: i.status, serviceType: (i.roadside && i.roadside.serviceType) || null,
    providerName: (i.roadside && i.roadside.assignedProvider && i.roadside.assignedProvider.name) || null,
    receivedAt: iso(rcv), validatedAt: iso(validated), dispatchedAt: iso(dispatched), enRouteAt: iso(enRoute), onSceneAt: iso(onScene), resolvedAt: iso(resolved),
    toValidateMin: m(rcv, validated), toDispatchMin: m(rcv, dispatched), dispatchToEnRouteMin: m(dispatched, enRoute), dispatchToOnSceneMin: m(dispatched, onScene), toOnSceneMin: m(rcv, onScene), toResolvedMin: m(rcv, resolved),
    promisedEtaMin: i.roadside && i.roadside.etaMin != null ? i.roadside.etaMin : null,
  };
}
const RESPONSE_FIELDS = [
  S('incidentId', 'Incident ID'), T('timestamp', 'Event time'), S('fleetId', 'Fleet ID', { groupable: true }), S('fleetName', 'Fleet', { groupable: true }), E('eventType', 'Event type', EVENT_TYPES), E('severity', 'Severity', SEVERITIES), E('status', 'Status', STATUSES),
  E('serviceType', 'Service type'), S('providerName', 'Provider', { groupable: true }),
  T('receivedAt', 'Received'), T('validatedAt', 'Validated'), T('dispatchedAt', 'Dispatched'), T('enRouteAt', 'En route'), T('onSceneAt', 'On scene'), T('resolvedAt', 'Resolved'),
  N('toValidateMin', 'Received to validated', 'min'), N('toDispatchMin', 'Received to dispatched', 'min'), N('dispatchToEnRouteMin', 'Dispatched to en route', 'min'), N('dispatchToOnSceneMin', 'Dispatched to on scene', 'min'),
  N('toOnSceneMin', 'Received to on scene', 'min'), N('toResolvedMin', 'Received to resolved', 'min'), N('promisedEtaMin', 'Promised ETA', 'min'),
];

// ---------- tow_providers (one row per assigned provider job) ----------
async function towRows(ctx) {
  const jobs = await db.list('job', { limit: 1e6 });
  const byInc = new Map(); for (const j of jobs) byInc.set(j.incidentId, j);
  return ctx.incidents.filter((i) => i.roadside && i.roadside.assignedProvider).map((i) => {
    const p = i.roadside.assignedProvider, job = byInc.get(i.id);
    const disp = tl(i, /^dispatched$/), onScene = tl(i, /^on_scene$/), resolved = tl(i, /^resolved$/);
    const actual = disp != null && onScene != null && onScene >= disp ? round(mins(disp, onScene), 1) : null;
    return {
      jobKey: i.id + ':' + p.id, incidentId: i.id, timestamp: iso(disp) || i.timestamp, fleetId: i.fleetId, fleetName: i.fleetName, providerId: p.id, providerName: p.name, providerCity: p.city || null, providerState: p.st || null,
      providerRating: p.rating != null ? p.rating : null, serviceType: i.roadside.serviceType, eventType: i.eventType, severity: i.severity, incidentStatus: i.status, jobStatus: job ? job.status : null,
      promisedEtaMin: p.etaMin != null ? p.etaMin : i.roadside.etaMin != null ? i.roadside.etaMin : null, distanceMi: p.distanceMi != null ? p.distanceMi : null, actualArrivalMin: actual,
      etaVarianceMin: actual != null && p.etaMin != null ? round(actual - p.etaMin, 1) : null, onTime: actual != null && p.etaMin != null ? actual <= p.etaMin : null,
      resolved: i.status === 'resolved', jobMinutes: onScene != null && resolved != null && resolved >= onScene ? round(mins(onScene, resolved), 1) : null,
    };
  });
}
const TOW_FIELDS = [
  S('jobKey', 'Job key'), S('incidentId', 'Incident ID'), T('timestamp', 'Dispatched'), S('fleetId', 'Fleet ID', { groupable: true }), S('fleetName', 'Fleet', { groupable: true }), S('providerId', 'Provider ID', { groupable: true }), S('providerName', 'Provider', { groupable: true }),
  S('providerCity', 'Provider city', { groupable: true }), S('providerState', 'Provider state', { groupable: true }), N('providerRating', 'Provider rating', 'stars'), E('serviceType', 'Service type'), E('eventType', 'Event type', EVENT_TYPES), E('severity', 'Severity', SEVERITIES),
  E('incidentStatus', 'Incident status', STATUSES), E('jobStatus', 'Job link status'), N('promisedEtaMin', 'Promised ETA', 'min'), N('distanceMi', 'Distance', 'mi'), N('actualArrivalMin', 'Dispatch to on scene', 'min'), N('etaVarianceMin', 'Actual minus promised ETA', 'min'),
  B('onTime', 'Arrived within promised ETA'), B('resolved', 'Resolved'), N('jobMinutes', 'On scene to resolved', 'min'),
];

// ---------- comms ----------
async function commsRows(ctx) {
  const cm = await db.list('comms', { limit: 1e6 });
  return cm.map((c) => ({
    commId: c.id, timestamp: c.at || c.createdAt, incidentId: c.incidentId || null, fleetId: c.fleetId, fleetName: c.fleetName || null, channel: c.channel, recipientType: (c.to && c.to.type) || null, recipientName: (c.to && c.to.name) || null,
    template: c.template || null, status: c.status, actor: c.actor || null, simulated: c.simulated !== false, bodyChars: c.body ? String(c.body).length : 0,
  }));
}
const COMMS_FIELDS = [
  S('commId', 'Message ID'), T('timestamp', 'Sent'), S('incidentId', 'Incident ID'), S('fleetId', 'Fleet ID', { groupable: true }), S('fleetName', 'Fleet', { groupable: true }), E('channel', 'Channel', ['sms', 'call', 'email']),
  E('recipientType', 'Recipient type', ['driver', 'tow', 'fleet_manager', 'authority', 'cargo_owner', 'insurer', 'oem']), S('recipientName', 'Recipient', { groupable: true }), E('template', 'Template'), E('status', 'Delivery status'), E('actor', 'Sent by'), B('simulated', 'Simulated'), N('bodyChars', 'Message length', 'chars'),
];

// ---------- sop (one row per SOP step per incident) ----------
function sopRows(ctx) {
  const ops = require('./ops');
  const out = [];
  for (const i of ctx.incidents) {
    let s; try { s = ops.sop(i); } catch (e) { continue; }
    const rcv = ms(i.receivedAt) || ms(i.timestamp);
    for (const st of s.steps) {
      const done = ms(st.doneAt);
      out.push({
        stepKey: i.id + ':' + st.key, incidentId: i.id, timestamp: i.timestamp, fleetId: i.fleetId, fleetName: i.fleetName, eventType: i.eventType, severity: i.severity, incidentStatus: i.status, sopKind: s.kind, step: st.key, stepLabel: st.label,
        required: !!st.required, done: !!st.done, doneBy: st.doneBy || null, minutesToComplete: st.done && done != null && done >= rcv ? round(mins(rcv, done), 1) : null,
      });
    }
  }
  return out;
}
const SOP_FIELDS = [
  S('stepKey', 'Step key'), S('incidentId', 'Incident ID'), T('timestamp', 'Event time'), S('fleetId', 'Fleet ID', { groupable: true }), S('fleetName', 'Fleet', { groupable: true }), E('eventType', 'Event type', EVENT_TYPES), E('severity', 'Severity', SEVERITIES), E('incidentStatus', 'Incident status', STATUSES),
  E('sopKind', 'SOP checklist', ['collision', 'hazmat', 'breakdown', 'warranty', 'false_positive', 'safety']), E('step', 'Step key'), S('stepLabel', 'Step', { groupable: true }), B('required', 'Required'), B('done', 'Completed'), E('doneBy', 'Completed by'), N('minutesToComplete', 'Minutes from receipt to completion', 'min'),
];

// ---------- vehicles / drivers ----------
function vehicleRows(ctx) {
  const by = new Map(); for (const i of ctx.incidents) if (i.vehicle && i.vehicle.id) (by.get(i.vehicle.id) || by.set(i.vehicle.id, []).get(i.vehicle.id)).push(i);
  const out = [];
  for (const fl of ctx.fleets) for (const v of fl.vehicles) {
    const evs = (by.get(v.id) || []).filter((i) => !isFP(i)); const drv = roster.getDriver(v.driverId);
    const last = evs.reduce((m, i) => Math.max(m, ms(i.timestamp)), 0);
    out.push({
      vehicleId: v.id, unit: v.unit, vin: v.vin, plate: v.plate, fleetId: fl.id, fleetName: fl.name, vendor: fl.vendor, year: v.year, make: v.make, model: v.model, oem: v.oem, vehicleClass: v.cls || null, odometerMi: v.odometer_mi,
      hasCamera: !!v.hasCamera, driverId: v.driverId || null, driverName: drv ? drv.name : null, events: evs.length, collisions: evs.filter((i) => ['collision', 'rollover'].includes(i.eventType)).length,
      faultEvents: evs.filter((i) => i.eventType === 'fault_code').length, breakdowns: evs.filter((i) => ['breakdown', 'tire', 'battery'].includes(i.eventType)).length, openIncidents: evs.filter((i) => OPEN_STATUSES.includes(i.status)).length,
      lastEventAt: last ? iso(last) : null,
    });
  }
  return out;
}
const VEHICLE_FIELDS = [
  S('vehicleId', 'Vehicle ID'), S('unit', 'Unit', { groupable: true }), S('vin', 'VIN'), S('plate', 'Plate'), S('fleetId', 'Fleet ID', { groupable: true }), S('fleetName', 'Fleet', { groupable: true }), E('vendor', 'Telematics vendor', ['motive', 'samsara', 'geotab', 'lytx', 'mantis', 'generic']),
  N('year', 'Model year', ''), E('make', 'Make'), E('model', 'Model'), E('oem', 'OEM'), E('vehicleClass', 'Class'), N('odometerMi', 'Odometer', 'mi'), B('hasCamera', 'Has camera'), S('driverId', 'Driver ID'), S('driverName', 'Assigned driver', { groupable: true }),
  N('events', 'Events (history)', 'events'), N('collisions', 'Collisions (history)', 'events'), N('faultEvents', 'Fault-code events', 'events'), N('breakdowns', 'Breakdown events', 'events'), N('openIncidents', 'Open incidents', 'incidents'), T('lastEventAt', 'Last event'),
];
function driverRowsDs(ctx) {
  const fe = I.fleetEnd(ctx.incidents);
  return I.driverRows(ctx.fleets, ctx.incidents, fe).map((d) => ({
    driverId: d.driverId, name: d.name, fleetId: d.fleetId, fleetName: d.fleetName, vehicleId: d.vehicle || null, vendor: (roster.getFleet(d.fleetId) || {}).vendor || null, driveScore: d.driveScore, band: d.band, trend30d: d.trend30d,
    events30d: d.events30d, collisions90d: d.collisions90d, cameraVerifiedPct: d.cameraVerifiedPct, topIssue: d.topIssue,
    followingDistance: d.components.followingDistance, braking: d.components.braking, acceleration: d.components.acceleration, cornering: d.components.cornering, speeding: d.components.speeding, distraction: d.components.distraction, fatigue: d.components.fatigue, nightDriving: d.components.nightDriving,
  }));
}
const DRIVER_FIELDS = [
  S('driverId', 'Driver ID'), S('name', 'Driver', { groupable: true }), S('fleetId', 'Fleet ID', { groupable: true }), S('fleetName', 'Fleet', { groupable: true }), S('vehicleId', 'Vehicle ID'), E('vendor', 'Telematics vendor', ['motive', 'samsara', 'geotab', 'lytx', 'mantis', 'generic']),
  N('driveScore', 'Drive Score', 'pts'), E('band', 'Drive Score band', ['excellent', 'good', 'fair', 'poor']), N('trend30d', '30-day trend', 'pts'), N('events30d', 'Events (30d)', 'events'), N('collisions90d', 'Collisions (90d)', 'events'), N('cameraVerifiedPct', 'Camera-verified', '%'), E('topIssue', 'Top issue'),
  N('followingDistance', 'Following distance score', 'pts'), N('braking', 'Braking score', 'pts'), N('acceleration', 'Acceleration score', 'pts'), N('cornering', 'Cornering score', 'pts'), N('speeding', 'Speeding score', 'pts'), N('distraction', 'Distraction score', 'pts'), N('fatigue', 'Fatigue score', 'pts'), N('nightDriving', 'Night driving score', 'pts'),
];

// ---------- safety_events ----------
function safetyRows(ctx) {
  return ctx.incidents.filter((i) => SAFETY_TYPES.includes(i.eventType)).map((i) => {
    const h = (new Date(i.timestamp).getUTCHours() + 19) % 24;
    return {
      incidentId: i.id, timestamp: i.timestamp, fleetId: i.fleetId, fleetName: i.fleetName, vendor: i.provider, eventType: i.eventType, severity: i.severity, status: i.status, driverId: (i.driver && i.driver.id) || null, driverName: (i.driver && i.driver.name) || null,
      vehicleId: i.vehicle && i.vehicle.id, vehicleUnit: i.vehicle && i.vehicle.unit, speedMph: i.location && i.location.speed_mph != null ? i.location.speed_mph : null, aiVerdict: (i.camera && i.camera.aiVerdict) || null, cameraVerified: !!(i.camera && i.camera.verified),
      isFalsePositive: !!isFP(i), eventScore: i.risk && i.risk.eventScore != null ? i.risk.eventScore : null, isNight: h >= 22 || h < 5, coachingAssigned: (i.timeline || []).some((e) => e.action === 'coaching'),
    };
  });
}
const SAFETY_FIELDS = [
  S('incidentId', 'Incident ID'), T('timestamp', 'Event time'), S('fleetId', 'Fleet ID', { groupable: true }), S('fleetName', 'Fleet', { groupable: true }), E('vendor', 'Telematics vendor', ['motive', 'samsara', 'geotab', 'lytx', 'mantis', 'generic']), E('eventType', 'Event type', SAFETY_TYPES), E('severity', 'Severity', SEVERITIES), E('status', 'Status', STATUSES),
  S('driverId', 'Driver ID'), S('driverName', 'Driver', { groupable: true }), S('vehicleId', 'Vehicle ID'), S('vehicleUnit', 'Vehicle unit', { groupable: true }), N('speedMph', 'Speed', 'mph'), E('aiVerdict', 'Camera AI verdict'), B('cameraVerified', 'Camera verified'),
  B('isFalsePositive', 'False positive'), N('eventScore', 'Event risk score', 'pts'), B('isNight', 'Night event (10pm-5am local)'), B('coachingAssigned', 'Coaching assigned'),
];

// ---------- warranty claims (shared with /api/records/claims) ----------
const FINAL = ['paid', 'denied'];
function claimRecords(incs, now = Date.now()) {
  const out = [];
  for (const i of incs) {
    const cp = claimPacket(i); if (!cp) continue;
    const hist = (cp.history || []).slice().sort((a, b) => (a.t < b.t ? -1 : 1));
    const pk = (i.timeline || []).find((e) => e.action === 'warranty_packet');
    const dec = hist.find((h) => h.status === 'approved' || h.status === 'denied');
    const last = hist.length ? hist[hist.length - 1] : null;
    const submitted = cp.submittedAt || null;
    const closed = FINAL.includes(cp.status);
    const startMs = ms(submitted) || ms((pk && pk.t) || i.receivedAt || i.timestamp);
    const endMs = closed && last ? ms(last.t) : now;
    const dtcs = (i.diagnostics && i.diagnostics.dtcs) || [];
    const timeline = [];
    if (pk) timeline.push({ at: pk.t, status: 'draft', note: 'Claim packet assembled from incident evidence', simulated: true });
    for (const h of hist) timeline.push({ at: h.t, status: h.status, note: h.note || '', simulated: true });
    out.push({
      claimId: i.warranty.claimId || ('WC-' + i.id), claimNumber: cp.claimNumber || null, incidentId: i.id, fleetId: i.fleetId, fleetName: i.fleetName, vehicleId: i.vehicle && i.vehicle.id, vin: i.vehicle && i.vehicle.vin, unit: i.vehicle && i.vehicle.unit,
      oem: i.warranty.oem || (i.vehicle && i.vehicle.oem) || null, dealer: (i.warrantyDealer && i.warrantyDealer.nearest && i.warrantyDealer.nearest.name) || null, faultCodes: dtcs.map((d) => d.code).filter(Boolean),
      warrantyBasis: i.warranty.coverage || null, status: cp.status, incidentAt: i.timestamp, submittedAt: submitted, decidedAt: dec ? dec.t : null, firstDecision: dec ? dec.status : null, paidAt: cp.paidAt || null,
      estimatedAmount: cp.estimatedValueUsd != null ? cp.estimatedValueUsd : null, approvedAmount: cp.approvedAmountUsd != null ? cp.approvedAmountUsd : null, recoveredAmount: cp.paidAmountUsd != null ? cp.paidAmountUsd : 0,
      denialReason: cp.denialReason || null, requestedInfo: cp.requestedInfo || null, preAuthNumber: cp.preAuthNumber || null, ageDays: round(Math.max(0, endMs - startMs) / DAY, 1),
      daysToDecision: submitted && dec ? round(Math.max(0, ms(dec.t) - ms(submitted)) / DAY, 2) : null, isOpen: !closed, wasDenied: !!(dec && dec.status === 'denied') || cp.status === 'denied',
      timestamp: submitted || (pk && pk.t) || i.timestamp, timeline,
    });
  }
  return out.sort((a, b) => (a.claimId < b.claimId ? -1 : 1));
}
const CLAIM_FIELDS = [
  S('claimId', 'Claim ID'), S('claimNumber', 'OEM claim number'), S('incidentId', 'Incident ID'), T('timestamp', 'Submitted (or packet created)'), S('fleetId', 'Fleet ID', { groupable: true }), S('fleetName', 'Fleet', { groupable: true }), S('vin', 'VIN'), S('unit', 'Unit', { groupable: true }),
  E('oem', 'OEM'), S('dealer', 'Dealer', { groupable: true }), E('warrantyBasis', 'Warranty basis', ['powertrain', 'emissions', 'bumper_to_bumper', 'none']), E('status', 'Claim status', CLAIM_STATUSES), E('firstDecision', 'First OEM decision', ['approved', 'denied']),
  T('incidentAt', 'Incident time'), T('submittedAt', 'Submitted'), T('decidedAt', 'Decided'), T('paidAt', 'Paid'), N('estimatedAmount', 'Estimated amount', 'USD'), N('approvedAmount', 'Approved amount', 'USD'), N('recoveredAmount', 'Recovered amount', 'USD'),
  S('denialReason', 'Denial reason', { groupable: true }), N('ageDays', 'Age', 'days'), N('daysToDecision', 'Days to decision', 'days'), B('isOpen', 'Open (not paid/denied)'), B('wasDenied', 'Denied at some point'),
];

// ---------- risk snapshots / portfolio ----------
const RISK_FIELDS = [
  S('snapshotId', 'Snapshot ID'), T('timestamp', 'Week start'), S('weekStart', 'Week', { groupable: true }), E('entityType', 'Entity type', ['fleet', 'driver']), S('entityId', 'Entity ID'), S('entityName', 'Entity', { groupable: true }), S('fleetId', 'Fleet ID', { groupable: true }), S('fleetName', 'Fleet', { groupable: true }),
  E('vendor', 'Telematics vendor', ['motive', 'samsara', 'geotab', 'lytx', 'mantis', 'generic']), N('riskScore', 'Risk score (rolling 30d)', 'pts'), E('riskTier', 'Risk tier', ['low', 'moderate', 'elevated', 'high']), N('driveScore', 'Drive Score (rolling 30d)', 'pts'),
  E('driveBand', 'Drive Score band', ['excellent', 'good', 'fair', 'poor']), N('events', 'Events in week', 'events'), N('collisions', 'Collisions in week', 'events'), N('estMiles', 'Estimated miles in week', 'mi'), N('eventsPer1kMi', 'Events per 1,000 mi', 'events/1k mi'),
  N('cameraVerifiedShare', 'Camera-verified share', '%'), N('windowEvents30d', 'Events in 30d window', 'events'), B('windowComplete', 'Full 30d history available'),
];
async function portfolioRows(ctx) {
  const since = ctx.now - 30 * DAY;
  const w30 = ctx.incidents.filter((i) => ms(i.timestamp) > since);
  const claims = claimRecords(ctx.incidents, ctx.now);
  return ctx.fleets.filter((fl) => !fl.onboarding || fl.onboarding.status !== 'setup').map((fl) => {
    const m = A.fleetMetrics(fl, w30.filter((i) => i.fleetId === fl.id), ctx.now, 30);
    const mine = ctx.incidents.filter((i) => i.fleetId === fl.id);
    const dr = I.driverRows([fl], ctx.incidents, I.fleetEnd(ctx.incidents));
    const cl = claims.filter((c) => c.fleetId === fl.id);
    return {
      fleetId: fl.id, fleetName: fl.name, vendor: fl.vendor, carrier: D.carrierOf(fl.id).name, policyNo: D.policyNo(fl.id), vehicles: m.vehicles, drivers: fl.drivers.length, riskScore: m.riskScore, riskTier: m.riskTier, driveScore: I.driveScoreOf(m.riskScore), trend: m.trend,
      events30dPer100veh: m.events30dPer100veh, collisionRate: m.collisionRate, cameraCoveragePct: m.cameraCoveragePct, verifiedEventPct: m.verifiedEventPct, avgDriverDriveScore: dr.length ? round(dr.reduce((s, d) => s + d.driveScore, 0) / dr.length, 1) : null,
      estLossUsd: m.estLossUsd, estMonthlyPremiumUsd: m.estMonthlyPremiumUsd, cargoExposureUsd: m.cargo.totalEstCargoExposureUsd, openCriticalIncidents: mine.filter((i) => i.severity === 'critical' && OPEN_STATUSES.includes(i.status) && !isFP(i)).length,
      openClaims: cl.filter((c) => c.isOpen).length, recoveredUsd: cl.reduce((s, c) => s + c.recoveredAmount, 0),
    };
  });
}
const PORTFOLIO_FIELDS = [
  S('fleetId', 'Fleet ID', { groupable: true }), S('fleetName', 'Fleet', { groupable: true }), E('vendor', 'Telematics vendor', ['motive', 'samsara', 'geotab', 'lytx', 'mantis', 'generic']), S('carrier', 'Carrier (synthetic)', { groupable: true }), S('policyNo', 'Policy number (synthetic)'),
  N('vehicles', 'Vehicles', ''), N('drivers', 'Drivers', ''), N('riskScore', 'Risk score (30d)', 'pts'), E('riskTier', 'Risk tier', ['low', 'moderate', 'elevated', 'high']), N('driveScore', 'Fleet Drive Score', 'pts'), E('trend', 'Trend', ['up', 'flat', 'down']),
  N('events30dPer100veh', 'Events / 100 vehicles (30d)', 'events'), N('collisionRate', 'Collisions / 100 vehicles (30d)', 'events'), N('cameraCoveragePct', 'Camera coverage', '%'), N('verifiedEventPct', 'Camera-verified events', '%'), N('avgDriverDriveScore', 'Average driver Drive Score', 'pts'),
  N('estLossUsd', 'Estimated loss (illustrative)', 'USD'), N('estMonthlyPremiumUsd', 'Estimated monthly premium (illustrative)', 'USD'), N('cargoExposureUsd', 'Cargo exposure (est.)', 'USD'), N('openCriticalIncidents', 'Open critical incidents', 'incidents'), N('openClaims', 'Open warranty claims', 'claims'), N('recoveredUsd', 'Warranty recovered', 'USD'),
];

// ---------- registry ----------
const col = (...a) => a;
const DATASETS = {
  incidents: { id: 'incidents', label: 'Incidents', description: 'One row per incident (safety events, collisions, breakdowns, diagnostics) with camera, roadside, warranty and FNOL flags.', areas: ['dispatch', 'fleet'], fields: INCIDENT_FIELDS, dateField: 'timestamp', idField: 'incidentId',
    defaultColumns: col('incidentId', 'timestamp', 'fleetName', 'eventType', 'severity', 'status', 'driverName', 'vehicleUnit'), defaultMetrics: [{ field: '*', agg: 'count', label: 'Incidents' }], rows: (c) => c.incidents.map((i) => incidentRow(i, c)), defaultSort: [{ field: 'timestamp', dir: 'desc' }] },
  response_times: { id: 'response_times', label: 'Response times', description: 'Per incident: minutes between received, validated, dispatched, en route, on scene and resolved, derived from incident timelines (blank when a step was not recorded).', areas: ['dispatch'], fields: RESPONSE_FIELDS, dateField: 'timestamp', idField: 'incidentId',
    defaultColumns: col('incidentId', 'timestamp', 'fleetName', 'eventType', 'severity', 'providerName', 'toDispatchMin', 'dispatchToOnSceneMin', 'toResolvedMin'), defaultMetrics: [{ field: 'toDispatchMin', agg: 'median', label: 'Median minutes to dispatch' }, { field: 'dispatchToOnSceneMin', agg: 'median', label: 'Median dispatch to on scene (min)' }], rows: (c) => c.incidents.map((i) => responseRow(i, c)), defaultSort: [{ field: 'timestamp', dir: 'desc' }] },
  tow_providers: { id: 'tow_providers', label: 'Tow and roadside providers', description: 'One row per provider job assigned to an incident, with promised vs actual arrival and job link status.', areas: ['dispatch'], fields: TOW_FIELDS, dateField: 'timestamp', idField: 'incidentId',
    defaultColumns: col('incidentId', 'timestamp', 'providerName', 'serviceType', 'fleetName', 'promisedEtaMin', 'actualArrivalMin', 'jobStatus'), defaultMetrics: [{ field: '*', agg: 'count', label: 'Jobs' }, { field: 'actualArrivalMin', agg: 'avg', label: 'Avg minutes to arrive' }], rows: towRows, defaultSort: [{ field: 'timestamp', dir: 'desc' }] },
  comms: { id: 'comms', label: 'Communications log', description: 'Every simulated SMS / call / email logged by dispatch (nothing is actually sent).', areas: ['dispatch'], fields: COMMS_FIELDS, dateField: 'timestamp', idField: 'commId',
    defaultColumns: col('timestamp', 'incidentId', 'fleetName', 'channel', 'recipientType', 'recipientName', 'template', 'status'), defaultMetrics: [{ field: '*', agg: 'count', label: 'Messages' }], rows: commsRows, defaultSort: [{ field: 'timestamp', dir: 'desc' }] },
  sop: { id: 'sop', label: 'SOP checklist steps', description: 'One row per SOP checklist step per incident, with completion and minutes to complete.', areas: ['dispatch'], fields: SOP_FIELDS, dateField: 'timestamp', idField: 'incidentId',
    defaultColumns: col('incidentId', 'timestamp', 'fleetName', 'sopKind', 'stepLabel', 'required', 'done', 'minutesToComplete'), defaultMetrics: [{ field: 'done', agg: 'rate', label: 'Completion rate (%)' }], rows: (c) => sopRows(c), defaultSort: [{ field: 'timestamp', dir: 'desc' }] },
  vehicles: { id: 'vehicles', label: 'Vehicles', description: 'Vehicle roster with event, collision and fault counts from stored history.', areas: ['fleet'], fields: VEHICLE_FIELDS, dateField: null, idField: 'vehicleId',
    defaultColumns: col('unit', 'fleetName', 'make', 'model', 'year', 'odometerMi', 'hasCamera', 'driverName', 'events', 'faultEvents'), defaultMetrics: [{ field: '*', agg: 'count', label: 'Vehicles' }], rows: (c) => vehicleRows(c), defaultSort: [{ field: 'events', dir: 'desc' }] },
  drivers: { id: 'drivers', label: 'Drivers', description: 'Driver roster with Nexus Drive Score, band, trend and component scores.', areas: ['fleet', 'insurer'], fields: DRIVER_FIELDS, dateField: null, idField: 'driverId',
    defaultColumns: col('name', 'fleetName', 'driveScore', 'band', 'trend30d', 'events30d', 'collisions90d', 'topIssue'), defaultMetrics: [{ field: 'driveScore', agg: 'avg', label: 'Average Drive Score' }, { field: '*', agg: 'count', label: 'Drivers' }], rows: (c) => driverRowsDs(c), defaultSort: [{ field: 'driveScore', dir: 'asc' }] },
  safety_events: { id: 'safety_events', label: 'Driver safety events', description: 'Safety and collision events attributed to drivers and vehicles, with camera verification and coaching flags.', areas: ['fleet'], fields: SAFETY_FIELDS, dateField: 'timestamp', idField: 'incidentId',
    defaultColumns: col('incidentId', 'timestamp', 'fleetName', 'eventType', 'severity', 'driverName', 'vehicleUnit', 'cameraVerified'), defaultMetrics: [{ field: '*', agg: 'count', label: 'Events' }], rows: (c) => safetyRows(c), defaultSort: [{ field: 'timestamp', dir: 'desc' }] },
  warranty_claims: { id: 'warranty_claims', label: 'Warranty claims', description: 'OEM warranty claim lifecycle (simulated OEM responses): status, amounts, recovery, age and denial reason.', areas: ['claims'], fields: CLAIM_FIELDS, dateField: 'timestamp', idField: 'claimId',
    defaultColumns: col('claimId', 'incidentId', 'fleetName', 'oem', 'status', 'estimatedAmount', 'recoveredAmount', 'ageDays', 'denialReason'), defaultMetrics: [{ field: '*', agg: 'count', label: 'Claims' }, { field: 'estimatedAmount', agg: 'sum', label: 'Estimated $' }, { field: 'recoveredAmount', agg: 'sum', label: 'Recovered $' }], rows: (c) => claimRecords(c.incidents, c.now), defaultSort: [{ field: 'timestamp', dir: 'desc' }] },
  risk_snapshots: { id: 'risk_snapshots', label: 'Risk snapshots (weekly)', description: 'Weekly snapshot per fleet and per driver: rolling 30-day risk score and Drive Score, plus weekly events per 1,000 miles, collisions and camera-verified share. Derived from stored incident history.', areas: ['insurer'], fields: RISK_FIELDS, dateField: 'timestamp', idField: 'snapshotId',
    defaultColumns: col('weekStart', 'entityType', 'entityName', 'fleetName', 'riskScore', 'driveScore', 'eventsPer1kMi', 'collisions', 'cameraVerifiedShare'), defaultMetrics: [{ field: 'riskScore', agg: 'avg', label: 'Average risk score' }], rows: (c) => H.snapshotRows(c.incidents, H.clock()), defaultSort: [{ field: 'timestamp', dir: 'desc' }] },
  fleet_portfolio: { id: 'fleet_portfolio', label: 'Fleet portfolio (by fleet and vendor)', description: 'One row per fleet: current 30-day risk, tier, camera coverage, estimated loss and premium (illustrative), open claims.', areas: ['insurer'], fields: PORTFOLIO_FIELDS, dateField: null, idField: 'fleetId',
    defaultColumns: col('fleetName', 'vendor', 'vehicles', 'riskScore', 'riskTier', 'trend', 'events30dPer100veh', 'verifiedEventPct', 'cameraCoveragePct'), defaultMetrics: [{ field: 'riskScore', agg: 'avg', label: 'Average risk score' }], rows: portfolioRows, defaultSort: [{ field: 'riskScore', dir: 'desc' }] },
};
const AREAS = [
  { id: 'dispatch', label: 'Dispatch', description: 'Incident intake, response times, providers, communications and SOP execution.' },
  { id: 'fleet', label: 'Fleet', description: 'Vehicles, drivers and safety events for a fleet.' },
  { id: 'insurer', label: 'Insurer', description: 'Portfolio risk, weekly risk snapshots and Drive Score distribution.' },
  { id: 'claims', label: 'Claims', description: 'OEM warranty claim pipeline, recovery and denials (simulated OEM responses).' },
];

module.exports = { DATASETS, AREAS, loadCtx, claimRecords, incidentRow, EVENT_TYPES, SEVERITIES, STATUSES, CATEGORIES, CLAIM_STATUSES, med };
