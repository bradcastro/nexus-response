/* Nexus Response — Records & History explorer. Vanilla JS, no build step.
   State lives in the URL hash:  #<tab>?q=..&fleet=a,b&range=30d&status=denied&offset=25&open=inc:inc_1
   Tabs: incidents | claims | risk | comms.  All data is synthetic demo data. */
(function () {
  'use strict';
  var el = NX.el, fmt = NX.fmt;
  var $ = function (s, r) { return (r || document).querySelector(s); };

  var TABS = [
    { id: 'incidents', label: 'Incidents', type: 'incident', noun: 'incidents' },
    { id: 'claims', label: 'Warranty claims', type: 'warranty_claim', noun: 'claims' },
    { id: 'risk', label: 'Risk history', noun: 'risk history' },
    { id: 'comms', label: 'Communications', type: 'comm', noun: 'communications' }
  ];
  var FILT = {
    incidents: ['fleet', 'range', 'status', 'category', 'severity', 'driver', 'vehicle'],
    claims: ['fleet', 'range', 'status', 'oem'],
    comms: ['fleet', 'range', 'status', 'category'],
    risk: ['fleet', 'range']
  };
  var FACET_TITLES = { status: 'Status', category: 'Category', severity: 'Severity', oem: 'OEM' };
  var CHIP_LABELS = { q: 'Search', status: 'Status', category: 'Category', severity: 'Severity', oem: 'OEM', driver: 'Driver', vehicle: 'Vehicle' };
  var RANGES = [['7d', 'Last 7 days', 7], ['30d', 'Last 30 days', 30], ['90d', 'Last 90 days', 90], ['ytd', 'Year to date'], ['all', 'All time'], ['custom', 'Custom']];
  var METRICS = [
    { id: 'riskScore', label: 'Risk score' }, { id: 'eventsPer1kMi', label: 'Events per 1k mi' }, { id: 'collisions', label: 'Collisions' },
    { id: 'cameraVerifiedShare', label: 'Camera-verified share' }, { id: 'driveScore', label: 'Drive Score' }
  ];
  var STV = { ready: 'pending', more_info_needed: 'warn', submitted: 'pending', under_review: 'validating', in_review: 'validating', approved: 'resolved', partially_approved: 'warn', paid: 'ok', denied: 'danger', appealed: 'warn', closed: 'dismissed', sent: 'ok', delivered: 'ok', failed: 'danger', queued: 'pending' };
  var VIEWS_KEY = 'nx-records-views';

  var S = { tab: 'incidents', p: {} };
  var ctx = { fleets: [], fleetsState: 'idle', entities: {}, data: null, facets: {}, summary: null, state: 'idle', err: null, key: null, seq: 0, risk: null, riskState: 'idle', riskErr: null, riskKey: null, tableView: false, lastHash: '', drawerKey: null };

  /* ------------------------------ utils ------------------------------ */
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
  function ymd(d) { return d.toISOString().slice(0, 10); }
  function dash(v) { return v == null || v === '' ? '—' : v; }
  function redact(s) { return String(s == null ? '' : s).replace(/\+?\d[\d\s().-]{8,}\d/g, '[phone removed]'); }
  function csvList(s) { return s ? String(s).split(',').filter(Boolean) : []; }
  function tabDef(id) { return TABS.filter(function (t) { return t.id === id; })[0] || TABS[0]; }
  function money(v) { return v == null ? '—' : fmt.currency(v); }
  function statusBadge(v) {
    if (v == null || v === '') return document.createTextNode('—');
    if (v === 'simulated') return NX.badge('simulated');
    var m = /^(.*) \(simulated\)$/.exec(String(v));
    if (m) return el('span.nx-row', { style: { gap: '6px', flexWrap: 'wrap' } }, statusBadge(m[1]), NX.badge('simulated'));
    return NX.badge(v, STV[v] || (NX.statuses.indexOf(v) > -1 ? v : 'plain'));
  }
  function sevBadge(v) { return v ? NX.badge(v, NX.severities.indexOf(v) > -1 ? v : 'plain') : document.createTextNode('—'); }
  function fleetName(id) { var fl = ctx.facets && ctx.facets.fleetLabels; if (fl && fl[id]) return fl[id]; var f = ctx.fleets.filter(function (x) { return x.id === id; })[0]; return f ? f.name : id; }
  function normList(r) { return Array.isArray(r) ? r : (r && (r.entities || r.results || r.items || r.fleets)) || []; }

  /* ------------------------------ URL state ------------------------------ */
  function parseHash() {
    var raw = location.hash.replace(/^#/, ''), i = raw.indexOf('?');
    var tab = (i < 0 ? raw : raw.slice(0, i)).replace(/\/$/, ''), p = {};
    if (i >= 0) raw.slice(i + 1).split('&').forEach(function (kv) {
      if (!kv) return; var j = kv.indexOf('='), k = decodeURIComponent(kv.slice(0, j < 0 ? undefined : j)), v = j < 0 ? '' : decodeURIComponent(kv.slice(j + 1).replace(/\+/g, ' '));
      if (v !== '') p[k] = v;
    });
    if (!TABS.some(function (t) { return t.id === tab; })) tab = 'incidents';
    return { tab: tab, p: p };
  }
  function buildHash(tab, p) {
    var q = Object.keys(p).filter(function (k) { return p[k] !== '' && p[k] != null; }).sort().map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(p[k]); }).join('&');
    return '#' + tab + (q ? '?' + q : '');
  }
  function writeUrl(replace) {
    var h = buildHash(S.tab, S.p);
    ctx.lastHash = h;
    if (h === location.hash) return;
    try { history[replace ? 'replaceState' : 'pushState'](null, '', location.pathname + location.search + h); } catch (e) { location.hash = h; }
  }
  // patch: {key: value|null}. Resets paging unless only paging/open keys change.
  function go(patch, opt) {
    opt = opt || {};
    var resets = false;
    Object.keys(patch).forEach(function (k) {
      var v = patch[k];
      if (v == null || v === '') delete S.p[k]; else S.p[k] = String(v);
      if (k !== 'offset' && k !== 'open' && k !== 'limit') resets = true;
    });
    if (resets && !('offset' in patch)) delete S.p.offset;
    writeUrl(opt.replace);
    render();
  }
  function goTab(id) {
    var keep = {}; ['q', 'fleet', 'range', 'from', 'to'].forEach(function (k) { if (S.p[k]) keep[k] = S.p[k]; });
    S.tab = id; S.p = keep; writeUrl(); render();
  }
  function onUrlChange() {
    if (location.hash === ctx.lastHash && ctx.lastHash) return;
    var st = parseHash(); S.tab = st.tab; S.p = st.p; ctx.lastHash = buildHash(S.tab, S.p); render();
  }

  /* ------------------------------ queries ------------------------------ */
  function dateRange(p) {
    var r = p.range || 'all', now = new Date(), out = {};
    var preset = RANGES.filter(function (x) { return x[0] === r; })[0];
    if (r === 'custom') { if (p.from) out.from = p.from; if (p.to) out.to = p.to; }
    else if (r === 'ytd') out.from = now.getFullYear() + '-01-01';
    else if (preset && preset[2]) out.from = ymd(new Date(now.getTime() - preset[2] * 864e5));
    return out;
  }
  function baseQuery() {
    var allowed = FILT[S.tab], p = S.p, q = {};
    if (p.q) q.q = p.q;
    if (allowed.indexOf('fleet') > -1 && p.fleet) q.fleetId = p.fleet;
    var dr = dateRange(p); if (dr.from) q.from = dr.from; if (dr.to) q.to = dr.to;
    ['status', 'category', 'severity', 'oem'].forEach(function (k) { if (allowed.indexOf(k) > -1 && p[k]) q[k] = p[k]; });
    if (allowed.indexOf('vehicle') > -1 && p.vehicle) q.vehicleId = p.vehicle;
    if (allowed.indexOf('driver') > -1 && p.driver) q.driverId = p.driver;
    return q;
  }
  function limit() { return Math.min(200, Math.max(5, parseInt(S.p.limit, 10) || 25)); }
  function offset() { return Math.max(0, parseInt(S.p.offset, 10) || 0); }
  function listQuery() {
    var q = baseQuery(); q.limit = limit(); q.offset = offset();
    if (S.p.sort) { q.sort = S.p.sort; q.dir = S.p.dir === 'asc' ? 'asc' : 'desc'; }
    return q;
  }
  function riskParams() {
    var p = S.p; return { scope: p.scope || 'portfolio', entity: p.entity || '', bucket: p.bucket || 'week', metrics: csvList(p.metrics || 'riskScore,eventsPer1kMi'), compare: csvList(p.compare) };
  }

  /* ------------------------------ data loading ------------------------------ */
  function loadFleets() {
    if (ctx.fleetsState !== 'idle') return;
    ctx.fleetsState = 'loading';
    NX.api('/api/fleets').then(function (r) { ctx.fleets = normList(r).map(function (f) { return { id: f.id, name: f.name || f.id }; }); ctx.fleetsState = 'ready'; renderFilters(); renderChips(); if (S.tab === 'risk') renderRisk(); })
      .catch(function () { ctx.fleetsState = 'error'; });
  }
  function loadEntities(scope, cb) {
    var key = scope + '|' + (S.p.fleet || '');
    if (ctx.entities[key] && ctx.entities[key].state === 'ready') return cb && cb(ctx.entities[key].list);
    if (ctx.entities[key] && ctx.entities[key].state === 'loading') return;
    ctx.entities[key] = { state: 'loading', list: [] };
    NX.api('/api/records/entities', { query: { scope: scope, fleetId: csvList(S.p.fleet).length === 1 ? S.p.fleet : null, limit: 1000 } }).then(function (r) {
      var fset = csvList(S.p.fleet);
      ctx.entities[key] = { state: 'ready', list: normList(r).filter(function (e) { return fset.length < 2 || fset.indexOf(e.fleetId) > -1; }).map(function (e) { return { id: e.id, name: e.name || e.id, fleetId: e.fleetId }; }) };
      renderFilters(); if (S.tab === 'risk') renderRisk();
    }).catch(function () { ctx.entities[key] = { state: 'error', list: [] }; renderFilters(); if (S.tab === 'risk') renderRisk(); });
  }
  function entitiesFor(scope) {
    if (scope === 'fleet') return ctx.fleets;
    var e = ctx.entities[scope + '|' + (S.p.fleet || '')];
    return e ? e.list : [];
  }
  function entityLabel(scope, id) {
    var l = entitiesFor(scope).filter(function (e) { return e.id === id; })[0];
    return l ? l.name : id;
  }

  // Backend accepts a single fleetId, so multi-fleet selections fan out one request per fleet and merge client-side.
  var SEVRANK = { critical: 4, high: 3, medium: 2, low: 1 };
  function sumMaps(a, b) { var o = Object.assign({}, a || {}); Object.keys(b || {}).forEach(function (k) { o[k] = typeof b[k] === 'number' ? (o[k] || 0) + b[k] : b[k]; }); return o; }
  function fetchList(path, q, extra) {
    var fl = csvList(q.fleetId);
    if (fl.length <= 1) return NX.api(path, { query: Object.assign({}, extra, q) });
    var off = +q.offset || 0, lim = +q.limit || 25, key = q.sort || 'timestamp', dir = q.dir === 'asc' ? 1 : -1;
    return Promise.all(fl.map(function (f) { return NX.api(path, { query: Object.assign({}, extra, q, { fleetId: f, offset: 0, limit: Math.min(1000, off + lim) }) }); })).then(function (rs) {
      var all = []; rs.forEach(function (r) { all = all.concat(r.results || []); });
      var kv = function (r) { var v = r[key]; if (key === 'id' && r.claimId) v = r.claimId; return key === 'severity' ? (SEVRANK[v] || 0) : v; };
      all.sort(function (a, b) { var x = kv(a), y = kv(b); if (x == null) return 1; if (y == null) return -1; return (x > y ? 1 : x < y ? -1 : 0) * dir; });
      var out = { total: 0, results: all.slice(off, off + lim), facets: {}, meta: rs[0].meta };
      if (rs[0].type) out.type = rs[0].type;
      rs.forEach(function (r) { out.total += r.total || 0; Object.keys(r.facets || {}).forEach(function (k) { out.facets[k] = sumMaps(out.facets[k], r.facets[k]); }); });
      if (rs[0].summary) {
        var sm = { count: 0, byStatus: {}, openCount: 0, estimatedTotal: 0, approvedTotal: 0, recoveredTotal: 0, decidedCount: 0, medianDaysToDecision: null, basis: rs[0].summary.basis }, wr = 0;
        rs.forEach(function (r) { var x = r.summary || {}; sm.count += x.count || 0; sm.byStatus = sumMaps(sm.byStatus, x.byStatus); ['openCount', 'estimatedTotal', 'approvedTotal', 'recoveredTotal', 'decidedCount'].forEach(function (k) { sm[k] += x[k] || 0; }); wr += (x.approvalRate || 0) * (x.decidedCount || 0); });
        sm.approvalRate = sm.decidedCount ? wr / sm.decidedCount : null; sm.mergedClientSide = true;
        out.summary = sm;
      }
      return out;
    });
  }

  function load(force) {
    var tab = S.tab;
    if (tab === 'risk') return loadRisk(force);
    var q = listQuery(), key = tab + JSON.stringify(q);
    if (!force && key === ctx.key) return;
    ctx.key = key; var seq = ++ctx.seq;
    ctx.state = 'loading'; ctx.err = null;
    renderBody();
    var def = tabDef(tab);
    var main = tab === 'claims' ? fetchList('/api/records/claims', q) : fetchList('/api/records/search', q, { type: def.type });
    var facetReq = Promise.resolve(null);
    Promise.all([main, facetReq]).then(function (res) {
      if (seq !== ctx.seq) return;
      var d = res[0];
      ctx.data = d; ctx.dataTab = tab;
      ctx.summary = d.summary || null;
      ctx.facets = d.facets || (res[1] && res[1].facets) || {};
      if (tab === 'claims' && d.summary && d.summary.byStatus && !(ctx.facets.status && Object.keys(ctx.facets.status).length)) ctx.facets = Object.assign({}, ctx.facets, { status: d.summary.byStatus });
      if (tab === 'claims' && res[1] && res[1].facets && res[1].facets.oem) ctx.facets = Object.assign({}, ctx.facets, { oem: res[1].facets.oem });
      ctx.state = 'ready'; renderFilters(); renderBody();
    }).catch(function (err) {
      if (seq !== ctx.seq) return;
      ctx.state = 'error'; ctx.err = err.message || 'Request failed'; renderBody();
    });
  }
  function loadRisk(force) {
    var r = riskParams(), dr = dateRange(S.p);
    if (r.scope !== 'portfolio' && !r.entity) { ctx.riskState = 'needs'; ctx.riskKey = null; ctx.seq++; renderBody(); return; }
    var q = { scope: r.scope, id: r.scope === 'portfolio' ? undefined : r.entity, bucket: r.bucket, from: dr.from, to: dr.to, metrics: r.metrics.join(','), compareIds: r.scope === 'portfolio' ? undefined : r.compare.join(',') };
    var key = JSON.stringify(q);
    if (!force && key === ctx.riskKey) return;
    ctx.riskKey = key; var seq = ++ctx.seq;
    ctx.riskState = 'loading'; ctx.riskErr = null; renderBody();
    NX.api('/api/records/risk-history', { query: q }).then(function (d) {
      if (seq !== ctx.seq) return; ctx.risk = d; ctx.riskState = 'ready'; renderBody();
    }).catch(function (err) { if (seq !== ctx.seq) return; ctx.riskState = 'error'; ctx.riskErr = err.message || 'Request failed'; renderBody(); });
  }

  /* ------------------------------ render: shell ------------------------------ */
  function render() {
    renderTabs(); renderFilters(); renderChips();
    var q = $('#rec-q'); if (q && document.activeElement !== q) q.value = S.p.q || '';
    $('#rec-filter-count').textContent = activeChips().length ? ' (' + activeChips().length + ')' : '';
    load(false);
    if (S.tab !== 'risk' && ctx.dataTab !== S.tab) renderBody();
    syncDrawer();
    document.title = 'Records & history: ' + tabDef(S.tab).label + ' — Nexus Response';
  }
  function renderTabs() {
    var root = $('#rec-tabs');
    root.textContent = '';
    TABS.forEach(function (t) {
      var on = t.id === S.tab;
      root.appendChild(el('button.nx-tab', { type: 'button', role: 'tab', id: 'tab-' + t.id, 'aria-selected': on, tabindex: on ? '0' : '-1', class: on ? 'is-active' : '', onclick: function () { if (!on) goTab(t.id); },
        onkeydown: function (e) {
          var i = TABS.indexOf(t), n = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : null;
          if (n == null) return; e.preventDefault(); goTab(TABS[(n + TABS.length) % TABS.length].id);
          setTimeout(function () { var b = $('#tab-' + S.tab); if (b) b.focus(); }, 0);
        } }, t.label));
    });
    $('#rec-content').setAttribute('role', 'tabpanel'); $('#rec-content').setAttribute('aria-labelledby', 'tab-' + S.tab);
  }

  /* ------------------------------ filters ------------------------------ */
  function activeChips() {
    var chips = [], p = S.p, allowed = FILT[S.tab];
    if (p.q) chips.push({ k: 'q', label: 'Search: ' + p.q });
    if (p.fleet && allowed.indexOf('fleet') > -1) csvList(p.fleet).forEach(function (id) { chips.push({ k: 'fleet', v: id, label: 'Fleet: ' + fleetName(id) }); });
    if (p.range && p.range !== 'all') {
      var r = RANGES.filter(function (x) { return x[0] === p.range; })[0];
      chips.push({ k: 'range', label: p.range === 'custom' ? 'Dates: ' + (p.from || '…') + ' to ' + (p.to || '…') : (r ? r[1] : p.range), clear: ['range', 'from', 'to'] });
    }
    ['status', 'category', 'severity', 'oem'].forEach(function (k) { if (p[k] && allowed.indexOf(k) > -1) chips.push({ k: k, label: CHIP_LABELS[k] + ': ' + fmt.label(p[k]) }); });
    if (p.driver && allowed.indexOf('driver') > -1) chips.push({ k: 'driver', label: 'Driver: ' + (lookupName('driver', p.driver)) });
    if (p.vehicle && allowed.indexOf('vehicle') > -1) chips.push({ k: 'vehicle', label: 'Vehicle: ' + (lookupName('vehicle', p.vehicle)) });
    return chips;
  }
  function lookupName(scope, id) { return entityLabel(scope, id); }
  function renderChips() {
    var root = $('#rec-chips'); root.textContent = '';
    var chips = activeChips(); if (!chips.length) return;
    chips.forEach(function (c) {
      root.appendChild(el('span.rec-chip', c.label, el('button', { type: 'button', 'aria-label': 'Remove filter ' + c.label, onclick: function () {
        var patch = {};
        if (c.k === 'fleet') { patch.fleet = csvList(S.p.fleet).filter(function (x) { return x !== c.v; }).join(','); }
        else (c.clear || [c.k]).forEach(function (k) { patch[k] = null; });
        go(patch);
      } }, '×')));
    });
    root.appendChild(el('button.nx-btn.nx-btn--ghost.nx-btn--sm', { type: 'button', onclick: clearAll }, 'Clear all'));
  }
  function clearAll() { var patch = {}; ['q', 'fleet', 'range', 'from', 'to', 'status', 'category', 'severity', 'oem', 'driver', 'vehicle'].forEach(function (k) { patch[k] = null; }); go(patch); }

  function renderFilters() {
    var root = $('#rec-filters-body'); if (!root) return;
    var act = document.activeElement, fid = act && act.dataset ? act.dataset.fid : null;
    root.textContent = '';
    var allowed = FILT[S.tab];
    if (allowed.indexOf('fleet') > -1) root.appendChild(fleetGroup());
    root.appendChild(rangeGroup());
    ['status', 'category', 'severity', 'oem'].forEach(function (k) { if (allowed.indexOf(k) > -1) { var g = facetGroup(k); if (g) root.appendChild(g); } });
    if (allowed.indexOf('driver') > -1) root.appendChild(pickerGroup('driver', 'Driver'));
    if (allowed.indexOf('vehicle') > -1) root.appendChild(pickerGroup('vehicle', 'Vehicle'));
    root.appendChild(viewsGroup());
    if (fid) { var n = root.querySelector('[data-fid="' + fid + '"]'); if (n) n.focus(); }
  }
  function countText(n) { return n == null ? '—' : fmt.number(n); }
  function fleetGroup() {
    var sel = csvList(S.p.fleet), counts = (ctx.facets && ctx.facets.fleet) || {};
    var list = ctx.fleets.slice();
    if (!list.length) list = Object.keys(counts).map(function (k) { return { id: k, name: k }; });
    var g = el('fieldset.rec-fgroup', el('legend', 'Fleet'));
    if (ctx.fleetsState === 'loading' && !list.length) g.appendChild(el('span.nx-skel.nx-skel--w75'));
    list.forEach(function (f) {
      var n = counts[f.id] != null ? counts[f.id] : counts[f.name];
      g.appendChild(el('label.rec-opt', el('input', { type: 'checkbox', checked: sel.indexOf(f.id) > -1, 'data-fid': 'fleet-' + f.id, onchange: function (e) {
        var cur = csvList(S.p.fleet); var i = cur.indexOf(f.id); if (e.target.checked && i < 0) cur.push(f.id); if (!e.target.checked && i > -1) cur.splice(i, 1);
        go({ fleet: cur.join(',') });
      } }), el('span.lbl', f.name), el('span.cnt', S.tab === 'risk' ? '' : countText(ctx.state === 'idle' || ctx.dataTab !== S.tab ? null : n == null ? 0 : n))));
    });
    return g;
  }
  function rangeGroup() {
    var cur = S.p.range || 'all';
    var g = el('div.rec-fgroup', el('h3', 'Date range'));
    var chips = el('div.nx-chips');
    RANGES.forEach(function (r) {
      chips.appendChild(el('button.nx-chip', { type: 'button', 'aria-pressed': cur === r[0], 'data-fid': 'range-' + r[0], onclick: function () {
        if (r[0] === 'custom') go({ range: 'custom' }); else go({ range: r[0] === 'all' ? null : r[0], from: null, to: null });
      } }, r[0] === 'all' ? 'All' : r[0] === 'ytd' ? 'YTD' : r[0] === 'custom' ? 'Custom' : r[0]));
    });
    g.appendChild(chips);
    if (cur === 'custom') {
      g.appendChild(el('div.rec-daterow',
        el('label', 'From', el('input.nx-input', { type: 'date', value: S.p.from || '', 'data-fid': 'from', max: S.p.to || null, onchange: function (e) { go({ from: e.target.value || null }); } })),
        el('label', 'To', el('input.nx-input', { type: 'date', value: S.p.to || '', 'data-fid': 'to', min: S.p.from || null, onchange: function (e) { go({ to: e.target.value || null }); } }))));
    }
    return g;
  }
  function facetGroup(key) {
    var counts = (ctx.facets && ctx.facets[key]) || {}, cur = S.p[key];
    var vals = Object.keys(counts);
    if (key === 'severity') vals.sort(function (a, b) { return NX.severities.indexOf(a) - NX.severities.indexOf(b); });
    else vals.sort(function (a, b) { return counts[b] - counts[a]; });
    if (cur && vals.indexOf(cur) < 0) vals.push(cur);
    if (!vals.length) return null;
    var g = el('div.rec-fgroup', el('h3', FACET_TITLES[key]));
    vals.forEach(function (v) {
      var on = cur === v;
      g.appendChild(el('button.rec-opt', { type: 'button', 'aria-pressed': on, 'data-fid': key + '-' + v, onclick: function () { var patch = {}; patch[key] = on ? null : v; go(patch); } },
        el('span.tick', { 'aria-hidden': 'true' }, on ? '✓' : ''), el('span.lbl', fmt.label(v)), el('span.cnt', countText(counts[v] == null ? 0 : counts[v]))));
    });
    return g;
  }
  function pickerGroup(scope, title) {
    var cur = S.p[scope], key = scope + '|' + (S.p.fleet || '');
    var g = el('div.rec-fgroup', el('h3', title));
    var dl = 'rec-dl-' + scope, list = ctx.entities[key] ? ctx.entities[key].list : [];
    var input = el('input.nx-input', { type: 'text', 'data-fid': 'pick-' + scope, list: dl, placeholder: 'Search ' + scope + 's', 'aria-label': title, value: cur ? entityLabel(scope, cur) : '',
      onfocus: function () { loadEntities(scope); },
      onchange: function (e) {
        var v = e.target.value.trim(); if (!v) return go((function () { var o = {}; o[scope] = null; return o; })());
        var m = list.filter(function (x) { return x.name + ' (' + x.id + ')' === v || x.id === v || x.name.toLowerCase() === v.toLowerCase(); })[0];
        var o = {}; o[scope] = m ? m.id : null; if (m) go(o); else { e.target.value = ''; NX.toast('No ' + scope + ' matches "' + v + '". Pick one from the list.', 'info'); }
      } });
    g.appendChild(input);
    g.appendChild(el('datalist', { id: dl }, list.slice(0, 500).map(function (x) { return el('option', { value: x.name + ' (' + x.id + ')' }); })));
    var st = ctx.entities[key] && ctx.entities[key].state;
    g.appendChild(el('p.rec-hint', st === 'loading' ? 'Loading list…' : st === 'error' ? 'Could not load the list.' : list.length ? list.length + ' available' + (S.p.fleet ? ' in selected fleets' : '') : 'Focus to load the list.'));
    return g;
  }

  /* saved views (per browser) */
  function readViews() { try { var v = JSON.parse(lsGet(VIEWS_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; } }
  function writeViews(v) { if (!lsSet(VIEWS_KEY, JSON.stringify(v))) NX.toast('Could not save: browser storage is unavailable.', 'error'); }
  function viewsGroup() {
    var views = readViews();
    var g = el('div.rec-fgroup', el('h3', 'Quick views'));
    var list = el('div.rec-views');
    if (!views.length) list.appendChild(el('p.rec-hint', 'No saved views yet.'));
    views.forEach(function (v, i) {
      list.appendChild(el('div.rec-view',
        el('button.nx-btn.nx-btn--sm', { type: 'button', title: v.hash, 'data-fid': 'view-' + i, onclick: function () { location.hash = v.hash; } }, v.name),
        el('button.nx-icon-btn', { type: 'button', 'aria-label': 'Delete view ' + v.name, style: { width: '28px', height: '28px' }, onclick: function () { var a = readViews(); a.splice(i, 1); writeViews(a); renderFilters(); } }, '×')));
    });
    g.appendChild(list);
    var inp = el('input.nx-input', { type: 'text', placeholder: 'Name this view', 'aria-label': 'Quick view name', maxlength: '40', 'data-fid': 'view-name' });
    var save = function (e) { if (e) e.preventDefault(); var n = inp.value.trim(); if (!n) return inp.focus(); var a = readViews(); a.push({ name: n, hash: buildHash(S.tab, S.p) }); writeViews(a.slice(-20)); renderFilters(); };
    g.appendChild(el('form.rec-saveform', { onsubmit: save }, inp, el('button.nx-btn.nx-btn--sm', { type: 'submit' }, 'Save')));
    g.appendChild(el('p.rec-hint', 'Saved in this browser only (localStorage). Not shared with other people or devices; use the page URL to share.'));
    return g;
  }

  /* ------------------------------ body ------------------------------ */
  function renderBody() {
    var body = $('#rec-body'); if (!body) return;
    $('#rec-content').setAttribute('aria-busy', (S.tab === 'risk' ? ctx.riskState : ctx.state) === 'loading' ? 'true' : 'false');
    if (S.tab === 'risk') return renderRisk();
    body.textContent = '';
    if (S.tab === 'claims') body.appendChild(claimsSummary());
    var card = el('div.nx-card.nx-card--flush');
    body.appendChild(card);
    var def = tabDef(S.tab);
    var stale = ctx.dataTab !== S.tab;
    if (ctx.state === 'error') {
      card.appendChild(el('div.rec-state', { role: 'alert' }, el('h3', 'Could not load ' + def.noun), el('p', ctx.err), el('button.nx-btn.nx-btn--primary', { type: 'button', onclick: function () { load(true); } }, 'Retry')));
      return;
    }
    if ((ctx.state === 'loading' || ctx.state === 'idle') && (stale || !ctx.data)) {
      card.appendChild(toolbar(null));
      for (var i = 0; i < 8; i++) card.appendChild(el('div.rec-skelrow', el('span.nx-skel'), el('span.nx-skel'), el('span.nx-skel'), el('span.nx-skel')));
      return;
    }
    var d = ctx.data, rows = d.results || [], total = d.total != null ? d.total : rows.length;
    card.appendChild(toolbar(total));
    if (!rows.length) {
      card.appendChild(el('div.rec-state', el('h3', 'No ' + def.noun + ' match'), el('p', activeChips().length ? 'Nothing matches the current search and filters.' : 'This response contained no records.'),
        activeChips().length ? el('button.nx-btn', { type: 'button', onclick: clearAll }, 'Clear all filters') : null));
      return;
    }
    var wrap = el('div.nx-table-wrap', { style: { opacity: ctx.state === 'loading' ? '.55' : null } });
    wrap.appendChild(table(rows));
    card.appendChild(wrap);
    card.appendChild(pager(total, rows.length));
  }

  function cols() {
    if (S.tab === 'claims') return [
      { k: 'claimId', l: 'Claim', sort: 'id' }, { k: 'status', l: 'Status', sort: 'status' }, { k: 'oem', l: 'OEM' }, { k: 'dealer', l: 'Dealer' }, { k: 'unit', l: 'Unit / VIN' },
      { k: 'faultCodes', l: 'Fault codes' }, { k: 'estimatedAmount', l: 'Estimated', num: true, sort: 'estimatedAmount' }, { k: 'approvedAmount', l: 'Approved', num: true },
      { k: 'recoveredAmount', l: 'Recovered', num: true, sort: 'recoveredAmount' }, { k: 'ageDays', l: 'Age', num: true, sort: 'ageDays' }, { k: 'submittedAt', l: 'Submitted', sort: 'timestamp' }
    ];
    if (S.tab === 'comms') return [
      { k: 'id', l: 'Message', sort: 'id' }, { k: 'timestamp', l: 'When', sort: 'timestamp' }, { k: 'title', l: 'Summary' }, { k: 'category', l: 'Channel', sort: 'channel' }, { k: 'fleetName', l: 'Fleet' }, { k: 'status', l: 'Status', sort: 'status' }, { k: 'links', l: 'Open' }
    ];
    return [
      { k: 'id', l: 'Incident', sort: 'id' }, { k: 'timestamp', l: 'When', sort: 'timestamp' }, { k: 'title', l: 'Summary' }, { k: 'fleetName', l: 'Fleet', sort: 'fleetName' },
      { k: 'category', l: 'Category' }, { k: 'severity', l: 'Severity', sort: 'severity' }, { k: 'status', l: 'Status', sort: 'status' }, { k: 'links', l: 'Open' }
    ];
  }
  function rowId(r) { return S.tab === 'claims' ? (r.claimId || r.id) : r.id; }
  function openKey(r) { return (S.tab === 'claims' ? 'claim:' : S.tab === 'comms' ? 'comm:' : 'inc:') + rowId(r); }
  function linkCell(r) {
    var l = r.links || {}, inc = r.incidentId || (S.tab === 'incidents' ? r.id : null), box = el('span.rec-links');
    var dispatch = l.dispatch || (inc ? '/dispatch/#' + inc : null), fleetL = l.fleet || (inc && r.fleetId ? '/fleet/?fleet=' + encodeURIComponent(r.fleetId) + '#incident=' + encodeURIComponent(inc) : null);
    if (dispatch) box.appendChild(el('a', { href: dispatch }, 'Dispatch'));
    if (fleetL) box.appendChild(el('a', { href: fleetL }, 'Fleet'));
    return box.childNodes.length ? box : '—';
  }
  function cell(c, r) {
    var v = r[c.k];
    switch (c.k) {
      case 'id': case 'claimId': return el('button.rowlink', { type: 'button', 'aria-label': 'Open record ' + rowId(r), onclick: function (e) { e.stopPropagation(); go({ open: openKey(r) }); } }, dash(v));
      case 'timestamp': case 'submittedAt': v = v || (c.k === 'submittedAt' ? r.timestamp : null); return v ? el('span.nowrap', fmt.dateTime(v), el('span.sub', fmt.ago(v))) : '—';
      case 'title': return el('span.ttl', dash(v), (r.unit || r.vehicleUnit || r.driver || r.driverName) ? el('span.sub', [r.unit || r.vehicleUnit, r.driver || r.driverName].filter(Boolean).join(' / ')) : null);
      case 'status': return statusBadge(v);
      case 'severity': return sevBadge(v);
      case 'category': return v ? fmt.label(v) : '—';
      case 'links': return linkCell(r);
      case 'faultCodes': return el('span.codes', Array.isArray(v) && v.length ? v.join(', ') : '—');
      case 'unit': return el('span', dash(v), r.vin ? el('span.sub.codes', r.vin) : null);
      case 'estimatedAmount': case 'approvedAmount': case 'recoveredAmount': return money(v);
      case 'ageDays': return v == null ? '—' : v + ' d';
      case 'fleetName': return dash(v || fleetName(r.fleetId));
      default: return dash(v);
    }
  }
  function table(rows) {
    var cs = cols(), cur = S.p.sort, dir = S.p.dir === 'asc' ? 'asc' : 'desc';
    var thead = el('tr', cs.map(function (c) {
      var on = cur === c.sort && c.sort;
      var th = el('th', { scope: 'col', class: c.num ? 'num' : null, 'aria-sort': on ? (dir === 'asc' ? 'ascending' : 'descending') : (c.sort ? 'none' : null) });
      if (c.sort) th.appendChild(el('button', { type: 'button', 'aria-label': 'Sort by ' + c.l, onclick: function () { go({ sort: c.sort, dir: on && dir === 'desc' ? 'asc' : 'desc' }); } }, c.l, el('span', { 'aria-hidden': 'true' }, on ? (dir === 'asc' ? '▲' : '▼') : '')));
      else th.textContent = c.l;
      return th;
    }));
    var tbody = el('tbody', rows.map(function (r) {
      var tr = el('tr', { 'data-click': '', class: S.p.open === openKey(r) ? 'is-selected' : null, onclick: function (e) { if (e.target.closest('a,button')) return; go({ open: openKey(r) }); } },
        cs.map(function (c) { return el('td', { class: c.num ? 'num' : (c.k === 'id' || c.k === 'claimId' ? 'id' : null), 'data-label': c.l }, cell(c, r)); }));
      return tr;
    }));
    return el('table.nx-table.rec-table', el('caption.nx-sr', tabDef(S.tab).label + ' results'), el('thead', thead), tbody);
  }
  function toolbar(total) {
    var start = offset();
    var cnt = total == null ? '—' : total === 0 ? '0 results' : 'Showing ' + fmt.number(start + 1) + '–' + fmt.number(Math.min(total, start + ((ctx.data && ctx.data.results) || []).length)) + ' of ' + fmt.number(total);
    return el('div.rec-toolbar', el('span.count', cnt),
      el('div.grp',
        el('label.nx-sr', { 'for': 'rec-limit' }, 'Page size'),
        el('select.nx-select#rec-limit', { onchange: function (e) { go({ limit: e.target.value === '25' ? null : e.target.value }); } }, [10, 25, 50, 100].map(function (n) { return el('option', { value: n, selected: n === limit() }, n + ' per page'); })),
        el('button.nx-btn.nx-btn--sm', { type: 'button', disabled: total == null || !total, onclick: exportCsv, title: 'Exports the rows shown on this page' }, 'Export CSV'),
        el('span.nx-badge.nx-badge--info', 'Synthetic demo data')));
  }
  function pager(total, shown) {
    var start = offset(), lim = limit(), page = Math.floor(start / lim) + 1, pages = Math.max(1, Math.ceil(total / lim));
    return el('nav.rec-pager', { 'aria-label': 'Pagination' }, el('span', 'Page ' + page + ' of ' + pages),
      el('div.grp',
        el('button.nx-btn.nx-btn--sm', { type: 'button', disabled: start <= 0, onclick: function () { go({ offset: Math.max(0, start - lim) || null }); } }, 'Previous'),
        el('button.nx-btn.nx-btn--sm', { type: 'button', disabled: start + lim >= total, onclick: function () { go({ offset: start + lim }); } }, 'Next')));
  }
  function claimsSummary() {
    var s = ctx.summary, ready = ctx.state === 'ready' && ctx.dataTab === 'claims' && s;
    var ar = ready && s.approvalRate != null ? s.approvalRate : null;
    function k(label, val, cls) { return el('div', { class: 'nx-kpi ' + (cls || '') }, el('div.nx-kpi__label', label), el('div.nx-kpi__value', val)); }
    return el('div.rec-summary', { role: 'group', 'aria-label': 'Claims summary' },
      k('Claims', ready ? fmt.number(s.count != null ? s.count : ctx.data.total) : '—'),
      k('Approval rate', ready ? fmt.pct(ar, 0) : '—'),
      k('Median days to decision', ready ? (s.mergedClientSide ? '—' : s.medianDaysToDecision == null ? '—' : fmt.number(s.medianDaysToDecision, 1)) : '—'),
      k('Estimated', ready ? money(s.estimatedTotal) : '—'),
      k('Recovered', ready ? money(s.recoveredTotal) : '—', 'nx-kpi--ok'));
  }

  /* ------------------------------ CSV export ------------------------------ */
  function csvCell(v) {
    if (v == null) return '';
    if (Array.isArray(v)) v = v.join('; ');
    else if (typeof v === 'object') return '';
    v = String(v);
    if (/^[=+\-@\t\r]/.test(v)) v = "'" + v;
    return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }
  function download(name, rows) {
    var blob = new Blob([rows.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' });
    var a = el('a', { href: URL.createObjectURL(blob), download: name }); document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    NX.toast('Exported ' + (rows.length - 1) + ' rows to ' + name, 'success');
  }
  function exportCsv() {
    var rows = (ctx.data && ctx.data.results) || []; if (!rows.length) return;
    var keys = [];
    rows.forEach(function (r) { Object.keys(r).forEach(function (k) { var v = r[k]; if (keys.indexOf(k) < 0 && (v == null || typeof v !== 'object' || Array.isArray(v) && v.every(function (x) { return typeof x !== 'object'; }))) keys.push(k); }); });
    var out = [keys.concat(['dispatchLink', 'fleetLink', 'dataLabel'])];
    rows.forEach(function (r) { out.push(keys.map(function (k) { return r[k]; }).concat([r.links && r.links.dispatch, r.links && r.links.fleet, 'Synthetic demo data'])); });
    download('nexus-records-' + S.tab + '-' + ymd(new Date()) + '-SYNTHETIC.csv', out);
  }

  /* ------------------------------ risk history ------------------------------ */
  function renderRisk() {
    var body = $('#rec-body'); if (!body || S.tab !== 'risk') return;
    var keepFocus = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.fid : null;
    body.textContent = '';
    body.appendChild(riskControls());
    var st = ctx.riskState, r = riskParams();
    if (st === 'needs') { body.appendChild(el('div.nx-card', el('div.rec-state', el('h3', 'Choose a ' + r.scope), el('p', 'Pick a ' + r.scope + ' above to chart its history.')))); return restore(); }
    if (st === 'error') { body.appendChild(el('div.nx-card', el('div.rec-state', { role: 'alert' }, el('h3', 'Could not load risk history'), el('p', ctx.riskErr), el('button.nx-btn.nx-btn--primary', { type: 'button', onclick: function () { load(true); } }, 'Retry')))); return restore(); }
    if (st !== 'ready' || !ctx.risk) {
      body.appendChild(el('div.nx-card.rec-chartcard', el('span.nx-skel.nx-skel--lg.nx-skel--w50'), el('span.nx-skel.nx-skel--block', { style: { marginTop: '12px', height: '200px' } })));
      return restore();
    }
    var d = ctx.risk, meta = d.meta || {};
    var lim = meta.limitations || [];
    body.appendChild(el('div.rec-limits', { role: 'note' }, el('div', el('span.nx-badge.nx-badge--info', meta.label || 'Synthetic demo data'), ' ', el('strong', 'Limitations')),
      lim.length ? el('ul', lim.map(function (x) { return el('li', x); })) : el('p', 'The backend did not list limitations for this response.')));
    // group series by metric, then entity
    var ents = [], byMetric = {};
    (d.series || []).forEach(function (s) {
      var eid = s.entityId || s.id || s.entity || '__primary', name = s.entityName || s.entityLabel || s.name || d.name || (eid === '__primary' ? (d.name || 'Selected') : eid);
      var e = ents.filter(function (x) { return x.id === eid; })[0];
      if (!e) { e = { id: eid, name: name, idx: ents.length }; ents.push(e); }
      var scale = s.metric === 'cameraVerifiedShare' && !/%/.test(s.unit || '') && (s.points || []).every(function (p) { return p.value == null || p.value <= 1; }) ? 100 : 1;
      (byMetric[s.metric] = byMetric[s.metric] || { metric: s.metric, label: s.label || s.metric, unit: s.unit, list: [] }).list.push({ key: eid, name: e.name, idx: e.idx, scale: scale, points: (s.points || []).map(function (p) { return { t: p.t, value: p.value == null ? null : p.value * scale, n: p.n, partial: p.partial }; }) });
    });
    (d.comparisons || d.compare || []).forEach(function (c) { (c.series || []).forEach(function (s) { /* alternative shape */
      var e = ents.filter(function (x) { return x.id === c.id; })[0]; if (!e) { e = { id: c.id, name: c.name || c.id, idx: ents.length }; ents.push(e); }
      (byMetric[s.metric] = byMetric[s.metric] || { metric: s.metric, label: s.label || s.metric, unit: s.unit, list: [] }).list.push({ key: c.id, name: e.name, idx: e.idx, points: s.points || [] }); }); });
    var primaryName = d.name;
    var order = r.metrics.filter(function (m) { return byMetric[m]; }).concat(Object.keys(byMetric).filter(function (m) { return r.metrics.indexOf(m) < 0; }));
    if (!order.length) { body.appendChild(el('div.nx-card', el('div.rec-state', el('h3', 'No history in this range'), el('p', 'The request succeeded but returned no data points. Widen the date range or choose another entity.')))); return restore(); }
    var tools = el('div.rec-charthead', el('div', el('strong', d.name || 'Portfolio'), el('span.nx-dim', ' / ' + (d.bucket || r.bucket) + ' buckets')),
      el('div.nx-row', { style: { gap: '8px' } },
        el('button.nx-btn.nx-btn--sm', { type: 'button', 'aria-pressed': ctx.tableView, 'data-fid': 'tableview', onclick: function () { ctx.tableView = !ctx.tableView; renderRisk(); } }, ctx.tableView ? 'View as chart' : 'View as table'),
        el('button.nx-btn.nx-btn--sm', { type: 'button', onclick: function () { exportRisk(order, byMetric); } }, 'Export CSV')));
    body.appendChild(tools);
    var evs = d.events || [];
    order.forEach(function (m, mi) {
      var g = byMetric[m], card = el('section.nx-card.rec-chartcard', { 'aria-labelledby': 'rc-h-' + m });
      card.appendChild(el('div.rec-charthead', el('h3', { id: 'rc-h-' + m }, g.label), g.unit ? el('span.nx-dim', 'Unit: ' + g.unit) : null));
      var sm = summaryFor(m, mi);
      if (sm) card.appendChild(el('div.rec-sumline', { role: 'group', 'aria-label': g.label + ' summary' },
        el('span', 'First ', el('b', fmtVal(sm.first, g))), el('span', 'Last ', el('b', fmtVal(sm.last, g))),
        el('span', 'Change ', el('b', (sm.change > 0 ? '+' : '') + fmtVal(sm.change, g))), el('span', 'Direction ', el('b', directionText(sm.direction, sm.change)), sm.interpretation ? ' (' + String(sm.interpretation).replace(/_/g, ' ') + ')' : '')));
      if (g.list.some(function (s) { return s.points.some(function (p) { return p.partial; }); })) card.appendChild(el('p.rec-hint', { role: 'note' }, 'Hollow points on the shaded band are partial: their rolling 30-day window starts before the earliest stored incident, so they understate risk. Treat them as indicative only.'));
      if (ctx.tableView) card.appendChild(metricTable(g)); else {
        var ch = RecCharts.line({ title: g.label, unit: g.unit, series: g.list, events: evs, markerTabs: mi === 0, onEvent: function (ev) { go({ open: 'inc:' + ev.incidentId }); }, format: function (v) { return fmtVal(v, g); } });
        card.appendChild(ch.el);
        card.appendChild(legend(g.list));
        if (mi === 0 && evs.length) card.appendChild(el('p.rec-hint', 'Markers under the chart are collisions and major events. Hover, focus or press Enter on one to open the incident. Shapes: diamond = critical or high, triangle = medium, square = low.'));
      }
      body.appendChild(card);
    });
    if (ctx.tableView && evs.length) body.appendChild(el('section.nx-card.rec-chartcard', el('div.rec-charthead', el('h3', 'Events')), el('ul.rec-list', evs.map(function (ev) {
      return el('li', sevBadge(ev.severity), el('span.nx-mono', fmt.dateTime(ev.t)), fmt.label(ev.type || 'event') + (ev.label ? ': ' + ev.label : ''), ev.incidentId ? el('button.rowlink', { type: 'button', onclick: function () { go({ open: 'inc:' + ev.incidentId }); } }, 'Open ' + ev.incidentId) : null);
    }))));
    if (d.annotations && d.annotations.length) body.appendChild(el('ul.rec-hint', { 'aria-label': 'Annotations' }, d.annotations.map(function (a) { return el('li', (a.t ? fmt.date(a.t) + ': ' : '') + a.label); })));
    restore();
    function restore() { if (keepFocus) { var n = body.querySelector('[data-fid="' + keepFocus + '"]'); if (n) n.focus(); } }
  }
  function fmtVal(v, g) {
    if (v == null || isNaN(v)) return '—';
    var u = g && g.unit || '', n = fmt.number(v, Math.abs(v) >= 1000 ? 0 : 2);
    return (g && g.metric === 'cameraVerifiedShare') || /^%/.test(u) ? n + '%' : n;
  }
  function directionText(dir, change) { var d = dir || (change > 0 ? 'up' : change < 0 ? 'down' : 'flat'); return (d === 'up' ? '▲ ' : d === 'down' ? '▼ ' : '► ') + d; }
  function summaryFor(metric, idx) {
    var s = ctx.risk && ctx.risk.summary; if (!s) return null;
    if (s[metric] && typeof s[metric] === 'object') return s[metric];
    if (s.byMetric && s.byMetric[metric]) return s.byMetric[metric];
    if (s.first !== undefined || s.last !== undefined) { if (s.metric ? s.metric === metric : idx === 0) return s; }
    return null;
  }
  function legend(list) {
    return el('div.rec-legend', list.map(function (s) {
      var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 26 8'); svg.setAttribute('aria-hidden', 'true');
      var ln = document.createElementNS('http://www.w3.org/2000/svg', 'line'); ln.setAttribute('x1', 0); ln.setAttribute('x2', 26); ln.setAttribute('y1', 4); ln.setAttribute('y2', 4); ln.setAttribute('stroke', RecCharts.color(s.idx)); ln.setAttribute('stroke-width', 2.5);
      if (RecCharts.dash[s.idx % 4]) ln.setAttribute('stroke-dasharray', RecCharts.dash[s.idx % 4]);
      svg.appendChild(ln); return el('span', svg, s.name);
    }));
  }
  function metricTable(g) {
    var times = {}; g.list.forEach(function (s) { s.points.forEach(function (p) { (times[p.t] = times[p.t] || {})[s.key] = p; }); });
    var ts = Object.keys(times).sort();
    return el('div.nx-table-wrap', { style: { maxHeight: '320px' } }, el('table.nx-table.rec-table', el('caption.nx-sr', g.label + ' values by date'),
      el('thead', el('tr', el('th', { scope: 'col' }, 'Date'), g.list.map(function (s) { return el('th.num', { scope: 'col' }, s.name); }))),
      el('tbody', ts.map(function (t) { return el('tr', el('td', { 'data-label': 'Date' }, fmt.date(t)), g.list.map(function (s) { var p = times[t][s.key]; return el('td.num', { 'data-label': s.name }, p ? fmtVal(p.value, g) + (p.partial ? ' (partial)' : '') : '—'); })); }))));
  }
  function exportRisk(order, byMetric) {
    var out = [['date', 'entity', 'metric', 'value', 'samples', 'dataLabel']];
    order.forEach(function (m) { byMetric[m].list.forEach(function (s) { s.points.forEach(function (p) { out.push([p.t, s.name, m, p.value, p.n, 'Synthetic demo data']); }); }); });
    download('nexus-risk-history-' + ymd(new Date()) + '-SYNTHETIC.csv', out);
  }
  function riskControls() {
    var r = riskParams(), card = el('div.nx-card.rec-risk-controls', { style: { marginBottom: 'var(--nx-sp-4)' } });
    var ents = r.scope === 'portfolio' ? [] : entitiesFor(r.scope);
    if (r.scope === 'driver' || r.scope === 'vehicle') loadEntities(r.scope);
    var entSel = el('select.nx-select#rec-entity', { disabled: r.scope === 'portfolio', 'data-fid': 'entity', onchange: function (e) { go({ entity: e.target.value || null, compare: null }); } },
      el('option', { value: '' }, r.scope === 'portfolio' ? 'All fleets' : ents.length ? 'Select a ' + r.scope : (ctx.entities[r.scope + '|' + (S.p.fleet || '')] || {}).state === 'error' ? 'Could not load' : 'Loading…'),
      ents.map(function (e) { return el('option', { value: e.id, selected: e.id === r.entity }, e.name); }));
    var cmpOpts = ents.filter(function (e) { return e.id !== r.entity && r.compare.indexOf(e.id) < 0; });
    var cmpSel = el('select.nx-select#rec-compare', { 'data-fid': 'compare', disabled: r.scope === 'portfolio' || !r.entity || r.compare.length >= 3, onchange: function (e) { if (e.target.value) go({ compare: r.compare.concat(e.target.value).join(',') }); } },
      el('option', { value: '' }, r.scope === 'portfolio' ? 'Not for portfolio' : r.compare.length >= 3 ? 'Max 3 compared' : 'Add to compare'), cmpOpts.map(function (e) { return el('option', { value: e.id }, e.name); }));
    card.appendChild(el('div.rec-rgrid',
      el('label', 'Scope', el('select.nx-select#rec-scope', { 'data-fid': 'scope', onchange: function (e) { go({ scope: e.target.value === 'portfolio' ? null : e.target.value, entity: null, compare: null }); } },
        ['portfolio', 'fleet', 'driver', 'vehicle'].map(function (s) { return el('option', { value: s, selected: s === r.scope }, fmt.label(s)); }))),
      el('label', r.scope === 'portfolio' ? 'Entity' : fmt.label(r.scope), entSel),
      el('label', 'Bucket', el('select.nx-select#rec-bucket', { 'data-fid': 'bucket', onchange: function (e) { go({ bucket: e.target.value === 'week' ? null : e.target.value }); } },
        ['day', 'week', 'month'].map(function (b) { return el('option', { value: b, selected: b === r.bucket }, fmt.label(b)); }))),
      el('label', 'Compare with', cmpSel)));
    if (r.compare.length) card.appendChild(el('div.rec-chips-compare', r.compare.map(function (id) {
      return el('span.rec-chip', entityLabel(r.scope, id), el('button', { type: 'button', 'aria-label': 'Remove comparison ' + entityLabel(r.scope, id), onclick: function () { go({ compare: r.compare.filter(function (x) { return x !== id; }).join(',') }); } }, '×'));
    })));
    card.appendChild(el('fieldset', el('legend.rec-hint', { style: { margin: 0 } }, 'Metrics'), el('div.rec-metrics', METRICS.map(function (m) {
      return el('label', el('input', { type: 'checkbox', checked: r.metrics.indexOf(m.id) > -1, 'data-fid': 'metric-' + m.id, onchange: function (e) {
        var cur = riskParams().metrics, i = cur.indexOf(m.id);
        if (e.target.checked && i < 0) cur.push(m.id); else if (!e.target.checked) { if (cur.length === 1) { e.target.checked = true; return NX.toast('Keep at least one metric selected.', 'info'); } cur.splice(i, 1); }
        go({ metrics: cur.join(',') });
      } }), m.label);
    }))));
    card.appendChild(el('p.rec-hint', 'Date range comes from the filter panel' + (window.matchMedia('(max-width: 900px)').matches ? ' (open Filters)' : ' on the left') + '. Fleet filter narrows the driver and vehicle lists.'));
    return card;
  }

  /* ------------------------------ drawer ------------------------------ */
  var drawer = { node: null, scrim: null, last: null, seq: 0 };
  function closeDrawer(silent) {
    if (!drawer.node) return;
    drawer.node.remove(); drawer.scrim.remove(); drawer.node = null; drawer.scrim = null; ctx.drawerKey = null;
    document.removeEventListener('keydown', drawerKey, true);
    if (drawer.last && document.contains(drawer.last)) drawer.last.focus();
    if (!silent && S.p.open) go({ open: null }, { replace: true });
  }
  function drawerKey(e) {
    if (!drawer.node) return;
    if (e.key === 'Escape') { e.stopPropagation(); closeDrawer(); }
    else if (e.key === 'Tab') {
      var f = drawer.node.querySelectorAll('a[href],button:not([disabled]),input,select,[tabindex="0"]'); if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      else if (!drawer.node.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    }
  }
  function syncDrawer() {
    var open = S.p.open;
    if (!open) return closeDrawer(true);
    if (open === ctx.drawerKey) return;
    var i = open.indexOf(':'), kind = open.slice(0, i), id = open.slice(i + 1);
    if (!drawer.node) {
      drawer.last = document.activeElement;
      drawer.scrim = el('div.rec-scrim', { onclick: function () { closeDrawer(); } });
      drawer.node = el('aside.rec-drawer', { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'rec-d-title' });
      $('#rec-drawer-root').append(drawer.scrim, drawer.node);
      document.addEventListener('keydown', drawerKey, true);
    }
    ctx.drawerKey = open;
    var seq = ++drawer.seq, node = drawer.node;
    var title = { inc: 'Incident record', claim: 'Warranty claim', comm: 'Communication' }[kind] || 'Record';
    function shell(content, foot) {
      node.textContent = '';
      node.append.apply(node, [el('div.rec-drawer__head', el('div.nx-grow', el('div.nx-eyebrow', title), el('h2#rec-d-title', id)), el('button.nx-icon-btn#rec-d-close', { type: 'button', 'aria-label': 'Close', onclick: function () { closeDrawer(); } }, '✕')),
        el('div.rec-drawer__body', content), foot ? el('div.rec-drawer__foot', foot) : null].filter(Boolean));
      var c = $('#rec-d-close'); if (c) c.focus();
    }
    shell(el('div', el('span.nx-skel.nx-skel--lg.nx-skel--w50'), el('span.nx-skel.nx-skel--block', { style: { marginTop: '12px' } }), el('span.nx-skel.nx-skel--block', { style: { marginTop: '12px' } })));
    function fail(err) { if (seq !== drawer.seq) return; shell(el('div.rec-state', { role: 'alert' }, el('h3', err.status === 404 ? 'Record not found' : 'Could not load record'), el('p', err.message), el('button.nx-btn.nx-btn--primary', { type: 'button', onclick: function () { ctx.drawerKey = null; syncDrawer(); } }, 'Retry'))); }
    if (kind === 'inc') NX.api('/api/records/incident/' + encodeURIComponent(id) + '/history').then(function (d) { if (seq === drawer.seq) incidentDrawer(d, id, shell); }).catch(fail);
    else if (kind === 'claim') {
      var row = ((ctx.data && ctx.data.results) || []).filter(function (r) { return (r.claimId || r.id) === id; })[0];
      NX.api('/api/records/claims/' + encodeURIComponent(id)).then(function (d) { if (seq === drawer.seq) claimDrawer(d.claim || d, id, shell); }).catch(function (err) { if (row && err.status !== 404) claimDrawer(row, id, shell); else fail(err); });
    } else {
      var rec = ((ctx.data && ctx.data.results) || []).filter(function (r) { return r.id === id; })[0];
      if (rec) commDrawer(rec, id, shell); else NX.api('/api/records/search', { query: { type: 'comm', q: id, limit: 5 } }).then(function (d) { var r = (d.results || []).filter(function (x) { return x.id === id; })[0]; if (r) commDrawer(r, id, shell); else fail({ status: 404, message: 'No communication with id ' + id }); }).catch(fail);
    }
  }
  function sec(title, node) { return el('section.rec-sec', el('h3', title), node); }
  function kv(pairs) {
    return el('dl.rec-kv', pairs.filter(function (p) { return p[1] != null && p[1] !== ''; }).map(function (p) { return [el('dt', p[0]), el('dd', p[1])]; }));
  }
  function timeline(items) {
    if (!items || !items.length) return el('p.nx-dim', 'No timeline entries.');
    return el('ol.rec-tl', items.map(function (t) {
      var when = t.t || t.at || t.timestamp, who = t.actor, what = t.action || t.status;
      return el('li', el('time', { datetime: when || null }, when ? fmt.dateTime(when) : '—'), el('strong', fmt.label(what || 'event')), who ? el('span.nx-dim', ' by ' + who) : null, t.simulated ? [' ', NX.badge('simulated')] : null, t.note ? el('div', redact(t.note)) : null);
    }));
  }
  function extLinks(inc, fleetId, reports) {
    var out = [];
    if (inc) {
      out.push(el('a.nx-btn.nx-btn--sm', { href: '/dispatch/#' + encodeURIComponent(inc) }, 'Open in Dispatch'));
      if (fleetId) out.push(el('a.nx-btn.nx-btn--sm', { href: '/fleet/?fleet=' + encodeURIComponent(fleetId) + '#incident=' + encodeURIComponent(inc) }, 'Open in Fleet'));
    }
    if (reports) out.push(el('a.nx-btn.nx-btn--sm', { href: reports }, 'Open in Reports'));
    return out;
  }
  function incidentDrawer(d, id, shell) {
    var rec = d.record || {}, raw = d.incident || {}, inc = Object.assign({}, raw, rec);
    var claim = d.claim, comms = d.comms || [], jobs = d.jobs || [], rel = d.related || [], cam = d.camera, fnol = d.fnol, sop = d.sop;
    var veh = raw.vehicle || {}, drv = raw.driver || {};
    var body = el('div', { style: { gap: 'var(--nx-sp-4)', display: 'grid' } });
    body.appendChild(el('div.nx-row', { style: { gap: '8px', flexWrap: 'wrap' } }, sevBadge(inc.severity), statusBadge(inc.status), el('span.nx-badge.nx-badge--info', 'Synthetic demo data')));
    body.appendChild(sec('Overview', kv([['Summary', inc.title], ['Detail', inc.summary], ['When', inc.timestamp ? fmt.dateTime(inc.timestamp) : null], ['Fleet', inc.fleetName || (inc.fleetId && fleetName(inc.fleetId))], ['Category', inc.category && fmt.label(inc.category)], ['Event type', inc.eventType && fmt.label(inc.eventType)],
      ['Vehicle', veh.unit || inc.vehicleUnit || inc.vehicleId], ['VIN', veh.vin || inc.vin], ['Driver', drv.name || inc.driverName || inc.driverId], ['Source', raw.provider]])));
    body.appendChild(sec('Timeline', timeline(d.timeline)));
    body.appendChild(sec('Communications (' + comms.length + ')', comms.length ? el('ul.rec-list', comms.map(function (c) {
      var who = c.to && c.to.name ? c.to.name + (c.to.type ? ' (' + c.to.type + ')' : '') : '';
      return el('li', el('span.nx-mono', c.at || c.createdAt ? fmt.dateTime(c.at || c.createdAt) : '—'), fmt.label(c.channel || 'message'), who ? ' to ' + who : '', c.status ? statusBadge(c.status) : null, c.simulated !== false ? NX.badge('simulated') : null,
        (c.body || c.subject) ? el('div.nx-dim', { style: { flexBasis: '100%' } }, redact(c.subject ? c.subject + ': ' : '') + redact(c.body || '')) : null);
    })) : el('p.nx-dim', 'No communications recorded for this incident.')));
    if (jobs.length) body.appendChild(sec('Tow jobs (' + jobs.length + ')', el('ul.rec-list', jobs.map(function (j) { return el('li', el('strong', j.providerName || j.providerId || 'Provider'), statusBadge(j.status), NX.badge('simulated'), j.createdAt ? el('span.nx-dim', fmt.dateTime(j.createdAt)) : null); }))));
    body.appendChild(sec('Warranty claim', claim ? el('div', kv([['Claim', el('button.rowlink', { type: 'button', onclick: function () { go({ open: 'claim:' + (claim.claimId || claim.id) }); } }, claim.claimId || claim.id)], ['Status', statusBadge(claim.status)], ['OEM', claim.oem], ['Estimated', money(claim.estimatedAmount)], ['Approved', money(claim.approvedAmount)], ['Recovered', money(claim.recoveredAmount)]])) : el('p.nx-dim', 'No warranty claim linked.')));
    if (fnol) body.appendChild(sec('Insurer FNOL', el('div', kv([['Reference', fnol.claimRef], ['Carrier', fnol.carrier], ['Status', fnol.status], ['Submitted', fnol.submittedAt && fmt.dateTime(fnol.submittedAt)]]), NX.badge('simulated'))));
    var clips = cam ? (cam.clips || []).concat(cam.snapshots || []) : [];
    body.appendChild(sec('Camera evidence', cam ? el('div', el('p.nx-dim', 'Verdict supplied with the vendor event. Nexus does not analyze video. Frames in this demo are placeholders.'), kv([['Provider', cam.provider], ['Vendor marked verified', cam.verified == null ? null : cam.verified ? 'Yes' : 'No'], ['Vendor verdict', cam.aiVerdict && fmt.label(cam.aiVerdict)], ['Confidence', cam.confidence != null ? Math.round(cam.confidence * 100) + '%' : null]]),
      clips.length ? el('ul.rec-list', { style: { marginTop: '8px' } }, clips.map(function (x) { return el('li', el('a', { href: x.url, target: '_blank', rel: 'noopener' }, fmt.label(x.type || 'clip') + ' ' + (x.durationSec ? x.durationSec + 's ' : '') + 'reference'), x.placeholder ? el('span.nx-dim', 'placeholder image, no real footage') : null); })) : null) : el('p.nx-dim', 'No camera evidence references on this incident.')));
    if (sop && sop.steps) { var done = sop.steps.filter(function (x) { return x.done; }).length; body.appendChild(sec('Response checklist', el('p', done + ' of ' + sop.steps.length + ' steps done (' + fmt.label(sop.kind || 'sop') + ')'))); }
    body.appendChild(sec('Related incidents (same vehicle or driver, last 90 days)', rel.length ? el('ul.rec-list', rel.map(function (r) {
      return el('li', el('button.rowlink', { type: 'button', onclick: function () { go({ open: 'inc:' + r.id }); } }, r.id), el('span.nx-dim', r.timestamp ? fmt.date(r.timestamp) : ''), r.eventType ? el('span', fmt.label(r.eventType)) : null, r.severity ? sevBadge(r.severity) : null, (r.relation || []).length ? el('span.nx-dim', r.relation.map(function (x) { return x.replace('_', ' '); }).join(', ')) : null);
    })) : el('p.nx-dim', 'No related incidents found.')));
    shell(body, extLinks(inc.id || id, inc.fleetId, claim ? '/reports/?area=claims' : '/reports/?area=dispatch'));
  }
  function claimDrawer(c, id, shell) {
    var body = el('div', { style: { display: 'grid', gap: 'var(--nx-sp-4)' } });
    body.appendChild(el('div.nx-row', { style: { gap: '8px', flexWrap: 'wrap' } }, statusBadge(c.status), el('span.nx-badge.nx-badge--info', 'Synthetic demo data')));
    body.appendChild(sec('Claim', kv([['Incident', c.incidentId ? el('button.rowlink', { type: 'button', onclick: function () { go({ open: 'inc:' + c.incidentId }); } }, c.incidentId) : null], ['Fleet', c.fleetName || fleetName(c.fleetId)], ['Unit', c.unit], ['VIN', c.vin], ['OEM', c.oem], ['Dealer', c.dealer],
      ['Fault codes', Array.isArray(c.faultCodes) && c.faultCodes.length ? c.faultCodes.join(', ') : null], ['Warranty basis', c.warrantyBasis], ['Denial reason', c.denialReason], ['Age', c.ageDays != null ? c.ageDays + ' days' : null],
      ['Submitted', c.submittedAt && fmt.dateTime(c.submittedAt)], ['Decided', c.decidedAt && fmt.dateTime(c.decidedAt)], ['Paid', c.paidAt && fmt.dateTime(c.paidAt)]])));
    body.appendChild(sec('Amounts', kv([['Estimated', money(c.estimatedAmount)], ['Approved', money(c.approvedAmount)], ['Recovered', money(c.recoveredAmount)]])));
    body.appendChild(sec('Timeline', timeline(c.timeline)));
    body.appendChild(el('p.rec-hint', 'Entries marked Simulated are generated for the demo; nothing was sent to an OEM.'));
    shell(body, [c.incidentId ? el('button.nx-btn.nx-btn--sm', { type: 'button', onclick: function () { go({ open: 'inc:' + c.incidentId }); } }, 'Open incident record') : null].concat(extLinks(c.incidentId, c.fleetId, '/reports/?area=claims')));
  }
  function commDrawer(r, id, shell) {
    var pairs = Object.keys(r).filter(function (k) { return typeof r[k] !== 'object' || r[k] == null; }).map(function (k) { return [fmt.label(k), /time|At$|^at$/i.test(k) && r[k] ? fmt.dateTime(r[k]) : redact(r[k])]; });
    var body = el('div', { style: { display: 'grid', gap: 'var(--nx-sp-4)' } }, el('div.nx-row', { style: { gap: '8px' } }, statusBadge(r.status), el('span.nx-badge.nx-badge--info', 'Synthetic demo data')), sec('Details', kv(pairs)));
    shell(body, [r.incidentId ? el('button.nx-btn.nx-btn--sm', { type: 'button', onclick: function () { go({ open: 'inc:' + r.incidentId }); } }, 'Open incident record') : null].concat(extLinks(r.incidentId, r.fleetId, null)));
  }

  /* ------------------------------ init ------------------------------ */
  function init() {
    NX.topbar('Records', { sidebar: false, live: false });
    var st = parseHash(); S.tab = st.tab; S.p = st.p; ctx.lastHash = buildHash(S.tab, S.p);
    var form = $('#rec-search'), input = $('#rec-q'), timer;
    form.addEventListener('submit', function (e) { e.preventDefault(); clearTimeout(timer); go({ q: input.value.trim() || null }); });
    input.addEventListener('input', function () { clearTimeout(timer); timer = setTimeout(function () { var v = input.value.trim(); if (v !== (S.p.q || '')) go({ q: v || null }, { replace: true }); }, 400); });
    $('#rec-filter-toggle').addEventListener('click', function () {
      var f = $('#rec-filters'), on = f.classList.toggle('is-open'); this.setAttribute('aria-expanded', on);
    });
    window.addEventListener('popstate', onUrlChange); window.addEventListener('hashchange', onUrlChange);
    document.addEventListener('nx:theme', function () { if (S.tab === 'risk') renderRisk(); });
    loadFleets();
    render();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
