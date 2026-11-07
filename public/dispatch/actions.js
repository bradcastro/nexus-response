/* Dispatch — daily-driver actions: SOP, action strip, authorities, comms, OEM claim, shift bar */
(function () {
  'use strict';
  var esc = NX.esc, fmt = NX.fmt, D, S;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var Sim = window.NXSim;
  var OEM_STEPS = ['draft', 'ready', 'submitted', 'under_review', 'decision', 'paid'];
  var DECISIONS = { approved: 'ok', denied: 'danger', more_info_needed: 'warn' };
  var STEP_RE = { validate: /valid|verif|review|camera/i, dispatch: /dispatch|tow|provider/i, fleet: /fleet|manager/i, authority: /authorit|police|911|patrol/i, fnol: /fnol|insurer|carrier/i, oem: /oem|claim|warrant/i, cargo: /cargo/i, eta: /eta|customer|driver/i };

  function api(p, o) { return D.api(p, o); }
  function inc() { return S.inc.get(S.sel); }
  function list(d, k) { return Array.isArray(d) ? d : (d && d[k]) || []; }
  function getS(k, id) { return (S[k] || (S[k] = {}))[id]; }
  function setS(k, id, v) { (S[k] || (S[k] = {}))[id] = v; }
  function stepFor(i, kind) {
    var sop = getS('sop', i.id); if (!sop || !sop.steps) return null;
    return sop.steps.find(function (s) { return STEP_RE[kind].test(s.key + ' ' + s.label); }) || null;
  }
  function pctSop(sop) { if (!sop) return null; if (sop.percent != null) return Math.round(sop.percent <= 1 && sop.percent > 0 && sop.steps && sop.steps.length > 1 && sop.percent !== 1 ? sop.percent * 100 : sop.percent); var st = sop.steps || []; return st.length ? Math.round(st.filter(function (x) { return x.done; }).length / st.length * 100) : 0; }
  function copy(t) { try { navigator.clipboard.writeText(t); NX.toast('Copied', 'success', 1500); } catch (e) { NX.toast('Copy failed', 'warn'); } }

  /* ---------- loading ---------- */
  function load(id) {
    var ok = function (k) { return function (d) { setS(k, id, d); if (S.sel === id) D.renderDetail(); }; };
    api('/api/incidents/' + encodeURIComponent(id) + '/sop').then(ok('sop')).catch(function () { setS('sop', id, null); });
    api('/api/incidents/' + encodeURIComponent(id) + '/contacts').then(ok('contacts')).catch(function () { setS('contacts', id, null); });
    refreshComms(id);
  }
  function refreshComms(id) { return api('/api/incidents/' + encodeURIComponent(id) + '/comms').then(function (d) { setS('comms', id, list(d, 'comms')); if (S.sel === id) D.renderDetail(); }).catch(function () { setS('comms', id, null); }); }
  function refreshSop(id) { return api('/api/incidents/' + encodeURIComponent(id) + '/sop').then(function (d) { setS('sop', id, d); if (S.sel === id) D.renderDetail(); }).catch(function () {}); }
  function afterAction(id) { refreshSop(id); refreshComms(id); }

  /* ---------- SOP ring + checklist ---------- */
  function ring(i) {
    var sop = getS('sop', i.id), p = pctSop(sop);
    if (p == null) return '<div class="sop-ring is-na" title="Guided SOP not available"><span>SOP</span></div>';
    var r = 19, c = 2 * Math.PI * r, col = p >= 100 ? 'var(--nx-ok)' : 'var(--nx-accent)';
    return '<button class="sop-ring" data-sopjump title="Guided SOP: ' + p + '% complete. Click to view checklist"><svg viewBox="0 0 48 48"><circle cx="24" cy="24" r="' + r + '" fill="none" stroke="var(--nx-surface-3)" stroke-width="5"/><circle cx="24" cy="24" r="' + r + '" fill="none" stroke="' + col + '" stroke-width="5" stroke-linecap="round" stroke-dasharray="' + (p / 100 * c).toFixed(1) + ' ' + c.toFixed(1) + '" transform="rotate(-90 24 24)" style="transition:stroke-dasharray .5s"/></svg><b>' + p + '</b></button>';
  }
  function sopPanel(i, panel) {
    var sop = getS('sop', i.id); if (!sop || !(sop.steps || []).length) return '';
    var req = sop.steps.filter(function (s) { return s.required !== false; }), next = sop.steps.find(function (s) { return !s.done && s.required !== false; });
    return panel('Guided SOP', '<span class="nx-mono nx-faint" style="font-size:12px">' + fmt.label(sop.kind || '') + ' &middot; ' + sop.steps.filter(function (s) { return s.done; }).length + '/' + sop.steps.length + '</span>',
      '<ul class="sop">' + sop.steps.map(function (s) {
        return '<li class="' + (s.done ? 'is-done' : '') + (next && next.key === s.key ? ' is-next' : '') + '"><button class="sop-box" data-sopstep="' + esc(s.key) + '" aria-pressed="' + !!s.done + '" title="' + (s.done ? 'Mark not done' : 'Mark done') + '">' + (s.done ? '✓' : '') + '</button><div class="nx-grow"><div class="sop-l">' + esc(s.label) + (s.required === false ? ' <span class="nx-faint">(optional)</span>' : '') + '</div>' +
          (s.done ? '<div class="nx-faint nx-mono" style="font-size:12px">' + (s.doneAt ? fmt.time(s.doneAt) : '') + (s.doneBy ? ' &middot; ' + esc(s.doneBy) : '') + (s.autoCompletedBy ? ' &middot; auto: ' + esc(s.autoCompletedBy) : '') + '</div>' : s.hint ? '<div class="nx-dim" style="font-size:12px">' + esc(s.hint) + '</div>' : '') + '</div></li>';
      }).join('') + '</ul>', 'sop');
  }
  function toggleStep(key) {
    var i = inc(), sop = getS('sop', i.id), st = sop && sop.steps.find(function (s) { return s.key === key; }); if (!st) return;
    var done = !st.done; st.done = done; D.renderDetail();
    api('/api/incidents/' + encodeURIComponent(i.id) + '/sop/' + encodeURIComponent(key), { method: 'POST', body: { done: done, actor: 'dispatcher' } }).then(function (d) { if (d && d.steps) setS('sop', i.id, d); else refreshSop(i.id); D.renderDetail(); }).catch(function (e) { st.done = !done; NX.toast(e.message, 'error'); D.renderDetail(); });
  }

  /* ---------- action strip ---------- */
  var ACTIONS = [
    ['validate', 'Validate', 'v'], ['dispatch', 'Dispatch tow', 'd'], ['fleet', 'Notify fleet', 'f'], ['authority', 'Authorities', 'p'],
    ['fnol', 'FNOL insurer', 'i'], ['oem', 'OEM claim', 'o'], ['cargo', 'Cargo owner', 'g'], ['eta', 'Share ETA', 'e']
  ];
  function cargoRelevant(i) { var c = i.load && i.load.contents; return !!(c && (c.hazmat || c.temperatureSensitive)); }
  function strip(i) {
    var closed = ['resolved', 'dismissed'].indexOf(i.status) > -1, w = i.warranty, hazOrColl = i.category === 'collision' || (i.load && i.load.contents && i.load.contents.hazmat);
    var auth = getS('brief', i.id);
    return '<div class="act-strip">' + ACTIONS.map(function (a) {
      var k = a[0], done = isDone(i, k);
      var dis = closed && k !== 'oem' && k !== 'fnol', hint = '', rec = false;
      if (k === 'oem') { dis = !(w && (w.claimEligible || w.claimPacket)); hint = dis ? 'No eligible OEM claim' : ''; }
      if (k === 'cargo') { dis = !cargoRelevant(i) && !(getS('contacts', i.id) && getS('contacts', i.id).cargoOwner); rec = cargoRelevant(i); }
      if (k === 'authority') rec = !!hazOrColl && i.severity !== 'low';
      if (k === 'validate') rec = i.status === 'pending';
      if (k === 'dispatch') rec = !done && !!(i.roadside && i.roadside.needed);
      return '<button class="act-btn' + (done ? ' is-done' : '') + (rec && !done ? ' is-rec' : '') + (S.busy['x_' + k] ? ' is-loading' : '') + '" data-xact="' + k + '"' + (dis ? ' disabled' : '') + (hint ? ' title="' + hint + '"' : '') + '><span class="act-l">' + (done ? '<i class="tick">✓</i>' : '') + a[1] + '</span><kbd>' + a[2] + '</kbd></button>';
    }).join('') + '</div><div class="act-sim">' + Sim.line('all') + '</div>';
  }

  /* ---------- next best action ---------- */
  function tlHas(i, re) { return (i.timeline || []).some(function (e) { return re.test(e.action || ''); }); }
  function commsTo(i, type) { return (getS('comms', i.id) || []).some(function (x) { return x.to && x.to.type === type; }); }
  function isDone(i, k) {
    var st = stepFor(i, k); if (st && st.done) return true;
    var pk = i.warranty && i.warranty.claimPacket;
    switch (k) {
      case 'validate': return i.status !== 'pending';
      case 'dispatch': return !!(i.roadside && i.roadside.assignedProvider);
      case 'fleet': return tlHas(i, /notified_fleet_manager/) || commsTo(i, 'fleet_manager');
      case 'authority': return tlHas(i, /notified_authority/) || commsTo(i, 'authority');
      case 'fnol': return !!(getS('fnol', i.id) || i.fnol) || tlHas(i, /fnol_sent/);
      case 'oem': return !!(pk && ['submitted', 'under_review', 'approved', 'paid', 'denied', 'more_info_needed'].indexOf(pk.status) > -1);
      case 'cargo': return tlHas(i, /notified_cargo_owner/) || commsTo(i, 'cargo_owner');
      case 'eta': return tlHas(i, /eta_shared/);
    }
    return false;
  }
  var PCT = function (c) { c = Number(c); return isNaN(c) ? null : Math.round(c <= 1 ? c * 100 : c); };
  function nextActions(i) {
    var closed = ['resolved', 'dismissed'].indexOf(i.status) > -1, cam = i.camera && i.camera.aiVerdict !== 'no_video' ? i.camera : null, conf = cam ? PCT(cam.confidence) : null;
    var fp = !!(i.camera && i.camera.aiVerdict === 'false_positive'), w = i.warranty, r = i.roadside || {}, rec = r.assignedProvider || r.recommendedProvider || null;
    var dx = i.diagnostics || {}, haz = !!(i.load && i.load.contents && i.load.contents.hazmat), coll = i.category === 'collision';
    var what = fmt.label(i.severity) + ' ' + fmt.label(i.eventType).toLowerCase();
    var camTxt = fp ? 'vendor verdict is false positive' + (conf != null ? ' (' + conf + '%)' : '') : cam ? (cam.verified ? 'vendor supplied a verdict' : 'vendor has not marked this verified') + (conf != null ? ' (' + conf + '%)' : '') : 'no camera evidence';
    var age = fmt.ago(i.receivedAt || i.timestamp), out = [];
    var X = function (k, title, why, btn, kbd, sim) { return { key: k, title: title, why: why, btn: btn, kbd: kbd, sim: sim || null, attr: 'data-xact="' + k + '"' }; };
    if (closed) {
      if (w && (w.claimEligible || w.claimPacket) && !isDone(i, 'oem')) out.push(X('oem', 'Submit the OEM warranty claim', 'The incident is ' + i.status + ' but a claim' + (w.claimPacket && w.claimPacket.estimatedValueUsd != null ? ' worth ' + fmt.currency(w.claimPacket.estimatedValueUsd) : '') + ' has not been filed.', 'Submit OEM claim', 'o', 'claim'));
      return out;
    }
    if (fp) out.push({ key: 'dismiss', title: 'Confirm false positive and dismiss', why: 'The ' + camTxt + '. Dispatching is not recommended unless the driver reports a real event.', btn: 'Dismiss', kbd: 'x', attr: 'data-act="dismissopen"' });
    if (!isDone(i, 'validate')) out.push(X('validate', 'Validate the event', what + ', ' + camTxt + ', waiting ' + age.replace(' ago', '') + '. Confirm it is real before anyone is dispatched.', 'Validate', 'v'));
    if (r.needed && !isDone(i, 'dispatch') && !fp) out.push(X('dispatch', 'Dispatch ' + (rec ? rec.name : 'a tow provider'), (dx.drivable === 'no' ? 'The vehicle is not drivable' : r.serviceType && r.serviceType !== 'none' ? fmt.label(r.serviceType) + ' is needed' : 'Roadside help is needed') + ' and no provider is assigned' + (rec && (rec.etaMin != null || r.etaMin != null) ? '. The recommended provider can arrive in about ' + Math.round(rec.etaMin != null ? rec.etaMin : r.etaMin) + ' min.' : '.'), 'Dispatch tow', 'd', 'tow'));
    if ((coll || haz) && i.severity !== 'low' && !isDone(i, 'authority') && !fp) out.push(X('authority', 'Call authorities', haz ? 'A hazmat load is on board. Responders need to know before anyone approaches.' : 'Collision on record. Confirm injuries with the driver and notify the responsible agency.', 'Call authorities', 'p', 'authority'));
    if ((i.severity === 'critical' || i.severity === 'high') && !isDone(i, 'fleet') && !fp) out.push(X('fleet', 'Notify the fleet manager', 'A ' + i.severity + ' event is open and the fleet manager has not been told.', 'Notify fleet', 'f', 'message'));
    if (r.assignedProvider && !isDone(i, 'eta')) out.push(X('eta', 'Share the ETA with the driver', 'Help is assigned' + (rec && rec.etaMin != null ? ' (about ' + Math.round(rec.etaMin) + ' min)' : '') + '. The driver has not been told.', 'Share ETA', 'e', 'eta'));
    if (cargoRelevant(i) && !isDone(i, 'cargo') && !fp) out.push(X('cargo', 'Notify the cargo owner', haz ? 'Hazmat cargo is involved.' : 'Temperature-sensitive cargo is on a delayed truck.', 'Notify cargo owner', 'g', 'message'));
    if (coll && !isDone(i, 'fnol') && !fp) out.push(X('fnol', 'File first notice of loss', 'Collision events need a first notice of loss to the insurer.', 'Send FNOL', 'i', 'fnol'));
    if (w && (w.claimEligible || w.claimPacket) && !isDone(i, 'oem') && !fp) out.push(X('oem', 'Submit the OEM warranty claim', 'Warranty-eligible failure' + (w.claimPacket && w.claimPacket.estimatedValueUsd != null ? ', ' + fmt.currency(w.claimPacket.estimatedValueUsd) + ' recoverable' : '') + '. The claim packet is ready.', 'Submit OEM claim', 'o', 'claim'));
    var nxt = { dispatched: ['en_route', 'Mark en route', '1'], en_route: ['on_scene', 'Mark on scene', '2'], on_scene: ['resolved', 'Resolve incident', '3'] }[i.status];
    if (nxt && !fp) out.push({ key: 'status', title: nxt[1], why: 'Keep the incident status current for the fleet and the audit trail.', btn: nxt[1], kbd: nxt[2], attr: 'data-act="status" data-st="' + nxt[0] + '"' });
    return out;
  }
  function urgentHTML(i) {
    var list = nextActions(i), a = list[0];
    if (!a) return '<section class="next-act is-clear" style="--c:var(--nx-ok)"><div class="na-eyebrow">Next action</div><div class="na-main"><div class="na-copy"><h3>Nothing urgent</h3><p class="na-why"><b>Why:</b> ' + (['resolved', 'dismissed'].indexOf(i.status) > -1 ? 'This incident is ' + esc(i.status) + ' and no follow-up is outstanding.' : 'All recommended actions for this stage are done.') + ' Supporting detail is below.</p></div></div></section>';
    var then = list.slice(1, 4).map(function (x) { return esc(x.btn); }).join(', ');
    return '<section class="next-act" style="--c:' + NX.sevColor(i.severity) + '"><div class="na-eyebrow">Next action</div><div class="na-main"><div class="na-copy"><h3>' + esc(a.title) + '</h3><p class="na-why"><b>Why:</b> ' + esc(a.why) + '</p></div>' +
      '<button class="nx-btn nx-btn--primary na-btn' + (S.busy['x_' + a.key] || S.busy[a.key] ? ' is-loading' : '') + '" ' + a.attr + '>' + esc(a.btn) + ' <kbd>' + a.kbd + '</kbd></button></div>' +
      (a.sim ? Sim.note(a.sim) : '') + (then ? '<div class="na-then"><span>Then:</span> ' + then + '</div>' : '') + '</section>';
  }

  /* ---------- helpers: templates & modals ---------- */
  function vars(i) {
    var v = i.vehicle || {}, d = i.driver || {}, l = i.location || {}, r = i.roadside || {}, p = r.assignedProvider || r.recommendedProvider || {};
    return { id: i.id, incidentId: i.id, eventType: fmt.label(i.eventType), type: fmt.label(i.eventType), severity: i.severity, status: fmt.label(i.status), unit: v.unit || v.plate || v.id, vehicle: [v.year, v.make, v.model].filter(Boolean).join(' '), plate: v.plate, vin: v.vin, driver: d.name, driverName: d.name, driverPhone: d.phone, address: l.address, road: l.road, fleet: i.fleetName, fleetName: i.fleetName, provider: p.name, providerName: p.name, eta: p.etaMin != null ? p.etaMin : r.etaMin, etaMin: p.etaMin != null ? p.etaMin : r.etaMin, time: fmt.time(i.timestamp), cargo: i.load && i.load.contents && i.load.contents.label };
  }
  function render(t, i) { var v = vars(i); return String(t || '').replace(/\{\{?\s*([\w.]+)\s*\}?\}/g, function (m, k) { return v[k] != null && v[k] !== '' ? v[k] : m; }); }
  function fallbackMsg(kind, i) {
    var v = vars(i), base = v.type + ' on unit ' + v.unit + ' (' + (v.driver || 'driver') + ') at ' + (v.address || 'unknown location') + '.';
    return {
      fleet_manager: 'Nexus Response: ' + base + ' Severity ' + v.severity + '. ' + (v.provider ? 'Tow: ' + v.provider + (v.eta != null ? ', ETA ' + Math.round(v.eta) + ' min' : '') + '. ' : 'Tow not yet dispatched. ') + 'Reply or call dispatch for updates.',
      cargo_owner: 'Nexus Response: truck ' + v.unit + ' carrying ' + (v.cargo || 'your shipment') + ' was involved in a ' + v.type.toLowerCase() + ' near ' + (v.address || 'unknown') + '. Delivery may be delayed; we will update you shortly.',
      driver: 'Nexus Response: help is on the way' + (v.provider ? ' (' + v.provider + (v.eta != null ? ', ETA ' + Math.round(v.eta) + ' min' : '') + ')' : '') + '. Stay in a safe place, keep hazards on, and reply with any change.'
    }[kind] || base;
  }
  function getTemplate(kind, i, prefer) {
    return api('/api/comms/templates', { query: { kind: kind, incidentId: i.id } }).then(function (d) {
      var l = list(d, 'templates'), isList = Array.isArray(d) || (d && d.templates);
      var t = isList ? ((prefer && l.filter(function (x) { return prefer.test(x.key || x.name || ''); })[0]) || l[0]) : d;
      // the server already renders {{vars}} for this incident (renderedBody); only fall back to the local renderer on the raw body
      var txt = t && (t.renderedBody || t.body || t.text || t.message || (typeof t === 'string' ? t : ''));
      return txt ? { text: t.renderedBody ? txt : render(txt, i), subject: t.renderedSubject || (t.subject ? render(t.subject, i) : null), name: t.name || t.key } : null;
    }).catch(function () { return null; });
  }
  function contact(i, kind) {
    var c = getS('contacts', i.id) || {}, d = i.driver || {};
    if (kind === 'fleet_manager') { var m = (c.fleetManagers || [])[0] || {}; return { list: c.fleetManagers || [], type: 'fleet_manager' }; }
    if (kind === 'cargo_owner') return { list: c.cargoOwner ? [c.cargoOwner] : [], type: 'cargo_owner' };
    if (kind === 'driver') return { list: [Object.assign({}, c.driver || {}, { name: (c.driver && c.driver.name) || d.name, phone: (c.driver && c.driver.phone) || d.phone })], type: 'driver' };
    return { list: [], type: kind };
  }
  function callLink(p) { return p ? '<a class="nx-btn nx-btn--sm" href="tel:' + esc(p) + '">Call ' + esc(p) + '</a>' : ''; }
  function footer(m, label, onSend, kind) {
    return [NX.el('span.sim-note', { html: Sim.line(kind || 'message') }), NX.el('button.nx-btn.nx-btn--ghost', { onclick: function () { m.close(); } }, 'Cancel'), NX.el('button.nx-btn.nx-btn--primary', { onclick: function (e) { e.currentTarget.classList.add('is-loading'); onSend(e.currentTarget); } }, label)];
  }

  function notifyModal(kind, title, label, prefer) {
    var simKind = kind === 'driver' ? 'eta' : 'message';
    var i = inc(); if (!i) return;
    var c = contact(i, kind), ta = NX.el('textarea.nx-textarea', { rows: 6 }), chan = NX.el('select.nx-select', {}, ['sms', 'email', 'call', 'push'].map(function (x) { return NX.el('option', { value: x }, x.toUpperCase()); }));
    var who = NX.el('select.nx-select', {}, c.list.length ? c.list.map(function (p, k) { return NX.el('option', { value: k }, (p.name || 'Contact') + (p.role ? ' (' + p.role + ')' : '') + (p.phone ? ' ' + p.phone : '')); }) : [NX.el('option', { value: -1 }, 'No contact on file')]);
    ta.value = fallbackMsg(kind, i);
    var tplKey;
    getTemplate(kind, i, prefer).then(function (t) { if (t && !ta.dataset.edited) { ta.value = t.text; tplKey = t.name; } });
    ta.addEventListener('input', function () { ta.dataset.edited = 1; });
    var m = NX.modal(title, NX.el('div.nx-stack', NX.el('div.two', NX.el('div', NX.el('label.nx-label', 'Recipient'), who), NX.el('div', NX.el('label.nx-label', 'Channel'), chan)), NX.el('label.nx-label', 'Message (editable template)'), ta), {
      footer: footer(null, label, function () {}, simKind)
    });
    // footer cancel needs the modal handle
    m.el.querySelector('.nx-modal__foot').replaceChildren.apply(m.el.querySelector('.nx-modal__foot'), footer(m, label, function (btn) {
      var p = c.list[+who.value] || {};
      send(i, { channel: chan.value, to: { type: c.type, id: p.id, name: p.name, phone: p.phone, email: p.email }, message: ta.value, template: ta.dataset.edited ? undefined : tplKey, actor: 'dispatcher' }, btn, simKind).then(function (ok) { if (ok) m.close(); else btn.classList.remove('is-loading'); });
    }, simKind));
    setTimeout(function () { ta.focus(); }, 50);
  }
  function send(i, body, btn, simKind) {
    return api('/api/incidents/' + encodeURIComponent(i.id) + '/notify', { method: 'POST', body: body }).then(function (r) {
      var who = esc(body.to.name || fmt.label(body.to.type));
      NX.toast(Sim.toast(body.to.type === 'authority' ? 'Call outcome logged for ' + who : (body.channel === 'call' ? 'Call logged with ' : String(body.channel).toUpperCase() + ' recorded for ') + who, simKind || (body.to.type === 'authority' ? 'authority' : 'message')), 'success', 7000);
      afterAction(i.id); refreshIncident(i.id); return true;
    }).catch(function (e) { NX.toast(e.message, 'error'); return false; });
  }
  function refreshIncident(id) { api('/api/incidents/' + encodeURIComponent(id)).then(function (f) { if (f && f.id) D.upsert(f); }).catch(function () {}); }

  /* ---------- validate ---------- */
  function validate() {
    var i = inc(); if (!i) return; var c = i.camera, v = c && c.aiVerdict, conf = c && c.confidence != null ? Math.round((c.confidence <= 1 ? c.confidence * 100 : c.confidence)) : null, m;
    var dt = (i.diagnostics && i.diagnostics.dtcs || []).length;
    var body = NX.el('div.nx-stack', NX.el('div.verif.' + (v === 'false_positive' ? 'warn' : 'ok'), NX.el('b', c && v && v !== 'no_video' ? 'Camera AI: ' + fmt.label(v) + (conf != null ? ' (' + conf + '%)' : '') : 'No camera evidence'), NX.el('span', (c && c.signals || []).slice(0, 4).join(' / ') || 'Validate on telematics data and a call to the driver.')), dt ? NX.el('p.nx-dim', dt + ' active trouble code' + (dt > 1 ? 's' : '') + ' attached.') : null, NX.el('p.nx-dim', 'Confirm this is a real event to move it to Validating and tick the SOP step.'));
    var go = function (real) {
      var step = stepFor(i, 'validate');
      m.close();
      if (!real) return D.dismiss('False positive - validated by dispatcher' + (v ? ' (' + fmt.label(v) + ')' : ''));
      D.act('validate', '/status', { status: 'validating', note: 'Validated by dispatcher: event confirmed real' + (v ? ' (' + fmt.label(v) + (conf != null ? ' ' + conf + '%' : '') + ')' : '') }, 'Event validated').then(function () { if (step && !step.done) api('/api/incidents/' + encodeURIComponent(i.id) + '/sop/' + encodeURIComponent(step.key), { method: 'POST', body: { done: true, actor: 'dispatcher' } }).then(function () { refreshSop(i.id); }).catch(function () {}); afterAction(i.id); });
    };
    m = NX.modal('Validate event', body, { footer: [NX.el('button.nx-btn.nx-btn--danger', { onclick: function () { go(false); } }, 'False positive'), NX.el('button.nx-btn.nx-btn--primary', { onclick: function () { go(true); } }, 'Confirm real event')] });
  }

  /* ---------- authorities ---------- */
  function authorities() {
    var i = inc(); if (!i) return; var box = NX.el('div.nx-stack', NX.skeleton(4)), m = NX.modal('Call authorities', box, { wide: true });
    var c = getS('contacts', i.id) || {};
    api('/api/incidents/' + encodeURIComponent(i.id) + '/authority-brief').then(function (b) { return b; }).catch(function () { return null; }).then(function (b) {
      b = b || {}; var auths = (c.authorities || []).slice(), recs = {};
      (b.recommended || []).forEach(function (r) { recs[String(r.agency).toLowerCase()] = r; });
      auths.forEach(function (a) { var r = recs[String(a.agency).toLowerCase()]; if (r) { a.recommended = true; a.reason = a.reason || r.reason; a._urg = r.urgency; } });
      auths.sort(function (a, b2) { return (b2.recommended ? 1 : 0) - (a.recommended ? 1 : 0); });
      var loc = b.location || i.location || {}, script = b.script || ('This is Nexus Response dispatch reporting a ' + fmt.label(i.eventType).toLowerCase() + ' at ' + (loc.address || 'unknown location') + (loc.road ? ' on ' + loc.road : '') + '. Vehicle: ' + [i.vehicle && i.vehicle.year, i.vehicle && i.vehicle.make, i.vehicle && i.vehicle.model].filter(Boolean).join(' ') + (i.equipment && i.equipment.trailer && i.equipment.trailer.type !== 'none' ? ' with ' + fmt.label(i.equipment.trailer.type) + ' trailer' : '') + '. Injuries unknown. Driver: ' + ((i.driver || {}).name || 'unknown') + '.');
      var scriptEl = NX.el('textarea.nx-textarea', { rows: 6, readonly: true }); scriptEl.value = script;
      var outcome = NX.el('select.nx-select', {}, [['reached', 'Reached, units dispatched'], ['reached_no_units', 'Reached, no units needed'], ['no_answer', 'No answer, retry'], ['already_on_scene', 'Already on scene']].map(function (o) { return NX.el('option', { value: o[0] }, o[1]); }));
      var agency = NX.el('select.nx-select', {}, auths.length ? auths.map(function (a, k) { return NX.el('option', { value: k }, a.agency + (a.recommended ? ' (recommended)' : '')); }) : [NX.el('option', { value: -1 }, 'Other agency')]);
      var note = NX.el('input.nx-input', { placeholder: 'Notes: unit numbers, incident #, officer name' });
      var agHTML = auths.map(function (a) { return '<div class="agency' + (a.recommended ? ' is-rec' : '') + '"><div class="nx-grow"><b>' + esc(a.agency) + '</b>' + (a.recommended ? ' <span class="tag acc">Recommended' + (a._urg ? ': ' + esc(a._urg) : '') + '</span>' : '') + '<div class="nx-dim" style="font-size:12px">' + esc(fmt.label(a.kind || '')) + (a.jurisdiction ? ' &middot; ' + esc(a.jurisdiction) : '') + (a.reason ? ' &mdash; ' + esc(a.reason) : '') + '</div></div>' + callLink(a.phone) + '</div>'; }).join('') || '<p class="nx-dim">No agency directory for this location.</p>';
      var facts = (b.facts || []).length ? '<ul class="why">' + b.facts.map(function (f) { return '<li>' + esc(f) + '</li>'; }).join('') + '</ul>' : '';
      var needs = b.needsAuthorities === false ? '<div class="verif warn"><b>Authorities likely not needed</b><span>No injury or road-blocking indicators. Call only if the driver reports otherwise.</span></div>' : b.needsAuthorities ? '<div class="verif ok" style="--c:var(--nx-danger)"><b style="color:var(--nx-danger)">Call now</b><span>' + esc((b.recommended || []).map(function (r) { return r.agency; }).join(', ') || 'Collision or hazmat indicators present') + '</span></div>' : '';
      var rc = b.recovery || null, recHTML = '';
      if (rc) {
        var cls = rc.assigned && !rc.capable ? 'warn' : 'ok';
        var provLine = rc.assigned ? '<b>' + esc(rc.provider.name) + '</b> is en route' + (rc.provider.etaMin ? ', ETA ' + Math.round(rc.provider.etaMin) + ' min' : '') + '. Dispatched at the <b>owner\'s request</b> (' + esc(rc.owner || 'fleet') + ').' : 'No tow provider assigned yet. Owner: ' + esc(rc.owner || 'fleet') + '.';
        var riscLine = rc.riscRequired ? (rc.riscQualified ? '<br><b>' + esc(rc.clearance.program) + ' check passed:</b> provider is qualified for this ' + esc(rc.clearance.state) + ' interstate (target ' + rc.clearance.targetMin + ' min).' : '<br><b style="color:var(--nx-danger)">Not ' + esc(rc.clearance.program) + '-qualified.</b> ' + esc(rc.clearance.state) + ' interstate scene needs a qualified vendor. Send one.') : '';
        var hzLine = !rc.hazmatRequired ? '' : !rc.assigned ? '<br>Hazmat load: assign a hazmat-certified provider.' : rc.hazmatCertified ? '<br><b>Hazmat check passed:</b> provider is hazmat-certified.' : '<br><b style="color:var(--nx-danger)">Not hazmat-certified.</b> Provider has been told hazmat is required. Request a hazmat response team.';
        recHTML = '<div class="verif ' + cls + '"><b>Recovery</b><span>' + provLine + hzLine + riscLine + '</span></div>';
        if (rc.hazmatRequired && (rc.hazmatTeams || []).length) recHTML += '<div class="nx-eyebrow" style="margin:10px 0 6px">Hazmat response teams (private)</div>' + rc.hazmatTeams.map(function (t, n) { return '<div class="agency' + (n === 0 ? ' is-rec' : '') + '"><div class="nx-grow"><b>' + esc(t.name) + '</b>' + (n === 0 ? ' <span class="tag acc">Nearest</span>' : '') + '<div class="nx-dim" style="font-size:12px">' + esc(t.city + ', ' + t.st) + ' &middot; ' + t.distanceMi + ' mi &middot; ETA ~' + Math.round(t.etaMin) + ' min &middot; ' + esc((t.capabilities || []).map(function (x) { return x.replace(/_/g, ' '); }).join(', ')) + '</div></div>' + callLink(t.phone) + '</div>'; }).join('');
      }
      box.replaceChildren(NX.el('div', { html: needs + recHTML }), NX.el('div.two', NX.el('div', NX.el('div.nx-eyebrow', { style: { marginBottom: '6px' } }, 'Agencies'), NX.el('div', { html: agHTML }), NX.el('div', { html: facts })), NX.el('div', NX.el('div.nx-eyebrow', { style: { marginBottom: '6px' } }, 'What to say'), scriptEl, NX.el('button.nx-btn.nx-btn--sm', { style: { marginTop: '6px' }, onclick: function () { copy(scriptEl.value); } }, 'Copy script'))),
        NX.el('div.nx-eyebrow', { style: { marginTop: '4px' } }, 'Log call outcome (no call is placed from here)'), NX.el('div.two', NX.el('div', agency), NX.el('div', outcome)), note);
      var foot = m.el.querySelector('.nx-modal__body'); var f = NX.el('div.nx-modal__foot'); f.append.apply(f, footer(m, 'Log outcome', function (btn) {
        var a = auths[+agency.value] || { agency: 'Other agency' };
        send(i, { channel: 'call', to: { type: 'authority', name: a.agency, phone: a.phone }, message: 'Authority call (' + a.agency + '): ' + outcome.options[outcome.selectedIndex].text + (note.value ? '. ' + note.value : ''), template: 'authority', actor: 'dispatcher' }, btn, 'authority').then(function (ok) { if (ok) m.close(); else btn.classList.remove('is-loading'); });
      }, 'authority')); foot.parentNode.appendChild(f);
    });
  }

  /* ---------- FNOL ---------- */
  function fnol() {
    var i = inc(); if (!i) return; var c = (getS('contacts', i.id) || {}).insurer || {}, m;
    var done = getS('fnol', i.id);
    var attach = ['Camera clips and snapshots', 'GPS trail and trip context', 'Load and cargo estimate', 'Trouble codes and vehicle VIN', 'Event timeline'];
    var body = NX.el('div.nx-stack', NX.el('dl.nx-kv', { html: '<dt>Carrier</dt><dd>' + esc(c.carrier || 'Fleet carrier of record') + '</dd><dt>Policy</dt><dd class="nx-mono">' + esc(c.policyNo || '--') + '</dd><dt>FNOL line</dt><dd class="nx-mono">' + esc(c.fnolLine || '--') + '</dd>' }), NX.el('div.nx-eyebrow', 'Attached automatically'), NX.el('ul.why', { html: attach.map(function (x) { return '<li>' + x + '</li>'; }).join('') }), done ? NX.el('div.verif.ok', NX.el('b', 'FNOL already recorded'), NX.el('span', done.claimRef), NX.el('div', { html: Sim.note('fnol') })) : null);
    m = NX.modal('First notice of loss (FNOL)', body, { footer: [NX.el('span.sim-note', { html: Sim.line('fnol') }), NX.el('button.nx-btn.nx-btn--ghost', { onclick: function () { m.close(); } }, 'Cancel'), NX.el('button.nx-btn.nx-btn--primary', { onclick: function (e) { e.currentTarget.classList.add('is-loading'); api('/api/incidents/' + encodeURIComponent(i.id) + '/fnol', { method: 'POST', body: { actor: 'dispatcher' } }).then(function (r) { setS('fnol', i.id, r); m.close(); NX.toast(Sim.toast('FNOL recorded: <b class="nx-mono">' + esc(r.claimRef || '') + '</b> for ' + esc(r.carrier || 'carrier'), 'fnol'), 'success', 8000); afterAction(i.id); refreshIncident(i.id); D.renderDetail(); }).catch(function (er) { e.target.classList.remove('is-loading'); NX.toast(er.message, 'error'); }); } }, done ? 'File again' : 'Send FNOL')] });
  }

  /* ---------- OEM claim ---------- */
  function submitOem() {
    var i = inc(); if (!i || !i.warranty) return; S.busy.x_oem = true; D.renderDetail();
    api('/api/incidents/' + encodeURIComponent(i.id) + '/warranty/submit', { method: 'POST', body: { actor: 'dispatcher' } }).then(function (r) {
      r = r || {}; if (r.id && r.warranty) { D.upsert(r); r = { confirmation: r.warranty.claimId }; } setS('oemSub', i.id, r); S.coll.oemclaim = 0;
      NX.toast(Sim.toast('OEM claim recorded: <b class="nx-mono">' + esc(r.confirmation || r.claimId || '') + '</b>', 'claim'), 'success', 8000);
      afterAction(i.id); refreshIncident(i.id);
    }).catch(function (e) { NX.toast(e.status === 409 ? 'No claim to submit for this incident' : e.message, 'error'); }).then(function () { delete S.busy.x_oem; D.renderDetail(); });
  }
  function claimStage(p) {
    var s = p && p.status; if (!s) return -1;
    if (s === 'paid') return OEM_STEPS.length; // final step complete
    if (DECISIONS[s]) return 4; var k = OEM_STEPS.indexOf(s); return k;
  }
  function oemHTML(i, panel) {
    var w = i.warranty, pk = w && w.claimPacket, sub = getS('oemSub', i.id), cts = getS('contacts', i.id) || {}, oem = cts.oem || {}, wd = i.warrantyDealer;
    if (!w || (!pk && !w.claimEligible)) return '';
    var status = (pk && pk.status) || 'draft', stage = claimStage(pk), dec = DECISIONS[status] ? status : null;
    var steps = OEM_STEPS.map(function (s, k) {
      var lbl = s === 'decision' ? (dec ? fmt.label(dec) : 'Decision') : fmt.label(s), cls = k < stage ? 'done' : k === stage ? 'cur' : '', tone = s === 'decision' && dec ? ' ' + DECISIONS[dec] : '';
      return '<li class="' + cls + tone + '"><i></i><span>' + esc(lbl) + '</span></li>';
    }).join('');
    var conf = (sub && sub.confirmation) || (pk && pk.confirmation) || w.claimId, evid = (pk && pk.evidence) || [];
    var appt = (w && w.appointment) || (wd && wd.appointment) || (pk && pk.appointment);
    var submitted = stage >= 2, canSubmit = stage < 2;
    var body = '<ol class="stepper">' + steps + '</ol>' +
      (status === 'more_info_needed' ? '<div class="verif warn" style="margin:10px 0"><b>OEM needs more information</b><span>' + esc((pk && pk.oemNote) || 'Attach the requested documents and resubmit.') + '</span></div>' : '') +
      (status === 'denied' ? '<div class="verif warn" style="--c:var(--nx-danger);margin:10px 0"><b>Claim denied</b><span>' + esc((pk && pk.oemNote) || 'Review the denial reason with the fleet.') + '</span></div>' : '') +
      '<dl class="nx-kv" style="margin-top:12px"><dt>Claim #</dt><dd class="nx-mono">' + esc(w.claimId || '--') + '</dd><dt>Confirmation</dt><dd class="nx-mono">' + (submitted && conf ? esc(conf) + ' ' + Sim.pill() : '<span class="nx-faint">not yet submitted</span>') + '</dd>' +
      '<dt>Pre-auth #</dt><dd class="nx-mono">' + esc((wd && wd.preAuthNumber) || (pk && pk.preAuthNumber) || '--') + '</dd><dt>OEM / coverage</dt><dd>' + esc(w.oem || oem.name || '--') + ' &middot; ' + esc(fmt.label(w.coverage || '')) + '</dd>' +
      '<dt>OEM warranty desk</dt><dd>' + esc(oem.name || w.oem || '--') + (oem.warrantyDesk ? ' &middot; <a href="tel:' + esc(oem.warrantyDesk) + '">' + esc(oem.warrantyDesk) + '</a>' : '') + '</dd>' + (oem.portal ? '<dt>Portal</dt><dd>' + esc(oem.portal) + '</dd>' : '') +
      (pk && pk.estimatedValueUsd != null ? '<dt>Est. value</dt><dd class="nx-mono">' + fmt.currency(pk.estimatedValueUsd) + '</dd>' : '') +
      (wd && wd.nearest ? '<dt>Dealer</dt><dd>' + esc(wd.nearest.name) + (wd.nearest.phone ? ' &middot; <a href="tel:' + esc(wd.nearest.phone) + '">' + esc(wd.nearest.phone) + '</a>' : '') + '</dd>' : '') +
      (appt ? '<dt>Appointment</dt><dd>' + esc(typeof appt === 'string' ? appt : [appt.when && fmt.dateTime(appt.when), appt.dealer || appt.location, appt.note].filter(Boolean).join(' &middot; ')) + '</dd>' : (wd && wd.nearest ? '<dt>Appointment</dt><dd class="nx-faint">none booked (call dealer)</dd>' : '')) + '</dl>' +
      (evid.length ? '<div class="nx-eyebrow" style="margin:12px 0 6px">Attached evidence (' + evid.length + ')</div><ul class="evid">' + evid.map(function (e) { return '<li>' + esc(e) + '</li>'; }).join('') + '</ul>' : '') +
      '<div class="pro-actions" style="margin-top:12px">' + (canSubmit ? '<button class="nx-btn nx-btn--primary' + (S.busy.x_oem ? ' is-loading' : '') + '" data-xact="oem">Submit OEM claim <kbd>o</kbd></button>' : '<button class="nx-btn" disabled>Submitted</button>') + Sim.note('claim') +
      '<div class="two"><a class="nx-btn" target="_blank" rel="noopener" href="/api/incidents/' + encodeURIComponent(i.id) + '/warranty-packet?format=html">Open claim packet</a>' +
      (submitted && !['paid', 'denied'].includes(status) ? '<select class="nx-select" data-oemsim title="Demo control: simulate the OEM warranty desk replying" aria-label="Simulate an OEM response"><option value="">Simulate OEM response (demo)</option><option value="under_review">Under review</option><option value="approved">Approved</option><option value="more_info_needed">More info needed</option><option value="denied">Denied</option><option value="paid">Paid</option></select>' : '<span></span>') + '</div></div>' +
      (submitted ? '<p class="nx-faint" style="font-size:12px;margin-top:8px">Status refreshes every few seconds. OEM replies shown here are simulated.</p>' : '');
    return panel('OEM claim', NX.badgeHTML(fmt.label(status), submitted ? (dec ? DECISIONS[dec] : 'info') : 'warn'), body, 'oemclaim');
  }
  function simOem(outcome) {
    var i = inc(); if (!i || !outcome) return;
    var url = '/api/incidents/' + encodeURIComponent(i.id) + '/warranty/status';
    function ok() { NX.toast(Sim.toast('Simulated OEM reply: ' + fmt.label(outcome), 'claim'), 'info', 6000); refreshIncident(i.id); afterAction(i.id); }
    // documented endpoint: POST .../warranty/status {status}. An illegal jump (409) retries as a simulated next step toward the outcome.
    api(url, { method: 'POST', body: { status: outcome, actor: 'oem' } }).then(ok).catch(function (e) {
      if (e.status === 409 || e.status === 400 || e.status === 422) return api(url, { method: 'POST', body: { simulate: true, outcome: outcome, actor: 'oem' } }).then(ok).catch(function (e2) { NX.toast(e2.message || e.message, 'warn'); });
      NX.toast(e.message, 'error');
    });
  }
  var oemPoll;
  function pollClaim() {
    clearInterval(oemPoll);
    oemPoll = setInterval(function () { var i = inc(); if (!i || !i.warranty || !i.warranty.claimPacket) return; if (['submitted', 'under_review'].indexOf(i.warranty.claimPacket.status) > -1) refreshIncident(i.id); }, 6000);
  }

  /* ---------- coordination: contacts + comms ---------- */
  function coordHTML(i, panel) {
    var tab = S.coordTab || 'contacts', c = getS('contacts', i.id), cm = getS('comms', i.id);
    var tabs = '<div class="cam-tabs"><button class="nx-chip' + (tab === 'contacts' ? ' is-active' : '') + '" data-ctab="contacts">Contacts</button><button class="nx-chip' + (tab === 'comms' ? ' is-active' : '') + '" data-ctab="comms">Comms log' + (cm && cm.length ? ' (' + cm.length + ')' : '') + '</button></div>';
    var body;
    if (tab === 'comms') body = cm === undefined ? NX.skeleton(2).outerHTML : !cm || !cm.length ? '<p class="nx-dim">Nothing sent yet for this incident. Messages from the action strip are logged here.</p>' + Sim.note('message') :
      '<ul class="comms">' + cm.slice().reverse().map(function (x) { var to = x.to || {}; return '<li><div class="nx-row" style="gap:8px"><span class="tag acc">' + esc((x.channel || '').toUpperCase()) + '</span><b class="nx-grow">' + esc(to.name || fmt.label(to.type || '')) + '</b><span class="nx-mono nx-faint" style="font-size:12px">' + esc(x.at ? fmt.time(x.at) : '') + '</span></div>' + (x.subject ? '<div style="font-weight:500;margin-top:4px">' + esc(x.subject) + '</div>' : '') + '<div class="nx-dim" style="font-size:12.5px;margin-top:3px;white-space:pre-wrap">' + esc(x.body || x.message || '') + '</div><div class="comm-sim">' + Sim.line('message') + '<span class="nx-faint nx-mono"> &middot; by ' + esc(x.actor || 'dispatcher') + '</span></div></li>'; }).join('') + '</ul>';
    else if (c === undefined) body = NX.skeleton(3).outerHTML;
    else if (!c) body = '<p class="nx-dim">Contact directory unavailable for this incident.</p>';
    else {
      var row = function (name, sub, phone, email) { return '<div class="ct"><div class="nx-grow"><b>' + esc(name || '--') + '</b><div class="nx-dim" style="font-size:12px">' + esc(sub || '') + '</div></div>' + (phone ? '<a class="nx-btn nx-btn--sm" href="tel:' + esc(phone) + '">' + esc(phone) + '</a>' : '') + (email ? '<a class="nx-btn nx-btn--sm nx-btn--ghost" href="mailto:' + esc(email) + '">Email</a>' : '') + '</div>'; };
      var sec = function (t, h) { return h ? '<div class="nx-eyebrow" style="margin:12px 0 4px">' + t + '</div>' + h : ''; };
      body = sec('Driver', c.driver ? row(c.driver.name || (i.driver || {}).name, c.driver.role || 'Driver', c.driver.phone || (i.driver || {}).phone, c.driver.email) : '') +
        sec('Fleet managers', (c.fleetManagers || []).map(function (p) { return row(p.name, p.role, p.phone, p.email); }).join('')) +
        sec('Tow providers', (c.towProviders || []).map(function (p) { return row(p.name, (p.etaMin != null ? 'ETA ' + Math.round(p.etaMin) + ' min' : '') + (p.rating ? ' &middot; ' + p.rating + ' stars' : ''), p.phone); }).join('')) +
        sec('Authorities', (c.authorities || []).map(function (p) { return row(p.agency + (p.recommended ? ' (recommended)' : ''), (fmt.label(p.kind || '') + ' ' + (p.jurisdiction || '')).trim(), p.phone); }).join('')) +
        sec('Insurer', c.insurer ? row(c.insurer.carrier, 'Policy ' + (c.insurer.policyNo || '--') + ' &middot; FNOL line', c.insurer.fnolLine) : '') +
        sec('OEM warranty', c.oem ? row(c.oem.name, c.oem.portal ? 'Portal: ' + c.oem.portal : 'Warranty desk', c.oem.warrantyDesk) : '') +
        sec('Cargo owner', c.cargoOwner ? row(c.cargoOwner.name, 'Cargo owner', c.cargoOwner.phone) : '');
    }
    return panel('Contacts &amp; comms log', '', tabs + body, 'coord');
  }

  /* ---------- shift bar ---------- */
  var HK = 'nx-dispatch-handoff';
  function notesGet() { try { return JSON.parse(localStorage.getItem(HK) || '[]'); } catch (e) { return S._hn || []; } }
  function notesSet(a) { S._hn = a; try { localStorage.setItem(HK, JSON.stringify(a.slice(-30))); } catch (e) {} }
  function minutes(a, b) { return (new Date(b) - new Date(a)) / 60000; }
  function firstAt(i, re) { var t = (i.timeline || []).find(function (e) { return re.test((e.action || '') + ' ' + (e.note || '')) && e.actor !== 'system'; }); return t && t.t; }
  function avg(a) { return a.length ? a.reduce(function (x, y) { return x + y; }, 0) / a.length : null; }
  var dur = function (m) { return m == null ? '--' : m < 1 ? Math.round(m * 60) + 's' : m < 60 ? m.toFixed(m < 10 ? 1 : 0) + 'm' : Math.floor(m / 60) + 'h' + Math.round(m % 60) + 'm'; };
  function shift() {
    var bar = $('#shift-bar'); if (!bar) return;
    var open = [], ttv = [], ttd = [], unack = [], day = Date.now() - 24 * 3600000, resolved = 0;
    S.inc.forEach(function (i) {
      var t0 = i.receivedAt || i.timestamp; if (i.source === 'historical_import') return;
      if (['resolved', 'dismissed'].indexOf(i.status) < 0) { open.push(i); if (i.severity === 'critical' && (i.status === 'pending' || i.status === 'validating')) unack.push(i); } else if (new Date(i.resolvedAt || i.timestamp) > day) resolved++;
      if (new Date(t0) > day) {
        var v = firstAt(i, /valid|confirmed real/i), d = firstAt(i, /dispatch/i);
        if (v) ttv.push(minutes(t0, v)); if (d) ttd.push(minutes(t0, d));
      }
    });
    var oldest = unack.sort(function (a, b) { return new Date(a.receivedAt || a.timestamp) - new Date(b.receivedAt || b.timestamp); })[0];
    var age = oldest ? minutes(oldest.receivedAt || oldest.timestamp, Date.now()) : null, breach = age != null && age > 5;
    var notes = notesGet(), last = notes[notes.length - 1], L = !!S.loaded, N = function (v) { return L ? v : '\u2014'; };
    var t = S.totals;
    var openN = t ? t.open : open.length;
    var unassignedN = t && t.byStatus ? (t.byStatus.pending || 0) : open.filter(function (i) { return i.status === 'pending'; }).length;
    var critN = t && t.openCriticalUnacked != null ? t.openCriticalUnacked : unack.length;
    var closedN = t && t.closedLast24h != null ? t.closedLast24h : resolved;
    if (!L) { oldest = null; unack = []; }
    bar.innerHTML = '<span class="sb-i" title="Open incidents in this scope, from the server total"><b>' + N(openN) + '</b> open</span><span class="sb-i"><b>' + N(unassignedN) + '</b> unassigned</span><span class="sb-i" title="Resolved or dismissed in the last 24 hours"><b>' + N(closedN) + '</b> closed 24h</span>' +
      '<span class="sb-i' + (critN ? ' is-bad' : '') + '" title="Critical incidents still pending or validating"><b>' + N(critN) + '</b> critical unacked' + (oldest && !t ? ' <em class="' + (breach ? 'late' : '') + '">oldest ' + dur(age) + '</em>' : '') + '</span>' +
      '<span class="sb-sep"></span><span class="sb-i" title="Average time from receipt to validation, using incidents loaded in this queue">Validate <b>' + (L ? dur(avg(ttv)) : '\u2014') + '</b><small>SLA 2m</small></span><span class="sb-i" title="Average time from receipt to dispatch, using incidents loaded in this queue">Dispatch <b>' + (L ? dur(avg(ttd)) : '\u2014') + '</b><small>SLA 5m</small></span>' +
      '<span class="nx-grow"></span><button class="nx-btn nx-btn--sm" id="sb-handoff" title="Shift handoff notes (H)">Handoff' + (notes.length ? ' (' + notes.length + ')' : '') + (last ? '' : '') + '</button>';
  }
  function handoff() {
    var notes = notesGet(), ta = NX.el('textarea.nx-textarea', { placeholder: 'What should the next dispatcher know? Open incidents, promised callbacks, watch items.', rows: 4 }), m;
    var listEl = NX.el('div.nx-stack', notes.slice().reverse().map(function (n) { return NX.el('div.hn', NX.el('div.nx-faint.nx-mono', { style: { fontSize: '11px' } }, fmt.dateTime(n.t)), NX.el('div', n.text)); }));
    var open = []; S.inc.forEach(function (i) { if (['resolved', 'dismissed'].indexOf(i.status) < 0 && i.source !== 'historical_import') open.push(i); });
    var openN = S.totals && S.totals.open != null ? S.totals.open : open.length;
    var listed = open.slice(0, 5).map(function (i) { return i.id + ' ' + fmt.label(i.eventType) + ' (' + i.status + ')'; }).join('; ');
    var sum = NX.el('div.verif.warn', NX.el('b', openN + ' open incidents to hand over'), NX.el('span', listed || (openN ? 'Open the Open queue to list them. The count is the full queue.' : 'None')));
    m = NX.modal('Shift handoff', NX.el('div.nx-stack', sum, ta, notes.length ? NX.el('div.nx-eyebrow', 'Previous notes') : null, listEl), { footer: [NX.el('span.sim-note.nx-faint', 'Saved on this device only'), NX.el('button.nx-btn.nx-btn--ghost', { onclick: function () { m.close(); } }, 'Close'), NX.el('button.nx-btn.nx-btn--primary', { onclick: function () { if (!ta.value.trim()) return ta.focus(); var a = notesGet(); a.push({ t: new Date().toISOString(), text: ta.value.trim() }); notesSet(a); m.close(); shift(); NX.toast('Handoff note saved', 'success'); } }, 'Save note')] });
    setTimeout(function () { ta.focus(); }, 40);
  }

  /* ---------- dispatch job link ---------- */
  function jobLinkHTML(i) {
    var j = getS('jobLink', i.id) || i.jobLink || (i.roadside && i.roadside.jobLink); if (!j) return '';
    var url = (j.url || '').indexOf('http') === 0 ? j.url : location.origin + (j.url || '/job/' + j.token);
    return '<div class="verif ok" style="margin-top:10px"><b>Job ticket link created</b><span class="nx-mono" style="word-break:break-all">' + esc(url) + '</span><span style="display:flex;gap:6px;margin-top:4px"><button class="nx-btn nx-btn--sm" data-copy="' + esc(url) + '">Copy</button><a class="nx-btn nx-btn--sm" target="_blank" rel="noopener" href="' + esc(url) + '">Open ticket</a></span>' + Sim.note('tow') + '</div>';
  }

  /* ---------- dispatch actions ---------- */
  function run(kind) {
    var i = inc(); if (!i) return;
    switch (kind) {
      case 'validate': return validate();
      case 'dispatch': D.dispatch(); return;
      case 'fleet': return notifyModal('fleet_manager', 'Notify fleet manager', 'Send message');
      case 'authority': return authorities();
      case 'fnol': return fnol();
      case 'oem': return submitOem();
      case 'cargo': return notifyModal('cargo_owner', 'Notify cargo owner', 'Send message');
      case 'eta': return notifyModal('driver', 'Share ETA with driver', 'Send ETA', /eta/i);
    }
  }
  function onClick(e) {
    var x = e.target.closest('[data-xact]'); if (x) { if (!x.disabled) run(x.dataset.xact); return true; }
    var s = e.target.closest('[data-sopstep]'); if (s) { toggleStep(s.dataset.sopstep); return true; }
    var j = e.target.closest('[data-sopjump]'); if (j) { S.coll.sop = 0; D.renderDetail(); var p = document.querySelector('[data-key=sop]'); if (p) p.scrollIntoView({ block: 'start' }); return true; }
    if (window.NXAudit && NXAudit.onClick(e)) { D.renderDetail(); return true; }
    var t = e.target.closest('[data-ctab]'); if (t) { S.coordTab = t.dataset.ctab; D.renderDetail(); return true; }
    var cp = e.target.closest('[data-copy]'); if (cp) { copy(cp.dataset.copy); return true; }
    return false;
  }
  function onChange(e) { var s = e.target.closest('[data-oemsim]'); if (s && s.value) { simOem(s.value); s.value = ''; } }
  function key(k) {
    var map = { v: 'validate', f: 'fleet', p: 'authority', i: 'fnol', o: 'oem', g: 'cargo', e: 'eta' };
    if (map[k]) { var b = document.querySelector('[data-xact="' + map[k] + '"]'); if (b && b.disabled) { NX.toast('Not available for this incident', 'warn', 1800); return true; } run(map[k]); return true; }
    if (k === 'H') { handoff(); return true; }
    if (k === 't') { S.coordTab = S.coordTab === 'comms' ? 'contacts' : 'comms'; S.coll.coord = 0; D.renderDetail(); return true; }
    return false;
  }
  function init(d) {
    D = d; S = d.S; S.coordTab = 'contacts';
    var main = document.querySelector('.nx-main'); var bar = NX.el('div#shift-bar.shift-bar'); main.insertBefore(bar, main.firstChild);
    bar.addEventListener('click', function (e) { if (e.target.closest('#sb-handoff')) handoff(); });
    $('#detail').addEventListener('click', function (e) { if (onClick(e)) e.stopPropagation(); }, true);
    $('#detail').addEventListener('change', onChange);
    shift(); setInterval(shift, 5000); pollClaim();
  }
  window.NXAct = { init: init, load: load, ring: ring, strip: strip, sop: sopPanel, oem: oemHTML, coord: coordHTML, jobLinkHTML: jobLinkHTML, urgent: urgentHTML, next: nextActions, comms: function (i) { return getS('comms', i.id) || []; }, key: key, shift: shift, afterAction: afterAction, setJob: function (id, j) { setS('jobLink', id, j); }, handoff: handoff };
})();
