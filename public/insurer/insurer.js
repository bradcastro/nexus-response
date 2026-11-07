/* Nexus Response — Insurer portal. Codes to docs/ARCHITECTURE.md; tolerant of shape variance. */
(function () {
  'use strict';
  var el = NX.el, esc = NX.esc, fmt = NX.fmt;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var state = { P: null, fleets: [], sort: { key: 'riskScore', dir: -1 }, q: '', vendor: '', tier: '', incidents: [], dive: null };

  /* ---------- helpers ---------- */
  function num(v, d) { v = Number(v); return isNaN(v) ? (d == null ? null : d) : v; }
  function pick(o) { if (!o) return undefined; for (var i = 1; i < arguments.length; i++) { var v = o[arguments[i]]; if (v != null) return v; } return undefined; }
  function pct(v) { v = num(v); return v == null ? null : (v <= 1 && v >= 0 ? v * 100 : v); } // accept 0-1 or 0-100
  function pctTxt(v, d) { var p = pct(v); return p == null ? '—' : p.toFixed(d == null ? 0 : d) + '%'; }
  function signed(v, d) { v = num(v); return v == null ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(d == null ? 1 : d) + '%'; }
  function avg(a) { a = a.filter(function (x) { return x != null; }); return a.length ? a.reduce(function (s, x) { return s + x; }, 0) / a.length : null; }
  function wavg(items, val, w) { var sw = 0, s = 0; items.forEach(function (i) { var v = val(i), ww = w(i); if (v != null && ww) { s += v * ww; sw += ww; } }); return sw ? s / sw : null; }
  var VENDOR_NAMES = { mantis: 'Mantis', motive: 'Motive', samsara: 'Samsara', geotab: 'Geotab', lytx: 'Lytx', generic: 'Generic' };
  function vName(v) { return VENDOR_NAMES[String(v || '').toLowerCase()] || fmt.label(v); }
  function vColor(v) { return 'var(--v-' + (VENDOR_NAMES[String(v || '').toLowerCase()] ? String(v).toLowerCase() : 'generic') + ')'; }
  function vendorChip(v) { return '<span class="ins-vendor" style="--c:' + vColor(v) + '"><i></i>' + esc(vName(v)) + '</span>'; }
  function tierColor(t, score) {
    var s = String(t || '').toLowerCase();
    if (/crit|sev/.test(s)) return 'var(--nx-sev-critical)';
    if (/high/.test(s)) return 'var(--nx-sev-high)';
    if (/elev|watch|above/.test(s)) return 'var(--nx-warn)';
    if (/mod|med|avg|average/.test(s)) return 'var(--nx-info)';
    if (/low|pref|best|standard/.test(s)) return 'var(--nx-ok)';
    score = num(score); if (score == null) return 'var(--nx-text-dim)';
    return score >= 75 ? 'var(--nx-sev-critical)' : score >= 60 ? 'var(--nx-sev-high)' : score >= 45 ? 'var(--nx-warn)' : score >= 30 ? 'var(--nx-info)' : 'var(--nx-ok)';
  }
  function tierHTML(t, score) { return '<span class="ins-tier" style="--c:' + tierColor(t, score) + '"><i></i>' + esc(fmt.label(t || '—')) + '</span>'; }
  function trendHTML(t) {
    var k = String(t || 'flat').toLowerCase();
    var up = /up|worse|rising|increas/.test(k), down = /down|better|falling|improv|decreas/.test(k);
    return '<span class="ins-trend ' + (up ? 'up' : down ? 'down' : 'flat') + '" title="Risk trend: ' + (up ? 'rising' : down ? 'improving' : 'stable') + '">' + (up ? '▲' : down ? '▼' : '▬') + '<span class="nx-sr"> ' + (up ? 'rising' : down ? 'improving' : 'stable') + '</span></span>';
  }
  function chips(list, max) {
    list = (list || []).map(function (f) { return typeof f === 'string' ? f : pick(f, 'label', 'factor', 'name', 'key'); }).filter(Boolean);
    if (!list.length) return '<span class="nx-faint">—</span>';
    return '<span class="ins-chips">' + list.slice(0, max || 3).map(function (f) { return '<span class="nx-chip nx-chip--static" title="' + esc(f) + '">' + esc(fmt.label(String(f).split(':')[0].replace(/ & .*/, ''))) + '</span>'; }).join('') + '</span>';
  }
  function scoreBar(score, tier) {
    var s = num(score, 0);
    return '<span class="ins-scorebar"><span class="ins-score">' + s.toFixed(0) + '</span><span class="nx-meter"><i style="width:' + Math.max(2, Math.min(100, s)) + '%;--c:' + tierColor(tier, s) + '"></i></span></span>';
  }
  function dl(name, content) { var a = el('a', { href: URL.createObjectURL(new Blob([content], { type: 'text/csv' })), download: name }); document.body.appendChild(a); a.click(); a.remove(); }
  function normFleet(f) {
    var fl = Object.assign({}, f);
    fl.riskScore = num(pick(f, 'riskScore', 'score'), 0);
    fl.riskTier = pick(f, 'riskTier', 'tier');
    fl.vehicles = num(f.vehicles, 0);
    fl.ev100 = num(pick(f, 'events30dPer100veh', 'eventsPer100'), null);
    fl.coll = num(pick(f, 'collisionRate'), null);
    fl.cam = num(pick(f, 'cameraCoveragePct'), null);
    fl.ver = num(pick(f, 'verifiedEventPct'), null);
    fl.cargo = num(f.cargoExposureUsd, null); fl.loadPct = num(f.avgLoadPctOfMax, null);
    fl.ev30 = num(pick(f, 'events30d', 'events'), null);
    if (fl.ev30 == null && fl.ev100 != null) fl.ev30 = Math.round(fl.ev100 * fl.vehicles / 100);
    return fl;
  }

  /* ---------- load ---------- */
  function load() {
    $('#err').innerHTML = '';
    $('#kpis').replaceChildren(NX.skeleton(2));
    return Promise.all([
      NX.api('/api/insurer/portfolio'),
      NX.api('/api/incidents', { query: { limit: 500 } }).catch(function () { return null; })
    ]).then(function (r) {
      state.P = r[0] || {};
      state.fleets = (state.P.fleets || []).map(normFleet);
      var inc = r[1]; state.incidents = Array.isArray(inc) ? inc : (inc && inc.incidents) || [];
      renderPortfolio(); route();
    }).catch(function (e) {
      $('#kpis').replaceChildren();
      $('#err').innerHTML = '<div class="nx-card nx-card--alert"><div class="nx-card__body"><b>Portfolio data unavailable.</b> ' + esc(e.message) + ' <button class="nx-btn nx-btn--sm" id="retry">Retry</button></div></div>';
      $('#retry').onclick = load;
    });
  }

  /* ---------- portfolio ---------- */
  function renderPortfolio() {
    var P = state.P, T = P.totals || {}, F = state.fleets;
    $('#asof').textContent = 'As of ' + fmt.dateTime(new Date());
    var lr = num(T.lossRatioProxy);
    var lrTxt = lr == null ? '—' : (lr <= 2 ? (lr * 100).toFixed(0) + '%' : lr.toFixed(0) + '%');
    var kp = [
      ['Policyholders', fmt.number(pick(T, 'fleets') != null ? T.fleets : F.length), 'fleets in book'],
      ['Insured vehicles', fmt.number(pick(T, 'vehicles') != null ? T.vehicles : F.reduce(function (s, f) { return s + f.vehicles; }, 0)), 'across ' + new Set(F.map(function (f) { return f.vendor; })).size + ' telematics vendors'],
      ['Events, 30d', fmt.number(T.events30d), 'normalized from all vendors'],
      ['Loss-ratio proxy (illustrative)', lrTxt, 'synthetic data, demo assumptions']
    ];
    var cargoTot = F.some(function (f) { return f.cargo != null; }) ? F.reduce(function (a, f) { return a + (f.cargo || 0); }, 0) : null;
    if (cargoTot != null) kp.splice(4, 0, ['Cargo exposure', fmt.currency(cargoTot), 'est. value of loads in recent events']);
    var hi = F.filter(function (f) { return /high|sev|crit|elev/i.test(f.riskTier || ''); }).length;
    kp.push(['Elevated or higher', String(hi), 'policyholders needing review']);
    $('#kpis').innerHTML = kp.map(function (k, i) { return '<div class="nx-kpi' + (k[0] === 'Elevated or higher' && hi ? ' nx-kpi--accent' : '') + '"><div class="nx-kpi__label">' + esc(k[0]) + '</div><div class="nx-kpi__value">' + esc(k[1]) + '</div><div class="nx-kpi__delta nx-dim">' + esc(k[2]) + '</div></div>'; }).join('');
    renderScatter(); renderDist(); renderClaims(); renderFilters(); renderTable(); renderVendors();
  }

  function distEntries() {
    var d = state.P.distribution || {};
    d = d.tiers || d;
    var out = [];
    if (Array.isArray(d)) d.forEach(function (x) { out.push([pick(x, 'tier', 'name', 'label'), num(pick(x, 'count', 'fleets', 'value'), 0)]); });
    else Object.keys(d).forEach(function (k) { var v = d[k]; if (typeof v === 'object' && v) v = pick(v, 'count', 'fleets'); if (num(v) != null) out.push([k, num(v)]); });
    if (!out.length) { var m = {}; state.fleets.forEach(function (f) { m[f.riskTier] = (m[f.riskTier] || 0) + 1; }); Object.keys(m).forEach(function (k) { out.push([k, m[k]]); }); }
    return out;
  }
  function renderDist() {
    var e = distEntries(), max = Math.max.apply(null, e.map(function (x) { return x[1]; }).concat([1]));
    if (!e.length) { $('#dist').replaceChildren(NX.empty('No tiers', 'No distribution reported.')); return; }
    var totalFleets = e.reduce(function (s, x) { return s + x[1]; }, 0);
    $('#dist').innerHTML = '<div class="ins-dist">' + e.map(function (x) {
      return '<div class="ins-dist__row' + (state.tier === x[0] ? ' is-active' : '') + '"><button type="button" data-tier="' + esc(x[0]) + '" title="Filter table to this tier">' + tierHTML(x[0]) + '<span class="nx-meter"><i style="width:' + (x[1] / max * 100) + '%;--c:' + tierColor(x[0]) + '"></i></span><span class="nx-mono" style="text-align:right">' + x[1] + '</span></button></div>';
    }).join('') + '</div><p class="nx-dim ins-note" style="margin:var(--nx-sp-3) 0 0">' + totalFleets + ' policyholders. Select a tier to filter the table.</p>';
    $('#dist').onclick = function (ev) { var b = ev.target.closest('[data-tier]'); if (!b) return; state.tier = state.tier === b.dataset.tier ? '' : b.dataset.tier; $('#f-tier').value = state.tier; renderDist(); renderTable(); };
  }

  function renderScatter() {
    var F = state.fleets, host = $('#scatter');
    if (!F.length) { host.replaceChildren(NX.empty('No policyholders')); return; }
    var W = 640, H = 340, m = { l: 44, r: 16, t: 12, b: 40 };
    var xmax = Math.max.apply(null, F.map(function (f) { return f.vehicles; })) * 1.12 || 1;
    var ys = F.map(function (f) { return f.riskScore; }), ymin = Math.max(0, Math.floor((Math.min.apply(null, ys) - 10) / 10) * 10), ymax = Math.min(100, Math.ceil((Math.max.apply(null, ys) + 10) / 10) * 10);
    if (ymax - ymin < 20) ymax = ymin + 20;
    var maxEv = Math.max.apply(null, F.map(function (f) { return f.ev30 || 1; }));
    var X = function (v) { return m.l + v / xmax * (W - m.l - m.r); }, Y = function (v) { return H - m.b - (v - ymin) / (ymax - ymin) * (H - m.t - m.b); };
    var g = '';
    for (var y = ymin; y <= ymax; y += 10) g += '<line class="grid" x1="' + m.l + '" x2="' + (W - m.r) + '" y1="' + Y(y) + '" y2="' + Y(y) + '"/><text x="' + (m.l - 8) + '" y="' + (Y(y) + 3) + '" text-anchor="end">' + y + '</text>';
    var xt = Math.ceil(xmax / 5 / 10) * 10;
    for (var x = 0; x <= xmax; x += xt) g += '<line class="grid" x1="' + X(x) + '" x2="' + X(x) + '" y1="' + m.t + '" y2="' + (H - m.b) + '"/><text x="' + X(x) + '" y="' + (H - m.b + 16) + '" text-anchor="middle">' + x + '</text>';
    g += '<text x="' + (W / 2) + '" y="' + (H - 6) + '" text-anchor="middle">Insured vehicles (exposure)</text><text transform="translate(11 ' + (H / 2) + ') rotate(-90)" text-anchor="middle">Risk score</text>';
    var b = F.slice().sort(function (a, c) { return (c.ev30 || 0) - (a.ev30 || 0); }).map(function (f) {
      var r = 8 + Math.sqrt((f.ev30 || 1) / maxEv) * 24, cx = X(f.vehicles), cy = Y(f.riskScore);
      return '<g><circle class="bub" tabindex="0" role="button" aria-label="' + esc(f.name) + ', risk ' + f.riskScore + ', ' + f.vehicles + ' vehicles" data-fleet="' + esc(f.id) + '" cx="' + cx + '" cy="' + cy + '" r="' + r.toFixed(1) + '" fill="' + tierColor(f.riskTier, f.riskScore) + '"/><text class="lbl" x="' + cx + '" y="' + (cy - r - 5) + '" text-anchor="middle">' + esc(f.name.split(' ').slice(0, 2).join(' ')) + '</text></g>';
    }).join('');
    host.innerHTML = '<div class="ins-rel"><svg class="ins-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Bubble chart of risk score versus insured vehicles">' + g + b + '</svg></div><div class="ins-legend">' +
      distEntries().map(function (e) { return '<span style="--c:' + tierColor(e[0]) + '"><i></i>' + esc(fmt.label(e[0])) + '</span>'; }).join('') + '<span class="nx-faint">Click a bubble to open the policyholder</span></div>';
    var rel = $('.ins-rel', host), tip = null;
    function show(c) {
      var f = F.filter(function (x) { return x.id === c.dataset.fleet; })[0]; hide();
      tip = el('div.ins-tip', { html: '<b>' + esc(f.name) + '</b>' + esc(vName(f.vendor)) + ' · ' + f.vehicles + ' vehicles<br>Risk ' + f.riskScore.toFixed(0) + ' (' + esc(fmt.label(f.riskTier)) + ')<br>' + fmt.number(f.ev30) + ' events / 30d' });
      rel.appendChild(tip);
      var cr = c.getBoundingClientRect(), rr = rel.getBoundingClientRect();
      tip.style.left = Math.min(rr.width - 200, Math.max(0, cr.left - rr.left + cr.width / 2 + 12)) + 'px'; tip.style.top = Math.max(0, cr.top - rr.top - 6) + 'px';
    }
    function hide() { if (tip) { tip.remove(); tip = null; } }
    host.querySelectorAll('.bub').forEach(function (c) {
      c.addEventListener('mouseenter', function () { show(c); }); c.addEventListener('mouseleave', hide);
      c.addEventListener('focus', function () { show(c); }); c.addEventListener('blur', hide);
      c.addEventListener('click', function () { openFleet(c.dataset.fleet); });
      c.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openFleet(c.dataset.fleet); } });
    });
  }

  /* ---------- claims intelligence ---------- */
  function claimsStats() {
    var C = null, TT = state.P.totals || {}, inc = state.incidents.filter(function (i) { return i.category !== 'diagnostic' && i.camera; });
    var s = {};
    if (inc.length) {
      var ver = inc.filter(function (i) { return i.camera.verified && i.camera.aiVerdict !== 'false_positive'; }).length;
      var fp = inc.filter(function (i) { return i.camera.aiVerdict === 'false_positive'; }).length;
      var packets = inc.filter(function (i) { return i.camera.verified && i.camera.aiVerdict !== 'false_positive' && ((i.camera.clips || []).length || (i.camera.snapshots || []).length); }).length;
      var lat = inc.map(function (i) { return (new Date(i.receivedAt) - new Date(i.timestamp)) / 1000; }).filter(function (x) { return x >= 0 && isFinite(x); }).sort(function (a, b) { return a - b; });
      s = { n: inc.length, verified: ver, fp: fp, unverified: inc.length - ver - fp, packets: packets, ttfn: lat.length ? lat[Math.floor(lat.length / 2)] : null, derived: true };
    } else {
      var F = state.fleets, vp = wavg(F, function (f) { return f.ver; }, function (f) { return f.ev30; });
      var tot = F.reduce(function (a, f) { return a + (f.ev30 || 0); }, 0);
      if (vp != null) s = { n: tot, verified: Math.round(tot * vp / 100), fp: null, unverified: tot - Math.round(tot * vp / 100), packets: null, ttfn: null, derived: true };
    }
    if (TT.falsePositivesFiltered != null) s.fp = TT.falsePositivesFiltered;
    if (C) { ['verified', 'unverified', 'fp', 'packets', 'ttfn', 'n'].forEach(function (k) { var v = pick(C, k, { fp: 'falsePositive', packets: 'evidencePackets', ttfn: 'timeToFirstNoticeSec', n: 'total' }[k]); if (v != null) s[k] = v; }); s.derived = false; }
    return s;
  }
  function renderClaims() {
    var s = claimsStats();
    if (!s.n) { $('#claims').replaceChildren(NX.empty('No claims-relevant events yet')); return; }
    var T = s.n, p = function (x) { return T ? x / T * 100 : 0; };
    var ttfn = s.ttfn == null ? '—' : (s.ttfn < 90 ? Math.round(s.ttfn) + ' s' : fmt.duration(s.ttfn / 60));
    $('#claims-note').textContent = s.derived ? 'Computed from ' + fmt.number(T) + ' recent events' : '';
    $('#claims').innerHTML = '<div class="ins-claims">' +
      '<div class="ins-stat"><div class="nx-eyebrow">Camera-verified</div><div class="ins-stat__v">' + fmt.number(s.verified) + ' <span class="nx-dim" style="font-size:var(--nx-text-md)">' + p(s.verified).toFixed(0) + '%</span></div>' +
        '<div class="ins-stack"><i style="width:' + p(s.verified) + '%;--c:var(--nx-ok)"></i><i style="width:' + p(s.unverified || 0) + '%;--c:var(--nx-text-faint)"></i><i style="width:' + p(s.fp || 0) + '%;--c:var(--nx-warn)"></i></div>' +
        '<div class="ins-stat__s">' + fmt.number(s.unverified) + ' unverified' + (s.fp != null ? ' · ' + fmt.number(s.fp) + ' false positives screened out' : '') + '</div></div>' +
      '<div class="ins-stat"><div class="nx-eyebrow">False positives filtered</div><div class="ins-stat__v">' + (s.fp == null ? '—' : fmt.number(s.fp)) + '</div><div class="ins-stat__s">Events whose vendor verdict was a false positive. Nexus does not analyze video.</div></div>' +
      '<div class="ins-stat"><div class="nx-eyebrow">Evidence packets available</div><div class="ins-stat__v">' + (s.packets == null ? '—' : fmt.number(s.packets)) + '</div><div class="ins-stat__s">Verified events with video or snapshot attached</div></div>' +
      '<div class="ins-stat"><div class="nx-eyebrow">Median time to first notice</div><div class="ins-stat__v">' + ttfn + '</div><div class="ins-stat__s">Event occurrence to Nexus receipt</div></div></div>';
  }

  /* ---------- table ---------- */
  var ALLCOLS = [
    ['name', 'Policyholder', false], ['vendor', 'Vendor', false], ['vehicles', 'Vehicles', true], ['riskScore', 'Risk score', false], ['riskTier', 'Tier', false],
    ['ev100', 'Events /100 veh', true], ['coll', 'Collision rate', true], ['cam', 'Camera cov.', true], ['ver', 'Verified', true], ['cargo', 'Cargo exposure', true], ['loadPct', 'Avg load % max', true], ['trend', 'Trend', false], ['factors', 'Top risk factors', false]
  ];
  function renderFilters() {
    var vs = Array.from(new Set(state.fleets.map(function (f) { return f.vendor; }))), ts = distEntries().map(function (e) { return e[0]; });
    $('#f-vendor').innerHTML = '<option value="">All vendors</option>' + vs.map(function (v) { return '<option value="' + esc(v) + '">' + esc(vName(v)) + '</option>'; }).join('');
    $('#f-tier').innerHTML = '<option value="">All tiers</option>' + ts.map(function (t) { return '<option value="' + esc(t) + '">' + esc(fmt.label(t)) + '</option>'; }).join('');
    $('#f-vendor').value = state.vendor; $('#f-tier').value = state.tier;
  }
  function visibleFleets() {
    var q = state.q.toLowerCase(), k = state.sort.key, d = state.sort.dir;
    var rows = state.fleets.filter(function (f) {
      return (!state.vendor || f.vendor === state.vendor) && (!state.tier || f.riskTier === state.tier) && (!q || (f.name + ' ' + f.vendor + ' ' + (f.region || '')).toLowerCase().indexOf(q) > -1);
    });
    var tr = { up: 2, flat: 1, down: 0 };
    rows.sort(function (a, b) {
      var x = k === 'trend' ? tr[a.trend] : k === 'factors' ? (a.topRiskFactors || [])[0] : a[k], y = k === 'trend' ? tr[b.trend] : k === 'factors' ? (b.topRiskFactors || [])[0] : b[k];
      if (x == null) return 1; if (y == null) return -1;
      return (typeof x === 'string' ? x.localeCompare(y) : x - y) * d;
    });
    return rows;
  }
  function renderTable() {
    var rows = visibleFleets(), s = state.sort;
    var COLS = ALLCOLS.filter(function (c) { return (c[0] !== 'cargo' && c[0] !== 'loadPct') || state.fleets.some(function (f) { return f[c[0]] != null; }); });
    var head = COLS.map(function (c) { return '<th' + (c[2] ? ' class="num"' : '') + ' data-sort="' + c[0] + '"' + (s.key === c[0] ? ' class="is-sorted' + (s.dir > 0 ? ' asc' : '') + (c[2] ? ' num' : '') + '" aria-sort="' + (s.dir > 0 ? 'ascending' : 'descending') + '"' : '') + '>' + c[1] + '</th>'; }).join('');
    var body = rows.map(function (f, i) {
      return '<tr data-fleet="' + esc(f.id) + '" tabindex="0"><td class="name">' + esc(f.name) + '<small>' + (f.region ? esc(f.region) : '') + '</small></td><td>' + vendorChip(f.vendor) + '</td><td class="num">' + fmt.number(f.vehicles) + '</td><td>' + scoreBar(f.riskScore, f.riskTier) + '</td><td>' + tierHTML(f.riskTier, f.riskScore) + '</td>' +
        '<td class="num">' + (f.ev100 == null ? '—' : f.ev100.toFixed(1)) + '</td><td class="num">' + (f.coll == null ? '—' : f.coll.toFixed(1) + '%') + '</td><td class="num">' + (f.cam == null ? '—' : f.cam.toFixed(0) + '%') + '</td><td class="num">' + (f.ver == null ? '—' : f.ver.toFixed(0) + '%') + '</td>' + (COLS.some(function (c) { return c[0] === 'cargo'; }) ? '<td class="num">' + (f.cargo == null ? '—' : fmt.currency(f.cargo)) + '</td><td class="num">' + (f.loadPct == null ? '—' : f.loadPct.toFixed(0) + '%') + '</td>' : '') + '<td>' + trendHTML(f.trend) + '</td><td>' + chips(f.topRiskFactors, 3) + '</td></tr>';
    }).join('');
    $('#table').innerHTML = '<table class="nx-table"><thead><tr>' + head + '</tr></thead><tbody>' + (body || '<tr><td colspan="' + COLS.length + '" class="nx-dim" style="padding:var(--nx-sp-5);text-align:center">No policyholders match these filters.</td></tr>') + '</tbody></table>';
    renderDistActive();
  }
  function renderDistActive() { document.querySelectorAll('.ins-dist__row').forEach(function (r) { r.classList.toggle('is-active', r.querySelector('[data-tier]').dataset.tier === state.tier); }); }

  /* ---------- across vendors ---------- */
  function vendorRows() {
    var by = {}; (state.P.byVendor || []).forEach(function (v) { by[v.vendor] = Object.assign({}, v); });
    state.fleets.forEach(function (f) { by[f.vendor] = by[f.vendor] || { vendor: f.vendor }; });
    return Object.keys(by).map(function (k) {
      var v = by[k], fs = state.fleets.filter(function (f) { return f.vendor === k; });
      v.fleets = pick(v, 'fleets') != null && typeof v.fleets === 'number' ? v.fleets : fs.length;
      v.vehicles = fs.reduce(function (s, f) { return s + f.vehicles; }, 0);
      v.avgRisk = num(pick(v, 'avgRisk'), avg(fs.map(function (f) { return f.riskScore; })));
      v.ev100 = wavg(fs, function (f) { return f.ev100; }, function (f) { return f.vehicles; });
      v.coll = wavg(fs, function (f) { return f.coll; }, function (f) { return f.vehicles; });
      v.cam = wavg(fs, function (f) { return f.cam; }, function (f) { return f.vehicles; });
      v.ver = wavg(fs, function (f) { return f.ver; }, function (f) { return f.vehicles; });
      return v;
    }).sort(function (a, b) { return b.avgRisk - a.avgRisk; });
  }
  function dq(v) { return v == null ? '<span class="nx-faint">—</span>' : '<span class="ins-dq"><span class="nx-meter"><i style="width:' + v + '%;--c:' + (v >= 80 ? 'var(--nx-ok)' : v >= 55 ? 'var(--nx-warn)' : 'var(--nx-sev-high)') + '"></i></span><span class="nx-mono">' + v.toFixed(0) + '%</span></span>'; }
  function renderVendors() {
    var rows = vendorRows(); if (!rows.length) { $('#vendors').replaceChildren(NX.empty('No vendor data')); return; }
    var maxR = Math.max.apply(null, rows.map(function (r) { return r.avgRisk || 0; }).concat([1])), top = rows[0], low = rows[rows.length - 1];
    var weak = rows.filter(function (r) { return r.cam != null; }).sort(function (a, b) { return a.cam - b.cam; })[0];
    var call = '<div class="ins-vcallout"><b>Equal footing.</b> Every vendor feed is mapped to one event schema and scored by one model, so ' + esc(vName(top.vendor)) + ' fleets (avg risk ' + top.avgRisk.toFixed(0) + ') compare directly with ' + esc(vName(low.vendor)) + ' fleets (' + low.avgRisk.toFixed(0) + '). ' +
      (weak ? 'Data quality still varies: ' + esc(vName(weak.vendor)) + ' fleets have the thinnest camera coverage (' + weak.cam.toFixed(0) + '%), so their scores carry more uncertainty and fewer events can be proven.' : '') + '</div>';
    var tr = rows.map(function (r) {
      return '<tr><td>' + vendorChip(r.vendor) + '</td><td class="num">' + r.fleets + '</td><td class="num">' + fmt.number(r.vehicles) + '</td><td><span class="ins-scorebar"><span class="ins-score">' + (r.avgRisk == null ? '—' : r.avgRisk.toFixed(0)) + '</span><span class="nx-meter"><i style="width:' + ((r.avgRisk || 0) / maxR * 100) + '%;--c:' + vColor(r.vendor) + '"></i></span></span></td><td class="num">' + (r.ev100 == null ? '—' : r.ev100.toFixed(1)) + '</td><td class="num">' + (r.coll == null ? '—' : r.coll.toFixed(1) + '%') + '</td><td>' + dq(r.cam) + '</td><td>' + dq(r.ver) + '</td></tr>';
    }).join('');
    $('#vendors').innerHTML = call + '<div class="nx-table-wrap"><table class="nx-table"><thead><tr><th>Vendor</th><th class="num">Fleets</th><th class="num">Vehicles</th><th>Avg risk</th><th class="num">Events /100 veh</th><th class="num">Collision rate</th><th>Camera coverage</th><th>Verified events</th></tr></thead><tbody>' + tr + '</tbody></table></div><p class="nx-dim ins-note" style="margin:var(--nx-sp-3) 0 0">Data-quality columns show how much of each vendor’s event stream is camera-backed and independently verified. Vehicle-weighted.</p>';
  }

  /* ---------- CSV ---------- */
  function csv() {
    var cols = ['Policyholder', 'Vendor', 'Vehicles', 'Risk score', 'Tier', 'Events per 100 vehicles (30d)', 'Collision rate %', 'Camera coverage %', 'Verified event %', 'Cargo exposure USD', 'Avg load % of max', 'Trend', 'Top risk factors'];
    var q = function (v) { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    var lines = [cols.join(',')].concat(visibleFleets().map(function (f) {
      return [f.name, vName(f.vendor), f.vehicles, f.riskScore, f.riskTier, f.ev100, f.coll, f.cam, f.ver, f.cargo, f.loadPct, f.trend, (f.topRiskFactors || []).join('; ')].map(q).join(',');
    }));
    dl('nexus-portfolio-' + new Date().toISOString().slice(0, 10) + '.csv', lines.join('\n'));
    NX.toast('Exported ' + (lines.length - 1) + ' policyholders', 'success');
  }

  /* ---------- deep dive ---------- */
  function openFleet(id) { location.hash = '#' + encodeURIComponent(id); }
  function route() {
    var id = decodeURIComponent(location.hash.slice(1));
    var p = $('#view-portfolio'), d = $('#view-dive');
    var v3 = window.INS_V3;
    if (v3) { v3.hide(); v3.nav(id); if (v3.match(id)) { p.hidden = true; d.hidden = true; window.scrollTo(0, 0); $('#main').scrollTop = 0; v3.route(id); return; } }
    if (!id || id === 'portfolio') { p.hidden = false; d.hidden = true; document.title = 'Nexus Response — Insurer Portfolio'; return; }
    p.hidden = true; d.hidden = false; window.scrollTo(0, 0); $('#main').scrollTop = 0;
    d.replaceChildren(NX.skeleton(5));
    NX.api('/api/insurer/fleets/' + encodeURIComponent(id)).then(function (data) { if (decodeURIComponent(location.hash.slice(1)) === id) renderDive(id, data); })
      .catch(function (e) { d.innerHTML = '<button class="nx-btn nx-btn--ghost ins-back" data-back>← Portfolio</button><div class="nx-card nx-card--alert"><div class="nx-card__body"><b>Could not load policyholder.</b> ' + esc(e.message || 'The request failed.') + ' <button class="nx-btn nx-btn--sm" type="button" data-retry>Retry</button></div></div>'; });
  }

  var SHORT = { collisions: 'Collisions', harsh_events: 'Harsh', speeding: 'Speeding', distraction: 'Distraction', maintenance: 'Maint./DTC' };
  function radar(dims) {
    var n = dims.length, cx = 120, cy = 118, R = 84, pt = function (i, v) { var a = -Math.PI / 2 + i * 2 * Math.PI / n; return [cx + Math.cos(a) * R * v / 100, cy + Math.sin(a) * R * v / 100]; };
    var rings = [25, 50, 75, 100].map(function (v) { return '<polygon class="ring" points="' + dims.map(function (_, i) { return pt(i, v).join(','); }).join(' ') + '"/>'; }).join('');
    var spokes = dims.map(function (_, i) { var p = pt(i, 100); return '<line class="spoke" x1="' + cx + '" y1="' + cy + '" x2="' + p[0] + '" y2="' + p[1] + '"/>'; }).join('');
    var labels = dims.map(function (d, i) { var p = pt(i, 122); return '<text x="' + p[0] + '" y="' + (p[1] + 3) + '" text-anchor="' + (p[0] < cx - 8 ? 'end' : p[0] > cx + 8 ? 'start' : 'middle') + '">' + esc(SHORT[d.key] || d.label) + '</text>'; }).join('');
    var hasB = dims.every(function (d) { return d.bench != null; });
    return '<svg class="ins-svg ins-radar" viewBox="-30 0 300 236" role="img" aria-label="Radar chart of score breakdown">' + rings + spokes +
      (hasB ? '<polygon class="b" points="' + dims.map(function (d, i) { return pt(i, d.bench).join(','); }).join(' ') + '"/>' : '') +
      '<polygon class="f" points="' + dims.map(function (d, i) { return pt(i, d.value).join(','); }).join(' ') + '"/>' + labels + '</svg>';
  }
  function incidentHTML(i) {
    var sig = i.signals || [], fp = i.aiVerdict === 'false_positive';
    return '<div class="ins-ev__item"><div class="ins-ev__head">' + NX.badgeHTML(i.severity) + '<b>' + esc(fmt.label(i.eventType)) + '</b>' + (fp ? NX.badgeHTML('False positive', 'warn') : NX.badgeHTML('Camera verified', 'ok')) +
      '<span class="nx-mono nx-dim" style="margin-left:auto">' + esc(i.id) + ' <button class="nx-btn nx-btn--sm nx-btn--ghost nx-no-print" data-share="incident:' + esc(i.id) + '" type="button">Share</button></span></div><div class="ins-ev__row">' +
      (i.snapshot ? '<img class="ins-ev__img" loading="lazy" alt="Camera frame for ' + esc(i.id) + '" src="' + esc(i.snapshot) + '">' : '') + '<div>' +
      '<div class="ins-note nx-dim">' + esc(fmt.dateTime(i.timestamp)) + (i.address ? ' · ' + esc(i.address) : '') + (i.driver ? ' · ' + esc(i.driver) : '') + (i.vehicle ? ' · ' + esc(i.vehicle) : '') + '</div>' +
      (i.aiVerdict ? '<div style="margin-top:6px;font-size:var(--nx-text-sm)">Vendor verdict: <b>' + esc(fmt.label(i.aiVerdict)) + '</b>' + (i.confidence != null ? ' at ' + Math.round(i.confidence * 100) + '% confidence' : '') + '</div>' : '') +
      (sig.length ? '<ul class="ins-ev__sig">' + sig.slice(0, 4).map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ul>' : '') + '</div></div>' +
      '<div class="ins-ev__load" data-load-for="' + esc(i.id) + '">' + loadHTML(i) + '</div><div class="ins-ev__meta"><span>Video clip: ' + (i.clip ? 'yes' : 'no') + '</span><span>Snapshot: ' + (i.snapshot ? 'yes' : 'no') + '</span><span>Evidence packet: ' + (i.clip || i.snapshot ? 'available' : 'not available') + '</span></div></div>';
  }
  function improvements(D, f) {
    var out = [];
    (D.scoreBreakdown || []).forEach(function (b) {
      if (b.ratePer100Veh > b.portfolioRatePer100Veh && b.ratePer100Veh > 0) {
        var gain = b.contribution * (1 - b.portfolioRatePer100Veh / b.ratePer100Veh);
        out.push({ action: 'Bring ' + b.label.toLowerCase() + ' down to the portfolio rate', detail: b.ratePer100Veh + ' to ' + b.portfolioRatePer100Veh + ' per 100 vehicles over 30 days (' + b.count + ' events now).', gain: gain });
      }
    });
    out.sort(function (a, b) { return b.gain - a.gain; });
    out = out.slice(0, 3);
    if (f.cam != null && f.cam < 70) out.push({ action: 'Extend camera coverage beyond ' + f.cam.toFixed(0) + '% of vehicles', detail: 'More events can be verified, so fewer are scored on telematics alone and claims can be backed by footage.', gain: null });
    if (f.ver != null && f.ver < 60) out.push({ action: 'Raise camera-verified event share (now ' + f.ver.toFixed(0) + '%)', detail: 'Unverified events carry less weight in pricing and are harder to defend in a claim.', gain: null });
    return out;
  }

  function loadHTML(i) {
    var L = i.load, E = i.equipment, T = E && E.trailer;
    if (!L && !T) return '';
    var c = (L && L.contents) || {}, bits = [];
    var verified = T && T.cameraVerified || (L && L.cameraVisual && L.cameraVisual.cargoVisible);
    if (T && T.attached !== false && T.type && T.type !== 'none') bits.push('<span><b>Trailer</b> ' + esc(fmt.label(T.type)) + (T.lengthFt ? ' ' + T.lengthFt + ' ft' : '') + '</span>');
    if (L && L.estimatedWeightLb != null) bits.push('<span><b>Est. load</b> ' + fmt.number(L.estimatedWeightLb) + ' lb' + (L.payloadPctOfMax != null ? ' (' + Math.round(L.payloadPctOfMax) + '% of max)' : '') + '</span>');
    if (c.label || c.category) bits.push('<span><b>Content</b> ' + esc(c.label || fmt.label(c.category)) + '</span>');
    if (c.estimatedValueUsd && c.estimatedValueUsd.length) bits.push('<span><b>Value</b> ' + fmt.currency(c.estimatedValueUsd[0]) + '–' + fmt.currency(c.estimatedValueUsd[1]) + '</span>');
    var flags = (c.hazmat ? NX.badgeHTML('Hazmat', 'danger') : '') + (c.temperatureSensitive ? NX.badgeHTML('Temperature sensitive', 'info') : '') + (L && L.overweightRisk ? NX.badgeHTML('Overweight risk', 'warn') : '') +
      (verified ? NX.badgeHTML('Trailer/load camera-verified', 'ok') : NX.badgeHTML('Inferred, not camera-verified', 'plain'));
    var ev = (T && T.cameraBasis) || (L && L.cameraVisual && L.cameraVisual.description) || '';
    return '<div class="ins-load"><div class="nx-eyebrow">Load and trailer evidence</div><div class="ins-load__bits">' + bits.join('') + '</div><div class="ins-chips" style="margin-top:6px">' + flags + '</div>' +
      (ev ? '<div class="ins-note nx-dim" style="margin-top:4px">Camera: ' + esc(ev) + '</div>' : '') + (L && L.confidence != null ? '<div class="ins-note nx-faint">Estimate confidence ' + Math.round(L.confidence * 100) + '%' + (L.method ? ' · ' + esc(fmt.label(L.method)) : '') + '</div>' : '') + '</div>';
  }
  function hydrateLoads(incs) {
    incs.slice(0, 6).forEach(function (i) {
      if (i.load || i.equipment) return;
      NX.api('/api/incidents/' + encodeURIComponent(i.id) + '/context').then(function (ctx) {
        if (!ctx || (!ctx.load && !ctx.equipment)) return;
        i.load = ctx.load; i.equipment = ctx.equipment;
        var slot = document.querySelector('[data-load-for="' + i.id + '"]'); if (slot) slot.innerHTML = loadHTML(i);
      }).catch(function () { /* optional */ });
    });
  }
  function cargoSection(D) {
    var C = D.cargoExposure;
    var why = '<div class="ins-why"><b>Why load context matters to underwriting.</b> Cargo value and weight drive two separate exposures. Inland-marine and cargo coverage depends on what was being hauled, its value and whether it is temperature sensitive. Liability severity rises with gross weight, hazmat content and shifting-load risk. Nexus infers load from the last stop, trailer type and engine-load and fuel-economy change, then checks it against camera evidence of the trailer and cargo. An independent record of what was on the truck is hard to inflate after the fact, which reduces cargo-claim fraud.</div>';
    if (!C) return '<section class="nx-card ins-span2"><div class="nx-card__head"><h2 class="nx-card__title">Cargo exposure</h2></div><div class="nx-card__body"><p class="nx-dim">No cargo exposure data reported for this policyholder yet.</p>' + why + '</div></section>';
    var bc = (C.byContent || []).slice().sort(function (a, b) { return (b.estValueUsd || 0) - (a.estValueUsd || 0); }), max = Math.max.apply(null, bc.map(function (x) { return x.estValueUsd || 0; }).concat([1]));
    var avgPct = (state.fleets.filter(function (f) { return f.id === (D.fleet && D.fleet.id); })[0] || {}).loadPct;
    var stat = function (l, v, sub, warn) { return '<div class="ins-stat"><div class="nx-eyebrow">' + l + '</div><div class="ins-stat__v"' + (warn ? ' style="color:var(--nx-sev-high)"' : '') + '>' + v + '</div>' + (sub ? '<div class="ins-stat__s">' + sub + '</div>' : '') + '</div>'; };
    var over = avgPct != null && avgPct > 90;
    return '<section class="nx-card ins-span2"><div class="nx-card__head"><h2 class="nx-card__title">Cargo exposure</h2><span class="nx-dim ins-note">Estimated from load inference; see confidence on each incident</span></div><div class="nx-card__body">' +
      '<div class="ins-claims">' + stat('Est. cargo exposure', fmt.currency(C.totalEstCargoExposureUsd), 'across recent events') + stat('Hazmat events', fmt.number(C.hazmatEvents), 'higher liability severity', C.hazmatEvents > 0) + stat('Perishable events', fmt.number(C.perishableEvents), 'spoilage clock on loss') + stat('High-value events', fmt.number(C.highValueEvents), 'theft and total-loss exposure') + '</div>' +
      '<div class="ins-claims ins-gap2">' + stat('Average load', C.avgLoadLb != null ? fmt.number(C.avgLoadLb) + ' lb' : '—', avgPct != null ? Math.round(avgPct) + '% of max payload' : '') + stat('Overweight signal', over ? 'Elevated' : avgPct != null ? 'Normal' : '—', over ? 'Average load above 90% of max payload' : 'Average load within payload limits', over) + '</div>' +
      '<h3 class="nx-eyebrow" style="margin:var(--nx-sp-4) 0 var(--nx-sp-2)">Exposure by cargo type</h3>' +
      (bc.length ? '<div class="ins-bars">' + bc.map(function (x) { return '<div class="ins-bar ins-bar--wide"><span>' + esc(fmt.label(x.category)) + '</span><span class="ins-bar__track"><span class="ins-bar__fill" style="width:' + ((x.estValueUsd || 0) / max * 100) + '%;--c:' + (/hazmat/.test(x.category) ? 'var(--nx-sev-critical)' : 'var(--nx-accent)') + '"></span></span><span class="nx-mono" style="text-align:right">' + fmt.currency(x.estValueUsd) + '<span class="nx-faint"> · ' + x.incidents + ' ev</span></span></div>'; }).join('') + '</div>' : '<span class="nx-dim">No load content identified.</span>') + why + '</div></section>';
  }
  function renderDive(id, D) {
    var base = state.fleets.filter(function (x) { return x.id === id; })[0] || {};
    var f = normFleet(Object.assign({}, base, D.fleet, D.kpis, { riskScore: D.riskScore, riskTier: D.riskTier, trend: D.trend }));
    var B = D.benchmark || {}, pr = D.pricingSignal || {}, adj = num(pr.suggestedPremiumAdjustmentPct);
    var dims = (D.scoreBreakdown || []).map(function (b) { return { key: b.key, label: b.label, value: Math.max(0, Math.min(100, b.score)), b: b }; });
    var incs = D.recentVerifiedIncidents || [], drivers = D.driversRanked || [], imps = improvements(D, f);
    var portfolioAvg = function (k) { return avg(state.fleets.map(function (x) { return x[k]; })); };
    var h = '<button class="nx-btn nx-btn--ghost nx-btn--sm ins-back nx-no-print" data-back type="button">← Portfolio</button>';
    h += '<div class="ins-subtabs nx-no-print"><a class="is-active" href="#' + esc(id) + '">Risk overview</a><a href="#' + esc(id) + '/drive">Nexus Drive Score</a></div>';
    h += '<div class="nx-page-head"><div><div class="nx-eyebrow">Policyholder deep dive</div><h1>' + esc(f.name) + '</h1><p>' + vendorChip(f.vendor) + ' · ' + fmt.number(f.vehicles) + ' vehicles' + (D.fleet.drivers ? ' · ' + fmt.number(D.fleet.drivers) + ' drivers' : '') + (D.fleet.region ? ' · ' + esc(D.fleet.region) : '') + '</p></div>' +
      '<div class="nx-row ins-actions nx-no-print"><button class="nx-btn" data-share="fleet:' + esc(id) + '" type="button">Share read-only link</button><button class="nx-btn" id="btn-print" type="button">Print / save PDF</button></div></div>';
    h += '<div class="nx-kpis"><div class="nx-kpi nx-kpi--accent"><div class="nx-kpi__label">Risk score</div><div class="nx-kpi__value">' + f.riskScore.toFixed(0) + '</div><div class="nx-kpi__delta">' + tierHTML(f.riskTier, f.riskScore) + ' ' + trendHTML(f.trend) + '</div></div>' +
      '<div class="nx-kpi"><div class="nx-kpi__label">Portfolio rank</div><div class="nx-kpi__value">' + (B.riskRank || '—') + ' / ' + (B.of || '—') + '</div><div class="nx-kpi__delta nx-dim">' + (B.riskRank && B.riskRank === B.of ? 'highest risk' : '1 = lowest risk') + '</div></div>' +
      '<div class="nx-kpi"><div class="nx-kpi__label">Events /100 vehicles</div><div class="nx-kpi__value">' + (f.ev100 == null ? '—' : f.ev100.toFixed(1)) + '</div><div class="nx-kpi__delta nx-dim">30 days</div></div>' +
      '<div class="nx-kpi"><div class="nx-kpi__label">Camera coverage</div><div class="nx-kpi__value">' + (f.cam == null ? '—' : f.cam.toFixed(0) + '%') + '</div></div>' +
      '<div class="nx-kpi"><div class="nx-kpi__label">Verified events</div><div class="nx-kpi__value">' + (f.ver == null ? '—' : f.ver.toFixed(0) + '%') + '</div><div class="nx-kpi__delta nx-dim">' + fmt.number((D.kpis || {}).falsePositivesFiltered) + ' false positives filtered</div></div></div>';
    h += '<div class="ins-dive-grid">';
    var rl = pr.rationale || [];
    h += '<section class="nx-card"><div class="nx-card__head"><h2 class="nx-card__title">Illustrative pricing signal</h2>' + (pr.confidence ? '<span class="nx-dim ins-note">Confidence: ' + esc(pr.confidence) + '</span>' : '') + '</div><div class="nx-card__body">' +
      (adj == null ? '<span class="nx-dim">No pricing signal reported.</span>' : '<div class="ins-price"><span class="ins-price__v ' + (adj > 0 ? 'up' : adj < 0 ? 'down' : '') + '">' + signed(adj) + '</span><span class="nx-dim">illustrative premium adjustment' + (pr.estAdjustmentUsdPerMonth != null ? ' · about ' + fmt.currency(Math.abs(pr.estAdjustmentUsdPerMonth)) + ' / month on ' + fmt.currency(pr.estMonthlyPremiumUsd) : '') + '</span></div>') +
      (rl.length ? '<ul style="margin:var(--nx-sp-3) 0 0;padding-left:18px;font-size:var(--nx-text-sm)">' + rl.map(function (r) { return '<li style="margin-bottom:4px">' + esc(r) + '</li>'; }).join('') + '</ul>' : '') +
      '<p class="nx-faint ins-note" style="margin:var(--nx-sp-3) 0 0">Illustrative only; not a rate filing and not validated on real-world claims data.</p></div></section>';
    var bmRows = (B.metrics || []).map(function (m) { return { label: m.label, a: m.fleet, b: m.portfolio, d: m.deltaPct }; });
    h += '<section class="nx-card"><div class="nx-card__head"><h2 class="nx-card__title">Benchmark vs portfolio</h2><span class="nx-dim ins-note">Events per 100 vehicles, 30d · marker = portfolio</span></div><div class="nx-card__body"><div class="ins-bars">' +
      bmRows.map(function (r) {
        var max = Math.max(r.a, r.b, 1) * 1.25, better = r.a <= r.b;
        return '<div class="ins-bar"><span>' + esc(r.label) + '</span><span class="ins-bar__track"><span class="ins-bar__fill" style="width:' + (r.a / max * 100) + '%;--c:' + (better ? 'var(--nx-ok)' : 'var(--nx-sev-high)') + '"></span><span class="ins-bar__bench" style="left:' + (r.b / max * 100) + '%" title="Portfolio ' + r.b + '"></span></span><span class="nx-mono" style="text-align:right">' + r.a + '</span></div>';
      }).join('') + '</div><p class="nx-dim ins-note" style="margin:var(--nx-sp-3) 0 0">Risk score ' + f.riskScore.toFixed(0) + ' vs portfolio ' + (B.portfolioAvgRiskScore != null ? B.portfolioAvgRiskScore.toFixed(1) : '—') + ' (' + signed(B.riskScoreDelta, 1).replace('%', '') + ' pts). Camera coverage ' + pctTxt(f.cam) + ' vs ' + (portfolioAvg('cam') || 0).toFixed(0) + '% portfolio.</p></div></section>';
    h += '<section class="nx-card ins-span2"><div class="nx-card__head"><h2 class="nx-card__title">Score breakdown</h2><span class="nx-dim ins-note">Component score 0-100, higher = more risk · weighted into the overall score</span></div><div class="nx-card__body">' +
      (dims.length ? '<div class="ins-radar-wrap">' + radar(dims) + '<div class="ins-bars">' + dims.map(function (d) {
        return '<div><div class="ins-bar"><span>' + esc(d.label) + '</span><span class="ins-bar__track"><span class="ins-bar__fill" style="width:' + d.value + '%;--c:' + tierColor('', d.value * 0.7) + '"></span></span><span class="nx-mono" style="text-align:right">' + d.value.toFixed(0) + '</span></div><div class="nx-dim ins-note" style="margin-top:2px">' + d.b.ratePer100Veh + ' vs portfolio ' + d.b.portfolioRatePer100Veh + ' per 100 vehicles · ' + Math.round(d.b.weight * 100) + '% weight · adds ' + d.b.contribution + ' pts</div></div>';
      }).join('') + '</div></div>' : '<span class="nx-dim">No breakdown reported.</span>') + '</div></section>';
    h += cargoSection(D);
    h += '<section class="nx-card ins-span2"><div class="nx-card__head"><h2 class="nx-card__title">Camera-verified incidents</h2><span class="nx-dim ins-note">' + incs.length + ' most recent</span></div><div class="nx-card__body">' +
      '<div class="ins-fraud"><b>Camera evidence (synthetic).</b> Verdicts below were supplied with the demo event. Nexus does not analyze video. Frames, GPS trails and sensor signals are generated, and nothing was sent to a carrier.</div>' +
      (incs.length ? '<div class="ins-ev">' + incs.slice(0, 6).map(incidentHTML).join('') + '</div>' : '<span class="nx-dim">No recent verified incidents.</span>') + '</div></section>';
    h += '<section class="nx-card"><div class="nx-card__head"><h2 class="nx-card__title">Highest-risk drivers</h2></div><div class="nx-card__body nx-card--flush">' +
      (drivers.length ? '<div class="nx-table-wrap"><table class="nx-table"><thead><tr><th>#</th><th>Driver</th><th class="num">Safety score</th><th class="num">Events</th><th class="num">Collisions</th><th>Main behavior</th></tr></thead><tbody>' + drivers.slice(0, 8).map(function (d, i) {
        return '<tr><td class="nx-mono nx-dim">' + (i + 1) + '</td><td>' + esc(d.name) + '</td><td class="num">' + fmt.number(d.safetyScore) + '</td><td class="num">' + fmt.number(d.events30d) + '</td><td class="num">' + fmt.number(d.collisions30d) + '</td><td>' + (d.topBehavior ? '<span class="nx-chip nx-chip--static">' + esc(fmt.label(d.topBehavior)) + '</span>' : '—') + '</td></tr>';
      }).join('') + '</tbody></table></div>' : '<div style="padding:var(--nx-sp-4)" class="nx-dim">No driver ranking reported.</div>') + '</div></section>';
    h += '<section class="nx-card"><div class="nx-card__head"><h2 class="nx-card__title">What would improve this score</h2></div><div class="nx-card__body">' +
      (imps.length ? '<ul class="ins-improve">' + imps.map(function (m) {
        return '<li><span class="gain">' + (m.gain == null ? '•' : '−' + Math.max(1, Math.round(m.gain))) + '</span><span>' + esc(m.action) + '<br><span class="nx-dim ins-note">' + esc(m.detail) + '</span></span></li>';
      }).join('') + '</ul><p class="nx-faint ins-note" style="margin:var(--nx-sp-3) 0 0">Point estimates assume the component moves to the portfolio rate.</p>' : '<p class="nx-dim">No component is above the portfolio rate. Maintain current practice.</p>') + '</div></section>';
    h += '</div><p class="ins-print-only nx-faint ins-note" style="margin-top:16px">Generated by Nexus Response · ' + esc(fmt.dateTime(new Date())) + '</p>';
    $('#view-dive').innerHTML = h; document.title = f.name + ' — Nexus Response Insurer'; hydrateLoads(incs);
  }

  /* ---------- events ---------- */
  document.addEventListener('click', function (e) {
    var th = e.target.closest('#table th[data-sort]');
    if (th) { var k = th.dataset.sort, s = state.sort; state.sort = { key: k, dir: s.key === k ? -s.dir : (k === 'name' || k === 'vendor' ? 1 : -1) }; renderTable(); return; }
    var tr = e.target.closest('#table tr[data-fleet]'); if (tr) return openFleet(tr.dataset.fleet);
    if (e.target.closest('[data-back]')) { location.hash = '#portfolio'; }
    if (e.target.closest('#btn-print')) { var vv = e.target.closest('[data-printable]') || $('#view-dive'); vv.classList.add('ins-printing'); window.print(); setTimeout(function () { vv.classList.remove('ins-printing'); }, 500); }
    if (e.target.closest('#btn-csv')) csv();
  });
  document.addEventListener('keydown', function (e) { var tr = e.target.closest && e.target.closest('#table tr[data-fleet]'); if (tr && e.key === 'Enter') openFleet(tr.dataset.fleet); });
  $('#q').addEventListener('input', function (e) { state.q = e.target.value; renderTable(); });
  $('#f-vendor').addEventListener('change', function (e) { state.vendor = e.target.value; renderTable(); });
  $('#f-tier').addEventListener('change', function (e) { state.tier = e.target.value; renderDist(); renderTable(); });
  window.addEventListener('hashchange', route);
  document.addEventListener('nx:theme', function () { if (state.P && !$('#view-portfolio').hidden) renderScatter(); });

  window.INS = { state: state, num: num, pick: pick, pct: pct, pctTxt: pctTxt, signed: signed, avg: avg, vName: vName, vColor: vColor, vendorChip: vendorChip, tierHTML: tierHTML, tierColor: tierColor, trendHTML: trendHTML, chips: chips, dl: dl, normFleet: normFleet, $: $, openFleet: openFleet };
  load();
  NX.sse('/api/stream', function () { clearTimeout(load._t); load._t = setTimeout(function () { if (!location.hash) load(); }, 1500); }, { events: ['incident'] });
})();
