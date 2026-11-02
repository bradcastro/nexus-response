/* Nexus Response - Fleet customer portal. Vanilla JS, consumes the contract in docs/ARCHITECTURE.md. */
(function () {
  'use strict';
  var esc = NX.esc, fmt = NX.fmt;
  var VENDORS = { motive: 'Motive', samsara: 'Samsara', geotab: 'Geotab', lytx: 'Lytx', generic: 'Generic' };
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
    S.summary = null; S.incidents = [];
    ['overview', 'incidents', 'warranty', 'drivers', 'vehicles', 'loads'].forEach(function (v) { $('v-' + v).innerHTML = ''; $('v-' + v).appendChild(NX.skeleton(4)); });
    $('error').classList.add('nx-hide');
    load().catch(fatal);
    if (S.sse) S.sse.close();
    S.sse = NX.sse('/api/stream', onStream, { events: ['incident'] });
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
  function onStream(d) {
    var inc = d && d.incident ? d.incident : d;
    if (!inc || !inc.id || inc.fleetId !== S.fleet.id) return;
    var idx = S.incidents.findIndex(function (i) { return i.id === inc.id; });
    var fresh = idx < 0;
    if (fresh) S.incidents.unshift(inc); else S.incidents[idx] = inc;
    sortIncidents();
    S.flash = fresh ? inc.id : null;
    renderCounts(); renderIncidentsTables(); renderLoads();
    if (S.openId === inc.id) renderDrawer(inc);
    if (fresh) NX.toast(typeLabel(inc.eventType) + ' · ' + ((inc.vehicle && inc.vehicle.plate) || 'vehicle') + ' (' + inc.severity + ')', inc.severity === 'critical' ? 'critical' : 'info');
    clearTimeout(S.timer);
    S.timer = setTimeout(function () {
      NX.api('/api/fleets/' + encodeURIComponent(S.fleet.id) + '/summary').then(function (s) { S.summary = s; renderKpis(); renderTrend(); renderTypes(); renderMarkers(); renderVehicles(); renderDrivers(); renderWarranty(); renderLoads(); renderCargo(); }).catch(function () { /* keep stale */ });
    }, 600);
  }

  /* ---------------- shell ---------------- */
  function show(view, fromHash) {
    S.view = view;
    document.querySelectorAll('.nx-nav[data-view]').forEach(function (b) { b.classList.toggle('is-active', b.dataset.view === view); });
    document.querySelectorAll('[data-section]').forEach(function (s) { s.hidden = s.dataset.section !== view; });
    if (!fromHash) { try { history.replaceState(null, '', location.pathname + location.search + '#' + view); } catch (e) { /* */ } }
    if (view === 'overview' && S.map) setTimeout(function () { S.map.invalidateSize(); }, 50);
    $('main').scrollTop = 0;
  }
  function renderSource() {
    var v = vendorName(S.fleet.vendor);
    $('source-badge').innerHTML = '<span class="fl-src" title="Events from this vendor are mapped to the Nexus canonical schema"><i></i>Telematics: <b>' + esc(v) + '</b><span class="tag">normalized by Nexus</span></span>';
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
    renderKpis(); renderTrend(); renderTypes(); renderCargo(); renderSources(); initMap(); renderMarkers();
    $('v-incidents').innerHTML = '<div id="inc-filters"></div><div id="inc-table"></div>';
    $('v-warranty').innerHTML = '<div id="war-body"></div>';
    $('v-drivers').innerHTML = '<div id="drv-body"></div>';
    $('v-vehicles').innerHTML = '<div id="veh-body"></div>';
    $('v-loads').innerHTML = '<div id="load-body"></div>';
    renderIncidentsTables(); renderWarranty(); renderDrivers(); renderVehicles(); renderLoads();
    if (S.view === 'overview' && S.map) setTimeout(function () { S.map.invalidateSize(); }, 50);
    var m = location.hash.match(/^#incident=(.+)$/); if (m) openIncident(decodeURIComponent(m[1]));
  }

  /* ---------------- overview ---------------- */
  function overviewHTML() {
    return '<div class="nx-kpis" id="kpis"></div>' +
      '<div class="fl-grid"><div class="nx-card"><div class="nx-card__head"><h3 class="nx-card__title">Events, last 30 days</h3><span class="nx-dim nx-mono" id="trend-sum"></span></div><div class="nx-card__body fl-chart" id="trend"></div></div>' +
      '<div class="nx-card"><div class="nx-card__head"><h3 class="nx-card__title">Events by type</h3></div><div class="nx-card__body" id="types"></div></div></div>' +
      '<div class="nx-card" style="margin-bottom:16px"><div class="nx-card__head"><h3 class="nx-card__title">Live fleet map</h3><span class="nx-dim nx-mono" id="map-sum"></span></div><div class="fl-map" id="map"></div>' +
      '<div class="fl-legend"><span><i style="--c:var(--nx-ok)"></i>Rolling / healthy</span><span><i style="--c:var(--nx-text-faint)"></i>Idle / stopped</span><span><i style="--c:var(--nx-sev-medium)"></i>Open trouble codes</span><span><i style="--c:var(--nx-danger)"></i>Down / incident</span><span class="nx-faint">Badge number = open trouble codes</span></div></div>' +
      '<div class="nx-card" style="margin-bottom:16px"><div class="nx-card__head"><h3 class="nx-card__title">Cargo exposure by content</h3><span class="nx-dim nx-mono">estimated</span></div><div class="nx-card__body" id="cargo"></div></div>' +
      '<div class="fl-grid fl-grid--even"><div class="nx-card"><div class="nx-card__head"><h3 class="nx-card__title">Recent incidents</h3><button class="nx-btn nx-btn--sm nx-btn--ghost" data-go="incidents">View all</button></div><div class="nx-card__body nx-card--flush" id="recent"></div></div>' +
      '<div class="nx-card"><div class="nx-card__head"><h3 class="nx-card__title">Data sources</h3></div><div class="nx-card__body" id="sources"></div></div></div>';
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
      m.bindPopup('<b>' + esc(v.unit || v.plate || v.id) + '</b> · ' + esc([v.make, v.model].filter(Boolean).join(' ')) + '<br>' + (v.speed_mph != null ? Math.round(v.speed_mph) + ' mph · ' : '') + + esc(fmt.label(v.status || 'unknown')) + (n ? '<br>' + n + ' open trouble code' + (n > 1 ? 's' : '') : '<br>No open trouble codes') + '<br><a href="#" data-veh="' + esc(v.id) + '">View incidents</a>');
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
        (cp ? '<div><span>Claim status</span><b>' + esc(claimLabel(cp.status)) + '</b></div><div><span>Estimated value</span><b>' + fmt.currency(cp.estimatedValueUsd) + '</b></div>' : '') + '</div>' +
        (cp && cp.summary ? '<p class="nx-dim" style="font-size:13px;margin:10px 0 0">' + esc(cp.summary) + '</p>' : '') +
        (w.claimEligible ? '<div style="margin-top:12px"><a class="nx-btn nx-btn--primary nx-btn--sm" target="_blank" rel="noopener" href="/api/incidents/' + encodeURIComponent(inc.id) + '/warranty-packet?format=html">Open claim packet</a></div>' : ''));
    }

    h += sec('Vehicle and driver', '', '<div class="fl-kvs"><div><span>Vehicle</span><b>' + esc(vehSub(inc) || '—') + '</b></div><div><span>Plate / VIN</span><b class="nx-mono" style="font-size:12px">' + esc(v.plate || '') + ' ' + esc(v.vin || '') + '</b></div><div><span>Odometer</span><b>' + (v.odometer_mi != null ? fmt.number(v.odometer_mi) + ' mi' : '—') + '</b></div><div><span>Speed at event</span><b>' + (l.speed_mph != null ? Math.round(l.speed_mph) + ' mph' : '—') + '</b></div><div><span>Driver</span><b>' + esc(d.name || '—') + '</b></div><div><span>Driver safety score</span><b>' + (d.safetyScore != null ? fmt.number(d.safetyScore) : '—') + '</b></div></div>');
    h += '</div>';
    var dr = $('drawer'), top = dr.scrollTop;
    dr.innerHTML = h; dr.scrollTop = top;
    $('d-close').onclick = closeDrawer;
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

  /* ---------------- warranty ---------------- */
  function claims() { return S.incidents.filter(function (i) { return i.warranty && i.warranty.claimEligible; }); }
  function claimLabel(s) { return { draft: 'Draft prepared', ready: 'Ready to file', submitted: 'Submitted', approved: 'Approved', paid: 'Paid', denied: 'Denied' }[s] || fmt.label(s || 'eligible'); }
  function renderWarranty() {
    var host = $('war-body'); if (!host) return;
    var cs = claims();
    var val = function (i) { return num(i.warranty.claimPacket && i.warranty.claimPacket.estimatedValueUsd, 0); };
    var st = function (i) { return (i.warranty.claimPacket && i.warranty.claimPacket.status) || 'draft'; };
    var recovered = num(S.summary && S.summary.kpis && S.summary.kpis.warrantyRecoveredUsd, 0);
    var pend = cs.filter(function (i) { return ['paid', 'approved', 'denied'].indexOf(st(i)) < 0; });
    var pendVal = pend.reduce(function (a, i) { return a + val(i); }, 0);
    var kp = (S.summary && S.summary.kpis) || {}; if (kp.warrantyPendingUsd != null) pendVal = Math.max(pendVal, kp.warrantyPendingUsd);
    var ready = cs.filter(function (i) { return st(i) === 'ready'; }).length;
    var html = '<div class="nx-kpis"><div class="nx-kpi nx-kpi--ok"><div class="nx-kpi__label">Recovered</div><div class="nx-kpi__value">' + fmt.currency(recovered) + '</div><div class="nx-kpi__delta">paid by OEMs</div></div>' +
      '<div class="nx-kpi nx-kpi--accent"><div class="nx-kpi__label">Pending value</div><div class="nx-kpi__value">' + fmt.currency(pendVal) + '</div><div class="nx-kpi__delta">' + pend.length + ' open claims</div></div>' +
      '<div class="nx-kpi"><div class="nx-kpi__label">Eligible claims</div><div class="nx-kpi__value">' + cs.length + '</div><div class="nx-kpi__delta">auto-assembled by Nexus</div></div>' +
      '<div class="nx-kpi"><div class="nx-kpi__label">Ready to file</div><div class="nx-kpi__value">' + ready + '</div><div class="nx-kpi__delta">evidence complete</div></div></div>';
    if (!cs.length) { host.innerHTML = html; host.appendChild(NX.empty('No eligible claims', 'Warranty-eligible failures will appear with a ready claim packet.')); return; }
    html += '<div class="nx-card nx-card--flush"><div class="nx-table-wrap"><table class="nx-table"><thead><tr><th>Claim</th><th>Vehicle</th><th>Failure</th><th>OEM / coverage</th><th>Status</th><th class="num">Est. value</th><th>Packet</th></tr></thead><tbody>' +
      cs.map(function (i) {
        var w = i.warranty, codes = i.diagnostics && i.diagnostics.dtcs ? i.diagnostics.dtcs.map(function (t) { return t.code; }).join(', ') : '';
        return '<tr class="fl-row-click" data-id="' + esc(i.id) + '"><td class="id">' + esc(w.claimId || i.id) + '<span class="sub">' + fmt.ago(i.timestamp) + '</span></td><td>' + esc(vehLabel(i)) + '<span class="sub">' + esc(vehSub(i)) + '</span></td><td class="wrap">' + esc(typeLabel(i.eventType)) + '<span class="sub">' + esc(codes) + '</span></td><td>' + esc(w.oem || (i.vehicle && i.vehicle.oem) || '') + '<span class="sub">' + esc(fmt.label(w.coverage)) + (w.expiresAt ? ' · to ' + esc(fmt.date(w.expiresAt)) : '') + '</span></td><td>' + NX.badgeHTML(claimLabel(st(i)), st(i) === 'ready' ? 'accent' : st(i) === 'submitted' ? 'info' : st(i) === 'paid' || st(i) === 'approved' ? 'ok' : 'plain') + '</td><td class="num">' + fmt.currency(val(i)) + '</td><td><a class="nx-btn nx-btn--sm" target="_blank" rel="noopener" href="/api/incidents/' + encodeURIComponent(i.id) + '/warranty-packet?format=html" onclick="event.stopPropagation()">Open</a></td></tr>';
      }).join('') + '</tbody></table></div></div>';
    host.innerHTML = html; bindRows(host);
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
