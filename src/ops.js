// Dispatch operations (ADDENDUM v4): contacts, notify + comms log + templates, authority brief, SOP checklists,
// one-click OEM claim + lifecycle, FNOL, tow job links (public). Everything outbound is SIMULATED.
const express = require('express');
const crypto = require('crypto');
const db = require('../db');
const roster = require('./roster');
const stream = require('./stream');
const claims = require('./claims');
const roadside = require('./enrich/roadside');
const D = require('./data/ops');
const { rngFrom, hashStr, round } = require('./util');

const SIM = 'delivered (simulated)';
const SIMMARK = { simulated: true, deliveredTo: 'no external recipient' };
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const ago = (inc, a) => (inc.timeline || []).slice().reverse().find((e) => e.action === a);
const hasA = (inc, ...as) => (inc.timeline || []).find((e) => as.includes(e.action));
const base = (req) => (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
const first = (n) => String(n || '').split(' ')[0] || 'driver';
const money = (n) => '$' + Math.round(n).toLocaleString('en-US');

function place(inc) {
  const l = inc.location || {};
  const parts = String(l.address || '').split(', ');
  const st = parts.length >= 2 ? parts[parts.length - 1] : 'AL';
  const city = parts.length >= 3 ? parts[parts.length - 2] : (parts[1] || '');
  const road = l.road || parts[0] || '';
  const dm = /\b(EB|WB|NB|SB)\b/.exec(road);
  const dir = dm ? { EB: 'eastbound', WB: 'westbound', NB: 'northbound', SB: 'southbound' }[dm[1]] : null;
  return { st: D.STATE_NAME[st] ? st : 'AL', city, road: road.replace(/\s+(EB|WB|NB|SB)$/, ''), direction: dir, interstate: /^I-\d+/.test(road) };
}

// ---------- authorities ----------
function authorities(inc) {
  const p = place(inc), sn = D.STATE_NAME[p.st];
  const dx = inc.diagnostics, ld = inc.load && inc.load.contents;
  const t = inc.eventType, fp = inc.camera && inc.camera.aiVerdict === 'false_positive';
  const collision = (t === 'collision' || t === 'rollover') && !fp;
  const hz = !!(ld && ld.hazmat);
  const airbag = (inc.risk && inc.risk.tags || []).includes('airbag_deployed') || (inc.camera.signals || []).some((s) => /airbag/i.test(s));
  const highImpact = (inc.risk && inc.risk.tags || []).includes('high_impact');
  const stranded = dx && dx.drivable === 'no' && p.interstate;
  const county = D.COUNTY[p.city] ? `${D.COUNTY[p.city]} County` : `${p.city || 'Local'} Area`;
  const rec = (kind, urgency, reason) => ({ kind, urgency, reason });
  const r = {
    state_patrol: collision ? rec('state_patrol', 'now', 'Crash report required; state-controlled highway') : stranded ? rec('state_patrol', 'soon', 'Disabled heavy vehicle on interstate - traffic hazard') : rec('state_patrol', 'no', 'No crash or hazard reported'),
    county_sheriff: collision && !p.interstate ? rec('county_sheriff', 'now', 'Non-interstate road - county has primary jurisdiction') : rec('county_sheriff', 'no', p.interstate ? 'Interstate: state patrol has primary jurisdiction' : 'No incident requiring law enforcement'),
    ems: collision && (airbag || highImpact || t === 'rollover') ? rec('ems', 'now', airbag ? 'Airbag deployed - injuries unknown' : 'High-g impact - injuries unknown') : collision ? rec('ems', 'soon', 'Collision - confirm injuries with driver') : rec('ems', 'no', 'No injury indicators'),
    fire: t === 'rollover' || hz ? rec('fire', 'now', hz ? 'Hazmat cargo - fire/spill risk' : 'Rollover - extrication and fluid hazard') : collision && airbag ? rec('fire', 'soon', 'Airbag deployment - fuel/fluid leak possible') : rec('fire', 'no', 'No fire risk indicators'),
    dot: (t === 'rollover' || hz || (collision && p.interstate && inc.severity === 'critical')) ? rec('dot', 'soon', 'Lane closure / traffic control likely needed') : rec('dot', 'no', 'No lane closure expected'),
    hazmat_response: hz ? rec('hazmat_response', 'now', `Hazmat load (${ld.label.replace(' (likely)', '')}) - spill/containment response`) : rec('hazmat_response', 'no', 'No hazmat cargo'),
  };
  const agency = {
    state_patrol: `${sn} Highway Patrol - ${p.city || 'District'} Post (simulated)`, county_sheriff: `${county} Sheriff's Office (simulated)`, ems: `${p.city || 'Regional'} EMS Dispatch (simulated)`,
    fire: `${p.city || 'Regional'} Fire & Rescue (simulated)`, dot: `${sn} DOT Traffic Operations Center (simulated)`, hazmat_response: `${sn} Regional Hazmat Response Team (simulated)`,
  };
  const juris = { state_patrol: `${sn} state highways`, county_sheriff: county, ems: `${p.city}, ${p.st}`, fire: `${p.city}, ${p.st}`, dot: `${sn} statewide`, hazmat_response: `${sn} region` };
  return ['state_patrol', 'county_sheriff', 'ems', 'fire', 'dot', 'hazmat_response'].map((k) => ({ agency: agency[k], kind: k, phone: D.phone(k + p.city + p.st, p.st), jurisdiction: juris[k], recommended: r[k].urgency !== 'no', urgency: r[k].urgency, reason: r[k].reason }));
}


// Recovery status for scripts and the dispatcher: who is coming, on whose request, and can they handle this load.
function recoveryCheck(inc) {
  const rs = inc.roadside || {}, ld = inc.load, hz = !!(ld && ld.contents && ld.contents.hazmat);
  const prov = rs.assignedProvider;
  const owner = inc.fleetName;
  const teams = hz && inc.location && inc.location.lat != null ? roadside.listHazmatTeams(inc.location.lat, inc.location.lng, 3) : [];
  if (!prov) return { assigned: false, hazmatRequired: hz, ownersRequest: true, owner, hazmatTeams: teams, summary: hz ? 'No tow provider assigned yet. Hazmat load: pick a hazmat-certified provider.' : 'No tow provider assigned yet.' };
  const certified = roadside.isHazmatCertified(prov.id);
  const capable = hz ? certified : true;
  return {
    assigned: true, provider: { id: prov.id, name: prov.name, phone: prov.phone, etaMin: rs.etaMin || prov.etaMin || null }, ownersRequest: true, owner, hazmatRequired: hz, hazmatCertified: certified, capable,
    hazmatNotified: hz && !certified, hazmatTeams: teams,
    summary: !hz ? `${prov.name} dispatched at the owner's request (${owner}).` : certified ? `${prov.name} is hazmat-certified and dispatched at the owner's request (${owner}).` : `${prov.name} is NOT hazmat-certified. They have been told hazmat is required; a hazmat response team is needed on scene.`,
  };
}

function brief(inc) {
  const auth = authorities(inc);
  const p = place(inc), l = inc.location, ld = inc.load, tr = inc.equipment && inc.equipment.trailer;
  const hz = ld && ld.contents && ld.contents.hazmat;
  const veh = `${inc.vehicle.year || ''} ${inc.vehicle.make || ''} ${inc.vehicle.model || ''}`.trim();
  const trailer = tr && tr.attached ? `${tr.lengthFt}ft ${tr.type.replace('_', ' ')}` : null;
  const airbag = (inc.risk.tags || []).includes('airbag_deployed');
  const facts = [
    `${inc.eventType.replace(/_/g, ' ')} (${inc.severity}) at ${new Date(inc.timestamp).toISOString().replace('T', ' ').slice(0, 16)} UTC`,
    inc.camera.verified ? `Camera-verified: ${inc.camera.aiVerdict.replace(/_/g, ' ')} (${Math.round(inc.camera.confidence * 100)}%)` : 'Not camera-verified',
    `Vehicle: ${veh}, plate ${inc.vehicle.plate}, ${inc.fleetName} unit ${inc.vehicle.unit || ''}`.trim(),
    trailer ? `Trailer: ${trailer}${ld && ld.contents ? `, cargo ~${ld.estimatedWeightLb.toLocaleString('en-US')} lb ${ld.contents.label.replace(' (likely)', '').toLowerCase()} (inferred)` : ''}` : 'No trailer attached',
    `Speed at event: ${l.speed_mph != null ? l.speed_mph + ' mph' : 'unknown'}${airbag ? '; airbag deployment detected' : ''}`,
    `Driver: ${inc.driver.name}${inc.driver.phone ? ', ' + inc.driver.phone : ''}`,
    inc.diagnostics ? `Fault codes: ${inc.diagnostics.dtcs.map((d) => d.code).join(', ')}; drivable: ${inc.diagnostics.drivable}` : null,
  ].filter(Boolean);
  const rc = recoveryCheck(inc);
  const rec = auth.filter((a) => a.recommended).map((a) => ({ agency: a.agency, kind: a.kind, reason: a.reason, urgency: a.urgency }));
  const script = `This is Nexus Response dispatch calling for ${inc.fleetName}. We are reporting a ${inc.eventType.replace(/_/g, ' ')} on ${p.road}${p.direction ? ' ' + p.direction : ''} near ${p.city}, ${p.st} (GPS ${l.lat}, ${l.lng}). `
    + `Vehicle: ${veh}${trailer ? ' pulling a ' + trailer : ''}. Injuries: ${airbag ? 'unknown - airbag deployed, please send EMS' : 'unknown, driver being contacted'}. `
    + (hz ? `HAZMAT: ${ld.contents.label.replace(' (likely)', '')} aboard, placard unconfirmed - request hazmat response. ` : '')
    + (rc.assigned ? `Recovery: ${rc.provider.name} has been dispatched at the request of the vehicle's owner, ${rc.owner}, and is en route${rc.provider.etaMin ? ', ETA ' + Math.round(rc.provider.etaMin) + ' min' : ''}. ${hz ? (rc.hazmatCertified ? 'The tow company is hazmat-certified.' : 'The tow company is not hazmat-certified and has been notified that hazmat is required; please send hazmat response.') + ' ' : ''}` : `Recovery: tow provider not yet assigned; owner is ${rc.owner}. `)
    + (hz && rc.hazmatTeams[0] ? `Nearest private hazmat team: ${rc.hazmatTeams[0].name}. ` : '')
    + `Lanes blocked: unknown, driver to confirm. Driver ${inc.driver.name}${inc.driver.phone ? ' (' + inc.driver.phone + ')' : ''}. Callback: ${D.phone('dispatch', p.st)}. (Simulated call script)`;
  return {
    recommended: rec, needsAuthorities: rec.some((x) => x.urgency === 'now' || x.urgency === 'soon'), script,
    location: { lat: l.lat, lng: l.lng, address: l.address, road: p.road, direction: p.direction, city: p.city, state: p.st, nearestMileMarker: null, crossStreet: null },
    facts, hazmat: hz ? { present: true, notes: `${ld.contents.label.replace(' (likely)', '')}; est. ${ld.estimatedWeightLb.toLocaleString('en-US')} lb; placard/UN number NOT confirmed - ask driver to read the placard from a safe distance. Isolate and deny entry; wait for hazmat team.` } : null,
    recovery: rc, hazmatTeams: rc.hazmatTeams,
    authorities: auth, ...SIMMARK, note: 'Simulated: no call is placed and no agency is contacted.',
  };
}

// ---------- contacts ----------
function contacts(inc) {
  const fleet = roster.getFleet(inc.fleetId) || {};
  const car = D.carrierOf(inc.fleetId);
  const desk = D.oemDesk((inc.vehicle && inc.vehicle.oem) || (inc.warranty && inc.warranty.oem));
  const rs = inc.roadside || {};
  const tows = [rs.assignedProvider, rs.recommendedProvider, ...(rs.alternatives || [])].filter(Boolean);
  const seen = new Set(); const provs = tows.filter((t) => !seen.has(t.id) && seen.add(t.id)).map((t) => ({ id: t.id, name: t.name, phone: t.phone, etaMin: t.etaMin, rating: t.rating, assigned: !!(rs.assignedProvider && rs.assignedProvider.id === t.id) }));
  const ld = inc.load && inc.load.contents;
  const ls = inc.trip && inc.trip.lastStop;
  const cargo = ld && ld.category !== 'unknown' && inc.load.estimatedWeightLb > 300 && ls && ls.placeType !== 'unknown' && ls.placeType !== 'truck_stop'
    ? { name: `${ls.businessName} - shipping desk`, phone: D.phone('cargo' + ls.businessName, place(inc).st), email: `shipping@${ls.businessName.toLowerCase().replace(/[^a-z]+/g, '')}-sim.example` } : null;
  const st = place(inc).st;
  return {
    fleetManagers: D.fleetManagers(fleet.id ? fleet : { id: inc.fleetId, home: '' }),
    driver: { id: inc.driver.id, name: inc.driver.name, phone: inc.driver.phone, email: null, vehicle: inc.vehicle.unit || inc.vehicle.plate },
    insurer: { carrier: car.name, policyNo: D.policyNo(inc.fleetId), fnolLine: car.fnolLine, portal: car.portal },
    oem: { name: desk.name, brand: desk.oem, warrantyDesk: desk.warrantyDesk, portal: desk.portal, email: desk.email, hours: desk.hours },
    towProviders: provs, authorities: authorities(inc).map(({ agency, kind, phone, jurisdiction, recommended, reason, urgency }) => ({ agency, kind, phone, jurisdiction, recommended, reason, urgency })),
    cargoOwner: cargo, dispatchCallback: D.phone('dispatch', st), simulated: true,
  };
}

// ---------- templates ----------
async function templatesFor(kind) {
  const over = new Map((await db.list('template', { limit: 1000 })).map((o) => [o.id, o]));
  return D.TEMPLATES.filter((t) => !kind || t.kind === kind).map((t) => ({ ...t, ...(over.get(t.key) ? { subject: over.get(t.key).subject !== undefined ? over.get(t.key).subject : t.subject, body: over.get(t.key).body || t.body, edited: true } : { edited: false }) }));
}
function varsFor(inc, req) {
  const p = place(inc), rs = inc.roadside || {}, prov = rs.assignedProvider || rs.recommendedProvider;
  const ld = inc.load, c = contacts(inc);
  const tr = inc.equipment && inc.equipment.trailer;
  const hz = ld && ld.contents && ld.contents.hazmat;
  const link = inc.jobLink ? `${req ? base(req) : ''}${inc.jobLink.url}` : '(sent on dispatch)';
  const td = rs.towDestination;
  const rf = tr && tr.reefer;
  return {
    fleetName: inc.fleetName, incidentId: inc.id, eventType: inc.eventType.replace(/_/g, ' '), severity: inc.severity.toUpperCase(), status: inc.status.replace('_', ' '),
    vehicle: `${inc.vehicle.year || ''} ${inc.vehicle.make || ''} ${inc.vehicle.model || ''} (${inc.vehicle.plate})`.replace(/\s+/g, ' ').trim(), unit: inc.vehicle.unit,
    city: place(inc).city, driver: inc.driver.name, driverFirst: first(inc.driver.name), driverPhone: inc.driver.phone, location: inc.location.address, road: p.road, time: new Date(inc.timestamp).toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
    speed: inc.location.speed_mph, eta: rs.etaMin ? `${rs.etaMin} min` : 'TBD', provider: prov ? prov.name : '(provider TBD)', serviceType: (rs.serviceType || 'service').replace(/_/g, ' '),
    helpLine: rs.assignedProvider ? `${rs.assignedProvider.name} is en route, ETA ${rs.etaMin ? rs.etaMin + ' min' : 'TBD'}.` : 'recovery is being arranged; we will text you the provider and ETA as soon as it is confirmed.',
    recoveryLine: rs.assignedProvider ? `A recovery provider is en route (ETA ${rs.etaMin ? rs.etaMin + ' min' : 'TBD'}).` : 'Recovery is being arranged; we will confirm the provider and ETA shortly.',
    camera: inc.camera.verified ? `Camera-verified (${inc.camera.aiVerdict.replace(/_/g, ' ')}, ${Math.round(inc.camera.confidence * 100)}%).` : 'No camera confirmation.',
    cargo: ld && ld.contents && ld.estimatedWeightLb > 300 ? `~${ld.estimatedWeightLb.toLocaleString('en-US')} lb ${ld.contents.label.replace(' (likely)', '').toLowerCase()}` : 'none / empty', cargoOwner: c.cargoOwner ? c.cargoOwner.name : 'shipper',
    response: rs.needed ? `${(rs.serviceType || '').replace(/_/g, ' ')} via ${prov ? prov.name : 'TBD'}, ETA ${rs.etaMin || 'TBD'} min` : 'monitoring; no roadside needed',
    towDestination: td ? `${td.name} (${td.distanceMi} mi)` : 'TBD', jobLink: link, hazards: hz ? `HAZMAT: ${ld.contents.label.replace(' (likely)', '')}. Hazmat-certified recovery required${prov && !roadside.isHazmatCertified(prov.id) ? ' - if you cannot handle hazmat, tell us now and stand by for the hazmat team' : ''}. This is a request from the vehicle owner (${inc.fleetName}). ` : `Request from the vehicle owner (${inc.fleetName}). ` + (inc.diagnostics && inc.diagnostics.drivable === 'no' ? 'Non-drivable. ' : ''),
    codes: inc.diagnostics ? inc.diagnostics.dtcs.map((d) => d.code).join(', ') : 'n/a', policyNo: c.insurer.policyNo, trailer: tr && tr.attached ? ` pulling a ${tr.lengthFt}ft ${tr.type.replace('_', ' ')}` : '',
    injuries: 'unknown - driver being contacted', hazmatLine: hz ? `Hazmat aboard (${ld.contents.label.replace(' (likely)', '')}). ` : '', lanes: 'unknown, driver to confirm', callback: c.dispatchCallback,
    spoilage: ld && ld.contents && ld.contents.spoilageRiskHours ? `Estimated spoilage window: ${ld.contents.spoilageRiskHours} hours.` : '', reefer: rf ? `${rf.setpointF}F, unit ${rf.unitRunning ? 'running' : 'NOT running'}` : 'n/a', claimRef: inc.fnol ? inc.fnol.claimRef : '(pending)',
  };
}
const render = (s, v) => (s == null ? s : String(s).replace(/\{\{(\w+)\}\}/g, (m, k) => (v[k] == null || v[k] === '' ? '' : v[k])));

// ---------- notify / comms ----------
const ACT = { fleet_manager: 'notified_fleet_manager', driver: 'notified_driver', tow: 'notified_tow', insurer: 'notified_insurer', authority: 'notified_authority', cargo_owner: 'notified_cargo_owner', oem: 'notified_oem' };
function resolveTo(inc, to) {
  const c = contacts(inc); const type = to.type || 'other';
  let r = null;
  if (type === 'fleet_manager') r = (to.name && c.fleetManagers.find((m) => m.name === to.name)) || c.fleetManagers[0];
  else if (type === 'driver') r = c.driver;
  else if (type === 'tow') r = (to.id && c.towProviders.find((t) => t.id === to.id)) || c.towProviders.find((t) => t.assigned) || c.towProviders[0];
  else if (type === 'insurer') r = { name: c.insurer.carrier, phone: c.insurer.fnolLine, email: `claims@${c.insurer.carrier.split(' ')[0].toLowerCase()}-sim.example` };
  else if (type === 'authority') r = (to.id && c.authorities.find((a) => a.kind === to.id || a.agency === to.id)) || (to.name && c.authorities.find((a) => a.agency === to.name)) || c.authorities.find((a) => a.recommended) || c.authorities[0];
  else if (type === 'cargo_owner') r = c.cargoOwner;
  else if (type === 'oem') r = { name: c.oem.name, phone: c.oem.warrantyDesk, email: c.oem.email };
  r = r || {};
  return { type, id: to.id || r.id || r.kind || null, name: to.name || r.name || r.agency || null, phone: to.phone || r.phone || null, email: to.email || r.email || null, agencyKind: r.kind || null };
}
async function logComms(inc, { channel, to, subject, body, actor, template, outcome, at }) {
  const t = at || new Date().toISOString();
  const doc = { id: 'cm_' + crypto.randomBytes(5).toString('hex'), at: t, createdAt: t, incidentId: inc.id, fleetId: inc.fleetId, fleetName: inc.fleetName, channel, to, subject: subject || null, body, status: SIM, simulated: true, deliveredTo: 'no external recipient', actor: actor || 'dispatcher', template: template || null, outcome: outcome || null };
  await db.put('comms', doc);
  return doc;
}
async function notify(inc, b, req) {
  const channel = ['sms', 'email', 'call', 'push'].includes(b.channel) ? b.channel : null;
  if (!channel) throw Object.assign(new Error('channel must be sms|email|call|push'), { status: 422 });
  if (!b.to || !b.to.type) throw Object.assign(new Error('to.type is required (fleet_manager|driver|tow|insurer|authority|cargo_owner|oem)'), { status: 422 });
  if (!b.template && !b.message) throw Object.assign(new Error('provide template or message'), { status: 422 });
  const to = resolveTo(inc, b.to);
  let subject = null, body = b.message;
  if (b.template) {
    const t = (await templatesFor()).find((x) => x.key === b.template);
    if (!t) throw Object.assign(new Error('unknown template ' + b.template), { status: 422 });
    const v = varsFor(inc, req);
    subject = render(t.subject, v); if (!body) body = render(t.body, v);
  }
  const actor = b.actor || 'dispatcher';
  const doc = await logComms(inc, { channel, to, subject: b.subject || subject, body, actor, template: b.template, outcome: b.outcome });
  const eta = b.template && /eta/.test(b.template);
  const out = await db.updateIncident(inc.id, (i) => {
    const note = `${channel.toUpperCase()} to ${to.name || to.type}${to.phone ? ' ' + to.phone : ''} - ${SIM}${b.outcome ? ' - ' + b.outcome : ''}`;
    i.timeline.push({ t: doc.at, actor, action: ACT[to.type] || 'notified', note, meta: { commsId: doc.id, channel, toType: to.type, agencyKind: to.agencyKind, template: b.template || null } });
    if (eta && ['driver', 'fleet_manager'].includes(to.type)) i.timeline.push({ t: doc.at, actor, action: 'eta_shared', note: `ETA shared with ${to.type.replace('_', ' ')} (simulated)`, meta: { commsId: doc.id } });
  });
  stream.publish(out, 'update');
  return { comms: doc, incident: out };
}

// ---------- SOP ----------
function sopKind(inc) {
  const hz = inc.load && inc.load.contents && inc.load.contents.hazmat;
  if (inc.camera && inc.camera.aiVerdict === 'false_positive') return 'false_positive';
  if (['collision', 'rollover'].includes(inc.eventType)) return hz ? 'hazmat' : 'collision';
  if (inc.warranty && inc.warranty.claimEligible && inc.warranty.claimPacket) return 'warranty';
  if (inc.diagnostics || ['breakdown', 'tire', 'battery'].includes(inc.eventType)) return 'breakdown';
  return 'safety';
}
function sopDef(inc) {
  const k = sopKind(inc);
  const rs = inc.roadside || {};
  const cp = inc.warranty && inc.warranty.claimPacket;
  const auth = brief(inc);
  const ld = inc.load && inc.load.contents;
  const cargoRel = ld && ld.estimatedValueUsd && (ld.temperatureSensitive || ld.hazmat || ld.estimatedValueUsd[1] >= 50000) && inc.load.estimatedWeightLb > 300;
  const S = (key, label, required, hint, auto) => ({ key, label, required, hint, auto });
  const validate = S('validate_event', 'Validate event (camera / AI / telemetry)', true, 'Review camera verdict and signals; confirm the event is real before acting.', (i) => hasA(i, 'camera_verified') && i.camera.verified ? 'camera_verified' : (hasA(i, 'dtc_decoded') && !i.camera.verified && i.diagnostics ? 'dtc_decoded' : null));
  const dispatch = S('dispatch_tow', rs.serviceType && rs.serviceType.startsWith('tow') ? 'Dispatch tow provider' : 'Dispatch roadside service', !!rs.needed, 'Pick a provider; a no-login job link is texted to them.', (i) => (hasA(i, 'dispatched') || (i.roadside && i.roadside.assignedProvider) ? 'dispatched' : null));
  const fm = S('notify_fleet_manager', 'Notify fleet manager', true, 'Send the incident alert template.', (i) => hasA(i, 'notified_fleet_manager') && 'notified_fleet_manager');
  const eta = S('share_eta', 'Share ETA with driver', true, 'Driver should know who is coming and when.', (i) => (hasA(i, 'eta_shared') || hasA(i, 'notified_driver')) && 'eta_shared');
  const fnol = S('send_fnol', 'Send FNOL to insurer', true, 'First notice of loss to the fleet\'s carrier.', (i) => (i.fnol || hasA(i, 'fnol_sent')) && 'fnol_sent');
  const authS = S('call_authorities', 'Call authorities', auth.needsAuthorities, 'See the authority brief and call script; log the outcome.', (i) => hasA(i, 'notified_authority') && 'notified_authority');
  const cargo = S('notify_cargo_owner', 'Notify cargo owner', false, 'Perishable / high-value / hazmat cargo - warn the shipper.', (i) => hasA(i, 'notified_cargo_owner') && 'notified_cargo_owner');
  const close = S('close_incident', 'Resolve and close', true, 'Mark resolved once the vehicle is recovered/serviced.', (i) => (i.status === 'resolved' || i.status === 'dismissed') && 'status_' + i.status);
  const claimStep = S('submit_oem_claim', 'Submit OEM warranty claim', true, 'One click - packet is pre-assembled.', (i) => cp && !['draft', 'ready'].includes(cp.status) && 'warranty_submitted');
  const trackClaim = S('track_claim', 'Track OEM claim to approval / payment', false, 'Check OEM response; supply any requested info.', (i) => cp && ['approved', 'paid'].includes(cp.status) && 'warranty_' + cp.status);
  const defs = {
    collision: [validate, S('assess_injuries', 'Check on driver - injuries?', true, 'Call the driver; ask about injuries and lane position.', null), authS, dispatch, fm, eta, ...(cargoRel ? [cargo] : []), fnol, S('document_scene', 'Document scene (photos / clips saved)', false, 'Ask driver for photos; clips are attached automatically.', null), close],
    hazmat: [validate, S('assess_injuries', 'Check on driver - injuries?', true, 'Call the driver; ask about injuries and distance from the vehicle.', null), S('isolate_scene', 'Advise driver: move upwind, deny entry, no ignition sources', true, 'Do not let the driver approach the spill.', null), { ...authS, required: true }, S('call_hazmat_response', 'Request hazmat response team', true, 'Use the authority brief script; placard number is unconfirmed.', (i) => (i.timeline || []).find((e) => e.action === 'notified_authority' && e.meta && e.meta.agencyKind === 'hazmat_response') && 'notified_authority'), dispatch, fm, eta, { ...cargo, required: true }, fnol, close],
    breakdown: [validate, S('assess_drivability', 'Confirm drivability with driver', true, 'Fault codes say ' + ((inc.diagnostics && inc.diagnostics.drivable) || 'unknown') + '; ask the driver to confirm.', null), dispatch, fm, eta, ...(inc.warrantyDealer ? [S('route_to_dealer', 'Route to OEM dealer', false, 'Tow destination is the nearest in-network dealer.', (i) => (i.roadside && i.roadside.towDestination && i.roadside.towDestination.kind === 'oem_dealer' && hasA(i, 'tow_destination', 'warranty_dealer')) && 'tow_destination')] : []), ...(cargoRel ? [cargo] : []), close],
    warranty: [validate, S('confirm_coverage', 'Confirm warranty coverage', true, (inc.warranty && inc.warranty.reason) || 'Check coverage window.', (i) => i.warranty && i.warranty.claimEligible && 'coverage_verified'), S('route_to_dealer', 'Route to OEM dealer', true, 'Nearest in-network dealer with heavy-duty bays.', (i) => (i.roadside && i.roadside.towDestination && hasA(i, 'tow_destination')) && 'tow_destination'), dispatch, fm, eta, claimStep, trackClaim, close],
    false_positive: [S('confirm_false_positive', 'Confirm false positive (camera / AI)', true, 'Camera AI classified this as a false positive.', (i) => hasA(i, 'auto_dismissed') && 'auto_dismissed'), S('notify_driver_optional', 'Let driver know no action needed', false, 'Optional courtesy message.', (i) => hasA(i, 'notified_driver') && 'notified_driver'), close],
    safety: [validate, S('review_clip', 'Review event video / signals', true, 'Look at the camera evidence and driver-facing signals.', null), S('coach_driver', 'Assign driver coaching', false, 'Send a coaching clip / schedule a session.', (i) => hasA(i, 'coaching') && 'coaching'), S('notify_fleet_manager_opt', 'Notify fleet manager', false, 'Only if repeated or severe.', (i) => hasA(i, 'notified_fleet_manager') && 'notified_fleet_manager'), close],
  };
  if (inc.warranty && inc.warranty.claimEligible && cp && k !== 'warranty' && ['breakdown'].includes(k)) defs.breakdown.splice(defs.breakdown.length - 1, 0, claimStep);
  return { kind: k, steps: defs[k] };
}
function sop(inc) {
  const def = sopDef(inc); const man = (inc.sop && inc.sop.steps) || {};
  const steps = def.steps.map((s) => {
    const m = man[s.key];
    let r = { key: s.key, label: s.label, required: !!s.required, done: false, doneAt: null, doneBy: null, hint: s.hint };
    if (m && m.done === false) { r.manual = true; return r; }
    if (m && m.done) return { ...r, done: true, doneAt: m.doneAt, doneBy: m.doneBy, note: m.note || null, manual: true };
    const a = s.auto ? s.auto(inc) : null;
    if (a) {
      const ev = (typeof a === 'string' && ago(inc, a === 'eta_shared' ? 'eta_shared' : a)) || (inc.timeline || []).find((e) => e.action === a);
      r = { ...r, done: true, doneAt: (ev && ev.t) || inc.receivedAt, doneBy: (ev && ev.actor) || 'system', autoCompletedBy: typeof a === 'string' ? a : 'system' };
    }
    return r;
  });
  const req = steps.filter((s) => s.required); const pool = req.length ? req : steps;
  return { kind: def.kind, steps, percent: Math.round((100 * pool.filter((s) => s.done).length) / Math.max(1, pool.length)), requiredDone: req.filter((s) => s.done).length, requiredTotal: req.length };
}

// ---------- FNOL ----------
async function sendFnol(inc, actor, note) {
  if (inc.fnol) return { inc, alreadySent: true };
  const car = D.carrierOf(inc.fleetId);
  const attached = [];
  if (inc.camera.clips.length) attached.push(`${inc.camera.clips.length} camera clip(s)`);
  if (inc.camera.snapshots.length) attached.push('dashcam snapshot');
  if (inc.trip) attached.push('trip history + telemetry');
  if (inc.load && inc.load.estimatedWeightLb > 300) attached.push('load & cargo estimate');
  if (inc.warranty && inc.warranty.claimPacket) attached.push('evidence packet');
  attached.push('GPS trail', 'driver & vehicle details');
  const t = new Date().toISOString();
  const fnol = { claimRef: 'FNOL-' + String(hashStr('fnol' + inc.id) % 9000000 + 1000000), carrier: car.name, policyNo: D.policyNo(inc.fleetId), submittedAt: t, status: 'received (simulated)', attached, note: note || null, simulated: true };
  const c = contacts(inc);
  const doc = await logComms(inc, { channel: 'email', to: { type: 'insurer', name: car.name, phone: car.fnolLine, email: c.insurer ? `claims@${car.name.split(' ')[0].toLowerCase()}-sim.example` : null }, subject: `FNOL ${inc.id} - ${inc.fleetName} - ${inc.eventType.replace(/_/g, ' ')}`, body: `First notice of loss for policy ${fnol.policyNo}. Reference ${fnol.claimRef}. Attached: ${attached.join(', ')}.`, actor: actor || 'dispatcher', template: 'insurer_fnol', at: t });
  const out = await db.updateIncident(inc.id, (i) => {
    i.fnol = fnol;
    i.timeline.push({ t, actor: actor || 'dispatcher', action: 'fnol_sent', note: `FNOL ${fnol.claimRef} sent to ${car.name} (${SIM})`, meta: { commsId: doc.id, claimRef: fnol.claimRef } });
  });
  stream.publish(out, 'update');
  return { inc: out, alreadySent: false };
}

// ---------- tow jobs ----------
const JOB_TTL = 7 * 86400000;
async function createJob(inc, prov, actor, req) {
  if (!prov) return null;
  if (inc.jobLink) { const ex = await db.get('job', inc.jobLink.token); if (ex && ex.providerId === prov.id && !['declined', 'completed'].includes(ex.status)) return inc.jobLink; }
  const token = crypto.randomBytes(16).toString('hex');
  const t = new Date().toISOString();
  const job = { id: token, token, fleetId: inc.fleetId, incidentId: inc.id, providerId: prov.id, providerName: prov.name, providerPhone: prov.phone || null, status: 'sent', createdAt: t, expiresAt: new Date(Date.now() + JOB_TTL).toISOString(), events: [{ t, status: 'sent', note: 'Job link sent (simulated)' }] };
  await db.put('job', job);
  const link = { token, url: '/job/' + token };
  const v = varsFor({ ...inc, jobLink: link }, req);
  const tpl = D.TEMPLATES.find((x) => x.key === 'tow_dispatch');
  await logComms(inc, { channel: 'sms', to: { type: 'tow', id: prov.id, name: prov.name, phone: prov.phone }, body: render(tpl.body, v), actor: actor || 'dispatcher', template: 'tow_dispatch' });
  return link;
}
function ticket(job, inc, req) {
  const p = place(inc), ld = inc.load, tr = inc.equipment && inc.equipment.trailer, rs = inc.roadside || {};
  const hz = ld && ld.contents && ld.contents.hazmat;
  const hazards = [];
  if (hz) hazards.push(`HAZMAT: ${ld.contents.label.replace(' (likely)', '')} - placard unconfirmed, keep clear until hazmat team clears. Hazmat-certified recovery required: tell dispatch immediately if you cannot handle it`);
  hazards.push(`Requested by the vehicle owner (${inc.fleetName})`);
  if ((inc.risk.tags || []).includes('airbag_deployed')) hazards.push('Airbag deployed - possible fluid leaks');
  if (inc.eventType === 'rollover') hazards.push('Rolled vehicle - heavy recovery equipment (rotator) likely required');
  if (ld && ld.contents && ld.contents.temperatureSensitive) hazards.push('Perishable cargo - time sensitive');
  if (inc.diagnostics && inc.diagnostics.drivable === 'no') hazards.push('Vehicle not drivable');
  if (ld && ld.overweightRisk) hazards.push('Load may be at/over legal weight');
  if (tr && tr.type === 'flatbed' && ld && ld.estimatedWeightLb > 20000) hazards.push('Loaded flatbed - check for shifted load / straps');
  const wc = ld && ld.estimatedWeightLb > 300 ? (ld.estimatedWeightLb > 60000 ? 'over 60k lb gross' : ld.estimatedWeightLb > 30000 ? '30-60k lb payload' : 'under 30k lb payload') : 'empty / light';
  const td = rs.towDestination;
  return {
    token: job.token, status: job.status, ...SIMMARK, incidentId: inc.id, createdAt: job.createdAt, expiresAt: job.expiresAt, provider: { id: job.providerId, name: job.providerName },
    summary: `${(rs.serviceType || 'roadside').replace(/_/g, ' ')} - ${inc.vehicle.year || ''} ${inc.vehicle.make || ''} ${inc.vehicle.model || ''}`.replace(/\s+/g, ' '), serviceType: rs.serviceType || 'none', rationale: rs.rationale || null,
    location: { lat: inc.location.lat, lng: inc.location.lng, address: inc.location.address, road: p.road, direction: p.direction, navUrl: `https://maps.google.com/?q=${inc.location.lat},${inc.location.lng}` },
    vehicle: { description: `${inc.vehicle.year || ''} ${inc.vehicle.make || ''} ${inc.vehicle.model || ''}`.replace(/\s+/g, ' ').trim(), plate: inc.vehicle.plate, unit: inc.vehicle.unit, vin: inc.vehicle.vin, class: inc.equipment ? inc.equipment.tractor.class : null, gvwrLb: inc.equipment ? inc.equipment.tractor.gvwrLb : null },
    trailer: tr && tr.attached ? { type: tr.type, lengthFt: tr.lengthFt, unitId: tr.unitId } : null,
    load: ld && ld.estimatedWeightLb > 300 ? { weightClass: wc, estimatedWeightLb: ld.estimatedWeightLb, contents: ld.contents.label.replace(' (likely)', ''), confidence: ld.confidence } : null,
    hazards, dropoff: td ? { kind: td.kind, name: td.name, address: td.address, lat: td.lat, lng: td.lng, distanceMi: td.distanceMi } : null,
    contact: { dispatcher: { name: 'Nexus Response Dispatch', phone: D.phone('dispatch', p.st) }, driver: { name: inc.driver.name, phone: inc.driver.phone }, fleet: inc.fleetName },
    notes: (inc.timeline || []).filter((e) => e.action === 'note' && e.actor === 'dispatcher').map((e) => ({ t: e.t, note: e.note })).slice(-5),
    etaMin: (rs.assignedProvider && rs.assignedProvider.etaMin) || rs.etaMin || null, events: job.events, actions: ['accept', 'decline', 'eta', 'arrived', 'complete'],
    incidentStatus: inc.status,
  };
}

// ---------- routes ----------
const router = express.Router();
async function getInc(req, res) { const i = await db.getIncident(req.params.id); if (!i) { res.status(404).json({ error: 'Incident not found' }); return null; } return i; }

router.get('/api/incidents/:id/contacts', wrap(async (req, res) => { const i = await getInc(req, res); if (i) res.json(contacts(i)); }));
router.get('/api/fleets/:id/contacts', (req, res) => {
  const f = roster.getFleet(req.params.id); if (!f) return res.status(404).json({ error: 'Fleet not found' });
  const car = D.carrierOf(f.id);
  res.json({ fleetId: f.id, fleetManagers: D.fleetManagers(f), insurer: { carrier: car.name, policyNo: D.policyNo(f.id), fnolLine: car.fnolLine, portal: car.portal }, ...SIMMARK });
});
router.get('/api/incidents/:id/authority-brief', wrap(async (req, res) => { const i = await getInc(req, res); if (i) res.json(brief(i)); }));

router.get('/api/comms/templates', wrap(async (req, res) => {
  let list = await templatesFor(req.query.kind);
  if (req.query.incidentId) {
    const inc = await db.getIncident(req.query.incidentId);
    if (!inc) return res.status(404).json({ error: 'Incident not found' });
    const v = varsFor(inc, req);
    list = list.map((t) => ({ ...t, renderedSubject: render(t.subject, v), renderedBody: render(t.body, v) }));
  }
  res.json(list.map((t) => ({ ...t, variables: [...new Set(((t.subject || '') + t.body).match(/\{\{(\w+)\}\}/g) || [])].map((x) => x.slice(2, -2)) })));
}));
router.put('/api/comms/templates/:key', wrap(async (req, res) => {
  const t = D.TEMPLATES.find((x) => x.key === req.params.key); if (!t) return res.status(404).json({ error: 'Unknown template' });
  const b = req.body || {}; if (!b.body && b.subject === undefined) return res.status(422).json({ error: 'provide body and/or subject' });
  await db.put('template', { id: t.key, createdAt: new Date().toISOString(), body: b.body || undefined, subject: b.subject });
  res.json((await templatesFor()).find((x) => x.key === t.key));
}));
router.delete('/api/comms/templates/:key', wrap(async (req, res) => { await db.del('template', req.params.key); res.json({ reset: true }); }));

router.post('/api/incidents/:id/notify', wrap(async (req, res) => {
  const i = await getInc(req, res); if (!i) return;
  try { const r = await notify(i, req.body || {}, req); res.json({ ...r.comms, ...SIMMARK, incident: r.incident }); } catch (e) { res.status(e.status || 500).json({ error: 'validation_failed', message: e.message }); }
}));
router.get('/api/incidents/:id/comms', wrap(async (req, res) => {
  const i = await getInc(req, res); if (!i) return;
  const all = await db.list('comms', { fleetId: i.fleetId, limit: 100000 });
  res.json({ comms: all.filter((c) => c.incidentId === i.id).sort((a, b) => (a.at < b.at ? -1 : 1)) });
}));
router.get('/api/comms', wrap(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 1000);
  let rows = await db.list('comms', { fleetId: req.query.fleetId, limit: 100000 });
  if (req.query.channel) rows = rows.filter((c) => c.channel === req.query.channel);
  if (req.query.toType) rows = rows.filter((c) => c.to && c.to.type === req.query.toType);
  rows.sort((a, b) => (a.at < b.at ? 1 : -1));
  res.json({ comms: rows.slice(0, limit) });
}));

