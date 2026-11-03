/* Nexus Response — Records chart helper (inline SVG, no build step).
   RecCharts.line({ title, unit, series:[{key,name,idx,points:[{t,value,n}]}], events:[{t,type,severity,incidentId,label}],
                    markerTabs:bool, onEvent(ev), format(v) }) -> { el, destroy }
   Style matches the insurer charts: mono 10.5px labels, --nx-border grid, theme tokens only.
   Series are distinguished by color AND dash pattern (never color alone). */
(function () {
  'use strict';
  var NS = 'http://www.w3.org/2000/svg';
  var DASH = ['', '7 4', '2 3', '9 3 2 3'];
  var SEV_SHAPE = { critical: 'M0,-6 L6,0 L0,6 L-6,0 Z', high: 'M0,-6 L6,0 L0,6 L-6,0 Z', medium: 'M-5,5 L5,5 L0,-5 Z', low: 'M-4.5,-4.5 H4.5 V4.5 H-4.5 Z' };

  function s(tag, attrs, kids) {
    var n = document.createElementNS(NS, tag);
    Object.keys(attrs || {}).forEach(function (k) { if (attrs[k] != null) n.setAttribute(k, attrs[k]); });
    (kids || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }
  function esc(x) { return String(x == null ? '' : x); }
  function niceTicks(min, max, count) {
    if (!isFinite(min) || !isFinite(max)) return [0, 1];
    if (min === max) { min -= 1; max += 1; }
    var span = max - min, step = Math.pow(10, Math.floor(Math.log10(span / count))), err = (count * step) / span;
    if (err <= .15) step *= 10; else if (err <= .35) step *= 5; else if (err <= .75) step *= 2;
    var a = Math.floor(min / step) * step, b = Math.ceil(max / step) * step, out = [];
    for (var v = a; v <= b + step / 2; v += step) out.push(+v.toFixed(10));
    return out;
  }
  var dFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
  var dFmtY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  function color(i) { return 'var(--rc-s' + ((i || 0) % 4 + 1) + ')'; }

  function line(opt) {
    var series = (opt.series || []).filter(function (x) { return x.points && x.points.length; });
    var events = opt.events || [];
    var fmtV = opt.format || function (v) { return v == null ? '—' : (Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 100) / 100) + (opt.unit && opt.unit.length <= 2 ? opt.unit : ''); };
    var wrap = document.createElement('div');
    wrap.className = 'rc-chart';
    var tip = document.createElement('div'); tip.className = 'rc-tip'; tip.hidden = true; tip.setAttribute('role', 'status');
    var live = document.createElement('div'); live.className = 'nx-sr'; live.setAttribute('aria-live', 'polite');
    wrap.appendChild(tip); wrap.appendChild(live);
    var svg = null, ro = null, lastW = 0, cursor = -1, geo = null;

    var allT = [];
    series.forEach(function (sr) { sr.points.forEach(function (p) { allT.push(+new Date(p.t)); }); });
    allT.sort(function (a, b) { return a - b; });
    var uniqT = allT.filter(function (v, i) { return i === 0 || v !== allT[i - 1]; });

    function showTip(html, x, y) {
      tip.textContent = '';
      html.forEach(function (row) { var d = document.createElement('div'); if (row.cls) d.className = row.cls; if (row.swatch != null) { var i = document.createElement('i'); i.style.setProperty('--c', color(row.swatch)); i.className = 'rc-sw'; i.style.setProperty('--d', DASH[row.swatch % 4] ? '1' : '0'); d.appendChild(i); } d.appendChild(document.createTextNode(row.text)); tip.appendChild(d); });
      tip.hidden = false;
      var w = tip.offsetWidth, W = wrap.clientWidth;
      tip.style.left = Math.max(4, Math.min(W - w - 4, x + 12)) + 'px';
      tip.style.top = Math.max(0, y - 8) + 'px';
    }
    function hideTip() { tip.hidden = true; }

    function valueAt(sr, t) {
      var best = null, bd = Infinity;
      sr.points.forEach(function (p) { var d = Math.abs(+new Date(p.t) - t); if (d < bd) { bd = d; best = p; } });
      return best;
    }
    function setCursor(i, px) {
      if (!geo || !uniqT.length) return;
      cursor = Math.max(0, Math.min(uniqT.length - 1, i));
      var t = uniqT[cursor], x = geo.x(t);
      var g = svg.querySelector('.rc-cursor'); g.setAttribute('x1', x); g.setAttribute('x2', x); g.style.display = '';
      var rows = [{ text: dFmtY.format(new Date(t)), cls: 'rc-tip__h' }], spoken = [dFmtY.format(new Date(t))];
      series.forEach(function (sr) {
        var p = valueAt(sr, t); if (!p) return;
        var line = (series.length > 1 ? sr.name + ': ' : '') + fmtV(p.value) + (p.partial ? ' partial' : '') + (p.n != null ? ' (n=' + p.n + ')' : '');
        rows.push({ text: line, swatch: sr.idx }); spoken.push(line);
      });
      showTip(rows, px != null ? px : x, geo.top + 10);
      live.textContent = (opt.title || 'Chart') + ' ' + spoken.join(', ');
      svg.querySelectorAll('.rc-dot').forEach(function (d) { d.style.display = 'none'; });
      series.forEach(function (sr, si) {
        var p = valueAt(sr, t); var d = svg.querySelector('.rc-dot[data-s="' + si + '"]');
        if (p && d) { d.setAttribute('cx', geo.x(+new Date(p.t))); d.setAttribute('cy', geo.y(p.value)); d.style.display = ''; }
      });
    }
    function clearCursor() {
      cursor = -1; hideTip();
      if (svg) { var g = svg.querySelector('.rc-cursor'); if (g) g.style.display = 'none'; svg.querySelectorAll('.rc-dot').forEach(function (d) { d.style.display = 'none'; }); }
    }

    function render() {
      var W = Math.max(260, wrap.clientWidth || 600), H = W < 480 ? 190 : 230;
      lastW = W;
      if (svg) svg.remove();
      var L = 46, R = 12, T = 10, B = events.length ? 46 : 28;
      var pw = W - L - R, ph = H - T - B;
      var t0 = uniqT[0], t1 = uniqT[uniqT.length - 1]; if (t0 === t1) { t0 -= 864e5; t1 += 864e5; }
      var vmin = Infinity, vmax = -Infinity;
      series.forEach(function (sr) { sr.points.forEach(function (p) { if (p.value != null) { vmin = Math.min(vmin, p.value); vmax = Math.max(vmax, p.value); } }); });
      var ticks = niceTicks(vmin, vmax, 4);
      var y0 = ticks[0], y1 = ticks[ticks.length - 1];
      var x = function (t) { return L + (t - t0) / (t1 - t0) * pw; };
      var y = function (v) { return T + ph - (v - y0) / (y1 - y0) * ph; };
      geo = { x: x, y: y, top: T };
      svg = s('svg', { 'class': 'rc-svg ins-svg', width: W, height: H, viewBox: '0 0 ' + W + ' ' + H, role: 'application', 'aria-roledescription': 'line chart', 'aria-label': (opt.title || 'Chart') + '. Use left and right arrow keys to read values; a table view is available.', tabindex: '0' });
      ticks.forEach(function (v) {
        svg.appendChild(s('line', { 'class': 'grid', x1: L, x2: W - R, y1: y(v), y2: y(v) }));
        var tx = s('text', { x: L - 6, y: y(v) + 3.5, 'text-anchor': 'end' }); tx.textContent = fmtV(v).replace(/%$/, ''); svg.appendChild(tx);
      });
      svg.appendChild(s('line', { 'class': 'axis', x1: L, x2: W - R, y1: T + ph, y2: T + ph }));
      var nx = Math.max(2, Math.min(6, Math.floor(pw / 90)));
      for (var i = 0; i <= nx; i++) {
        var tt = t0 + (t1 - t0) * i / nx;
        var lb = s('text', { x: x(tt), y: T + ph + 15, 'text-anchor': i === 0 ? 'start' : i === nx ? 'end' : 'middle' }); lb.textContent = dFmt.format(new Date(tt)); svg.appendChild(lb);
      }
      var pMax = null;
      series.forEach(function (sr) { sr.points.forEach(function (p) { if (p.partial) pMax = Math.max(pMax || 0, +new Date(p.t)); }); });
      if (pMax != null) {
        var px1 = Math.min(x(pMax), L + pw);
        svg.insertBefore(s('rect', { 'class': 'rc-partial', x: L, y: T, width: Math.max(0, px1 - L), height: ph }), svg.firstChild);
        var pl = s('text', { x: L + 4, y: T + 10 }); pl.textContent = 'partial window'; svg.appendChild(pl);
      }
      series.forEach(function (sr) {
        var pts = sr.points.filter(function (p) { return p.value != null; });
        if (!pts.length) return;
        var d = pts.map(function (p, k) { return (k ? 'L' : 'M') + x(+new Date(p.t)).toFixed(1) + ',' + y(p.value).toFixed(1); }).join('');
        svg.appendChild(s('path', { 'class': 'rc-line', d: d, fill: 'none', stroke: color(sr.idx), 'stroke-dasharray': DASH[(sr.idx || 0) % 4] || null }));
        pts.forEach(function (p) { if (pts.length <= 40 || p.partial) svg.appendChild(s('circle', { 'class': 'rc-pt' + (p.partial ? ' is-partial' : ''), cx: x(+new Date(p.t)), cy: y(p.value), r: p.partial ? 3.2 : 2.5, fill: p.partial ? 'var(--nx-surface)' : color(sr.idx), stroke: p.partial ? color(sr.idx) : null, 'stroke-width': p.partial ? 1.5 : null })); });
      });
      svg.appendChild(s('line', { 'class': 'rc-cursor', y1: T, y2: T + ph, style: 'display:none' }));
      series.forEach(function (sr, si) { svg.appendChild(s('circle', { 'class': 'rc-dot', 'data-s': si, r: 5, fill: color(sr.idx), style: 'display:none' })); });
      // event markers
      events.forEach(function (ev, k) {
        var te = +new Date(ev.t); if (te < t0 || te > t1) return;
        var ex = x(te), ey = T + ph + 34, sev = ev.severity || 'low';
        svg.appendChild(s('line', { 'class': 'rc-evline', x1: ex, x2: ex, y1: T, y2: T + ph }));
        var label = esc(ev.type ? NX.fmt.label(ev.type) : 'Event') + ', ' + sev + ', ' + dFmtY.format(new Date(te)) + (ev.label ? ': ' + ev.label : '') + (ev.incidentId ? '. Press Enter to open incident.' : '');
        var g = s('g', { 'class': 'rc-ev', transform: 'translate(' + ex + ',' + ey + ')', role: ev.incidentId ? 'button' : 'img', 'aria-label': label, tabindex: opt.markerTabs !== false ? '0' : null, 'aria-hidden': opt.markerTabs === false ? 'true' : null }, [
          s('path', { d: SEV_SHAPE[sev] || SEV_SHAPE.low, fill: 'var(--nx-sev-' + (SEV_SHAPE[sev] ? sev : 'low') + ')', stroke: 'var(--nx-surface)', 'stroke-width': 1.5 }),
          s('circle', { r: 11, fill: 'transparent' })
        ]);
        var show = function () { svg.classList.add('is-ev'); showTip([{ text: dFmtY.format(new Date(te)), cls: 'rc-tip__h' }, { text: NX.fmt.label(ev.type || 'event') + ' / ' + sev }, ev.label ? { text: ev.label } : null].filter(Boolean), ex, ey - 40); };
        g.addEventListener('mouseenter', show); g.addEventListener('focus', show);
        g.addEventListener('mouseleave', hideTip); g.addEventListener('blur', hideTip);
        if (ev.incidentId && opt.onEvent) {
          g.addEventListener('click', function () { opt.onEvent(ev); });
          g.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); opt.onEvent(ev); } });
        }
        svg.appendChild(g);
      });
      if (events.length) { var el = s('text', { x: L - 6, y: T + ph + 38, 'text-anchor': 'end' }); el.textContent = 'Events'; svg.appendChild(el); }
      // hit area
      var hit = s('rect', { x: L, y: T, width: pw, height: ph, fill: 'transparent', 'class': 'rc-hit' });
      hit.addEventListener('mousemove', function (e) {
        var r = svg.getBoundingClientRect(), px = e.clientX - r.left, t = t0 + (px - L) / pw * (t1 - t0), bi = 0, bd = Infinity;
        uniqT.forEach(function (u, i) { var d = Math.abs(u - t); if (d < bd) { bd = d; bi = i; } });
        setCursor(bi, px);
      });
      hit.addEventListener('mouseleave', clearCursor);
      svg.insertBefore(hit, svg.querySelector('.rc-ev'));
      svg.addEventListener('keydown', function (e) {
        if (e.target !== svg) return;
        if (e.key === 'ArrowRight') { e.preventDefault(); setCursor(cursor < 0 ? 0 : cursor + 1); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); setCursor(cursor < 0 ? uniqT.length - 1 : cursor - 1); }
        else if (e.key === 'Home') { e.preventDefault(); setCursor(0); }
        else if (e.key === 'End') { e.preventDefault(); setCursor(uniqT.length - 1); }
        else if (e.key === 'Escape') clearCursor();
      });
      svg.addEventListener('blur', clearCursor);
      wrap.insertBefore(svg, tip);
      cursor = -1;
    }
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(function () { if (Math.abs((wrap.clientWidth || 0) - lastW) > 2 && wrap.clientWidth) render(); });
      ro.observe(wrap);
    }
    setTimeout(function () { if (!svg && wrap.isConnected) render(); }, 0);
    return { el: wrap, render: render, destroy: function () { if (ro) ro.disconnect(); } };
  }
  window.RecCharts = { line: line, color: color, dash: DASH };
})();
