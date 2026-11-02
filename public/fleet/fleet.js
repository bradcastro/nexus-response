/* Nexus Response - Fleet customer portal. Vanilla JS, consumes the contract in docs/ARCHITECTURE.md. */
(function () {
  'use strict';
  var esc = NX.esc, fmt = NX.fmt;
  var VENDORS = { motive: 'Motive', samsara: 'Samsara', geotab: 'Geotab', lytx: 'Lytx', generic: 'Generic', mantis: 'Mantis' };
  var S = { fleets: [], fleet: null, summary: null, incidents: [], view: 'overview', incFilter: 'open', vehFilter: 'all', openId: null, map: null, markers: null, sse: null, timer: null };
  var $ = function (id) { return document.getElementById(id); };
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
  var vendorName = function (v) { return VENDORS[String(v || '').toLowerCase()] || fmt.label(v || 'unknown'); };
  var isOpen = function (i) { return i.status !== 'resolved' && i.status !== 'dismissed'; };
  var typeLabel = function (t) { return fmt.label(t || 'other'); };
  var scoreCls = function (s) { return s == null ? '' : s >= 85 ? 'ok' : s >= 70 ? 'warn' : 'bad'; };
  var num = function (v, d) { return v == null || v === '' || isNaN(v) ? d : Number(v); };

  /* ---------------- boot ---------------- */
  function init() {
    document.querySelectorAll('.nx-nav[data-view]').forEach(function (b) { b.addEventListener('click', function () { show(b.dataset.view); $('side').classList.remove('is-open'); }); });
    $('scrim').addEventListener('click', closeDrawer);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDrawer(); });
    document.addEventListener('nx:theme', function () { if (S.summary) { renderMarkers(); } });
    window.addEventListener('hashchange', function () { var h = location.hash.slice(1); if (h && $('v-' + h)) show(h, true); });
    NX.api('/api/fleets').then(function (res) {
      S.fleets = Array.isArray(res) ? res : (res && res.fleets) || [];
      if (!S.fleets.length) throw new Error('No fleets returned by /api/fleets');
      var qp = new URLSearchParams(location.search).get('fleet');
      var pick = qp || lsGet('nx-fleet');
      var f = S.fleets.filter(function (x) { return x.id === pick || x.name === pick; })[0] || S.fleets[0];
      var sel = $('fleet-select');
      sel.innerHTML = S.fleets.map(function (x) { return '<option value="' + esc(x.id) + '">' + esc(x.name) + ' · ' + esc(vendorName(x.vendor)) + '</option>'; }).join('');
      sel.addEventListener('change', function () { selectFleet(sel.value); });
      var h = location.hash.slice(1); if (h && $('v-' + h)) show(h, true);
      selectFleet(f.id);
    }).catch(fatal);
  }
  function fatal(err) {
    var e = $('error'); e.classList.remove('nx-hide');
    e.innerHTML = '<div class="nx-card nx-card--alert"><div class="nx-card__body"><b>Cannot load fleet data.</b> <span class="nx-dim">' + esc(err.message) + '</span><div style="margin-top:10px"><button class="nx-btn nx-btn--sm" onclick="location.reload()">Retry</button></div></div></div>';
  }

  function selectFleet(id) {
    S.fleet = S.fleets.filter(function (f) { return f.id === id; })[0] || S.fleets[0];
    $('fleet-select').value = S.fleet.id;
    lsSet('nx-fleet', S.fleet.id);
    try { var u = new URL(location.href); u.searchParams.set('fleet', S.fleet.id); history.replaceState(null, '', u); } catch (e) { /* ignore */ }
    closeDrawer();
    $('fleet-name').textContent = S.fleet.name;
    $('region').textContent = S.fleet.region || 'Fleet';
    $('fleet-sub').textContent = fmt.number(S.fleet.vehicles) + ' vehicles · ' + fmt.number(S.fleet.drivers) + ' drivers';
    renderSource();
    S.summary = null; S.incidents = []; S.comms = {}; S.feed = null;
    ['overview', 'predict', 'incidents', 'warranty', 'drivers', 'vehicles', 'loads'].forEach(function (v) { $('v-' + v).innerHTML = ''; $('v-' + v).appendChild(NX.skeleton(4)); });
    $('error').classList.add('nx-hide');
    load().catch(fatal);
    if (S.sse) S.sse.close();
    S.sse = NX.sse('/api/stream', onStream, { events: ['incident', 'alert'] });
  }

  function load() {
    var id = S.fleet.id;
    return Promise.all([
      NX.api('/api/fleets/' + encodeURIComponent(id) + '/summary'),
      NX.api('/api/incidents', { query: { fleetId: id, limit: 500 } })
    ]).then(function (r) {
      if (S.fleet.id !== id) return;
      S.summary = r[0] || {};
      S.incidents = ((r[1] && r[1].incidents) || r[1] || []).filter(function (i) { return !i.fleetId || i.fleetId === id; });
      sortIncidents();
      renderAll();
    });
  }
  function sortIncidents() { S.incidents.sort(function (a, b) { return new Date(b.timestamp || b.receivedAt) - new Date(a.timestamp || a.receivedAt); }); }

  /* ---------------- live updates ---------------- */
  function onStream(d, type) {
    if (type === 'alert') return onAlert(d && d.alert ? d.alert : d);
    var inc = d && d.incident ? d.incident : d;
    if (!inc || !inc.id || inc.fleetId !== S.fleet.id) return;
    var idx = S.incidents.findIndex(function (i) { return i.id === inc.id; });
    var fresh = idx < 0;
    if (fresh) S.incidents.unshift(inc); else S.incidents[idx] = inc;
    sortIncidents();
    S.flash = fresh ? inc.id : null;
    renderCounts(); renderIncidentsTables(); renderLoads(); renderWarranty(); renderAttention();
    if (S.openId === inc.id) renderDrawer(inc);
    if (fresh) NX.toast(typeLabel(inc.eventType) + ' · ' + ((inc.vehicle && inc.vehicle.plate) || 'vehicle') + ' (' + inc.severity + ')', inc.severity === 'critical' ? 'critical' : 'info');
    clearTimeout(S.timer);
    S.timer = setTimeout(function () {
      NX.api('/api/fleets/' + encodeURIComponent(S.fleet.id) + '/summary').then(function (s) { S.summary = s; renderKpis(); renderTrend(); renderTypes(); renderMarkers(); renderVehicles(); renderDrivers(); renderWarranty(); renderLoads(); renderCargo(); renderAttention(); loadFeed(); }).catch(function () { /* keep stale */ });
    }, 600);
  }

  /* ---------------- shell ---------------- */
  function show(view, fromHash) {
    S.view = view;
    document.querySelectorAll('.nx-nav[data-view]').forEach(function (b) { b.classList.toggle('is-active', b.dataset.view === view); });
    document.querySelectorAll('[data-section]').forEach(function (s) { s.hidden = s.dataset.section !== view; });
    if (!fromHash) { try { history.replaceState(null, '', location.pathname + location.search + '#' + view); } catch (e) { /* */ } }
    if (view === 'predict' && S.pmap) setTimeout(function () { S.pmap.invalidateSize(); }, 50);
    if (view === 'overview' && S.map) setTimeout(function () { S.map.invalidateSize(); }, 50);
    $('main').scrollTop = 0;
  }
  function renderSource() {
    var v = vendorName(S.fleet.vendor);
    $('source-badge').innerHTML = '<span class="fl-src" title="Events from this vendor are mapped to the Nexus canonical schema"><i></i>Telematics: <b>' + esc(v) + '</b><span class="tag">normalized by Nexus</span></span>';
    var cov = S.fleet.cameraCoveragePct != null ? ' · ' + Math.round(S.fleet.cameraCoveragePct) + '% camera coverage' : '';
    $('source-badge').firstChild.insertAdjacentHTML('beforeend', '<span class="nx-dim">' + esc(cov) + '</span>');
    var ob = S.fleet.onboarding, bn = $('onboard');
    if (ob && ob.status === 'setup') { bn.hidden = false; bn.innerHTML = '<b>' + (ob.status === 'setup' ? 'Onboarding in progress.' : 'Demo data.') + '</b> ' + (ob.status === 'setup' ? 'This fleet is still being connected, so figures reflect partial data until the first events and history arrive.' : 'This fleet shows seeded demonstration data, not live vendor events.') + (S.fleet.id ? ' <a href="/onboarding/?fleet=' + encodeURIComponent(S.fleet.id) + '">Open setup checklist</a>' : ''); } else { bn.hidden = true; }
    $('side-source').innerHTML = '<div class="nx-eyebrow" style="margin-bottom:6px">Data source</div><div class="fl-src" style="flex-wrap:wrap"><i></i><b>' + esc(v) + '</b><span class="tag">normalized by Nexus</span></div>';
  }
  function renderCounts() {
    $('cnt-inc').textContent = S.incidents.filter(isOpen).length;
    $('cnt-war').textContent = claims().length;
    $('cnt-drv').textContent = drivers().length;
    $('cnt-load').textContent = loads().length;
    $('cnt-veh').textContent = ((S.summary && S.summary.vehicles) || []).length;
  }
  function renderAll() {
    renderCounts();
    $('v-overview').innerHTML = overviewHTML();
    renderKpis(); renderTrend(); renderTypes(); renderCargo(); renderSources(); renderAttention(); loadFeed(); initMap(); renderMarkers();
    $('v-incidents').innerHTML = '<div id="inc-filters"></div><div id="inc-table"></div>';
    $('v-warranty').innerHTML = '<div id="war-body"></div>';
    $('v-drivers').innerHTML = '<div id="drv-body"></div>';
    $('v-vehicles').innerHTML = '<div id="veh-body"></div>';
    $('v-loads').innerHTML = '<div id="load-body"></div>';
    renderIncidentsTables(); renderWarranty(); renderDrivers(); renderVehicles(); renderLoads();
    loadPredict();
    if (S.view === 'overview' && S.map) setTimeout(function () { S.map.invalidateSize(); }, 50);
    var m = location.hash.match(/^#incident=(.+)$/); if (m) openIncident(decodeURIComponent(m[1]));
  }

  /* ---------------- overview ---------------- */
  function overviewHTML() {
    return '<div id="attn"></div><div class="nx-kpis" id="kpis"></div>' +
      '<div class="fl-grid"><div class="nx-card"><div class="nx-card__head"><h3 class="nx-card__title">Events, last 30 days</h3><span class="nx-dim nx-mono" id="trend-sum"></span></div><div class="nx-card__body fl-chart" id="trend"></div></div>' +
      '<div class="nx-card"><div class="nx-card__head"><h3 class="nx-card__title">Events by type</h3></div><div class="nx-card__body" id="types"></div></div></div>' +
      '<div class="nx-card" style="margin-bottom:16px"><div class="nx-card__head"><h3 class="nx-card__title">Live fleet map</h3><span class="nx-dim nx-mono" id="map-sum"></span></div><div class="fl-map" id="map"></div>' +
      '<div class="fl-legend"><span><i style="--c:var(--nx-ok)"></i>Rolling / healthy</span><span><i style="--c:var(--nx-text-faint)"></i>Idle / stopped</span><span><i style="--c:var(--nx-sev-medium)"></i>Open trouble codes</span><span><i style="--c:var(--nx-danger)"></i>Down / incident</span><span class="nx-faint">Badge number = open trouble codes</span></div></div>' +
      '<div class="nx-card" style="margin-bottom:16px"><div class="nx-card__head"><h3 class="nx-card__title">Cargo exposure by content</h3><span class="nx-dim nx-mono">estimated</span></div><div class="nx-card__body" id="cargo"></div></div>' +
      '<div class="fl-grid fl-grid--even"><div class="nx-card"><div class="nx-card__head"><h3 class="nx-card__title">Recent incidents</h3><button class="nx-btn nx-btn--sm nx-btn--ghost" data-go="incidents">View all</button></div><div class="nx-card__body nx-card--flush" id="recent"></div></div>' +
      '<div class="nx-card"><div class="nx-card__head"><h3 class="nx-card__title">What Nexus did for you</h3><span class="fl-tag">simulated in demo</span></div><div class="nx-card__body nx-card--flush" id="feed"></div></div></div>' +
      '<div class="nx-card" style="margin-bottom:16px"><div class="nx-card__head"><h3 class="nx-card__title">Data sources</h3></div><div class="nx-card__body" id="sources"></div></div>';
  }
  function renderKpis() {
    var k = (S.summary && S.summary.kpis) || {};
    var sc = num(k.safetyScore, null);
    var items = [
      ['Open incidents', fmt.number(k.openIncidents), (k.openIncidents ? 'nx-kpi--accent' : ''), 'needs attention'],
      ['Mean time to resolution', k.mttrMin == null ? '—' : fmt.duration(k.mttrMin), '', 'detected to resolved'],
      ['Events, last 30d', fmt.number(k.eventsLast30d), '', 'all event types'],
      ['Roadside calls', fmt.number(k.roadsideCalls), '', 'dispatched by Nexus'],
      ['Warranty recovered', fmt.currency(k.warrantyRecoveredUsd), 'nx-kpi--ok', 'OEM claims'],
      ['Fleet safety score', sc == null ? '—' : fmt.number(sc, 0), '', 'out of 100'],
      ['Cargo at risk', k.cargoAtRiskUsd == null ? '—' : fmt.currency(k.cargoAtRiskUsd), (k.cargoAtRiskUsd ? 'nx-kpi--critical' : ''), (k.incidentsWithLoadContext != null ? k.incidentsWithLoadContext + ' incidents with load context' : 'estimated, open incidents')]
    ];
    $('kpis').innerHTML = items.map(function (i) { return '<div class="nx-kpi ' + i[2] + '"><div class="nx-kpi__label">' + i[0] + '</div><div class="nx-kpi__value">' + esc(i[1]) + '</div><div class="nx-kpi__delta">' + i[3] + '</div></div>'; }).join('');
    $('main').querySelectorAll('[data-go]').forEach(function (b) { b.onclick = function () { show(b.dataset.go); }; });
  }

  function renderTrend() {
    var t = ((S.summary && S.summary.trend) || []).slice();
    var host = $('trend'); if (!host) return;
    if (!t.length) { host.innerHTML = ''; host.appendChild(NX.empty('No trend data', 'Events will appear here as they arrive.')); return; }
    var W = 720, H = 220, L = 30, R = 8, T = 10, B = 24;
    var max = Math.max(4, Math.max.apply(null, t.map(function (p) { return p.count; })));
    max = Math.ceil(max / 4) * 4;
    var x = function (i) { return L + (t.length > 1 ? i * (W - L - R) / (t.length - 1) : 0); };
    var y = function (v) { return T + (H - T - B) * (1 - v / max); };
    var pts = t.map(function (p, i) { return x(i).toFixed(1) + ',' + y(p.count).toFixed(1); });
    var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Daily event count, last 30 days">';
    for (var g = 0; g <= 4; g++) { var gv = max * g / 4; s += '<line class="grid" x1="' + L + '" x2="' + (W - R) + '" y1="' + y(gv) + '" y2="' + y(gv) + '"/><text x="' + (L - 6) + '" y="' + (y(gv) + 3) + '" text-anchor="end">' + Math.round(gv) + '</text>'; }
    s += '<path class="area" d="M' + x(0) + ',' + y(0) + ' L' + pts.join(' L') + ' L' + x(t.length - 1) + ',' + y(0) + 'Z"/><polyline class="line" points="' + pts.join(' ') + '"/>';
    var step = Math.max(1, Math.round(t.length / 6));
    t.forEach(function (p, i) { if (i % step === 0 || i === t.length - 1) { var d = new Date(p.date + (String(p.date).length <= 10 ? 'T12:00:00' : '')); s += '<text x="' + x(i) + '" y="' + (H - 6) + '" text-anchor="' + (i === 0 ? 'start' : i === t.length - 1 ? 'end' : 'middle') + '">' + d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + '</text>'; } });
    s += '<line class="hov" id="hov" y1="' + T + '" y2="' + (H - B) + '" style="display:none"/><circle class="dot" id="hdot" r="4" style="display:none"/></svg><div class="fl-tip" id="tip" hidden></div>';
    host.innerHTML = s;
    $('trend-sum').textContent = fmt.number(t.reduce(function (a, p) { return a + p.count; }, 0)) + ' total';
    var svg = host.querySelector('svg'), tip = $('tip'), hov = $('hov'), dot = $('hdot');
    function move(ev) {
      var r = svg.getBoundingClientRect(), px = ((ev.touches ? ev.touches[0].clientX : ev.clientX) - r.left) / r.width * W;
      var i = Math.max(0, Math.min(t.length - 1, Math.round((px - L) / ((W - L - R) / Math.max(1, t.length - 1)))));
      hov.setAttribute('x1', x(i)); hov.setAttribute('x2', x(i)); hov.style.display = '';
      dot.setAttribute('cx', x(i)); dot.setAttribute('cy', y(t[i].count)); dot.style.display = '';
      tip.hidden = false; tip.style.left = (x(i) / W * r.width) + 'px'; tip.style.top = (y(t[i].count) / H * r.height) + 'px';
      tip.innerHTML = '<b>' + t[i].count + '</b> event' + (t[i].count === 1 ? '' : 's') + ' · ' + fmt.date(new Date(t[i].date + 'T12:00:00'));
    }
    svg.addEventListener('mousemove', move); svg.addEventListener('touchmove', move, { passive: true });
    svg.addEventListener('mouseleave', function () { tip.hidden = true; hov.style.display = 'none'; dot.style.display = 'none'; });
  }

  function renderTypes() {
    var host = $('types'); if (!host) return;
    var bt = (S.summary && S.summary.byType) || {};
    var rows = Array.isArray(bt) ? bt.map(function (r) { return [r.type || r.name, r.count]; }) : Object.keys(bt).map(function (k) { return [k, bt[k]]; });
    rows.sort(function (a, b) { return b[1] - a[1]; });
    if (!rows.length) { host.innerHTML = ''; host.appendChild(NX.empty('No events yet')); return; }
    var max = rows[0][1] || 1;
    host.innerHTML = '<div class="fl-bars">' + rows.slice(0, 9).map(function (r) {
      return '<div class="fl-bar"><span title="' + esc(typeLabel(r[0])) + '">' + esc(typeLabel(r[0])) + '</span><div class="nx-meter"><i style="width:' + (r[1] / max * 100) + '%"></i></div><span class="fl-bar__n">' + r[1] + '</span></div>';
    }).join('') + '</div>';
  }

  function renderSources() {
    var host = $('sources'); if (!host) return;
    var inc = S.incidents, ver = inc.filter(function (i) { return i.camera && i.camera.verified; }).length;
    var withDtc = inc.filter(function (i) { return i.diagnostics && i.diagnostics.dtcs && i.diagnostics.dtcs.length; }).length;
    var v = vendorName(S.fleet.vendor);
    host.innerHTML = '<div class="fl-sources"><span class="fl-node">' + esc(v) + ' <span class="nx-dim">native events</span></span><span class="fl-arrow">→</span><span class="fl-node nx"><b>Nexus</b> canonical schema</span><span class="fl-arrow">→</span><span class="fl-node">This portal</span></div>' +
      '<dl class="nx-kv" style="margin-top:14px"><dt>Telematics vendor</dt><dd>' + esc(v) + ' <span class="nx-badge nx-badge--accent">normalized by Nexus</span></dd>' +
      '<dt>Events ingested</dt><dd class="nx-mono">' + fmt.number(inc.length) + '</dd>' +
      '<dt>Camera-verified</dt><dd class="nx-mono">' + ver + ' (' + (inc.length ? Math.round(ver / inc.length * 100) : 0) + '%)</dd>' +
      '<dt>With trouble codes</dt><dd class="nx-mono">' + withDtc + '</dd></dl>' +
      '<p class="fl-note">Nexus accepts Motive, Samsara, Geotab and Lytx and maps every event to one schema, so incident handling, roadside and warranty work the same whichever vendor you run.</p>';
  }

  /* ---------------- map ---------------- */
  function initMap() {
    if (S.map) { S.map.remove(); S.map = null; }
    if (typeof L === 'undefined') { $('map').innerHTML = '<div class="nx-empty"><p>Map library unavailable (offline).</p></div>'; return; }
    S.map = L.map('map', { zoomControl: true, scrollWheelZoom: false }).setView([32, -86], 6);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '&copy; OpenStreetMap contributors' }).addTo(S.map);
    S.markers = L.layerGroup().addTo(S.map);
    S.fitted = false;
  }
  function pinColor(v) {
    var st = String(v.status || '').toLowerCase();
    if (/down|incident|breakdown|disabled|offline|critical/.test(st)) return 'var(--nx-danger)';
    if (num(v.openDtcs, 0) > 0 || st === 'attention') return 'var(--nx-sev-medium)';
    if (/idle|stop|park/.test(st)) return 'var(--nx-text-faint)';
    return 'var(--nx-ok)';
  }
  function renderMarkers() {
    if (!S.map || !S.markers) return;
    S.markers.clearLayers();
    var vs = ((S.summary && S.summary.vehicles) || []).filter(function (v) { return v.lat != null && v.lng != null; });
    var pts = [];
    vs.forEach(function (v) {
      var n = num(v.openDtcs, 0);
      var icon = L.divIcon({ className: '', iconSize: [22, 22], iconAnchor: [11, 11], html: '<div class="fl-pin" style="--c:' + pinColor(v) + '">' + (n ? '<em>' + n + '</em>' : '') + '</div>' });
      var m = L.marker([v.lat, v.lng], { icon: icon, title: v.plate || v.id });
      m.bindPopup('<b>' + esc(v.unit || v.plate || v.id) + '</b> · ' + esc([v.make, v.model].filter(Boolean).join(' ')) + '<br>' + (v.speed_mph != null ? Math.round(v.speed_mph) + ' mph · ' : '') + esc(fmt.label(v.status || 'unknown')) + (n ? '<br>' + n + ' open trouble code' + (n > 1 ? 's' : '') : '<br>No open trouble codes') + '<br><a href="#" data-veh="' + esc(v.id) + '">View incidents</a>');
      m.on('popupopen', function (e) { var a = e.popup.getElement().querySelector('[data-veh]'); if (a) a.onclick = function (ev) { ev.preventDefault(); S.vehFocus = v.id; var inc = S.incidents.filter(function (i) { return i.vehicle && i.vehicle.id === v.id; })[0]; if (inc) openIncident(inc.id); else NX.toast('No incidents on file for ' + (v.plate || v.id), 'info'); }; });
      S.markers.addLayer(m); pts.push([v.lat, v.lng]);
    });
    if (pts.length && !S.fitted) { S.map.fitBounds(pts, { padding: [30, 30], maxZoom: 9 }); S.fitted = true; }
    var down = vs.filter(function (v) { return pinColor(v) === 'var(--nx-danger)'; }).length;
    if ($('map-sum')) $('map-sum').textContent = vs.length + ' vehicles · ' + vs.filter(function (v) { return num(v.openDtcs, 0) > 0; }).length + ' with DTCs' + (down ? ' · ' + down + ' down' : '');
  }

  /* ---------------- incidents ---------------- */
  function vehLabel(i) { var v = i.vehicle || {}; return v.unit || v.plate || v.id || '—'; }
  function vehSub(i) { var v = i.vehicle || {}; return [v.year, v.make, v.model].filter(Boolean).join(' '); }
  function incRow(i) {
    var cam = i.camera && i.camera.verified ? NX.badgeHTML('Verified', 'ok') : (i.camera ? '<span class="nx-dim">' + esc(fmt.label((i.camera.aiVerdict || 'unverified'))) + '</span>' : '<span class="nx-faint">No camera</span>');
    return '<tr class="fl-row-click' + (S.flash === i.id ? ' nx-new' : '') + '" data-id="' + esc(i.id) + '" tabindex="0">' +
      '<td>' + NX.badgeHTML(i.severity) + '</td><td>' + esc(typeLabel(i.eventType)) + '<span class="sub">' + esc((i.location && (i.location.road || i.location.address)) || '') + '</span></td>' +
      '<td>' + esc(vehLabel(i)) + '<span class="sub">' + esc(vehSub(i)) + '</span></td><td>' + esc((i.driver && i.driver.name) || '—') + '</td>' +
      '<td>' + cam + '</td><td>' + NX.badgeHTML(i.status) + '</td><td class="dim nx-mono" title="' + esc(fmt.dateTime(i.timestamp)) + '">' + fmt.ago(i.timestamp) + '</td></tr>';
  }
  var INC_HEAD = '<thead><tr><th>Severity</th><th>Event</th><th>Vehicle</th><th>Driver</th><th>Camera</th><th>Status</th><th>When</th></tr></thead>';
  function bindRows(root) {
    root.querySelectorAll('tr[data-id]').forEach(function (r) { r.onclick = function () { openIncident(r.dataset.id); }; r.onkeydown = function (e) { if (e.key === 'Enter') openIncident(r.dataset.id); }; });
  }
  function renderIncidentsTables() {
    var open = S.incidents.filter(isOpen), done = S.incidents.filter(function (i) { return !isOpen(i); });
    var rec = $('recent');
    if (rec) {
      var r5 = S.incidents.slice(0, 6);
      rec.innerHTML = r5.length ? '<div class="nx-table-wrap"><table class="nx-table"><thead><tr><th>Severity</th><th>Event</th><th>Vehicle</th><th>Status</th></tr></thead><tbody>' + r5.map(function (i) { return '<tr class="fl-row-click' + (S.flash === i.id ? ' nx-new' : '') + '" data-id="' + esc(i.id) + '"><td>' + NX.badgeHTML(i.severity) + '</td><td>' + esc(typeLabel(i.eventType)) + '<span class="sub">' + fmt.ago(i.timestamp) + '</span></td><td>' + esc(vehLabel(i)) + '</td><td>' + NX.badgeHTML(i.status) + '</td></tr>'; }).join('') + '</tbody></table></div>' : '';
      if (!r5.length) rec.appendChild(NX.empty('No incidents'));
      bindRows(rec);
    }
    var fh = $('inc-filters'); if (!fh) return;
    var tabs = [['open', 'Open', open.length], ['resolved', 'Resolved / dismissed', done.length], ['all', 'All', S.incidents.length]];
    fh.innerHTML = '<div class="fl-filters"><div class="fl-pills nx-chips">' + tabs.map(function (t) { return '<button class="nx-chip' + (S.incFilter === t[0] ? ' is-active' : '') + '" data-f="' + t[0] + '">' + t[1] + ' ' + t[2] + '</button>'; }).join('') + '</div><span class="nx-dim" style="font-size:12px">Live updates on · ' + esc(S.fleet.name) + ' only</span></div>';
    fh.querySelectorAll('[data-f]').forEach(function (b) { b.onclick = function () { S.incFilter = b.dataset.f; renderIncidentsTables(); }; });
    var rows = S.incFilter === 'open' ? open : S.incFilter === 'resolved' ? done : S.incidents;
    var host = $('inc-table');
    host.innerHTML = rows.length ? '<div class="nx-card nx-card--flush"><div class="nx-table-wrap"><table class="nx-table">' + INC_HEAD + '<tbody>' + rows.slice(0, 200).map(incRow).join('') + '</tbody></table></div></div>' : '';
    if (!rows.length) host.appendChild(NX.empty('Nothing here', 'No incidents match this filter.'));
    bindRows(host);
    renderCounts();
  }

  /* ---------------- drawer ---------------- */
  function openIncident(id) {
    S.openId = id;
    var local = S.incidents.filter(function (i) { return i.id === id; })[0];
    $('scrim').hidden = false; $('drawer').classList.add('is-open'); $('drawer').setAttribute('aria-hidden', 'false');
    if (local) renderDrawer(local); else $('drawer').innerHTML = '<div class="fl-d-body"></div>';
    NX.api('/api/incidents/' + encodeURIComponent(id)).then(function (full) {
      if (S.openId !== id) return;
      var k = S.incidents.findIndex(function (i) { return i.id === id; }); if (k >= 0) S.incidents[k] = full;
      renderDrawer(full);
    }).catch(function (e) { if (!local) { $('drawer').innerHTML = '<div class="fl-d-body"><div class="nx-empty"><p>' + esc(e.message) + '</p></div></div>'; } });
  }
  function closeDrawer() { S.openId = null; $('scrim').hidden = true; $('drawer').classList.remove('is-open'); $('drawer').setAttribute('aria-hidden', 'true'); }

  function stage(inc) {
    var tl = inc.timeline || [], st = inc.status;
    function at(re) { var e = tl.filter(function (x) { return re.test((x.action || '') + ' ' + (x.note || '')); })[0]; return e ? e.t : null; }
    if (st === 'dismissed') return [
      { k: 'Detected', done: true, t: inc.receivedAt || inc.timestamp },
      { k: 'Verified', done: true, t: at(/verif|valid|confirm/i) },
      { k: 'Reviewed', done: true, t: at(/review|dismiss/i) },
      { k: 'Dismissed', done: true, t: null }
    ];
    var dispatched = ['dispatched', 'en_route', 'on_scene', 'resolved'].indexOf(st) > -1;
    return [
      { k: 'Detected', done: true, t: inc.receivedAt || inc.timestamp },
      { k: 'Verified', done: !!(inc.camera && inc.camera.verified) || st !== 'pending' && st !== 'validating', t: at(/verif|valid|confirm/i) },
      { k: 'Dispatched', done: dispatched, t: at(/dispatch/i) },
      { k: 'Resolved', done: st === 'resolved', t: at(/resolv|clos/i) }
    ];
  }
  function sec(title, right, body) { return '<section class="fl-sec"><h3><span>' + title + '</span>' + (right ? '<span>' + right + '</span>' : '') + '</h3><div>' + body + '</div></section>'; }
  function renderDrawer(inc) {
    var v = inc.vehicle || {}, d = inc.driver || {}, l = inc.location || {}, c = inc.camera, dx = inc.diagnostics, rs = inc.roadside, w = inc.warranty;
    var steps = stage(inc), firstOpen = steps.findIndex(function (s) { return !s.done; });
    var h = '<div class="fl-d-head"><div class="nx-grow"><div class="nx-row" style="gap:6px;flex-wrap:wrap">' + NX.badgeHTML(inc.severity) + NX.badgeHTML(inc.status) + '<span class="nx-mono nx-faint" style="font-size:11px">' + esc(inc.id) + '</span></div><h2>' + esc(typeLabel(inc.eventType)) + '</h2><div class="nx-dim" style="font-size:13px">' + esc(vehLabel(inc)) + ' · ' + esc(vehSub(inc)) + ' · ' + esc(d.name || 'Driver unknown') + '</div><div class="nx-faint nx-mono" style="font-size:11px;margin-top:4px">' + esc(fmt.dateTime(inc.timestamp)) + ' · ' + esc(vendorName(inc.provider)) + ' · ' + esc(l.address || l.road || '') + '</div></div><button class="nx-icon-btn" aria-label="Close" id="d-close">✕</button></div><div class="fl-d-body">';

    h += sec('What Nexus did', '', '<div class="fl-steps">' + steps.map(function (s, i) { return '<div class="fl-step' + (s.done ? ' done' : '') + (i === firstOpen ? ' now' : '') + '">' + s.k + '<small>' + (s.t ? fmt.time(s.t) : (s.done ? '' : (i === firstOpen ? 'in progress' : 'pending'))) + '</small></div>'; }).join('') + '</div>' +
      ((inc.timeline && inc.timeline.length) ? '<ul class="nx-timeline" style="margin-top:16px">' + inc.timeline.slice().sort(function (a, b) { return new Date(a.t) - new Date(b.t); }).map(function (e, i, arr) { return '<li class="nx-timeline__item is-' + esc(e.actor || 'system') + (i === arr.length - 1 ? ' is-latest' : '') + '"><div class="nx-timeline__time">' + esc(fmt.dateTime(e.t)) + ' · ' + esc(e.actor || 'system') + '</div><div class="nx-timeline__action">' + esc(fmt.label(e.action)) + '</div>' + (e.note ? '<div class="nx-timeline__note">' + esc(e.note) + '</div>' : '') + '</li>'; }).join('') + '</ul>' : ''));

    h += contextSection(inc);

    if (c) {
      var conf = c.confidence == null ? null : Math.round(c.confidence * 100);
      var media = (c.snapshots || []).map(function (s) { return mediaTile('img', s.url, 'Snapshot' + (s.type ? ' · ' + s.type : '')); }).concat((c.clips || []).map(function (s) { return mediaTile('video', s.url, (s.type === 'driver' ? 'Driver-facing' : 'Road-facing') + ' clip' + (s.durationSec ? ' · ' + s.durationSec + 's' : '')); }));
      h += sec('Camera evidence', c.verified ? NX.badgeHTML('Camera verified', 'ok') : NX.badgeHTML('Not verified', 'plain'),
        '<div class="nx-row" style="justify-content:space-between;gap:12px"><div><div class="nx-faint" style="font:500 10px var(--nx-font-mono);letter-spacing:.1em;text-transform:uppercase">AI verdict</div><div style="font-weight:600">' + esc(/no.?video/i.test(c.aiVerdict || '') ? 'No camera footage for this event' : fmt.label(c.aiVerdict || 'pending')) + '</div></div>' + (!conf ? '' : '<div style="min-width:140px"><div class="nx-faint nx-mono" style="font-size:11px;text-align:right">' + (conf == null ? '' : conf + '% confidence') + '</div><div class="nx-meter" style="margin-top:6px"><i style="width:' + (conf || 0) + '%;--c:' + (c.verified ? 'var(--nx-ok)' : 'var(--nx-text-faint)') + '"></i></div></div>') + '</div>' +
        ((c.signals && c.signals.length) ? '<ul class="fl-signals">' + c.signals.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ul>' : '') +
        (media.length ? '<div class="fl-media">' + media.join('') + '</div>' : '') + '<p class="fl-note">Source: ' + esc(vendorName(c.provider || inc.provider)) + ' camera, verified by Nexus before any dispatch or claim.</p>');
    }

    if (dx && dx.dtcs && dx.dtcs.length) {
      h += sec('Trouble codes, in plain language', NX.badgeHTML(dx.drivable === 'yes' ? 'Drivable' : dx.drivable === 'limp' ? 'Limp mode' : 'Do not drive', dx.drivable === 'yes' ? 'ok' : dx.drivable === 'limp' ? 'warn' : 'danger'),
        dx.dtcs.map(function (t) {
          return '<div class="fl-dtc"><div class="fl-dtc__top"><span class="fl-dtc__code">' + esc(t.code) + '</span>' + (t.severity ? NX.badgeHTML(t.severity) : '') + (t.system ? '<span class="nx-dim" style="font-size:12px">' + esc(t.system) + '</span>' : '') + '</div><p><b>' + esc(t.desc || 'Unrecognized code') + '</b></p>' +
            (t.recommendedAction ? '<p>What to do: ' + esc(t.recommendedAction) + '</p>' : '') + (t.partsHint ? '<p>Likely parts: ' + esc(t.partsHint) + '</p>' : '') + '</div>';
        }).join('') + '<div class="nx-dim" style="font-size:12px">' + (dx.faultLampOn ? 'Check-engine lamp is on. ' : '') + (dx.engineHours ? fmt.number(dx.engineHours) + ' engine hours.' : '') + '</div>');
    }

    if (rs && (rs.needed || rs.assignedProvider || rs.recommendedProvider)) {
      var p = rs.assignedProvider || rs.recommendedProvider, eta = rs.etaMin != null ? rs.etaMin : p && p.etaMin;
      h += sec('Roadside assistance', rs.assignedProvider ? NX.badgeHTML('Assigned', 'ok') : NX.badgeHTML('Pre-staged', 'info'),
        '<div class="fl-kvs"><div><span>Service</span><b>' + esc(fmt.label(rs.serviceType || 'none')) + '</b></div><div><span>Provider</span><b>' + esc(p ? p.name : 'Not yet assigned') + '</b></div><div><span>ETA</span><b>' + (eta != null ? eta + ' min' : '—') + '</b></div><div><span>Distance</span><b>' + (p && p.distanceMi != null ? fmt.number(p.distanceMi, 1) + ' mi' : '—') + '</b></div></div>');
    } else if (rs) {
      h += sec('Roadside assistance', '', '<span class="nx-dim">No roadside service needed for this event.</span>');
    }

    if (w) {
      var cp = w.claimPacket;
      h += sec('Warranty', w.claimEligible ? NX.badgeHTML(cp ? claimLabel(cp.status) : 'Eligible', cp && cp.status === 'submitted' ? 'info' : 'accent') : NX.badgeHTML('No claim', 'plain'),
        '<div class="fl-kvs"><div><span>OEM</span><b>' + esc(w.oem || v.oem || '—') + '</b></div><div><span>Coverage</span><b>' + (w.inWarranty ? esc(fmt.label(w.coverage)) : 'Out of warranty') + '</b></div><div><span>Expires</span><b>' + (w.expiresAt ? esc(fmt.date(w.expiresAt)) : '—') + '</b></div><div><span>Miles remaining</span><b>' + (w.milesRemaining != null ? fmt.number(w.milesRemaining) : '—') + '</b></div>' +
        (cp ? '<div><span>Claim status</span><b>' + esc(claimLabel(cp.status)) + '</b></div>' + (cConfirm(inc) ? '<div><span>Confirmation</span><b class="nx-mono" style="font-size:12px">' + esc(cConfirm(inc)) + '</b></div>' : '') + '<div><span>Estimated value</span><b>' + fmt.currency(cp.estimatedValueUsd) + '</b></div>' : '') + '</div>' +
        (cp && cp.summary ? '<p class="nx-dim" style="font-size:13px;margin:10px 0 0">' + esc(cp.summary) + '</p>' : '') +
        (w.claimEligible ? '<div style="margin-top:12px">' + claimStepper(inc) + '</div>' : '') + (w.claimEligible ? '<div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">' + (cStatus(inc) === 'ready' ? '<button class="nx-btn nx-btn--primary nx-btn--sm" id="d-submit">Submit claim</button>' : '') + '<a class="nx-btn nx-btn--sm" target="_blank" rel="noopener" href="/api/incidents/' + encodeURIComponent(inc.id) + '/warranty-packet?format=html">Open claim packet</a></div>' + (cStatus(inc) === 'ready' ? '<div class="fl-note">Submission is simulated in the demo.</div>' : '') : ''));
    }

    h += sec('Vehicle and driver', '', '<div class="fl-kvs"><div><span>Vehicle</span><b>' + esc(vehSub(inc) || '—') + '</b></div><div><span>Plate / VIN</span><b class="nx-mono" style="font-size:12px">' + esc(v.plate || '') + ' ' + esc(v.vin || '') + '</b></div><div><span>Odometer</span><b>' + (v.odometer_mi != null ? fmt.number(v.odometer_mi) + ' mi' : '—') + '</b></div><div><span>Speed at event</span><b>' + (l.speed_mph != null ? Math.round(l.speed_mph) + ' mph' : '—') + '</b></div><div><span>Driver</span><b>' + esc(d.name || '—') + '</b></div><div><span>Driver safety score</span><b>' + (d.safetyScore != null ? fmt.number(d.safetyScore) : '—') + '</b></div></div>');
    h += '</div>';
    var dr = $('drawer'), top = dr.scrollTop;
    dr.innerHTML = h; dr.scrollTop = top;
    $('d-close').onclick = closeDrawer;
    var ds = $('d-submit'); if (ds) ds.onclick = function () { submitClaim(inc.id, ds); };
    dr.querySelectorAll('.tile video, .tile img').forEach(function (m) { m.addEventListener('error', function () { m.remove(); }); });
  }
  function mediaTile(kind, url, label) {
    var asImg = kind === 'img' || /\.(svg|png|jpe?g|webp|gif)(\?|$)/i.test(url || '');
    var inner = url ? (asImg ? '<img src="' + esc(url) + '" alt="' + esc(label) + '" loading="lazy">' : '<video src="' + esc(url) + '" controls preload="none" muted></video>') : '';
    return '<div class="tile">' + inner + '<span class="lbl">' + (kind === 'video' ? '▶ ' : '') + esc(label) + '</span></div>';
  }


  /* ---------------- load / context helpers ---------------- */
  var CATS = { perishable_food: 'Perishable food', frozen_food: 'Frozen food', dry_grocery: 'Dry grocery', beverage: 'Beverage', building_materials: 'Building materials', steel: 'Steel', lumber: 'Lumber', machinery: 'Machinery', vehicles: 'Vehicles', fuel_liquid: 'Liquid fuel', hazmat: 'Hazmat', aggregate: 'Aggregate', parcel: 'Parcel', unknown: 'Unknown' };
  var catLabel = function (c) { return CATS[c] || fmt.label(c || 'unknown'); };
  var PLACES = { food_distributor: 'Food distributor', grocery_dc: 'Grocery DC', cold_storage: 'Cold storage', steel_yard: 'Steel yard', lumber_yard: 'Lumber yard', building_supply: 'Building supply', fuel_stop: 'Fuel stop', truck_stop: 'Truck stop', port: 'Port', manufacturer: 'Manufacturer', farm: 'Farm', quarry: 'Quarry', retail_dc: 'Retail DC', parcel_hub: 'Parcel hub', unknown: 'Stop' };
  var lb = function (n) { return n == null ? '—' : fmt.number(n) + ' lb'; };
  var usdRange = function (a) { return !a ? '—' : Array.isArray(a) ? (a[0] === a[1] ? fmt.currency(a[0]) : fmt.currency(a[0]) + ' – ' + fmt.currency(a[1])) : fmt.currency(a); };
  var usdMid = function (a) { return !a ? 0 : Array.isArray(a) ? (num(a[0], 0) + num(a[1], 0)) / 2 : num(a, 0); };
  function shiftRisk(i) {
    var t = i.equipment && i.equipment.trailer && i.equipment.trailer.type, c = i.load && i.load.contents && i.load.contents.category;
    return ['flatbed', 'lowboy', 'car_hauler'].indexOf(t) > -1 || ['steel', 'lumber', 'machinery', 'vehicles'].indexOf(c) > -1;
  }
  function spoilLeft(i) { // hours left on spoilage clock from incident time
    var c = i.load && i.load.contents; if (!c || c.spoilageRiskHours == null) return null;
    return c.spoilageRiskHours - (Date.now() - new Date(i.timestamp)) / 3600000;
  }
  function loads() { return S.incidents.filter(function (i) { return i.load && i.load.estimatedWeightLb != null; }); }
  function spark(series, key, color, label, unit) {
    var pts = (series || []).filter(function (p) { return p[key] != null; });
    if (pts.length < 2) return '';
    var W = 240, H = 56, mn = Math.min.apply(null, pts.map(function (p) { return p[key]; })), mx = Math.max.apply(null, pts.map(function (p) { return p[key]; }));
    if (mx === mn) { mx += 1; mn -= 1; }
    var d = pts.map(function (p, i) { return (i * W / (pts.length - 1)).toFixed(1) + ',' + (H - 4 - (p[key] - mn) / (mx - mn) * (H - 8)).toFixed(1); }).join(' ');
    return '<div class="fl-spark"><div class="fl-spark__l"><span>' + label + '</span><b class="nx-mono">' + pts[pts.length - 1][key].toFixed(key === 'fuelMpg' ? 1 : 0) + unit + '</b></div><svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="' + label + ' over time"><polyline points="' + d + '" fill="none" stroke="' + color + '" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg></div>';
  }
  function delta(v, unit, goodDown) { if (v == null) return ''; var up = v > 0; return '<span class="' + ((goodDown ? !up : up) ? 'fl-d-ok' : 'fl-d-bad') + ' nx-mono">' + (up ? '+' : '') + Number(v).toFixed(1) + unit + '</span>'; }

  function contextSection(inc) {
    var tr = inc.trip, eq = inc.equipment, ld = inc.load, wd = inc.warrantyDealer, rs = inc.roadside;
    if (!tr && !eq && !ld && !wd) return '';
    var h = '';
    if (tr && tr.lastStop) {
      var ls = tr.lastStop;
      h += '<div class="fl-ctx"><div class="fl-ctx__t">Last stop</div><b>' + esc(ls.businessName || ls.name) + '</b> <span class="nx-dim">' + esc(PLACES[ls.placeType] || fmt.label(ls.placeType)) + '</span><div class="nx-dim" style="font-size:12px">' +
        [ls.dwellMin != null ? ls.dwellMin + ' min dwell' : '', ls.minutesBeforeIncident != null ? ls.minutesBeforeIncident + ' min before event' : '', ls.milesSinceStop != null ? fmt.number(ls.milesSinceStop, 1) + ' mi since' : ''].filter(Boolean).join(' · ') + '</div>' +
        (ls.address ? '<div class="nx-faint" style="font-size:12px">' + esc(ls.address) + '</div>' : '') + '</div>';
    }
    var te = tr && tr.telemetry;
    if (te) {
      var b = te.before || {}, a = te.after || {};
      h += '<div class="fl-ctx"><div class="fl-ctx__t">Engine load and fuel economy around the stop</div><div class="fl-spark-wrap">' + spark(te.series, 'engineLoadPct', 'var(--nx-accent)', 'Engine load', '%') + spark(te.series, 'fuelMpg', 'var(--nx-info)', 'Fuel economy', ' mpg') + '</div>' +
        '<div class="fl-kvs" style="margin-top:8px"><div><span>Before stop</span><b class="nx-mono" style="font-size:12px">' + (b.avgEngineLoadPct != null ? Math.round(b.avgEngineLoadPct) + '% load' : '—') + ' · ' + (b.avgFuelMpg != null ? Number(b.avgFuelMpg).toFixed(1) + ' mpg' : '—') + '</b></div><div><span>After departure</span><b class="nx-mono" style="font-size:12px">' + (a.avgEngineLoadPct != null ? Math.round(a.avgEngineLoadPct) + '% load' : '—') + ' · ' + (a.avgFuelMpg != null ? Number(a.avgFuelMpg).toFixed(1) + ' mpg' : '—') + '</b></div><div><span>Load change</span><b>' + (delta(te.deltaEngineLoadPct, '%', false) || '—') + '</b></div><div><span>Fuel economy change</span><b>' + (delta(te.deltaFuelMpg, ' mpg', false) || '—') + '</b></div></div></div>';
    }
    var t = eq && eq.trailer;
    if (t || (eq && eq.tractor)) {
      var tc = eq.tractor || {};
      h += '<div class="fl-ctx"><div class="fl-ctx__t">Trailer</div>' + (t && t.attached !== false && t.type !== 'none' ?
        '<b>' + esc(fmt.label(t.type)) + '</b>' + (t.lengthFt ? ' <span class="nx-dim">' + t.lengthFt + ' ft</span>' : '') + ' ' + (t.cameraVerified ? NX.badgeHTML('Camera verified', 'ok') : NX.badgeHTML('Inferred', 'plain')) +
        '<div class="nx-dim" style="font-size:12px;margin-top:4px">' + (t.cameraBasis ? esc(t.cameraBasis) : 'Detected by ' + esc(fmt.label(t.detectedBy || 'inferred'))) + (t.maxPayloadLb ? ' · max payload ' + lb(t.maxPayloadLb) : '') + '</div>' +
        (t.reefer ? '<div style="font-size:13px;margin-top:4px">Reefer ' + (t.reefer.unitRunning ? 'running' : 'off') + (t.reefer.setpointF != null ? ' · setpoint ' + t.reefer.setpointF + 'F' : '') + (t.reefer.returnAirF != null ? ' · return air ' + t.reefer.returnAirF + 'F' : '') + (t.reefer.fuelPct != null ? ' · fuel ' + t.reefer.fuelPct + '%' : '') + '</div>' : '')
        : '<span class="nx-dim">No trailer attached (' + esc(fmt.label(tc.class || 'straight truck')) + ')</span>') + '</div>';
    }
    if (ld) {
      var c = ld.contents || {}, pct = ld.payloadPctOfMax, sl = spoilLeft(inc), open = isOpen(inc);
      h += '<div class="fl-ctx"><div class="fl-ctx__t">Estimated load <span class="nx-faint">· estimate, not scale weight</span></div>' +
        '<div class="nx-row" style="justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap"><div><span class="fl-big">' + lb(ld.estimatedWeightLb) + '</span>' + (ld.weightRangeLb ? ' <span class="nx-dim nx-mono" style="font-size:11px">range ' + fmt.number(ld.weightRangeLb[0]) + '–' + fmt.number(ld.weightRangeLb[1]) + '</span>' : '') + '</div><div>' + (ld.overweightRisk ? NX.badgeHTML('Overweight risk', 'danger') : NX.badgeHTML('Within limits', 'ok')) + '</div></div>' +
        (pct != null ? '<div class="nx-meter" style="margin:8px 0 4px"><i style="width:' + Math.min(100, pct) + '%;--c:' + (pct > 100 ? 'var(--nx-danger)' : pct > 90 ? 'var(--nx-sev-medium)' : 'var(--nx-ok)') + '"></i></div><div class="nx-dim nx-mono" style="font-size:11px">' + Math.round(pct) + '% of max payload' + (ld.grossVehicleWeightLb ? ' · GVW ' + lb(ld.grossVehicleWeightLb) : '') + '</div>' : '') +
        '<div style="margin-top:10px"><b>' + esc(c.label || catLabel(c.category)) + '</b> ' + (c.hazmat ? NX.badgeHTML('Hazmat', 'danger') : '') + (c.temperatureSensitive ? NX.badgeHTML('Temperature sensitive', 'info') : '') + (shiftRisk(inc) ? NX.badgeHTML('Shifting-load risk', 'warn') : '') + '</div>' +
        (c.examples && c.examples.length ? '<div class="nx-dim" style="font-size:12px">e.g. ' + esc(c.examples.join(', ')) + '</div>' : '') +
        (c.estimatedValueUsd ? '<div style="font-size:13px;margin-top:4px">Cargo value ' + usdRange(c.estimatedValueUsd) + '</div>' : '') +
        (sl != null && c.spoilageRiskHours != null ? '<div class="fl-clock ' + (sl < 0 ? 'bad' : sl < 2 ? 'warn' : '') + '">' + (open ? (sl <= 0 ? 'Spoilage window passed' : 'Spoilage clock: about ' + (sl < 1 ? Math.round(sl * 60) + ' min' : sl.toFixed(1) + ' h') + ' left') : 'Spoilage window was ' + c.spoilageRiskHours + ' h') + '</div>' : '') +
        (ld.cameraVisual && ld.cameraVisual.description ? '<div class="fl-note" style="margin-top:8px">Camera sees: ' + esc(ld.cameraVisual.description) + (ld.cameraVisual.confidence != null ? ' (' + Math.round(ld.cameraVisual.confidence * 100) + '%)' : '') + '</div>' : '') +
        ((ld.basis && ld.basis.length) ? '<details class="fl-how"' + '><summary>How we know' + (ld.confidence != null ? ' · ' + Math.round(ld.confidence * 100) + '% confidence' : '') + '</summary><ul>' + ld.basis.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' + (ld.method ? '<div class="nx-faint nx-mono" style="font-size:10.5px">Method: ' + esc(fmt.label(ld.method)) + '</div>' : '') + '</details>' : '') + '</div>';
    }
    if (rs && rs.towDestination) { var td = rs.towDestination; h += '<div class="fl-ctx"><div class="fl-ctx__t">Tow destination</div><b>' + esc(td.name) + '</b> <span class="nx-dim">' + esc(fmt.label(td.kind)) + '</span><div class="nx-dim" style="font-size:12px">' + esc(td.address || '') + (td.distanceMi != null ? ' · ' + fmt.number(td.distanceMi, 1) + ' mi' : '') + '</div></div>'; }
    if (wd && wd.nearest) {
      var n = wd.nearest;
      h += '<div class="fl-ctx"><div class="fl-ctx__t">OEM warranty dealer · ' + esc(wd.oem || '') + '</div><b>' + esc(n.name) + '</b> ' + (n.open24x7 ? NX.badgeHTML('Open 24/7', 'ok') : '') + (n.heavyDutyBays ? NX.badgeHTML('Heavy-duty bays', 'info') : '') + (n.hasPartsInStock ? NX.badgeHTML('Parts in stock', 'ok') : '') +
        '<div class="nx-dim" style="font-size:12px">' + esc(n.address || '') + '</div><div class="fl-kvs" style="margin-top:6px"><div><span>Distance / drive</span><b>' + (n.distanceMi != null ? fmt.number(n.distanceMi, 1) + ' mi' : '—') + (n.driveEtaMin != null ? ' · ' + n.driveEtaMin + ' min' : '') + '</b></div><div><span>Phone</span><b class="nx-mono" style="font-size:12px">' + esc(n.phone || '—') + '</b></div><div><span>Hours</span><b>' + esc(n.hours || '—') + '</b></div><div><span>Pre-authorization</span><b>' + (wd.authorizationRequired ? esc(wd.preAuthNumber || 'Required') : 'Not required') + '</b></div></div>' +
        (wd.reason ? '<div class="nx-dim" style="font-size:12px;margin-top:6px">' + esc(wd.reason) + '</div>' : '') +
        ((wd.alternates && wd.alternates.length) ? '<div class="nx-faint" style="font-size:12px;margin-top:6px">Alternates: ' + wd.alternates.map(function (x) { return esc(x.name) + (x.distanceMi != null ? ' (' + fmt.number(x.distanceMi, 0) + ' mi)' : ''); }).join(' · ') + '</div>' : '') + '</div>';
    }
    return sec('What was happening', '', h);
  }

  /* ---------------- cargo overview ---------------- */
  function renderCargo() {
    var host = $('cargo'); if (!host) return;
    var bc = S.summary && S.summary.byContent, rows = [];
    if (Array.isArray(bc)) rows = bc.map(function (r) { return { cat: r.category || r.content || r.name, n: num(r.incidents != null ? r.incidents : r.count, 0), usd: usdMid(r.estValueUsd != null ? r.estValueUsd : r.valueUsd) }; });
    else if (bc && typeof bc === 'object') rows = Object.keys(bc).map(function (k) { var v = bc[k]; return typeof v === 'object' ? { cat: k, n: num(v.incidents != null ? v.incidents : v.count, 0), usd: usdMid(v.estValueUsd != null ? v.estValueUsd : v.valueUsd) } : { cat: k, n: num(v, 0), usd: 0 }; });
    else { var m = {}; loads().forEach(function (i) { var c = (i.load.contents || {}); var k = c.category || 'unknown'; m[k] = m[k] || { cat: k, n: 0, usd: 0 }; m[k].n++; m[k].usd += usdMid(c.estimatedValueUsd); }); rows = Object.keys(m).map(function (k) { return m[k]; }); }
    rows = rows.filter(function (r) { return r.cat; }).sort(function (a, b) { return b.usd - a.usd || b.n - a.n; });
    if (!rows.length) { host.innerHTML = ''; host.appendChild(NX.empty('No load context yet', 'Cargo estimates appear when incidents include trip and load data.')); return; }
    var max = Math.max.apply(null, rows.map(function (r) { return r.usd || r.n; })) || 1;
    host.innerHTML = '<div class="fl-bars">' + rows.slice(0, 8).map(function (r) {
      return '<div class="fl-bar fl-bar--wide"><span title="' + esc(catLabel(r.cat)) + '">' + esc(catLabel(r.cat)) + '</span><div class="nx-meter"><i style="width:' + ((r.usd || r.n) / max * 100) + '%"></i></div><span class="fl-bar__n">' + (r.usd ? fmt.currency(r.usd) : '') + ' · ' + r.n + '</span></div>';
    }).join('') + '</div><p class="fl-note">Values are estimates from stop type, trailer and load inference; open incidents drive the cargo-at-risk total.</p>';
  }

  /* ---------------- loads view ---------------- */
  function renderLoads() {
    var host = $('load-body'); if (!host) return;
    var ls = loads();
    if (!ls.length) { host.innerHTML = ''; host.appendChild(NX.empty('No load context yet', 'Estimated payload appears here once Nexus can place a vehicle at a pickup stop.')); return; }
    var f = S.loadFilter || 'all';
    var ow = ls.filter(function (i) { return i.load.overweightRisk; }), per = ls.filter(function (i) { var c = i.load.contents || {}; return c.temperatureSensitive || c.spoilageRiskHours != null; }), sh = ls.filter(shiftRisk), hz = ls.filter(function (i) { return i.load.contents && i.load.contents.hazmat; });
    var avg = ls.filter(function (i) { return i.load.payloadPctOfMax != null; });
    var avgPct = avg.length ? avg.reduce(function (a, i) { return a + i.load.payloadPctOfMax; }, 0) / avg.length : null;
    var clocks = per.filter(function (i) { var l = spoilLeft(i); return isOpen(i) && l != null && l > 0; });
    var sets = { all: ls, over: ow, perish: per, shift: sh, hazmat: hz };
    var rows = sets[f] || ls;
    var html = '<div class="nx-kpis"><div class="nx-kpi"><div class="nx-kpi__label">Loaded incidents</div><div class="nx-kpi__value">' + ls.length + '</div><div class="nx-kpi__delta">with estimated payload</div></div>' +
      '<div class="nx-kpi ' + (ow.length ? 'nx-kpi--critical' : '') + '"><div class="nx-kpi__label">Overweight risk</div><div class="nx-kpi__value">' + ow.length + '</div><div class="nx-kpi__delta">over payload or GVW margin</div></div>' +
      '<div class="nx-kpi ' + (clocks.length ? 'nx-kpi--accent' : '') + '"><div class="nx-kpi__label">Spoilage clocks running</div><div class="nx-kpi__value">' + clocks.length + '</div><div class="nx-kpi__delta">open perishable loads</div></div>' +
      '<div class="nx-kpi"><div class="nx-kpi__label">Shifting-load risk</div><div class="nx-kpi__value">' + sh.length + '</div><div class="nx-kpi__delta">flatbed / steel / lumber</div></div>' +
      '<div class="nx-kpi"><div class="nx-kpi__label">Avg payload of max</div><div class="nx-kpi__value">' + (avgPct == null ? '—' : Math.round(avgPct) + '%') + '</div><div class="nx-kpi__delta">' + hz.length + ' hazmat</div></div></div>' +
      '<div class="fl-filters"><div class="fl-pills nx-chips">' + [['all', 'All', ls], ['over', 'Overweight', ow], ['perish', 'Perishable', per], ['shift', 'Shifting load', sh], ['hazmat', 'Hazmat', hz]].map(function (t) { return '<button class="nx-chip' + (f === t[0] ? ' is-active' : '') + '" data-f="' + t[0] + '">' + t[1] + ' ' + t[2].length + '</button>'; }).join('') + '</div></div>';
    html += rows.length ? '<div class="nx-card nx-card--flush"><div class="nx-table-wrap"><table class="nx-table"><thead><tr><th>Vehicle</th><th>Event</th><th>Content</th><th class="num">Est. weight</th><th>Payload of max</th><th>Risk flags</th><th>Cargo value</th><th>When</th></tr></thead><tbody>' + rows.slice(0, 150).map(function (i) {
      var c = i.load.contents || {}, pct = i.load.payloadPctOfMax, sl = spoilLeft(i), fl = [];
      if (i.load.overweightRisk) fl.push(NX.badgeHTML('Overweight', 'danger'));
      if (c.hazmat) fl.push(NX.badgeHTML('Hazmat', 'danger'));
      if (shiftRisk(i)) fl.push(NX.badgeHTML('Shifting load', 'warn'));
      if (sl != null && isOpen(i)) fl.push(NX.badgeHTML(sl > 0 ? (sl < 1 ? Math.round(sl * 60) + ' min' : sl.toFixed(1) + ' h') + ' to spoil' : 'Spoilage passed', sl > 2 ? 'info' : 'warn'));
      else if (c.temperatureSensitive) fl.push(NX.badgeHTML('Temp sensitive', 'info'));
      return '<tr class="fl-row-click" data-id="' + esc(i.id) + '"><td>' + esc(vehLabel(i)) + '<span class="sub">' + esc(vehSub(i)) + '</span></td><td>' + esc(typeLabel(i.eventType)) + '<span class="sub">' + NX.badgeHTML(i.severity) + '</span></td><td>' + esc(c.label || catLabel(c.category)) + '<span class="sub">' + esc(i.equipment && i.equipment.trailer ? fmt.label(i.equipment.trailer.type) : '') + '</span></td><td class="num">' + lb(i.load.estimatedWeightLb) + '<span class="sub">' + (i.load.confidence != null ? Math.round(i.load.confidence * 100) + '% conf.' : '') + '</span></td><td style="min-width:130px">' + (pct == null ? '—' : '<div class="nx-meter"><i style="width:' + Math.min(100, pct) + '%;--c:' + (pct > 100 ? 'var(--nx-danger)' : pct > 90 ? 'var(--nx-sev-medium)' : 'var(--nx-ok)') + '"></i></div><span class="sub nx-mono">' + Math.round(pct) + '%</span>') + '</td><td class="wrap">' + (fl.join(' ') || '<span class="nx-faint">None</span>') + '</td><td>' + usdRange(c.estimatedValueUsd) + '</td><td class="dim nx-mono">' + fmt.ago(i.timestamp) + '</td></tr>';
    }).join('') + '</tbody></table></div></div>' : '';
    host.innerHTML = html;
    if (!rows.length) host.appendChild(NX.empty('Nothing flagged', 'No loads match this filter.'));
    host.querySelectorAll('[data-f]').forEach(function (b) { b.onclick = function () { S.loadFilter = b.dataset.f; renderLoads(); }; });
    bindRows(host);
    var n = $('cnt-load'); if (n) n.textContent = ls.length;
  }


  /* ---------------- Ahead of risk (predictive) ---------------- */
  var KIND = { driver_risk_spike: 'Driver risk spike', fatigue_pattern: 'Fatigue pattern', following_distance_trend: 'Following-distance trend', hotspot_forming: 'Hotspot forming', vehicle_breakdown_risk: 'Breakdown risk', maintenance_overdue: 'Maintenance overdue' };
  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  function apiOr(path, opts, dflt) { return NX.api(path, opts).catch(function (e) { return e.status === 404 ? dflt : Promise.reject(e); }); }
  function loadPredict() {
    var id = S.fleet.id, host = $('v-predict');
    host.innerHTML = predictShell();
    S.pred = { horizon: S.pred && S.pred.horizon || 90, picked: {}, alerts: [] };
    var q = { fleetId: id };
    Promise.all([
      NX.api('/api/predict/fleet/' + encodeURIComponent(id), { query: { horizonDays: 90 } }).catch(function (e) { return { _err: e }; }),
      NX.api('/api/predict/drivers', { query: { fleetId: id, limit: 8 } }).catch(function () { return null; }),
      NX.api('/api/predict/alerts', { query: { fleetId: id, limit: 30 } }).catch(function () { return null; }),
      NX.api('/api/predict/backtest', { query: q }).catch(function () { return null; })
    ]).then(function (r) {
      if (S.fleet.id !== id) return;
      var f = r[0];
      if (f && f._err) { $('pr-main').innerHTML = ''; $('pr-main').appendChild(NX.empty('Predictions unavailable', 'The predictive service did not respond (' + f._err.message + ').')); return; }
      S.pred.fleet = f; S.pred.drivers = (r[1] && r[1].drivers) || r[1] || []; setTimeout(renderAttention, 0); S.pred.alerts = (r[2] && r[2].alerts) || r[2] || []; S.pred.bt = r[3];
      renderPredict();
    });
  }
  function predictShell() {
    return '<div id="pr-main"><div class="nx-kpis" id="pr-kpis"></div>' +
      '<div class="fl-grid"><div class="nx-card"><div class="nx-card__head"><h3 class="nx-card__title">Risk forecast</h3><div class="nx-chips" id="pr-hz"></div></div><div class="nx-card__body fl-chart" id="pr-chart"></div></div>' +
      '<div class="nx-card"><div class="nx-card__head"><h3 class="nx-card__title">Leading indicators</h3></div><div class="nx-card__body" id="pr-ind"></div></div></div>' +
      '<div class="fl-grid fl-grid--even"><div class="nx-card"><div class="nx-card__head"><h3 class="nx-card__title">What-if: act now</h3></div><div class="nx-card__body" id="pr-whatif"></div></div>' +
      '<div class="nx-card"><div class="nx-card__head"><h3 class="nx-card__title">Proactive alerts</h3><span class="nx-dim nx-mono" id="pr-alert-n"></span></div><div class="nx-card__body nx-card--flush" id="pr-alerts" style="max-height:420px;overflow:auto"></div></div></div>' +
      '<div class="nx-card" style="margin-bottom:16px"><div class="nx-card__head"><h3 class="nx-card__title">Drivers most likely to be involved next</h3></div><div class="nx-card__body nx-card--flush" id="pr-drivers"></div></div>' +
      '<div class="fl-grid fl-grid--even"><div class="nx-card"><div class="nx-card__head"><h3 class="nx-card__title">Hotspots</h3></div><div class="fl-map" id="pr-map" style="height:340px"></div></div>' +
      '<div class="nx-card"><div class="nx-card__head"><h3 class="nx-card__title">When risk concentrates</h3></div><div class="nx-card__body" id="pr-pattern"></div></div></div>' +
      '<div class="nx-card"><div class="nx-card__head"><h3 class="nx-card__title">What we would have caught</h3><span class="nx-dim nx-mono">backtest</span></div><div class="nx-card__body" id="pr-bt"></div></div></div>';
  }
  function renderPredict() {
    var P = S.pred, f = P.fleet, k = f.risk || {}, ex = f.expected || {};
    var dirIcon = { improving: '↘', worsening: '↗', stable: '→' }[k.direction] || '';
    var dirCls = k.direction === 'improving' ? 'nx-kpi--ok' : k.direction === 'worsening' ? 'nx-kpi--critical' : '';
    var fv = function (v, d) { return v == null ? '—' : fmt.number(v, d); };
    $('pr-kpis').innerHTML = [
      ['Risk score now', fv(k.current), '', 'higher is riskier'],
      ['Projected 30d', fv(k.projected30d) + ' ' + dirIcon, dirCls, fmt.label(k.direction || 'stable') + (k.band90d ? ' · 90d band ' + Math.round(k.band90d[0]) + '–' + Math.round(k.band90d[1]) : '')],
      ['Expected incidents, 30d', fv(ex.incidents30d, 1), '', ex.collisions30d != null ? '~' + fv(ex.collisions30d, 1) + ' collisions' : ''],
      ['Collision probability, 30d', ex.collisionProb30d == null ? '—' : (ex.collisionProb30d <= 1 ? Math.round(ex.collisionProb30d * 100) : Math.round(ex.collisionProb30d)) + '%', '', 'at least one collision'],
      ['Expected loss, 90d', ex.expectedLossUsd90d == null ? '—' : fmt.currency(ex.expectedLossUsd90d), 'nx-kpi--accent', 'before prevention']
    ].map(function (i) { return '<div class="nx-kpi ' + i[2] + '"><div class="nx-kpi__label">' + i[0] + '</div><div class="nx-kpi__value">' + esc(i[1]) + '</div><div class="nx-kpi__delta">' + esc(i[3]) + '</div></div>'; }).join('');
    $('pr-hz').innerHTML = [30, 90].map(function (h) { return '<button class="nx-chip' + (P.horizon === h ? ' is-active' : '') + '" data-h="' + h + '">' + h + ' days</button>'; }).join('');
    $('pr-hz').querySelectorAll('[data-h]').forEach(function (b) { b.onclick = function () { P.horizon = +b.dataset.h; renderPredict(); }; });
    drawForecast(); renderIndicators(); renderWhatIf(); renderAlerts(); renderPredDrivers(); renderPattern(); renderBacktest(); initPredMap();
  }
  function drawForecast() {
    var P = S.pred, host = $('pr-chart'), ser = (P.fleet.series || []).slice();
    var today = new Date().toISOString().slice(0, 10), last = new Date(Date.now() + P.horizon * 86400000).toISOString().slice(0, 10);
    ser = ser.filter(function (p) { return p.date <= last; });
    if (ser.length < 2) { host.innerHTML = ''; host.appendChild(NX.empty('No forecast series')); return; }
    var W = 720, H = 240, L = 30, R = 8, T = 10, B = 24, vals = [];
    ser.forEach(function (p) { ['actual', 'projected', 'lo', 'hi'].forEach(function (k) { if (p[k] != null) vals.push(p[k]); }); });
    var mx = Math.min(100, Math.ceil((Math.max.apply(null, vals) + 5) / 10) * 10), mn = Math.max(0, Math.floor((Math.min.apply(null, vals) - 5) / 10) * 10);
    var x = function (i) { return L + i * (W - L - R) / (ser.length - 1); }, y = function (v) { return T + (H - T - B) * (1 - (v - mn) / (mx - mn || 1)); };
    var line = function (k) { var seg = [], out = []; ser.forEach(function (p, i) { if (p[k] != null) seg.push(x(i).toFixed(1) + ',' + y(p[k]).toFixed(1)); }); return seg.join(' '); };
    var up = [], dn = []; ser.forEach(function (p, i) { if (p.lo != null && p.hi != null) { up.push(x(i).toFixed(1) + ',' + y(p.hi).toFixed(1)); dn.unshift(x(i).toFixed(1) + ',' + y(p.lo).toFixed(1)); } });
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Risk score actual and projected">';
    for (var g = 0; g <= 4; g++) { var gv = mn + (mx - mn) * g / 4; svg += '<line class="grid" x1="' + L + '" x2="' + (W - R) + '" y1="' + y(gv) + '" y2="' + y(gv) + '"/><text x="' + (L - 6) + '" y="' + (y(gv) + 3) + '" text-anchor="end">' + Math.round(gv) + '</text>'; }
    if (up.length) svg += '<polygon class="band" points="' + up.join(' ') + ' ' + dn.join(' ') + '"/>';
    var ti = ser.findIndex(function (p) { return p.date >= today; }); if (ti > 0) svg += '<line class="hov" x1="' + x(ti) + '" x2="' + x(ti) + '" y1="' + T + '" y2="' + (H - B) + '"/><text x="' + (x(ti) + 4) + '" y="' + (T + 8) + '">today</text>';
    svg += '<polyline class="line" points="' + line('actual') + '"/><polyline class="line proj" points="' + line('projected') + '"/>';
    var step = Math.max(1, Math.round(ser.length / 6));
    ser.forEach(function (p, i) { if (i % step === 0 || i === ser.length - 1) svg += '<text x="' + x(i) + '" y="' + (H - 6) + '" text-anchor="' + (i === 0 ? 'start' : i === ser.length - 1 ? 'end' : 'middle') + '">' + new Date(p.date + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + '</text>'; });
    host.innerHTML = svg + '</svg><div class="fl-legend" style="border:0;padding:8px 0 0"><span><i style="--c:var(--nx-accent)"></i>Actual</span><span><i style="--c:var(--nx-info)"></i>Projected</span><span><i style="--c:color-mix(in srgb,var(--nx-info) 25%,transparent)"></i>Confidence band</span></div>';
  }
  function trendArrow(d, pct) { var up = d === 'up' || d === 'worsening' || pct > 0; var dn = d === 'down' || d === 'improving' || pct < 0; if (d === 'flat' || d === 'stable') up = dn = false; return '<span class="fl-trend ' + (up ? 'bad' : dn ? 'good' : '') + '">' + (up ? '↑' : dn ? '↓' : '→') + (pct != null ? ' ' + Math.abs(Math.round(pct)) + '%' : '') + '</span>'; }
  function renderIndicators() {
    var ind = (S.pred.fleet.leadingIndicators || []).slice().sort(function (a, b) { return num(b.contributionToRisk, 0) - num(a.contributionToRisk, 0); });
    var host = $('pr-ind'); if (!ind.length) { host.innerHTML = ''; host.appendChild(NX.empty('No indicators')); return; }
    var mx = Math.max.apply(null, ind.map(function (i) { return num(i.contributionToRisk, 0); })) || 1;
    host.innerHTML = ind.map(function (i) { var c = num(i.contributionToRisk, 0); return '<div class="fl-ind"><div class="fl-ind__top"><span>' + esc(i.label || fmt.label(i.key)) + '</span><span class="nx-mono">' + (i.value != null ? esc(fmt.number(i.value, 1)) + ' ' + esc(i.unit || '') : '') + ' ' + trendArrow(i.direction, i.trendPct) + '</span></div><div class="nx-meter" title="Contribution to risk"><i style="width:' + (c / mx * 100) + '%"></i></div><div class="nx-faint nx-mono" style="font-size:10.5px">' + (c <= 1 ? Math.round(c * 100) : Math.round(c)) + (c <= 1 ? '%' : ' pts') + ' of risk</div></div>'; }).join('') + '<p class="fl-note">Contribution is each indicator\'s weighted share of the current risk score. Demo-calibrated model.</p>';
  }
  function whatIfLocal(keys) {
    var iv = S.pred.fleet.interventions || [], sel = iv.filter(function (i) { return keys.indexOf(i.key) > -1; });
    var red = 100 * (1 - sel.reduce(function (a, i) { return a * (1 - num(i.expectedRiskReductionPct, 0) / 100); }, 1));
    return { riskReductionPct: red, avoidedIncidents90d: sel.reduce(function (a, i) { return a + num(i.expectedAvoidedIncidents90d, 0); }, 0), savingsUsd: sel.reduce(function (a, i) { return a + num(i.expectedSavingsUsd, 0); }, 0), local: true };
  }
  function renderWhatIf() {
    var iv = S.pred.fleet.interventions || [], host = $('pr-whatif');
    if (!iv.length) { host.innerHTML = ''; host.appendChild(NX.empty('No interventions suggested')); return; }
    host.innerHTML = '<p class="nx-dim" style="margin:0 0 10px;font-size:13px">Choose actions to see the projected effect over 90 days.</p>' + iv.map(function (i) {
      return '<label class="fl-iv"><input type="checkbox" data-k="' + esc(i.key) + '"' + (S.pred.picked[i.key] ? ' checked' : '') + '><span><b>' + esc(i.label) + '</b><span class="sub nx-dim">−' + fmt.number(i.expectedRiskReductionPct, 0) + '% risk · ' + fmt.number(i.expectedAvoidedIncidents90d, 1) + ' incidents avoided · ' + fmt.currency(i.expectedSavingsUsd) + '</span>' + ((i.targets && i.targets.length) ? '<span class="sub nx-faint">' + i.targets.length + ' driver' + (i.targets.length > 1 ? 's' : '') + ' targeted</span>' : '') + '</span></label>';
    }).join('') + '<div id="pr-wi-out" class="fl-wi-out"></div>';
    host.querySelectorAll('input[data-k]').forEach(function (c) { c.onchange = function () { S.pred.picked[c.dataset.k] = c.checked; runWhatIf(); }; });
    runWhatIf();
  }
  function runWhatIf() {
    var keys = Object.keys(S.pred.picked).filter(function (k) { return S.pred.picked[k]; }), out = $('pr-wi-out'); if (!out) return;
    if (!keys.length) { out.innerHTML = '<span class="nx-faint">Nothing selected</span>'; return; }
    var seq = S.pred.seq = (S.pred.seq || 0) + 1;
    function show(r) {
      if (seq !== S.pred.seq) return;
      var red = r.riskReductionPct != null ? r.riskReductionPct : r.reductionPct, av = r.avoidedIncidents90d != null ? r.avoidedIncidents90d : r.avoidedIncidents, sv = r.savingsUsd != null ? r.savingsUsd : r.expectedSavingsUsd, p = r.projectedRisk != null ? r.projectedRisk : (r.risk && r.risk.projected90d);
      out.innerHTML = '<div class="fl-wi"><div><span>Risk reduction</span><b>' + (red != null ? '−' + fmt.number(red, 0) + '%' : '—') + '</b></div><div><span>Incidents avoided</span><b>' + (av != null ? fmt.number(av, 1) : '—') + '</b></div><div><span>Est. savings</span><b>' + (sv != null ? fmt.currency(sv) : '—') + '</b></div>' + (p != null ? '<div><span>Projected risk</span><b>' + fmt.number(p, 0) + '</b></div>' : '') + '</div>' + (r.local ? '<div class="fl-note">Estimated from the individual interventions.</div>' : '');
    }
    NX.api('/api/predict/simulate-what-if', { method: 'POST', body: { fleetId: S.fleet.id, interventions: keys } }).then(function (r) { show(r && r.result ? r.result : r || {}); }).catch(function () { show(whatIfLocal(keys)); });
  }
  function renderAlerts() {
    var host = $('pr-alerts'), al = S.pred.alerts.slice().sort(function (a, b) { return new Date(b.createdAt) - new Date(a.createdAt); });
    var open = al.filter(function (a) { return a.status === 'open'; }).length; $('pr-alert-n').textContent = open + ' open';
    if (!al.length) { host.innerHTML = ''; host.appendChild(NX.empty('No alerts', 'Nexus will flag emerging risk before it becomes an incident.')); return; }
    host.innerHTML = al.map(function (a) {
      var act = a.status === 'open' ? '<button class="nx-btn nx-btn--sm" data-a="ack" data-id="' + esc(a.id) + '">Acknowledge</button> <button class="nx-btn nx-btn--sm nx-btn--primary" data-a="action" data-id="' + esc(a.id) + '">Take action</button> <button class="nx-btn nx-btn--sm nx-btn--ghost" data-a="dismiss" data-id="' + esc(a.id) + '">Dismiss</button>' : a.status === 'acknowledged' ? '<button class="nx-btn nx-btn--sm nx-btn--primary" data-a="action" data-id="' + esc(a.id) + '">Take action</button>' : '';
      return '<div class="fl-alert' + (S.flashAlert === a.id ? ' nx-new' : '') + '"><div class="nx-row" style="gap:6px;flex-wrap:wrap">' + NX.badgeHTML(a.severity || 'medium') + '<span class="nx-mono nx-faint" style="font-size:11px">' + esc(KIND[a.kind] || fmt.label(a.kind)) + '</span><span class="nx-grow"></span>' + (a.status !== 'open' ? NX.badgeHTML(a.status, a.status === 'actioned' ? 'ok' : 'plain') : '') + '</div><b>' + esc(a.headline) + '</b>' +
        ((a.rationale && a.rationale.length) ? '<ul class="fl-rat">' + a.rationale.slice(0, 3).map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' : '') +
        '<div class="nx-dim" style="font-size:12.5px">' + (a.probability != null ? '<span class="nx-mono">' + Math.round(a.probability <= 1 ? a.probability * 100 : a.probability) + '%</span> likelihood' + (a.horizonHours ? ' in ' + a.horizonHours + ' h' : '') + ' · ' : '') + (a.recommendedAction ? 'Do: ' + esc(a.recommendedAction) : '') + '</div>' + (a.expectedImpact ? '<div class="nx-faint" style="font-size:12px">Impact: ' + esc(a.expectedImpact) + '</div>' : '') + (act ? '<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">' + act + '</div>' : '') + '</div>';
    }).join('');
    host.querySelectorAll('[data-a]').forEach(function (b) { b.onclick = function () { b.disabled = true; NX.api('/api/predict/alerts/' + encodeURIComponent(b.dataset.id) + '/' + b.dataset.a, { method: 'POST', body: { actor: 'fleet', note: 'From fleet portal' } }).then(function (u) { var a = S.pred.alerts.filter(function (x) { return x.id === b.dataset.id; })[0]; var map = { ack: 'acknowledged', action: 'actioned', dismiss: 'dismissed' }; if (a) { var nu = u && u.alert ? u.alert : u; if (nu && nu.status) Object.assign(a, nu); else a.status = map[b.dataset.a]; } renderAlerts(); renderAttention(); NX.toast('Alert ' + map[b.dataset.a], 'success'); }).catch(function (e) { b.disabled = false; NX.toast(e.message, 'error'); }); }; });
  }
  function onAlert(a) {
    if (!a || !a.id || (a.fleetId && a.fleetId !== S.fleet.id) || !S.pred) return;
    var i = S.pred.alerts.findIndex(function (x) { return x.id === a.id; });
    if (i < 0) { S.pred.alerts.unshift(a); S.flashAlert = a.id; NX.toast('Early warning: ' + (a.headline || KIND[a.kind] || 'new alert'), a.severity === 'critical' ? 'critical' : 'warn'); } else S.pred.alerts[i] = a;
    if ($('pr-alerts')) renderAlerts();
    var n = S.pred.alerts.filter(function (x) { return x.status === 'open'; }).length; $('cnt-pred').textContent = n;
  }
  function renderPredDrivers() {
    var host = $('pr-drivers'), ds = S.pred.drivers; $('cnt-pred').textContent = S.pred.alerts.filter(function (x) { return x.status === 'open'; }).length;
    if (!ds.length) { host.innerHTML = ''; host.appendChild(NX.empty('No at-risk drivers')); return; }
    host.innerHTML = '<div class="nx-table-wrap"><table class="nx-table"><thead><tr><th>Driver</th><th class="num">Risk now</th><th class="num">Projected 30d</th><th class="num">Collision prob.</th><th>Signals</th><th>Recommended intervention</th></tr></thead><tbody>' + ds.map(function (d) {
      var cp = d.collisionProb30d; return '<tr><td><b style="font-weight:500">' + esc(d.name) + '</b><span class="sub">' + (d.daysSinceLastCoaching != null ? d.daysSinceLastCoaching + ' d since coaching' : 'No coaching on record') + '</span></td><td class="num"><span class="fl-score ' + scoreCls(100 - num(d.riskNow, 0)) + '">' + fmt.number(d.riskNow) + '</span></td><td class="num">' + fmt.number(d.riskProjected30d) + ' ' + trendArrow(d.trend, null) + '</td><td class="num">' + (cp == null ? '—' : Math.round(cp <= 1 ? cp * 100 : cp) + '%') + '</td><td class="wrap">' + ((d.signals || []).slice(0, 3).map(function (g) { return '<span class="fl-flag nx-badge nx-badge--plain">' + esc(g.label || g.key) + (g.trendPct != null ? ' ' + (g.trendPct > 0 ? '+' : '') + Math.round(g.trendPct) + '%' : '') + '</span>'; }).join('') || '<span class="nx-faint">—</span>') + '</td><td class="wrap dim">' + esc(d.recommendedIntervention || '—') + '</td></tr>';
    }).join('') + '</tbody></table></div>';
  }
  function renderPattern() {
    var pt = S.pred.fleet.patterns || {}, host = $('pr-pattern');
    function strip(arr, labels, title) { if (!arr || !arr.length) return ''; var mx = Math.max.apply(null, arr) || 1; return '<div class="nx-eyebrow" style="margin:10px 0 6px">' + title + '</div><div class="fl-heat" style="grid-template-columns:repeat(' + arr.length + ',1fr)">' + arr.map(function (v, i) { return '<div title="' + esc(labels[i]) + ': ' + fmt.number(v, 1) + '" style="--a:' + (0.08 + 0.92 * v / mx).toFixed(2) + '"><span>' + (arr.length > 12 ? (i % 3 === 0 ? i : '') : labels[i]) + '</span></div>'; }).join('') + '</div>'; }
    var hrs = (pt.byHour || []).map(function (_, i) { return i + ':00'; });
    host.innerHTML = strip(pt.byHour, hrs, 'By hour of day') + strip(pt.byDow, DOW, 'By day of week') + (pt.byHour || pt.byDow ? '<p class="fl-note">Darker means more expected incidents. Use it to schedule coaching and dispatch coverage.</p>' : '');
    if (!pt.byHour && !pt.byDow) host.appendChild(NX.empty('No pattern data'));
  }
  function initPredMap() {
    var hs = (S.pred.fleet.hotspots || []).filter(function (h) { return h.lat != null; });
    if (S.pmap) { S.pmap.remove(); S.pmap = null; }
    if (typeof L === 'undefined') return;
    S.pmap = L.map('pr-map', { scrollWheelZoom: false }).setView([32, -86], 6);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 18, attribution: '&copy; OpenStreetMap contributors' }).addTo(S.pmap);
    if (!hs.length) { return; }
    var pts = [];
    hs.forEach(function (h) { var rs = num(h.riskScore, 50), col = NX.sevColor(rs >= 75 ? 'critical' : rs >= 55 ? 'high' : rs >= 35 ? 'medium' : 'low', true); L.circleMarker([h.lat, h.lng], { radius: 8 + Math.min(14, num(h.incidents, 1) * 1.5), color: col, fillColor: col, fillOpacity: 0.35, weight: 2 }).addTo(S.pmap).bindPopup('<b>' + esc(h.label) + '</b><br>Risk ' + Math.round(rs) + ' · ' + num(h.incidents, 0) + ' incidents' + (h.topEventType ? '<br>Mostly ' + esc(fmt.label(h.topEventType).toLowerCase()) : '')); pts.push([h.lat, h.lng]); });
    S.pmap.fitBounds(pts, { padding: [30, 30], maxZoom: 10 });
    setTimeout(function () { if (S.pmap) S.pmap.invalidateSize(); }, 80);
  }
  function renderBacktest() {
    var b = S.pred.bt, host = $('pr-bt');
    if (!b || b.recallPct == null && b.collisions == null) { host.innerHTML = ''; host.appendChild(NX.empty('Backtest unavailable')); return; }
    var missed = b.collisions != null && b.caught != null ? b.collisions - b.caught : null;
    host.innerHTML = '<div class="fl-wi"><div><span>Collisions in window</span><b>' + fmt.number(b.collisions) + '</b></div><div><span>Flagged in advance</span><b>' + fmt.number(b.caught) + ' (' + fmt.number(b.recallPct, 0) + '%)</b></div><div><span>Missed</span><b>' + (missed == null ? '—' : missed) + '</b></div><div><span>Median lead time</span><b>' + (b.medianLeadDays != null ? fmt.number(b.medianLeadDays, 0) + ' days' : '—') + '</b></div><div><span>False alerts / 100 veh</span><b>' + (b.falseAlertsPer100Veh != null ? fmt.number(b.falseAlertsPer100Veh, 1) : '—') + '</b></div></div>' +
      ((b.examples && b.examples.length) ? '<div class="fl-ex">' + b.examples.slice(0, 4).map(function (e) { return '<div class="fl-ex__i"><div><b>' + esc(e.driverName || 'Driver') + '</b> <span class="nx-dim">warned ' + (e.leadDays != null ? fmt.number(e.leadDays, 0) + ' days' : '') + ' before the collision</span></div><div class="nx-faint" style="font-size:12px">' + esc(fmt.date(e.warningAt)) + ' → ' + esc(fmt.date(e.incidentAt)) + ' · ' + esc((e.signals || []).join(', ')) + '</div></div>'; }).join('') + '</div>' : '') +
      '<div class="fl-limits"><b>Limits.</b> ' + (missed ? missed + ' collision' + (missed > 1 ? 's' : '') + ' had no visible precursor and were not flagged. ' : '') + (b.limitations && b.limitations.length ? esc(Array.isArray(b.limitations) ? b.limitations.join(' ') : b.limitations) : 'Backtest is on seeded, demo-calibrated history, not a guarantee of future results.') + '</div>';
  }


  /* ---------------- what needs my attention ---------------- */
  function renderAttention() {
    var host = $('attn'); if (!host || !S.summary) return;
    var items = [];
    S.incidents.filter(function (i) { return i.severity === 'critical' && isOpen(i); }).slice(0, 3).forEach(function (i) {
      items.push({ pri: 'critical', title: typeLabel(i.eventType) + ' on ' + vehLabel(i), text: (i.driver && i.driver.name ? i.driver.name + ' · ' : '') + ((i.location && (i.location.road || i.location.address)) || '') + ' · ' + fmt.ago(i.timestamp) + ' · ' + fmt.label(i.status), btn: 'View incident', fn: function () { openIncident(i.id); } });
    });
    var cs = claims(), info = cs.filter(function (i) { return cStatus(i) === 'more_info_needed'; }), rdy = cs.filter(function (i) { return cStatus(i) === 'ready'; });
    info.slice(0, 2).forEach(function (i) { items.push({ pri: 'high', title: 'OEM needs more information', text: (i.warranty.claimId || i.id) + ' · ' + vehLabel(i) + ' · ' + fmt.currency(cVal(i)), btn: 'Review claim', fn: function () { openIncident(i.id); } }); });
    if (rdy.length) items.push({ pri: 'medium', title: rdy.length + ' warranty claim' + (rdy.length > 1 ? 's' : '') + ' ready to file', text: fmt.currency(rdy.reduce(function (a, i) { return a + cVal(i); }, 0)) + ' recoverable. Packets are complete.', btn: 'Submit all ready (' + rdy.length + ')', primary: true, fn: function (b) { submitAllReady(b); } });
    var al = ((S.pred && S.pred.alerts) || []).filter(function (a) { return a.status === 'open'; });
    al.slice(0, 2).forEach(function (a) { items.push({ pri: a.severity === 'critical' ? 'critical' : 'medium', title: 'Early warning: ' + (a.headline || KIND[a.kind]), text: (a.recommendedAction ? 'Suggested: ' + a.recommendedAction : '') , btn: 'Acknowledge', fn: function (b) { b.disabled = true; NX.api('/api/predict/alerts/' + encodeURIComponent(a.id) + '/ack', { method: 'POST', body: { actor: 'fleet' } }).then(function () { a.status = 'acknowledged'; renderAttention(); NX.toast('Alert acknowledged', 'success'); }).catch(function (e) { b.disabled = false; NX.toast(e.message, 'error'); }); } }); });
    if (al.length > 2) items.push({ pri: 'low', title: (al.length - 2) + ' more early warnings', text: '', btn: 'Review all', fn: function () { show('predict'); } });
    var fl = drivers().filter(function (d) { return d.flags.length; });
    if (fl.length) items.push({ pri: 'low', title: fl.length + ' driver' + (fl.length > 1 ? 's' : '') + ' flagged for coaching', text: fl.slice(0, 3).map(function (d) { return d.name; }).join(', ') + (fl.length > 3 ? ' and ' + (fl.length - 3) + ' more' : ''), btn: 'See drivers', fn: function () { show('drivers'); } });
    var n = items.length;
    if (!n) { host.innerHTML = '<div class="fl-clear"><span class="fl-clear__dot"></span><div><b>All clear</b><div class="nx-dim" style="font-size:13px">Nothing needs your attention. Nexus is watching ' + fmt.number(S.fleet.vehicles) + ' vehicles and will notify you if that changes.</div></div></div>'; return; }
    host.innerHTML = '<div class="nx-card fl-attn"><div class="nx-card__head"><h3 class="nx-card__title">What needs my attention</h3><span class="nx-dim nx-mono">' + n + ' item' + (n > 1 ? 's' : '') + '</span></div><div id="attn-list"></div></div>';
    var list = $('attn-list');
    items.forEach(function (it) {
      var row = NX.el('div.fl-attn__row.pri-' + it.pri, NX.el('div.nx-grow', NX.el('b', it.title), it.text ? NX.el('div.nx-dim', { style: 'font-size:13px' }, it.text) : null), NX.el('button', { class: 'nx-btn nx-btn--sm' + (it.primary || it.pri === 'critical' ? ' nx-btn--primary' : ''), onclick: function (e) { it.fn(e.currentTarget); } }, it.btn));
      list.appendChild(row);
    });
    var cn = $('cnt-pred'); if (cn && S.pred && S.pred.alerts) cn.textContent = al.length;
  }

  /* ---------------- what Nexus did for you ---------------- */
  var VERB = { sms: 'Texted', email: 'Emailed', call: 'Called', push: 'Sent a notification to' };
  function loadFeed() {
    var host = $('feed'); if (!host) return;
    var fid = S.fleet.id, recent = S.incidents.slice(0, 10);
    Promise.all(recent.map(function (i) {
      if (S.comms[i.id]) return Promise.resolve(S.comms[i.id]);
      return NX.api('/api/incidents/' + encodeURIComponent(i.id) + '/comms').then(function (r) { return (S.comms[i.id] = Array.isArray(r) ? r : (r && (r.comms || r.messages)) || []); }).catch(function () { return (S.comms[i.id] = []); });
    })).then(function () { if (S.fleet.id === fid) renderFeed(recent); });
  }
  var TL_RE = /dispatch|notif|warranty|claim|fnol|submitted|eta_shared|authority|called|roadside_assigned|tow/i;
  function renderFeed(recent) {
    var host = $('feed'); if (!host) return;
    var rows = [];
    recent.forEach(function (i) {
      var cm = S.comms[i.id] || [], veh = vehLabel(i);
      cm.forEach(function (c) { var to = c.to && (c.to.name || c.to.type) || 'contact'; rows.push({ t: c.at || c.t, icon: { sms: 'SMS', email: 'MAIL', call: 'CALL', push: 'PUSH' }[c.channel] || 'MSG', title: (VERB[c.channel] || 'Contacted') + ' ' + to, text: (c.subject || c.body || '') + ' · ' + veh, id: i.id, sim: true }); });
      (i.timeline || []).forEach(function (e) {
        if ((e.actor === 'fleet' && !/warranty|claim|submitted/i.test(e.action || '')) || !TL_RE.test(e.action || '')) return;
        if (cm.length && /notif|sms|call|email/i.test(e.action || '')) return;
        var a = String(e.action || '');
        rows.push({ t: e.t, icon: /warranty|claim|submitted/i.test(a) ? 'CLAIM' : /dispatch|tow|roadside/i.test(a) ? 'TOW' : 'NX', title: fmt.label(a), text: (e.note || '') + ' · ' + veh, id: i.id, sim: /warranty|claim|submitted|fnol|notif|call/i.test(a) });
      });
    });
    rows.sort(function (a, b) { return new Date(b.t) - new Date(a.t); });
    rows = rows.slice(0, S.feedAll ? 40 : 5);
    if (!rows.length) { host.innerHTML = ''; host.appendChild(NX.empty('Nothing yet', 'Texts, calls, dispatches and claims Nexus handles for you will show here.')); return; }
    host.innerHTML = rows.map(function (r) { return '<div class="fl-feed__row fl-row-click" data-id="' + esc(r.id) + '"><span class="fl-feed__ic">' + r.icon + '</span><div class="nx-grow"><b>' + esc(r.title) + '</b>' + (r.sim ? ' <span class="fl-tag">simulated</span>' : '') + '<div class="nx-dim" style="font-size:12.5px">' + esc(r.text) + '</div></div><span class="nx-faint nx-mono" style="font-size:11px;white-space:nowrap">' + fmt.ago(r.t) + '</span></div>'; }).join('') + (S.feedAll ? '' : '<button class="nx-btn nx-btn--ghost nx-btn--sm nx-btn--block" id="feed-more">Show more</button>');
    bindRows(host); host.querySelectorAll('.fl-feed__row').forEach(function (n) { n.onclick = function () { openIncident(n.dataset.id); }; });
    var m = $('feed-more'); if (m) m.onclick = function () { S.feedAll = true; renderFeed(recent); };
  }

  /* ---------------- warranty ---------------- */
  function claims() { return S.incidents.filter(function (i) { return i.warranty && i.warranty.claimEligible; }); }
  var CLAIM_LABEL = { draft: 'Draft prepared', ready: 'Ready to file', submitted: 'Submitted', under_review: 'Under review', approved: 'Approved', denied: 'Denied', more_info_needed: 'More info needed', paid: 'Paid' };
  function claimLabel(s) { return CLAIM_LABEL[s] || fmt.label(s || 'eligible'); }
  function cStatus(i) { var w = i.warranty || {}; return (w.claimPacket && w.claimPacket.status) || w.claimStatus || 'draft'; }
  function cConfirm(i) { var w = i.warranty || {}, cp = w.claimPacket || {}; return cp.confirmation || cp.confirmationNumber || w.confirmation || (w.submission && w.submission.confirmation) || (cp.submission && cp.submission.confirmation) || null; }
  function cVal(i) { return num(i.warranty && i.warranty.claimPacket && i.warranty.claimPacket.estimatedValueUsd, 0); }
  function claimStepper(i) {
    var st = cStatus(i), idx = { draft: -1, ready: 0, submitted: 1, under_review: 2, more_info_needed: 2, approved: 3, paid: 3, denied: 3 }[st];
    if (idx == null) idx = 0;
    var last = ['approved', 'paid', 'denied'].indexOf(st) > -1 ? claimLabel(st) : 'Decision', warn = st === 'more_info_needed', bad = st === 'denied';
    return '<div class="fl-steps fl-steps--sm">' + [['Ready', 0], ['Submitted', 1], [warn ? 'Info needed' : 'In review', 2], [last, 3]].map(function (x) { var d = idx >= x[1] && !(x[1] === 2 && warn); return '<div class="fl-step' + (d ? ' done' : '') + (warn && x[1] === 2 ? ' now' : '') + (bad && x[1] === 3 ? ' bad' : '') + '">' + x[0] + '</div>'; }).join('') + '</div>';
  }
  function submitClaim(id, btn) {
    if (btn) { btn.disabled = true; btn.classList.add('is-loading'); }
    return NX.api('/api/incidents/' + encodeURIComponent(id) + '/warranty/submit', { method: 'POST', body: { actor: 'fleet' } }).then(function (res) {
      var inc = S.incidents.filter(function (x) { return x.id === id; })[0];
      if (inc && inc.warranty) { var cp = inc.warranty.claimPacket = inc.warranty.claimPacket || {}; cp.status = (res && res.status) || 'submitted'; if (res && res.confirmation) cp.confirmation = res.confirmation; if (res && res.submittedTo) cp.submittedTo = res.submittedTo; if (res && res.submittedAt) cp.submittedAt = res.submittedAt; }
      NX.toast('Claim submitted' + (res && res.confirmation ? ' · ' + res.confirmation : '') + ' (simulated in demo)', 'success');
      refreshClaims();
      NX.api('/api/incidents/' + encodeURIComponent(id)).then(function (full) { var k = S.incidents.findIndex(function (x) { return x.id === id; }); if (k >= 0) S.incidents[k] = full; if (S.openId === id) renderDrawer(full); refreshClaims(); }).catch(function () { /* keep local */ });
    }).catch(function (e) { if (btn) { btn.disabled = false; btn.classList.remove('is-loading'); } NX.toast(e.message, 'error'); });
  }
  function submitAllReady(btn) {
    btn.disabled = true; btn.classList.add('is-loading');
    return NX.api('/api/fleets/' + encodeURIComponent(S.fleet.id) + '/warranty/submit-ready', { method: 'POST', body: { actor: 'fleet' } }).then(function (res) {
      var n = res && (res.submitted != null ? (Array.isArray(res.submitted) ? res.submitted.length : res.submitted) : res.count);
      NX.toast((n != null ? n + ' claim' + (n === 1 ? '' : 's') : 'Claims') + ' submitted (simulated in demo)', 'success');
      return NX.api('/api/incidents', { query: { fleetId: S.fleet.id, limit: 500 } }).then(function (r) { S.incidents = (r && r.incidents) || r || []; sortIncidents(); refreshClaims(); renderIncidentsTables(); });
    }).catch(function (e) { btn.disabled = false; btn.classList.remove('is-loading'); NX.toast(e.message, 'error'); });
  }
  function refreshClaims() { renderWarranty(); renderAttention(); renderCounts(); S.comms = {}; loadFeed(); }
  function renderWarranty() {
    var host = $('war-body'); if (!host) return;
    var cs = claims();
    var recovered = num(S.summary && S.summary.kpis && S.summary.kpis.warrantyRecoveredUsd, 0);
    var kp = (S.summary && S.summary.kpis) || {};
    var closed = ['paid', 'approved', 'denied'];
    var pend = cs.filter(function (i) { return closed.indexOf(cStatus(i)) < 0; });
    var pendVal = pend.reduce(function (a, i) { return a + cVal(i); }, 0);
    var ready = cs.filter(function (i) { return cStatus(i) === 'ready'; }), info = cs.filter(function (i) { return cStatus(i) === 'more_info_needed'; });
    var readyVal = ready.reduce(function (a, i) { return a + cVal(i); }, 0);
    var html = '<div class="fl-sim">Claim submission is <b>simulated in the demo</b>: Nexus returns a confirmation number and logs it, but nothing is sent to an OEM.</div>' +
      '<div class="nx-kpis"><div class="nx-kpi nx-kpi--ok"><div class="nx-kpi__label">Recovered</div><div class="nx-kpi__value">' + fmt.currency(recovered) + '</div><div class="nx-kpi__delta">paid by OEMs</div></div>' +
      '<div class="nx-kpi nx-kpi--accent"><div class="nx-kpi__label">Pending value</div><div class="nx-kpi__value">' + fmt.currency(pendVal) + '</div><div class="nx-kpi__delta">' + pend.length + ' open claims</div></div>' +
      '<div class="nx-kpi"><div class="nx-kpi__label">Ready to file</div><div class="nx-kpi__value">' + ready.length + '</div><div class="nx-kpi__delta">' + fmt.currency(readyVal) + ' evidence complete</div></div>' +
      '<div class="nx-kpi ' + (info.length ? 'nx-kpi--critical' : '') + '"><div class="nx-kpi__label">Need your input</div><div class="nx-kpi__value">' + info.length + '</div><div class="nx-kpi__delta">OEM asked for more info</div></div></div>';
    if (ready.length) html += '<div class="fl-bulk"><div><b>' + ready.length + ' claim' + (ready.length > 1 ? 's' : '') + ' ready to file</b><div class="nx-dim" style="font-size:13px">Worth ' + fmt.currency(readyVal) + '. Packets are already assembled with evidence, codes and coverage.</div></div><button class="nx-btn nx-btn--primary" id="submit-all">Submit all ready (' + ready.length + ')</button></div>';
    if (!cs.length) { host.innerHTML = html; host.appendChild(NX.empty('No eligible claims', 'Warranty-eligible failures will appear with a ready claim packet.')); return; }
    var order = { more_info_needed: 0, ready: 1, draft: 2, submitted: 3, under_review: 3, approved: 4, paid: 4, denied: 4 };
    cs = cs.slice().sort(function (a, b) { return (order[cStatus(a)] == null ? 5 : order[cStatus(a)]) - (order[cStatus(b)] == null ? 5 : order[cStatus(b)]); });
    html += '<div class="nx-card nx-card--flush"><div class="nx-table-wrap"><table class="nx-table"><thead><tr><th>Claim</th><th>Vehicle</th><th>Failure</th><th>Progress</th><th class="num">Est. value</th><th>Action</th></tr></thead><tbody>' +
      cs.map(function (i) {
        var w = i.warranty, st = cStatus(i), conf = cConfirm(i), codes = i.diagnostics && i.diagnostics.dtcs ? i.diagnostics.dtcs.map(function (t) { return t.code; }).join(', ') : '';
        var act = st === 'ready' ? '<button class="nx-btn nx-btn--sm nx-btn--primary" data-submit="' + esc(i.id) + '">Submit claim</button>' : '';
        return '<tr class="fl-row-click" data-id="' + esc(i.id) + '"><td class="id">' + esc(w.claimId || i.id) + '<span class="sub">' + fmt.ago(i.timestamp) + '</span></td><td>' + esc(vehLabel(i)) + '<span class="sub">' + esc(vehSub(i)) + '</span></td><td class="wrap">' + esc(typeLabel(i.eventType)) + '<span class="sub">' + esc(codes) + '</span><span class="sub">' + esc(w.oem || (i.vehicle && i.vehicle.oem) || '') + ' · ' + esc(fmt.label(w.coverage)) + '</span></td><td style="min-width:230px">' + claimStepper(i) + '<span class="sub">' + esc(claimLabel(st)) + (conf ? ' · <span class="nx-mono">' + esc(conf) + '</span>' : '') + '</span></td><td class="num">' + fmt.currency(cVal(i)) + '</td><td>' + act + ' <a class="nx-btn nx-btn--sm" target="_blank" rel="noopener" href="/api/incidents/' + encodeURIComponent(i.id) + '/warranty-packet?format=html" onclick="event.stopPropagation()">Packet</a></td></tr>';
      }).join('') + '</tbody></table></div></div>';
    host.innerHTML = html; bindRows(host);
    host.querySelectorAll('[data-submit]').forEach(function (b) { b.onclick = function (e) { e.stopPropagation(); submitClaim(b.dataset.submit, b); }; });
    var sa = $('submit-all'); if (sa) sa.onclick = function () { submitAllReady(sa); };
  }

  /* ---------------- drivers ---------------- */
  var SAFETY = ['harsh_brake', 'harsh_accel', 'harsh_turn', 'speeding', 'distracted', 'following_distance', 'collision', 'rollover'];
  function drivers() {
    var map = {};
    S.incidents.forEach(function (i) {
      var d = i.driver; if (!d || !(d.name || d.id)) return;
      var k = d.id || d.name, r = map[k] = map[k] || { id: d.id, name: d.name || d.id, score: null, events: 0, clips: 0, verified: 0, types: {}, last: 0 };
      var ts = new Date(i.timestamp).getTime();
      if (d.safetyScore != null && ts >= r.last) { r.score = d.safetyScore; r.last = ts; }
      if (SAFETY.indexOf(i.eventType) > -1 || i.category === 'safety' || i.category === 'collision') {
        r.events++; r.types[i.eventType] = (r.types[i.eventType] || 0) + 1;
        if (i.camera && i.camera.verified) { r.verified++; r.clips += (i.camera.clips || []).length || 1; }
      }
    });
    ((S.summary && S.summary.topDrivers) || []).forEach(function (t) {
      var k = t.id || t.name, r = map[k] || Object.keys(map).map(function (x) { return map[x]; }).filter(function (x) { return x.name === t.name; })[0];
      var sc = t.safetyScore != null ? t.safetyScore : t.score;
      if (!r) { r = map[k] = { id: t.id, name: t.name || k, score: sc, events: num(t.events30d != null ? t.events30d : t.events != null ? t.events : t.eventCount, 0), clips: 0, verified: 0, types: {}, last: 0 }; }
      else if (sc != null) r.score = sc;
    });
    var out = Object.keys(map).map(function (k) { return map[k]; });
    out.forEach(function (r) {
      r.flags = [];
      if (r.score != null && r.score < 75) r.flags.push(['Coaching recommended', 'warn']);
      if ((r.types.speeding || 0) >= 2) r.flags.push(['Speeding pattern', 'warn']);
      if ((r.types.distracted || 0) >= 1) r.flags.push(['Distraction', 'danger']);
      if ((r.types.following_distance || 0) >= 2) r.flags.push(['Tailgating', 'warn']);
      if ((r.types.harsh_brake || 0) + (r.types.harsh_accel || 0) + (r.types.harsh_turn || 0) >= 3) r.flags.push(['Harsh driving', 'warn']);
      if (r.types.collision) r.flags.push(['Collision on record', 'danger']);
    });
    out.sort(function (a, b) { return (a.score == null ? 101 : a.score) - (b.score == null ? 101 : b.score) || b.events - a.events; });
    return out;
  }
  function renderDrivers() {
    var host = $('drv-body'); if (!host) return;
    var ds = drivers();
    if (!ds.length) { host.innerHTML = ''; host.appendChild(NX.empty('No driver data yet')); return; }
    var clips = ds.reduce(function (a, d) { return a + d.clips; }, 0), flagged = ds.filter(function (d) { return d.flags.length; }).length;
    host.innerHTML = '<div class="nx-kpis"><div class="nx-kpi"><div class="nx-kpi__label">Drivers with events</div><div class="nx-kpi__value">' + ds.length + '</div></div><div class="nx-kpi nx-kpi--accent"><div class="nx-kpi__label">Coaching flags</div><div class="nx-kpi__value">' + flagged + '</div><div class="nx-kpi__delta">drivers to review</div></div><div class="nx-kpi"><div class="nx-kpi__label">Camera-verified clips</div><div class="nx-kpi__value">' + clips + '</div><div class="nx-kpi__delta">objective evidence</div></div></div>' +
      '<div class="nx-card nx-card--flush"><div class="nx-table-wrap"><table class="nx-table"><thead><tr><th>#</th><th>Driver</th><th class="num">Safety score</th><th class="num">Safety events</th><th class="num">Verified clips</th><th>Coaching flags</th></tr></thead><tbody>' +
      ds.map(function (d, i) { return '<tr><td class="dim nx-mono">' + (i + 1) + '</td><td><b style="font-weight:500">' + esc(d.name) + '</b></td><td class="num"><span class="fl-score ' + scoreCls(d.score) + '">' + (d.score == null ? '—' : fmt.number(d.score)) + '</span></td><td class="num">' + d.events + '</td><td class="num">' + d.clips + '</td><td class="wrap">' + (d.flags.length ? d.flags.map(function (f) { return '<span class="fl-flag">' + NX.badgeHTML(f[0], f[1]) + '</span>'; }).join('') : '<span class="nx-faint">None</span>') + '</td></tr>'; }).join('') +
      '</tbody></table></div></div><p class="fl-note">Ranked by safety score, lowest first so coaching candidates surface at the top. Flags are derived from camera-verified event patterns over the fleet history.</p>';
  }

  /* ---------------- vehicles ---------------- */
  function renderVehicles() {
    var host = $('veh-body'); if (!host) return;
    var vs = ((S.summary && S.summary.vehicles) || []).slice();
    if (!vs.length) { host.innerHTML = ''; host.appendChild(NX.empty('No vehicles reported')); return; }
    var byV = {};
    S.incidents.forEach(function (i) { var v = i.vehicle || {}; [v.id, v.plate].forEach(function (k) { if (k) (byV[k] = byV[k] || []).push(i); }); });
    var rows = vs.map(function (v) {
      var inc = (byV[v.id] || byV[v.plate] || []).slice(), open = inc.filter(isOpen);
      var info = Object.assign({}, (inc[0] && inc[0].vehicle) || {}, v);
      var dtcs = []; open.forEach(function (i) { ((i.diagnostics && i.diagnostics.dtcs) || []).forEach(function (t) { dtcs.push(t); }); });
      var drv = open.map(function (i) { return i.diagnostics && i.diagnostics.drivable; }).filter(Boolean);
      var drivable = drv.indexOf('no') > -1 ? 'no' : drv.indexOf('limp') > -1 ? 'limp' : /down|breakdown/i.test(v.status || '') ? 'no' : 'yes';
      var hint;
      if (dtcs.length && dtcs[0].recommendedAction) hint = dtcs[0].recommendedAction;
      else if (info.odometer_mi) { var next = Math.ceil((info.odometer_mi + 1) / 25000) * 25000; hint = 'PM service in ~' + fmt.number(next - info.odometer_mi) + ' mi'; }
      else hint = 'No service due';
      return { v: v, info: info, n: Math.max(num(v.openDtcs, 0), dtcs.length), dtcs: dtcs, drivable: drivable, hint: hint, firstInc: open[0] || inc[0] };
    });
    var f = S.vehFilter;
    var shown = rows.filter(function (r) { return f === 'dtc' ? r.n > 0 : f === 'nodrive' ? r.drivable !== 'yes' : true; });
    shown.sort(function (a, b) { return b.n - a.n || String(a.v.plate).localeCompare(String(b.v.plate)); });
    var cnt = { all: rows.length, dtc: rows.filter(function (r) { return r.n > 0; }).length, nodrive: rows.filter(function (r) { return r.drivable !== 'yes'; }).length };
    host.innerHTML = '<div class="fl-filters"><div class="fl-pills nx-chips">' + [['all', 'All'], ['dtc', 'Open trouble codes'], ['nodrive', 'Not fully drivable']].map(function (t) { return '<button class="nx-chip' + (f === t[0] ? ' is-active' : '') + '" data-f="' + t[0] + '">' + t[1] + ' ' + cnt[t[0]] + '</button>'; }).join('') + '</div></div>' +
      '<div class="nx-card nx-card--flush"><div class="nx-table-wrap"><table class="nx-table"><thead><tr><th>Vehicle</th><th>Status</th><th class="num">Open DTCs</th><th>Drivable</th><th>Next service / action</th></tr></thead><tbody>' +
      shown.map(function (r) {
        return '<tr' + (r.firstInc ? ' class="fl-row-click" data-id="' + esc(r.firstInc.id) + '"' : '') + '><td>' + esc(r.v.unit || r.v.plate || r.v.id) + '<span class="sub">' + esc([r.v.year, r.v.make, r.v.model].filter(Boolean).join(' ') || r.v.id) + '</span></td><td>' + NX.badgeHTML(r.v.status || 'unknown', /down|breakdown|incident/i.test(r.v.status || '') ? 'danger' : /idle|stop|park/i.test(r.v.status || '') ? 'on_scene' : r.v.status === 'attention' ? 'warn' : 'ok') + '</td><td class="num">' + (r.n ? '<b style="color:var(--nx-sev-medium)">' + r.n + '</b>' : '<span class="nx-faint">0</span>') + (r.dtcs.length ? '<span class="sub nx-mono">' + esc(r.dtcs.slice(0, 2).map(function (t) { return t.code; }).join(', ')) + '</span>' : '') + '</td><td>' + NX.badgeHTML(r.drivable === 'yes' ? 'Drivable' : r.drivable === 'limp' ? 'Limp mode' : 'Not drivable', r.drivable === 'yes' ? 'ok' : r.drivable === 'limp' ? 'warn' : 'danger') + '</td><td class="wrap dim">' + esc(r.hint) + '</td></tr>';
      }).join('') + '</tbody></table></div></div><p class="fl-note">Service hints combine open trouble-code recommendations with a 25,000 mi preventive-maintenance cadence from the last reported odometer.</p>';
    host.querySelectorAll('[data-f]').forEach(function (b) { b.onclick = function () { S.vehFilter = b.dataset.f; renderVehicles(); }; });
    bindRows(host);
  }

  init();
})();