router.get('/api/incidents/:id/sop', wrap(async (req, res) => { const i = await getInc(req, res); if (i) res.json(sop(i)); }));
router.post('/api/incidents/:id/sop/:stepKey', wrap(async (req, res) => {
  const i = await getInc(req, res); if (!i) return;
  const def = sopDef(i); const st = def.steps.find((s) => s.key === req.params.stepKey);
  if (!st) return res.status(404).json({ error: 'Unknown step for this incident type', steps: def.steps.map((s) => s.key) });
  const b = req.body || {}; const done = b.done !== false; const actor = b.actor || 'dispatcher'; const t = new Date().toISOString();
  const out = await db.updateIncident(i.id, (inc) => {
    inc.sop = inc.sop || { steps: {} };
    inc.sop.steps[st.key] = { done, doneAt: done ? t : null, doneBy: done ? actor : null, note: b.note || null };
    inc.timeline.push({ t, actor, action: 'sop_step', note: `${done ? 'Completed' : 'Reopened'}: ${st.label}${b.note ? ' - ' + b.note : ''}`, meta: { step: st.key, done } });
  });
  stream.publish(out, 'update');
  res.json(sop(out));
}));

router.post('/api/incidents/:id/fnol', wrap(async (req, res) => {
  const i = await getInc(req, res); if (!i) return;
  const r = await sendFnol(i, req.body && req.body.actor, req.body && req.body.note);
  res.status(r.alreadySent ? 200 : 201).json({ ...r.inc.fnol, ...SIMMARK, alreadySent: r.alreadySent });
}));
router.get('/api/incidents/:id/fnol', wrap(async (req, res) => { const i = await getInc(req, res); if (!i) return; if (!i.fnol) return res.status(404).json({ error: 'No FNOL sent for this incident' }); res.json(i.fnol); }));

