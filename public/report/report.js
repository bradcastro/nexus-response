/* Public read-only report page: /report/<token>. No login. Renders the snapshot from GET /api/reports/:token. */
(function () {
  'use strict';
  var esc = NX.esc, fmt = NX.fmt, app = document.getElementById('app');
  function pick(o) { if (!o) return undefined; for (var i = 1; i < arguments.length; i++) if (o[arguments[i]] != null) return o[arguments[i]]; }
  function num(v) { v = Number(v); return isNaN(v) ? null : v; }
  function signed(v) { v = num(v); return v == null ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1) + '%'; }
  function money(v) { return v == null ? '—' : fmt.currency(v); }
  function redact(t) { return String(t).replace(/\+?\d[\d\-\s().]{8,}\d/g, '[phone hidden]'); }
  function lbl(s) { return fmt.label(s); }
  function list(a) { a = (a || []).map(function (x) { return typeof x === 'string' ? x : pick(x, 'text', 'headline', 'label', 'note', 'name', 'why') || ''; }).filter(Boolean); return a.length ? '<ul class="rp-list">' + a.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' : '<span class="nx-dim">None.</span>'; }
  function K(l, v, s) { return '<div class="rp-k"><div class="l">' + esc(l) + '</div><div class="v">' + v + '</div>' + (s ? '<div class="s">' + s + '</div>' : '') + '</div>'; }
  function C(t, b, span) { return '<section class="rp-card' + (span ? ' rp-span' : '') + '"><h2>' + esc(t) + '</h2>' + b + '</section>'; }
  function colorFor(v, good) { v = num(v) || 0; var r = good ? 100 - v : v; return r >= 70 ? 'var(--nx-sev-high)' : r >= 50 ? 'var(--nx-warn)' : r >= 30 ? 'var(--nx-info)' : 'var(--nx-ok)'; }
  function bars(items, good) { items = items || []; return items.length ? '<div class="rp-bars">' + items.map(function (b) { var v = num(b.score != null ? b.score : b.value) || 0; return '<div class="rp-bar"><span>' + esc(b.label || lbl(b.key)) + '</span><span class="t"><i style="width:' + Math.min(100, v) + '%;--c:' + colorFor(v, good) + '"></i></span><span class="nx-mono" style="text-align:right">' + Math.round(v) + '</span></div>'; }).join('') + '</div>' : '<span class="nx-dim">Not reported.</span>'; }
  function tier(t) { return t ? NX.badgeHTML(t, ({ low: 'ok', moderate: 'info', elevated: 'warn', high: 'danger' })[String(t).toLowerCase()] || 'plain') : ''; }
  function price(p) { p = p || {}; var a = num(pick(p, 'suggestedPremiumAdjustmentPct', 'adjustmentPct')); if (a == null) return '<span class="nx-dim">No pricing signal.</span>'; var r = p.rationale; return '<div style="font:600 44px/1 var(--nx-font-display)" class="' + (a > 0 ? 'up' : a < 0 ? 'down' : '') + '">' + signed(a) + '</div><div class="nx-dim" style="font-size:13px;margin:4px 0 10px">illustrative premium adjustment' + (p.estAdjustmentUsdPerMonth != null ? ' · about ' + money(Math.abs(p.estAdjustmentUsdPerMonth)) + ' / month' : '') + '</div>' + list(Array.isArray(r) ? r : r ? [r] : []); }
  function drivers(d) { d = d || []; return d.length ? '<div class="rp-wrap"><table class="rp-tbl"><thead><tr><th>Driver</th><th class="n">Score</th><th class="n">Events</th></tr></thead><tbody>' + d.slice(0, 8).map(function (x) { return '<tr><td>' + esc(x.name) + '</td><td class="n">' + esc(pick(x, 'safetyScore', 'driveScore', 'riskScore') != null ? Math.round(pick(x, 'safetyScore', 'driveScore', 'riskScore')) : '—') + '</td><td class="n">' + esc(pick(x, 'events30d', 'events') != null ? pick(x, 'events30d', 'events') : '—') + '</td></tr>'; }).join('') + '</tbody></table></div>' : '<span class="nx-dim">None.</span>'; }
  function evidence(list_) { list_ = list_ || []; return list_.length ? '<div class="rp-callout" style="margin-bottom:12px"><b>Camera evidence (synthetic).</b> Verdicts and frames came with the demo event. Nexus does not analyze video, and nothing here was sent to a carrier.</div><div class="rp-ev">' + list_.slice(0, 6).map(function (i) { return '<div><b>' + esc(lbl(i.eventType)) + '</b> ' + NX.badgeHTML(i.severity || 'low') + ' <span class="nx-dim">' + esc(fmt.dateTime(i.timestamp)) + (i.address ? ' · ' + esc(i.address) : '') + '</span>' + (i.aiVerdict ? '<div>Vendor verdict: <b>' + esc(lbl(i.aiVerdict)) + '</b>' + (i.confidence != null ? ' at ' + Math.round(i.confidence * 100) + '%' : '') + '</div>' : '') + (i.signals && i.signals.length ? '<div class="nx-dim">' + esc(i.signals.slice(0, 4).join(' · ')) + '</div>' : '') + (i.snapshot ? '<img loading="lazy" alt="Placeholder camera frame" src="' + esc(i.snapshot) + '">' : '') + '</div>'; }).join('') + '</div>' : '<span class="nx-dim">No recent verified incidents.</span>'; }

  var R = {
    fleet: function (d) {
      var f = d.fleet || {}, B = d.benchmark || {}, hasDS = d.driveScore != null, h = '';
      h += '<div class="rp-kpis">' + (d.riskScore != null ? K('Risk score', fmt.number(d.riskScore), tier(d.riskTier)) : '') + (hasDS ? K('Nexus Drive Score', fmt.number(d.driveScore), 'higher is better') : '') + (B.riskRank ? K('Portfolio rank', B.riskRank + ' / ' + B.of, '1 = lowest risk') : '') + (d.kpis ? K('Events /100 vehicles', fmt.number(d.kpis.events30dPer100veh, 1), '30 days') + K('Verified events', fmt.number(d.kpis.verifiedEventPct) + '%', 'camera coverage ' + fmt.number(d.kpis.cameraCoveragePct) + '%') : '') + '</div>';
      h += '<div class="rp-grid">' + C('Pricing signal', price(d.pricingSignal || d.pricing)) + C('Score breakdown', bars(d.scoreBreakdown, false));
      if (d.recentVerifiedIncidents) h += C('Camera-verified incidents', evidence(d.recentVerifiedIncidents), true);
      if (d.driversRanked) h += C('Highest-risk drivers', drivers(d.driversRanked));
      if (d.topImprovementLevers) h += C('How to improve', list(d.topImprovementLevers.map(function (x) { return x.label + (x.potentialSavingsUsd ? ' (illustrative saving ' + money(x.potentialSavingsUsd) + ' / yr)' : ''); })));
      if (d.usageNote) h += '<p class="nx-dim" style="font-size:12px;margin-top:12px">' + esc(d.usageNote) + '.</p>';
      return h + '</div>';
    },
    assessment: function (d) {
      var pr = d.pricing || {}, h = '<div class="rp-kpis">' + K('Risk score', fmt.number(d.riskScore), tier(d.riskTier)) + K('Data sufficiency (modeled)', d.confidence != null ? Math.round(d.confidence <= 1 ? d.confidence * 100 : d.confidence) + '%' : '—') + K('Data quality', fmt.number(d.dataQualityScore), 'of 100') + K('Events / million miles', d.eventsPerMillionMiles == null ? 'n/a' : fmt.number(d.eventsPerMillionMiles), d.eventsPerMillionMiles == null ? 'no mileage supplied' : '') + '</div>';
      h += '<div class="rp-grid">' + C('Pricing signal', price(pr)) + C('Score breakdown', bars(d.scoreBreakdown, false)) + C('Pre-accident indicators', list(d.preAccidentIndicators)) + C('Recommended programs', list((d.recommendedPrograms || []).map(function (x) { return typeof x === 'string' ? x : (x.label || x.name) + (x.description ? ': ' + x.description : ''); }))) + C('Limitations', list(d.limitations), true) + '</div>';
      return h;
    },
    incident: function (d) {
      var c = d.camera || {}, l = d.location || {}, v = d.vehicle || {}, dr = d.driver || {}, ld = d.load || null, h = '<div class="rp-kpis">' + K('Event', esc(lbl(d.eventType)), NX.badgeHTML(d.severity || 'low')) + K('Status', esc(lbl(d.status))) + K('When', esc(fmt.dateTime(d.timestamp)), esc(l.address || '')) + K('Camera', c.verified ? 'Verified' : 'Unverified', esc(lbl(c.aiVerdict || '')) + (c.confidence != null ? ' · ' + Math.round(c.confidence * 100) + '%' : '')) + '</div>';
      h += '<div class="rp-grid">' + C('Vehicle and driver', '<ul class="rp-list"><li>' + esc([v.year, v.make, v.model].filter(Boolean).join(' ')) + (v.plate ? ' · ' + esc(v.plate) : '') + '</li>' + (v.vin ? '<li class="nx-mono">VIN ' + esc(v.vin) + '</li>' : '') + (dr.name ? '<li>Driver: ' + esc(dr.name) + '</li>' : '') + '</ul>') +
        C('Camera evidence', (c.signals && c.signals.length ? list(c.signals) : '<span class="nx-dim">No signals.</span>') + (c.snapshots && c.snapshots[0] ? '<div class="rp-ev"><div><img alt="Camera frame" src="' + esc(c.snapshots[0].url) + '"></div></div>' : ''));
      if (ld) h += C('Load context', '<ul class="rp-list"><li>Estimated load ' + fmt.number(ld.estimatedWeightLb) + ' lb' + (ld.payloadPctOfMax != null ? ' (' + Math.round(ld.payloadPctOfMax) + '% of max)' : '') + '</li>' + (ld.contents ? '<li>' + esc(ld.contents.label || lbl(ld.contents.category)) + '</li>' : '') + '</ul>');
      if (d.timeline && d.timeline.length) h += C('Timeline', '<ul class="rp-list">' + d.timeline.map(function (t) { return '<li><span class="nx-mono nx-dim">' + esc(fmt.dateTime(t.t)) + '</span> ' + esc(t.action || '') + (t.note ? ': ' + esc(redact(t.note)) : '') + '</li>'; }).join('') + '</ul>', true);
      return h + '</div>';
    },
    builder: function (d) {
      var res = d.result || {}, cols = res.columns || [], rows = res.rows || [], tot = res.totals || null, m = res.meta || {}, per = m.period || {}, ch = d.chart || {};
      var cellText = function (c, v) {
        if (v == null || v === '') return '—';
        if (c.type === 'number') { var n = Number(v); if (!isFinite(n)) return String(v); if (c.unit === 'USD' || c.unit === '$') return fmt.currency(n, Math.abs(n) < 100 && n % 1 ? 2 : 0); var s = fmt.number(n, Number.isInteger(n) ? 0 : 2); return c.unit === '%' ? s + '%' : (c.unit && c.unit !== 'count' ? s + ' ' + c.unit : s); }
        if (c.type === 'date') { var st = String(v); return /^\d{4}-\d{2}-\d{2}$/.test(st) ? fmt.date(st + 'T00:00:00') : fmt.dateTime(v); }
        if (c.type === 'boolean' || typeof v === 'boolean') return v ? 'Yes' : 'No';
        if (c.type === 'enum') return fmt.label(v);
        var t = String(v); if (/^\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?$/.test(t)) return t.length === 10 ? fmt.date(t + 'T00:00:00') : fmt.dateTime(t);
        return redact(t);
      };
      var byId = {}; cols.forEach(function (c) { byId[c.id] = c; });
      var colFmt = function (id, v) { return byId[id] ? cellText(byId[id], v) : String(v == null ? '—' : v); };
      var colLabel = function (id) { var c = byId[id]; return c ? c.label + (c.unit && c.unit !== 'count' ? ' (' + c.unit + ')' : '') : id; };
      var h = '<div class="rp-callout rp-synth" role="note"><b>' + esc(d.label || m.label || 'Synthetic demo data') + '.</b> ' + esc(d.note || 'Frozen snapshot of simulated records; not real policyholder, driver or claims data, and not validated.') + '</div>';
      h += '<div class="rp-meta">' + [fmt.number(res.rowCount != null ? res.rowCount : rows.length) + ' rows', per.from ? fmt.date(per.from) + ' to ' + fmt.date(per.to) : '', d.frozenAt ? 'Frozen ' + fmt.dateTime(d.frozenAt) : m.generatedAt ? 'Generated ' + fmt.dateTime(m.generatedAt) : '', d.area ? fmt.label(d.area) : ''].filter(Boolean).map(function (x) { return '<span>' + esc(x) + '</span>'; }).join('') + '</div>';
      if (res.truncated) h += '<div class="rp-callout rp-warn" role="status"><b>Truncated.</b> Showing ' + fmt.number(rows.length) + (res.rowCount > rows.length ? ' of ' + fmt.number(res.rowCount) : '') + ' rows.</div>';
      (m.notes || []).forEach(function (n) { h += '<div class="rp-callout rp-warn">' + esc(String(n)) + '</div>'; });
      if (!rows.length) return h + '<div class="rp-card rp-span"><h2>No rows</h2><p class="nx-dim">This report ran successfully when it was shared and returned no rows.</p></div>';
      var type = ch.type || ch.suggested || 'table', x = byId[ch.x] ? ch.x : (cols[0] && cols[0].id);
      var series = (ch.series || []).filter(function (s) { return byId[s]; });
      if (!series.length) series = cols.filter(function (c) { return c.type === 'number' && c.id !== x; }).slice(0, 1).map(function (c) { return c.id; });
      if (type !== 'table' && window.NXChart && series.length) {
        h += '<section class="rp-card rp-span"><h2>Chart <span class="nx-dim nx-mono" style="font-size:11px">' + esc(fmt.label(type)) + '</span></h2><div id="rp-chart"></div></section>';
      }
      h += '<section class="rp-card rp-span"><h2>Data</h2><div class="rp-wrap"><table class="rp-tbl"><thead><tr>' + cols.map(function (c) { return '<th' + (c.type === 'number' ? ' class="n"' : '') + '>' + esc(colLabel(c.id)) + '</th>'; }).join('') + '</tr></thead><tbody>' +
        rows.map(function (r) { return '<tr>' + cols.map(function (c) { return '<td' + (c.type === 'number' ? ' class="n"' : '') + '>' + esc(cellText(c, r[c.id])) + '</td>'; }).join('') + '</tr>'; }).join('') + '</tbody>' +
        (tot ? '<tfoot><tr>' + cols.map(function (c, i) { return '<td' + (c.type === 'number' ? ' class="n"' : '') + '>' + (tot[c.id] != null ? esc(cellText(c, tot[c.id])) : i === 0 ? 'Total' : '') + '</td>'; }).join('') + '</tr></tfoot>' : '') + '</table></div></section>';
      var sb = (ch.options && ch.options.seriesBy) || ch.seriesBy || ''; if (sb === 'none' || !byId[sb] || sb === x) sb = '';
      var cc = res.columns, cr = rows, cs = series, cfmt = colFmt, clab = colLabel;
      if (sb && series.length && /^(bar|stacked_bar|line|area)$/.test(type)) {
        var s0 = series[0], xs = [], gs = [], map = {};
        rows.forEach(function (row) { var xv = row[x], gv = row[sb] == null ? '—' : String(row[sb]); if (xs.indexOf(xv) < 0) xs.push(xv); if (gs.indexOf(gv) < 0) gs.push(gv); map[xv + '\u0001' + gv] = row[s0]; });
        cc = [byId[x]].concat(gs.map(function (g) { return Object.assign({}, byId[s0], { id: 'pv:' + g, label: lbl(g) }); }));
        cr = xs.map(function (xv) { var o = {}; o[x] = xv; gs.forEach(function (g) { var v = map[xv + '\u0001' + g]; o['pv:' + g] = v == null ? 0 : v; }); return o; });
        cs = gs.map(function (g) { return 'pv:' + g; });
        var cm = {}; cc.forEach(function (c) { cm[c.id] = c; });
        cfmt = function (id, v) { return cm[id] ? cellText(cm[id], v) : String(v == null ? '—' : v); };
        clab = function (id) { var c = cm[id]; return c ? c.label + (c.unit && c.unit !== 'count' && !/^pv:/.test(id) ? ' (' + c.unit + ')' : '') : id; };
      }
      setTimeout(function () { var host = document.getElementById('rp-chart'); if (host && window.NXChart) { try { host.appendChild(window.NXChart.render({ type: type, columns: cc, rows: cr, x: x, series: cs, fmt: cfmt, label: clab })); } catch (e) { host.innerHTML = '<p class="nx-dim">Chart could not be drawn.</p>'; } } }, 0);
      return '<div class="rp-grid">' + h.replace('<div class="rp-grid">', '') + '</div>';
    },
    digest: function (d) {
      var it = function (x) { return typeof x === 'string' ? x : [pick(x, 'name', 'fleetName'), pick(x, 'headline', 'why', 'label', 'text', 'summary', 'detail')].filter(Boolean).join(': '); };
      return '<div class="rp-headline">' + esc(d.headline || 'No exceptions this period.') + '</div><div class="rp-kpis" style="margin-top:16px">' + K('Needing attention', String((d.fleetsNeedingAttention || []).length)) + K('High-severity events', String((d.newHighSeverity || []).length)) + K('Improvements', String((d.notableImprovements || []).length)) + K('Claims opened', fmt.number(d.claimsOpened)) + K('FNOLs sent', fmt.number(d.fnolsSent)) + '</div><div class="rp-grid">' + C('Fleets needing attention', list((d.fleetsNeedingAttention || []).map(it))) + C('New high-severity events', list((d.newHighSeverity || []).map(it))) + C('Notable improvements', list((d.notableImprovements || []).map(it))) + C('Recommended actions', list(d.recommendedActions)) + '</div>';
    }
  };
  function generic(d) { return C('Report data', '<div class="rp-wrap"><table class="rp-tbl"><tbody>' + Object.keys(d).filter(function (k) { return typeof d[k] !== 'object'; }).map(function (k) { return '<tr><td>' + esc(lbl(k)) + '</td><td>' + esc(d[k]) + '</td></tr>'; }).join('') + '</tbody></table></div>', true); }

  function token() { var m = location.pathname.match(/\/report\/([^\/?#]+)/); return (m && m[1] !== 'index.html' && m[1]) || new URLSearchParams(location.search).get('t') || location.hash.slice(1) || ''; }
  function fail(title, text) { app.innerHTML = '<div class="rp-err"><h1>' + esc(title) + '</h1><p class="nx-dim">' + esc(text) + '</p></div>'; }
  var tk = token();
  if (!tk) return fail('No report specified', 'This link is missing its report code. Ask the sender for a new link.');
  function load() {
  app.innerHTML = '<div class="rp-skel" aria-busy="true"></div>';
  fetch('/api/reports/' + encodeURIComponent(tk), { headers: { Accept: 'application/json' } }).then(function (r) {
    if (r.status === 404 || r.status === 410) throw Object.assign(new Error('gone'), { gone: true });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }).then(function (r) {
    var d = r.snapshot || r.data || r.payload || r.report || r, kind = r.kind || d.kind || (d.headline && 'digest') || (d.eventType && 'incident') || (d.result && d.result.columns && 'builder') || (d.confidence != null && d.dataQualityScore != null && 'assessment') || 'fleet';
    if (d && d.deepDive) { var ub = d.usageBased || {}; d = Object.assign({}, d.deepDive, { driveScore: ub.driveScore, topImprovementLevers: ub.topImprovementLevers, usageNote: ub.pricing && ub.pricing.note }); }
    var exp = r.expiresAt ? new Date(r.expiresAt) : null, days = exp ? Math.ceil((exp - Date.now()) / 864e5) : null;
    var name = (d.fleet && d.fleet.name) || d.fleetName || d.name || (kind === 'incident' ? d.id : kind === 'digest' ? d.periodLabel : '') || '';
    var titles = { fleet: 'Policyholder risk report', assessment: 'Underwriting assessment', incident: 'Incident report', digest: 'Weekly digest', builder: 'Custom report' };
    document.title = (titles[kind] || 'Report') + (name ? ' — ' + name : '') + ' — Nexus Response';
    var h = '<div class="rp-eyebrow">' + esc(titles[kind] || 'Shared report') + '</div><h1 class="rp-h">' + esc(name || titles[kind] || 'Report') + '</h1><p class="rp-sub">' + (r.createdAt ? 'Snapshot taken ' + esc(fmt.dateTime(r.createdAt)) : '') + (d.fleet && d.fleet.vendor ? ' · ' + esc(lbl(d.fleet.vendor)) : '') + '</p>';
    h += '<div class="rp-expiry' + (days != null && days <= 3 ? ' warn' : '') + '"><span>' + (exp ? (days > 0 ? 'This link expires on <b>' + esc(fmt.date(exp)) + '</b> (' + days + ' day' + (days === 1 ? '' : 's') + ' left).' : 'This link has expired.') : 'This link is time-limited.') + ' Read-only snapshot, no sign-in required.</span><button class="nx-btn nx-btn--sm nx-no-print" style="margin-left:auto" onclick="window.print()">Print / save PDF</button></div>';
    h += (R[kind] || generic)(d);
    app.innerHTML = h;
  }).catch(function (e) {
    if (e.gone) fail('This link is no longer available', 'The report has expired or the link is not valid. Ask the sender for a new link.');
    else { fail('Could not load the report', 'Please try again in a moment. ' + (e.message || '')); var b = document.createElement('button'); b.className = 'nx-btn'; b.textContent = 'Retry'; b.onclick = load; app.firstChild.appendChild(b); }
  });
  }
  load();
})();
