/* Nexus Response reports: tiny inline-SVG chart helper (no dependencies).
   NXChart.render({type, columns, rows, x, series, fmt(colId, v), label(colId)}) -> Element
   Types: bar, stacked_bar, line, area, pie, scatter. Colors come from --rp-c0..--rp-c7 (reports.css). */
(function () {
  'use strict';
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var col = function (i) { return 'var(--rp-c' + (i % 8) + ')'; };
  var num = function (v) { return typeof v === 'number' && isFinite(v) ? v : (v != null && v !== '' && isFinite(Number(v)) ? Number(v) : null); };

  function niceTicks(min, max, n) {
    if (min === max) { max = min + 1; }
    var span = max - min, step = Math.pow(10, Math.floor(Math.log10(span / n))), err = span / n / step;
    step *= err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1;
    var lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step, t = [];
    for (var v = lo; v <= hi + step / 2; v += step) t.push(Math.round(v / step) * step);
    return t;
  }
  function short(v) {
    var a = Math.abs(v);
    if (a >= 1000) return Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(v);
    return String(Math.round(v * 100) / 100);
  }
  function catLabel(v, type) {
    if (v == null || v === '') return '—';
    var s = String(v);
    if ((type === 'date' || type === 'string') && /^\d{4}-\d{2}-\d{2}/.test(s)) {
      var d = new Date(s.length === 10 ? s + 'T00:00:00' : s);
      if (!isNaN(d)) return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }
    return s.replace(/_/g, ' ');
  }
  function trunc(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function legend(items) {
    return '<ul class="rp-legend">' + items.map(function (it) {
      return '<li><i style="background:' + it.color + '"></i>' + esc(it.label) + (it.extra ? ' <span class="nx-mono">' + esc(it.extra) + '</span>' : '') + '</li>';
    }).join('') + '</ul>';
  }

  function cartesian(o, cols, cats, series) {
    var W = 720, H = 320, m = { l: 54, r: 14, t: 12, b: 58 }, type = o.type, stacked = type === 'stacked_bar';
    var N = cats.length, vals = series.map(function (s) { return o.rows.map(function (r) { return num(r[s]); }); });
    var lo = 0, hi = 0;
    if (stacked) {
      for (var i = 0; i < N; i++) { var pos = 0, neg = 0; vals.forEach(function (v) { var x = v[i] || 0; if (x >= 0) pos += x; else neg += x; }); hi = Math.max(hi, pos); lo = Math.min(lo, neg); }
    } else vals.forEach(function (v) { v.forEach(function (x) { if (x != null) { hi = Math.max(hi, x); lo = Math.min(lo, x); } }); });
    if (type === 'line' && lo > 0) { lo = Math.min.apply(null, [].concat.apply([], vals).filter(function (x) { return x != null; })); lo = lo - (hi - lo) * 0.1; }
    var ticks = niceTicks(lo, hi || 1, 5), y0 = ticks[0], y1 = ticks[ticks.length - 1];
    var iw = W - m.l - m.r, ih = H - m.t - m.b, band = iw / Math.max(N, 1);
    var Y = function (v) { return m.t + ih - (v - y0) / ((y1 - y0) || 1) * ih; };
    var g = '';
    ticks.forEach(function (t) { g += '<line class="grid" x1="' + m.l + '" x2="' + (W - m.r) + '" y1="' + Y(t).toFixed(1) + '" y2="' + Y(t).toFixed(1) + '"/><text x="' + (m.l - 8) + '" y="' + (Y(t) + 3.5).toFixed(1) + '" text-anchor="end">' + short(t) + '</text>'; });
    g += '<line class="axis" x1="' + m.l + '" x2="' + (W - m.r) + '" y1="' + Y(0).toFixed(1) + '" y2="' + Y(0).toFixed(1) + '"/>';
    var every = Math.max(1, Math.ceil(N / Math.max(2, Math.floor(iw / 62)))), rot = N > 6 && band < 70;
    var xt = cols[o.x] ? cols[o.x].type : 'string', X = function (i) { return m.l + band * (i + 0.5); }, marks = '';
    cats.forEach(function (c, i) {
      if (i % every) return;
      var lab = trunc(catLabel(c, xt), rot ? 14 : 12), x = X(i);
      g += rot ? '<text transform="translate(' + x.toFixed(1) + ' ' + (H - m.b + 14) + ') rotate(-35)" text-anchor="end">' + esc(lab) + '</text>' : '<text x="' + x.toFixed(1) + '" y="' + (H - m.b + 16) + '" text-anchor="middle">' + esc(lab) + '</text>';
    });
    function tip(si, i) { return catLabel(cats[i], xt) + ' — ' + o.label(series[si]) + ': ' + o.fmt(series[si], vals[si][i]); }
    if (type === 'bar' || stacked) {
      var inner = Math.min(band * 0.78, stacked ? 56 : 64), bw = stacked ? inner : inner / series.length;
      for (var i2 = 0; i2 < N; i2++) {
        var pp = 0, nn = 0;
        series.forEach(function (s, si) {
          var v = vals[si][i2]; if (v == null) return;
          var a, b, x;
          if (stacked) { x = X(i2) - bw / 2; if (v >= 0) { a = pp; pp += v; b = pp; } else { a = nn; nn += v; b = nn; } }
          else { x = X(i2) - inner / 2 + si * bw; a = 0; b = v; }
          var top = Y(Math.max(a, b)), h = Math.max(1, Math.abs(Y(a) - Y(b)));
          marks += '<rect class="mk" tabindex="0" role="img" aria-label="' + esc(tip(si, i2)) + '" x="' + x.toFixed(1) + '" y="' + top.toFixed(1) + '" width="' + Math.max(1, bw - (stacked ? 0 : 1)).toFixed(1) + '" height="' + h.toFixed(1) + '" rx="2" style="fill:' + col(si) + '"><title>' + esc(tip(si, i2)) + '</title></rect>';
        });
      }
    } else {
      series.forEach(function (s, si) {
        var pts = [], segs = [];
        vals[si].forEach(function (v, i) { if (v == null) { if (pts.length) segs.push(pts); pts = []; } else pts.push([X(i), Y(v), i]); });
        if (pts.length) segs.push(pts);
        segs.forEach(function (seg) {
          var d = seg.map(function (p, k) { return (k ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join('');
          if (type === 'area') marks += '<path d="' + d + 'L' + seg[seg.length - 1][0].toFixed(1) + ' ' + Y(0).toFixed(1) + 'L' + seg[0][0].toFixed(1) + ' ' + Y(0).toFixed(1) + 'Z" style="fill:' + col(si) + ';fill-opacity:.2"/>';
          marks += '<path d="' + d + '" fill="none" stroke-width="2" stroke-linejoin="round" style="stroke:' + col(si) + '"/>';
        });
        if (N <= 60) vals[si].forEach(function (v, i) {
          if (v == null) return;
          marks += '<circle class="mk" tabindex="0" role="img" aria-label="' + esc(tip(si, i)) + '" cx="' + X(i).toFixed(1) + '" cy="' + Y(v).toFixed(1) + '" r="3.5" style="fill:' + col(si) + '"><title>' + esc(tip(si, i)) + '</title></circle>';
        });
      });
    }
    var yl = o.unitLabel ? '<text transform="translate(11 ' + (m.t + ih / 2) + ') rotate(-90)" text-anchor="middle">' + esc(o.unitLabel) + '</text>' : '';
    return '<svg class="rp-svg" viewBox="0 0 ' + W + ' ' + H + '" role="group" aria-label="' + esc(type.replace('_', ' ') + ' chart of ' + series.map(o.label).join(', ') + ' by ' + o.label(o.x)) + '">' + g + marks + yl + '</svg>' +
      (series.length > 1 || type !== 'bar' ? legend(series.map(function (s, si) { return { color: col(si), label: o.label(s) }; })) : '');
  }

  function pie(o, cats, series) {
    var s = series[0], total = 0, items = [], xt = o.cols[o.x] ? o.cols[o.x].type : 'string';
    o.rows.forEach(function (r, i) { var v = num(r[s]); if (v != null && v > 0) { items.push({ l: catLabel(cats[i], xt), v: v }); total += v; } });
    if (!items.length) return null;
    items.sort(function (a, b) { return b.v - a.v; });
    if (items.length > 8) { var rest = items.slice(7), rs = rest.reduce(function (a, b) { return a + b.v; }, 0); items = items.slice(0, 7).concat([{ l: 'Other (' + rest.length + ')', v: rs }]); }
    var R = 120, r0 = 70, cx = 150, cy = 140, a0 = -Math.PI / 2, paths = '';
    items.forEach(function (it, i) {
      var frac = it.v / total, a1 = a0 + frac * Math.PI * 2, big = frac > 0.5 ? 1 : 0;
      if (frac > 0.9999) a1 = a0 + Math.PI * 2 - 0.0001;
      var p = function (r, a) { return (cx + r * Math.cos(a)).toFixed(2) + ' ' + (cy + r * Math.sin(a)).toFixed(2); };
      var tip = it.l + ': ' + o.fmt(s, it.v) + ' (' + (frac * 100).toFixed(1) + '%)';
      paths += '<path class="mk" tabindex="0" role="img" aria-label="' + esc(tip) + '" d="M' + p(R, a0) + 'A' + R + ' ' + R + ' 0 ' + big + ' 1 ' + p(R, a1) + 'L' + p(r0, a1) + 'A' + r0 + ' ' + r0 + ' 0 ' + big + ' 0 ' + p(r0, a0) + 'Z" style="fill:' + col(i) + '"><title>' + esc(tip) + '</title></path>';
      it.c = col(i); it.extra = o.fmt(s, it.v) + ' · ' + (frac * 100).toFixed(1) + '%'; it.label = it.l; it.color = it.c;
      a0 = a1;
    });
    return '<div class="rp-pie"><svg class="rp-svg rp-svg--pie" viewBox="0 0 300 280" role="group" aria-label="Pie chart of ' + esc(o.label(s)) + ' by ' + esc(o.label(o.x)) + '">' + paths +
      '<text x="150" y="136" text-anchor="middle" class="big">' + esc(o.fmt(s, total)) + '</text><text x="150" y="154" text-anchor="middle">total</text></svg>' + legend(items) + '</div>';
  }

  function scatter(o, cats, series) {
    var xc = o.cols[o.x], xs, ys, xl, yl;
    var all = o.rows;
    if (xc && xc.type === 'number') { xs = o.x; ys = series[0]; }
    else { xs = series[0]; ys = series[1] || series[0]; }
    xl = o.label(xs); yl = o.label(ys);
    var pts = all.map(function (r, i) { return { x: num(r[xs]), y: num(r[ys]), c: cats[i] }; }).filter(function (p) { return p.x != null && p.y != null; });
    if (!pts.length) return null;
    var W = 720, H = 320, m = { l: 54, r: 16, t: 12, b: 44 }, iw = W - m.l - m.r, ih = H - m.t - m.b;
    var xt = niceTicks(Math.min.apply(null, pts.map(function (p) { return p.x; })), Math.max.apply(null, pts.map(function (p) { return p.x; })), 6);
    var yt = niceTicks(Math.min(0, Math.min.apply(null, pts.map(function (p) { return p.y; }))), Math.max.apply(null, pts.map(function (p) { return p.y; })), 5);
    var X = function (v) { return m.l + (v - xt[0]) / ((xt[xt.length - 1] - xt[0]) || 1) * iw; }, Y = function (v) { return m.t + ih - (v - yt[0]) / ((yt[yt.length - 1] - yt[0]) || 1) * ih; };
    var g = '';
    yt.forEach(function (t) { g += '<line class="grid" x1="' + m.l + '" x2="' + (W - m.r) + '" y1="' + Y(t).toFixed(1) + '" y2="' + Y(t).toFixed(1) + '"/><text x="' + (m.l - 8) + '" y="' + (Y(t) + 3.5).toFixed(1) + '" text-anchor="end">' + short(t) + '</text>'; });
    xt.forEach(function (t) { g += '<line class="grid" x1="' + X(t).toFixed(1) + '" x2="' + X(t).toFixed(1) + '" y1="' + m.t + '" y2="' + (H - m.b) + '"/><text x="' + X(t).toFixed(1) + '" y="' + (H - m.b + 16) + '" text-anchor="middle">' + short(t) + '</text>'; });
    g += '<text x="' + (m.l + iw / 2) + '" y="' + (H - 6) + '" text-anchor="middle">' + esc(xl) + '</text><text transform="translate(11 ' + (m.t + ih / 2) + ') rotate(-90)" text-anchor="middle">' + esc(yl) + '</text>';
    var marks = pts.slice(0, 1500).map(function (p) {
      var tip = (p.c != null ? catLabel(p.c) + ' — ' : '') + xl + ': ' + o.fmt(xs, p.x) + ', ' + yl + ': ' + o.fmt(ys, p.y);
      return '<circle class="mk" tabindex="0" role="img" aria-label="' + esc(tip) + '" cx="' + X(p.x).toFixed(1) + '" cy="' + Y(p.y).toFixed(1) + '" r="5" style="fill:' + col(0) + ';fill-opacity:.75"><title>' + esc(tip) + '</title></circle>';
    }).join('');
    return '<svg class="rp-svg" viewBox="0 0 ' + W + ' ' + H + '" role="group" aria-label="Scatter chart of ' + esc(yl) + ' versus ' + esc(xl) + '">' + g + marks + '</svg>';
  }

  function render(o) {
    var host = document.createElement('div');
    host.className = 'rp-chart';
    var cols = {}; (o.columns || []).forEach(function (c) { cols[c.id] = c; });
    o.cols = cols; o.fmt = o.fmt || function (c, v) { return v == null ? '—' : String(v); }; o.label = o.label || function (c) { return (cols[c] && cols[c].label) || c; };
    var series = (o.series || []).filter(function (s) { return cols[s]; });
    var msg = function (t) { host.innerHTML = '<p class="rp-chart__msg nx-dim">' + esc(t) + '</p>'; return host; };
    if (!cols[o.x]) return msg('Choose an X axis to draw this chart.');
    if (!series.length) return msg('Choose at least one series (a numeric column).');
    if (!o.rows.length) return msg('No rows to chart.');
    var rows = o.rows, note = '';
    var limit = o.type === 'scatter' ? 1500 : 80;
    if (o.type !== 'pie' && rows.length > limit) { rows = rows.slice(0, limit); note = '<p class="rp-chart__note nx-dim">Chart shows the first ' + limit + ' rows of ' + o.rows.length + '. The table has all of them.</p>'; }
    o.rows = rows;
    var cats = rows.map(function (r) { return r[o.x]; }), html;
    if (o.type === 'pie') html = pie(o, cats, series);
    else if (o.type === 'scatter') html = scatter(o, cats, series);
    else html = cartesian(o, cols, cats, series);
    if (!html) return msg(o.type === 'pie' ? 'Pie charts need positive values in the selected series.' : 'No numeric points to plot for this selection.');
    host.innerHTML = html + note;
    return host;
  }
  window.NXChart = { render: render };
})();