// ----- OEM claim: one click, idempotent -----
async function submitClaim(id, actor, req) {
  const inc0 = await db.getIncident(id); if (!inc0) throw Object.assign(new Error('Incident not found'), { status: 404 });
  let created = false;
  const out = await db.updateIncident(id, (inc) => { const r = claims.submit(inc, { actor }); created = r.created; });
  if (created) stream.publish(out, 'update');
  const cp = out.warranty.claimPacket;
  return {
    status: 'submitted', claimStatus: cp.status, confirmation: out.warranty.claimId, submittedTo: cp.submittedTo, submittedAt: cp.submittedAt, packetUrl: `/api/incidents/${id}/warranty-packet?format=html`,
    estimatedValueUsd: cp.estimatedValueUsd, claimNumber: cp.claimNumber, preAuthNumber: cp.preAuthNumber || null, oemDesk: cp.oemDesk, alreadySubmitted: !created, ...SIMMARK, incident: out,
  };
}
router.post('/api/incidents/:id/warranty/submit', wrap(async (req, res) => {
  try { res.json(await submitClaim(req.params.id, (req.body && req.body.actor) || 'fleet', req)); } catch (e) { res.status(e.status || 500).json({ error: 'claim_error', message: e.message }); }
}));
router.post('/api/fleets/:id/warranty/submit-ready', wrap(async (req, res) => {
  const f = roster.getFleet(req.params.id); if (!f) return res.status(404).json({ error: 'Fleet not found' });
  const incs = await db.listIncidents({ fleetId: f.id, limit: 100000, clone: false });
  const ready = incs.filter((i) => i.warranty && i.warranty.claimPacket && i.warranty.claimPacket.status === 'ready').map((i) => i.id);
  const results = [];
  for (const id of ready) { try { const r = await submitClaim(id, (req.body && req.body.actor) || 'fleet', req); results.push({ incidentId: id, confirmation: r.confirmation, claimNumber: r.claimNumber, estimatedValueUsd: r.estimatedValueUsd }); } catch (e) { results.push({ incidentId: id, error: e.message }); } }
  res.json({ submitted: results.filter((r) => !r.error).length, totalValueUsd: results.reduce((s, r) => s + (r.estimatedValueUsd || 0), 0), results, ...SIMMARK });
}));
router.get('/api/incidents/:id/warranty/claim', wrap(async (req, res) => { const i = await getInc(req, res); if (!i) return; const s = claims.summary(i); if (!s) return res.status(404).json({ error: 'No warranty claim on this incident' }); res.json(s); }));
router.post('/api/incidents/:id/warranty/status', wrap(async (req, res) => {
  const i0 = await getInc(req, res); if (!i0) return;
  if (!i0.warranty || !i0.warranty.claimPacket) return res.status(404).json({ error: 'No warranty claim on this incident' });
  const b = req.body || {};
  let to = b.status, actor = b.actor || 'oem';
  try {
    if (b.simulate || !to) { to = claims.simulateNext(i0, b.outcome); actor = 'oem'; if (!to) return res.status(409).json({ error: 'nothing_to_simulate', message: `Claim is ${i0.warranty.claimPacket.status}; submit it first or it is already final.` }); }
    const out = await db.updateIncident(i0.id, (inc) => { claims.applyStatus(inc, to, { note: b.note, actor }); });
    stream.publish(out, 'update');
    res.json({ ...claims.summary(out), ...SIMMARK, incident: out });
  } catch (e) { res.status(e.status || 500).json({ error: 'invalid_transition', message: e.message, allowed: claims.NEXT[i0.warranty.claimPacket.status] }); }
}));

