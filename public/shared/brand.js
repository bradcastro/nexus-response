/* Nexus Response — brand.js  (vanilla helpers, exposes window.NX)
   Include in <head> (so the saved theme applies before first paint):
   <script src="/shared/brand.js"></script>                                   */
(function () {
  'use strict';
  var NX = (window.NX = window.NX || {});
  var KEY = 'nx-theme';

  /* ---------------- theme ---------------- */
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
  var theme = {
    get: function () {
      var t = document.documentElement.getAttribute('data-theme');
      if (t) return t;
      return window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    },
    set: function (t, persist) {
      document.documentElement.setAttribute('data-theme', t);
      if (persist !== false) lsSet(KEY, t);
      document.querySelectorAll('[data-nx-theme-toggle]').forEach(function (b) {
        var icon = b.querySelector('.nx-theme-btn__icon');
        var next = t === 'dark' ? 'light' : 'dark';
        if (icon) icon.textContent = t === 'dark' ? '☀' : '☾';
        else b.textContent = t === 'dark' ? '☀' : '☾';
        b.title = 'Color theme. Switch to ' + next + '. This does not show whether the server is connected.';
        b.setAttribute('aria-label', 'Color theme, currently ' + t + '. Switch to ' + next + '.');
      });
      document.dispatchEvent(new CustomEvent('nx:theme', { detail: t }));
    },
    toggle: function () { theme.set(theme.get() === 'dark' ? 'light' : 'dark'); },
    /* portals can declare a default (e.g. light for fleet/insurer) that applies only if the user never chose */
    defaultTo: function (t) { if (!lsGet(KEY)) theme.set(t, false); }
  };
  NX.theme = theme;
  var saved = lsGet(KEY);
  if (saved === 'dark' || saved === 'light') document.documentElement.setAttribute('data-theme', saved);

  /* ---------------- DOM builder ---------------- */
  // NX.el('div.card#id', {class:'x', dataset:{a:1}, style:{}, onclick:fn, html:'<b>'}, child, 'text', [children])
  function el(tag, attrs) {
    var m = String(tag || 'div').match(/^([a-zA-Z0-9-]*)((?:[.#][\w-]+)*)$/) || [];
    var node = document.createElement(m[1] || 'div');
    (m[2] || '').replace(/([.#])([\w-]+)/g, function (_, t, n) { if (t === '.') node.classList.add(n); else node.id = n; return ''; });
    var start = 1;
    if (attrs && typeof attrs === 'object' && !(attrs instanceof Node) && !Array.isArray(attrs)) {
      start = 2;
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v == null || v === false) return;
        if (k === 'class' || k === 'className') node.className += (node.className ? ' ' : '') + (Array.isArray(v) ? v.filter(Boolean).join(' ') : v);
        else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
        else if (k === 'dataset') Object.keys(v).forEach(function (d) { node.dataset[d] = v[d]; });
        else if (k === 'html') node.innerHTML = v;
        else if (k === 'text') node.textContent = v;
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
        else if (v === true) node.setAttribute(k, '');
        else node.setAttribute(k, v);
      });
    }
    (function add(list) {
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (c == null || c === false) continue;
        if (Array.isArray(c)) add(c);
        else node.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
      }
    })(Array.prototype.slice.call(arguments, start));
    return node;
  }
  NX.el = el;
  NX.esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };

  /* ---------------- formatting ---------------- */
  function toDate(v) { return v instanceof Date ? v : new Date(v); }
  var fmt = {
    ago: function (v) {
      var d = toDate(v), s = Math.round((Date.now() - d.getTime()) / 1000);
      if (isNaN(s)) return '—';
      if (s < 0) return 'in ' + fmt.ago(new Date(Date.now() + (Date.now() - d.getTime()))).replace(' ago', '');
      if (s < 10) return 'just now';
      if (s < 60) return s + 's ago';
      if (s < 3600) return Math.floor(s / 60) + 'm ago';
      if (s < 86400) return Math.floor(s / 3600) + 'h ago';
      if (s < 86400 * 30) return Math.floor(s / 86400) + 'd ago';
      return fmt.date(d);
    },
    number: function (n, digits) { return n == null || isNaN(n) ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: digits == null ? 0 : digits }); },
    compact: function (n) { return n == null ? '—' : Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n); },
    currency: function (n, digits) { return n == null || isNaN(n) ? '—' : Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: digits == null ? 0 : digits }); },
    pct: function (n, digits) { return n == null || isNaN(n) ? '—' : Number(n).toFixed(digits == null ? 0 : digits) + '%'; },
    date: function (v) { var d = toDate(v); return isNaN(d) ? '—' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); },
    time: function (v) { var d = toDate(v); return isNaN(d) ? '—' : d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }); },
    dateTime: function (v) { var d = toDate(v); return isNaN(d) ? '—' : d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }); },
    duration: function (min) { if (min == null) return '—'; return min < 60 ? Math.round(min) + ' min' : Math.floor(min / 60) + 'h ' + Math.round(min % 60) + 'm'; },
    label: function (s) { return String(s == null ? '' : s).replace(/_/g, ' ').replace(/^./, function (c) { return c.toUpperCase(); }); }
  };
  NX.fmt = fmt;

  /* ---------------- colors / badges ---------------- */
  var SEV = ['critical', 'high', 'medium', 'low'];
  var STATUS = ['pending', 'validating', 'dispatched', 'en_route', 'on_scene', 'resolved', 'dismissed'];
  NX.severities = SEV; NX.statuses = STATUS;
  // returns a CSS color string that follows the active theme (usable in canvas via getComputedStyle, in SVG/inline style as var())
  NX.sevColor = function (sev, resolved) {
    var v = 'var(--nx-sev-' + (SEV.indexOf(sev) > -1 ? sev : 'low') + ')';
    return resolved ? getComputedStyle(document.documentElement).getPropertyValue(v.slice(4, -1)).trim() : v;
  };
  NX.statusColor = function (st, resolved) {
    var v = 'var(--nx-st-' + (STATUS.indexOf(st) > -1 ? st : 'pending') + ')';
    return resolved ? getComputedStyle(document.documentElement).getPropertyValue(v.slice(4, -1)).trim() : v;
  };
  // NX.badge('critical') / NX.badge('en_route') / NX.badge('Verified','ok') -> element
  // Capability kinds ("what is real"): NX.badge('simulated'), NX.badge('working_verified'), ...
  var CAP = {
    working_verified: { g: '\u2713', label: 'Working & verified', desc: 'Exercised end to end and checked by tests or inspection.' },
    working_synthetic: { g: '\u25D0', label: 'Working, synthetic data', desc: 'The code path runs for real, but the inputs are seeded or generated demo data.' },
    simulated: { g: '\u25B7', label: 'Simulated action', desc: 'The outcome is faked in the demo: nothing is sent to a real person, carrier or OEM.' },
    planned: { g: '\u25CB', label: 'Planned / needs integration', desc: 'Not built, or blocked on a real partner integration or specification.' }
  };
  var CAP_ALIAS = { verified: 'working_verified', working: 'working_verified', synthetic: 'working_synthetic', working_with_synthetic_data: 'working_synthetic', simulate: 'simulated', needs_integration: 'planned', integration: 'planned' };
  NX.capabilities = CAP;
  NX.capKind = function (v) { v = String(v == null ? '' : v).toLowerCase().replace(/[^a-z]+/g, '_'); return CAP[v] ? v : (CAP_ALIAS[v] || null); };
  NX.capBadge = function (kind, text) {
    var k = NX.capKind(kind) || 'planned';
    return el('span', { class: 'nx-badge nx-badge--cap nx-badge--' + k, title: CAP[k].desc }, el('span.nx-badge__g', { 'aria-hidden': 'true' }, CAP[k].g), text || CAP[k].label);
  };
  // four-badge legend (each with its one-line meaning)
  NX.capLegend = function () {
    return el('ul.nx-cap-legend', Object.keys(CAP).map(function (k) { return el('li', NX.capBadge(k), CAP[k].desc); }));
  };
  NX.badge = function (value, variant) {
    var v = String(value == null ? '' : value);
    if (!variant && NX.capKind(v)) return NX.capBadge(v);
    var key = variant || v;
    return el('span', { class: 'nx-badge nx-badge--' + key.replace(/[^\w]/g, '_') }, fmt.label(v));
  };
  NX.badgeHTML = function (value, variant) { return NX.badge(value, variant).outerHTML; };

  /* ---------------- toast ---------------- */
  NX.toast = function (msg, type, ms) {
    var host = document.querySelector('.nx-toasts') || document.body.appendChild(el('div.nx-toasts', { role: 'status', 'aria-live': 'polite' }));
    var t = el('div', { class: 'nx-toast nx-toast--' + (type || 'info') }, el('div.nx-grow', msg instanceof Node ? msg : String(msg)));
    host.appendChild(t);
    var kill = function () { t.classList.add('is-leaving'); setTimeout(function () { t.remove(); }, 220); };
    t.addEventListener('click', kill);
    if (ms !== 0) setTimeout(kill, ms || (type === 'error' ? 6500 : 4000));
    return t;
  };

  /* ---------------- api ---------------- */
  // NX.api('/api/incidents', {query:{status:'pending'}}) | NX.api(path,{method:'POST', body:{...}})
  // resolves parsed JSON; rejects Error with .status/.data. Pass {toast:true} to auto-toast failures.
  NX.api = function (path, opts) {
    opts = opts || {};
    var url = path;
    if (opts.query) {
      var q = Object.keys(opts.query).filter(function (k) { return opts.query[k] != null && opts.query[k] !== ''; })
        .map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(opts.query[k]); }).join('&');
      if (q) url += (url.indexOf('?') > -1 ? '&' : '?') + q;
    }
    var init = { method: opts.method || (opts.body != null ? 'POST' : 'GET'), headers: Object.assign({ Accept: 'application/json' }, opts.headers || {}) };
    if (opts.body != null) { init.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body); init.headers['Content-Type'] = 'application/json'; }
    return fetch(url, init).then(function (res) {
      return res.text().then(function (txt) {
        var data = null; try { data = txt ? JSON.parse(txt) : null; } catch (e) { data = txt; }
        if (!res.ok) {
          var err = new Error((data && (data.error || data.message)) || res.status + ' ' + res.statusText);
          err.status = res.status; err.data = data; throw err;
        }
        return data;
      });
    }).catch(function (err) {
      if (!err.status) err.message = 'Cannot reach Nexus backend (' + err.message + ')';
      if (opts.toast) NX.toast(err.message, 'error');
      throw err;
    });
  };

  /* ---------------- SSE with auto-reconnect ---------------- */
  // NX.sse('/api/stream', function(data, type){...}, {events:['incident'], onStatus:fn(bool)})
  NX.sse = function (url, onEvent, opts) {
    opts = opts || {};
    var names = opts.events || ['incident'], es, closed = false, retry = 0, timer;
    function status(ok) { NX.setLive(ok ? 'live' : 'reconnecting'); if (opts.onStatus) opts.onStatus(ok); }
    function handle(type) { return function (ev) { var d = ev.data; try { d = JSON.parse(ev.data); } catch (e) { /* raw */ } onEvent(d, type, ev); }; }
    function connect() {
      if (closed) return;
      try { es = new EventSource(url); } catch (e) { return schedule(); }
      es.onopen = function () { retry = 0; status(true); };
      es.onerror = function () { status(false); try { es.close(); } catch (e) { /* */ } schedule(); };
      es.onmessage = handle('message');
      names.forEach(function (n) { es.addEventListener(n, handle(n)); });
    }
    function schedule() { if (closed) return; clearTimeout(timer); timer = setTimeout(connect, Math.min(15000, 1000 * Math.pow(1.6, retry++))); }
    connect();
    return { close: function () { closed = true; clearTimeout(timer); if (es) es.close(); NX.setLive('off'); } };
  };

  /* ---------------- live indicator ---------------- */
  // state: 'checking' | 'live' | 'reconnecting' | 'off'
  // Connection to this server. Not a data-quality flag and not the theme control.
  var LIVE_LABEL = { checking: 'Checking', live: 'Live', reconnecting: 'Reconnecting', off: 'Offline' };
  NX.setLive = function (state) {
    document.querySelectorAll('[data-nx-live]').forEach(function (n) {
      var dot = n.querySelector('.nx-live-dot'), txt = n.querySelector('.nx-live__text');
      if (!dot || !txt) return;
      var kind = state === 'live' ? '' : state === 'reconnecting' ? ' nx-live-dot--warn' : state === 'checking' ? ' nx-live-dot--wait' : ' nx-live-dot--off';
      dot.className = 'nx-live-dot' + kind;
      txt.textContent = LIVE_LABEL[state] || 'Offline';
      n.setAttribute('aria-label', 'Connection: ' + (LIVE_LABEL[state] || 'Offline'));
    });
  };

  /* ---------------- topbar ---------------- */
  var PORTALS = [['Dispatch', '/dispatch/'], ['Fleet', '/fleet/'], ['Insurer', '/insurer/'], ['Onboarding', '/onboarding/'], ['Reports', '/reports/'], ['Records', '/records/'], ['Tour', '/tour/']];
  // NX.topbar('Dispatch', {mount:'#nx-topbar'|Element, sidebar:true, live:true, right:[Node...]}) -> <header class="nx-topbar">
  // Mounts by replacing #nx-topbar, else prepends to .nx-app, else body.
  NX.topbar = function (portalName, opts) {
    opts = opts || {};
    var cur = String(portalName || '').toLowerCase();
    var bar = el('header.nx-topbar',
      opts.sidebar !== false && el('button.nx-icon-btn.nx-sidebar-toggle', { 'aria-label': 'Menu', onclick: function () { var s = document.querySelector('.nx-sidebar'); if (s) s.classList.toggle('is-open'); } }, '☰'),
      el('a.nx-brand', { href: '/', 'aria-label': 'Nexus Response home' }, el('img', { src: '/shared/logo-mark.svg', alt: '' }), el('span.nx-brand__name', 'NEXUS', el('b', ' / RESPONSE'))),
      portalName && el('span.nx-portal-name', portalName),
      el('nav.nx-switcher', { 'aria-label': 'Portals' }, PORTALS.map(function (p) {
        return el('a', { href: p[1], 'aria-current': p[0].toLowerCase() === cur ? 'page' : null }, p[0]);
      })),
      el('div.nx-topbar__right',
        opts.right,
        opts.live !== false && el('span.nx-live', { 'data-nx-live': '', role: 'status', title: 'Connection to this server' }, el('span.nx-live-dot.nx-live-dot--wait', { 'aria-hidden': 'true' }), el('span.nx-live__text', 'Checking')),
        el('button.nx-theme-btn', { type: 'button', 'data-nx-theme-toggle': '', 'aria-label': 'Color theme', title: 'Color theme', onclick: theme.toggle }, el('span.nx-theme-btn__icon', { 'aria-hidden': 'true' }, '☾'), el('span.nx-theme-btn__label', 'Theme')))
    );
    var mount = typeof opts.mount === 'string' ? document.querySelector(opts.mount) : opts.mount;
    mount = mount || document.getElementById('nx-topbar');
    function place() {
      if (mount) mount.replaceWith(bar);
      else (document.querySelector('.nx-app') || document.body).prepend(bar);
      theme.set(theme.get(), false);
    }
    if (document.body) place(); else document.addEventListener('DOMContentLoaded', place);
    return bar;
  };

  /* ---------------- misc helpers ---------------- */
  // NX.tabs(rootEl) wires .nx-tab[data-tab] to .nx-tabpanel[data-panel]
  NX.tabs = function (root) {
    var tabs = root.querySelectorAll('.nx-tab'), panels = root.querySelectorAll('.nx-tabpanel');
    function show(id) {
      tabs.forEach(function (t) { var on = t.dataset.tab === id; t.classList.toggle('is-active', on); t.setAttribute('aria-selected', on); });
      panels.forEach(function (p) { p.hidden = p.dataset.panel !== id; });
    }
    tabs.forEach(function (t) { t.addEventListener('click', function () { show(t.dataset.tab); }); });
    if (tabs[0]) show((root.querySelector('.nx-tab.is-active') || tabs[0]).dataset.tab);
    return { show: show };
  };
  // NX.modal(titleNodeOrText, bodyNode, {footer:[btns], wide:true}) -> {close, el}
  NX.modal = function (title, body, opts) {
    opts = opts || {};
    var bd = el('div.nx-modal-backdrop', { onclick: function (e) { if (e.target === bd) close(); } },
      el('div', { class: 'nx-modal' + (opts.wide ? ' nx-modal--wide' : ''), role: 'dialog', 'aria-modal': 'true' },
        el('div.nx-modal__head', el('h3.nx-grow', title), el('button.nx-icon-btn', { 'aria-label': 'Close', onclick: function () { close(); } }, '✕')),
        el('div.nx-modal__body', body),
        opts.footer && el('div.nx-modal__foot', opts.footer)));
    function esc(e) { if (e.key === 'Escape') close(); }
    function close() { bd.remove(); document.removeEventListener('keydown', esc); }
    document.addEventListener('keydown', esc);
    document.body.appendChild(bd);
    return { close: close, el: bd };
  };
  NX.skeleton = function (rows) { var w = el('div.nx-stack'); for (var i = 0; i < (rows || 3); i++) w.appendChild(el('span', { class: 'nx-skel' + (i % 2 ? ' nx-skel--w75' : '') })); return w; };
  NX.empty = function (title, text, icon) { return el('div.nx-empty', el('div.nx-empty__icon', icon || '◎'), el('div.nx-empty__title', title), text && el('p', text)); };
  NX.PORTALS = PORTALS;

  document.addEventListener('DOMContentLoaded', function () { theme.set(theme.get(), false); });
})();
