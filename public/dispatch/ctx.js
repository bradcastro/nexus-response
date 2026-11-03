/* Dispatch — incident context intelligence panels (trip, telemetry, equipment, load, warranty dealer) */
(function () {
  'use strict';
  var esc = NX.esc, fmt = NX.fmt;
  var PLACE = { food_distributor: ['FD', 'Food distributor'], grocery_dc: ['GD', 'Grocery DC'], cold_storage: ['CS', 'Cold storage'], steel_yard: ['SY', 'Steel yard'], lumber_yard: ['LY', 'Lumber yard'], building_supply: ['BS', 'Building supply'], fuel_stop: ['FU', 'Fuel stop'], truck_stop: ['TS', 'Truck stop'], port: ['PT', 'Port'], manufacturer: ['MF', 'Manufacturer'], farm: ['FM', 'Farm'], quarry: ['QY', 'Quarry'], retail_dc: ['RD', 'Retail DC'], parcel_hub: ['PH', 'Parcel hub'], unknown: ['??', 'Unknown'] };
  var place = function (t) { return PLACE[t] || [String(t || '?').slice(0, 2).toUpperCase(), fmt.label(t || 'unknown')]; };
  var num = function (n, d) { return n == null || isNaN(n) ? '--' : fmt.number(n, d); };
  var sgn = function (n, d) { return n == null || isNaN(n) ? '--' : (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toFixed(d == null ? 1 : d); };
  var lbs = function (n) { return n == null ? '--' : n >= 10000 ? Math.round(n / 1000) + 'k lb' : fmt.number(n) + ' lb'; };
  var usd = function (r) { return !r ? '--' : r.length ? fmt.compact(r[0]).replace(/^/, '$') + '–' + fmt.compact(r[1]).replace(/^/, '$') : fmt.currency(r); };
  var CAT_LABEL = function (c) { return fmt.label(c || 'unknown'); };
  var KIND_COL = { drive: 'var(--nx-info)', stop: 'var(--nx-accent)', idle: 'var(--nx-warn)', event: 'var(--nx-sev-critical)' };

  /* ---------- summary chips at top of detail ---------- */
  function chips(i) {
    var out = [], L = i.load, E = i.equipment, T = E && E.trailer, c = L && L.contents;
    if (c && c.hazmat) out.push(['HAZMAT', 'bad']);
    if (L && L.estimatedWeightLb != null) out.push(['≈' + lbs(L.estimatedWeightLb), L.overweightRisk ? 'bad' : '']);
    if (c && c.temperatureSensitive) out.push(['perishable', 'warn']);
    else if (c && c.category && c.category !== 'unknown') out.push([CAT_LABEL(c.category).toLowerCase(), '']);
    if (T && T.attached !== false && T.type && T.type !== 'none') out.push([T.type.replace(/_/g, ' '), '']);
    if (T && T.attached !== false && T.type !== 'none') out.push([T.cameraVerified ? 'camera-verified' : 'inferred', T.cameraVerified ? 'ok' : 'warn']);
    if (L && L.overweightRisk) out.push(['overweight risk', 'bad']);
    if (c && c.estimatedValueUsd) out.push([usd(c.estimatedValueUsd) + ' cargo', '']);
    if (i.warrantyDealer && i.warrantyDealer.nearest) out.push(['OEM dealer ' + num(i.warrantyDealer.nearest.distanceMi, 0) + ' mi', 'ok']);
    if (!out.length) return '';
    return '<div class="ctx-chips">' + out.map(function (c) { return '<span class="tag ' + c[1] + '">' + esc(c[0]) + '</span>'; }).join('') + '</div>';
  }
  function hazBanner(i) {
    var c = i.load && i.load.contents; if (!c || !c.hazmat) return '';
    return '<div class="haz-banner"><div class="haz-ic">!</div><div><b>Hazmat load</b><span>' + esc(c.label || 'Hazardous material') + '. Treat as spill risk: notify HazMat response and isolate the scene before dispatching standard tow.</span></div></div>';
  }

  /* ---------- trip & last stop ---------- */
  function tripHTML(i, panel) {
    var t = i.trip; if (!t) return panel('Trip &amp; last stop', NX.badgeHTML('No trip data', 'plain'), '<p class="nx-dim">No trip history is available for this vehicle.</p>', 'trip');
    var s = t.lastStop, body = '';
    if (s) {
      var p = place(s.placeType);
      body += '<div class="stop-card"><div class="pt-ic" title="' + esc(p[1]) + '">' + esc(p[0]) + '</div><div class="nx-grow"><div class="stop-name">' + esc(s.businessName || s.name || 'Unnamed stop') + '</div><div class="nx-dim" style="font-size:12px">' + esc(p[1]) + (s.address ? ' &middot; ' + esc(s.address) : '') + '</div></div></div>' +
        '<div class="stat-row"><div><b>' + num(s.dwellMin, 0) + '</b><span>Dwell min</span></div><div><b>' + num(s.minutesBeforeIncident, 0) + '</b><span>Min before event</span></div><div><b>' + num(s.milesSinceStop, 1) + '</b><span>Miles since</span></div></div>' +
        '<div class="nx-faint nx-mono" style="font-size:12px;margin:6px 0 2px">' + (s.arrivedAt ? 'Arrived ' + fmt.time(s.arrivedAt) : '') + (s.departedAt ? ' &middot; departed ' + fmt.time(s.departedAt) : '') + '</div>';
    }
    var rs = (t.recentStops || []);
    if (rs.length) body += '<div class="nx-eyebrow" style="margin:12px 0 6px">Recent stops</div><div class="rstops">' + rs.map(function (r) { var q = place(r.placeType); return '<div class="rstop"><span class="pt-ic sm">' + esc(q[0]) + '</span><span class="nx-grow">' + esc(r.name || r.businessName || q[1]) + '</span><span class="nx-mono nx-faint">' + (r.arrivedAt ? fmt.time(r.arrivedAt).slice(0, 5) : '') + ' &middot; ' + num(r.dwellMin, 0) + 'm</span></div>'; }).join('') + '</div>';
    var tl = (t.timeline || []).slice(-8);
    if (tl.length) body += '<div class="nx-eyebrow" style="margin:12px 0 6px">Trip timeline</div><ul class="mtl">' + tl.map(function (e) { return '<li style="--c:' + (KIND_COL[e.kind] || 'var(--nx-text-faint)') + '"><span class="nx-mono nx-faint">' + esc(fmt.time(e.t).slice(0, 5)) + '</span><span>' + esc(e.label) + '</span></li>'; }).join('') + '</ul>';
    return panel('Trip &amp; last stop', '<span class="nx-mono nx-faint" style="font-size:12px">' + num(t.distanceMi, 0) + ' mi &middot; ' + (t.durationMin != null ? fmt.duration(t.durationMin) : '--') + (t.idleMin ? ' &middot; ' + num(t.idleMin, 0) + 'm idle' : '') + '</span>', body, 'trip');
  }

  /* ---------- telemetry: engine load / fuel economy ---------- */
  function spark(series, key, color, stop, evt, label, unit) {
    var W = 440, H = 76, P = 4, pts = series.filter(function (d) { return d[key] != null; });
    if (pts.length < 2) return '';
    var ts = pts.map(function (d) { return +new Date(d.t); }), t0 = Math.min.apply(0, ts), t1 = Math.max.apply(0, ts);
    var vs = pts.map(function (d) { return d[key]; }), lo = Math.min.apply(0, vs), hi = Math.max.apply(0, vs), pad = (hi - lo || 1) * 0.15; lo -= pad; hi += pad;
    var x = function (t) { return P + (t - t0) / (t1 - t0 || 1) * (W - 2 * P); }, y = function (v) { return H - P - (v - lo) / (hi - lo) * (H - 2 * P); };
    var line = pts.map(function (d, k) { return (k ? 'L' : 'M') + x(+new Date(d.t)).toFixed(1) + ' ' + y(d[key]).toFixed(1); }).join(' ');
    var area = line + ' L' + x(t1).toFixed(1) + ' ' + (H - P) + ' L' + x(t0).toFixed(1) + ' ' + (H - P) + ' Z';
    var shade = '', ev = '';
    if (stop && stop.arrivedAt) { var a = Math.max(t0, +new Date(stop.arrivedAt)), b = Math.min(t1, +new Date(stop.departedAt || stop.arrivedAt)); if (b > a) shade = '<rect x="' + x(a).toFixed(1) + '" y="0" width="' + (x(b) - x(a)).toFixed(1) + '" height="' + H + '" fill="var(--nx-accent)" opacity=".16"/><text x="' + ((x(a) + x(b)) / 2).toFixed(1) + '" y="11" text-anchor="middle" fill="var(--nx-accent)" font-size="8.5" font-family="var(--nx-font-mono)" letter-spacing=".1em">STOP</text>'; }
    if (evt && +new Date(evt) >= t0 && +new Date(evt) <= t1) ev = '<line x1="' + x(+new Date(evt)).toFixed(1) + '" x2="' + x(+new Date(evt)).toFixed(1) + '" y1="0" y2="' + H + '" stroke="var(--nx-sev-critical)" stroke-width="1.5" stroke-dasharray="3 3"/><text x="' + (x(+new Date(evt)) - 4).toFixed(1) + '" y="11" text-anchor="end" fill="var(--nx-sev-critical)" font-size="8.5" font-family="var(--nx-font-mono)" letter-spacing=".1em">EVENT</text>';
    return '<div class="spark"><div class="spark-l"><span>' + label + '</span><span class="nx-mono nx-faint">' + Math.round(Math.min.apply(0, vs)) + '–' + Math.round(Math.max.apply(0, vs)) + ' ' + unit + '</span></div>' +
      '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="' + esc(label) + ' over time">' + shade + '<path d="' + area + '" fill="' + color + '" opacity=".14"/><path d="' + line + '" fill="none" stroke="' + color + '" stroke-width="2" vector-effect="non-scaling-stroke"/>' + ev + '</svg></div>';
  }
  function delta(label, b, a, d, unit, goodDown, dec) {
    var bad = d != null && (goodDown ? d < 0 : d > 0);
    return '<div class="delta"><div class="nx-eyebrow">' + label + '</div><div class="delta-n" style="color:' + (d == null ? '' : (label.indexOf('Fuel') === 0 ? (d < 0 ? 'var(--nx-sev-high)' : 'var(--nx-ok)') : (d > 0 ? 'var(--nx-sev-high)' : 'var(--nx-ok)'))) + '">' + sgn(d, dec) + '<small>' + unit + '</small></div><div class="nx-mono nx-faint" style="font-size:12px">' + num(b, dec) + ' &rarr; ' + num(a, dec) + '</div></div>';
  }
  function telemetryHTML(i, panel) {
    var T = i.trip && i.trip.telemetry; if (!T) return '';
    var series = T.series || [], b = T.before || {}, a = T.after || {};
    var dl = T.deltaEngineLoadPct != null ? T.deltaEngineLoadPct : (a.avgEngineLoadPct != null && b.avgEngineLoadPct != null ? a.avgEngineLoadPct - b.avgEngineLoadPct : null);
    var dm = T.deltaFuelMpg != null ? T.deltaFuelMpg : (a.avgFuelMpg != null && b.avgFuelMpg != null ? a.avgFuelMpg - b.avgFuelMpg : null);
    var stop = i.trip.lastStop;
    return panel('Engine load &amp; fuel economy', '<span class="nx-mono nx-faint" style="font-size:12px">before vs after last stop</span>',
      '<div class="deltas">' + delta('Engine load', b.avgEngineLoadPct, a.avgEngineLoadPct, dl, '%', false, 0) + delta('Fuel economy', b.avgFuelMpg, a.avgFuelMpg, dm, ' mpg', true, 1) + '</div>' +
      spark(series, 'engineLoadPct', 'var(--nx-sev-high)', stop, i.timestamp, 'Engine load', '%') + spark(series, 'fuelMpg', 'var(--nx-info)', stop, i.timestamp, 'Fuel economy', 'mpg') +
      '<p class="nx-faint" style="font-size:12px;margin-top:8px">A step up in load and drop in mpg after the stop indicates a pickup. ' + (b.sampleCount != null ? 'Based on ' + b.sampleCount + ' + ' + (a.sampleCount || 0) + ' samples.' : '') + '</p>', 'telemetry');
  }

  /* ---------- equipment ---------- */
  function equipmentHTML(i, panel) {
    var E = i.equipment; if (!E) return panel('Equipment', NX.badgeHTML('No data', 'plain'), '<p class="nx-dim">Tractor and trailer are not known for this vehicle.</p>', 'equipment');
    var t = E.tractor || {}, tr = E.trailer, body = '';
    body += '<div class="eq-row"><div class="eq-k">Tractor</div><div class="nx-grow"><b>' + esc([t.year, t.make, t.model].filter(Boolean).join(' ') || 'Unknown') + '</b><div class="nx-dim" style="font-size:12px">' + esc(fmt.label(t.class || '')) + (t.engine ? ' &middot; ' + esc(t.engine) : '') + (t.gvwrLb ? ' &middot; GVWR ' + lbs(t.gvwrLb) : '') + '</div></div></div>';
    var badge = '';
    if (!tr || tr.attached === false || tr.type === 'none') body += '<div class="eq-row"><div class="eq-k">Trailer</div><div class="nx-grow"><b>Bobtail / no trailer</b></div></div>';
    else {
      badge = tr.cameraVerified ? '<div class="verif ok"><b>Camera-verified</b><span>' + esc(tr.cameraBasis || 'Visually confirmed by camera') + '</span></div>' : '<div class="verif warn"><b>Inferred</b><span>Not seen by camera. Detected by ' + esc(fmt.label(tr.detectedBy || 'inference').toLowerCase()) + (tr.cameraBasis ? '. ' + esc(tr.cameraBasis) : '') + '</span></div>';
      body += '<div class="eq-row"><div class="eq-k">Trailer</div><div class="nx-grow"><b>' + esc(fmt.label(tr.type)) + (tr.lengthFt ? ' &middot; ' + tr.lengthFt + ' ft' : '') + '</b><div class="nx-dim" style="font-size:12px">' + (tr.unitId ? esc(tr.unitId) + ' &middot; ' : '') + 'Tare ' + lbs(tr.tareLb) + ' &middot; Max payload ' + lbs(tr.maxPayloadLb) + '</div></div></div>' + badge;
      if (tr.reefer) body += '<div class="stat-row"><div><b>' + num(tr.reefer.setpointF, 0) + '&deg;F</b><span>Setpoint</span></div><div><b>' + num(tr.reefer.returnAirF, 0) + '&deg;F</b><span>Return air</span></div><div><b style="color:' + (tr.reefer.unitRunning ? 'var(--nx-ok)' : 'var(--nx-danger)') + '">' + (tr.reefer.unitRunning ? 'RUN' : 'OFF') + '</b><span>Reefer unit</span></div><div><b>' + num(tr.reefer.fuelPct, 0) + '%</b><span>Reefer fuel</span></div></div>';
    }
    var right = tr && tr.attached !== false && tr.type !== 'none' ? NX.badgeHTML(tr.cameraVerified ? 'Camera-verified' : 'Inferred', tr.cameraVerified ? 'ok' : 'warn') : '';
    return panel('Equipment', right, body, 'equipment');
  }

  /* ---------- load intelligence ---------- */
  function gauge(L, E) {
    var max = E && E.trailer && E.trailer.maxPayloadLb, pct = L.payloadPctOfMax;
    if (pct == null && max && L.estimatedWeightLb != null) pct = L.estimatedWeightLb / max * 100;
    if (pct == null) return '';
    var r = L.weightRangeLb, lo = r && max ? Math.max(0, r[0] / max * 100) : null, hi = r && max ? Math.min(130, r[1] / max * 100) : null;
    var col = pct > 100 ? 'var(--nx-danger)' : pct > 85 ? 'var(--nx-sev-high)' : pct > 50 ? 'var(--nx-warn)' : 'var(--nx-ok)';
    var scale = Math.max(110, Math.ceil(pct / 10) * 10 + 10), w = function (v) { return Math.min(100, v / scale * 100); };
    return '<div class="gauge"><div class="gauge-bar">' + (lo != null ? '<i class="rng" style="left:' + w(lo) + '%;width:' + Math.max(1, w(hi) - w(lo)) + '%"></i>' : '') +
      '<i class="fill" style="width:' + w(Math.min(pct, scale)) + '%;--c:' + col + '"></i><i class="tick" style="left:' + w(100) + '%"></i></div>' +
      '<div class="gauge-l"><span>0</span><span style="left:' + w(100) + '%">max payload ' + lbs(max) + ' \u25B8</span></div>' +
      '<div class="gauge-v"><b style="color:' + col + '">' + Math.round(pct) + '%</b> of max payload' + (L.grossVehicleWeightLb ? ' &middot; GVW ' + fmt.number(L.grossVehicleWeightLb) + ' lb' : '') + '</div></div>';
  }
  function loadHTML(i, panel) {
    var L = i.load; if (!L) return panel('Load intelligence', NX.badgeHTML('Unknown', 'plain'), '<p class="nx-dim">Not enough telemetry or trip history to estimate the load.</p>', 'load');
    var c = L.contents || {}, flags = '';
    if (c.hazmat) flags += NX.badgeHTML('Hazmat', 'danger');
    if (c.temperatureSensitive) flags += NX.badgeHTML('Perishable', 'warn');
    if (L.overweightRisk) flags += NX.badgeHTML('Overweight risk', 'danger');
    var conf = L.confidence != null ? Math.round(L.confidence * 100) : null;
    var ex = (c.examples || []).length ? '<div class="nx-dim" style="font-size:12px">e.g. ' + esc(c.examples.join(', ')) + '</div>' : '';
    var spoil = '';
    if (c.spoilageRiskHours != null) {
      var left = c.spoilageRiskHours - (Date.now() - new Date(i.timestamp)) / 3600000;
      spoil = '<div class="spoil' + (left < 1 ? ' late' : '') + '"><div class="nx-eyebrow">Spoilage clock</div><div class="spoil-n">' + (left > 0 ? left.toFixed(1) + ' h left' : 'Window exceeded') + '</div><div class="nx-faint nx-mono" style="font-size:12px">' + c.spoilageRiskHours + ' h window from event</div></div>';
    }
    var body = '<div class="load-top"><div class="load-w"><div class="nx-eyebrow">Estimated cargo weight</div><div class="load-n">≈' + num(L.estimatedWeightLb) + '<small> lb</small></div>' +
      (L.weightRangeLb ? '<div class="nx-mono nx-faint" style="font-size:11.5px">range ' + fmt.number(L.weightRangeLb[0]) + '–' + fmt.number(L.weightRangeLb[1]) + ' lb</div>' : '') + '</div>' + spoil + '</div>' + gauge(L, i.equipment) +
      '<div class="cargo"><div class="nx-grow"><div class="nx-eyebrow">Cargo</div><div style="font-weight:600;margin-top:4px">' + esc(c.label || CAT_LABEL(c.category)) + '</div>' + ex + '</div>' +
      (conf != null ? '<div class="conf-s"><b>' + conf + '%</b><span>confidence</span><div class="nx-meter" style="margin-top:4px"><i style="width:' + conf + '%;--c:' + (conf >= 75 ? 'var(--nx-ok)' : conf >= 50 ? 'var(--nx-warn)' : 'var(--nx-sev-high)') + '"></i></div></div>' : '') + '</div>' +
      (flags || c.estimatedValueUsd ? '<div class="nx-row" style="gap:6px;flex-wrap:wrap;margin-top:10px">' + flags + (c.estimatedValueUsd ? '<span class="tag">Est. value ' + usd(c.estimatedValueUsd) + '</span>' : '') + '</div>' : '');
    if (L.cameraVisual) body += '<div class="verif ' + (L.cameraVisual.cargoVisible ? 'ok' : 'warn') + '" style="margin-top:10px"><b>' + (L.cameraVisual.cargoVisible ? 'Cargo seen on camera' : 'Cargo not visible') + (L.cameraVisual.confidence != null ? ' (' + Math.round(L.cameraVisual.confidence * 100) + '%)' : '') + '</b><span>' + esc(L.cameraVisual.description || '') + '</span></div>';
    var basis = L.basis || [];
    if (basis.length) body += '<div class="how"><div class="nx-eyebrow" style="margin-bottom:8px">How we know' + (L.method ? ' &middot; ' + esc(fmt.label(L.method)) : '') + '</div><ol>' + basis.map(function (b) { return '<li>' + esc(b) + '</li>'; }).join('') + '</ol></div>';
    return panel('Load intelligence', NX.badgeHTML(c.hazmat ? 'Hazmat' : c.temperatureSensitive ? 'Perishable' : fmt.label(c.category || 'estimated'), c.hazmat ? 'danger' : c.temperatureSensitive ? 'warn' : 'plain'), body, 'load');
  }

  /* ---------- warranty dealer ---------- */
  function dealerHTML(i, panel, btn, S) {
    var d = i.warrantyDealer; if (!d || !d.nearest) return '';
    var n = d.nearest, tow = i.roadside && i.roadside.towDestination, closed = ['resolved', 'dismissed'].indexOf(i.status) > -1;
    var card = function (x, big) {
      return '<div class="dealer' + (big ? ' big' : '') + (S.dealerPick === x.id || (!S.dealerPick && big) ? ' is-picked' : '') + '" data-dealer="' + esc(x.id) + '"><div class="nx-grow"><div class="dealer-n">' + esc(x.name) + '</div><div class="nx-dim" style="font-size:12px">' + esc(x.address || '') + '</div>' +
        '<div class="nx-row" style="gap:5px;flex-wrap:wrap;margin-top:6px">' + (x.open24x7 ? '<span class="tag ok">24x7</span>' : x.hours ? '<span class="tag">' + esc(x.hours) + '</span>' : '') + (x.heavyDutyBays ? '<span class="tag ok">Heavy-duty bays</span>' : '<span class="tag warn">No HD bays</span>') + (x.hasPartsInStock === true ? '<span class="tag ok">Parts in stock</span>' : x.hasPartsInStock === false ? '<span class="tag warn">Parts on order</span>' : '') + '</div></div>' +
        '<div class="eta"><b>' + (x.driveEtaMin != null ? Math.round(x.driveEtaMin) : '--') + '</b><span>MIN DRIVE</span><div class="nx-mono nx-faint" style="font-size:12px;margin-top:4px">' + num(x.distanceMi, 1) + ' mi</div></div></div>';
    };
    var pick = [n].concat(d.alternates || []).find(function (x) { return x.id === S.dealerPick; }) || n;
    var body = card(n, true) +
      '<div class="dealer-meta">' + (d.reason ? '<p class="nx-dim" style="font-size:12.5px">' + esc(d.reason) + '</p>' : '') +
      '<dl class="nx-kv"><dt>OEM / coverage</dt><dd>' + esc(d.oem || '--') + ' &middot; ' + esc(fmt.label(d.coverage || '')) + '</dd><dt>Phone</dt><dd class="nx-mono">' + (n.phone ? '<a href="tel:' + esc(n.phone) + '">' + esc(n.phone) + '</a>' : '--') + '</dd>' +
      '<dt>Authorization</dt><dd>' + (d.authorizationRequired ? NX.badgeHTML(d.preAuthNumber ? 'Pre-auth issued' : 'Required', d.preAuthNumber ? 'ok' : 'warn') + (d.preAuthNumber ? ' <span class="nx-mono">' + esc(d.preAuthNumber) + '</span>' : '') : 'Not required') + '</dd></dl></div>' +
      ((d.alternates || []).length ? '<div class="nx-eyebrow" style="margin:12px 0 6px">Alternates</div>' + d.alternates.map(function (x) { return card(x, false); }).join('') : '') +
      (tow ? '<div class="verif ok" style="margin-top:12px"><b>Tow destination set</b><span>' + esc(tow.name) + (tow.distanceMi != null ? ' &middot; ' + num(tow.distanceMi, 1) + ' mi' : '') + '</span></div>' : '') +
      '<div style="margin-top:12px">' + btn((tow && tow.name === pick.name ? 'Tow destination set' : 'Tow to ' + esc(pick.name)), 'nx-btn--block' + (tow ? '' : ' nx-btn--primary'), 'towdealer', closed || (tow && tow.name === pick.name) ? ' disabled' : '', 'tow') + '</div>';
    return panel('Warranty dealer', NX.badgeHTML(d.authorizationRequired ? 'Pre-auth' : 'OEM service', 'info'), body, 'dealer');
  }

  window.NXCtx = { chips: chips, hazBanner: hazBanner, trip: tripHTML, telemetry: telemetryHTML, equipment: equipmentHTML, load: loadHTML, dealer: dealerHTML, place: place };
})();