// ----- tow job links (public) -----
async function loadJob(req, res) {
  const job = await db.get('job', req.params.token);
  if (!job) { res.status(404).json({ error: 'Job link not found' }); return {}; }
  if (new Date(job.expiresAt) < new Date()) { res.status(410).json({ error: 'Job link expired' }); return {}; }
  const inc = await db.getIncident(job.incidentId);
  if (!inc) { res.status(404).json({ error: 'Incident not found' }); return {}; }
  return { job, inc };
}
router.get('/api/jobs/:token', wrap(async (req, res) => { const { job, inc } = await loadJob(req, res); if (job) res.json(ticket(job, inc, req)); }));
const JOB_ACTIONS = {
  accept: { job: 'accepted', inc: 'en_route', action: 'en_route', note: (b) => `Provider accepted the job${b.etaMin ? `, ETA ${b.etaMin} min` : ''}` },
  decline: { job: 'declined', inc: 'pending', action: 'provider_declined', note: (b) => `Provider declined the job${b.note ? ': ' + b.note : ''}` },
  eta: { job: 'en_route', inc: 'en_route', action: 'eta_updated', note: (b) => `Provider updated ETA to ${b.etaMin} min` },
  arrived: { job: 'arrived', inc: 'on_scene', action: 'on_scene', note: () => 'Provider arrived on scene' },
  complete: { job: 'completed', inc: 'resolved', action: 'resolved', note: (b) => `Provider marked job complete${b.note ? ': ' + b.note : ''}` },
};
router.post('/api/jobs/:token/:action', wrap(async (req, res) => {
  const A = JOB_ACTIONS[req.params.action]; if (!A) return res.status(404).json({ error: 'Unknown action', actions: Object.keys(JOB_ACTIONS) });
  const { job, inc } = await loadJob(req, res); if (!job) return;
  const b = req.body || {};
  if (['accept', 'eta'].includes(req.params.action) || b.etaMin != null) { if (b.etaMin != null && !(Number.isFinite(+b.etaMin) && +b.etaMin >= 1 && +b.etaMin <= 1440)) return res.status(422).json({ error: 'validation_failed', message: 'etaMin must be 1-1440' }); if (req.params.action === 'eta' && b.etaMin == null) return res.status(422).json({ error: 'validation_failed', message: 'etaMin is required' }); }
  if (['declined', 'completed'].includes(job.status)) return res.status(409).json({ error: 'job_closed', message: `Job already ${job.status}` });
  const t = new Date().toISOString();
  if (A.job && !(req.params.action === 'eta' && job.status === 'arrived')) job.status = A.job;
  job.events.push({ t, status: A.job || job.status, action: req.params.action, etaMin: b.etaMin != null ? +b.etaMin : undefined, note: b.note || null });
  await db.put('job', job);
  const out = await db.updateIncident(inc.id, (i) => {
    const rs = i.roadside = i.roadside || {};
    if (b.etaMin != null) { rs.etaMin = +b.etaMin; if (rs.assignedProvider) rs.assignedProvider.etaMin = +b.etaMin; }
    if (A.inc && !(req.params.action === 'eta' && ['on_scene', 'resolved'].includes(i.status))) { i.status = A.inc; if (A.inc === 'resolved') i.resolvedAt = t; }
    if (req.params.action === 'decline') rs.assignedProvider = null;
    i.timeline.push({ t, actor: 'provider', action: A.action, note: A.note(b) + ` (${job.providerName}, via job link)`, meta: { jobToken: job.token } });
  });
  stream.publish(out, 'update');
  res.json(ticket(job, out, req));
}));

