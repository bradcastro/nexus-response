/* Nexus Response — Dispatch Center */
(function () {
  'use strict';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var esc = NX.esc, fmt = NX.fmt;
  var SEV_RANK = { critical: 0, high: 1, medium: 2, low: 3 };
  var CLOSED = { resolved: 1, dismissed: 1 };
  var STATUS_LIST = ['pending', 'validating', 'dispatched', 'en_route', 'on_scene', 'resolved', 'dismissed'];
  var CATS = ['collision', 'safety', 'diagnostic', 'roadside'];

  var S = {
    inc: new Map(),          // id -> incident
    sel: null,               // selected id
    filters: { status: 'open', sev: '', cat: '', fleet: '', q: '' },
    fleets: [],
    providers: [],           // providers near selected incident
    provFor: null,
    pick: null,              // picked providerId
    loading: true, error: null,
    sound: true, follow: false,
    noteDraft: {}, busy: {}, camTab: 'road',
    newIds: new Set()
  };
  try { S.sound = localStorage.getItem('nx-dispatch-sound') !== '0'; } catch (e) {}

  /* ---------- helpers ---------- */
  var isClosed = function (i) { return !!CLOSED[i.status]; };
  var title = function (i) { return fmt.label(i.eventType || 'event'); };
  var unit = function (i) { var v = i.vehicle || {}; return v.unit || v.name || v.plate || v.id || 'Unit'; };
  var addr = function (i) { var l = i.location || {}; return l.address || (l.lat != null ? l.lat.toFixed(4) + ', ' + l.lng.toFixed(4) : 'Location unknown'); };
  var vlabel = function (v) { v = v || {}; return [v.year, v.make, v.model].filter(Boolean).join(' ') || 'Vehicle'; };
  var verdict = function (i) { return i.camera && i.camera.aiVerdict; };
  var isFP = function (i) { return verdict(i) === 'false_positive'; };
  var sevColor = function (s) { return NX.sevColor(s, true); };
  var pct = function (c) { c = Number(c); return isNaN(c) ? null : Math.round((c <= 1 ? c * 100 : c)); };
  function group(i) { return isClosed(i) ? 2 : (i.status === 'pending' || i.status === 'validating') ? 0 : 1; }
  function cmp(a, b) {
    return group(a) - group(b) || (SEV_RANK[a.severity] - SEV_RANK[b.severity]) ||
      (new Date(b.timestamp || b.receivedAt) - new Date(a.timestamp || a.receivedAt));
  }
  function ageMin(i) { return (Date.now() - new Date(i.receivedAt || i.timestamp)) / 60000; }
  function api(p, o) { return NX.api(p, o); }
  function listFrom(d, key) { return Array.isArray(d) ? d : (d && d[key]) || []; }

  /* ---------- top bar ---------- */
  var clock = NX.el('div.tb-clock', NX.el('span#clk-t', '--:--:--'), NX.el('small#clk-d', ''));
  var soundBtn = NX.el('button.nx-icon-btn', { title: 'Alert sound', 'aria-label': 'Toggle alert sound', onclick: function () { S.sound = !S.sound; try { localStorage.setItem('nx-dispatch-sound', S.sound ? '1' : '0'); } catch (e) {} paintSound(); if (S.sound) beep(1); } }, '');
  var helpBtn = NX.el('button.nx-icon-btn.tb-hide-tablet', { title: 'Keyboard shortcuts (?)', onclick: showHelp }, '?');
  NX.topbar('Dispatch', { sidebar: false, right: [clock, soundBtn, helpBtn] });
  function paintSound() { soundBtn.textContent = S.sound ? '♪' : 'Ø'; soundBtn.style.color = S.sound ? 'var(--nx-accent)' : ''; soundBtn.title = 'Alert sound ' + (S.sound ? 'on' : 'off'); }
  paintSound();
  function tick() {
    var d = new Date();
    $('#clk-t').textContent = d.toLocaleTimeString('en-US', { hour12: false });
    $('#clk-d').textContent = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).toUpperCase();
  }
  tick(); setInterval(tick, 1000);

  /* ---------- audio alert ---------- */
  var actx;
  function beep(n) {
    if (!S.sound) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      var t = actx.currentTime;
      for (var k = 0; k < (n || 3); k++) {
        var o = actx.createOscillator(), g = actx.createGain();
        o.type = 'square'; o.frequency.value = k % 2 ? 660 : 880;
        g.gain.setValueAtTime(0.0001, t + k * 0.18); g.gain.exponentialRampToValueAtTime(0.06, t + k * 0.18 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + k * 0.18 + 0.15);
        o.connect(g); g.connect(actx.destination); o.start(t + k * 0.18); o.stop(t + k * 0.18 + 0.16);
      }
    } catch (e) { /* autoplay blocked */ }
  }

  /* ---------- queue ---------- */
  function counts() {
    var c = { all: 0, open: 0 };
    STATUS_LIST.forEach(function (s) { c[s] = 0; });
    S.inc.forEach(function (i) { c.all++; c[i.status] = (c[i.status] || 0) + 1; if (!isClosed(i)) c.open++; });
    return c;
  }
  function filtered() {
    var f = S.filters, q = f.q.trim().toLowerCase();
    var out = [];
    S.inc.forEach(function (i) {
      if (f.status === 'open' ? isClosed(i) : (f.status !== 'all' && i.status !== f.status)) return;
      if (f.sev && i.severity !== f.sev) return;
      if (f.cat && i.category !== f.cat) return;
      if (f.fleet && i.fleetId !== f.fleet) return;
      if (q) {
        var v = i.vehicle || {}, d = i.driver || {};
        var hay = [i.id, i.fleetName, i.eventType, v.plate, v.vin, v.make, v.model, v.unit, d.name, (i.location || {}).address].join(' ').toLowerCase();
        if (hay.indexOf(q) < 0) return;
      }
      out.push(i);
    });
    return out.sort(cmp);
  }
  function chips() {
    var c = counts(), el = $('#status-chips');
    var items = [['open', 'Open'], ['all', 'All']].concat(STATUS_LIST.map(function (s) { return [s, fmt.label(s)]; }));
    el.innerHTML = items.map(function (it) {
      return '<button class="nx-chip' + (S.filters.status === it[0] ? ' is-active' : '') + '" data-st="' + it[0] + '">' + esc(it[1]) + ' <b>' + (c[it[0]] || 0) + '</b></button>';
    }).join('');
  }
  function fillSelects() {
    $('#f-sev').innerHTML = '<option value="">All severity</option>' + NX.severities.map(function (s) { return '<option value="' + s + '">' + fmt.label(s) + '</option>'; }).join('');
    $('#f-cat').innerHTML = '<option value="">All categories</option>' + CATS.map(function (s) { return '<option value="' + s + '">' + fmt.label(s) + '</option>'; }).join('');
    paintFleetSelect();
  }
  function paintFleetSelect() {
    var m = new Map();
    S.fleets.forEach(function (f) { m.set(f.id, f.name); });
    S.inc.forEach(function (i) { if (i.fleetId && !m.has(i.fleetId)) m.set(i.fleetId, i.fleetName || i.fleetId); });
    var cur = S.filters.fleet;
    $('#f-fleet').innerHTML = '<option value="">All fleets</option>' + Array.from(m).map(function (e) { return '<option value="' + esc(e[0]) + '"' + (e[0] === cur ? ' selected' : '') + '>' + esc(e[1]) + '</option>'; }).join('');
  }
  function rowHTML(i) {
    var a = ageMin(i), late = !isClosed(i) && (i.status === 'pending' || i.status === 'validating') && ((i.severity === 'critical' && a > 2) || (i.severity === 'high' && a > 5));
    var cam = i.camera && i.camera.aiVerdict !== 'no_video' ? i.camera : null, tags = '';
    if (isFP(i)) tags += '<span class="tag bad">False positive</span>';
    else if (cam && cam.verified) tags += '<span class="tag ok">Cam verified ' + (pct(cam.confidence) != null ? pct(cam.confidence) + '%' : '') + '</span>';
    else if (cam) tags += '<span class="tag warn">Cam review</span>';
    var dt = i.diagnostics && i.diagnostics.dtcs;
    if (dt && dt.length) tags += '<span class="tag warn">' + dt.length + ' DTC</span>';
    if (i.roadside && i.roadside.needed) tags += '<span class="tag acc">' + esc(fmt.label(i.roadside.serviceType || 'roadside')) + '</span>';
    if (i.warranty && i.warranty.claimEligible) tags += '<span class="tag ok">Warranty</span>';
    return '<div class="qrow' + (S.sel === i.id ? ' is-selected' : '') + (isClosed(i) ? ' is-closed' : '') + (i.severity === 'critical' && !isClosed(i) ? ' is-crit-open' : '') + (S.newIds.has(i.id) ? ' nx-new' : '') +
      '" data-id="' + esc(i.id) + '" style="--c:' + sevColor(i.severity) + '" tabindex="-1">' +
      '<div class="qr-top">' + NX.badgeHTML(i.severity) + NX.badgeHTML(i.status) + '<span class="qr-age' + (late ? ' is-late' : '') + '">' + (isClosed(i) ? fmt.ago(i.receivedAt || i.timestamp) : fmt.ago(i.receivedAt || i.timestamp)) + '</span></div>' +
      '<div class="qr-title">' + esc(title(i)) + ' &middot; ' + esc(unit(i)) + '</div>' +
      '<div class="qr-sub">' + esc(i.fleetName || '') + ' &middot; ' + esc((i.driver || {}).name || 'Unassigned driver') + '</div>' +
      '<div class="qr-sub">' + esc(addr(i)) + '</div>' +
      '<div class="qr-tags"><span class="qr-id">' + esc(i.id) + '</span>' + tags + '<span class="tag">' + esc(i.provider || '') + '</span></div></div>';
  }
  function renderQueue() {
    chips();
    var list = filtered(), box = $('#q-list');
    $('#q-shown').textContent = list.length + ' shown';
    if (S.loading) { box.innerHTML = '<div class="sk">' + [1, 2, 3, 4, 5].map(function () { return '<span class="nx-skel nx-skel--block"></span>'; }).join('') + '</div>'; return; }
    if (S.error) { box.innerHTML = ''; box.appendChild(NX.empty('Cannot load incidents', S.error, '!')); var b = NX.el('button.nx-btn.nx-btn--primary.nx-btn--sm', { onclick: load }, 'Retry'); box.firstChild.appendChild(b); return; }
    if (!list.length) { box.innerHTML = ''; box.appendChild(NX.empty(S.inc.size ? 'No incidents match' : 'Queue is clear', S.inc.size ? 'Adjust the filters above.' : 'New events appear here the moment they arrive.')); return; }
    var top = box.scrollTop;
    box.innerHTML = list.map(rowHTML).join('');
    box.scrollTop = top;
    S.newIds.clear();
    var el = box.querySelector('.is-selected'); if (el && S._scrollSel) { el.scrollIntoView({ block: 'nearest' }); S._scrollSel = false; }
  }
  function renderHud() {
    var o = [], crit = 0, un = 0, act = 0;
    S.inc.forEach(function (i) { if (isClosed(i)) return; o.push(i); if (i.severity === 'critical') crit++; if (i.status === 'pending' || i.status === 'validating') un++; else act++; });
    $('#hud-stats').innerHTML = [['Open', o.length], ['Critical', crit], ['Unassigned', un], ['In progress', act]].map(function (x) { return '<div class="hud-stat"><b' + (x[0] === 'Critical' && x[1] ? ' style="color:var(--nx-sev-critical)"' : '') + '>' + x[1] + '</b><span>' + x[0] + '</span></div>'; }).join('');
  }

  /* ---------- map ---------- */
  var map, tileLayer, markers = new Map(), trailLayer, provLayer, routeLayer;
  function initMap() {
    if (!window.L) { $('#map').innerHTML = '<div class="nx-empty"><div class="nx-empty__title">Map library unavailable</div><p>Leaflet failed to load (offline?). The queue still works.</p></div>'; return; }
    map = L.map('map', { zoomControl: false, attributionControl: true, preferCanvas: false }).setView([32.5, -90], 5);
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    setTiles();
    trailLayer = L.layerGroup().addTo(map); provLayer = L.layerGroup().addTo(map);
    document.addEventListener('nx:theme', setTiles);
    if (window.ResizeObserver) new ResizeObserver(function () { map.invalidateSize(); }).observe($('#map'));
  }
  function setTiles() {
    if (!map) return;
    if (tileLayer) map.removeLayer(tileLayer);
    tileLayer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, className: 'osm-tiles', attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);
  }
  function mkIcon(i) {
    var sel = S.sel === i.id, cls = 'mk' + (i.severity === 'critical' && !isClosed(i) ? ' crit' : '') + (sel ? ' sel' : '') + (isClosed(i) ? ' closed' : '');
    return L.divIcon({ className: '', iconSize: [22, 22], iconAnchor: [11, 11], html: '<div class="' + cls + '" style="--c:' + sevColor(i.severity) + '"><i></i></div>' });
  }
  function syncMarkers() {
    if (!map) return;
    var show = new Set(filtered().map(function (i) { return i.id; }));
    if (S.sel) show.add(S.sel);
    markers.forEach(function (m, id) { if (!show.has(id) || !S.inc.has(id)) { map.removeLayer(m); markers.delete(id); } });
    show.forEach(function (id) {
      var i = S.inc.get(id); if (!i || !i.location || i.location.lat == null) return;
      var ll = [i.location.lat, i.location.lng], m = markers.get(id);
      if (!m) {
        m = L.marker(ll, { icon: mkIcon(i), zIndexOffset: SEV_RANK[i.severity] === 0 ? 500 : 0 }).addTo(map);
        m.on('click', function () { select(id, { view: 'detail' }); });
        markers.set(id, m);
      } else { m.setLatLng(ll); m.setIcon(mkIcon(i)); }
      m.unbindTooltip().bindTooltip(esc(title(i) + ' · ' + unit(i)), { className: 'nx-tip', direction: 'top', offset: [0, -10] });
      m.setZIndexOffset(S.sel === id ? 1000 : (i.severity === 'critical' ? 500 : 0));
    });
  }
  function fitAll() {
    if (!map) return;
    var pts = [];
    markers.forEach(function (m) { pts.push(m.getLatLng()); });
    if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.25), { maxZoom: 9, animate: true });
  }
  function drawSelection() {
    if (!map) return;
    trailLayer.clearLayers(); provLayer.clearLayers();
    var i = S.inc.get(S.sel); if (!i || !i.location) return;
    var c = sevColor(i.severity), bounds = [[i.location.lat, i.location.lng]];
    var tr = (i.trail || []).filter(function (p) { return p.lat != null; });
    if (tr.length > 1) {
      var pts = tr.map(function (p) { return [p.lat, p.lng]; });
      L.polyline(pts, { color: c, weight: 7, opacity: 0.18 }).addTo(trailLayer);
      L.polyline(pts, { color: c, weight: 3, opacity: 0.95, dashArray: '1 0' }).addTo(trailLayer);
      tr.forEach(function (p, k) { if (k % Math.max(1, Math.floor(tr.length / 8)) === 0) L.circleMarker([p.lat, p.lng], { radius: 3, color: c, fillColor: c, fillOpacity: 1, weight: 1 }).bindTooltip(fmt.time(p.t) + (p.speed_mph != null ? ' · ' + Math.round(p.speed_mph) + ' mph' : ''), { className: 'nx-tip' }).addTo(trailLayer); });
      bounds = bounds.concat(pts);
    }
    var rec = (i.roadside && (i.roadside.assignedProvider || i.roadside.recommendedProvider)) || {};
    S.providers.slice(0, 6).forEach(function (p) {
      if (p.lat == null || p.lng == null) return;
      var isRec = p.id === S.pick || p.id === rec.id;
      var m = L.marker([p.lat, p.lng], { icon: L.divIcon({ className: '', iconSize: [26, 26], iconAnchor: [13, 13], html: '<div class="pk' + (isRec ? ' rec' : '') + '"><i>' + esc((p.name || 'P').charAt(0)) + '</i></div>' }) });
      m.bindTooltip(esc(p.name || 'Provider') + (p.etaMin != null ? ' · ETA ' + Math.round(p.etaMin) + ' min' : ''), { className: 'nx-tip', direction: 'top', permanent: isRec, offset: [0, -10] });
      m.on('click', function () { S.pick = p.id; renderDetail(); drawSelection(); });
      m.addTo(provLayer);
      if (isRec) { L.polyline([[p.lat, p.lng], [i.location.lat, i.location.lng]], { color: getComputedStyle(document.documentElement).getPropertyValue('--nx-accent').trim(), weight: 2, dashArray: '6 8', opacity: .9 }).addTo(provLayer); bounds.push([p.lat, p.lng]); }
    });
    S._bounds = bounds;
  }
  function focusSelection() {
    if (!map) return;
    if (!S._bounds || !S._bounds.length) return fitAll();
    if (S._bounds.length > 1) map.fitBounds(L.latLngBounds(S._bounds).pad(0.3), { maxZoom: 14, animate: true });
    else map.setView(S._bounds[0], Math.max(map.getZoom(), 12), { animate: true });
  }

  /* ---------- selection / data ---------- */
  function setView(v) {
    $('#dc').dataset.view = v;
    document.querySelectorAll('.view-tabs button').forEach(function (b) { b.classList.toggle('is-active', b.dataset.view === v); });
    if (v === 'map' && map) setTimeout(function () { map.invalidateSize(); focusSelection(); }, 50);
  }
  function select(id, o) {
    o = o || {};
    S.sel = id; S._scrollSel = true;
    if (!o.noHash) { try { history.replaceState(null, '', '#' + encodeURIComponent(id)); } catch (e) {} }
    var cached = S.inc.get(id);
    S.pick = null; S.providers = []; S.provFor = null; S.camTab = 'road';
    renderQueue(); renderDetail(); syncMarkers();
    if (cached) { afterSelect(cached); }
    if (o.view && window.innerWidth <= 1100) setView(o.view);
    api('/api/incidents/' + encodeURIComponent(id)).then(function (full) {
      if (!full || !full.id) return;
      S.inc.set(full.id, full);
      if (S.sel === id) { afterSelect(full); renderDetail(); renderQueue(); syncMarkers(); }
    }).catch(function (e) {
      if (S.sel === id && !cached) { S.detailError = e.message; renderDetail(); }
    });
  }
  function afterSelect(i) {
    drawSelection(); focusSelection();
    if (i.location && i.location.lat != null && S.provFor !== i.id) {
      S.provFor = i.id;
      api('/api/providers', { query: { lat: i.location.lat, lng: i.location.lng, service: (i.roadside && i.roadside.serviceType && i.roadside.serviceType !== 'none') ? i.roadside.serviceType : '', limit: 8 } }).then(function (d) {
        if (S.sel !== i.id) return;
        S.providers = listFrom(d, 'providers');
        var rr = i.roadside || {};
        [rr.assignedProvider, rr.recommendedProvider].concat(rr.alternatives || []).forEach(function (x) { if (x && x.id && !S.providers.some(function (p) { return p.id === x.id; })) { var full = x; S.providers.push(full); } });
        S.providers.sort(function (a, b) { return (a.etaMin == null) - (b.etaMin == null) || a.etaMin - b.etaMin; });
        var r = i.roadside || {};
        S.pick = (r.assignedProvider || r.recommendedProvider || S.providers[0] || {}).id || null;
        renderDetail(); drawSelection();
      }).catch(function () { /* optional */ });
    }
  }
  function nav(dir) {
    var l = filtered(); if (!l.length) return;
    var k = l.findIndex(function (i) { return i.id === S.sel; });
    k = k < 0 ? (dir > 0 ? 0 : l.length - 1) : Math.max(0, Math.min(l.length - 1, k + dir));
    select(l[k].id);
  }
  function upsert(i, fromStream) {
    if (!i || !i.id) return;
    var prev = S.inc.get(i.id);
    S.inc.set(i.id, i);
    if (fromStream) {
      var isNew = !prev;
      if (isNew) S.newIds.add(i.id);
      var critNow = i.severity === 'critical' && !isClosed(i);
      if (critNow && (isNew || prev.severity !== 'critical')) criticalAlert(i);
      else if (isNew) NX.toast(title(i) + ' · ' + unit(i) + ' (' + (i.fleetName || '') + ')', 'info', 3500);
    }
    paintFleetSelect();
    renderQueue(); renderHud(); syncMarkers();
    if (S.sel === i.id) { drawSelection(); renderDetail(); }
  }
  var flashTimer;
  function criticalAlert(i) {
    beep(3);
    var a = $('#q-alert');
    a.className = 'q-alert';
    a.innerHTML = '<b>CRITICAL</b><span>' + esc(title(i)) + ' &middot; ' + esc(unit(i)) + ' &middot; ' + esc(i.fleetName || '') + '</span>';
    a.onclick = function () { select(i.id, { view: 'detail' }); a.classList.add('nx-hide'); };
    var orig = document.title, n = 0;
    clearInterval(flashTimer);
    flashTimer = setInterval(function () { document.title = (n++ % 2 ? '' : '● CRITICAL · ') + 'Dispatch Center · Nexus Response'; if (n > 12) { clearInterval(flashTimer); document.title = orig; } }, 700);
    NX.toast('Critical: ' + title(i) + ' · ' + unit(i), 'critical', 6000);
  }

  function load() {
    S.loading = true; S.error = null; renderQueue();
    return api('/api/incidents', { query: { limit: 300 } }).then(function (d) {
      S.inc.clear(); listFrom(d, 'incidents').forEach(function (i) { S.inc.set(i.id, i); });
      S.loading = false; S.error = null;
      paintFleetSelect(); renderQueue(); renderHud(); syncMarkers();
      var h = decodeURIComponent((location.hash || '').slice(1));
      if (h && !S.sel) select(h, { noHash: true, view: 'detail' });
      else if (!S.sel && !h) { if (!S._fitted) { S._fitted = true; fitAll(); } }
      else if (S.sel) renderDetail();
      if (!S._fitted && !h) { S._fitted = true; fitAll(); }
    }).catch(function (e) { S.loading = false; S.error = e.message; renderQueue(); });
  }

  /* ---------- actions ---------- */
  function act(kind, path, body, okMsg) {
    var id = S.sel; if (!id) return Promise.resolve();
    var key = kind; S.busy[key] = true; renderDetail();
    return api('/api/incidents/' + encodeURIComponent(id) + path, { method: 'POST', body: body || {} }).then(function (r) {
      var inc = r && (r.incident || r); if (inc && inc.id) upsert(inc);
      if (okMsg) NX.toast(okMsg, 'success');
      return inc;
    }).catch(function (e) { NX.toast(e.message, 'error'); }).then(function (x) { delete S.busy[key]; renderDetail(); return x; });
  }
  function doDispatch() {
    var i = S.inc.get(S.sel); if (!i) return;
    if (isClosed(i)) return NX.toast('Incident is ' + i.status, 'warn');
    var pid = S.pick || ((i.roadside || {}).recommendedProvider || {}).id;
    var p = S.providers.find(function (x) { return x.id === pid; }) || (i.roadside || {}).recommendedProvider || {};
    act('dispatch', '/dispatch', { providerId: pid, note: 'Dispatched via console' }, 'Dispatched ' + (p.name || 'provider') + (p.etaMin != null ? ' · ETA ' + Math.round(p.etaMin) + ' min' : ''));
  }
  function doDismiss(reason) {
    var i = S.inc.get(S.sel); if (!i) return;
    if (reason) return act('dismiss', '/dismiss', { reason: reason }, 'Incident dismissed');
    var ta = NX.el('textarea.nx-textarea', { placeholder: 'Reason (logged to timeline)' });
    ta.value = isFP(i) ? 'False positive - camera review: ' + fmt.label(verdict(i)) : '';
    var m;
    var ok = NX.el('button.nx-btn.nx-btn--danger', { onclick: function () { if (!ta.value.trim()) { ta.focus(); return; } m.close(); doDismiss(ta.value.trim()); } }, 'Dismiss incident');
    m = NX.modal('Dismiss ' + i.id, NX.el('div.nx-stack', NX.el('p.nx-dim', 'Removes it from the active queue. The record is retained.'), ta), { footer: [NX.el('button.nx-btn.nx-btn--ghost', { onclick: function () { m.close(); } }, 'Cancel'), ok] });
    setTimeout(function () { ta.focus(); ta.select(); }, 30);
  }
  function showHelp() {
    var rows = [['j / k', 'Next / previous incident'], ['d', 'Dispatch selected provider'], ['x', 'Dismiss incident'], ['1 / 2 / 3', 'Mark en route / on scene / resolved'], ['n', 'Add note'], ['/', 'Search queue'], ['f', 'Fit map to all'], ['Esc', 'Clear selection / close']];
    NX.modal('Keyboard shortcuts', NX.el('div.help-grid', rows.map(function (r) { return [NX.el('kbd', r[0]), NX.el('span', r[1])]; })));
  }

  /* ---------- detail ---------- */
  var detailEl = $('#detail');
  function btn(label, cls, a, extra, k) { return '<button class="nx-btn ' + cls + (S.busy[k || a] ? ' is-loading' : '') + '" data-act="' + a + '"' + (extra || '') + '>' + label + '</button>'; }
  function panel(t, right, body, id) { return '<section class="pc"' + (id ? ' id="' + id + '"' : '') + '><div class="pc-h"><h4>' + t + '</h4>' + (right || '') + '</div><div class="pc-b">' + body + '</div></section>'; }
  var CAM_SVG = '<svg viewBox="0 0 200 100" fill="none" stroke="currentColor" stroke-width="1.2"><path d="M20 100 L85 20 M180 100 L115 20 M100 100 L100 62 M100 50 L100 38" /><rect x="68" y="58" width="64" height="26" rx="3" stroke-dasharray="3 3"/><path d="M62 54 v-8 h8 M138 54 v-8 h-8 M62 88 v8 h8 M138 88 v8 h-8"/></svg>';

  function v0(c) { return c && c.aiVerdict; }
  function camHTML(i) {
    var c = i.camera;
    if (!c || v0(c) === 'no_video') return panel('Camera verification', NX.badgeHTML('No camera', 'plain'), '<p class="nx-dim">No camera is attached to this vehicle. Event is telematics-only and has not been visually verified.</p>');
    var v = verdict(i), conf = pct(c.confidence), fp = isFP(i);
    var clips = (c.clips || []), snaps = (c.snapshots || []);
    var clip = clips.filter(function (x) { return x.url && (x.type || 'road') === S.camTab; })[0] || clips.filter(function (x) { return x.url; })[0];
    var snap = snaps.filter(function (x) { return x.url && (x.type || 'road') === S.camTab; })[0] || snaps.filter(function (x) { return x.url; })[0];
    var isVid = function (u) { return /\.(mp4|webm|mov)(\?|$)/i.test(u); };
    var mu = clip && clip.url, su = snap && snap.url;
    var media = mu && isVid(mu) ? '<video src="' + esc(mu) + '" controls muted playsinline' + (su && !isVid(su) ? ' poster="' + esc(su) + '"' : '') + '></video>'
      : (mu || su) ? '<img src="' + esc(mu || su) + '" alt="Event frame" onerror="this.replaceWith(Object.assign(document.createElement(\'div\'),{className:\'cam-ph\'}))">'
      : '<div class="cam-ph">' + CAM_SVG + '</div>';
    var dur = (clips[0] || {}).durationSec;
    var hud = '<div class="cam-hud top"><span class="' + (clip ? 'rec' : '') + '">' + (clip || snap ? 'CLIP' : 'NO MEDIA ATTACHED') + ' &middot; ' + esc(String(S.camTab).toUpperCase()) + ' CAM</span><span>' + esc((c.provider || i.provider || '').toUpperCase()) + '</span></div>' +
      '<div class="cam-hud bot"><span>' + esc(fmt.dateTime(i.timestamp)) + '</span><span>' + (dur ? dur + 's' : '') + '</span></div>';
    var stamp = fp ? '<div class="stamp bad">False positive</div>' : c.verified ? '<div class="stamp">Verified</div>' : '<div class="stamp warn">Unverified</div>';
    var hasDriver = clips.concat(snaps).some(function (x) { return x.type === 'driver'; });
    var tabs = hasDriver || clips.length > 1 ? '<div class="cam-tabs"><button class="nx-chip' + (S.camTab === 'road' ? ' is-active' : '') + '" data-cam="road">Road facing</button><button class="nx-chip' + (S.camTab === 'driver' ? ' is-active' : '') + '" data-cam="driver">Driver facing</button></div>' : '';
    var col = fp ? 'var(--nx-danger)' : conf >= 85 ? 'var(--nx-ok)' : conf >= 60 ? 'var(--nx-warn)' : 'var(--nx-sev-high)';
    var banner = fp ? '<div class="fp-banner"><div><b>Likely false positive</b><span>Camera AI does not support this event' + (conf != null ? ' (' + conf + '% confidence)' : '') + '. Dispatch is not recommended.</span></div>' + btn('Dismiss <kbd>x</kbd>', 'nx-btn--danger nx-btn--sm', 'fpdismiss', '', 'dismiss') + '</div>' : '';
    return panel('Camera verification', NX.badgeHTML(c.verified ? 'Verified' : fp ? 'False positive' : 'Unverified', c.verified ? 'ok' : fp ? 'danger' : 'warn'),
      banner + tabs + '<div class="cam">' + media + hud + stamp + '</div>' +
      '<div class="conf"><div class="conf-row"><span class="nx-eyebrow">AI verdict</span><b>' + esc(fmt.label(v || 'pending')) + '</b></div>' +
      '<div class="conf-row"><span class="nx-eyebrow">Confidence</span><b style="color:' + col + '">' + (conf != null ? conf + '%' : '--') + '</b></div>' +
      '<div class="nx-meter"><i style="width:' + (conf || 0) + '%;--c:' + col + '"></i></div></div>' +
      ((c.signals || []).length ? '<div class="sigs">' + c.signals.map(function (s) { return '<span class="sig">' + esc(s) + '</span>'; }).join('') + '</div>' : ''), 'cam');
  }
  function dtcHTML(i) {
    var d = i.diagnostics;
    if (!d || !(d.dtcs || []).length) return panel('Trouble codes', NX.badgeHTML('None', 'plain'), '<p class="nx-dim">No active fault codes reported with this event.</p>');
    var dr = { yes: ['var(--nx-ok)', 'Drivable', 'Vehicle can continue to destination or shop.'], limp: ['var(--nx-warn)', 'Limp mode', 'Reduced power. Drive only to nearest safe location.'], no: ['var(--nx-danger)', 'Not drivable', 'Do not move. Tow or mobile repair required.'] }[d.drivable] || ['var(--nx-text-faint)', 'Unknown', ''];
    var rows = d.dtcs.map(function (x) {
      return '<tr><td class="code">' + esc(x.code) + (x.spn != null && String(x.code).indexOf('SPN') < 0 ? '<div class="nx-faint" style="font-size:10.5px;font-weight:400">SPN ' + esc(x.spn) + ' / FMI ' + esc(x.fmi) + '</div>' : '') + '</td><td><div>' + esc(x.desc) + '</div>' +
        (x.recommendedAction ? '<div class="act">&#9656; ' + esc(x.recommendedAction) + '</div>' : '') + (x.partsHint ? '<div class="parts">Parts: ' + esc(x.partsHint) + '</div>' : '') +
        '</td><td>' + esc(x.system || '') + '</td><td>' + NX.badgeHTML(x.severity || 'low') + '</td></tr>';
    }).join('');
    return panel('Trouble codes', '<span class="nx-mono nx-faint" style="font-size:11px">' + (d.engineHours != null ? fmt.number(d.engineHours) + ' eng h' : '') + '</span>',
      '<div class="drive" style="--c:' + dr[0] + '"><span class="lamp" style="' + (d.faultLampOn ? '' : 'background:var(--nx-text-faint);box-shadow:none') + '" title="Fault lamp"></span><div><b>' + dr[1] + '</b><br><span>' + dr[2] + (d.faultLampOn ? ' Fault lamp on.' : '') + '</span></div></div>' +
      '<table class="dtc"><thead><tr><th>Code</th><th>Decoded</th><th>System</th><th>Sev</th></tr></thead><tbody>' + rows + '</tbody></table>');
  }
  function roadsideHTML(i) {
    var r = i.roadside || {}, asg = r.assignedProvider, rec = r.recommendedProvider, closed = isClosed(i);
    if (!r.needed && !asg && !rec && !S.providers.length) return panel('Roadside', NX.badgeHTML('Not needed', 'plain'), '<p class="nx-dim">No roadside service required for this event type.</p>');
    var shown = asg || rec;
    var top = shown ? '<div class="rec-prov"><div class="nx-grow"><div class="nx-eyebrow">' + (asg ? 'Assigned provider' : 'Recommended provider') + '</div><div style="font-weight:600;margin-top:5px">' + esc(shown.name) + '</div><div class="nx-dim" style="font-size:12px">' + esc(fmt.label(r.serviceType || 'service')) + (shown.distanceMi != null ? ' &middot; ' + shown.distanceMi + ' mi' : '') + '</div></div><div class="eta"><b>' + (shown.etaMin != null ? Math.round(shown.etaMin) : (r.etaMin != null ? Math.round(r.etaMin) : '--')) + '</b><span>ETA MIN</span></div></div>' : '<p class="nx-dim">Service type: ' + esc(fmt.label(r.serviceType || 'unspecified')) + '. No provider recommended yet.</p>';
    var provs = S.providers.slice(0, 6).map(function (p) {
      return '<div class="prov' + (S.pick === p.id ? ' is-picked' : '') + '" data-prov="' + esc(p.id) + '"><span class="radio"></span><div class="nx-grow"><div class="pn">' + esc(p.name) + '</div><div class="pm">' + esc([p.distanceMi != null ? p.distanceMi + ' mi' : '', (p.services || []).slice(0, 3).join(', ')].filter(Boolean).join(' | ')) + '</div></div><div class="pe">' + (p.etaMin != null ? Math.round(p.etaMin) + ' min' : '') + '</div></div>';
    }).join('');
    var pickedP = S.providers.find(function (p) { return p.id === S.pick; });
    var lbl = asg ? 'Re-dispatch' : 'Dispatch' + (pickedP ? ' ' + esc(pickedP.name) : '');
    var dis = closed ? ' disabled' : '';
    return panel('Roadside', NX.badgeHTML(asg ? 'Assigned' : r.needed ? 'Needed' : 'Optional', asg ? 'ok' : r.needed ? 'accent' : 'plain'),
      top + (provs ? '<div class="nx-eyebrow" style="margin:12px 0 6px">Nearby providers</div><div class="provs">' + provs + '</div>' : '') +
      '<div style="margin-top:12px">' + btn(lbl + ' <kbd>d</kbd>', 'nx-btn--primary nx-btn--block', 'dispatch', dis) + '</div>');
  }
  function warrantyHTML(i) {
    var w = i.warranty, v = i.vehicle || {};
    if (!w) return panel('OEM warranty', NX.badgeHTML('No data', 'plain'), '<p class="nx-dim">VIN ' + esc(v.vin || '--') + ' has no warranty record.</p>');
    var dec = w.vinDecoded || {}, pk = w.claimPacket;
    var decRows = Object.keys(dec).filter(function (k) { return ['vin', 'valid', 'checkDigitOk', 'source', 'oem'].indexOf(k) < 0 && typeof dec[k] !== 'boolean' && dec[k] != null && typeof dec[k] !== 'object'; }).slice(0, 7).map(function (k) { return '<dt>' + esc(fmt.label(k)) + '</dt><dd>' + esc(typeof dec[k] === 'object' ? JSON.stringify(dec[k]) : dec[k]) + '</dd>'; }).join('');
    return panel('OEM warranty', NX.badgeHTML(w.claimEligible ? 'Claim eligible' : w.inWarranty ? 'In warranty' : 'Out of warranty', w.claimEligible ? 'ok' : w.inWarranty ? 'info' : 'plain'),
      '<div class="cov"><div class="nx-grow"><div class="nx-eyebrow">Coverage</div><div class="cov-big" style="margin-top:5px;color:' + (w.inWarranty ? 'var(--nx-ok)' : 'var(--nx-text-dim)') + '">' + esc(fmt.label(w.coverage || 'none')) + '</div></div>' +
      '<div style="text-align:right"><div class="nx-eyebrow">Expires</div><div class="nx-mono" style="margin-top:5px">' + (w.expiresAt ? fmt.date(w.expiresAt) : '--') + '</div>' + (w.milesRemaining != null ? '<div class="nx-faint nx-mono" style="font-size:11px">' + fmt.number(w.milesRemaining) + ' mi left</div>' : '') + '</div></div>' +
      '<dl class="nx-kv"><dt>OEM</dt><dd>' + esc(w.oem || v.oem || '--') + '</dd><dt>VIN</dt><dd class="vin">' + esc(v.vin || '--') + '</dd>' + decRows +
      (pk ? '<dt>Claim packet</dt><dd>' + NX.badgeHTML(pk.status || 'draft', pk.status === 'ready' || pk.status === 'submitted' ? 'ok' : 'warn') + (pk.estimatedValueUsd != null ? ' <span class="nx-mono">' + fmt.currency(pk.estimatedValueUsd) + '</span>' : '') + '</dd>' : '') + '</dl>' +
      (pk && pk.summary ? '<p class="nx-dim" style="margin-top:10px;font-size:12.5px">' + esc(pk.summary) + '</p>' : '') +
      '<div style="margin-top:12px"><a class="nx-btn nx-btn--block' + (w.claimEligible ? ' nx-btn--primary' : '') + '" target="_blank" rel="noopener" href="/api/incidents/' + encodeURIComponent(i.id) + '/warranty-packet?format=html">Open claim packet</a></div>');
  }
  function vehicleHTML(i) {
    var v = i.vehicle || {}, d = i.driver || {}, l = i.location || {};
    return panel('Vehicle &amp; driver', NX.badgeHTML(i.fleetName || 'Fleet', 'plain'),
      '<div class="two"><dl class="nx-kv"><dt>Unit</dt><dd>' + esc(unit(i)) + '</dd><dt>Vehicle</dt><dd>' + esc(vlabel(v)) + '</dd><dt>Plate</dt><dd class="nx-mono">' + esc(v.plate || '--') + '</dd><dt>VIN</dt><dd class="vin" style="font-size:11.5px">' + esc(v.vin || '--') + '</dd><dt>Odometer</dt><dd class="nx-mono">' + (v.odometer_mi != null ? fmt.number(v.odometer_mi) + ' mi' : '--') + '</dd></dl>' +
      '<dl class="nx-kv"><dt>Driver</dt><dd>' + esc(d.name || '--') + '</dd><dt>Score</dt><dd class="nx-mono">' + (d.safetyScore != null ? d.safetyScore : '--') + '</dd><dt>Speed</dt><dd class="nx-mono">' + (l.speed_mph != null ? Math.round(l.speed_mph) + ' mph' : '--') + '</dd><dt>Heading</dt><dd class="nx-mono">' + (l.heading != null ? Math.round(l.heading) + '°' : '--') + '</dd><dt>Road</dt><dd>' + esc(l.road || '--') + '</dd></dl></div>' +
      '<div class="callbtns">' + (d.phone ? '<a class="nx-btn nx-btn--sm" href="tel:' + esc(d.phone) + '">Call driver &middot; ' + esc(d.phone) + '</a>' : '') + '<a class="nx-btn nx-btn--sm" href="tel:+18005550142">Call fleet manager</a>' + (l.lat != null ? '<a class="nx-btn nx-btn--sm nx-btn--ghost" target="_blank" rel="noopener" href="https://www.openstreetmap.org/?mlat=' + l.lat + '&mlon=' + l.lng + '#map=16/' + l.lat + '/' + l.lng + '">Open in OSM</a>' : '') + '</div>');
  }
  function timelineHTML(i) {
    var tl = (i.timeline || []).slice().sort(function (a, b) { return new Date(b.t) - new Date(a.t); });
    var steps = ['en_route', 'on_scene', 'resolved'], cur = STATUS_LIST.indexOf(i.status), closed = isClosed(i);
    var next = closed ? null : steps.find(function (s) { return STATUS_LIST.indexOf(s) > cur; });
    var st = '<div class="status-steps">' + steps.map(function (s, k) {
      var done = STATUS_LIST.indexOf(s) <= cur;
      return '<button class="nx-btn nx-btn--sm' + (s === next ? ' is-next' : '') + (done ? ' is-done' : '') + (S.busy['st_' + s] ? ' is-loading' : '') + '" data-act="status" data-st="' + s + '"' + (done || closed ? ' disabled' : '') + '>' + fmt.label(s) + ' <kbd>' + (k + 1) + '</kbd></button>';
    }).join('') + '</div>';
    var draft = S.noteDraft[i.id] || '';
    return panel('Timeline', '<span class="nx-mono nx-faint" style="font-size:11px">' + tl.length + ' entries</span>',
      '<div class="nx-eyebrow" style="margin-bottom:8px">Progress status</div>' + st +
      '<div class="note-form" style="margin-top:14px"><input class="nx-input" id="note-in" placeholder="Add dispatcher note..." value="' + esc(draft) + '" autocomplete="off">' + btn('Add', 'nx-btn--sm nx-btn--primary', 'note', '', 'note') + '</div>' +
      '<div class="tl-wrap"><ul class="nx-timeline">' + tl.map(function (e, k) {
        return '<li class="nx-timeline__item is-' + esc(e.actor || 'system') + (k === 0 ? ' is-latest' : '') + '"><div class="nx-timeline__time">' + esc(fmt.dateTime(e.t)) + ' &middot; ' + esc(e.actor || 'system') + '</div><div class="nx-timeline__action">' + esc(e.action) + '</div>' + (e.note ? '<div class="nx-timeline__note">' + esc(e.note) + '</div>' : '') + '</li>';
      }).join('') + '</ul></div>');
  }
  function riskHTML(i) {
    if (!i.risk) return '';
    return '<div class="nx-row" style="gap:8px;flex-wrap:wrap"><span class="nx-eyebrow">Risk score</span><b class="nx-mono">' + i.risk.eventScore + '</b>' + (i.risk.tags || []).map(function (t) { return '<span class="tag">' + esc(t) + '</span>'; }).join('') + '</div>';
  }
  function renderDetail() {
    var i = S.inc.get(S.sel), keepScroll = detailEl.scrollTop, note = $('#note-in');
    if (note && S.sel) S.noteDraft[S.sel] = note.value;
    var focusNote = note && document.activeElement === note;
    if (!S.sel) { detailEl.innerHTML = '<div class="nx-empty d-empty"><div class="nx-empty__icon">&#9678;</div><div class="nx-empty__title">No incident selected</div><p>Pick an incident from the queue or a marker on the map. Use <kbd>j</kbd> / <kbd>k</kbd> to step through.</p></div>'; return; }
    if (!i) { detailEl.innerHTML = S.detailError ? '' : '<div class="sk"><span class="nx-skel nx-skel--lg"></span><span class="nx-skel nx-skel--block"></span><span class="nx-skel nx-skel--block"></span></div>'; if (S.detailError) detailEl.appendChild(NX.empty('Incident not found', S.detailError)); return; }
    var closed = isClosed(i), fp = isFP(i);
    var head = '<header class="d-head" style="--c:' + sevColor(i.severity) + '"><div class="d-id">' + NX.badgeHTML(i.severity) + NX.badgeHTML(i.status) + '<span class="nx-mono">' + esc(i.id) + '</span><span class="nx-mono" style="margin-left:auto">' + esc(fmt.ago(i.receivedAt || i.timestamp)) + '</span></div>' +
      '<h2 class="d-title">' + esc(title(i)) + ' &middot; ' + esc(unit(i)) + '</h2><div class="d-sub">' + esc(addr(i)) + '</div>' +
      '<div class="d-actions">' + (closed ? '' : btn('Dispatch <kbd>d</kbd>', 'nx-btn--primary nx-btn--sm', 'dispatch') + btn('Dismiss <kbd>x</kbd>', 'nx-btn--sm', 'dismissopen', '', 'dismiss')) +
      '<button class="nx-btn nx-btn--sm nx-btn--ghost" data-act="center">Center map</button></div></header>';
    var sections = [camHTML(i), dtcHTML(i), roadsideHTML(i), warrantyHTML(i), vehicleHTML(i), timelineHTML(i)];
    if (fp) sections = [sections[0], sections[5], sections[4], sections[1], sections[2], sections[3]]; // false positive: prioritise camera + timeline
    detailEl.innerHTML = head + '<div class="d-body">' + riskHTML(i) + sections.join('') + '</div>';
    detailEl.scrollTop = keepScroll;
    if (focusNote) { var n = $('#note-in'); n.focus(); n.setSelectionRange(n.value.length, n.value.length); }
  }

  detailEl.addEventListener('click', function (e) {
    var cam = e.target.closest('[data-cam]'); if (cam) { S.camTab = cam.dataset.cam; return renderDetail(); }
    var pv = e.target.closest('[data-prov]'); if (pv) { S.pick = pv.dataset.prov; renderDetail(); drawSelection(); return; }
    var b = e.target.closest('[data-act]'); if (!b) return;
    var a = b.dataset.act, i = S.inc.get(S.sel); if (!i) return;
    if (a === 'dispatch') doDispatch();
    else if (a === 'dismissopen') doDismiss();
    else if (a === 'fpdismiss') doDismiss('False positive - camera AI verdict ' + fmt.label(verdict(i)) + (pct(i.camera.confidence) != null ? ' (' + pct(i.camera.confidence) + '%)' : ''));
    else if (a === 'center') { focusSelection(); if (window.innerWidth <= 1100) setView('map'); }
    else if (a === 'status') setStatus(b.dataset.st);
    else if (a === 'note') addNote();
  });
  detailEl.addEventListener('keydown', function (e) { if (e.target.id === 'note-in' && e.key === 'Enter') { e.preventDefault(); addNote(); } });
  function setStatus(st) { act('st_' + st, '/status', { status: st, note: 'Status set by dispatcher' }, 'Status: ' + fmt.label(st)); }
  function addNote() {
    var n = $('#note-in'); if (!n || !n.value.trim()) return n && n.focus();
    var txt = n.value.trim(); S.noteDraft[S.sel] = '';
    act('note', '/notes', { note: txt, actor: 'dispatcher' }).then(function () { var x = $('#note-in'); if (x) x.focus(); });
  }

  /* ---------- wiring ---------- */
  fillSelects();
  $('#status-chips').addEventListener('click', function (e) { var b = e.target.closest('[data-st]'); if (!b) return; S.filters.status = b.dataset.st; renderQueue(); syncMarkers(); });
  ['sev', 'cat', 'fleet'].forEach(function (k) { $('#f-' + k).addEventListener('change', function (e) { S.filters[k] = e.target.value; renderQueue(); syncMarkers(); }); });
  $('#f-q').addEventListener('input', function (e) { S.filters.q = e.target.value; renderQueue(); syncMarkers(); });
  $('#q-list').addEventListener('click', function (e) { var r = e.target.closest('[data-id]'); if (r) select(r.dataset.id, { view: 'detail' }); });
  $('#btn-refresh').addEventListener('click', load);
  $('#btn-fit').addEventListener('click', fitAll);
  $('#btn-follow').addEventListener('click', function (e) { S.follow = !S.follow; e.target.setAttribute('aria-pressed', S.follow); if (S.follow) focusSelection(); });
  document.querySelectorAll('.view-tabs button').forEach(function (b) { b.addEventListener('click', function () { setView(b.dataset.view); }); });
  window.addEventListener('hashchange', function () { var h = decodeURIComponent(location.hash.slice(1)); if (h && h !== S.sel) select(h, { noHash: true, view: 'detail' }); });
  document.addEventListener('keydown', function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var t = e.target, typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    if (document.querySelector('.nx-modal-backdrop') && e.key !== 'Escape') return;
    if (e.key === 'Escape') { if (typing) { t.blur(); return; } if (S.sel) { S.sel = null; S.providers = []; history.replaceState(null, '', location.pathname); renderQueue(); renderDetail(); drawSelection(); syncMarkers(); } return; }
    if (typing) return;
    var k = e.key;
    if (k === 'j' || k === 'ArrowDown') { e.preventDefault(); nav(1); }
    else if (k === 'k' || k === 'ArrowUp') { e.preventDefault(); nav(-1); }
    else if (k === 'd') doDispatch();
    else if (k === 'x') doDismiss();
    else if (k === '1' || k === '2' || k === '3') { var i = S.inc.get(S.sel); if (i && !isClosed(i)) setStatus(['en_route', 'on_scene', 'resolved'][+k - 1]); }
    else if (k === 'n') { var n = $('#note-in'); if (n) { e.preventDefault(); n.focus(); } }
    else if (k === '/') { e.preventDefault(); $('#f-q').focus(); }
    else if (k === 'f') fitAll();
    else if (k === '?') showHelp();
  });
  // keep relative times fresh
  setInterval(function () { if (!S.loading) { renderQueue(); } }, 20000);
  // first user gesture unlocks audio
  document.addEventListener('click', function () { try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === 'suspended') actx.resume(); } catch (e) {} }, { once: true });

  initMap();
  renderDetail(); renderHud();
  api('/api/fleets').then(function (d) { S.fleets = listFrom(d, 'fleets'); paintFleetSelect(); }).catch(function () {});
  load();
  NX.sse('/api/stream', function (data, type) {
    var inc = data && (data.incident || data);
    if (inc && inc.id) upsert(inc, true);
  }, { events: ['incident'], onStatus: function (ok) { if (ok && S._wasDown) { S._wasDown = false; load(); } if (!ok) S._wasDown = true; } });
})();
