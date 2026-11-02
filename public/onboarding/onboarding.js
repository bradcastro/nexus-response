/* Nexus Response — Client Onboarding & Integrations portal. Vanilla JS on top of window.NX (brand.js). */
(function () {
  'use strict';
  var el = NX.el, fmt = NX.fmt;

  /* ============================== config ============================== */
  var VENDORS = [
    { id: 'mantis', name: 'Mantis', feat: true, c: '#F25C05', blurb: 'Camera-first telematics. Driver-facing and road-facing AI signals, plus clips, give the richest verification and the best early warnings.' },
    { id: 'motive', name: 'Motive', c: '#2f7fd6', blurb: 'ELD, dashcam and safety events.' },
    { id: 'samsara', name: 'Samsara', c: '#1f9d8a', blurb: 'Connected operations and AI dashcams.' },
    { id: 'geotab', name: 'Geotab', c: '#8a63d2', blurb: 'Open-platform telematics, rules and exceptions.' },
    { id: 'lytx', name: 'Lytx', c: '#c9892b', blurb: 'DriveCam video safety events.' },
    { id: 'other', name: 'Other', c: '#7b8ba3', blurb: 'Any system that can send JSON or CSV.' }
  ];
  var VENDOR_BY = {}; VENDORS.forEach(function (v) { VENDOR_BY[v.id] = v; });
  var FALLBACK_STEPS = {
    mantis: ['In the Mantis admin console, open Integrations and choose Webhooks.', 'Paste the webhook URL below as the destination.', 'Add the API key as the header x-nexus-key (or as a Bearer token).', 'Turn on camera events, driver-facing alerts (drowsiness, phone, seatbelt) and collision events.', 'Save, then press Send test event here to confirm.'],
    motive: ['In Motive, open Fleet, Settings, Webhooks and add a new webhook.', 'Paste the webhook URL below and add the API key as the header x-nexus-key.', 'Select safety events, dashcam events and fault codes.', 'Save, then press Send test event here to confirm.'],
    samsara: ['In Samsara, open Settings, Developer, Webhooks and add a webhook.', 'Paste the webhook URL below and add the API key as the header x-nexus-key.', 'Subscribe to safety events and vehicle fault codes.', 'Save, then press Send test event here to confirm.'],
    geotab: ['In MyGeotab, add a Data Connector or an Add-In that posts exceptions as JSON.', 'Send them to the webhook URL below with the header x-nexus-key.', 'Include accelerations, speeding and fault data rules.', 'Save, then press Send test event here to confirm.'],
    lytx: ['In Lytx, ask your account manager to enable event notifications.', 'Give them the webhook URL below and the API key as header x-nexus-key.', 'Ask for coachable events and video-available notifications.', 'Save, then press Send test event here to confirm.'],
    other: ['Have your system send each event as JSON with POST to the webhook URL below.', 'Add the API key as the header x-nexus-key.', 'No live feed yet? Skip this and use Import history instead.', 'Press Send test event here to confirm.']
  };
  var STEP_HELP = {
    account_created: { label: 'Client account created', help: 'Done when you add the client.' },
    api_key_issued: { label: 'API key issued', help: 'Copy it into the vendor system.' },
    first_event_received: { label: 'First live event received', help: 'Send a test event, or wait for a real one.', go: 'test' },
    vehicles_mapped: { label: 'Vehicles loaded', help: 'Upload the roster so events match trucks and drivers.', go: '#roster' },
    history_imported: { label: 'History imported', help: 'Load past events for a risk assessment.', go: '#import' },
    alerts_configured: { label: 'Alerts configured', help: 'Choose who is notified in Dispatch.', go: null }
  };
  var SAMPLES = { mantis: 'mantis-export.csv', motive: 'motive-export.csv', samsara: 'samsara-export.csv' };
  // keys match the backend importer (src/importer.js SYN); [key, plain label, required, advanced]
  var NEXUS_FIELDS = [
    ['timestamp', 'Date and time', true], ['eventType', 'Event type', true], ['vin', 'VIN'], ['unit', 'Vehicle / unit name'], ['driver', 'Driver'],
    ['lat', 'Latitude'], ['lng', 'Longitude'], ['speed', 'Speed'], ['severity', 'Severity'], ['externalId', 'Event ID'], ['video', 'Video link'], ['address', 'Location'],
    ['dtc', 'Fault codes', false, true], ['plate', 'License plate', false, true], ['odometer', 'Odometer', false, true], ['followingDistance', 'Following distance (s)', false, true], ['drowsiness', 'Drowsiness score', false, true],
    ['phoneUse', 'Phone use', false, true], ['seatbelt', 'Seatbelt on', false, true], ['aiClassification', 'Camera AI verdict', false, true], ['aiConfidence', 'Camera AI confidence', false, true], ['weight', 'Load weight', false, true],
    ['date', 'Trip date (mileage rows)', false, true], ['miles', 'Miles (mileage rows)', false, true], ['hours', 'Hours (mileage rows)', false, true]
  ];

  /* ============================== helpers ============================== */
  var state = { fleetId: null, fleets: null, created: {}, sse: null, incidentHandlers: [] };
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* */ } }
  state.fleetId = lsGet('nx-ob-fleet');

  function loadFleets(force) {
    if (state.fleets && !force) return Promise.resolve(state.fleets);
    return NX.api('/api/fleets').then(function (d) { state.fleets = Array.isArray(d) ? d : (d && d.fleets) || []; return state.fleets; })
      .catch(function () { state.fleets = state.fleets || []; return state.fleets; });
  }
  function fleetName(id) { var f = (state.fleets || []).filter(function (x) { return x.id === id; })[0]; return f ? f.name : id; }
  function setFleet(id) { state.fleetId = id; lsSet('nx-ob-fleet', id || ''); }
  function abs(u) { if (!u) return ''; return /^https?:/.test(u) ? u : location.origin + (u[0] === '/' ? '' : '/') + u; }
  function errMsg(e) { var d = e && e.data; if (d && d.details && d.details.length) return [].concat(d.details).join(' '); if (d && d.message) return d.message; return (e && e.message) || 'Something went wrong'; }
  function isLocalFleet(f) { return f && f.onboarding; }

  function copyText(text, btn) {
    function done() { NX.toast('Copied to clipboard', 'success', 1800); if (btn) { var o = btn.textContent; btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = o; }, 1400); } }
    if (navigator.clipboard && window.isSecureContext !== false) navigator.clipboard.writeText(text).then(done, fallback); else fallback();
    function fallback() { var t = el('textarea', { style: { position: 'fixed', opacity: 0 } }); t.value = text; document.body.appendChild(t); t.select(); try { document.execCommand('copy'); done(); } catch (e) { NX.toast('Copy failed. Select the text and copy it manually.', 'warn'); } t.remove(); }
  }
  function copyRow(text, opts) {
    opts = opts || {};
    var b = el('button.nx-btn.nx-btn--sm', { type: 'button', onclick: function () { copyText(text, b); } }, 'Copy');
    return el('div', { class: 'ob-copy' + (opts.key ? ' ob-copy--key' : '') }, el('code', text), b);
  }
  function download(name, text, type) {
    var a = el('a', { href: URL.createObjectURL(new Blob([text], { type: type || 'text/csv' })), download: name });
    document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  function busy(btn, p) { btn.classList.add('is-loading'); return p.then(function (r) { btn.classList.remove('is-loading'); return r; }, function (e) { btn.classList.remove('is-loading'); throw e; }); }
  function field(label, input, hint, cls) { return el('div', { class: cls || '' }, el('label.nx-label', label), input, hint && el('div.ob-hint', hint)); }
  function card(title, body, right, cls) {
    return el('section', { class: 'nx-card ' + (cls || '') }, title && el('div.nx-card__head', el('h2.nx-card__title', title), right && el('div', { style: { marginLeft: 'auto' } }, right)), el('div.nx-card__body', body));
  }
  function pageHead(eyebrow, title, sub, right) {
    return el('div.nx-page-head', el('div', el('div.nx-eyebrow', eyebrow), el('h1', title), sub && el('p', sub)), right);
  }
  function fleetSelect(onchange, opts) {
    opts = opts || {};
    var s = el('select.nx-select', { 'aria-label': 'Client', onchange: function () { setFleet(s.value); onchange && onchange(s.value); } });
    function fill() {
      s.innerHTML = '';
      if (opts.placeholder) s.appendChild(el('option', { value: '' }, opts.placeholder));
      (state.fleets || []).forEach(function (f) { s.appendChild(el('option', { value: f.id }, f.name + (f.vendor ? ' (' + f.vendor + ')' : ''))); });
      if (opts.extra) opts.extra.forEach(function (o) { s.appendChild(o); });
      var want = opts.value || state.fleetId;
      if (want && Array.prototype.some.call(s.options, function (o) { return o.value === want; })) s.value = want;
      else if (!opts.placeholder && s.options.length) { s.selectedIndex = 0; setFleet(s.value); }
    }
    fill(); loadFleets().then(function () { fill(); onchange && opts.fireInitial !== false && onchange(s.value); });
    s.refill = fill;
    return s;
  }
  function vendorDot(v) { var d = VENDOR_BY[v]; return el('span', { class: 'nx-dim', style: { whiteSpace: 'nowrap' } }, el('span.ob-vdot', { style: '--c:' + (d ? d.c : '#7b8ba3') }), d ? d.name : fmt.label(v || 'unknown')); }
  function statusBadge(s) { var m = { healthy: 'ok', stale: 'warn', failing: 'danger', never_connected: 'plain' }; return NX.badge(s === 'never_connected' ? 'Never connected' : fmt.label(s), m[s] || 'plain'); }
  function onbBadge(s) { var m = { live: 'ok', setup: 'warn', demo: 'plain' }; return NX.badge(s ? fmt.label(s) : 'Demo', m[s] || 'plain'); }

  /* ----- tiny CSV parser (RFC4180-ish) ----- */
  function parseCSV(text, maxRows) {
    var rows = [], row = [], cur = '', q = false, i = 0, n = text.length;
    if (text.charCodeAt(0) === 0xFEFF) i = 1;
    // sniff delimiter on first line
    var first = text.slice(0, text.indexOf('\n') < 0 ? n : text.indexOf('\n'));
    var delim = [',', '\t', ';', '|'].map(function (d) { return [d, first.split(d).length]; }).sort(function (a, b) { return b[1] - a[1]; })[0][0];
    for (; i < n; i++) {
      var c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else if (c === '"') q = true;
      else if (c === delim) { row.push(cur); cur = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); cur = ''; if (row.length > 1 || row[0] !== '') rows.push(row); row = []; if (maxRows && rows.length >= maxRows) return rows; }
      else cur += c;
    }
    if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
    return rows;
  }
  function countRows(text) { var n = 0, p = -1; while ((p = text.indexOf('\n', p + 1)) !== -1) n++; if (text && text[text.length - 1] !== '\n') n++; return Math.max(0, n - 1); }
  function sniff(text) {
    var t = text.trim(); if (!t) return null;
    if (t[0] === '[' || t[0] === '{') return 'json';
    return 'csv';
  }
  function bytes(n) { return n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }

  /* ----- drop zone ----- */
  function dropzone(opts) {
    var input = el('input', { type: 'file', accept: opts.accept || '.csv,.json,.txt,text/csv,application/json', onchange: function () { read(input.files[0]); } });
    var zone = el('label.ob-drop', { tabindex: 0, onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } } },
      el('div', el('b', 'Drop a file here'), ' or click to choose'), el('div.ob-small', opts.hint || 'CSV or JSON'), input);
    ['dragenter', 'dragover'].forEach(function (t) { zone.addEventListener(t, function (e) { e.preventDefault(); zone.classList.add('is-over'); }); });
    ['dragleave', 'drop'].forEach(function (t) { zone.addEventListener(t, function (e) { e.preventDefault(); zone.classList.remove('is-over'); }); });
    zone.addEventListener('drop', function (e) { if (e.dataTransfer.files[0]) read(e.dataTransfer.files[0]); });
    function read(file) {
      if (!file) return;
      var fr = new FileReader();
      fr.onload = function () { opts.onText(String(fr.result), file.name, file.size); };
      fr.onerror = function () { NX.toast('Could not read that file', 'error'); };
      fr.readAsText(file);
    }
    return zone;
  }

  /* ----- live stream (one shared SSE connection) ----- */
  function ensureStream() {
    if (state.sse) return;
    state.sse = NX.sse('/api/stream', function (d) { state.incidentHandlers.slice().forEach(function (h) { try { h(d); } catch (e) { /* */ } }); }, { events: ['incident'] });
  }
  function onIncident(fn) { state.incidentHandlers.push(fn); return function () { state.incidentHandlers = state.incidentHandlers.filter(function (x) { return x !== fn; }); }; }

  /* ----- router ----- */
  var views = {}, cleanup = [], viewEl = document.getElementById('view');
  function route() {
    var h = (location.hash || '#clients').slice(1), parts = h.split('?'), name = parts[0] || 'clients';
    var q = {}; (parts[1] || '').split('&').forEach(function (kv) { if (kv) { var p = kv.split('='); q[p[0]] = decodeURIComponent(p[1] || ''); } });
    if (!views[name]) name = 'clients';
    cleanup.forEach(function (f) { try { f(); } catch (e) { /* */ } }); cleanup = [];
    document.querySelectorAll('#side .nx-nav').forEach(function (a) { a.classList.toggle('is-active', a.dataset.view === name); });
    var sb = document.getElementById('side'); if (sb) sb.classList.remove('is-open');
    if (q.fleet) setFleet(q.fleet);
    viewEl.innerHTML = '';
    var node = views[name](q, function (fn) { cleanup.push(fn); });
    viewEl.appendChild(node);
    document.getElementById('main').scrollTop = 0;
  }
  function go(h) { if (location.hash === h) route(); else location.hash = h; }

  /* ============================== shared: checklist ============================== */
  function checklistView(fleetId, opts) {
    opts = opts || {};
    var root = el('div'), timer;
    function render(d) {
      var steps = (d && d.steps) || [], pct = d && d.percent != null ? d.percent : Math.round(100 * steps.filter(function (s) { return s.done; }).length / (steps.length || 1));
      root.innerHTML = '';
      root.appendChild(el('div.nx-row', { style: { marginBottom: '12px' } },
        el('div.ob-pct', pct + '%'), el('div.nx-grow', el('div.nx-meter.ob-progress', el('i', { style: 'width:' + pct + '%;--c:' + (pct >= 100 ? 'var(--nx-ok)' : 'var(--nx-accent)') })),
          el('div.ob-hint', pct >= 100 ? 'Everything is in place. This client is live.' : steps.filter(function (s) { return !s.done; }).length + ' step(s) left before go-live.'))));
      var ul = el('ul.ob-check');
      steps.forEach(function (s) {
        var h = STEP_HELP[s.key] || {}, act = null;
        if (!s.done && !opts.compact && h.go) {
          act = h.go === 'test' ? el('button.nx-btn.nx-btn--sm', { type: 'button', onclick: function (e) { var b = e.currentTarget; busy(b, NX.api('/api/onboarding/fleets/' + fleetId + '/test-event', { method: 'POST', body: {} })).then(function () { NX.toast('Test event sent', 'success'); setTimeout(load, 700); }, function (er) { NX.toast(errMsg(er), 'error'); }); } }, 'Send test event')
            : el('a.nx-btn.nx-btn--sm', { href: h.go + '?fleet=' + encodeURIComponent(fleetId) }, h.go === '#roster' ? 'Load vehicles' : 'Import history');
        }
        ul.appendChild(el('li' + (s.done ? '.is-done' : ''), el('span.ob-tick', s.done ? '✓' : ''),
          el('div.lbl', s.label || h.label || fmt.label(s.key), el('small', s.done ? (s.doneAt ? 'Done ' + fmt.ago(s.doneAt) : 'Done') : (h.help || ''))), act));
      });
      root.appendChild(ul);
      if (opts.onData) opts.onData(d);
    }
    function load() {
      return NX.api('/api/onboarding/fleets/' + encodeURIComponent(fleetId) + '/checklist').then(render, function (e) { root.innerHTML = ''; root.appendChild(el('div.ob-callout.ob-callout--danger', 'Could not load the checklist. ' + errMsg(e))); });
    }
    root.reload = load;
    root.stop = function () { clearInterval(timer); };
    root.appendChild(NX.skeleton(4));
    load();
    if (opts.poll) timer = setInterval(load, opts.poll);
    return root;
  }

  /* ============================== VIEW: clients ============================== */
  views.clients = function (q, reg) {
    var root = el('div'), list = el('div');
    root.appendChild(pageHead('Client onboarding', 'Ready to load clients', 'Connect a fleet’s telematics, load its vehicles and import its history. Each step takes a few minutes.',
      el('a.nx-btn.nx-btn--primary', { href: '#add' }, 'Add a client')));
    root.appendChild(el('div.ob-guide',
      el('section.nx-card', el('div.nx-card__body', el('div.n', 'STEP 1'), el('h2.nx-card__title', 'Connect live data'), el('p', 'Create the client, copy its webhook address and key into the vendor system, then send a test event.'), el('a.nx-btn.nx-btn--sm', { href: '#add' }, 'Add a client'))),
      el('section.nx-card', el('div.nx-card__body', el('div.n', 'STEP 2'), el('h2.nx-card__title', 'Load vehicles'), el('p', 'Upload a simple list of trucks and drivers so events match the right vehicle.'), el('a.nx-btn.nx-btn--sm', { href: '#roster' }, 'Upload a roster'))),
      el('section.nx-card', el('div.nx-card__body', el('div.n', 'STEP 3'), el('h2.nx-card__title', 'Import history'), el('p', 'Bring in past events to produce a risk assessment on day one, before any live data arrives.'), el('a.nx-btn.nx-btn--sm', { href: '#import' }, 'Import history')))));
    root.appendChild(card('Clients', list, el('button.nx-btn.nx-btn--sm', { type: 'button', onclick: function () { load(true); } }, 'Refresh'), 'ob-gap'));
    function load(force) {
      list.innerHTML = ''; list.appendChild(NX.skeleton(4));
      Promise.all([loadFleets(true), NX.api('/api/ingest/health').catch(function () { return []; })]).then(function (r) {
        var fleets = r[0], health = Array.isArray(r[1]) ? r[1] : (r[1] && (r[1].integrations || r[1].fleets || r[1].items)) || [];
        var hBy = {}; health.forEach(function (h) { hBy[h.fleetId] = h; });
        list.innerHTML = '';
        if (!fleets.length) { list.appendChild(NX.empty('No clients yet', 'Add your first client to get a webhook address and API key.')); return; }
        var t = el('table.nx-table', el('thead', el('tr', ['Client', 'Vendor', 'Vehicles', 'Status', 'Connection', ''].map(function (h, i) { return el('th' + (i === 2 ? '.num' : ''), h); }))), el('tbody'));
        fleets.forEach(function (f) {
          var h = hBy[f.id], on = f.onboarding && f.onboarding.status;
          t.tBodies[0].appendChild(el('tr', el('td', { style: { fontWeight: 600 } }, f.name, f.region ? el('div.nx-dim.ob-small', { style: { fontWeight: 400 } }, f.region) : null),
            el('td', vendorDot(f.vendor)), el('td.num', fmt.number(f.vehicles)), el('td', onbBadge(on)),
            el('td', h ? statusBadge(h.status) : el('span.nx-faint', 'Not reported')),
            el('td', el('div.ob-fleetrow', { style: { justifyContent: 'flex-end' } },
              el('a.nx-btn.nx-btn--sm', { href: '#checklist?fleet=' + f.id }, 'Checklist'),
              el('a.nx-btn.nx-btn--sm.nx-btn--ghost', { href: '#roster?fleet=' + f.id }, 'Vehicles'),
              el('a.nx-btn.nx-btn--sm.nx-btn--ghost', { href: '#import?fleet=' + f.id }, 'Import')))));
        });
        list.appendChild(el('div.nx-table-wrap', t));
      });
    }
    load();
    return root;
  };

  /* ============================== VIEW: add client ============================== */
  views.add = function (q, reg) {
    var root = el('div.ob-narrow'), form = {};
    root.appendChild(pageHead('Step 1 of 3', 'Add a client', 'Tell us about the fleet. You will get a private webhook address and API key to paste into their telematics system.'));
    var stage = el('div');
    root.appendChild(stage);

    var vendor = 'mantis';
    var vendorBox = el('div.ob-vendors', { role: 'radiogroup', 'aria-label': 'Telematics vendor' });
    function drawVendors() {
      vendorBox.innerHTML = '';
      VENDORS.forEach(function (v) {
        var b = el('button.ob-vendor' + (v.feat ? '.ob-vendor--feat' : ''), { type: 'button', role: 'radio', 'aria-checked': String(v.id === vendor), onclick: function () { vendor = v.id; drawVendors(); } },
          v.feat ? el('div', el('b', el('span.ob-vdot', { style: '--c:' + v.c }), v.name), el('span', v.blurb)) : [el('b', el('span.ob-vdot', { style: '--c:' + v.c }), v.name), el('span', v.blurb)],
          v.feat && NX.badge('Featured', 'accent'));
        vendorBox.appendChild(b);
      });
    }
    drawVendors();

    form.name = el('input.nx-input', { placeholder: 'e.g. Redline Regional Carriers', autocomplete: 'off', 'aria-required': 'true' });
    form.contact = el('input.nx-input', { placeholder: 'Full name', autocomplete: 'off' });
    form.email = el('input.nx-input', { type: 'email', placeholder: 'name@company.com', autocomplete: 'off' });
    form.region = el('input.nx-input', { placeholder: 'e.g. TN / KY / OH valley (optional)' });
    form.vehicles = el('input.nx-input', { type: 'number', min: 1, placeholder: 'Number of trucks', inputmode: 'numeric' });
    var errBox = el('div.ob-err');
    var submit = el('button.nx-btn.nx-btn--primary.nx-btn--lg', { type: 'submit' }, 'Create client');
    var f = el('form.nx-card', { novalidate: true, onsubmit: function (e) {
      e.preventDefault(); errBox.textContent = '';
      var body = { name: form.name.value.trim(), vendor: vendor, vehicles: form.vehicles.value ? +form.vehicles.value : undefined, contactName: form.contact.value.trim(), contactEmail: form.email.value.trim(), region: form.region.value.trim() || undefined };
      if (!body.name) { errBox.textContent = 'Enter the company name.'; form.name.focus(); return; }
      if (!body.contactName) { errBox.textContent = 'Enter a contact name.'; form.contact.focus(); return; }
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.contactEmail)) { errBox.textContent = 'Enter a valid contact email.'; form.email.focus(); return; }
      busy(submit, NX.api('/api/onboarding/fleets', { method: 'POST', body: body })).then(function (res) { loadFleets(true); showResult(res, body); }, function (er) { errBox.textContent = errMsg(er); });
    } },
      el('div.nx-card__head', el('h2.nx-card__title', 'Company details')),
      el('div.nx-card__body',
        el('div.ob-form',
          field('Company name', form.name, null, 'full'),
          field('Contact name', form.contact), field('Contact email', form.email, 'We send setup confirmations here.'),
          field('Region', form.region), field('Fleet size', form.vehicles, 'Approximate is fine.'),
          el('div.full', el('label.nx-label', 'Telematics or camera system'), vendorBox, el('div.ob-hint', 'Pick the system the fleet runs today. You can connect more later.')))),
      el('div.nx-card__foot.nx-row', submit, errBox));
    stage.appendChild(f);

    function showResult(res, body) {
      var fleet = res.fleet || {}, id = fleet.id || res.fleetId, key = typeof res.apiKey === 'string' ? res.apiKey : (res.apiKey && (res.apiKey.key || res.apiKey.value)) || '';
      var url = abs(res.webhookUrl || ('/webhook/' + (body.vendor === 'other' ? 'generic' : body.vendor)));
      setFleet(id);
      stage.innerHTML = '';
      var vd = VENDOR_BY[body.vendor] || {};
      stage.appendChild(el('div.ob-callout.ob-callout--ok', { style: { marginBottom: '16px' } }, el('div', el('b', (fleet.name || body.name) + ' is created. '), 'Now connect ' + (vd.name || 'the vendor') + ' using the three steps below.')));

      // 1 credentials
      var keyWrap = el('div'), keyNote = el('div.ob-callout', { style: { marginTop: '10px' } }, 'This key is shown once. Copy it now and store it in the vendor system. If it is lost, rotate it to get a new one.');
      function drawKey(k) { keyWrap.innerHTML = ''; keyWrap.appendChild(copyRow(k, { key: true })); }
      drawKey(key || '(not returned)');
      var rotate = el('button.nx-btn.nx-btn--sm', { type: 'button', onclick: function () {
        if (!confirm('Rotate the API key? The old key stops working immediately.')) return;
        busy(rotate, NX.api('/api/onboarding/fleets/' + id + '/rotate-key', { method: 'POST', body: {} })).then(function (r) {
          var nk = typeof r.apiKey === 'string' ? r.apiKey : (r.apiKey && r.apiKey.key) || r.key || ''; drawKey(nk); keyWrap.classList.add('ob-reveal'); NX.toast('New key issued. The old key no longer works.', 'success');
        }, function (er) { NX.toast(errMsg(er), 'error'); });
      } }, 'Rotate key');
      stage.appendChild(card('1. Webhook address and API key', el('div.nx-stack',
        el('div', el('label.nx-label', 'Webhook URL'), copyRow(url)),
        el('div', el('div.nx-row', { style: { marginBottom: '6px' } }, el('label.nx-label', { style: { margin: 0 } }, 'API key'), el('div.nx-grow'), rotate), keyWrap),
        keyNote,
        el('div.ob-hint', 'Send the key in the header ', el('span.ob-mono', 'x-nexus-key'), ' (or as ', el('span.ob-mono', 'Authorization: Bearer'), ').'))));

      // 2 steps
      var steps = (res.setupSteps && res.setupSteps.length ? res.setupSteps : FALLBACK_STEPS[body.vendor] || FALLBACK_STEPS.other);
      var ol = el('ol.ob-steps'); steps.forEach(function (s) { ol.appendChild(el('li', el('div', typeof s === 'string' ? s : (s.title ? el('b', s.title + '. ') : null), typeof s === 'string' ? null : (s.text || s.detail || '')))); });
      stage.appendChild(card('2. Set it up in ' + (vd.name || 'the vendor system'), ol, null, 'ob-gap'));

      // 3 test
      var liveBox = el('div.ob-live', el('span.nx-faint', 'Waiting. Press the button to send a test event through the real pipeline.'));
      var checklist = checklistView(id, { compact: true, poll: 6000 }); reg(function () { checklist.stop(); });
      var testBtn = el('button.nx-btn.nx-btn--primary', { type: 'button' }, 'Send test event');
      var pending = null;
      testBtn.onclick = function () {
        var sentAt = Date.now(); liveBox.className = 'ob-live'; liveBox.innerHTML = ''; liveBox.appendChild(el('span.ob-spin')); liveBox.appendChild(el('span', 'Sent. Waiting for the event to arrive on the live stream...'));
        if (pending) pending();
        var settled = false;
        function ok(inc, via) { if (settled) return; settled = true; pending && pending(); liveBox.className = 'ob-live is-ok'; liveBox.innerHTML = ''; liveBox.appendChild(el('span.ob-tick', { style: { background: 'var(--nx-ok)', borderColor: 'var(--nx-ok)' } }, '✓')); liveBox.appendChild(el('div', el('b', 'Event received'), inc ? [' ', el('span.ob-mono', inc.id || ''), ' ' + fmt.label(inc.eventType || 'event') + (inc.severity ? ', ' + inc.severity : '')] : '', el('div.nx-dim.ob-small', 'Confirmed ' + via + ' in ' + Math.max(0.1, (Date.now() - sentAt) / 1000).toFixed(1) + 's. The connection works.'))); checklist.reload(); }
        var off = onIncident(function (d) { if (d && d.fleetId === id) ok(d, 'on the live stream'); });
        var t1 = setTimeout(function () { // fallback: ask the checklist
          NX.api('/api/onboarding/fleets/' + id + '/checklist').then(function (c) { var s = (c.steps || []).filter(function (x) { return x.key === 'first_event_received'; })[0]; if (s && s.done) ok(null, 'by the checklist'); });
        }, 4000);
        var t2 = setTimeout(function () { if (!settled) { settled = true; pending && pending(); liveBox.className = 'ob-live is-fail'; liveBox.innerHTML = ''; liveBox.appendChild(el('span', 'No confirmation yet. Check Integration health for errors, then try again.')); } }, 12000);
        pending = function () { off(); clearTimeout(t1); clearTimeout(t2); pending = null; };
        NX.api('/api/onboarding/fleets/' + id + '/test-event', { method: 'POST', body: {} }).then(function (r) { if (r && (r.incident || r.incidentId) && !settled) { var inc = r.incident || { id: r.incidentId }; setTimeout(function () { ok(inc, 'by the server'); }, 1800); } }, function (er) { if (pending) pending(); settled = true; liveBox.className = 'ob-live is-fail'; liveBox.innerHTML = ''; liveBox.appendChild(el('span', 'The test event was rejected: ' + errMsg(er))); });
      };
      reg(function () { pending && pending(); });
      ensureStream();
      stage.appendChild(card('3. Confirm it works', el('div.nx-stack', el('div.nx-row', testBtn, el('span.nx-dim.ob-small', 'Sends a sample ' + (vd.name || '') + ' event through the same path real events use.')), liveBox), null, 'ob-gap'));

      stage.appendChild(card('Go-live progress', checklist, null, 'ob-gap'));
      stage.appendChild(el('div.ob-actions', el('a.nx-btn.nx-btn--primary', { href: '#roster?fleet=' + id }, 'Next: load vehicles'), el('a.nx-btn', { href: '#import?fleet=' + id }, 'Import history'), el('a.nx-btn.nx-btn--ghost', { href: '#add', onclick: function () { setTimeout(route, 0); } }, 'Add another client')));
    }
    return root;
  };

  /* ============================== VIEW: roster ============================== */
  var ROSTER_COLS = ['unit', 'vin', 'plate', 'make', 'model', 'year', 'driver'];
  var ROSTER_ALIAS = { unit: ['unit', 'unitnumber', 'unitno', 'truck', 'vehicle', 'vehiclename', 'vehicleid', 'name'], vin: ['vin', 'vinnumber'], plate: ['plate', 'licenseplate', 'licenceplate', 'tag'], make: ['make', 'manufacturer'], model: ['model'], year: ['year', 'modelyear'], driver: ['driver', 'drivername', 'assigneddriver'] };
  function parseRoster(text) {
    var kind = sniff(text), recs = [], issues = [];
    if (!kind) return { rows: [], issues: [], empty: true };
    if (kind === 'json') {
      var j; try { j = JSON.parse(text); } catch (e) { return { rows: [], issues: [{ row: 0, msg: 'This is not valid JSON: ' + e.message }] }; }
      if (!Array.isArray(j)) j = j.vehicles || j.roster || [j];
      recs = j.map(function (o) { var r = {}; Object.keys(o).forEach(function (k) { r[k.toLowerCase().replace(/[^a-z0-9]/g, '')] = o[k]; }); return r; });
    } else {
      var rows = parseCSV(text); if (rows.length < 2) return { rows: [], issues: [{ row: 0, msg: 'Add a header row and at least one vehicle.' }] };
      var hdr = rows[0].map(function (h) { return h.trim().toLowerCase().replace(/[^a-z0-9]/g, ''); });
      recs = rows.slice(1).map(function (r) { var o = {}; hdr.forEach(function (h, i) { o[h] = r[i]; }); return o; });
    }
    var seen = {}, out = [];
    recs.forEach(function (r, i) {
      var o = {}; ROSTER_COLS.forEach(function (c) { var k = ROSTER_ALIAS[c].filter(function (a) { return r[a] != null && r[a] !== ''; })[0]; o[c] = k ? String(r[k]).trim() : ''; });
      var line = i + 2, bad = false;
      if (!o.unit && !o.vin) { issues.push({ row: line, msg: 'Needs a unit name or a VIN.' }); return; }
      if (o.vin) {
        var v = o.vin.toUpperCase(); o.vin = v;
        if (v.length !== 17 || /[IOQ]/.test(v) || /[^A-Z0-9]/.test(v)) issues.push({ row: line, msg: 'VIN "' + o.vin + '" should be 17 letters and numbers (no I, O or Q).', warn: true });
        if (seen[v]) issues.push({ row: line, msg: 'Duplicate VIN, also on row ' + seen[v] + '.', warn: true }); else seen[v] = line;
      }
      if (o.year && !/^(19|20)\d\d$/.test(o.year)) issues.push({ row: line, msg: 'Year "' + o.year + '" looks wrong.', warn: true });
      if (!bad) out.push(o);
    });
    return { rows: out, issues: issues };
  }
  views.roster = function (q, reg) {
    var root = el('div.ob-narrow'), data = { text: '', parsed: null };
    root.appendChild(pageHead('Step 2 of 3', 'Load vehicles', 'Give us the fleet’s trucks and drivers. Events are matched to these by VIN or unit name.', el('button.nx-btn', { type: 'button', onclick: function () {
      download('nexus-roster-template.csv', 'unit,vin,plate,make,model,year,driver\nRL-101,1FUJGLDR5LLAB1234,TN-4821A,Freightliner,Cascadia,2021,Marcus Hale\nRL-102,4V4NC9EH7MN123456,TN-5530C,Volvo,VNL 760,2022,Dana Ortiz\n');
    } }, 'Download template')));
    var sel = fleetSelect(null, {}), ta = el('textarea.nx-textarea.ob-textarea', { placeholder: 'unit,vin,plate,make,model,year,driver\nRL-101,1FUJGLDR5LLAB1234,TN-4821A,Freightliner,Cascadia,2021,Marcus Hale', spellcheck: false, 'aria-label': 'Paste roster', oninput: function () { setText(ta.value); } });
    var feedback = el('div'), send = el('button.nx-btn.nx-btn--primary', { type: 'button', disabled: true, onclick: doSend }, 'Upload vehicles');
    var dz = dropzone({ hint: 'CSV or JSON with columns: unit, vin, plate, make, model, year, driver', onText: function (t, name) { ta.value = t; setText(t); NX.toast('Loaded ' + name, 'info', 1800); } });
    root.appendChild(card(null, el('div.nx-stack', field('Client', sel), dz, field('Or paste it here', ta)), null));
    root.appendChild(el('div.ob-gap', feedback));
    root.appendChild(el('div.ob-actions', send));
    function setText(t) {
      data.text = t; data.parsed = parseRoster(t); feedback.innerHTML = '';
      var p = data.parsed; send.disabled = !p.rows.length;
      if (p.empty) return;
      var errs = p.issues.filter(function (i) { return !i.warn; }), warns = p.issues.filter(function (i) { return i.warn; });
      var head = el('div.nx-row', { style: { flexWrap: 'wrap' } }, NX.badge(p.rows.length + ' ready', p.rows.length ? 'ok' : 'danger'), warns.length ? NX.badge(warns.length + ' to check', 'warn') : null, errs.length ? NX.badge(errs.length + ' skipped', 'danger') : null);
      var body = el('div.nx-stack', head);
      if (p.issues.length) body.appendChild(el('ul', { style: { margin: 0, paddingLeft: '18px', fontSize: 'var(--nx-text-sm)' } }, p.issues.slice(0, 12).map(function (i) { return el('li', (i.row ? 'Row ' + i.row + ': ' : '') + i.msg); }), p.issues.length > 12 ? el('li.nx-faint', '...and ' + (p.issues.length - 12) + ' more') : null));
      if (p.rows.length) {
        var t = el('table.nx-table', el('thead', el('tr', ROSTER_COLS.map(function (c) { return el('th', c); }))), el('tbody', p.rows.slice(0, 8).map(function (r) { return el('tr', ROSTER_COLS.map(function (c) { return el('td' + (c === 'vin' ? '.id' : ''), r[c] || el('span.nx-faint', '—')); })); })));
        body.appendChild(el('div.ob-scroll', t)); if (p.rows.length > 8) body.appendChild(el('div.ob-hint', 'Showing 8 of ' + p.rows.length + ' vehicles.'));
      }
      feedback.appendChild(card('Check before uploading', body));
    }
    function doSend() {
      var id = sel.value; if (!id) return NX.toast('Choose a client first', 'warn');
      var rows = data.parsed.rows;
      busy(send, NX.api('/api/onboarding/fleets/' + id + '/vehicles', { method: 'POST', body: { vehicles: rows } }).catch(function (e) {
        if (e.status === 400) return NX.api('/api/onboarding/fleets/' + id + '/vehicles', { method: 'POST', body: rows }); throw e; })).then(function (r) {
        var n = r && (r.added != null ? r.added + (r.updated || 0) : r.created != null ? r.created : r.count != null ? r.count : r.vehicles != null ? (Array.isArray(r.vehicles) ? r.vehicles.length : r.vehicles) : rows.length);
        var skipped = r && (r.skipped || r.rejected || (r.errors && r.errors.length));
        feedback.innerHTML = ''; feedback.appendChild(el('div.ob-callout.ob-callout--ok', el('div', el('b', fmt.number(n) + ' vehicles saved to ' + fleetName(id) + '. '), skipped ? skipped + ' skipped. ' : '', el('a', { href: '#checklist?fleet=' + id }, 'See the go-live checklist'))));
        NX.toast('Vehicles uploaded', 'success'); loadFleets(true);
      }, function (e) { feedback.appendChild(el('div.ob-callout.ob-callout--danger', { style: { marginTop: '12px' } }, 'Upload failed: ' + errMsg(e))); });
    }
    return root;
  };

  /* ============================== VIEW: import ============================== */
  views.import = function (q, reg) {
    var root = el('div.ob-narrow');
    var S = { step: 0, target: 'existing', fleetId: state.fleetId, newName: '', newVendor: 'mantis', vendor: 'mantis', purpose: 'underwriting', text: '', format: 'csv', fileName: '', rows: 0, mapping: {}, preview: null, job: null, jobId: null };
    var body = el('div');
    var head = pageHead('Step 3 of 3', 'Import history', 'Load a fleet’s past events from any telematics system. We check the data, then build a risk assessment from it.');
    root.appendChild(head);
    var stepper = el('div.ob-stepper'); root.appendChild(stepper); root.appendChild(body);
    var STEPS = ['Fleet and source', 'Add the data', 'Check the columns', 'Import', 'Data report'];
    var poll;
    reg(function () { clearTimeout(poll); });
    function drawStepper() { stepper.innerHTML = ''; STEPS.forEach(function (s, i) { stepper.appendChild(el('div' + (i < S.step ? '.is-done' : i === S.step ? '.is-current' : ''), (i + 1) + '. ' + s)); }); }
    function show(n) { S.step = n; drawStepper(); body.innerHTML = ''; [s1, s2, s3, s4, s5][n](); window.scrollTo && document.getElementById('main').scrollTo({ top: 0 }); }

    /* -- step 1 -- */
    function s1() {
      var sel = fleetSelect(function (v) { S.fleetId = v; }, { fireInitial: false, value: S.fleetId });
      var existingBox = el('div', field('Client', sel, 'Choose the client these events belong to.'));
      var nName = el('input.nx-input', { placeholder: 'Company name', value: S.newName, oninput: function () { S.newName = nName.value; } });
      var newBox = el('div', field('New fleet name', nName, 'Creates an assessment-only fleet. You can connect live data later.'));
      var vsel = el('select.nx-select', { 'aria-label': 'Vendor', onchange: function () { S.vendor = vsel.value; S.newVendor = vsel.value; } }, VENDORS.map(function (v) { return el('option', { value: v.id, selected: v.id === S.vendor }, v.name + (v.feat ? ' (featured)' : '')); }));
      var psel = el('select.nx-select', { 'aria-label': 'Purpose', onchange: function () { S.purpose = psel.value; } }, el('option', { value: 'underwriting', selected: S.purpose === 'underwriting' }, 'Insurance underwriting (risk assessment)'), el('option', { value: 'onboarding', selected: S.purpose === 'onboarding' }, 'Client onboarding (history for a live client)'));
      var seg = el('div.nx-chips', [['existing', 'Existing client'], ['new', 'New fleet']].map(function (o) { return el('button.nx-chip' + (S.target === o[0] ? '.is-active' : ''), { type: 'button', onclick: function () { S.target = o[0]; show(0); } }, o[1]); }));
      body.appendChild(card(null, el('div.nx-stack', el('div', el('label.nx-label', 'Import into'), seg), S.target === 'existing' ? existingBox : newBox,
        el('div.ob-form', field('Where did the data come from?', vsel), field('Purpose', psel)))));
      body.appendChild(el('div.ob-actions', el('button.nx-btn.nx-btn--primary', { type: 'button', onclick: function () {
        if (S.target === 'existing' && !(S.fleetId = sel.value)) return NX.toast('Choose a client', 'warn');
        if (S.target === 'new' && !S.newName.trim()) return NX.toast('Enter the new fleet name', 'warn');
        show(1); } }, 'Continue')));
    }

    /* -- step 2 -- */
    function s2() {
      var ta = el('textarea.nx-textarea.ob-textarea', { placeholder: 'Paste CSV or JSON here', spellcheck: false, 'aria-label': 'Paste history data' });
      var info = el('div'), next = el('button.nx-btn.nx-btn--primary', { type: 'button', disabled: !S.text, onclick: function () { runPreview().then(function () { show(2); }); } }, 'Check the data');
      function set(t, name) {
        S.text = t; S.fileName = name || ''; S.format = sniff(t) || 'csv'; S.rows = S.format === 'csv' ? countRows(t) : (function () { var m = t.match(/"[A-Za-z_]*(?:id|time|timestamp)[A-Za-z_]*"\s*:/gi); return m ? Math.round(m.length) : 0; })();
        info.innerHTML = '';
        if (t) {
          info.appendChild(el('div.ob-callout.ob-callout--ok', el('div', el('b', (name || 'Pasted data') + ': '), S.format.toUpperCase() + ', ' + bytes(t.length) + (S.format === 'csv' ? ', about ' + fmt.number(S.rows) + ' rows' : '') + '. ', S.rows > 5000 ? 'Large file, that is fine. It is processed in chunks.' : '')));
          if (t.length > 25 * 1048576) info.appendChild(el('div.ob-callout.ob-callout--danger', { style: { marginTop: '8px' } }, 'This file is over 25 MB. Split it by quarter and import each part.'));
        }
        next.disabled = !t; if (ta.value !== t && t.length < 400000) ta.value = t;
        if (t.length >= 400000) ta.value = '';
      }
      ta.oninput = function () { set(ta.value, ''); };
      var dz = dropzone({ hint: 'CSV or JSON export, 20,000+ rows is fine', onText: function (t, n) { set(t, n); } });
      var samples = el('div.nx-chips');
      ['mantis', 'motive', 'samsara'].forEach(function (v) {
        samples.appendChild(el('button.nx-chip', { type: 'button', onclick: function () { fetch('/onboarding/samples/' + SAMPLES[v]).then(function (r) { if (!r.ok) throw new Error('missing'); return r.text(); }).then(function (t) { S.vendor = v; S.newVendor = v; set(t, SAMPLES[v]); }, function () { NX.toast('Sample not found', 'error'); }); } }, 'Use sample ' + VENDOR_BY[v].name + ' export'));
      });
      if (S.text) set(S.text, S.fileName);
      body.appendChild(card(null, el('div.nx-stack', dz, field('Or paste it here', ta),
        el('div', el('label.nx-label', 'No file handy? Try a demo export'), samples),
        el('div.nx-row', { style: { flexWrap: 'wrap' } }, el('a.nx-btn.nx-btn--sm', { href: '/api/import/templates/' + (S.vendor === 'other' ? 'nexus' : S.vendor), download: S.vendor + '-template.csv', target: '_blank', rel: 'noopener' }, 'Download ' + (VENDOR_BY[S.vendor] || {}).name + ' template'), el('span.nx-dim.ob-small', 'Shows the columns we recognise.')),
        info)));
      body.appendChild(el('div.ob-actions', el('button.nx-btn', { type: 'button', onclick: function () { show(0); } }, 'Back'), el('span.spacer'), next));
    }
    function payload(extra) {
      var p = { vendor: S.vendor, format: S.format }; if (S.format === 'json') p.data = S.text; else p.csv = S.text;
      return Object.assign(p, extra || {});
    }
    function runPreview(mapping) {
      var b = body.querySelector('.nx-btn--primary'); if (b) b.classList.add('is-loading');
      return NX.api('/api/import/preview', { method: 'POST', body: payload(mapping ? { mapping: mapping } : {}) }).then(function (r) {
        S.preview = r; if (!mapping) S.mapping = Object.assign({}, r.suggestedMapping || {}); if (b) b.classList.remove('is-loading'); return r;
      }, function (e) { if (b) b.classList.remove('is-loading'); NX.toast('Could not read that data: ' + errMsg(e), 'error', 8000); throw e; });
    }

    /* -- step 3 -- */
    function s3() {
      var p = S.preview || {}, cols = p.detectedColumns || [];
      var sampleBox = el('div'), warnBox = el('div');
      function drawSample() {
        var p2 = S.preview || {}, smp = p2.sample || [], keys = [];
        smp.forEach(function (r) { Object.keys(r).forEach(function (k) { if (keys.indexOf(k) < 0 && typeof r[k] !== 'object') keys.push(k); }); });
        keys = keys.slice(0, 9);
        sampleBox.innerHTML = '';
        sampleBox.appendChild(smp.length ? el('div.ob-scroll', el('table.nx-table', el('thead', el('tr', keys.map(function (k) { return el('th', k); }))), el('tbody', smp.map(function (r) { return el('tr', keys.map(function (k) { return el('td', r[k] == null || r[k] === '' ? el('span.nx-faint', '—') : String(r[k]).slice(0, 40)); })); })))) : el('div.nx-dim', 'No sample rows could be built from this mapping.'));
        warnBox.innerHTML = '';
        (p2.warnings || []).forEach(function (w) { warnBox.appendChild(el('div.ob-callout', { style: { marginBottom: '6px' } }, typeof w === 'string' ? w : (w.message || JSON.stringify(w)))); });
      }
      var tb = el('tbody');
      var timer;
      var tbAdv = el('tbody');
      NEXUS_FIELDS.forEach(function (f) {
        var s = el('select.nx-select', { 'aria-label': 'Column for ' + f[1], onchange: function () { if (s.value) S.mapping[f[0]] = s.value; else delete S.mapping[f[0]]; clearTimeout(timer); timer = setTimeout(function () { runPreview(S.mapping).then(drawSample); }, 350); } },
          el('option', { value: '' }, '— not in this file —'), cols.map(function (c) { return el('option', { value: c, selected: S.mapping[f[0]] === c }, c); }));
        (f[3] && !S.mapping[f[0]] ? tbAdv : tb).appendChild(el('tr', el('td', f[1], f[2] ? el('span.ob-req', '*') : null, el('div.nx-faint.ob-small.ob-mono', f[0])), el('td', s)));
      });
      var adv = tbAdv.children.length ? el('details', { style: { marginTop: '10px' } }, el('summary.nx-dim', { style: { cursor: 'pointer' } }, 'More fields (' + tbAdv.children.length + ')'), el('div.ob-scroll', { style: { marginTop: '8px' } }, el('table.nx-table.ob-map', tbAdv))) : null;
      body.appendChild(el('div.nx-stack',
        el('div.ob-callout.ob-callout--ok', el('div', el('b', fmt.number(p.rows != null ? p.rows : S.rows) + ' rows found. '), 'We matched ' + Object.keys(S.mapping).length + ' of your columns automatically. Fix any that look wrong; the preview updates as you change them.')),
        warnBox,
        card('Match your columns', el('div', el('div.ob-scroll', { style: { maxHeight: '420px' } }, el('table.nx-table.ob-map', el('thead', el('tr', el('th', 'We need'), el('th', 'Your column'))), tb)), adv), el('span.nx-dim.ob-small', '* required')),
        card('How the first rows will look', sampleBox)));
      drawSample();
      body.appendChild(el('div.ob-actions', el('button.nx-btn', { type: 'button', onclick: function () { show(1); } }, 'Back'), el('span.spacer'),
        el('button.nx-btn.nx-btn--primary.nx-btn--lg', { type: 'button', onclick: function (e) {
          if (!S.mapping.timestamp || !S.mapping.eventType) { if (!confirm('Date and time or event type is not matched. Rows without them will be skipped. Continue anyway?')) return; }
          startJob(e.currentTarget); } }, 'Start import')));
    }

    /* -- step 4 -- */
    function startJob(btn) {
      var b = payload({ mapping: S.mapping, purpose: S.purpose });
      if (S.target === 'existing') b.fleetId = S.fleetId; else b.newFleet = { name: S.newName.trim(), vendor: S.newVendor };
      busy(btn, NX.api('/api/import/jobs', { method: 'POST', body: b })).then(function (r) { var j = r.job || r; S.jobId = j.id; S.job = j; show(3); }, function (e) { NX.toast('Could not start the import: ' + errMsg(e), 'error', 8000); });
    }
    function s4() {
      var bar = el('i', { style: { width: '2%' } }), pct = el('div.ob-pct', '0%'), msg = el('div.nx-dim', 'Starting...');
      body.appendChild(card('Importing ' + (S.fileName || 'your data'), el('div.nx-stack', el('div.nx-row', pct, el('div.nx-grow', el('div.nx-meter.ob-progress', bar))), msg,
        el('div.ob-hint', 'You can leave this page open. Large files are processed in chunks, and imported events never trigger dispatch alerts.'))));
      var fails = 0;
      (function tick() {
        NX.api('/api/import/jobs/' + S.jobId).then(function (j) {
          S.job = j; var p = Math.round((j.progress || 0) * 100);
          bar.style.width = Math.max(2, p) + '%'; pct.textContent = p + '%';
          msg.textContent = j.status === 'queued' ? 'Waiting to start...' : fmt.number(Math.round((j.progress || 0) * (j.rowsTotal || 0))) + ' of ' + fmt.number(j.rowsTotal) + ' rows processed' + (j.rowsSkipped ? ', ' + fmt.number(j.rowsSkipped) + ' skipped' : '');
          if (j.status === 'completed') { bar.style.width = '100%'; pct.textContent = '100%'; setTimeout(function () { show(4); }, 500); }
          else if (j.status === 'failed') { body.appendChild(el('div.ob-callout.ob-callout--danger', { style: { marginTop: '12px' } }, 'The import failed. ' + ((j.errors && j.errors[0] && j.errors[0].message) || 'Check the file and try again.'))); body.appendChild(el('div.ob-actions', el('button.nx-btn', { type: 'button', onclick: function () { show(2); } }, 'Back to the data'))); }
          else poll = setTimeout(tick, 800);
        }, function () { if (++fails < 6) poll = setTimeout(tick, 1500); else msg.textContent = 'Lost contact with the server. Reload to check this job: ' + S.jobId; });
      })();
    }

    /* -- step 5 -- */
    function s5() {
      var j = S.job || {}, dq = j.dataQuality || {}, cov = dq.fieldCoverage || {}, qs = dq.qualityScore;
      var vals = Object.keys(cov).map(function (k) { return cov[k]; }), frac = vals.every(function (v) { return v <= 1; });
      var qc = qs >= 80 ? 'var(--nx-ok)' : qs >= 60 ? 'var(--nx-warn)' : 'var(--nx-danger)';
      var qlabel = qs >= 80 ? 'Good quality' : qs >= 60 ? 'Usable, with gaps' : 'Needs attention';
      var fl = { vin: 'VIN', driver: 'Driver', gps: 'GPS location', speed: 'Speed', video: 'Video', dtc: 'Fault codes', load: 'Load data' };
      var covBox = el('div'); Object.keys(cov).forEach(function (k) { var v = Math.round(frac ? cov[k] * 100 : cov[k]); covBox.appendChild(el('div.ob-cov', el('span', fl[k] || fmt.label(k)), el('div.nx-meter', el('i', { style: 'width:' + v + '%;--c:' + (v >= 80 ? 'var(--nx-ok)' : v >= 40 ? 'var(--nx-warn)' : 'var(--nx-sev-high)') })), el('span.nx-num', { style: { textAlign: 'right' } }, v + '%'))); });
      var dr = dq.dateRange || {};
      function dOnly(x) { var m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(String(x || '')); return fmt.date(m ? new Date(+m[1], +m[2] - 1, +m[3]) : x); } // date-only strings: avoid UTC shift to the previous day
      var errs = j.errors || [];
      body.appendChild(el('div.ob-callout.ob-callout--ok', { style: { marginBottom: '16px' } }, el('div', el('b', 'Import complete. '), fmt.number(j.rowsOk) + ' of ' + fmt.number(j.rowsTotal) + ' rows imported' + (j.rowsSkipped ? ', ' + fmt.number(j.rowsSkipped) + ' skipped' : '') + '.')));
      body.appendChild(card('Data quality report', el('div.nx-stack',
        el('div.nx-row', { style: { gap: '24px', flexWrap: 'wrap', alignItems: 'center' } },
          el('div.ob-score', { style: '--c:' + qc }, el('div', qs != null ? Math.round(qs) : '—', el('small', 'OF 100'))),
          el('div.nx-grow', { style: { minWidth: '220px' } }, el('h3', { style: { margin: '0 0 6px', font: '600 var(--nx-text-lg)/1 var(--nx-font-display)', textTransform: 'uppercase', letterSpacing: '.03em' } }, qlabel),
            el('div.ob-bignum', [['Date range', dr.from ? dOnly(dr.from) + ' to ' + dOnly(dr.to) : '—'], ['Days', fmt.number(dq.days)], ['Vehicles', fmt.number(dq.vehicles)], ['Drivers', fmt.number(dq.drivers)], ['Duplicates', fmt.number(dq.duplicates)]].map(function (k) { return el('div', el('b', k[1]), el('span', k[0])); })))),
        Object.keys(cov).length ? el('div', el('label.nx-label', 'Field coverage'), covBox) : null,
        (dq.notes && dq.notes.length) ? el('div', el('label.nx-label', 'Notes'), el('ul', { style: { margin: 0, paddingLeft: '18px', fontSize: 'var(--nx-text-sm)' } }, dq.notes.map(function (n) { return el('li', n); }))) : null)));
      if (errs.length) {
        body.appendChild(card('Rows we could not import (' + fmt.number(errs.length) + ')', el('div', el('div.ob-scroll', el('table.nx-table', el('thead', el('tr', el('th.num', 'Row'), el('th', 'Problem'))), el('tbody', errs.slice(0, 100).map(function (e) { return el('tr', el('td.num', e.row), el('td', e.message)); })))), errs.length > 100 ? el('div.ob-hint', 'Showing the first 100.') : null,
          el('div.ob-actions', el('button.nx-btn.nx-btn--sm', { type: 'button', onclick: function () { download('import-errors-' + S.jobId + '.csv', 'row,message\n' + errs.map(function (e) { return e.row + ',"' + String(e.message).replace(/"/g, '""') + '"'; }).join('\n')); } }, 'Download error list'))), null, 'ob-gap'));
      }
      var aid = j.assessmentId;
      body.appendChild(el('div.ob-actions',
        aid ? el('a.nx-btn.nx-btn--primary.nx-btn--lg', { href: '/insurer/#assessment=' + encodeURIComponent(aid) }, 'View risk assessment') : el('span.nx-dim', 'The risk assessment is still being prepared. Refresh in a moment.'),
        j.fleetId ? el('a.nx-btn', { href: '#checklist?fleet=' + j.fleetId }, 'Go-live checklist') : null,
        el('button.nx-btn.nx-btn--ghost', { type: 'button', onclick: function () { S.text = ''; S.job = null; S.preview = null; show(0); } }, 'Import another file')));
      if (j.fleetId) loadFleets(true);
    }

    // resume a job via #import?job=ID
    if (q.job) { S.jobId = q.job; NX.api('/api/import/jobs/' + q.job).then(function (j) { S.job = j; show(j.status === 'completed' ? 4 : 3); }, function () { show(0); }); drawStepper(); }
    else show(0);
    return root;
  };

  /* ============================== VIEW: health ============================== */
  views.health = function (q, reg) {
    var root = el('div'), healthBox = el('div'), logBox = el('div'), filters = { fleetId: '', status: '' };
    root.appendChild(pageHead('Integrations', 'Integration health', 'Whether each client’s feed is arriving. Healthy means events are flowing; stale means a quiet spell; failing means events are being rejected.', el('button.nx-btn', { type: 'button', onclick: function () { loadHealth(); loadLog(); } }, 'Refresh')));
    var kpis = el('div.nx-kpis'); root.appendChild(kpis);
    root.appendChild(card('Connections', healthBox));
    var fsel = el('select.nx-select', { 'aria-label': 'Filter by client', onchange: function () { filters.fleetId = fsel.value; loadLog(); } }, el('option', { value: '' }, 'All clients'));
    var ssel = el('select.nx-select', { 'aria-label': 'Filter by status', onchange: function () { filters.status = ssel.value; loadLog(); } }, [['', 'All results'], ['accepted', 'Accepted'], ['duplicate', 'Duplicate'], ['rejected', 'Rejected'], ['failed', 'Failed']].map(function (o) { return el('option', { value: o[0] }, o[1]); }));
    loadFleets().then(function (fl) { fl.forEach(function (f) { fsel.appendChild(el('option', { value: f.id }, f.name)); }); });
    root.appendChild(card('Ingest log', logBox, el('div.ob-filters', fsel, ssel), 'ob-gap'));

    function loadHealth() {
      return Promise.all([loadFleets(), NX.api('/api/ingest/health')]).then(function (r) {
        var rows = Array.isArray(r[1]) ? r[1] : (r[1] && (r[1].integrations || r[1].fleets || r[1].items || r[1].health)) || [];
        var cnt = { healthy: 0, stale: 0, failing: 0, never_connected: 0 }; rows.forEach(function (h) { cnt[h.status] = (cnt[h.status] || 0) + 1; });
        kpis.innerHTML = '';
        [['Healthy', cnt.healthy, 'nx-kpi--ok'], ['Stale', cnt.stale, ''], ['Failing', cnt.failing, cnt.failing ? 'nx-kpi--critical' : ''], ['Never connected', cnt.never_connected, ''], ['Events, 24h', rows.reduce(function (a, h) { return a + (h.events24h || 0); }, 0), 'nx-kpi--accent']].forEach(function (k) { kpis.appendChild(el('div', { class: 'nx-kpi ' + k[2] }, el('div.nx-kpi__label', k[0]), el('div.nx-kpi__value', fmt.number(k[1])))); });
        healthBox.innerHTML = '';
        if (!rows.length) { healthBox.appendChild(NX.empty('No connections yet', 'Add a client to see its feed here.')); return; }
        var t = el('table.nx-table', el('thead', el('tr', ['Client', 'Vendor', 'Status', 'Last event', 'Events 24h', 'Errors 24h', 'Latency'].map(function (h, i) { return el('th' + (i > 3 ? '.num' : ''), h); }))), el('tbody'));
        rows.sort(function (a, b) { var o = { failing: 0, stale: 1, never_connected: 2, healthy: 3 }; return (o[a.status] - o[b.status]) || String(fleetName(a.fleetId)).localeCompare(fleetName(b.fleetId)); });
        rows.forEach(function (h) {
          t.tBodies[0].appendChild(el('tr', { dataset: { click: 1 }, onclick: function () { fsel.value = h.fleetId; filters.fleetId = h.fleetId; loadLog(); } },
            el('td', { style: { fontWeight: 600 } }, h.fleetName || fleetName(h.fleetId)), el('td', vendorDot(h.provider)), el('td', statusBadge(h.status)),
            el('td', h.lastEventAt ? [fmt.ago(h.lastEventAt)] : el('span.nx-faint', 'Never')), el('td.num', fmt.number(h.events24h)),
            el('td.num', { style: h.errors24h ? { color: 'var(--nx-danger)' } : {} }, fmt.number(h.errors24h)), el('td.num', h.avgLatencyMs != null ? Math.round(h.avgLatencyMs) + ' ms' : '—')));
        });
        healthBox.appendChild(el('div.nx-table-wrap', t));
        healthBox.appendChild(el('div.ob-hint', 'Click a row to filter the log below to that client.'));
      }, function (e) { healthBox.innerHTML = ''; healthBox.appendChild(el('div.ob-callout.ob-callout--danger', 'Could not load health: ' + errMsg(e))); });
    }
    function loadLog() {
      logBox.innerHTML = ''; logBox.appendChild(NX.skeleton(4));
      return NX.api('/api/ingest/log', { query: { fleetId: filters.fleetId, status: filters.status, limit: 60 } }).then(function (r) {
        var rows = Array.isArray(r) ? r : (r && (r.entries || r.log || r.items)) || [];
        logBox.innerHTML = '';
        if (!rows.length) { logBox.appendChild(NX.empty('Nothing logged', 'Events appear here as soon as a feed or test sends something.')); return; }
        var t = el('table.nx-table', el('thead', el('tr', ['Received', 'Client', 'Vendor', 'Result', 'Latency', ''].map(function (h, i) { return el('th' + (i === 4 ? '.num' : ''), h); }))), el('tbody'));
        rows.forEach(function (l) {
          var bad = l.status === 'rejected' || l.status === 'failed', v = { accepted: 'ok', duplicate: 'plain', rejected: 'warn', failed: 'danger' }[l.status] || 'plain';
          var rb = bad ? el('button.nx-btn.nx-btn--sm', { type: 'button', onclick: function (e) { e.stopPropagation(); busy(rb, NX.api('/api/ingest/log/' + encodeURIComponent(l.id) + '/replay', { method: 'POST', body: {} })).then(function (r) { var st = r && r.status; if (st === 'accepted' || st === 'duplicate') NX.toast('Replayed. The event was ' + st + (r.incidentId ? ' (' + r.incidentId + ')' : '') + '.', 'success'); else NX.toast('Replayed, but it was ' + (st || 'not accepted') + ' again' + (r && r.error ? ': ' + r.error : '') + '. The original data needs fixing at the source.', 'warn', 8000); loadLog(); loadHealth(); }, function (er) { NX.toast('Replay failed: ' + errMsg(er), 'error'); }); } }, 'Replay') : null;
          var tr = el('tr', { dataset: { click: 1 }, title: 'Show details', onclick: function () { var nx = tr.nextSibling; if (nx && nx.classList && nx.classList.contains('ob-detail')) nx.remove(); else if (l.error || l.incidentId) tr.after(el('tr.ob-detail', el('td', { colspan: 6 }, l.error ? el('div', el('b', 'Error: '), l.error) : null, l.incidentId ? el('div', 'Incident ', el('a', { href: '/dispatch/#' + l.incidentId }, l.incidentId)) : null, el('div.nx-faint', fmt.number(l.payloadBytes) + ' bytes, id ' + l.id)))); } },
            el('td', el('div', fmt.ago(l.receivedAt)), el('div.nx-faint.ob-small', fmt.dateTime(l.receivedAt))), el('td', l.fleetName || (l.fleetId ? fleetName(l.fleetId) : el('span.nx-faint', 'Unknown'))), el('td', vendorDot(l.provider)),
            el('td', NX.badge(fmt.label(l.status), v), l.error ? el('div.nx-dim.ob-small', { style: { marginTop: '4px', maxWidth: '320px' } }, String(l.error).slice(0, 90)) : null), el('td.num', l.latencyMs != null ? Math.round(l.latencyMs) + ' ms' : '—'), el('td', { style: { textAlign: 'right' } }, rb));
          t.tBodies[0].appendChild(tr);
        });
        logBox.appendChild(el('div.nx-table-wrap', t));
      }, function (e) { logBox.innerHTML = ''; logBox.appendChild(el('div.ob-callout.ob-callout--danger', 'Could not load the log: ' + errMsg(e))); });
    }
    loadHealth(); loadLog();
    var iv = setInterval(function () { loadHealth(); }, 15000); reg(function () { clearInterval(iv); });
    ensureStream(); var off = onIncident(function () { clearTimeout(root._t); root._t = setTimeout(function () { loadHealth(); loadLog(); }, 800); }); reg(off);
    return root;
  };

  /* ============================== VIEW: checklist ============================== */
  views.checklist = function (q, reg) {
    var root = el('div.ob-narrow'), box = el('div'), cl;
    root.appendChild(pageHead('Go-live', 'Go-live checklist', 'Everything a client needs before you call them live.'));
    var meta = el('div');
    var sel = fleetSelect(draw, {});
    root.appendChild(el('div', { style: { maxWidth: '420px', marginBottom: '16px' } }, field('Client', sel)));
    root.appendChild(meta); root.appendChild(box);
    function draw(id) {
      if (cl) cl.stop(); box.innerHTML = ''; meta.innerHTML = '';
      if (!id) { box.appendChild(NX.empty('Choose a client', 'Pick a client to see its progress.')); return; }
      var f = (state.fleets || []).filter(function (x) { return x.id === id; })[0];
      cl = checklistView(id, { poll: 8000, onData: function (d) {
        meta.innerHTML = ''; if (!f) return;
        meta.appendChild(el('div.nx-row', { style: { marginBottom: '12px', flexWrap: 'wrap' } }, vendorDot(f.vendor), onbBadge(f.onboarding && f.onboarding.status), el('span.nx-dim.ob-small', fmt.number(f.vehicles) + ' vehicles')));
      } });
      box.appendChild(card('Progress', cl, el('a.nx-btn.nx-btn--sm', { href: '#health' }, 'Open health')));
    }
    reg(function () { cl && cl.stop(); });
    return root;
  };

  /* ============================== boot ============================== */
  var bar = NX.topbar('Onboarding');
  // Stopgap: portal switcher has no Onboarding link yet (see docs/HANDOFFS.md). Add one locally if brand.js does not.
  (function () {
    function patch() {
      var sw = document.querySelector('.nx-switcher'); if (!sw) return;
      var has = Array.prototype.some.call(sw.querySelectorAll('a'), function (a) { return /onboarding/i.test(a.textContent); });
      if (!has) sw.appendChild(el('a', { href: '/onboarding/', 'aria-current': 'page' }, 'Onboarding'));
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', patch); else patch();
  })();
  ensureStream();
  window.addEventListener('hashchange', route);
  loadFleets().then(route, route);
})();