// ---------- seed ----------
const SEV = { critical: 3, high: 2, medium: 1, low: 0 };
async function seedOps({ now = new Date() } = {}) {
  const incs = await db.listIncidents({ limit: 100000, clone: false, notSource: 'historical_import' });
  const t14 = now.getTime() - 14 * 86400000;
  let nComms = 0, nFnol = 0, nJobs = 0;
  const T = (inc, mins) => new Date(+new Date(inc.receivedAt) + mins * 60000).toISOString();
  for (const inc of incs) {
    const rng = rngFrom('ops:' + inc.id);
    const cp = inc.warranty && inc.warranty.claimPacket;
    if (cp) {
      claims.ensureMeta(inc);
      if (cp.status !== 'draft' && cp.status !== 'ready') { cp.claimNumber = cp.claimNumber || claims.claimNumber(inc); cp.submittedAt = cp.submittedAt || (inc.timeline.find((e) => e.action === 'warranty_submitted') || {}).t || T(inc, 300); cp.submittedTo = cp.oemDesk.portal; cp.confirmation = inc.warranty.claimId; if (!cp.history.length) cp.history.push({ t: cp.submittedAt, status: 'submitted', by: 'fleet', note: 'Submitted (simulated)' }); if (cp.status === 'paid') { cp.paidAmountUsd = cp.paidAmountUsd || Math.round(cp.estimatedValueUsd * 0.92); cp.paidAt = cp.paidAt || (inc.timeline.find((e) => e.action === 'warranty_paid') || {}).t; cp.approvedAmountUsd = cp.paidAmountUsd; } }
      if (inc.warrantyDealer && cp.status !== 'draft' && !inc.warrantyDealer.preAuthNumber) claims.ensureMeta(inc), (cp.estimatedValueUsd > 2500 && claimsPre(inc));
    }
    if (+new Date(inc.timestamp) < t14 || inc.camera.aiVerdict === 'false_positive') continue;
    const tl = inc.timeline;
    const add = (min, actor, action, note, meta) => tl.push({ t: T(inc, min), actor, action, note, meta });
    const mk = async (min, channel, to, template, body, actor = 'dispatcher') => { const d = await logComms(inc, { channel, to, template, body, actor, at: T(inc, min) }); nComms++; add(min, actor, ACT[to.type] || 'notified', `${channel.toUpperCase()} to ${to.name} ${to.phone || ''} - ${SIM}`, { commsId: d.id, channel, toType: to.type, template, agencyKind: to.agencyKind || undefined }); return d; };
    const c = contacts(inc); const v = varsFor(inc, null);
    const sevN = SEV[inc.severity] || 0;
    if (sevN >= 2 || inc.category === 'roadside' || inc.category === 'collision') {
      const m = c.fleetManagers[0];
      await mk(2 + Math.floor(rng() * 4), 'sms', { type: 'fleet_manager', name: m.name, phone: m.phone }, 'fm_incident_sms', render(D.TEMPLATES.find((x) => x.key === 'fm_incident_sms').body, v));
    }
    if (inc.category === 'collision' || (inc.diagnostics && inc.diagnostics.drivable !== 'yes')) await mk(3 + Math.floor(rng() * 4), 'sms', { type: 'driver', name: c.driver.name, phone: c.driver.phone }, inc.category === 'collision' ? 'driver_check_in' : 'driver_breakdown', render(D.TEMPLATES.find((x) => x.key === (inc.category === 'collision' ? 'driver_check_in' : 'driver_breakdown')).body, v));
    if (inc.roadside && inc.roadside.assignedProvider) {
      const pv = inc.roadside.assignedProvider;
      const tok = crypto.createHash('sha1').update('job' + inc.id).digest('hex').slice(0, 32);
      const link = { token: tok, url: '/job/' + tok };
      const st = { dispatched: 'sent', en_route: 'accepted', on_scene: 'arrived', resolved: 'completed' }[inc.status] || 'sent';
      await db.put('job', { id: tok, token: tok, fleetId: inc.fleetId, incidentId: inc.id, providerId: pv.id, providerName: pv.name, providerPhone: pv.phone, status: st, createdAt: T(inc, 5), expiresAt: new Date(now.getTime() + JOB_TTL).toISOString(), events: [{ t: T(inc, 5), status: 'sent', note: 'Job link sent (simulated)' }] });
      inc.jobLink = link; nJobs++;
      await mk(5, 'sms', { type: 'tow', id: pv.id, name: pv.name, phone: pv.phone }, 'tow_dispatch', render(D.TEMPLATES.find((x) => x.key === 'tow_dispatch').body, varsFor(inc, null)));
      if (rng() < 0.6) await mk(7, 'sms', { type: 'driver', name: c.driver.name, phone: c.driver.phone }, 'driver_eta', render(D.TEMPLATES.find((x) => x.key === 'driver_eta').body, v));
      tl.push({ t: T(inc, 7), actor: 'dispatcher', action: 'eta_shared', note: 'ETA shared with driver (simulated)' });
    }
    if (['collision', 'rollover'].includes(inc.eventType)) {
      if (rng() < 0.55 && c.authorities.some((a) => a.recommended)) { const a = c.authorities.find((x) => x.recommended); await mk(4, 'call', { type: 'authority', name: a.agency, phone: a.phone, agencyKind: a.kind }, 'authority_call', render(D.TEMPLATES.find((x) => x.key === 'authority_call').body, v)); }
      if (c.cargoOwner && inc.load.contents.temperatureSensitive && rng() < 0.6) await mk(12, 'email', { type: 'cargo_owner', name: c.cargoOwner.name, phone: c.cargoOwner.phone }, 'cargo_delay', render(D.TEMPLATES.find((x) => x.key === 'cargo_delay').body, v));
    }
    if (['collision', 'rollover'].includes(inc.eventType) && SEV[inc.severity] >= 2 && rng() < 0.7 && inc.status !== 'pending') {
      const car = D.carrierOf(inc.fleetId); const tt = T(inc, 25 + Math.floor(rng() * 60));
      inc.fnol = { claimRef: 'FNOL-' + String(hashStr('fnol' + inc.id) % 9000000 + 1000000), carrier: car.name, policyNo: D.policyNo(inc.fleetId), submittedAt: tt, status: 'received (simulated)', attached: ['camera clips', 'trip history + telemetry', 'GPS trail', 'driver & vehicle details'], simulated: true };
      tl.push({ t: tt, actor: 'dispatcher', action: 'fnol_sent', note: `FNOL ${inc.fnol.claimRef} sent to ${car.name} (${SIM})`, meta: { claimRef: inc.fnol.claimRef } });
      nFnol++;
    }
    tl.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  }
  // persist all
  await db.saveIncidentsBulk(incs);
  return { comms: nComms, fnols: nFnol, jobs: nJobs };
}
function claimsPre(inc) { const cp = inc.warranty.claimPacket; cp.preAuthNumber = `PA-${inc.warranty.oem.slice(0, 3).toUpperCase()}-${String(inc.id).replace(/\D/g, '')}`; inc.warrantyDealer.preAuthNumber = cp.preAuthNumber; }

module.exports = { recoveryCheck, router, contacts, authorities, brief, sop, notify, varsFor, createJob, seedOps, submitClaim, sendFnol, logComms };
