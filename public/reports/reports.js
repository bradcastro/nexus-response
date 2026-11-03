/* Nexus Response: Reports portal. Builds against docs/REPORTS_CONTRACT.md (/api/report-builder/*). No build step. */
(function () {
  'use strict';
  var el = NX.el, fmt = NX.fmt;
  var API = '/api/report-builder';
  var uid = 0, nid = function (p) { return (p || 'rp') + '-' + (++uid); };
  var root = document.getElementById('rp-root');
  NX.topbar('Reports', { sidebar: false, live: false });
  NX.theme.defaultTo('light');
  setTimeout(function () { var a = document.querySelector('.nx-switcher [aria-current]'); if (a && a.scrollIntoView) a.scrollIntoView({ inline: 'center', block: 'nearest' }); }, 50);

  var AREA_ORDER = ['dispatch', 'fleet', 'insurer', 'claims'];
  var AGG_LABEL = { count: 'Count', sum: 'Sum', avg: 'Average', min: 'Minimum', max: 'Maximum', median: 'Median', p90: '90th percentile', rate: 'Rate' };
  var OP_LABEL = { eq: 'is', neq: 'is not', contains: 'contains', in: 'is one of', gt: '>', gte: '>=', lt: '<', lte: '<=', between: 'between' };
  var CHART_LABEL = { table: 'Table only', bar: 'Bar', line: 'Line', area: 'Area', pie: 'Pie', stacked_bar: 'Stacked bar', scatter: 'Scatter' };
  var BUCKET_LABEL = { none: 'No time bucket', day: 'Day', week: 'Week', month: 'Month' };

  var S = {
    catalog: null, saved: [], fleets: [], area: 'dispatch', cur: null, base: '',
    result: null, status: 'idle', err: null, auto: true, timer: null, seq: 0,
    tsort: null, scope: null, open: { data: true, filters: false, metrics: true, columns: false, chart: true },
    loadErr: null, railOpen: false
  };
  var qs = new URLSearchParams(location.search);

  /* ---------------- helpers ---------------- */
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function isMobile() { return window.matchMedia('(max-width: 900px)').matches; }
  function datasets() { var out = []; (S.catalog ? S.catalog.areas : []).forEach(function (a) { a.datasets.forEach(function (d) { out.push({ area: a.id, ds: d }); }); }); return out; }
  function dsById(id) { var f = datasets().filter(function (x) { return x.ds.id === id; })[0]; return f ? f.ds : null; }
  function dsArea(id) { var f = datasets().filter(function (x) { return x.ds.id === id; })[0]; return f ? f.area : null; }
  function curDs() { return S.cur ? dsById(S.cur.config.dataset) : null; }
  function fieldOf(ds, id) { return ds && ds.fields.filter(function (f) { return f.id === id; })[0]; }
  function areaLabel(id) { var a = S.catalog && S.catalog.areas.filter(function (x) { return x.id === id; })[0]; return a ? a.label : fmt.label(id); }
  function fleetName(id) { var f = S.fleets.filter(function (x) { return x.id === id; })[0]; return f ? f.name : id; }
  function isRO() { return !!(S.cur && S.cur.isTemplate); }
  function opts(list, cur) { return list.map(function (o) { return el('option', { value: o.v, selected: String(o.v) === String(cur) ? true : null }, o.l); }); }
  function select(list, cur, onchange, label, id) {
    var s = el('select.rp-select', { id: id, 'aria-label': id ? null : label, onchange: function () { onchange(s.value); } }, opts(list, cur));
    return s;
  }
  function field(label, control, id, hint) {
    return el('div.rp-field', el('label', { for: id }, label), control, hint && el('div.rp-hint', hint));
  }
  function check(label, checked, onchange, extra) {
    var id = nid('ck');
    return el('div.rp-check', el('input', { type: 'checkbox', id: id, checked: checked ? true : null, onchange: function (e) { onchange(e.target.checked); } }), el('label', { for: id }, label, extra));
  }
  function xbtn(label, onclick, disabled, glyph) { return el('button.rp-x', { type: 'button', 'aria-label': label, title: label, disabled: disabled ? true : null, onclick: onclick }, glyph || '✕'); }

  /* ---------------- config ---------------- */
  function newConfig(dsId) {
    var ds = dsById(dsId) || (datasets()[0] && datasets()[0].ds);
    return {
      dataset: ds ? ds.id : '', fleetIds: S.scope ? [S.scope] : [], dateRange: { preset: '30d' }, filters: [], groupBy: [], timeBucket: 'none',
      metrics: ds ? clone(ds.defaultMetrics || []) : [], columns: ds ? (ds.defaultColumns || []).slice() : [], sort: [], limit: 500, offset: 0
    };
  }
  function normalize(c) {
    var d = { dataset: (c && c.dataset) || '', fleetIds: [], dateRange: { preset: '30d' }, filters: [], groupBy: [], timeBucket: 'none', metrics: [], columns: [], sort: [], limit: 500, offset: 0 };
    var o = Object.assign({}, d, clone(c || {}));
    o.filters = o.filters || []; o.groupBy = o.groupBy || []; o.metrics = o.metrics || []; o.columns = o.columns || []; o.sort = o.sort || []; o.fleetIds = o.fleetIds || [];
    o.dateRange = o.dateRange || { preset: '30d' }; o.timeBucket = o.timeBucket || 'none'; o.limit = o.limit || 500;
    if (o.compareTo !== 'previous_period') delete o.compareTo;
    return o;
  }
  function filterOk(f) {
    if (!f.field || !f.op || f.value == null || f.value === '') return false;
    if (Array.isArray(f.value)) return f.op === 'between' ? f.value.length === 2 && f.value[0] !== '' && f.value[1] !== '' && f.value[0] != null && f.value[1] != null : f.value.length > 0;
    return true;
  }
  function buildReq(c) {
    var cfg = c.config, aggregated = cfg.groupBy.length || (cfg.timeBucket && cfg.timeBucket !== 'none') || cfg.metrics.some(function (m) { return m.field && m.agg; }), dr = { preset: cfg.dateRange.preset || '30d' };
    if (dr.preset === 'custom') { dr.from = cfg.dateRange.from || undefined; dr.to = cfg.dateRange.to || undefined; }
    if (cfg.dateRange.field) dr.field = cfg.dateRange.field;
    var r = {
      dataset: cfg.dataset, dateRange: dr, filters: cfg.filters.filter(filterOk).map(function (f) { return { field: f.field, op: f.op, value: f.value }; }),
      groupBy: cfg.groupBy.slice(), timeBucket: cfg.timeBucket || 'none',
      metrics: cfg.metrics.filter(function (m) { return m.field && m.agg; }).map(function (m) { var o = { field: m.field, agg: m.agg }; if (m.label) o.label = m.label; return o; }),
      columns: aggregated ? [] : cfg.columns.slice(), sort: cfg.sort.filter(function (s) { return s.field; }).map(function (s) { return { field: s.field, dir: s.dir || 'desc' }; }),
      limit: Math.max(1, Math.min(2000, Number(cfg.limit) || 500)), offset: 0
    };
    if (cfg.fleetIds.length) r.fleetIds = cfg.fleetIds.slice();
    if (cfg.compareTo) r.compareTo = 'previous_period';
    return r;
  }
  function sig() { return S.cur ? JSON.stringify([S.cur.name, S.cur.description || '', buildReq(S.cur), S.cur.chart]) : ''; }
  function isDirty() { return !!S.cur && sig() !== S.base; }
  function mark() { S.base = sig(); }

  /* ---------------- data loading ---------------- */
  function loadAll() {
    root.replaceChildren(el('div.nx-stack', { style: { padding: 'var(--nx-sp-5)' } }, el('span.nx-skel.nx-skel--lg.nx-skel--w50'), el('span.nx-skel.nx-skel--block'), el('span.nx-skel.nx-skel--block')));
    return Promise.all([
      NX.api(API + '/catalog'),
      NX.api(API + '/saved').catch(function (e) { S.savedErr = e; return []; }),
      NX.api('/api/fleets').catch(function () { return []; })
    ]).then(function (r) {
      S.catalog = r[0]; S.saved = Array.isArray(r[1]) ? r[1] : (r[1] && r[1].saved) || []; S.fleets = Array.isArray(r[2]) ? r[2] : (r[2] && r[2].fleets) || [];
      S.loadErr = null; init();
    }).catch(function (e) {
      S.loadErr = e;
      root.replaceChildren(el('div.nx-card', el('div.nx-card__body', el('div.nx-empty', el('div.nx-empty__icon', '!'), el('div.nx-empty__title', 'Reports could not load'), el('p', e.message), el('button.nx-btn.nx-btn--primary', { type: 'button', onclick: loadAll }, 'Retry')))));
    });
  }
  function refreshSaved() {
    return NX.api(API + '/saved').then(function (r) { S.saved = Array.isArray(r) ? r : (r && r.saved) || []; }).catch(function () { /* keep */ });
  }

  function init() {
    var a = qs.get('area'); if (a && AREA_ORDER.indexOf(a) > -1) S.area = a;
    var f = qs.get('fleet'); if (f) S.scope = f;
    var id = decodeURIComponent(location.hash.replace(/^#/, ''));
    var found = id && S.saved.filter(function (s) { return s.id === id; })[0];
    if (found) { S.area = found.area || S.area; openSaved(found, true); } else render();
    window.addEventListener('hashchange', function () {
      var h = decodeURIComponent(location.hash.replace(/^#/, ''));
      if (S.cur && h === (S.cur.id || '')) return;
      var s = h && S.saved.filter(function (x) { return x.id === h; })[0];
      if (s) { S.area = s.area || S.area; openSaved(s, true); }
    });
    window.matchMedia('(max-width: 900px)').addEventListener('change', function () { render(); });
  }

  function setHash(id) { try { history.replaceState(null, '', location.pathname + location.search + (id ? '#' + encodeURIComponent(id) : '')); } catch (e) { /* ignore */ } }

  function openSaved(s, noHash) {
    var cfg = normalize(s.config);
    if (S.scope) cfg.fleetIds = [S.scope];
    S.cur = { id: s.id, name: s.name, description: s.description || '', area: s.area, isTemplate: !!s.isTemplate, config: cfg, chart: Object.assign({ type: '', x: '', series: [], options: {} }, clone(s.chart || {})), savedAt: s.updatedAt };
    if (S.cur.chart.type === 'table' && false) S.cur.chart.type = '';
    S.area = s.area || S.area; S.result = null; S.tsort = null; S.err = null; mark();
    if (!noHash) setHash(s.id);
    S.builderOpen = !!S.forceOpen; S.forceOpen = false; if (isMobile()) { S.open = { data: true }; S.railOpen = false; }
    render(); run();
  }
  function newReport(dsId) {
    var ds = dsId || (S.catalog.areas.filter(function (a) { return a.id === S.area; })[0] || { datasets: [] }).datasets[0];
    var id = ds && (ds.id || ds);
    S.cur = { id: null, name: 'Untitled report', description: '', area: S.area, isTemplate: false, config: newConfig(id), chart: { type: '', x: '', series: [], options: {} } };
    S.result = null; S.tsort = null; S.err = null; mark(); setHash('');
    S.railOpen = false; S.builderOpen = true; render(); run();
  }

  /* ---------------- running ---------------- */
  function touch() {
    updateHeader();
    if (S.auto && !isRO()) { clearTimeout(S.timer); S.timer = setTimeout(run, 700); }
  }
  function run() {
    clearTimeout(S.timer);
    if (!S.cur || !S.cur.config.dataset) return;
    var my = ++S.seq;
    S.status = 'loading'; S.err = null; renderOutput();
    NX.api(API + '/run', { method: 'POST', body: buildReq(S.cur) }).then(function (r) {
      if (my !== S.seq) return;
      S.result = r; S.status = 'ok'; renderOutput(); rebuildSection('chart');
    }).catch(function (e) {
      if (my !== S.seq) return;
      if (e.data && /^sort/.test(e.data.field || '') && S.cur.config.sort.length && !isRO()) {
        S.cur.config.sort = []; NX.toast('Sort reset: it no longer matches the result columns', 'info'); rebuildSection('columns'); return run();
      }
      S.status = 'error'; S.err = e; renderOutput();
    });
  }

  /* effective chart settings (user choice, else backend suggestion) */
  function eff() {
    var r = S.result, ch = S.cur.chart, sug = (r && r.chart) || {}, cols = r ? r.columns : [];
    var ids = cols.map(function (c) { return c.id; });
    var type = ch.type || sug.suggested || 'table';
    var x = ids.indexOf(ch.x) > -1 ? ch.x : (sug.x && ids.indexOf(sug.x) > -1 ? sug.x : (cols[0] && cols[0].id));
    var series = (ch.series || []).filter(function (s) { return ids.indexOf(s) > -1; });
    if (!series.length) series = (sug.series || []).filter(function (s) { return ids.indexOf(s) > -1; });
    if (!series.length) series = cols.filter(function (c) { return c.type === 'number' && c.id !== x; }).slice(0, 1).map(function (c) { return c.id; });
    var sb = (ch.options && ch.options.seriesBy) || '';
    if (sb === 'none') sb = ''; else if (!sb) sb = sug.seriesBy || '';
    if (sb && (ids.indexOf(sb) < 0 || sb === x)) sb = '';
    return { type: type, x: x, series: series, seriesBy: sb };
  }
  function pivot(r, ef) {
    var s0 = ef.series[0], xs = [], gs = [], map = {};
    r.rows.forEach(function (row) {
      var xv = row[ef.x], gv = row[ef.seriesBy] == null ? '—' : String(row[ef.seriesBy]);
      if (xs.indexOf(xv) < 0) xs.push(xv); if (gs.indexOf(gv) < 0) gs.push(gv);
      map[xv + '\u0001' + gv] = row[s0];
    });
    if (xs.every(function (v) { return /^\d{4}-\d{2}/.test(String(v)); })) xs.sort();
    if (gs.length > 8) {
      var tot = {}; gs.forEach(function (g) { tot[g] = 0; }); r.rows.forEach(function (row) { var g = row[ef.seriesBy] == null ? '—' : String(row[ef.seriesBy]); tot[g] += Number(row[s0]) || 0; });
      var keep = gs.slice().sort(function (a, b) { return tot[b] - tot[a]; }).slice(0, 7);
      xs.forEach(function (xv) { var o = 0; gs.forEach(function (g) { if (keep.indexOf(g) < 0) o += Number(map[xv + '\u0001' + g]) || 0; }); map[xv + '\u0001Other (' + (gs.length - 7) + ')'] = o; });
      gs = keep.concat(['Other (' + (gs.length - 7) + ')']);
    }
    var base = r.columns.filter(function (c) { return c.id === s0; })[0], xc = r.columns.filter(function (c) { return c.id === ef.x; })[0];
    var cols = [xc].concat(gs.map(function (g) { return Object.assign({}, base, { id: 'pv:' + g, label: fmt.label(g) }); }));
    var rows = xs.map(function (xv) { var o = {}; o[ef.x] = xv; gs.forEach(function (g) { var v = map[xv + '\u0001' + g]; o['pv:' + g] = v == null ? 0 : v; }); return o; });
    return { columns: cols, rows: rows, series: gs.map(function (g) { return 'pv:' + g; }) };
  }

  /* ---------------- formatting ---------------- */
  function cellText(c, v) {
    if (v == null || v === '') return '—';
    if (c.type === 'number') {
      var n = Number(v); if (!isFinite(n)) return String(v);
      if (c.unit === 'USD' || c.unit === '$') return fmt.currency(n, Math.abs(n) < 100 && n % 1 ? 2 : 0);
      var s = fmt.number(n, Number.isInteger(n) ? 0 : 2);
      return c.unit === '%' ? s + '%' : (c.unit && c.unit !== 'count' ? s + ' ' + c.unit : s);
    }
    if (c.type === 'date') { var st = String(v); return /^\d{4}-\d{2}-\d{2}$/.test(st) ? fmt.date(st + 'T00:00:00') : fmt.dateTime(v); }
    if (c.type === 'boolean' || typeof v === 'boolean') return v ? 'Yes' : 'No';
    if (c.type === 'enum') return fmt.label(v);
    return String(v);
  }
  function colFmt(colId, v) { var c = S.result && S.result.columns.filter(function (x) { return x.id === colId; })[0]; return c ? cellText(c, v) : String(v == null ? '—' : v); }
  function colLabel(colId) { var c = S.result && S.result.columns.filter(function (x) { return x.id === colId; })[0]; return c ? c.label + (c.unit && c.unit !== 'count' ? ' (' + c.unit + ')' : '') : colId; }

  function deltaInfo(colId, label) {
    var cmp = S.result && S.result.comparison; if (!cmp || !cmp.deltaByMetric) return null;
    var d = cmp.deltaByMetric[colId]; if (d == null && label) d = cmp.deltaByMetric[label];
    if (d == null) return null;
    if (typeof d === 'number') return { delta: d };
    var pct = d.pct != null ? d.pct : d.percent != null ? d.percent : d.deltaPct != null ? d.deltaPct : d.pctChange;
    return { delta: d.delta != null ? d.delta : d.change, pct: pct, previous: d.previous != null ? d.previous : d.prev, current: d.current };
  }
  function deltaText(d, unit) {
    if (!d) return '';
    var arrow = (d.pct != null ? d.pct : d.delta) > 0 ? '▲' : (d.pct != null ? d.pct : d.delta) < 0 ? '▼' : '■';
    var s = d.pct != null ? (d.pct > 0 ? '+' : '') + Number(d.pct).toFixed(1) + '%' : (d.delta > 0 ? '+' : '') + fmt.number(d.delta, 2);
    return arrow + ' ' + s;
  }

  /* ---------------- shell render ---------------- */
  function render() {
    if (!S.catalog) return;
    var layout = el('div.rp-layout', buildRail(), el('section.rp-work', { 'aria-label': 'Report workspace' }, S.cur ? buildWorkspace() : buildStart()));
    root.replaceChildren(layout);
    if (S.cur) { renderOutput(); }
  }

  function buildRail() {
    var tpls = S.saved.filter(function (s) { return s.isTemplate && s.area === S.area; });
    var mine = S.saved.filter(function (s) { return !s.isTemplate && s.area === S.area; });
    function item(s) {
      var d = dsById(s.config && s.config.dataset);
      return el('li', el('button.rp-item', { type: 'button', 'aria-current': S.cur && S.cur.id === s.id ? 'true' : null, onclick: function () { openSaved(s); } },
        el('span.rp-item__name', s.name),
        s.description && el('span.rp-item__desc', s.description),
        d && el('span.rp-item__meta', d.label)));
    }
    var body = el('div.rp-rail__body',
      el('div.rp-areas', { role: 'group', 'aria-label': 'Report areas' }, AREA_ORDER.map(function (a) {
        return el('button.rp-area', { type: 'button', 'aria-pressed': S.area === a ? 'true' : 'false', onclick: function () { S.area = a; render(); } }, areaLabel(a));
      })),
      el('button.nx-btn.nx-btn--primary.nx-btn--block', { type: 'button', onclick: function () { newReport(); } }, '+ New report'),
      el('div', el('h2.nx-eyebrow.rp-group-title', 'Templates · ' + areaLabel(S.area)), tpls.length ? el('ul.rp-list', tpls.map(item)) : el('p.rp-hint', S.savedErr ? 'Templates could not load.' : 'No templates in this area.')),
      el('div', el('h2.nx-eyebrow.rp-group-title', 'My reports'), mine.length ? el('ul.rp-list', mine.map(item)) : el('p.rp-hint', 'Nothing saved in ' + areaLabel(S.area) + ' yet. Build a report and choose Save.')));
    return el('aside.rp-rail' + (S.railOpen ? '.is-open' : ''), { 'aria-label': 'Report library' },
      el('button.nx-btn.rp-rail__toggle', { type: 'button', 'aria-expanded': S.railOpen ? 'true' : 'false', onclick: function () { S.railOpen = !S.railOpen; render(); } },
        el('span', 'Library: ' + areaLabel(S.area)), el('span.nx-dim', S.railOpen ? 'Hide' : 'Show')),
      body);
  }

  function honestBadges() {
    return el('div.rp-badges',
      el('span.nx-badge.nx-badge--synthetic-data', 'Synthetic demo data'),
      NX.capBadge('simulated', 'Schedule and email: simulated'));
  }

  function buildStart() {
    var tpls = S.saved.filter(function (s) { return s.isTemplate && s.area === S.area; }).slice(0, 4);
    return el('div.nx-card', el('div.nx-card__body.rp-empty-start',
      el('div.nx-eyebrow', 'Reports / ' + areaLabel(S.area)),
      el('h1', { style: { marginTop: '8px' } }, 'Reports'),
      el('p.nx-dim', { style: { marginTop: '6px' } }, 'Pick a template or build your own'),
      S.scope && scopeBanner(),
      honestBadges(),
      tpls.length ? el('div.rp-pick', tpls.map(function (s) {
        return el('button.rp-item', { type: 'button', onclick: function () { openSaved(s); } }, el('span.rp-item__name', s.name), el('span.rp-item__desc', s.description || ''), el('span.rp-item__meta', 'Template'));
      })) : el('p.rp-hint', { style: { marginTop: '12px' } }, S.savedErr ? 'Templates could not load. ' : 'No templates in this area yet. '),
      el('div', { style: { marginTop: '16px' } }, el('button.nx-btn.nx-btn--primary', { type: 'button', onclick: function () { newReport(); } }, 'Build your own'))));
  }

  function scopeBanner() {
    return el('div.rp-banner', { style: { marginTop: '12px' } }, el('span', 'Scoped to fleet ', el('b', fleetName(S.scope))), el('button.nx-btn.nx-btn--sm', { type: 'button', onclick: function () {
      S.scope = null; qs.delete('fleet'); try { history.replaceState(null, '', location.pathname + (qs.toString() ? '?' + qs : '') + location.hash); } catch (e) { /* */ }
      if (S.cur) { S.cur.config.fleetIds = []; } render(); if (S.cur) run();
    } }, 'Clear scope'));
  }

  /* ---------------- workspace: header + toolbar ---------------- */
  var hdr = {};
  function buildWorkspace() {
    var c = S.cur;
    hdr.title = el('h1', c.name);
    hdr.status = el('span');
    hdr.sub = el('p.rp-head__sub');
    hdr.btns = {};
    function btn(key, label, fn, cls, title) { var b = el('button.nx-btn.nx-btn--sm' + (cls || ''), { type: 'button', title: title || null, onclick: fn }, label); hdr.btns[key] = b; return b; }
    var tb = el('div.rp-toolbar', { role: 'toolbar', 'aria-label': 'Report actions' },
      btn('apply', 'Apply', run, '.nx-btn--primary', 'Run the report now'),
      btn('save', 'Save', doSave), btn('saveas', 'Save as…', function () { saveAsModal(); }), btn('dup', 'Duplicate', doDuplicate),
      btn('rename', 'Rename', renameModal), btn('del', 'Delete', deleteModal, '.nx-btn--danger'),
      el('span.sep', { 'aria-hidden': 'true' }),
      btn('csv', 'Export CSV', function () { doExport('csv'); }), btn('json', 'Export JSON', function () { doExport('json'); }), btn('print', 'Print', function () { window.print(); }),
      el('span.sep', { 'aria-hidden': 'true' }),
      btn('share', 'Share link', shareModal), btn('sched', 'Schedule', scheduleModal));
    var head = el('div.rp-head', el('div.nx-grow', el('div.nx-eyebrow', 'Reports / ' + areaLabel(c.area || S.area)), el('div', { style: { marginTop: '6px' } }, hdr.title), hdr.sub,
      el('div.rp-badges', hdr.status, el('span.nx-badge.nx-badge--synthetic-data', 'Synthetic demo data'), NX.capBadge('simulated', 'Schedule and email: simulated'))));
    hdr.banner = el('div');
    var wrap = el('div', head, el('div', { style: { marginTop: 'var(--nx-sp-3)' } }, tb), hdr.banner);
    var body = el('div.rp-body' + (S.builderOpen ? '.is-open' : '') + (S.builderOpen ? '.cfg-first' : ''), buildBuilder(), el('div.rp-out', { id: 'rp-out' }));
    var node = el('div.rp-work-inner.nx-stack', wrap, S.scope && scopeBanner(), body, buildPrintHead());
    node.style.gap = 'var(--nx-sp-3)';
    setTimeout(updateHeader, 0);
    return node;
  }
  function updateHeader() {
    var c = S.cur; if (!c || !hdr.title) return;
    var dirty = isDirty(), ro = isRO(), saved = !!c.id;
    hdr.title.textContent = c.name;
    hdr.status.className = 'nx-badge ' + (ro ? 'nx-badge--plain' : dirty ? 'nx-badge--high' : saved ? 'nx-badge--ok' : 'nx-badge--plain');
    hdr.status.textContent = ro ? 'Template (read-only)' : dirty ? (saved ? 'Unsaved changes' : 'Unsaved draft') : saved ? 'Saved' : 'Draft';
    hdr.sub.textContent = c.description || '';
    hdr.sub.hidden = !c.description;
    var b = hdr.btns;
    b.save.disabled = ro || (saved && !dirty); b.save.title = ro ? 'Templates are read-only. Duplicate to edit.' : '';
    b.rename.disabled = ro || !saved; b.del.disabled = ro || !saved;
    b.dup.textContent = ro ? 'Duplicate to edit' : 'Duplicate'; b.dup.className = 'nx-btn nx-btn--sm' + (ro ? ' nx-btn--primary' : '');
    b.share.disabled = !saved; b.share.title = saved ? (dirty ? 'Shares the last saved version' : '') : 'Save the report to create a share link';
    b.sched.disabled = !saved; b.sched.title = saved ? '' : 'Save the report to schedule it';
    var hasRes = S.status === 'ok' && S.result;
    b.csv.disabled = !hasRes; b.json.disabled = !hasRes; b.print.disabled = !hasRes;
    hdr.banner.replaceChildren();
    if (ro) hdr.banner.appendChild(el('div.rp-banner', { style: { marginTop: 'var(--nx-sp-3)' } }, el('span', 'This is a built-in template and cannot be changed.'), el('button.nx-btn.nx-btn--sm.nx-btn--primary', { type: 'button', onclick: doDuplicate }, 'Duplicate to edit')));
    else if (saved && dirty) hdr.banner.appendChild(el('div.rp-banner.rp-banner--warn', { style: { marginTop: 'var(--nx-sp-3)' } }, 'You have unsaved changes. Sharing and scheduling use the last saved version.'));
    var t = document.title.replace(/ — .*$/, ''); document.title = 'Nexus Response — Reports' ;
    var pn = document.getElementById('rp-printname'); if (pn) pn.textContent = c.name;
  }

  /* ---------------- builder ---------------- */
  function buildBuilder() {
    var det = el('details.rp-builder', { open: S.builderOpen ? true : null, ontoggle: function (e) { if (e.target !== det) return; S.builderOpen = det.open; var b = document.querySelector('.rp-body'); if (b) b.classList.toggle('is-open', det.open); } },
      el('summary', 'Configure report', el('span.rp-sum__hint', isRO() ? 'read-only' : '')),
      el('div.rp-ro', { hidden: !isRO() }, isRO() ? 'Read-only template. Duplicate to change the settings.' : ''),
      el('fieldset', { disabled: isRO() ? true : null },
        el('legend.nx-sr', 'Report builder'),
        el('div#rp-sections', ['data', 'filters', 'metrics', 'columns', 'chart'].map(buildSection))),
      el('div.rp-autorun', el('div.rp-row2', el('button.nx-btn.nx-btn--primary', { type: 'button', onclick: function () { run(); if (window.matchMedia('(max-width: 1100px)').matches) { det.open = false; S.builderOpen = false; var o = document.getElementById('rp-out'); if (o) o.scrollIntoView({ block: 'start' }); } } }, 'Apply'),
        el('div', check('Auto-run on change', S.auto, function (v) { S.auto = v; })))));
    return det;
  }
  function rebuildSection(key) {
    var old = document.querySelector('[data-sec="' + key + '"]');
    if (!old) return;
    var open = old.open; var n = buildSection(key); n.open = open; old.replaceWith(n);
  }
  function buildSection(key) {
    var map = { data: secData, filters: secFilters, metrics: secMetrics, columns: secColumns, chart: secChart };
    var titles = { data: 'Data and scope', filters: 'Filters', metrics: 'Group and metrics', columns: 'Columns and sort', chart: 'Chart' };
    var c = S.cur.config;
    var count = key === 'filters' ? (c.filters.length ? String(c.filters.length) : '') : key === 'metrics' ? (c.groupBy.length + c.metrics.length ? c.groupBy.length + ' group, ' + c.metrics.length + ' metric' : '') : key === 'columns' ? (c.columns.length ? c.columns.length + ' cols' : 'default') : '';
    var d = el('details.rp-sec', { 'data-sec': key, open: S.open[key] ? true : null }, el('summary', titles[key], el('span.rp-sec__count', count)), el('div.rp-sec__body', map[key]()));
    d.addEventListener('toggle', function () {
      S.open[key] = d.open;
      if (d.open && isMobile()) document.querySelectorAll('.rp-sec[open]').forEach(function (o) { if (o !== d) { o.open = false; S.open[o.dataset.sec] = false; } });
    });
    return d;
  }
  function changed(structural, key) { touch(); if (structural) rebuildSection(key); else updateCount(); }
  function updateCount() { /* counts refresh on structural changes only */ }

  function secData() {
    var c = S.cur.config, ds = curDs(), cat = S.catalog;
    var dsel = el('select.rp-select', { id: 'f-ds', onchange: function (e) {
      var d = dsById(e.target.value); S.cur.config = Object.assign(newConfig(d.id), { fleetIds: c.fleetIds, dateRange: c.dateRange, limit: c.limit });
      S.cur.chart = { type: '', x: '', series: [], options: {} }; S.result = null;
      ['data', 'filters', 'metrics', 'columns', 'chart'].forEach(rebuildSection); touch(); } },
      cat.areas.map(function (a) { return el('optgroup', { label: a.label }, a.datasets.map(function (d) { return el('option', { value: d.id, selected: d.id === c.dataset ? true : null }, d.label); })); }));
    var presets = (cat.dateRangePresets || []).map(function (p) { return typeof p === 'string' ? { v: p, l: p } : { v: p.id, l: p.label }; });
    var dateFields = ds ? ds.fields.filter(function (f) { return f.type === 'date'; }) : [];
    var custom = el('div.rp-row2', { hidden: c.dateRange.preset !== 'custom' },
      field('From', el('input.nx-input', { type: 'date', id: 'f-from', value: c.dateRange.from || '', onchange: function (e) { c.dateRange.from = e.target.value; touch(); } }), 'f-from'),
      field('To', el('input.nx-input', { type: 'date', id: 'f-to', value: c.dateRange.to || '', onchange: function (e) { c.dateRange.to = e.target.value; touch(); } }), 'f-to'));
    var preset = select(presets, c.dateRange.preset, function (v) { c.dateRange.preset = v; custom.hidden = v !== 'custom'; touch(); }, 'Date range', 'f-preset');
    var out = [
      field('Dataset', dsel, 'f-ds', ds && ds.description),
      field('Date range', preset, 'f-preset'), custom
    ];
    if (dateFields.length > 1) out.push(field('Date field', select(dateFields.map(function (f) { return { v: f.id, l: f.label }; }), c.dateRange.field || dateFields[0].id, function (v) { c.dateRange.field = v; touch(); }, 'Date field', 'f-dfield'), 'f-dfield'));
    var fl = S.fleets;
    out.push(el('div.rp-field', el('div.nx-label', { id: 'f-fleets-l' }, 'Fleets'),
      fl.length ? el('div.rp-checklist', { role: 'group', 'aria-labelledby': 'f-fleets-l' }, fl.map(function (f) {
        return check(f.name || f.id, c.fleetIds.indexOf(f.id) > -1, function (on) { var i = c.fleetIds.indexOf(f.id); if (on && i < 0) c.fleetIds.push(f.id); if (!on && i > -1) c.fleetIds.splice(i, 1); touch(); fleetHint.textContent = fleetTxt(); });
      })) : el('div.rp-hint', 'Fleet list unavailable. All fleets are included.'),
      (function () { fleetHint = el('div.rp-hint', fleetTxt()); return fleetHint; })()));
    return out;
    function fleetTxt() { return c.fleetIds.length ? c.fleetIds.length + ' fleet' + (c.fleetIds.length > 1 ? 's' : '') + ' selected' : 'None selected: all fleets'; }
  }
  var fleetHint;

  function secFilters() {
    var c = S.cur.config, ds = curDs(), flds = ds ? ds.fields.filter(function (f) { return f.filterable !== false; }) : [];
    var wrap = el('div.nx-stack');
    c.filters.forEach(function (f, i) { wrap.appendChild(filterRow(f, i, flds)); });
    if (!c.filters.length) wrap.appendChild(el('p.rp-hint', 'No filters: every row in the date range and fleet scope is included.'));
    wrap.appendChild(el('button.nx-btn.nx-btn--sm', { type: 'button', disabled: flds.length ? null : true, onclick: function () {
      var f0 = flds[0]; c.filters.push({ field: f0.id, op: ((S.catalog.filterOps || {})[f0.type] || ['eq'])[0], value: '' }); rebuildSection('filters'); touch(); } }, '+ Add filter'));
    return wrap;
  }
  function filterRow(f, i, flds) {
    var c = S.cur.config, ds = curDs(), fld = fieldOf(ds, f.field) || flds[0], type = fld ? fld.type : 'string';
    var ops = ((S.catalog.filterOps || {})[type] || ['eq']);
    var idp = nid('flt');
    var valHost = el('div');
    function drawVal() { valHost.replaceChildren(valueControl(f, fld, idp + '-v')); }
    var fsel = el('select.rp-select', { id: idp + '-f', 'aria-label': 'Filter ' + (i + 1) + ' field', onchange: function (e) { f.field = e.target.value; var nf = fieldOf(ds, f.field); f.op = ((S.catalog.filterOps || {})[nf.type] || ['eq'])[0]; f.value = ''; rebuildSection('filters'); touch(); } },
      opts(flds.map(function (x) { return { v: x.id, l: x.label }; }), f.field));
    var osel = el('select.rp-select', { id: idp + '-o', 'aria-label': 'Filter ' + (i + 1) + ' operator', onchange: function (e) { f.op = e.target.value; f.value = f.op === 'between' ? ['', ''] : f.op === 'in' ? [] : ''; drawVal(); touch(); } },
      opts(ops.map(function (o) { return { v: o, l: OP_LABEL[o] || o }; }), f.op));
    drawVal();
    return el('div.rp-rowset', el('div.rp-rowset__top', fsel, xbtn('Remove filter ' + (i + 1), function () { c.filters.splice(i, 1); rebuildSection('filters'); touch(); })), osel, valHost);
  }
  function valueControl(f, fld, id) {
    var type = fld ? fld.type : 'string', lab = 'Filter value';
    function set(v) { f.value = v; touch(); }
    if (f.op === 'between') {
      if (!Array.isArray(f.value)) f.value = ['', ''];
      var it = type === 'date' ? 'date' : type === 'number' ? 'number' : 'text';
      var conv = function (v) { return it === 'number' && v !== '' ? Number(v) : v; };
      return el('div.rp-row2', el('input.nx-input', { type: it, id: id, 'aria-label': lab + ' from', value: f.value[0], onchange: function (e) { f.value[0] = conv(e.target.value); touch(); } }),
        el('input.nx-input', { type: it, 'aria-label': lab + ' to', value: f.value[1], onchange: function (e) { f.value[1] = conv(e.target.value); touch(); } }));
    }
    if (type === 'boolean') {
      return select([{ v: '', l: 'Choose…' }, { v: 'true', l: 'Yes' }, { v: 'false', l: 'No' }], f.value === true ? 'true' : f.value === false ? 'false' : '', function (v) { set(v === '' ? '' : v === 'true'); }, lab, id);
    }
    if (type === 'enum') {
      var ev = (fld && fld.enumValues) || [];
      if (f.op === 'in') {
        if (!Array.isArray(f.value)) f.value = [];
        return el('div.rp-checklist', { role: 'group', 'aria-label': lab }, ev.map(function (v) { return check(fmt.label(v), f.value.indexOf(v) > -1, function (on) { var k = f.value.indexOf(v); if (on && k < 0) f.value.push(v); if (!on && k > -1) f.value.splice(k, 1); touch(); }); }));
      }
      return select([{ v: '', l: 'Choose…' }].concat(ev.map(function (v) { return { v: v, l: fmt.label(v) }; })), f.value, set, lab, id);
    }
    if (type === 'number') return el('input.nx-input', { type: 'number', id: id, 'aria-label': lab, value: f.value, step: 'any', onchange: function (e) { set(e.target.value === '' ? '' : Number(e.target.value)); } });
    if (type === 'date') return el('input.nx-input', { type: 'date', id: id, 'aria-label': lab, value: f.value, onchange: function (e) { set(e.target.value); } });
    if (f.op === 'in') return el('input.nx-input', { type: 'text', id: id, 'aria-label': lab + ', comma separated', placeholder: 'value, value', value: Array.isArray(f.value) ? f.value.join(', ') : f.value, onchange: function (e) { set(e.target.value.split(',').map(function (s) { return s.trim(); }).filter(Boolean)); } });
    return el('input.nx-input', { type: 'text', id: id, 'aria-label': lab, value: f.value, onchange: function (e) { set(e.target.value); } });
  }

  function secMetrics() {
    var c = S.cur.config, ds = curDs(), flds = ds ? ds.fields : [];
    var groupable = flds.filter(function (f) { return f.groupable !== false; });
    var out = [];
    out.push(el('div.rp-field', el('div.nx-label', { id: 'gb-l' }, 'Group by'),
      el('div.nx-chips', { role: 'group', 'aria-labelledby': 'gb-l' }, groupable.map(function (f) {
        var on = c.groupBy.indexOf(f.id) > -1;
        return el('button.nx-chip', { type: 'button', 'aria-pressed': on ? 'true' : 'false', onclick: function () { var k = c.groupBy.indexOf(f.id); if (k > -1) c.groupBy.splice(k, 1); else c.groupBy.push(f.id); rebuildSection('metrics'); touch(); } }, f.label);
      })), !groupable.length && el('div.rp-hint', 'This dataset has no groupable fields.')));
    out.push(field('Time bucket', select((S.catalog.timeBuckets || ['none']).map(function (b) { return { v: b, l: BUCKET_LABEL[b] || b }; }), c.timeBucket, function (v) { c.timeBucket = v; touch(); }, 'Time bucket', 'f-bucket')));
    var list = el('div.nx-stack');
    c.metrics.forEach(function (m, i) {
      var fld = m.field === '*' ? null : (fieldOf(ds, m.field) || flds[0]), aggs = (fld && fld.aggregations && fld.aggregations.length) ? fld.aggregations : ['count'];
      if (aggs.indexOf(m.agg) < 0) m.agg = aggs[0];
      list.appendChild(el('div.rp-rowset',
        el('div.rp-rowset__top', select([{ v: '*', l: 'All rows' }].concat(flds.map(function (f) { return { v: f.id, l: f.label }; })), m.field, function (v) { m.field = v; var nf = fieldOf(ds, v), a = (nf && nf.aggregations && nf.aggregations.length) ? nf.aggregations : ['count']; if (a.indexOf(m.agg) < 0) m.agg = a[0]; rebuildSection('metrics'); touch(); }, 'Metric ' + (i + 1) + ' field'),
          xbtn('Remove metric ' + (i + 1), function () { c.metrics.splice(i, 1); rebuildSection('metrics'); touch(); })),
        select(aggs.map(function (a) { return { v: a, l: AGG_LABEL[a] || a }; }), m.agg, function (v) { m.agg = v; touch(); }, 'Metric ' + (i + 1) + ' aggregation'),
        el('input.nx-input', { type: 'text', 'aria-label': 'Metric ' + (i + 1) + ' label', placeholder: 'Label (optional)', value: m.label || '', onchange: function (e) { m.label = e.target.value; touch(); } })));
    });
    if (!c.metrics.length) list.appendChild(el('p.rp-hint', 'No metrics: the report returns row-level detail. Add a metric to aggregate.'));
    list.appendChild(el('button.nx-btn.nx-btn--sm', { type: 'button', disabled: flds.length ? null : true, onclick: function () {
      var f0 = flds.filter(function (f) { return f.aggregations && f.aggregations.length; })[0] || flds[0]; c.metrics.push({ field: f0.id, agg: (f0.aggregations && f0.aggregations[0]) || 'count', label: '' }); rebuildSection('metrics'); touch(); } }, '+ Add metric'));
    out.push(el('div.rp-field', el('div.nx-label', 'Metrics'), list));
    out.push(check('Compare to previous period', !!c.compareTo, function (v) { if (v) c.compareTo = 'previous_period'; else delete c.compareTo; touch(); }));
    return out;
  }

  function secColumns() {
    var c = S.cur.config, ds = curDs(), flds = ds ? ds.fields : [];
    var sel = c.columns.filter(function (id) { return fieldOf(ds, id); });
    var rest = flds.filter(function (f) { return sel.indexOf(f.id) < 0; }).map(function (f) { return f.id; });
    var order = sel.concat(rest);
    var list = el('div.rp-checklist', { style: { maxHeight: '260px' }, role: 'group', 'aria-label': 'Columns' }, order.map(function (id) {
      var f = fieldOf(ds, id), on = sel.indexOf(id) > -1, i = sel.indexOf(id);
      return el('div.rp-colrow', check(f.label, on, function (v) { if (v) c.columns.push(id); else c.columns.splice(c.columns.indexOf(id), 1); rebuildSection('columns'); touch(); }),
        on && xbtn('Move ' + f.label + ' up', function () { move(i, -1); }, i === 0, '↑'),
        on && xbtn('Move ' + f.label + ' down', function () { move(i, 1); }, i === sel.length - 1, '↓'));
    }));
    function move(i, d) { var a = c.columns; var t = a[i]; a[i] = a[i + d]; a[i + d] = t; rebuildSection('columns'); touch(); }
    var out = [el('div.rp-field', el('div.nx-label', 'Show, hide and order columns'), list, el('div.rp-hint', 'Applies to row-level detail. Grouped reports show group and metric columns.'))];
    var sortWrap = el('div.nx-stack');
    var sortOpts = (S.result ? S.result.columns.map(function (x) { return { v: x.id, l: x.label }; }) : flds.filter(function (f) { return f.sortable !== false; }).map(function (f) { return { v: f.id, l: f.label }; }));
    c.sort.forEach(function (s, i) {
      if (!sortOpts.some(function (o) { return o.v === s.field; })) sortOpts = sortOpts.concat([{ v: s.field, l: s.field }]);
      sortWrap.appendChild(el('div.rp-rowset', el('div.rp-rowset__top', select(sortOpts, s.field, function (v) { s.field = v; touch(); }, 'Sort ' + (i + 1) + ' field'), xbtn('Remove sort ' + (i + 1), function () { c.sort.splice(i, 1); rebuildSection('columns'); touch(); })),
        select([{ v: 'desc', l: 'Descending' }, { v: 'asc', l: 'Ascending' }], s.dir || 'desc', function (v) { s.dir = v; touch(); }, 'Sort ' + (i + 1) + ' direction')));
    });
    sortWrap.appendChild(el('button.nx-btn.nx-btn--sm', { type: 'button', onclick: function () { var f0 = sortOpts[0]; if (!f0) return; c.sort.push({ field: f0.v, dir: 'desc' }); rebuildSection('columns'); touch(); } }, '+ Add sort'));
    out.push(el('div.rp-field', el('div.nx-label', 'Sort'), sortWrap));
    out.push(field('Row limit', el('input.nx-input', { type: 'number', id: 'f-limit', min: 1, max: 2000, value: c.limit, onchange: function (e) { var v = Math.max(1, Math.min(2000, Number(e.target.value) || 500)); e.target.value = v; c.limit = v; touch(); } }), 'f-limit', 'Up to 2000 rows'));
    return out;
  }

  function secChart() {
    var ch = S.cur.chart, r = S.result, e = r ? eff() : null;
    var types = (S.catalog.chartTypes || Object.keys(CHART_LABEL));
    var out = [];
    out.push(field('Chart type', select([{ v: '', l: r && r.chart ? 'Auto (' + (CHART_LABEL[r.chart.suggested] || r.chart.suggested) + ')' : 'Auto' }].concat(types.map(function (t) { return { v: t, l: CHART_LABEL[t] || fmt.label(t) }; })), ch.type || '', function (v) { ch.type = v; touch(); renderOutput(); }, 'Chart type', 'f-ctype')));
    if (!r) { out.push(el('p.rp-hint', 'Axes appear after the first successful run.')); return out; }
    var cols = r.columns;
    out.push(field('X axis / category', select(cols.map(function (c) { return { v: c.id, l: c.label }; }), e.x, function (v) { ch.x = v; touch(); renderOutput(); }, 'X axis', 'f-cx'), 'f-cx'));
    var cats = cols.filter(function (c) { return c.type !== 'number' && c.id !== e.x; });
    if (cats.length) out.push(field('Split series by', select([{ v: 'none', l: 'None' }].concat(cats.map(function (c) { return { v: c.id, l: c.label }; })), e.seriesBy || 'none', function (v) { ch.options = Object.assign({}, ch.options, { seriesBy: v }); touch(); renderOutput(); }, 'Split series by', 'f-split'), 'f-split', 'Pivots one numeric series into a line or bar per value (bar, line, area).'));
    var nums = cols.filter(function (c) { return c.type === 'number'; });
    out.push(el('div.rp-field', el('div.nx-label', { id: 'cs-l' }, 'Series (numeric)'), nums.length ? el('div.rp-checklist', { role: 'group', 'aria-labelledby': 'cs-l' }, nums.map(function (c) {
      return check(c.label, e.series.indexOf(c.id) > -1, function (on) { var cur = ch.series && ch.series.length ? ch.series.slice() : e.series.slice(); var k = cur.indexOf(c.id); if (on && k < 0) cur.push(c.id); if (!on && k > -1) cur.splice(k, 1); ch.series = cur; touch(); renderOutput(); });
    })) : el('div.rp-hint', 'No numeric columns in this result.')));
    return out;
  }

  /* ---------------- output ---------------- */
  function renderOutput() {
    var host = document.getElementById('rp-out'); if (!host || !S.cur) return;
    updateHeader();
    if (S.status === 'loading') {
      host.replaceChildren(el('div.nx-card', { 'aria-busy': 'true' }, el('div.nx-card__body.nx-stack', el('span.nx-sr', { role: 'status' }, 'Running report'), el('span.nx-skel.nx-skel--lg.nx-skel--w50'), el('span.nx-skel.nx-skel--block'), el('span.nx-skel'), el('span.nx-skel.nx-skel--w75'), el('span.nx-skel'))));
      return;
    }
    if (S.status === 'error') {
      var e = S.err || {};
      host.replaceChildren(el('div.nx-card', el('div.nx-card__body', el('div.nx-empty', { role: 'alert' }, el('div.nx-empty__icon', '!'), el('div.nx-empty__title', 'Report failed to run'), el('p', emsg(e)), e.data && e.data.field && el('p.nx-mono', 'Field: ' + e.data.field),
        el('button.nx-btn.nx-btn--primary', { type: 'button', onclick: run }, 'Retry')))));
      return;
    }
    var r = S.result; if (!r) { host.replaceChildren(el('div.nx-card', el('div.nx-card__body', NX.empty('Not run yet', 'Choose Apply to run this report.')))); return; }
    var nodes = [];
    var m = r.meta || {}, per = m.period || {};
    nodes.push(el('div.rp-meta.rp-meta--screen', el('span', fmt.number(r.rowCount != null ? r.rowCount : r.rows.length) + ' rows'),
      per.from && el('span', fmt.date(per.from) + ' to ' + fmt.date(per.to)), m.generatedAt && el('span', 'Generated ' + fmt.dateTime(m.generatedAt)), el('span', m.label || 'Synthetic demo data')));
    if (r.truncated) nodes.push(el('div.rp-banner.rp-banner--warn', { role: 'status' }, el('b', 'Truncated.'), 'Showing ' + fmt.number(r.rows.length) + (r.rowCount > r.rows.length ? ' of ' + fmt.number(r.rowCount) : '') + ' rows. Narrow the filters or raise the row limit for the full result.'));
    (m.notes || []).forEach(function (n) { nodes.push(el('div.rp-banner', String(n))); });
    if (!r.rows.length) {
      nodes.push(el('div.nx-card', el('div.nx-card__body', NX.empty('No rows match', 'The report ran successfully but returned nothing. Widen the date range or remove a filter.' + (r.columns.some(function (c) { return c.id === 'denialReason'; }) ? '' : '')))));
      host.replaceChildren.apply(host, nodes); return;
    }
    var kp = kpiTiles(r); if (kp) nodes.push(kp);
    var ef = eff();
    if (ef.type !== 'table') {
      var chartHost = el('div.nx-card__body');
      var cc = r.columns, cr = r.rows, cs = ef.series;
      if (ef.seriesBy && ef.series.length && /^(bar|stacked_bar|line|area)$/.test(ef.type)) { var pv = pivot(r, ef); cc = pv.columns; cr = pv.rows; cs = pv.series; }
      var cmap = {}; cc.forEach(function (c) { cmap[c.id] = c; });
      chartHost.appendChild(window.NXChart.render({ type: ef.type, columns: cc, rows: cr, x: ef.x, series: cs,
        fmt: function (id, v) { return cmap[id] ? cellText(cmap[id], v) : String(v == null ? '—' : v); },
        label: function (id) { var c = cmap[id]; return c ? c.label + (c.unit && c.unit !== 'count' && !/^pv:/.test(id) ? ' (' + c.unit + ')' : '') : id; } }));
      nodes.push(el('div.nx-card', el('div.nx-card__head', el('h2.nx-card__title', 'Chart'), el('span.nx-dim.nx-mono', CHART_LABEL[ef.type] || ef.type)), chartHost));
    }
    nodes.push(buildTable(r));
    host.replaceChildren.apply(host, nodes);
  }

  function kpiTiles(r) {
    if (!r.comparison) return null;
    var tiles = r.columns.filter(function (c) { return c.type === 'number' && r.totals && r.totals[c.id] != null; }).slice(0, 6).map(function (c) {
      var d = deltaInfo(c.id, c.label);
      return el('div.rp-kpi', el('div.rp-kpi__l', c.label), el('div.rp-kpi__v', cellText(c, r.totals[c.id])),
        d ? el('div.rp-delta', el('b', deltaText(d)), ' vs previous period', d.previous != null ? ' (' + cellText(c, d.previous) + ')' : '') : el('div.rp-delta', 'No comparison value'));
    });
    return tiles.length ? el('div.rp-kpis', { 'aria-label': 'Totals compared to previous period' }, tiles) : null;
  }

  function drillLinks(c, row) {
    var id = row[c.id], inc = c.id === 'incidentId' ? id : row.incidentId;
    if (id == null || id === '') return '—';
    if (!inc || (c.id !== 'incidentId' && c.id !== 'claimId')) return String(id);
    var fid = S.scope || row.fleetId;
    var a = el('a', { href: S.scope && fid ? '/fleet/?fleet=' + encodeURIComponent(fid) + '#incident=' + encodeURIComponent(inc) : '/dispatch/#' + encodeURIComponent(inc), title: 'Open incident ' + inc + (S.scope ? ' in the fleet portal' : ' in dispatch') }, String(id));
    if (!S.scope && fid) return el('span', a, ' ', el('a', { href: '/fleet/?fleet=' + encodeURIComponent(fid) + '#incident=' + encodeURIComponent(inc), 'aria-label': 'Open ' + inc + ' in fleet portal', title: 'Open in fleet portal' }, '[fleet]'));
    return a;
  }

  function sortBy(c, curDir) {
    var dir = curDir === 'desc' ? 'asc' : curDir === 'asc' ? 'desc' : (c.type === 'number' ? 'desc' : 'asc');
    if (isRO()) { S.tsort = curDir === 'asc' ? null : { col: c.id, dir: dir }; return renderOutput(); }
    S.cur.config.sort = [{ field: c.id, dir: dir }]; S.tsort = { col: c.id, dir: dir };
    rebuildSection('columns'); touch(); run();
  }

  function buildTable(r) {
    var cols = r.columns, rows = r.rows.slice(), ts = S.tsort;
    if (ts && cols.some(function (c) { return c.id === ts.col; })) {
      var cc = cols.filter(function (c) { return c.id === ts.col; })[0], dir = ts.dir === 'asc' ? 1 : -1;
      rows.sort(function (a, b) {
        var x = a[ts.col], y = b[ts.col];
        if (x == null) return 1; if (y == null) return -1;
        if (cc.type === 'number') return (Number(x) - Number(y)) * dir;
        return String(x).localeCompare(String(y), undefined, { numeric: true }) * dir;
      });
    } else ts = null;
    var prevIdx = null, keyCols = cols.filter(function (c) { return c.type !== 'number' && c.type !== 'date'; });
    var cmpRows = r.comparison && !cols.some(function (c) { return c.id === 'bucket'; }) && r.comparison.rows;
    function prevFor(row, idx) {
      if (!cmpRows) return null;
      if (keyCols.length) { var k = keyCols.map(function (c) { return row[c.id]; }).join('|'); if (!prevIdx) { prevIdx = {}; cmpRows.forEach(function (p) { prevIdx[keyCols.map(function (c) { return p[c.id]; }).join('|')] = p; }); } return prevIdx[k] || null; }
      return cmpRows[r.rows.indexOf(row)] || null;
    }
    var head = el('tr', cols.map(function (c) {
      var on = ts && ts.col === c.id;
      return el('th', { scope: 'col', class: c.type === 'number' ? 'num' : '', 'aria-sort': on ? (ts.dir === 'asc' ? 'ascending' : 'descending') : 'none' },
        el('button.rp-sort', { type: 'button', title: 'Sort by ' + c.label, onclick: function () { sortBy(c, on ? ts.dir : null); } },
          c.label + (c.unit && c.unit !== 'count' && c.type === 'number' ? ' (' + c.unit + ')' : ''), el('span', { 'aria-hidden': 'true' }, on ? (ts.dir === 'asc' ? '▲' : '▼') : '')));
    }));
    var body = rows.map(function (row) {
      var prev = prevFor(row);
      return el('tr', cols.map(function (c) {
        var v = row[c.id], isId = c.id === 'incidentId' || c.id === 'claimId';
        var cell = isId ? drillLinks(c, row) : cellText(c, v);
        var sub = null;
        if (prev && c.type === 'number' && v != null && prev[c.id] != null) {
          var p = Number(prev[c.id]), n = Number(v), d = n - p;
          sub = el('span.rp-cmp', p ? (d > 0 ? '▲ +' : d < 0 ? '▼ ' : '■ ') + (d / Math.abs(p) * 100).toFixed(1) + '% vs prev' : 'prev ' + cellText(c, p));
        }
        return el('td', { class: c.type === 'number' ? 'num' : (isId ? 'id' : 'str') }, cell, sub);
      }));
    });
    var foot = null;
    if (r.totals && Object.keys(r.totals).length) {
      foot = el('tfoot', el('tr', cols.map(function (c, i) {
        var t = r.totals[c.id];
        return el('td', { class: c.type === 'number' ? 'num' : '' }, i === 0 && t == null ? 'Total' : (t != null ? cellText(c, t) : ''));
      })));
    }
    var cap = el('caption.nx-sr', (S.cur.name || 'Report') + ' results');
    return el('div.nx-card.nx-card--flush', el('div.nx-card__head', el('h2.nx-card__title', 'Results'), el('span.nx-dim.nx-mono', fmt.number(rows.length) + ' rows')),
      el('div.rp-tablewrap.nx-table-wrap', { tabindex: '0', role: 'region', 'aria-label': 'Results table, scrollable' }, el('table.nx-table.rp-table', cap, el('thead', head), el('tbody', body), foot)));
  }

  function buildPrintHead() {
    var c = S.cur;
    var lines = function () {
      var cfg = c.config, ds = curDs(), l = [['Dataset', ds ? ds.label : cfg.dataset]];
      var r = S.result, per = r && r.meta && r.meta.period;
      l.push(['Period', per && per.from ? fmt.date(per.from) + ' to ' + fmt.date(per.to) : cfg.dateRange.preset]);
      l.push(['Fleets', cfg.fleetIds.length ? cfg.fleetIds.map(fleetName).join(', ') : 'All fleets']);
      var fl = cfg.filters.filter(filterOk).map(function (f) { var fd = fieldOf(ds, f.field); return (fd ? fd.label : f.field) + ' ' + (OP_LABEL[f.op] || f.op) + ' ' + (Array.isArray(f.value) ? f.value.join(' - ') : String(f.value)); });
      if (fl.length) l.push(['Filters', fl.join('; ')]);
      l.push(['Generated', r && r.meta && r.meta.generatedAt ? fmt.dateTime(r.meta.generatedAt) : new Date().toLocaleString()]);
      return l;
    };
    var dl = el('dl');
    var node = el('div.rp-print-only', el('div.nx-eyebrow', 'Nexus Response / Reports'), el('h2', { id: 'rp-printname' }, c.name),
      el('p', el('b', 'Synthetic demo data.'), ' Simulated environment: figures are seeded for demonstration.'), dl);
    window.addEventListener('beforeprint', function () { dl.replaceChildren.apply(dl, [].concat.apply([], lines().map(function (x) { return [el('dt', x[0]), el('dd', x[1])]; }))); });
    return node;
  }

  /* ---------------- actions ---------------- */
  function chartForSave() {
    var e = S.result ? eff() : { type: S.cur.chart.type || 'table', x: S.cur.chart.x, series: S.cur.chart.series };
    return { type: e.type || 'table', x: e.x || '', series: e.series || [], options: S.cur.chart.options || {} };
  }
  function payload(name, desc) {
    return { name: name, area: S.cur.area || dsArea(S.cur.config.dataset) || S.area, description: desc || '', config: buildReq(S.cur), chart: chartForSave() };
  }
  function afterSave(s, msg) {
    return refreshSaved().then(function () {
      var cfg = normalize(s.config || buildReq(S.cur));
      S.cur.id = s.id; S.cur.name = s.name; S.cur.description = s.description || ''; S.cur.isTemplate = !!s.isTemplate; S.cur.area = s.area || S.cur.area;
      S.cur.chart = Object.assign({ type: '', x: '', series: [], options: {} }, s.chart || S.cur.chart);
      S.area = S.cur.area; mark(); setHash(s.id); NX.toast(msg, 'success'); render();
    });
  }
  function emsg(e) { return (e && e.data && e.data.message) || (e && e.message) || 'Request failed'; }
  function apiErr(e) { NX.toast(emsg(e), 'error'); }
  function doSave() {
    if (!S.cur || isRO()) return;
    if (!S.cur.id) return saveAsModal();
    var b = hdr.btns.save; b.classList.add('is-loading');
    NX.api(API + '/saved/' + encodeURIComponent(S.cur.id), { method: 'PUT', body: payload(S.cur.name, S.cur.description) }).then(function (s) { return afterSave(s, 'Report saved'); }).catch(apiErr).then(function () { b.classList.remove('is-loading'); });
  }
  function formModal(title, fieldsFn, submitLabel, onSubmit, opts) {
    var errBox = el('div.rp-err', { role: 'alert' });
    var form = el('form.rp-form', { novalidate: true, onsubmit: function (e) { e.preventDefault(); go(); } }, fieldsFn(), errBox);
    var ok = el('button.nx-btn.nx-btn--primary' + ((opts && opts.danger) ? '.nx-btn--danger' : ''), { type: 'button', onclick: function () { go(); } }, submitLabel);
    var cancel = el('button.nx-btn', { type: 'button', onclick: function () { m.close(); } }, (opts && opts.cancelLabel) || 'Cancel');
    var m = NX.modal(title, form, { footer: [cancel, (opts && opts.noSubmit) ? null : ok], wide: opts && opts.wide });
    function go() {
      errBox.textContent = ''; ok.classList.add('is-loading');
      Promise.resolve().then(function () { return onSubmit(m, errBox); }).catch(function (e) { errBox.textContent = e.message || 'Failed'; }).then(function () { ok.classList.remove('is-loading'); });
    }
    setTimeout(function () { var f = form.querySelector('input,select,textarea'); if (f) f.focus(); else ok.focus(); }, 30);
    return m;
  }
  function saveAsModal() {
    var n, d;
    formModal('Save report', function () {
      n = el('input.nx-input', { type: 'text', id: 'm-name', value: S.cur.id ? S.cur.name + ' (copy)' : (S.cur.name === 'Untitled report' ? '' : S.cur.name), placeholder: 'Report name', maxlength: 120 });
      d = el('textarea.nx-textarea', { id: 'm-desc', rows: 3, placeholder: 'Optional' }, S.cur.description || '');
      return [field('Name', n, 'm-name'), field('Description', d, 'm-desc')];
    }, 'Save', function (m, err) {
      var name = n.value.trim(); if (!name) { err.textContent = 'Enter a name.'; n.focus(); return; }
      return NX.api(API + '/saved', { method: 'POST', body: payload(name, d.value.trim()) }).then(function (s) { m.close(); return afterSave(s, 'Saved as "' + name + '"'); });
    });
  }
  function doDuplicate() {
    if (!S.cur) return;
    if (!S.cur.id) return saveAsModal();
    NX.api(API + '/saved/' + encodeURIComponent(S.cur.id) + '/duplicate', { method: 'POST', body: {} }).then(function (s) {
      return refreshSaved().then(function () { NX.toast('Duplicated. You can edit this copy.', 'success'); S.forceOpen = true; var f = S.saved.filter(function (x) { return x.id === s.id; })[0] || s; openSaved(f); });
    }).catch(apiErr);
  }
  function renameModal() {
    if (!S.cur || !S.cur.id || isRO()) return;
    var n;
    formModal('Rename report', function () { n = el('input.nx-input', { type: 'text', id: 'm-name', value: S.cur.name, maxlength: 120 }); return [field('Name', n, 'm-name')]; }, 'Rename', function (m, err) {
      var name = n.value.trim(); if (!name) { err.textContent = 'Enter a name.'; return; }
      return NX.api(API + '/saved/' + encodeURIComponent(S.cur.id), { method: 'PUT', body: { name: name } }).then(function (s) { m.close(); S.cur.name = name; return refreshSaved().then(function () { mark(); NX.toast('Renamed', 'success'); render(); }); });
    });
  }
  function deleteModal() {
    if (!S.cur || !S.cur.id || isRO()) return;
    formModal('Delete report', function () { return el('p', 'Delete "' + S.cur.name + '"? Share links already created keep their frozen snapshot. This cannot be undone.'); }, 'Delete', function (m) {
      return NX.api(API + '/saved/' + encodeURIComponent(S.cur.id), { method: 'DELETE' }).then(function () { m.close(); return refreshSaved().then(function () { NX.toast('Report deleted', 'success'); S.cur = null; S.result = null; setHash(''); render(); }); });
    }, { danger: true });
  }
  function doExport(format) {
    var b = hdr.btns[format]; b.classList.add('is-loading');
    var body = Object.assign(buildReq(S.cur), { format: format });
    fetch(API + '/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(function (res) {
      if (!res.ok) return res.text().then(function (t) { var m = t; try { var j = JSON.parse(t); m = j.message || j.error || t; } catch (e) { /* */ } throw new Error(m || 'Export failed'); });
      var cd = res.headers.get('Content-Disposition') || '', mt = cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
      var name = mt ? decodeURIComponent(mt[1]) : 'nexus-' + S.cur.config.dataset + '-' + new Date().toISOString().slice(0, 10) + '-SYNTHETIC.' + format;
      return res.blob().then(function (blob) {
        var url = URL.createObjectURL(blob), a = el('a', { href: url, download: name });
        document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
        NX.toast('Downloaded ' + name, 'success');
      });
    }).catch(apiErr).then(function () { b.classList.remove('is-loading'); });
  }
  function shareModal() {
    if (!S.cur || !S.cur.id) return;
    var out = el('div.nx-stack', el('p.nx-dim', 'Creates a frozen, redacted snapshot of the last saved result. Anyone with the link can view it until it expires.'), NX.skeleton(2));
    var dirty = isDirty();
    var m = NX.modal('Share link', out, { footer: [el('button.nx-btn', { type: 'button', onclick: function () { m.close(); } }, 'Close')] });
    NX.api('/api/insurer/reports', { method: 'POST', body: { kind: 'builder', refId: S.cur.id } }).then(function (r) {
      var url = r.url && /^https?:/.test(r.url) ? r.url : location.origin + (r.url || '/report/' + r.token);
      var input = el('input.nx-input', { type: 'text', readonly: true, id: 'm-link', value: url, 'aria-label': 'Share link', onfocus: function (e) { e.target.select(); } });
      var exp = r.expiresAt ? fmt.date(r.expiresAt) : 'in 30 days';
      out.replaceChildren.apply(out, [
        el('p.nx-dim', 'Frozen, redacted snapshot of "' + S.cur.name + '".'),
        dirty && el('div.rp-banner.rp-banner--warn', 'You have unsaved changes: the link shows the last saved version.'),
        el('div.rp-field', el('label', { for: 'm-link' }, 'Link'), el('div.rp-linkbox', input, el('button.nx-btn', { type: 'button', onclick: function () {
          (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject()).then(function () { NX.toast('Link copied', 'success'); }, function () { input.select(); try { document.execCommand('copy'); NX.toast('Link copied', 'success'); } catch (e) { NX.toast('Press Ctrl/Cmd+C to copy', 'info'); } });
        } }, 'Copy link'))),
        el('p.rp-hint', el('b', 'Expires: '), exp), el('div.rp-badges', el('span.nx-badge.nx-badge--synthetic-data', 'Synthetic demo data'))].filter(Boolean));
      input.focus(); input.select();
    }).catch(function (e) { out.replaceChildren(el('div.rp-err', { role: 'alert' }, 'Could not create the link: ' + e.message), el('button.nx-btn.nx-btn--primary', { type: 'button', onclick: function () { m.close(); shareModal(); } }, 'Retry')); });
  }
  function scheduleModal() {
    if (!S.cur || !S.cur.id) return;
    var cad, rec, form2, list = el('div.nx-stack');
    function loadList() {
      list.replaceChildren(NX.skeleton(1));
      NX.api(API + '/schedules', { query: { savedId: S.cur.id } }).then(function (all) {
        var arr = (Array.isArray(all) ? all : (all && all.schedules) || []).filter(function (s) { return !s.savedId || s.savedId === S.cur.id; });
        list.replaceChildren(arr.length ? el('div.nx-stack', arr.map(function (s) {
          return el('div.rp-rowset', el('div.rp-rowset__top', el('div', el('b', fmt.label(s.cadence)), ' · ' + String(s.format || 'csv').toUpperCase() + ' · ' + (s.recipients || []).join(', ')), xbtn('Remove schedule', function () { NX.api(API + '/schedules/' + encodeURIComponent(s.id), { method: 'DELETE' }).then(loadList).catch(apiErr); })),
            el('div.rp-hint', 'Stored, not sent. Simulated: no email is sent.'));
        })) : el('p.rp-hint', 'No schedules for this report.'));
      }).catch(function (e) { list.replaceChildren(el('div.rp-err', 'Could not load schedules: ' + e.message)); });
    }
    var fmtSel;
    formModal('Schedule report', function () {
      cad = el('select.rp-select', { id: 's-cad' }, opts([{ v: 'daily', l: 'Daily' }, { v: 'weekly', l: 'Weekly' }, { v: 'monthly', l: 'Monthly' }], 'weekly'));
      fmtSel = el('select.rp-select', { id: 's-fmt' }, opts([{ v: 'csv', l: 'CSV' }, { v: 'json', l: 'JSON' }], 'csv'));
      rec = el('input.nx-input', { type: 'text', id: 's-rec', placeholder: 'name@example.com, other@example.com' });
      loadList();
      return [el('div.rp-banner.rp-banner--warn', NX.badge('simulated'), el('b', 'Simulated: no email is sent.'), 'Schedules are stored for the demo only.'),
        field('Cadence', cad, 's-cad'), field('Recipients', rec, 's-rec', 'Comma separated email addresses'), field('Format', fmtSel, 's-fmt'),
        el('div.rp-field', el('div.nx-label', 'Existing schedules'), list)];
    }, 'Add schedule', function (m, err) {
      var emails = rec.value.split(/[,;\s]+/).map(function (s) { return s.trim(); }).filter(Boolean);
      if (!emails.length) { err.textContent = 'Add at least one recipient.'; rec.focus(); return; }
      var bad = emails.filter(function (x) { return !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x); });
      if (bad.length) { err.textContent = 'Not a valid email: ' + bad[0]; rec.focus(); return; }
      return NX.api(API + '/schedules', { method: 'POST', body: { savedId: S.cur.id, cadence: cad.value, recipients: emails, format: fmtSel.value } }).then(function (r) {
        rec.value = ''; loadList(); NX.toast((r && r.note) || 'Schedule stored. Simulated: no email is sent.', 'success');
      });
    }, { cancelLabel: 'Close' });
  }

  loadAll();
})();
