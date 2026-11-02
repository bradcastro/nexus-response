/* Dispatch — Proactive mode: predictive alerts ("prevent", not "respond") */
(function () {
  'use strict';
  var esc = NX.esc, fmt = NX.fmt, D, S;
  var KINDS = { driver_risk_spike: 'Driver risk spike', fatigue_pattern: 'Fatigue pattern', following_distance_trend: 'Following-distance trend', hotspot_forming: 'Hotspot forming', vehicle_breakdown_risk: 'Breakdown risk', maintenance_overdue: 'Maintenance overdue' };
  var SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3 };
  var ST_RANK = { open: 0, acknowledged: 1, actioned: 2, dismissed: 3 };
  var STS = ['open', 'acknowledged', 'actioned', 'dismissed'];
  var cache = { drivers: {}, vehicles: {}, fleet: {} };
  var $ = function (s) { return document.querySelector(s); };
  var pct = function (p) { p = Number(p); return isNaN(p) ? null : Math.round(p <= 1 ? p * 100 : p); };
  var tone = function (a) { return (a.severity === 'critical' || a.severity === 'high') ? 'warn' : 'info'; };
  var closed = function (a) { return a.status === 'dismissed' || a.status === 'actioned'; };
  var horizon = function (h) { return h == null ? '--' : h < 48 ? 'next ' + Math.round(h) + ' h' : 'next ' + Math.round(h / 24) + ' d'; };
  function api(p, o) { return D.api(p, o); }
  function list(d, k) { return Array.isArray(d) ? d : (d && d[k]) || []; }

  function counts() { var c = { all: 0 }; STS.forEach(function (s) { c[s] = 0; }); S.alerts.forEach(function (a) { c.all++; c[a.status] = (c[a.status] || 0) + 1; }); return c; }
  function sorted() {
    var f = S.af, out = [];
    S.alerts.forEach(function (a) {
      if (f.status !== 'all' && a.status !== f.status) return;
      if (f.kind && a.kind !== f.kind) return;
      if (f.fleet && a.fleetId !== f.fleet) return;
      out.push(a);
    });
    return out.sort(function (a, b) { return (ST_RANK[a.status] - ST_RANK[b.status]) || (SEV_RANK[a.severity] - SEV_RANK[b.severity]) || ((pct(b.probability) || 0) - (pct(a.probability) || 0)); });
  }
  function paintCounts() {
    var c = counts(), n = $('#c-pro'); if (n) { n.textContent = c.open || 0; n.classList.toggle('is-hot', !!c.open); }
    var h = $('#hud-watch'); if (h) h.textContent = c.open || 0;
  }

  /* ---------- queue ---------- */
  function row(a) {
    var p = pct(a.probability), t = tone(a), sub = a.subject || {};
    return '<div class="arow tone-' + t + (S.selAlert === a.id ? ' is-selected' : '') + (closed(a) ? ' is-closed' : '') + (S.newAlerts.has(a.id) ? ' nx-new' : '') + '" data-aid="' + esc(a.id) + '" tabindex="-1">' +
      '<div class="ar-top"><span class="watch">Watch</span><span class="ar-kind">' + esc(KINDS[a.kind] || fmt.label(a.kind)) + '</span><span class="qr-age">' + esc(fmt.ago(a.createdAt)) + '</span></div>' +
      '<div class="ar-head">' + esc(a.headline || KINDS[a.kind]) + '</div>' +
      '<div class="ar-meta"><span class="ar-p"><b>' + (p != null ? p + '%' : '--') + '</b> likely</span><span>' + esc(horizon(a.horizonHours)) + '</span><span class="nx-grow"></span>' + NX.badgeHTML(a.status === 'open' ? 'Open' : a.status, a.status === 'open' ? 'info' : a.status === 'actioned' ? 'ok' : 'plain') + '</div>' +
      '<div class="qr-sub">' + esc(fmt.label(sub.type || '')) + ': ' + esc(sub.name || sub.id || '') + ' &middot; ' + esc(a.fleetName || '') + '</div></div>';
  }
  function renderList() {
    var c = counts(), chips = $('#pro-chips');
    chips.innerHTML = ['open', 'acknowledged', 'actioned', 'dismissed', 'all'].map(function (s) { return '<button class="nx-chip' + (S.af.status === s ? ' is-active' : '') + '" data-ast="' + s + '">' + fmt.label(s) + ' <b>' + (c[s] || 0) + '</b></button>'; }).join('');
    var ks = $('#f-kind'); if (!ks.options.length) ks.innerHTML = '<option value="">All alert types</option>' + Object.keys(KINDS).map(function (k) { return '<option value="' + k + '">' + KINDS[k] + '</option>'; }).join('');
    var l = sorted(), box = $('#q-list');
    $('#q-shown').textContent = l.length + ' shown';
    paintCounts();
    if (S.alertsLoading) { box.innerHTML = '<div class="sk">' + [1, 2, 3].map(function () { return '<span class="nx-skel nx-skel--block"></span>'; }).join('') + '</div>'; return; }
    if (S.alertsError) { box.innerHTML = ''; box.appendChild(NX.empty('Predictive alerts unavailable', S.alertsError, '!')); return; }
    if (!l.length) { box.innerHTML = ''; box.appendChild(NX.empty(S.alerts.size ? 'No alerts match' : 'Nothing to prevent right now', S.alerts.size ? 'Adjust the filters above.' : 'Predicted risks appear here before they become incidents.', '◌')); return; }
    var top = box.scrollTop; box.innerHTML = l.map(row).join(''); box.scrollTop = top; S.newAlerts.clear();
    var el = box.querySelector('.is-selected'); if (el && S._scrollA) { el.scrollIntoView({ block: 'nearest' }); S._scrollA = false; }
  }

  /* ---------- data ---------- */
  function load() {
    S.alertsLoading = !S.alerts.size; S.alertsError = null;
    return api('/api/predict/alerts', { query: { limit: 500 } }).then(function (d) {
      S.alerts.clear(); list(d, 'alerts').forEach(function (a) { S.alerts.set(a.id, a); });
      S.alertsLoading = false; paintCounts(); if (S.mode === 'proactive') { renderList(); D.renderDetail(); drawMap(); } else D.renderDetail();
    }).catch(function (e) { S.alertsLoading = false; S.alertsError = e.status === 404 ? 'The predictive engine is not enabled on this server.' : e.message; paintCounts(); if (S.mode === 'proactive') renderList(); });
  }
  function upsert(a) {
    if (!a || !a.id) return;
    var prev = S.alerts.get(a.id); S.alerts.set(a.id, a);
    if (!prev && a.status === 'open') { S.newAlerts.add(a.id); NX.toast('Watch: ' + (a.headline || KINDS[a.kind]), 'info', 4500); }
    paintCounts();
    if (S.mode === 'proactive') { renderList(); if (S.selAlert === a.id) { renderDetail(); drawMap(); } } else D.renderDetail();
  }
  function selectAlert(id) {
    S.selAlert = id; S._scrollA = true; S.subjMiss = null; renderList(); renderDetail(); drawMap(true);
    var a = S.alerts.get(id); if (a) loadSubject(a);
  }
  function loadSubject(a) {
    var s = a.subject || {}, fid = a.fleetId;
    var done = function () { if (S.selAlert === a.id) { renderDetail(); drawMap(); } };
    if (s.type === 'driver' && !cache.drivers[fid]) api('/api/predict/drivers', { query: { fleetId: fid, limit: 200 } }).then(function (d) { cache.drivers[fid] = list(d, 'drivers'); done(); }).catch(function () { cache.drivers[fid] = []; });
    else if (s.type === 'vehicle' && !cache.vehicles[fid]) api('/api/predict/vehicles', { query: { fleetId: fid } }).then(function (d) { cache.vehicles[fid] = list(d, 'vehicles'); done(); }).catch(function () { cache.vehicles[fid] = []; });
    if ((s.type === 'route' || a.kind === 'hotspot_forming' || true) && !cache.fleet[fid]) api('/api/predict/fleet/' + encodeURIComponent(fid), { query: { horizonDays: 90 } }).then(function (d) { cache.fleet[fid] = d || {}; done(); }).catch(function () { cache.fleet[fid] = {}; });
  }

  /* ---------- subject / coordinates ---------- */
  function latestIncident(a) {
    var s = a.subject || {}, best = null;
    D.inc.forEach(function (i) {
      var m = (s.type === 'driver' && i.driver && (i.driver.id === s.id || i.driver.name === s.name)) || (s.type === 'vehicle' && i.vehicle && (i.vehicle.id === s.id || i.vehicle.unit === s.name || i.vehicle.plate === s.name));
      if (m && i.location && i.location.lat != null && (!best || new Date(i.timestamp) > new Date(best.timestamp))) best = i;
    });
    return best;
  }
  function coords(a) {
    var s = a.subject || {}, c = [s, a, a.location, a.hotspot].find(function (x) { return x && x.lat != null && x.lng != null; });
    if (c) return { ll: [c.lat, c.lng], kind: 'exact', r: c.radiusM };
    var fl = cache.fleet[a.fleetId];
    if (a.kind === 'hotspot_forming' || s.type === 'route') {
      var hs = (fl && fl.hotspots) || [], text = ((a.headline || '') + ' ' + (s.name || '')).toLowerCase();
      var h = hs.find(function (x) { return x.label && text.indexOf(String(x.label).toLowerCase()) > -1; }) || hs[0];
      if (h) return { ll: [h.lat, h.lng], kind: 'hotspot', r: 5000, label: h.label };
    }
    var i = latestIncident(a); if (i) return { ll: [i.location.lat, i.location.lng], kind: 'last', inc: i };
    return null;
  }

  /* ---------- detail ---------- */
  function donut(p, col) {
    var r = 34, c = 2 * Math.PI * r, d = (p || 0) / 100 * c;
    return '<svg class="donut" viewBox="0 0 84 84"><circle cx="42" cy="42" r="' + r + '" fill="none" stroke="var(--nx-surface-3)" stroke-width="8"/><circle cx="42" cy="42" r="' + r + '" fill="none" stroke="' + col + '" stroke-width="8" stroke-linecap="round" stroke-dasharray="' + d.toFixed(1) + ' ' + c.toFixed(1) + '" transform="rotate(-90 42 42)"/><text x="42" y="47" text-anchor="middle" fill="var(--nx-text)" font-family="var(--nx-font-display)" font-size="22" font-weight="600">' + (p != null ? p + '%' : '--') + '</text></svg>';
  }
  function bars(arr, label) {
    if (!arr || arr.length < 2) return '';
    var mx = Math.max.apply(0, arr) || 1, W = 240, H = 44, bw = W / arr.length;
    return '<div class="spark" style="margin-top:10px"><div class="spark-l"><span>' + label + '</span></div><svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" style="height:44px">' + arr.map(function (v, k) { return '<rect x="' + (k * bw + 1).toFixed(1) + '" y="' + (H - v / mx * (H - 3)).toFixed(1) + '" width="' + (bw - 2).toFixed(1) + '" height="' + (v / mx * (H - 3)).toFixed(1) + '" fill="var(--nx-info)" opacity=".7"/>'; }).join('') + '</svg></div>';
  }
  function signalRows(sigs) {
    return (sigs || []).slice(0, 6).map(function (g) {
      var t = Number(g.trendPct), up = t > 0, w = Math.min(100, Math.abs(t) || 0);
      return '<div class="sig-row"><span class="nx-grow">' + esc(g.label || fmt.label(g.key)) + '</span><span class="nx-mono nx-dim">' + esc(g.value != null ? g.value : '') + '</span><span class="trend ' + (isNaN(t) ? '' : up ? 'up' : 'down') + '"><i style="width:' + w + '%"></i></span><span class="nx-mono tr-n ' + (up ? 'up' : 'down') + '">' + (isNaN(t) ? '--' : (up ? '▲ +' : '▼ ') + Math.round(t) + '%') + '</span></div>';
    }).join('');
  }
  function subjectCard(a) {
    var s = a.subject || {}, body = '', type = s.type || 'subject', fid = a.fleetId;
    var icon = { driver: 'DR', vehicle: 'VH', route: 'RT' }[type] || '??';
    if (type === 'driver') {
      var d = (cache.drivers[fid] || []).find(function (x) { return x.driverId === s.id || x.id === s.id || x.name === s.name; });
      if (d) body += '<div class="stat-row"><div><b>' + Math.round(d.riskNow) + '</b><span>Risk now</span></div><div><b>' + Math.round(d.riskProjected30d) + '</b><span>30d projected</span></div><div><b>' + (pct(d.collisionProb30d) != null ? pct(d.collisionProb30d) + '%' : '--') + '</b><span>Collision 30d</span></div></div>' +
        '<div class="nx-eyebrow" style="margin:12px 0 4px">Leading signals</div>' + signalRows(d.signals) +
        '<p class="nx-dim" style="font-size:12px;margin-top:8px">' + (d.daysSinceLastCoaching != null ? 'Last coached ' + d.daysSinceLastCoaching + ' d ago. ' : '') + (d.recommendedIntervention ? 'Recommended: ' + esc(d.recommendedIntervention) : '') + '</p>';
      else if (cache.drivers[fid] === undefined) body = '<span class="nx-skel"></span>';
    } else if (type === 'vehicle') {
      var v = (cache.vehicles[fid] || []).find(function (x) { return x.vehicleId === s.id || x.id === s.id || x.unit === s.name; });
      if (v) body += '<dl class="nx-kv">' + Object.keys(v).filter(function (k) { return typeof v[k] !== 'object' && ['id', 'vehicleId', 'fleetId', 'name'].indexOf(k) < 0; }).slice(0, 8).map(function (k) { return '<dt>' + esc(fmt.label(k.replace(/([A-Z])/g, '_$1').toLowerCase())) + '</dt><dd>' + esc(v[k]) + '</dd>'; }).join('') + '</dl>' + (v.signals ? signalRows(v.signals) : '');
    } else {
      var f = cache.fleet[fid]; if (f && f.patterns) body += bars(f.patterns.byHour, 'Incidents by hour of day (fleet)');
      var h = coords(a); if (h && h.label) body += '<p class="nx-dim" style="font-size:12px;margin-top:8px">Matched hotspot: ' + esc(h.label) + '</p>';
    }
    var hist = (a.history || []).filter(function (x) { return typeof x === 'number'; });
    if (hist.length > 2) body += bars(hist, 'Signal trend');
    var link = type === 'driver' ? '/fleet/?fleet=' + encodeURIComponent(fid) + '#drivers' : '/fleet/?fleet=' + encodeURIComponent(fid);
    return '<section class="pc"><div class="pc-h"><h4>Subject</h4><a class="nx-btn nx-btn--sm nx-btn--ghost" target="_blank" rel="noopener" href="' + link + '">Open in fleet portal</a></div><div class="pc-b"><div class="stop-card"><div class="pt-ic" style="border-color:var(--nx-info);color:var(--nx-info);background:color-mix(in srgb,var(--nx-info) 12%,transparent)">' + icon + '</div><div class="nx-grow"><div class="stop-name">' + esc(s.name || s.id || 'Unknown') + '</div><div class="nx-dim" style="font-size:12px">' + esc(fmt.label(type)) + ' &middot; ' + esc(a.fleetName || fid || '') + '</div></div></div>' + body + '</div></section>';
  }
  function renderDetail() {
    var el = $('#detail'), a = S.alerts.get(S.selAlert);
    if (!a) { el.innerHTML = '<div class="nx-empty d-empty"><div class="nx-empty__icon">◌</div><div class="nx-empty__title">Select an alert</div><p>Predicted risks are shown before they become incidents. Use <kbd>j</kbd> / <kbd>k</kbd> to step, <kbd>a</kbd> to acknowledge.</p></div>'; return; }
    var keep = el.scrollTop, p = pct(a.probability), t = tone(a), col = t === 'warn' ? 'var(--nx-warn)' : 'var(--nx-info)', done = closed(a);
    var kind = a.kind, vehicleKind = kind === 'vehicle_breakdown_risk' || kind === 'maintenance_overdue';
    var B = function (label, key, cls) { return '<button class="nx-btn ' + cls + (S.busy['a_' + key] ? ' is-loading' : '') + '" data-aact="' + key + '"' + (done ? ' disabled' : '') + '>' + label + '</button>'; };
    var hist = (a.history || []).filter(function (x) { return x && typeof x === 'object' && (x.action || x.note); });
    el.innerHTML = '<header class="d-head pro-head tone-' + t + '"><div class="d-id"><span class="watch">Watch</span><span class="nx-badge nx-badge--' + (a.status === 'open' ? 'info' : a.status === 'actioned' ? 'ok' : 'plain') + '">' + fmt.label(a.status) + '</span><span class="nx-mono">' + esc(a.id) + '</span><span class="nx-mono" style="margin-left:auto">' + esc(fmt.ago(a.createdAt)) + '</span></div>' +
      '<div class="nx-eyebrow" style="margin-top:12px;color:' + col + '">Prevent &middot; ' + esc(KINDS[kind] || fmt.label(kind)) + '</div><h2 class="d-title" style="text-transform:none;font-size:20px;line-height:1.2">' + esc(a.headline || '') + '</h2></header>' +
      '<div class="d-body"><section class="pc"><div class="pc-b"><div class="prob">' + donut(p, col) + '<div class="nx-grow"><div class="nx-eyebrow">Probability</div><div class="prob-h">' + (p != null ? p + '%' : '--') + ' <small>' + esc(horizon(a.horizonHours)) + '</small></div><div class="nx-dim" style="font-size:12px">Projected event likelihood. Model is demo-calibrated and explainable.</div></div></div>' +
      (a.expectedImpact ? '<div class="impact"><span class="nx-eyebrow">If nothing changes</span><div>' + esc(a.expectedImpact) + '</div></div>' : '') + '</div></section>' +
      '<section class="pc"><div class="pc-h"><h4>Why we think so</h4></div><div class="pc-b"><ol class="why">' + (a.rationale || []).map(function (r) { return '<li>' + esc(r) + '</li>'; }).join('') + '</ol></div></section>' +
      '<section class="pc rec-act"><div class="pc-h"><h4>Recommended action</h4></div><div class="pc-b"><p style="font-weight:500">' + esc(a.recommendedAction || 'Review and acknowledge.') + '</p>' +
      '<div class="pro-actions">' + B('Contact driver', 'contact_driver', vehicleKind ? '' : 'nx-btn--primary') + B('Create coaching task', 'coaching_task', '') + B('Schedule maintenance', 'schedule_maintenance', vehicleKind ? 'nx-btn--primary' : '') + '</div>' +
      '<div class="pro-actions sec">' + B('Acknowledge <kbd>a</kbd>', 'ack', 'nx-btn--sm') + B('Dismiss <kbd>x</kbd>', 'dismiss', 'nx-btn--sm nx-btn--ghost') + '</div>' + (done ? '<p class="nx-faint" style="font-size:12px;margin-top:8px">This alert is ' + a.status + '.</p>' : '') + '</div></section>' +
      subjectCard(a) +
      (hist.length ? '<section class="pc"><div class="pc-h"><h4>Activity</h4></div><div class="pc-b"><ul class="nx-timeline">' + hist.slice().reverse().map(function (e, k) { return '<li class="nx-timeline__item is-' + esc(e.actor || 'system') + (k === 0 ? ' is-latest' : '') + '"><div class="nx-timeline__time">' + esc(e.t ? fmt.dateTime(e.t) : '') + ' &middot; ' + esc(e.actor || 'system') + '</div><div class="nx-timeline__action">' + esc(fmt.label(e.action || 'note')) + '</div>' + (e.note ? '<div class="nx-timeline__note">' + esc(e.note) + '</div>' : '') + '</li>'; }).join('') + '</ul></div></section>' : '') + '</div>';
    el.scrollTop = keep;
  }

  /* ---------- actions ---------- */
  function post(id, verb, body, ok) {
    S.busy['a_' + (body.action || verb)] = true; renderDetail();
    return api('/api/predict/alerts/' + encodeURIComponent(id) + '/' + verb, { method: 'POST', body: Object.assign({ actor: 'dispatcher' }, body) }).then(function (r) {
      var a = r && (r.alert || r); var cur = S.alerts.get(id);
      if (a && a.id) S.alerts.set(id, a); else if (cur) { cur.status = verb === 'ack' ? 'acknowledged' : verb === 'action' ? 'actioned' : 'dismissed'; }
      if (ok) NX.toast(ok, 'success'); return true;
    }).catch(function (e) { NX.toast(e.message, 'error'); }).then(function (x) { delete S.busy['a_' + (body.action || verb)]; renderList(); renderDetail(); drawMap(); paintCounts(); D.renderDetail(true); return x; });
  }
  var ACT = {
    contact_driver: ['Contact driver', 'Log the call', 'Called driver, discussed the flagged pattern and agreed on corrective steps.'],
    coaching_task: ['Create coaching task', 'Create task', 'Coaching task created for fleet safety manager: review flagged behaviors with the driver within 7 days.'],
    schedule_maintenance: ['Schedule maintenance', 'Schedule', 'Maintenance scheduled at next available bay before the unit returns to service.']
  };
  function doAction(key) {
    var a = S.alerts.get(S.selAlert); if (!a) return;
    var def = ACT[key], ta = NX.el('textarea.nx-textarea', {}); ta.value = def[2]; var m;
    var extra = '';
    var drv = null; D.inc.forEach(function (i) { if (a.subject && a.subject.type === 'driver' && i.driver && (i.driver.id === a.subject.id || i.driver.name === a.subject.name) && i.driver.phone) drv = i.driver; });
    var body = NX.el('div.nx-stack', NX.el('p.nx-dim', a.headline || ''), key === 'contact_driver' && drv ? NX.el('a.nx-btn', { href: 'tel:' + drv.phone }, 'Call ' + drv.name + ' ' + drv.phone) : null, NX.el('label.nx-label', 'Note (recorded on the alert)'), ta);
    m = NX.modal(def[0], body, { footer: [NX.el('button.nx-btn.nx-btn--ghost', { onclick: function () { m.close(); } }, 'Cancel'), NX.el('button.nx-btn.nx-btn--primary', { onclick: function () { m.close(); post(a.id, 'action', { action: key, note: ta.value.trim() || def[2] }, def[0] + ' recorded'); } }, def[1])] });
  }
  function act(key) {
    var a = S.alerts.get(S.selAlert); if (!a) return;
    if (ACT[key]) return doAction(key);
    if (key === 'ack') return post(a.id, 'ack', { note: 'Acknowledged by dispatcher' }, 'Alert acknowledged');
    if (key === 'dismiss') {
      var ta = NX.el('textarea.nx-textarea', { placeholder: 'Why is this not actionable?' }); var m;
      m = NX.modal('Dismiss alert', NX.el('div.nx-stack', NX.el('p.nx-dim', 'The model learns from dismissals. The alert is retained in history.'), ta), { footer: [NX.el('button.nx-btn.nx-btn--ghost', { onclick: function () { m.close(); } }, 'Cancel'), NX.el('button.nx-btn.nx-btn--danger', { onclick: function () { m.close(); post(a.id, 'dismiss', { note: ta.value.trim() || 'Not actionable' }, 'Alert dismissed'); } }, 'Dismiss')] });
    }
  }

  /* ---------- map overlay ---------- */
  function drawMap(focus) {
    var map = D.map(); if (!map || S.mode !== 'proactive') return;
    var L1 = D.layers(); L1.trail.clearLayers(); L1.prov.clearLayers();
    var info = getComputedStyle(document.documentElement).getPropertyValue('--nx-info').trim(), warn = getComputedStyle(document.documentElement).getPropertyValue('--nx-warn').trim();
    var pts = [], selB = [];
    sorted().forEach(function (a) {
      if (closed(a) && a.id !== S.selAlert) return;
      var c = coords(a); if (!c) return;
      var col = tone(a) === 'warn' ? warn : info, sel = a.id === S.selAlert;
      if (c.kind === 'hotspot') L.circle(c.ll, { radius: c.r || 5000, color: col, weight: sel ? 2 : 1, dashArray: '6 6', fillColor: col, fillOpacity: sel ? .18 : .08 }).addTo(L1.prov);
      else if (c.r) L.circle(c.ll, { radius: c.r, color: col, weight: 1, dashArray: '6 6', fillColor: col, fillOpacity: .08 }).addTo(L1.prov);
      var m = L.marker(c.ll, { icon: L.divIcon({ className: '', iconSize: [26, 26], iconAnchor: [13, 13], html: '<div class="wk' + (sel ? ' sel' : '') + ' ' + tone(a) + '"><i></i></div>' }), zIndexOffset: sel ? 900 : 0 });
      m.bindTooltip(esc(a.headline || KINDS[a.kind]) + ' · ' + (pct(a.probability) || '--') + '%', { className: 'nx-tip', direction: 'top', offset: [0, -10] });
      m.on('click', function () { selectAlert(a.id); }); m.addTo(L1.prov);
      pts.push(c.ll); if (sel) { selB.push(c.ll); if (c.kind === 'hotspot') selB.push([c.ll[0] + .04, c.ll[1] + .04], [c.ll[0] - .04, c.ll[1] - .04]); }
    });
    if (focus && selB.length) { if (selB.length > 1) map.fitBounds(L.latLngBounds(selB).pad(.4), { maxZoom: 11 }); else map.setView(selB[0], Math.max(map.getZoom(), 9)); }
    else if (focus && pts.length && !S.selAlert) map.fitBounds(L.latLngBounds(pts).pad(.3), { maxZoom: 8 });
  }

  /* ---------- "we warned you" banner for live incidents ---------- */
  function priorFor(i) {
    var best = null, t0 = new Date(i.timestamp || i.receivedAt).getTime();
    S.alerts.forEach(function (a) {
      var s = a.subject || {}; if (a.status === 'dismissed') return;
      var m = (s.type === 'driver' && i.driver && (s.id === i.driver.id || (s.name && s.name === i.driver.name))) || (s.type === 'vehicle' && i.vehicle && (s.id === i.vehicle.id || (s.name && (s.name === i.vehicle.unit || s.name === i.vehicle.plate))));
      var ts = new Date(a.createdAt).getTime(); if (!m || !(ts < t0)) return;
      if (!best || ts > new Date(best.createdAt).getTime()) best = a;
    });
    return best;
  }
  function banner(i) {
    var a = priorFor(i); if (!a) return '';
    var days = Math.max(0, Math.round((new Date(i.timestamp || i.receivedAt) - new Date(a.createdAt)) / 86400000)), p = pct(a.probability);
    return '<div class="pred-banner"><div class="pred-ic">◌</div><div class="nx-grow"><b>Predicted &middot; we warned about this ' + (days === 0 ? 'earlier today' : days + (days === 1 ? ' day' : ' days') + ' ago') + '</b><span>' + esc(a.headline || KINDS[a.kind]) + (p != null ? ' (' + p + '% likely)' : '') + '. Alert status: ' + esc(a.status) + (a.status === 'open' ? ' &mdash; never acted on' : '') + '.</span></div><button class="nx-btn nx-btn--sm" data-gotoalert="' + esc(a.id) + '">View alert</button></div>';
  }

  /* ---------- wiring ---------- */
  function init(d) {
    D = d; S = d.S; S.alerts = new Map(); S.newAlerts = new Set(); S.af = { status: 'open', kind: '', fleet: '' }; S.selAlert = null;
    $('#pro-chips').addEventListener('click', function (e) { var b = e.target.closest('[data-ast]'); if (!b) return; S.af.status = b.dataset.ast; renderList(); drawMap(); });
    $('#f-kind').addEventListener('change', function (e) { S.af.kind = e.target.value; renderList(); drawMap(); });
    $('#q-list').addEventListener('click', function (e) { var r = e.target.closest('[data-aid]'); if (r) { selectAlert(r.dataset.aid); if (window.innerWidth <= 1100) D.setView('detail'); } });
    $('#detail').addEventListener('click', function (e) { var b = e.target.closest('[data-aact]'); if (b && S.mode === 'proactive') act(b.dataset.aact); var g = e.target.closest('[data-gotoalert]'); if (g) { D.setMode('proactive'); selectAlert(g.dataset.gotoalert); } });
    load();
  }
  function nav(dir) { var l = sorted(); if (!l.length) return; var k = l.findIndex(function (a) { return a.id === S.selAlert; }); k = k < 0 ? 0 : Math.max(0, Math.min(l.length - 1, k + dir)); selectAlert(l[k].id); }
  function key(k) {
    if (k === 'j' || k === 'ArrowDown') nav(1); else if (k === 'k' || k === 'ArrowUp') nav(-1);
    else if (k === 'a') act('ack'); else if (k === 'x') act('dismiss'); else if (k === 'c') act('contact_driver'); else return false;
    return true;
  }
  window.NXPro = { init: init, renderList: renderList, renderDetail: renderDetail, drawMap: drawMap, upsert: upsert, key: key, banner: banner, load: load, paintCounts: paintCounts, selectAlert: selectAlert };
})();
