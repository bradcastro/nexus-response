/* Tow job ticket (no login). Token comes from /job/<token>. Reads GET /api/jobs/:token, posts accept|decline|eta|arrived|complete. */
(function () {
  'use strict';
  var el = NX.el, fmt = NX.fmt, app = document.getElementById('app');
  NX.theme.defaultTo(window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  var token = (location.pathname.match(/\/job\/([^/?#]+)/) || [])[1] || location.hash.replace('#', '') || new URLSearchParams(location.search).get('t') || '';
  var KEY = 'nx-job-' + token, QKEY = KEY + '-q';
  var S = { job: null, raw: null, eta: 30, busy: false, offline: false, err: null, note: '', missing: false };

  function ls(k, v) { try { if (v === undefined) return JSON.parse(localStorage.getItem(k)); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) { return null; } }
  function pick(o) { for (var i = 1; i < arguments.length; i++) { var v = o; arguments[i].split('.').forEach(function (k) { v = v == null ? v : v[k]; }); if (v != null && v !== '') return v; } return null; }
  function num(n) { return n == null || isNaN(n) ? null : Number(n); }
  function lb(n) { return n >= 1000 ? Math.round(n / 1000) + 'k lb' : n + ' lb'; }
  function tel(p) { return 'tel:' + String(p).replace(/[^\d+]/g, ''); }
  function say(msg) { var t = el('div.jb-toast', msg); document.body.appendChild(t); setTimeout(function () { t.remove(); }, 3200); }

  /* ---------- normalise whatever shape the backend returns ---------- */
  function norm(r) {
    var j = r.job || r, inc = r.incident || j.incident || {};
    var loc = pick(j, 'location', 'incident.location') || inc.location || {};
    var veh = pick(j, 'vehicle', 'incident.vehicle') || inc.vehicle || {};
    var eq = pick(j, 'equipment') || inc.equipment || {};
    var ld = pick(j, 'load') || inc.load || {};
    var wd = pick(j, 'warrantyDealer') || inc.warrantyDealer || null;
    var drop = pick(j, 'dropoff', 'dropOff', 'destination', 'towDestination', 'roadside.towDestination') || (inc.roadside && inc.roadside.towDestination) || (wd && wd.nearest && { kind: 'oem_dealer', name: wd.nearest.name, address: wd.nearest.address, lat: wd.nearest.lat, lng: wd.nearest.lng, phone: wd.nearest.phone, hours: wd.nearest.hours }) || null;
    var contact = pick(j, 'contact', 'dispatcher', 'dispatch') || {};
    var out = {
      status: String(pick(j, 'status', 'jobStatus') || 'offered').toLowerCase(),
      id: pick(j, 'incidentId', 'id') || inc.id, service: pick(j, 'serviceType', 'service', 'roadside.serviceType') || (inc.roadside && inc.roadside.serviceType),
      eventType: pick(j, 'eventType') || inc.eventType, fleet: pick(j, 'fleetName', 'fleet.name') || inc.fleetName, loc: loc, veh: veh, eq: eq, ld: ld, drop: drop,
      contact: contact, notes: pick(j, 'notes', 'note', 'instructions'), eta: num(pick(j, 'etaMin', 'eta')), expiresAt: pick(j, 'expiresAt'), driver: pick(j, 'driver') || inc.driver || null,
      provider: pick(j, 'providerName', 'provider.name'), simulated: true, hazardsIn: j.hazards || null, tags: (inc.risk && inc.risk.tags) || j.tags || [], sev: pick(j, 'severity') || inc.severity,
      brief: j.briefing || null, tkTrailer: j.trailer || null, tkLoad: j.load || null, driverC: (j.contact && j.contact.driver) || null, equipmentNeeded: pick(j, 'equipmentNeeded', 'whatToBring', 'equipmentClass'), warranty: wd, dtcs: (inc.diagnostics && inc.diagnostics.dtcs) || j.dtcs || null, drivable: pick(j, 'drivable') || (inc.diagnostics && inc.diagnostics.drivable) || null
    };
    // server job status stays 'accepted' after an ETA post and uses 'arrived'; derive the stages this page shows
    if (out.status === 'arrived') out.status = 'on_scene';
    if (out.status === 'accepted' && (j.events || []).some(function (e) { return e.action === 'eta'; })) out.status = 'en_route';
    return out;
  }
  function hazards(j) {
    var h = [], seen = {};
    function add(t, crit) { if (t && !seen[t]) { seen[t] = 1; h.push({ t: t, crit: !!crit }); } }
    (j.hazardsIn || []).forEach(function (x) { var t = typeof x === 'string' ? x : (x.label || x.text || x.message || x.key); add(plain(t), /hazmat|spill|fuel|fire|critical/i.test(t)); });
    var tags = j.tags || [], c = j.ld && j.ld.contents || {};
    if (c.hazmat || tags.indexOf('hazmat_load') > -1) add('HAZMAT load' + (c.label ? ' (' + c.label + ')' : '') + '. Keep clear, do not smoke, and wait for a hazmat-trained crew if there is a spill.', true);
    if (c.temperatureSensitive || tags.indexOf('perishable_spoilage_clock') > -1) add('Perishable cargo' + (c.spoilageRiskHours ? '. Spoils in about ' + c.spoilageRiskHours + ' h' : '') + '. Keep the reefer running and move fast.');
    if (j.ld && j.ld.overweightRisk && j.ld.overweightRisk !== 'none' && j.ld.overweightRisk !== 'low' || tags.indexOf('overweight_risk') > -1) add('Load may be over weight. Plan for a heavier lift and axle limits.');
    if (tags.indexOf('shifting_load_risk') > -1) add('Load may have shifted. Check the cargo before you winch or lift.');
    if (tags.indexOf('high_value_cargo') > -1) add('High-value cargo. Do not leave the trailer unattended.');
    if (j.eventType === 'rollover' || /rollover/.test(j.service || '')) add('Rollover. Use a rotator or heavy recovery, and check for leaks first.', true);
    if (j.drivable === 'no') add('Truck cannot be driven. Tow only.');
    return h;
  }
  function plain(t) { return String(t || '').replace(/_/g, ' ').replace(/^./, function (c) { return c.toUpperCase(); }); }
  function equipment(j) {
    if (j.equipmentNeeded) return typeof j.equipmentNeeded === 'string' ? j.equipmentNeeded : (j.equipmentNeeded.label || j.equipmentNeeded.summary || JSON.stringify(j.equipmentNeeded));
    var t = j.eq.tractor || {}, tr = j.eq.trailer || {}, w = num(j.ld.estimatedWeightLb), cls = String(t.class || '');
    var heavy = /8|heavy/i.test(cls) || (w && w > 26000) || /tow_heavy/.test(j.service || '');
    var gross = num(j.ld.grossVehicleWeightLb);
    var parts = [heavy ? 'Heavy wrecker' : (/tow_light|light/.test(j.service || '') ? 'Light-duty tow' : 'Tow truck')];
    if (j.eventType === 'rollover' || (gross && gross > 70000)) parts[0] = 'Heavy wrecker or rotator';
    var what = [];
    if (tr.attached && tr.type && tr.type !== 'none') what.push(w ? '~' + lb(w) + ' ' + String(tr.type).replace(/_/g, ' ') : String(tr.type).replace(/_/g, ' '));
    else if (w) what.push('~' + lb(w) + ' load');
    if (gross) what.push('gross ~' + lb(gross));
    return parts[0] + (what.length ? ', ' + what.join(', ') : '');
  }
  function navUrl(lat, lng, q) {
    var dest = lat != null && lng != null ? lat + ',' + lng : encodeURIComponent(q || '');
    return /iPhone|iPad|Macintosh/.test(navigator.userAgent) && 'ontouchend' in document ? 'https://maps.apple.com/?daddr=' + dest : 'https://www.google.com/maps/dir/?api=1&destination=' + dest;
  }

  /* ---------- network ---------- */
  function load(quiet) {
    return fetch('/api/jobs/' + encodeURIComponent(token), { headers: { Accept: 'application/json' } }).then(function (r) {
      if (r.status === 404 || r.status === 410) { S.missing = r.status; S.job = null; setOffline(false); return render(); }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json().then(function (d) { S.missing = false; S.raw = d; S.job = norm(d); ls(KEY, d); if (S.job.eta && !S.touchedEta) S.eta = S.job.eta; setOffline(false); render(); });
    }).catch(function () {
      setOffline(true);
      if (!S.job) { var c = ls(KEY); if (c) { S.raw = c; S.job = norm(c); } }
      if (!quiet || !S.job) render(); else render();
    });
  }
  function setOffline(v) { S.offline = v; document.getElementById('net').hidden = !v; }
  function post(action, body) {
    return fetch('/api/jobs/' + encodeURIComponent(token) + '/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) { var e = new Error(d.message || d.error || 'HTTP ' + r.status); e.status = r.status; throw e; } return d; });
    });
  }
  var NEXT = { accept: 'accepted', decline: 'declined', eta: 'en_route', arrived: 'on_scene', complete: 'completed' };
  function act(action, body) {
    if (S.busy) return; S.busy = true; render();
    return post(action, body).then(function (d) { S.busy = false; S.touchedEta = false; return load(); }, function (e) {
      S.busy = false;
      if (e.status && e.status < 500 && e.status !== 408) { say(e.message); return load(); }
      // offline or server down: queue, show optimistic state, retry later
      var q = ls(QKEY) || []; q.push({ action: action, body: body || {}, at: Date.now() }); ls(QKEY, q);
      if (S.job) S.job.status = NEXT[action] || S.job.status; setOffline(true); say('No signal. Saved, will send when you are back online.'); render();
    });
  }
  function flush() {
    var q = ls(QKEY) || []; if (!q.length || !navigator.onLine) return;
    ls(QKEY, null);
    q.reduce(function (p, it) { return p.then(function () { return post(it.action, it.body).catch(function (e) { if (!e.status || e.status >= 500) { var r = ls(QKEY) || []; r.push(it); ls(QKEY, r); } }); }); }, Promise.resolve()).then(function () { return load(true); });
  }

  /* ---------- views ---------- */
  var STAGES = ['accepted', 'en_route', 'on_scene', 'completed'];
  function statusPill(s) {
    var m = { offered: ['New job', ''], pending: ['New job', ''], sent: ['New job', ''], dispatched: ['New job', ''], accepted: ['Accepted', 'is-ok'], en_route: ['En route', 'is-act'], on_scene: ['On scene', 'is-act'], completed: ['Complete', 'is-ok'], resolved: ['Complete', 'is-ok'], declined: ['Declined', 'is-bad'], cancelled: ['Cancelled', 'is-bad'], expired: ['Expired', 'is-bad'] };
    var x = m[s] || [plain(s), '']; return el('span', { class: 'jb-status ' + x[1] }, x[0]);
  }
  function stateView(title, text) { app.innerHTML = ''; app.appendChild(el('div.jb-state', el('h1', title), el('p', text), el('button.jb-btn.jb-btn--sm', { onclick: function () { load(); } }, 'Try again'))); }

  function render() {
    if (S.missing) { return stateView(S.missing === 410 ? 'This job link has expired' : 'Job not found', 'Check the link in your text message, or call the dispatcher who sent it. Links stop working after the job is closed.'); }
    var j = S.job;
    if (!j) { if (!token) return stateView('No job link', 'Open the link from your dispatch text message.'); return stateView('Cannot load the job', 'You may be out of signal. It will retry automatically.'); }
    var st = j.status, closed = /declined|cancelled|expired/.test(st), done = /completed|resolved/.test(st), fresh = /offered|pending|sent|dispatched|new/.test(st);
    app.innerHTML = '';
    var loc = j.loc || {}, addr = loc.address || (loc.lat != null ? loc.lat + ', ' + loc.lng : 'Location pending');
    var v = j.veh || {}, veh = [v.year, v.make, v.model].filter(Boolean).join(' ');

    // header card
    app.appendChild(el('div.jb-card', el('div.jb-top', statusPill(st), el('span.jb-id', j.id || ''), el('span.jb-id', { style: { marginLeft: 'auto' } }, j.fleet || '')),
      el('div.jb-title', j.service ? plain(String(j.service).replace('tow_', 'Tow ')) : 'Tow job'), el('div.jb-sub', plain(j.eventType || 'Breakdown') + (j.sev ? ' · ' + plain(j.sev) + ' priority' : ''))));

    var hz = hazards(j);
    if (hz.length && !closed) app.appendChild(el('div', { class: 'jb-hazard' + (hz.some(function (h) { return h.crit; }) ? ' is-crit' : ''), role: 'alert' }, el('b', 'Read before you roll'), el('ul', hz.map(function (h) { return el('li', h.t); }))));

    var B = j.brief;
    if (B && !closed) {
      app.appendChild(el('div.jb-card.jb-owner', el('h2', 'Requested by the owner'), el('div.jb-big', B.owner.name), el('p.jb-sub', B.owner.statement)));
      var rq = B.requirements || {}, lines = [];
      if (rq.hazmat) lines.push({ ok: rq.hazmatCertified, t: rq.hazmatCertified ? 'Hazmat load. Your company is on file as hazmat-certified.' : 'Hazmat load. Your company is NOT on file as hazmat-certified. Tell dispatch right away if you cannot handle it. A hazmat team is being arranged.' });
      if (rq.clearance) lines.push({ ok: rq.clearanceQualified, t: rq.clearance.program + ' scene (' + rq.clearance.state + ' interstate). ' + (rq.clearanceQualified ? 'Your company is on file as ' + rq.clearance.program + '-qualified.' : 'Your company is NOT on file as ' + rq.clearance.program + '-qualified. Tell dispatch right away.') + ' Clearance target: ' + rq.clearance.targetMin + ' min from notification.' });
      if (lines.length) app.appendChild(el('div', { class: 'jb-req' }, el('b', 'Scene requirements'), el('ul', lines.map(function (l) { return el('li', { class: l.ok ? 'ok' : 'bad' }, (l.ok ? '✓ ' : '! ') + l.t); }))));
    }
    if (done) {
      app.appendChild(el('div.jb-card.jb-done', el('div.tick', '✓'), el('div.jb-title', 'Job complete'), el('p.jb-sub', 'Thank you. Dispatch has been notified.')));
    }
    if (closed) {
      app.appendChild(el('div.jb-card.jb-done', el('div.jb-title', st === 'declined' ? 'You declined this job' : 'This job is closed'), el('p.jb-sub', 'No further action needed.')));
    }

    // primary actions
    if (fresh) {
      app.appendChild(el('div.jb-card', el('div', { style: { display: 'grid', gap: '12px' } },
        el('button.jb-btn.jb-btn--go', { disabled: S.busy, onclick: function () { act('accept', { etaMin: S.eta }); } }, 'Accept job'),
        etaBox(true),
        el('button.jb-btn.jb-btn--no', { disabled: S.busy, onclick: function () { if (confirm('Decline this job?')) act('decline', { note: S.note || undefined }); } }, 'Decline'))));
    }
    if (!fresh && !done && !closed) {
      var idx = STAGES.indexOf(st);
      var steps = el('div.jb-steps', STAGES.slice(0, 3).map(function (_, i) { return el('i', { class: i < idx ? 'done' : i === idx ? 'on' : '' }); }));
      var card = el('div.jb-card', el('h2', 'Your status'), steps);
      if (st === 'accepted') { card.appendChild(etaBox(false)); card.appendChild(el('div', { style: { marginTop: '12px' } }, el('button.jb-btn.jb-btn--pri', { disabled: S.busy, onclick: function () { act('eta', { etaMin: S.eta, note: S.note || undefined }); } }, 'I am en route'))); }
      if (st === 'en_route') { card.appendChild(etaBox(false, 'Update ETA')); card.appendChild(el('div.jb-row', { style: { marginTop: '12px' } }, el('button.jb-btn.jb-btn--sm', { disabled: S.busy, onclick: function () { act('eta', { etaMin: S.eta, note: S.note || undefined }); } }, 'Send new ETA'), el('button.jb-btn.jb-btn--pri', { disabled: S.busy, onclick: function () { act('arrived', { note: S.note || undefined }); } }, 'On scene'))); }
      if (st === 'on_scene') card.appendChild(el('button.jb-btn.jb-btn--go', { disabled: S.busy, onclick: function () { if (confirm('Mark this job complete?')) act('complete', { note: S.note || undefined }); } }, 'Complete job'));
      card.appendChild(el('div', { style: { marginTop: '12px' } }, el('textarea.jb-input', { placeholder: 'Optional note for dispatch', value: S.note, oninput: function (e) { S.note = e.target.value; } })));
      app.appendChild(card);
    }

    // where
    var nav = navUrl(loc.lat, loc.lng, addr);
    app.appendChild(el('div.jb-card', el('h2', 'Pick up at'), el('div.jb-big', addr), loc.road ? el('div.jb-sub', loc.road) : null,
      el('div', { style: { marginTop: '12px' } }, el('a.jb-btn.jb-btn--pri', { href: nav, target: '_blank', rel: 'noopener' }, 'Navigate'))));

    // bring
    var bringList = B && B.bring && B.bring.length ? B.bring : null;
    var bc = el('div.jb-card', el('h2', 'What to bring'), bringList ? el('ul.jb-list', bringList.map(function (x) { return el('li', x); })) : el('div.jb-big', equipment(j)));
    if (B && B.service && B.service.drivable) bc.appendChild(el('div.jb-note', { style: { marginTop: '8px' } }, 'Drivable: ' + plain(B.service.drivable) + (B.service.faultLampOn ? '. Fault lamp is on.' : '')));
    app.appendChild(bc);

    // fault codes, fixes, parts
    if (B && B.service && B.service.codes && B.service.codes.length) {
      app.appendChild(el('div.jb-card', el('h2', 'Fault codes, likely fixes and parts'), el('div.jb-codes', B.service.codes.map(function (c) {
        return el('div.jb-code', el('div.jb-code-h', el('b', c.code), el('span', { class: 'jb-sev sev-' + (c.severity || '') }, plain(c.severity || ''))), el('div', c.desc || ''),
          c.fix ? el('div.jb-note', el('b', 'Likely fix: '), c.fix) : null, c.parts && !/^TBD/.test(c.parts) ? el('div.jb-note', el('b', 'Parts: '), c.parts) : null,
          el('div.jb-note', [c.system ? c.system : '', c.drivable ? 'Drivable: ' + c.drivable : ''].filter(Boolean).join(' · ')));
      })), el('div.jb-note', { style: { marginTop: '8px' } }, 'Decoded from the truck. Confirm on site before ordering parts.')));
    }

    // scene position
    if (B && B.scene) {
      var sc = B.scene, sl = el('div.jb-card.jb-scene', el('h2', 'Where the truck is'), el('div.jb-big', sc.label),
        el('div.jb-sub', [sc.position === 'off_road' ? plain(sc.terrain) + (sc.dropFt ? ', about ' + sc.dropFt + ' ft drop' : '') : '', sc.surface && sc.position !== 'on_roadway' ? 'Ground: ' + plain(sc.surface) : ''].filter(Boolean).join(' · ')),
        el('div.jb-note', { style: { marginTop: '6px' } }, (sc.reported ? 'Reported by the driver or dispatcher.' : 'Estimate, ' + sc.confidence + ' confidence. ') + (sc.reported ? '' : sc.basis) + ' GPS accuracy about ±' + sc.gpsAccuracyM + ' m.'),
        sc.notes ? el('div', { style: { marginTop: '6px', whiteSpace: 'pre-wrap' } }, sc.notes) : null,
        sc.access && sc.access.length ? el('ul.jb-list', sc.access.map(function (x) { return el('li', x); })) : null);
      app.appendChild(sl);
    }

    // camera evidence
    if (B && B.camera && (B.camera.frames.length || B.camera.verified)) {
      var cam = B.camera, cc = el('div.jb-card', el('h2', 'Camera evidence'),
        cam.verdict ? el('div.jb-sub', 'AI verdict: ' + plain(cam.verdict) + (cam.confidence != null ? ' (' + cam.confidence + '% confidence)' : '')) : null,
        cam.frames.length ? el('div.jb-frames', cam.frames.map(function (f) { return el('a', { href: f.url, target: '_blank', rel: 'noopener', class: 'jb-frame' }, el('img', { src: f.url, alt: f.label, loading: 'lazy' }), el('span', f.label)); })) : el('div.jb-note', 'No frames available.'),
        cam.clips.length ? el('div.jb-row', { style: { marginTop: '10px' } }, cam.clips.map(function (c, i) { return /^https?:/.test(c.url || '') ? el('a.jb-btn.jb-btn--sm', { href: c.url, target: '_blank', rel: 'noopener' }, 'Open ' + (c.type || 'road') + ' clip' + (c.durationSec ? ' (' + c.durationSec + 's)' : '')) : null; })) : null,
        el('div.jb-note', { style: { marginTop: '8px' } }, cam.note));
      app.appendChild(cc);
    }

    // authorities
    if (B && B.authorities) {
      var au = B.authorities, items = [];
      au.called.forEach(function (a) { items.push(el('li', { class: 'ok' }, '✓ Called: ' + a.agency)); });
      au.pending.forEach(function (a) { items.push(el('li', 'Recommended, not called yet: ' + a.agency + (a.urgency ? ' (' + a.urgency + ')' : ''))); });
      app.appendChild(el('div.jb-card', el('h2', 'Authorities'), items.length ? el('ul.jb-list', items) : el('div.jb-note', 'No authorities called or recommended at this time.')));
    }

    // vehicle
    var kv = el('dl.jb-kv');
    function row(k, val) { if (val) { kv.appendChild(el('dt', k)); kv.appendChild(el('dd', val)); } }
    var T = j.tkTrailer || (j.eq && j.eq.trailer && j.eq.trailer.attached ? j.eq.trailer : null), L = j.tkLoad;
    var dr = j.driverC || j.driver || {};
    var desc = v.description || veh;
    row('Truck', desc); row('Engine', v.engine);
    row('Class', [v.class ? plain(String(v.class).replace(/^class(\d+)/, 'Class $1')) : '', v.gvwrLb ? 'GVWR ' + lb(v.gvwrLb) : ''].filter(Boolean).join(', '));
    row('Axles / fuel', [v.axles ? v.axles + ' axles' : '', v.fuelType ? plain(v.fuelType) : ''].filter(Boolean).join(', '));
    row('Odometer', v.odometerMi != null ? Number(v.odometerMi).toLocaleString() + ' mi' : '');
    row('Unit', v.unit); row('Plate', v.plate); row('VIN', v.vin);
    if (T) { row('Trailer', [plain(T.type), T.lengthFt ? T.lengthFt + ' ft' : '', T.unitId].filter(Boolean).join(', ')); row('Trailer weight', [T.tareLb ? 'tare ' + lb(T.tareLb) : '', T.maxPayloadLb ? 'max payload ' + lb(T.maxPayloadLb) : ''].filter(Boolean).join(', ')); if (T.reefer) row('Reefer', T.reefer.setpointF + ' F, unit ' + (T.reefer.unitRunning ? 'running' : 'NOT running')); }
    var ldw = (L && L.estimatedWeightLb) || (j.ld && j.ld.estimatedWeightLb);
    if (ldw) row('Est. load', '~' + lb(ldw) + ((L && L.contents) || (j.ld && j.ld.contents && j.ld.contents.label) ? ', ' + (L && L.contents || j.ld.contents.label) : '') + (L && L.weightRangeLb ? ' (range ' + lb(L.weightRangeLb[0]) + ' to ' + lb(L.weightRangeLb[1]) + ')' : ''));
    if (v.grossLb) row('Est. gross weight', '~' + lb(v.grossLb) + (L && L.overweightRisk ? ', may be over legal weight' : ''));
    row('Fleet', j.fleet);
    if (dr.name) row('Driver', dr.name);
    app.appendChild(el('div.jb-card', el('h2', 'Vehicle'), kv, dr.phone ? el('div', { style: { marginTop: '12px' } }, el('a.jb-btn.jb-btn--sm', { href: tel(dr.phone) }, 'Call driver ' + dr.phone)) : null));

    // drop-off
    if (j.drop) {
      var d = j.drop, dn = navUrl(d.lat, d.lng, d.address || d.name);
      app.appendChild(el('div.jb-card', el('h2', d.kind === 'oem_dealer' ? 'Drop off at OEM dealer' : 'Drop off at'), el('div.jb-big', d.name || d.address), d.name && d.address ? el('div.jb-sub', d.address) : null,
        d.hours ? el('div.jb-note', 'Hours: ' + d.hours) : null, d.distanceMi != null ? el('div.jb-note', d.distanceMi + ' mi from the scene') : null,
        j.warranty && j.warranty.preAuthNumber ? el('div.jb-note', 'Pre-auth: ' + j.warranty.preAuthNumber) : null,
        el('div.jb-row', { style: { marginTop: '12px' } }, el('a.jb-btn.jb-btn--sm', { href: dn, target: '_blank', rel: 'noopener' }, 'Navigate'), d.phone ? el('a.jb-btn.jb-btn--sm', { href: tel(d.phone) }, 'Call') : null)));
    }

    // contact
    var c = j.contact || {};
    if (c.phone || c.name) app.appendChild(el('div.jb-card', el('h2', 'Dispatch'), el('div.jb-big', c.name || 'Dispatcher'), c.phone ? el('div', { style: { marginTop: '12px' } }, el('a.jb-btn.jb-btn--go.jb-btn--sm', { href: tel(c.phone) }, 'Call ' + c.phone)) : null));
    if (j.notes) app.appendChild(el('div.jb-card', el('h2', 'Notes'), el('div', { style: { whiteSpace: 'pre-wrap' } }, typeof j.notes === 'string' ? j.notes : JSON.stringify(j.notes))));
    app.appendChild(el('div.jb-sim', 'Demo: all calls and messages are simulated'));
  }

  function etaBox(compact, label) {
    var n = el('div.n', S.eta, el('small', 'min'));
    function bump(d) { S.touchedEta = true; S.eta = Math.max(5, Math.min(600, S.eta + d)); n.firstChild.nodeValue = S.eta; }
    var custom = el('input.jb-input', { type: 'number', inputmode: 'numeric', min: 5, max: 600, placeholder: 'Custom minutes', 'aria-label': 'Custom ETA minutes', onchange: function (e) { var x = parseInt(e.target.value, 10); if (x > 0) { S.touchedEta = true; S.eta = x; n.firstChild.nodeValue = S.eta; } } });
    return el('div.jb-eta', el('h2', label || 'Your ETA to the scene'), n,
      el('div.jb-row3', { style: { margin: '10px 0' } }, el('button.jb-btn.jb-btn--sm', { type: 'button', onclick: function () { bump(-5); } }, '−5'), el('button.jb-btn.jb-btn--sm', { type: 'button', onclick: function () { bump(5); } }, '+5'), el('button.jb-btn.jb-btn--sm', { type: 'button', onclick: function () { bump(10); } }, '+10')),
      compact ? null : custom);
  }

  /* ---------- boot ---------- */
  var cached = ls(KEY); if (cached) { S.raw = cached; S.job = norm(cached); render(); }
  load();
  setInterval(function () { if (!document.hidden && !S.busy && !(document.activeElement && /INPUT|TEXTAREA/.test(document.activeElement.tagName))) { flush(); load(true); } }, 20000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) { flush(); load(true); } });
  window.addEventListener('online', function () { flush(); load(true); });
  window.addEventListener('offline', function () { setOffline(true); });
})();
