/* Insurer portal v3: Assess a new fleet, Assessments, Projections. Contract: ARCHITECTURE.md addendum v3 sections 3-4. */
(function () {
  'use strict';
  var I = window.INS, el = NX.el, esc = NX.esc, fmt = NX.fmt, num = I.num, pick = I.pick, $ = I.$;
  var main = $('#main'), VIEWS = ['projections', 'assess', 'assessments', 'report', 'digest', 'drive'];
  VIEWS.forEach(function (v) { main.appendChild(el('div', { id: 'view-' + v, hidden: true, 'data-printable': '' })); });
  var cache = {};

  function get(path, q) { return NX.api(path, { query: q }); }
  function arr(x, k) { return Array.isArray(x) ? x : (x && (x[k] || x.items || x.data)) || []; }
  function errBox(e, what) { var s = (e && e.status === 404) ? 'This endpoint is not available on the connected backend yet.' : (e && e.message) || ''; return '<div class="nx-card nx-card--alert"><div class="nx-card__body"><b>' + esc(what) + '</b> ' + esc(s) + '</div></div>'; }
  function fleetName(id) { var f = I.state.fleets.filter(function (x) { return x.id === id; })[0]; return f ? f.name : id; }
  function fleetVendor(id) { var f = I.state.fleets.filter(function (x) { return x.id === id; })[0]; return f && f.vendor; }
  function dirKey(d) { d = String(d || '').toLowerCase(); return /improv/.test(d) ? 'down' : /worse|rising|up/.test(d) ? 'up' : 'flat'; }
  function dirHTML(d) { var k = dirKey(d); return '<span class="ins-trend ' + k + '">' + (k === 'up' ? '▲' : k === 'down' ? '▼' : '▬') + ' ' + esc(fmt.label(d || 'stable')) + '</span>'; }
  function money(v) { return v == null ? '—' : fmt.currency(v); }
  function conf(v) { v = num(v); return v == null ? '—' : (v <= 1 ? Math.round(v * 100) : Math.round(v)) + '%'; }
  function meter(v, color) { v = Math.max(0, Math.min(100, v || 0)); return '<span class="ins-dq"><span class="nx-meter"><i style="width:' + v + '%;--c:' + color + '"></i></span><span class="nx-mono">' + Math.round(v) + '%</span></span>'; }
  function head(eyebrow, title, sub, right) { return '<div class="nx-page-head"><div><div class="nx-eyebrow">' + esc(eyebrow) + '</div><h1>' + title + '</h1>' + (sub ? '<p>' + sub + '</p>' : '') + '</div>' + (right ? '<div class="nx-row ins-actions nx-no-print">' + right + '</div>' : '') + '</div>'; }
  function kpi(l, v, sub, cls) { return '<div class="nx-kpi' + (cls ? ' ' + cls : '') + '"><div class="nx-kpi__label">' + esc(l) + '</div><div class="nx-kpi__value">' + v + '</div>' + (sub ? '<div class="nx-kpi__delta nx-dim">' + sub + '</div>' : '') + '</div>'; }
  function card(title, body, note, cls) { return '<section class="nx-card ' + (cls || '') + '"><div class="nx-card__head"><h2 class="nx-card__title">' + esc(title) + '</h2>' + (note ? '<span class="nx-dim ins-note">' + note + '</span>' : '') + '</div><div class="nx-card__body">' + body + '</div></section>'; }
  function list(items, cls) { items = (items || []).map(function (x) { return typeof x === 'string' ? x : pick(x, 'text', 'label', 'note', 'message', 'name') || ''; }).filter(Boolean); return items.length ? '<ul class="ins-list ' + (cls || '') + '">' + items.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' : ''; }

  /* ---- forecast chart: series [{date, actual?, projected?, lo?, hi?}] ---- */
  function forecast(series) {
    series = (series || []).filter(function (p) { return p && p.date; });
    if (series.length < 2) return '<p class="nx-dim">No forecast series available.</p>';
    var W = 640, H = 260, m = { l: 40, r: 14, t: 12, b: 30 }, vals = [];
    series.forEach(function (p) { ['actual', 'projected', 'lo', 'hi'].forEach(function (k) { if (num(p[k]) != null) vals.push(p[k]); }); });
    var ymax = Math.ceil((Math.max.apply(null, vals) + 5) / 10) * 10, ymin = Math.max(0, Math.floor((Math.min.apply(null, vals) - 5) / 10) * 10);
    var X = function (i) { return m.l + i / (series.length - 1) * (W - m.l - m.r); }, Y = function (v) { return H - m.b - (v - ymin) / (ymax - ymin || 1) * (H - m.t - m.b); };
    var g = ''; for (var y = ymin; y <= ymax; y += (ymax - ymin > 60 ? 20 : 10)) g += '<line class="grid" x1="' + m.l + '" x2="' + (W - m.r) + '" y1="' + Y(y) + '" y2="' + Y(y) + '"/><text x="' + (m.l - 6) + '" y="' + (Y(y) + 3) + '" text-anchor="end">' + y + '</text>';
    var step = Math.ceil(series.length / 6); series.forEach(function (p, i) { if (i % step === 0) g += '<text x="' + X(i) + '" y="' + (H - 10) + '" text-anchor="middle">' + esc(String(p.date).slice(5, 10)) + '</text>'; });
    var band = series.map(function (p, i) { return num(p.lo) != null && num(p.hi) != null ? [i, p] : null; }).filter(Boolean);
    var bandPath = band.length > 1 ? 'M' + band.map(function (b) { return X(b[0]) + ',' + Y(b[1].hi); }).join('L') + 'L' + band.slice().reverse().map(function (b) { return X(b[0]) + ',' + Y(b[1].lo); }).join('L') + 'Z' : '';
    var line = function (k) { var pts = series.map(function (p, i) { return num(p[k]) != null ? X(i) + ',' + Y(p[k]) : null; }).filter(Boolean); return pts.length > 1 ? 'M' + pts.join('L') : ''; };
    var lastActual = -1; series.forEach(function (p, i) { if (num(p.actual) != null) lastActual = i; });
    var hasProj = series.some(function (p) { return num(p.projected) != null; });
    var today = lastActual >= 0 && hasProj ? '<line class="today" x1="' + X(lastActual) + '" x2="' + X(lastActual) + '" y1="' + m.t + '" y2="' + (H - m.b) + '"/><text x="' + (X(lastActual) + 4) + '" y="' + (m.t + 9) + '">today</text>' : '';
    return '<svg class="ins-svg ins-fc" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Risk forecast with confidence band">' + g + (bandPath ? '<path class="band" d="' + bandPath + '"/>' : '') + today + '<path class="act" d="' + line('actual') + '"/><path class="prj" d="' + line('projected') + '"/></svg>' +
      '<div class="ins-legend"><span><i style="--c:var(--nx-text)"></i>Actual risk</span><span><i style="--c:var(--nx-accent)"></i>Projected</span><span><i style="--c:color-mix(in srgb, var(--nx-accent) 30%, transparent)"></i>Confidence band</span></div>';
  }

  /* ================= PROJECTIONS ================= */
  function viewProjections(id) {
    var host = $('#view-projections'); host.hidden = false; host.replaceChildren(NX.skeleton(5));
    if (id) return fleetForecast(host, id);
    get('/api/predict/portfolio').then(function (P) {
      var fl = P.fleets || [], bv = P.byVendor || [], T = P.totals || {};
      var h = head('Predictive risk', 'Projections', 'Where each policyholder is heading over the next 90 days, and what is driving it.');
      h += '<div class="nx-kpis">' + kpi('Expected loss, next 90d', money(T.expectedLossUsd90d), 'modelled across the book', 'nx-kpi--accent') + kpi('Fleets worsening', String(fl.filter(function (f) { return dirKey(f.direction) === 'up'; }).length), 'of ' + fl.length) + kpi('Fleets improving', String(fl.filter(function (f) { return dirKey(f.direction) === 'down'; }).length), 'of ' + fl.length) + kpi('Drivers at risk', fmt.number(T.driversAtRisk), 'elevated collision probability') + kpi('Open predictive alerts', fmt.number(T.alertsOpen), 'awaiting action') + '</div>';
      if (P.insight) h += '<div class="ins-vcallout ins-gap"><b>What the data shows.</b> ' + esc(P.insight) + '</div>';
      h += '<div class="ins-gap">' + card('Policyholder forecast', '<div class="nx-table-wrap"><table class="nx-table"><thead><tr><th>Policyholder</th><th>Vendor</th><th class="num">Risk now</th><th class="num">Projected 90d</th><th>Direction</th><th class="num">Expected loss 90d</th><th>Camera coverage</th><th>Prediction confidence</th></tr></thead><tbody>' +
        fl.slice().sort(function (a, b) { return (b.projected90d || 0) - (a.projected90d || 0); }).map(function (f) {
          return '<tr data-pfleet="' + esc(f.fleetId) + '" tabindex="0" style="cursor:pointer"><td class="name"><b>' + esc(f.name) + '</b></td><td>' + I.vendorChip(f.vendor) + '</td><td class="num">' + fmt.number(f.risk) + '</td><td class="num"><b>' + fmt.number(f.projected90d) + '</b></td><td>' + dirHTML(f.direction) + '</td><td class="num">' + money(f.expectedLossUsd90d) + '</td><td>' + meter(num(f.cameraCoveragePct), 'var(--nx-ok)') + '</td><td>' + meter(num(f.predictionConfidence) <= 1 ? f.predictionConfidence * 100 : f.predictionConfidence, 'var(--nx-info)') + '</td></tr>';
        }).join('') + '</tbody></table></div>', 'Select a policyholder for the forecast, leading indicators and what-if') + '</div>';
      // vendors
      var mantis = bv.filter(function (v) { return v.vendor === 'mantis'; })[0];
      var others = bv.filter(function (v) { return v.vendor !== 'mantis'; });
      var oa = function (k) { return I.avg(others.map(function (v) { return num(v[k]); })); };
      var pc = function (v) { v = num(v); return v == null ? null : (v <= 1 ? v * 100 : v); };
      var vb = '';
      if (mantis && others.length) {
        var cmp = [['Camera coverage', pc(mantis.cameraCoveragePct), pc(oa('cameraCoveragePct')), '%'], ['Prediction confidence', pc(mantis.avgPredictionConfidence), pc(oa('avgPredictionConfidence')), '%'], ['Warning lead time', num(mantis.avgLeadDays), oa('avgLeadDays'), ' days']];
        vb += '<div class="ins-claims">' + cmp.map(function (c) { return '<div class="ins-stat"><div class="nx-eyebrow">' + c[0] + '</div><div class="ins-stat__v" style="color:var(--v-mantis)">' + (c[1] == null ? '—' : c[1].toFixed(c[3] === '%' ? 0 : 1) + c[3]) + '</div><div class="ins-stat__s">Mantis fleets · other vendors ' + (c[2] == null ? '—' : c[2].toFixed(c[3] === '%' ? 0 : 1) + c[3]) + '</div></div>'; }).join('') + '</div>';
      }
      vb += '<div class="nx-table-wrap ins-gap2"><table class="nx-table"><thead><tr><th>Vendor</th><th class="num">Avg risk</th><th>Camera coverage</th><th>Prediction confidence</th><th class="num">Avg lead time</th></tr></thead><tbody>' + bv.slice().sort(function (a, b) { return (b.vendor === 'mantis') - (a.vendor === 'mantis') || (b.avgPredictionConfidence || 0) - (a.avgPredictionConfidence || 0); }).map(function (v) {
        return '<tr' + (v.vendor === 'mantis' ? ' class="is-selected"' : '') + '><td>' + I.vendorChip(v.vendor) + '</td><td class="num">' + fmt.number(v.avgRisk, 0) + '</td><td>' + meter(pc(v.cameraCoveragePct), 'var(--nx-ok)') + '</td><td>' + meter(pc(v.avgPredictionConfidence), 'var(--nx-info)') + '</td><td class="num">' + (v.avgLeadDays == null ? '—' : v.avgLeadDays.toFixed(1) + ' days') + '</td></tr>';
      }).join('') + '</tbody></table></div><p class="nx-dim ins-note" style="margin:var(--nx-sp-3) 0 0">Camera-first data, especially driver-facing signals such as drowsiness and phone use, gives the model earlier and more reliable warning. Demo-calibrated, not a guarantee.</p>';
      h += '<div class="ins-gap">' + card('Mantis vs other vendors', vb, 'Same model, different data richness') + '</div>';
      host.innerHTML = h;
    }).catch(function (e) { host.innerHTML = head('Predictive risk', 'Projections') + errBox(e, 'Projections unavailable.'); });
  }

  function fleetForecast(host, id) {
    Promise.all([get('/api/predict/fleet/' + encodeURIComponent(id), { horizonDays: 90 }), get('/api/predict/backtest', { fleetId: id }).catch(function () { return null; }), get('/api/predict/drivers', { fleetId: id, limit: 8 }).catch(function () { return []; })]).then(function (r) {
      var F = r[0], BT = r[1], DR = arr(r[2], 'drivers'), R = F.risk || {}, E = F.expected || {}, name = fleetName(id), v = fleetVendor(id);
      var h = '<a class="nx-btn nx-btn--ghost nx-btn--sm ins-back nx-no-print" href="#projections">← Projections</a>';
      h += head('Fleet forecast', esc(name), v ? I.vendorChip(v) + ' · ' + F.horizonDays + '-day horizon' : '', '<button class="nx-btn" id="btn-print" type="button">Print / save PDF</button>');
      h += '<div class="nx-kpis">' + kpi('Risk now', fmt.number(R.current), dirHTML(R.direction), 'nx-kpi--accent') + kpi('Projected, 30d', fmt.number(R.projected30d)) + kpi('Projected, 90d', fmt.number(R.projected90d), R.band90d ? 'band ' + R.band90d[0] + '–' + R.band90d[1] : '') + kpi('Collision probability, 30d', conf(E.collisionProb30d), fmt.number(E.collisions30d, 1) + ' expected collisions') + kpi('Expected loss, 90d', money(E.expectedLossUsd90d), fmt.number(E.incidents30d, 0) + ' incidents expected / 30d') + '</div>';
      h += '<div class="ins-dive-grid">' + card('Risk forecast', forecast(F.series), 'Band = likely range', 'ins-span2');
      var li = F.leadingIndicators || [], maxC = Math.max.apply(null, li.map(function (x) { return Math.abs(x.contributionToRisk || 0); }).concat([1]));
      h += card('Leading indicators', li.length ? '<div class="nx-table-wrap"><table class="nx-table"><thead><tr><th>Indicator</th><th class="num">Level</th><th class="num">Trend</th><th>Contribution</th></tr></thead><tbody>' + li.slice().sort(function (a, b) { return (b.contributionToRisk || 0) - (a.contributionToRisk || 0); }).map(function (x) {
        var t = num(x.trendPct); return '<tr><td>' + esc(x.label) + '</td><td class="num">' + fmt.number(x.value, 1) + ' <span class="nx-faint">' + esc(x.unit || '') + '</span></td><td class="num"><span class="ins-trend ' + dirKey(x.direction) + '">' + (t == null ? '—' : (t > 0 ? '+' : '') + t.toFixed(0) + '%') + '</span></td><td>' + meter(Math.abs(x.contributionToRisk || 0) / maxC * 100, 'var(--nx-accent)') + '</td></tr>';
      }).join('') + '</tbody></table></div>' : '<span class="nx-dim">No indicators reported.</span>', 'What is moving the projection');
      h += card('Drivers at risk', DR.length ? '<div class="nx-table-wrap"><table class="nx-table"><thead><tr><th>Driver</th><th class="num">Risk now</th><th class="num">30d</th><th class="num">Collision prob.</th><th>Recommended</th></tr></thead><tbody>' + DR.slice(0, 8).map(function (d) {
        return '<tr><td>' + esc(d.name) + '</td><td class="num">' + fmt.number(d.riskNow) + '</td><td class="num">' + fmt.number(d.riskProjected30d) + '</td><td class="num">' + conf(d.collisionProb30d) + '</td><td class="nx-dim ins-note">' + esc(d.recommendedIntervention || '') + '</td></tr>';
      }).join('') + '</tbody></table></div>' : '<span class="nx-dim">No driver ranking reported.</span>', 'Ranked by projected 30-day risk');
      h += '</div>';
      // backtest
      var bt = '';
      if (BT) {
        var miss = BT.collisions != null && BT.caught != null ? BT.collisions - BT.caught : null;
        bt += '<div class="ins-claims">' + [['Collisions in window', fmt.number(BT.collisions), BT.window ? esc(typeof BT.window === 'string' ? BT.window : (BT.window.from || '') + ' to ' + (BT.window.to || '')) : ''], ['Warned in advance', fmt.number(BT.caught), BT.recallPct != null ? Math.round(BT.recallPct) + '% recall' : ''], ['Median warning lead', BT.medianLeadDays != null ? BT.medianLeadDays + ' days' : '—', 'before the collision'], ['False alerts', fmt.number(BT.falseAlertsPer100Veh, 1), 'per 100 vehicles']].map(function (c) { return '<div class="ins-stat"><div class="nx-eyebrow">' + c[0] + '</div><div class="ins-stat__v">' + c[1] + '</div><div class="ins-stat__s">' + c[2] + '</div></div>'; }).join('') + '</div>';
        if (miss > 0) bt += '<div class="ins-miss"><b>' + miss + ' collision' + (miss === 1 ? '' : 's') + ' not caught.</b> No escalation in leading indicators preceded ' + (miss === 1 ? 'it' : 'them') + '. Some collisions are not predictable from telematics, and we report them rather than hide them.</div>';
        var ex = BT.examples || [];
        if (ex.length) bt += '<h3 class="nx-eyebrow" style="margin:var(--nx-sp-4) 0 var(--nx-sp-2)">What we would have caught</h3><div class="ins-ev">' + ex.slice(0, 5).map(function (e) { return '<div class="ins-ev__item"><div class="ins-ev__head"><b>' + esc(e.driverName || 'Driver') + '</b>' + NX.badgeHTML(e.leadDays + ' days warning', 'ok') + '<span class="nx-mono nx-dim" style="margin-left:auto">' + esc(e.incidentId || '') + '</span></div><div class="ins-note nx-dim">Warned ' + esc(fmt.date(e.warningAt)) + ', collision ' + esc(fmt.date(e.incidentAt)) + '</div>' + list(e.signals, 'ins-ev__sig') + '</div>'; }).join('') + '</div>';
        if (BT.limitations) bt += '<div class="ins-note nx-dim" style="margin-top:var(--nx-sp-3)">Limitations: ' + esc(Array.isArray(BT.limitations) ? BT.limitations.join(' ') : BT.limitations) + '</div>';
      } else bt = '<span class="nx-dim">Backtest not available.</span>';
      h += '<div class="ins-gap">' + card('Backtest: what we would have caught', bt, 'Predictions replayed against actual collisions') + '</div>';
      // what-if
      var iv = F.interventions || [];
      h += '<div class="ins-gap nx-no-print">' + card('What-if interventions', iv.length ? '<div class="ins-whatif">' + iv.map(function (x) { return '<label class="ins-check"><input type="checkbox" data-iv="' + esc(x.key) + '"><span><b>' + esc(x.label) + '</b><br><span class="nx-dim ins-note">−' + fmt.number(x.expectedRiskReductionPct, 0) + '% risk · ' + fmt.number(x.expectedAvoidedIncidents90d, 1) + ' incidents avoided · ' + money(x.expectedSavingsUsd) + ' saved / 90d</span></span></label>'; }).join('') + '</div><div class="nx-row" style="margin-top:var(--nx-sp-3)"><button class="nx-btn nx-btn--primary" id="btn-whatif" type="button">Simulate selected</button></div><div id="whatif-out" class="ins-gap2"></div>' : '<span class="nx-dim">No interventions suggested.</span>', 'Select programs and simulate the effect') + '</div>';
      if (F.modelNotes) h += '<p class="nx-faint ins-note" style="margin-top:var(--nx-sp-3)">' + esc(Array.isArray(F.modelNotes) ? F.modelNotes.join(' ') : F.modelNotes) + '</p>';
      host.innerHTML = h;
      var btn = $('#btn-whatif', host);
      if (btn) btn.onclick = function () {
        var keys = [].map.call(host.querySelectorAll('[data-iv]:checked'), function (c) { return c.dataset.iv; });
        if (!keys.length) return NX.toast('Select at least one intervention', 'warn');
        btn.classList.add('is-loading');
        NX.api('/api/predict/simulate-what-if', { method: 'POST', body: { fleetId: id, interventions: keys } }).then(function (res) {
          var o = res.result || res, base = pick(o, 'baselineRisk90d', 'baselineRisk', 'baseline'), prj = pick(o, 'projectedRisk90d', 'projectedRisk', 'riskAfter', 'projected90d', 'withInterventions'), red = pick(o, 'riskReductionPct', 'expectedRiskReductionPct', 'reductionPct'), sv = pick(o, 'expectedSavingsUsd', 'savingsUsd', 'estimatedSavingsUsd', 'expectedSavingsUsd90d'), av = pick(o, 'expectedAvoidedIncidents90d', 'avoidedIncidents90d', 'avoidedIncidents');
          if (typeof prj === 'object' && prj) prj = pick(prj, 'projected90d', 'risk');
          $('#whatif-out', host).innerHTML = '<div class="ins-claims">' + [['Projected 90d risk', prj == null ? '—' : fmt.number(prj), base != null ? 'baseline ' + fmt.number(base) : ''], ['Risk reduction', red == null ? '—' : fmt.number(red, 0) + '%', ''], ['Incidents avoided', av == null ? '—' : fmt.number(av, 1), 'over 90 days'], ['Est. savings', money(sv), 'over 90 days']].map(function (c) { return '<div class="ins-stat"><div class="nx-eyebrow">' + c[0] + '</div><div class="ins-stat__v">' + c[1] + '</div><div class="ins-stat__s">' + c[2] + '</div></div>'; }).join('') + '</div>';
        }).catch(function (e) { $('#whatif-out', host).innerHTML = errBox(e, 'Simulation failed.'); }).then(function () { btn.classList.remove('is-loading'); });
      };
    }).catch(function (e) { host.innerHTML = '<a class="nx-btn nx-btn--ghost nx-btn--sm ins-back" href="#projections">← Projections</a>' + errBox(e, 'Forecast unavailable.'); });
  }

  /* ================= ASSESS A NEW FLEET ================= */
  var A = { vendor: 'mantis', name: '', vehicles: '', text: '', fmtKind: 'csv', preview: null, mapping: {}, job: null };
  var VENDORS = [['mantis', 'Mantis'], ['motive', 'Motive'], ['samsara', 'Samsara'], ['geotab', 'Geotab'], ['lytx', 'Lytx'], ['nexus', 'Other / Nexus format']];
  function payload() {
    var b = { vendor: A.vendor, format: A.fmtKind };
    if (A.fmtKind === 'json') { try { b.data = JSON.parse(A.text); } catch (e) { throw new Error('The pasted JSON is not valid: ' + e.message); } } else b.csv = A.text;
    return b;
  }
  function sniff(t, name) { return /\.json$/i.test(name || '') || /^\s*[\[{]/.test(t) ? 'json' : 'csv'; }
  function viewAssess() {
    var host = $('#view-assess'); host.hidden = false;
    var h = head('Underwriting', 'Assess a new fleet', 'Load a prospect fleet’s historical telematics export from any vendor. Nexus normalizes it and returns a risk assessment with the same scoring used across the book.');
    h += '<div class="nx-grid ins-split2"><section class="nx-card"><div class="nx-card__head"><h2 class="nx-card__title">1. Source data</h2></div><div class="nx-card__body ins-form">' +
      '<label class="nx-label">Prospect fleet name<input class="nx-input" id="a-name" placeholder="e.g. Riverbend Haulers" value="' + esc(A.name) + '"></label>' +
      '<div class="ins-form2"><label class="nx-label">Source vendor<select class="nx-select" id="a-vendor">' + VENDORS.map(function (v) { return '<option value="' + v[0] + '"' + (A.vendor === v[0] ? ' selected' : '') + '>' + v[1] + '</option>'; }).join('') + '</select></label>' +
      '<label class="nx-label">Vehicles (optional)<input class="nx-input" id="a-veh" type="number" min="1" value="' + esc(A.vehicles) + '"></label></div>' +
      '<label class="nx-label">Upload CSV or JSON <input class="nx-input" id="a-file" type="file" accept=".csv,.json,.txt"></label>' +
      '<label class="nx-label">Or paste export<textarea class="nx-textarea" id="a-text" rows="8" spellcheck="false" placeholder="Paste CSV rows or a JSON array of events">' + esc(A.text) + '</textarea></label>' +
      '<div class="nx-row" style="flex-wrap:wrap;gap:8px"><button class="nx-btn" id="a-sample" type="button">Load vendor sample</button><a class="nx-btn nx-btn--ghost" id="a-tpl" href="/api/import/templates/' + A.vendor + '" target="_blank" rel="noopener">Download template</a><button class="nx-btn nx-btn--primary" id="a-preview" type="button" style="margin-left:auto">Preview import</button></div></div></section>' +
      '<section class="nx-card"><div class="nx-card__head"><h2 class="nx-card__title">What happens next</h2></div><div class="nx-card__body"><ol class="ins-steps"><li><b>Preview.</b> Columns are detected and mapped to the Nexus schema. Check the sample and warnings.</li><li><b>Import.</b> Events load as history only. They never trigger dispatch alerts.</li><li><b>Assess.</b> You get a risk score and tier with confidence, data-quality caveats, benchmarks, a pricing signal and a 90-day projection.</li></ol><p class="nx-dim ins-note">Mileage or trip rows (vin, date, miles, hours) are optional. With them, exposure is reported as events per million miles. Without, an estimate is used and flagged.</p></div></section></div>' +
      '<div id="a-out" class="ins-gap"></div>';
    host.innerHTML = h;
    var sync = function () { A.name = $('#a-name', host).value; A.vendor = $('#a-vendor', host).value; A.vehicles = $('#a-veh', host).value; A.text = $('#a-text', host).value; A.fmtKind = sniff(A.text, A.fileName); $('#a-tpl', host).href = '/api/import/templates/' + A.vendor; };
    host.addEventListener('input', sync); host.addEventListener('change', sync);
    $('#a-file', host).onchange = function (e) { var f = e.target.files[0]; if (!f) return; A.fileName = f.name; var r = new FileReader(); r.onload = function () { $('#a-text', host).value = r.result; sync(); NX.toast('Loaded ' + f.name + ' (' + fmt.number(f.size / 1024, 0) + ' KB)', 'success'); }; r.readAsText(f); };
    $('#a-sample', host).onclick = function () { NX.api('/api/import/templates/' + A.vendor).then(function (t) { $('#a-text', host).value = typeof t === 'string' ? t : JSON.stringify(t, null, 2); sync(); }).catch(function (e) { NX.toast(e.status === 404 ? 'No sample available for this vendor yet' : e.message, 'error'); }); };
    $('#a-preview', host).onclick = function () { sync(); doPreview(host); };
    if (A.preview) renderPreview(host);
  }
  function doPreview(host) {
    var out = $('#a-out', host);
    if (!A.name.trim()) return NX.toast('Enter a fleet name', 'warn');
    if (!A.text.trim()) return NX.toast('Upload or paste data first', 'warn');
    var b; try { b = payload(); } catch (e) { return NX.toast(e.message, 'error'); }
    out.innerHTML = NX.skeleton(3).outerHTML;
    NX.api('/api/import/preview', { method: 'POST', body: b }).then(function (p) { A.preview = p; A.mapping = Object.assign({}, p.suggestedMapping || {}); renderPreview(host); }).catch(function (e) { out.innerHTML = errBox(e, 'Preview failed.'); });
  }
  function renderPreview(host) {
    var p = A.preview, out = $('#a-out', host), cols = p.detectedColumns || [], map = A.mapping, S = p.sample || [];
    var keys = Object.keys(map);
    var h = card('2. Preview and mapping', '<div class="ins-claims"><div class="ins-stat"><div class="nx-eyebrow">Rows detected</div><div class="ins-stat__v">' + fmt.number(p.rows) + '</div></div><div class="ins-stat"><div class="nx-eyebrow">Columns</div><div class="ins-stat__v">' + cols.length + '</div></div><div class="ins-stat"><div class="nx-eyebrow">Mapped fields</div><div class="ins-stat__v">' + keys.length + '</div></div><div class="ins-stat"><div class="nx-eyebrow">Warnings</div><div class="ins-stat__v">' + (p.warnings || []).length + '</div></div></div>' +
      ((p.warnings || []).length ? '<div class="ins-miss" style="margin-top:var(--nx-sp-3)"><b>Warnings.</b>' + list(p.warnings) + '</div>' : '') +
      '<h3 class="nx-eyebrow" style="margin:var(--nx-sp-4) 0 var(--nx-sp-2)">Column mapping</h3><div class="ins-map">' + keys.map(function (k) { return '<label class="ins-map__row"><span class="nx-mono">' + esc(k) + '</span><select class="nx-select" data-map="' + esc(k) + '"><option value="">(not mapped)</option>' + cols.map(function (c) { return '<option' + (map[k] === c ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join('') + '</select></label>'; }).join('') + '</div>' +
      (S.length ? '<h3 class="nx-eyebrow" style="margin:var(--nx-sp-4) 0 var(--nx-sp-2)">Normalized sample</h3><div class="nx-table-wrap"><table class="nx-table"><thead><tr><th>Time</th><th>Event</th><th>Severity</th><th>Vehicle</th><th>Driver</th></tr></thead><tbody>' + S.map(function (s) { return '<tr><td class="nx-mono">' + esc(fmt.dateTime(s.timestamp)) + '</td><td>' + esc(fmt.label(s.eventType)) + '</td><td>' + esc(s.severity || '—') + '</td><td class="nx-mono">' + esc((s.vehicle && (s.vehicle.vin || s.vehicle.plate || s.vehicle.id)) || '—') + '</td><td>' + esc((s.driver && s.driver.name) || '—') + '</td></tr>'; }).join('') + '</tbody></table></div>' : '') +
      '<div class="nx-row" style="margin-top:var(--nx-sp-4)"><button class="nx-btn nx-btn--primary nx-btn--lg" id="a-run" type="button">Import and assess</button></div>') + '<div id="a-job" class="ins-gap"></div>';
    out.innerHTML = h;
    out.querySelectorAll('[data-map]').forEach(function (s) { s.onchange = function () { if (s.value) A.mapping[s.dataset.map] = s.value; else delete A.mapping[s.dataset.map]; }; });
    $('#a-run', out).onclick = function () { runJob(out); };
  }
  function runJob(out) {
    var b; try { b = payload(); } catch (e) { return NX.toast(e.message, 'error'); }
    b.newFleet = { name: A.name.trim(), vendor: A.vendor === 'nexus' ? 'other' : A.vendor }; if (A.vehicles) b.newFleet.vehicles = Number(A.vehicles);
    b.mapping = A.mapping; b.purpose = 'underwriting';
    var jobEl = $('#a-job', out); $('#a-run', out).classList.add('is-loading'); jobEl.innerHTML = NX.skeleton(2).outerHTML;
    NX.api('/api/import/jobs', { method: 'POST', body: b }).then(function (r) { poll((r.job || r).id, jobEl, out); }).catch(function (e) { $('#a-run', out).classList.remove('is-loading'); jobEl.innerHTML = errBox(e, 'Import failed to start.'); });
  }
  function poll(id, jobEl, out) {
    NX.api('/api/import/jobs/' + encodeURIComponent(id)).then(function (j) {
      var p = Math.round((j.progress || 0) * 100);
      if (j.status === 'completed') { $('#a-run', out).classList.remove('is-loading'); return finishJob(j, jobEl); }
      if (j.status === 'failed') { $('#a-run', out).classList.remove('is-loading'); jobEl.innerHTML = card('Import failed', list((j.errors || []).slice(0, 8).map(function (e) { return 'Row ' + e.row + ': ' + e.message; })) || '<span class="nx-dim">No detail reported.</span>', '', 'nx-card--alert'); return; }
      jobEl.innerHTML = card('Importing', '<div class="nx-meter" style="height:10px"><i style="width:' + p + '%"></i></div><p class="nx-dim ins-note" style="margin:8px 0 0">' + esc(fmt.label(j.status)) + ' · ' + p + '% · ' + fmt.number(j.rowsOk) + ' of ' + fmt.number(j.rowsTotal) + ' rows</p>');
      setTimeout(function () { if ($('#a-job')) poll(id, jobEl, out); }, 800);
    }).catch(function (e) { $('#a-run', out).classList.remove('is-loading'); jobEl.innerHTML = errBox(e, 'Lost track of the import job.'); });
  }
  function finishJob(j, jobEl) {
    var q = j.dataQuality || {}, fc = q.fieldCoverage || {}, dr = q.dateRange || {};
    var h = '<div class="ins-claims">' + [['Quality score', fmt.number(q.qualityScore), 'data quality, 0-100'], ['Rows imported', fmt.number(j.rowsOk), fmt.number(j.rowsSkipped) + ' skipped'], ['Date range', q.days != null ? q.days + ' days' : '—', dr.from ? esc(fmt.date(dr.from)) + ' to ' + esc(fmt.date(dr.to)) : ''], ['Vehicles / drivers', fmt.number(q.vehicles) + ' / ' + fmt.number(q.drivers), fmt.number(q.duplicates) + ' duplicates removed']].map(function (c) { return '<div class="ins-stat"><div class="nx-eyebrow">' + c[0] + '</div><div class="ins-stat__v">' + c[1] + '</div><div class="ins-stat__s">' + c[2] + '</div></div>'; }).join('') + '</div>';
    var fk = Object.keys(fc);
    if (fk.length) h += '<h3 class="nx-eyebrow" style="margin:var(--nx-sp-4) 0 var(--nx-sp-2)">Field coverage</h3><div class="ins-fc-grid">' + fk.map(function (k) { var v = fc[k] <= 1 ? fc[k] * 100 : fc[k]; return '<div class="ins-bar" style="grid-template-columns:70px 1fr 40px"><span>' + esc(k.toUpperCase()) + '</span><span class="ins-bar__track"><span class="ins-bar__fill" style="width:' + v + '%;--c:' + (v >= 70 ? 'var(--nx-ok)' : v >= 35 ? 'var(--nx-warn)' : 'var(--nx-sev-high)') + '"></span></span><span class="nx-mono" style="text-align:right">' + Math.round(v) + '%</span></div>'; }).join('') + '</div>';
    if ((q.notes || []).length) h += '<div class="ins-miss" style="margin-top:var(--nx-sp-3)"><b>Data-quality notes.</b>' + list(q.notes) + '</div>';
    if ((j.errors || []).length) h += '<details style="margin-top:var(--nx-sp-3)"><summary class="nx-dim">' + j.errors.length + ' row errors</summary>' + list(j.errors.slice(0, 20).map(function (e) { return 'Row ' + e.row + ': ' + e.message; })) + '</details>';
    var go = function (id) { return '<div class="nx-row" style="margin-top:var(--nx-sp-4)"><a class="nx-btn nx-btn--primary nx-btn--lg" href="#assessment=' + encodeURIComponent(id) + '">View assessment</a></div>'; };
    jobEl.innerHTML = card('3. Import complete', h + (j.assessmentId ? go(j.assessmentId) : '<div class="nx-row" style="margin-top:var(--nx-sp-4)"><button class="nx-btn nx-btn--primary nx-btn--lg" id="a-mk" type="button">Run assessment</button></div>'));
    var mk = $('#a-mk', jobEl); if (mk) mk.onclick = function () { mk.classList.add('is-loading'); NX.api('/api/insurer/assessments', { method: 'POST', body: { jobId: j.id } }).then(function (a) { location.hash = '#assessment=' + encodeURIComponent(a.id); }).catch(function (e) { mk.classList.remove('is-loading'); NX.toast(e.message, 'error'); }); };
    A.preview = null;
  }

  /* ================= ASSESSMENTS LIST + REPORT ================= */
  function viewList() {
    var host = $('#view-assessments'); host.hidden = false; host.replaceChildren(NX.skeleton(4));
    get('/api/insurer/assessments').then(function (r) {
      var L = arr(r, 'assessments');
      var h = head('Underwriting', 'Assessments', 'Prospect fleets assessed from imported history.', '<a class="nx-btn nx-btn--primary" href="#assess">Assess a new fleet</a>');
      h += card('All assessments', L.length ? '<div class="nx-table-wrap"><table class="nx-table"><thead><tr><th>Fleet</th><th>Created</th><th class="num">Risk score</th><th>Tier</th><th class="num">Confidence</th><th class="num">Data quality</th><th class="num">Suggested premium</th></tr></thead><tbody>' + L.map(function (a) {
        var pr = a.pricing || {}; return '<tr data-assess="' + esc(a.id) + '" tabindex="0" style="cursor:pointer"><td class="name"><b>' + esc(a.fleetName || (a.fleet && a.fleet.name) || fleetName(a.fleetId)) + '</b></td><td class="nx-mono">' + esc(fmt.dateTime(a.createdAt)) + '</td><td class="num">' + fmt.number(a.riskScore) + '</td><td>' + I.tierHTML(a.riskTier, a.riskScore) + '</td><td class="num">' + conf(a.confidence) + '</td><td class="num">' + fmt.number(a.dataQualityScore) + '</td><td class="num">' + I.signed(pr.suggestedPremiumAdjustmentPct) + '</td></tr>';
      }).join('') + '</tbody></table></div>' : '<div class="nx-empty"><div class="nx-empty__title">No assessments yet</div><p>Import a prospect fleet’s history to create the first one.</p></div>');
      host.innerHTML = h;
    }).catch(function (e) { host.innerHTML = head('Underwriting', 'Assessments') + errBox(e, 'Assessments unavailable.'); });
  }
  function bars(items, valKey, labelKey, max, colorFn) { return '<div class="ins-bars">' + items.map(function (x) { var v = num(x[valKey]) || 0; return '<div class="ins-bar"><span>' + esc(x[labelKey]) + '</span><span class="ins-bar__track"><span class="ins-bar__fill" style="width:' + Math.min(100, v / (max || 100) * 100) + '%;--c:' + I.tierColor('', v * 0.7) + '"></span></span><span class="nx-mono" style="text-align:right">' + Math.round(v) + '</span></div>'; }).join('') + '</div>'; }
  function bench(b, title) {
    if (!b) return '';
    var rows = (b.metrics || []).map(function (m) { return '<tr><td>' + esc(m.label || m.key) + '</td><td class="num">' + fmt.number(m.fleet, 1) + '</td><td class="num">' + fmt.number(m.portfolio != null ? m.portfolio : m.peers, 1) + '</td><td class="num">' + (m.deltaPct == null ? '—' : (m.deltaPct > 0 ? '+' : '') + m.deltaPct + '%') + '</td></tr>'; }).join('');
    var top = [];
    if (b.portfolioAvgRiskScore != null || b.peerAvgRiskScore != null || b.avgRiskScore != null) top.push('Comparison average risk score ' + fmt.number(pick(b, 'portfolioAvgRiskScore', 'peerAvgRiskScore', 'avgRiskScore'), 1));
    if (b.riskScoreDelta != null) top.push((b.riskScoreDelta > 0 ? '+' : '') + fmt.number(b.riskScoreDelta, 1) + ' points vs comparison');
    if (b.riskRank != null) top.push('Rank ' + b.riskRank + ' of ' + b.of + ' (1 = lowest risk)');
    if (b.percentile != null) top.push('Riskier than ' + Math.round(b.percentile) + '% of comparison fleets');
    if (b.summary) top.push(b.summary);
    return '<div><h3 class="nx-eyebrow" style="margin-bottom:var(--nx-sp-2)">' + title + '</h3>' + list(top) + (rows ? '<div class="nx-table-wrap"><table class="nx-table"><thead><tr><th>Metric</th><th class="num">This fleet</th><th class="num">Comparison</th><th class="num">Delta</th></tr></thead><tbody>' + rows + '</tbody></table></div>' : '') + (!top.length && !rows ? '<span class="nx-dim">No comparison data.</span>' : '') + '</div>';
  }
  function viewReport(id) {
    var host = $('#view-report'); host.hidden = false; host.replaceChildren(NX.skeleton(6));
    get('/api/insurer/assessments/' + encodeURIComponent(id)).then(function (a) {
      var name = a.fleetName || (a.fleet && a.fleet.name) || fleetName(a.fleetId), pr = a.pricing || {}, adj = num(pr.suggestedPremiumAdjustmentPct), q = a.dataQuality || {};
      var h = '<a class="nx-btn nx-btn--ghost nx-btn--sm ins-back nx-no-print" href="#assessments">← Assessments</a>';
      h += head('Underwriting assessment', esc(name), (fleetVendor(a.fleetId) ? I.vendorChip(fleetVendor(a.fleetId)) + ' · ' : '') + 'Prepared ' + esc(fmt.dateTime(a.createdAt)), '<button class="nx-btn" data-share="assessment:' + esc(id) + '" type="button">Share read-only link</button><a class="nx-btn" target="_blank" rel="noopener" href="/api/insurer/assessments/' + encodeURIComponent(id) + '?format=html">Server print view</a><button class="nx-btn nx-btn--primary" id="btn-print" type="button">Print / save PDF</button>');
      var epm = a.eventsPerMillionMiles;
      h += '<div class="nx-kpis">' + kpi('Risk score', fmt.number(a.riskScore), I.tierHTML(a.riskTier, a.riskScore), 'nx-kpi--accent') + kpi('Assessment confidence', conf(a.confidence), 'driven by data quality') + kpi('Data quality', fmt.number(a.dataQualityScore != null ? a.dataQualityScore : q.qualityScore), 'score out of 100') + kpi('Events per million miles', epm == null ? 'n/a' : fmt.number(epm, 0), epm == null ? 'no mileage supplied' : 'exposure-adjusted') + kpi('Collision rate', a.collisionRate == null ? '—' : fmt.number(a.collisionRate, 1) + '%', 'per 100 vehicles, 30d') + '</div>';
      var cav = [].concat(q.notes || [], (a.limitations || []).slice(0, 3));
      if (a.confidence != null && num(a.confidence) < 0.6 || (a.dataQualityScore != null && a.dataQualityScore < 60)) h += '<div class="ins-miss ins-gap"><b>Treat with caution.</b> Data quality limits how far this score can be relied on. See caveats below.</div>';
      h += '<div class="ins-dive-grid">';
      h += card('Pricing signal', (adj == null ? '<span class="nx-dim">No pricing signal.</span>' : '<div class="ins-price"><span class="ins-price__v ' + (adj > 0 ? 'up' : adj < 0 ? 'down' : '') + '">' + I.signed(adj) + '</span><span class="nx-dim">suggested premium adjustment vs. standard rate</span></div>') + list(Array.isArray(pr.rationale) ? pr.rationale : pr.rationale ? [pr.rationale] : []) + '<p class="nx-faint ins-note" style="margin:var(--nx-sp-3) 0 0">Decision support only. Final pricing remains with underwriting.</p>');
      h += card('Data-quality caveats', list(cav) || '<span class="nx-dim">No caveats reported.</span>', 'What limits this assessment');
      var sb = (a.scoreBreakdown || []).map(function (b) { return { label: b.label || fmt.label(b.key), score: b.score }; });
      h += card('Score breakdown', sb.length ? bars(sb, 'score', 'label') : '<span class="nx-dim">Not reported.</span>', 'Component scores 0-100, higher = more risk');
      var dd = a.driverRiskDistribution, ddItems = Array.isArray(dd) ? dd.map(function (x) { return { label: fmt.label(x.band || x.tier || x.label), n: x.count || x.drivers || x.pct }; }) : dd ? Object.keys(dd).map(function (k) { return { label: fmt.label(k), n: dd[k] }; }) : [];
      var dmax = Math.max.apply(null, ddItems.map(function (x) { return x.n || 0; }).concat([1]));
      h += card('Driver risk distribution', ddItems.length ? bars(ddItems, 'n', 'label', dmax) : '<span class="nx-dim">Not reported.</span>');
      h += card('Benchmark', '<div class="ins-bench">' + bench((a.benchmark || {}).vsPortfolio, 'Vs. Nexus portfolio') + bench((a.benchmark || {}).vsVendorPeers, 'Vs. same-vendor peers') + '</div>', '', 'ins-span2');
      var pre = a.preAccidentIndicators || [];
      h += card('Pre-accident indicators', pre.length ? '<ul class="ins-list">' + pre.map(function (x) { return '<li>' + (typeof x === 'string' ? esc(x) : '<b>' + esc(x.label || x.key) + '</b>' + (x.value != null ? ' ' + esc(fmt.number(x.value, 1) + ' ' + (x.unit || '')) : '') + (x.trendPct != null ? ' <span class="ins-trend ' + (x.trendPct > 0 ? 'up' : 'down') + '">' + (x.trendPct > 0 ? '+' : '') + Math.round(x.trendPct) + '%</span>' : '') + (x.note ? '<br><span class="nx-dim ins-note">' + esc(x.note) + '</span>' : '')) + '</li>'; }).join('') + '</ul>' : '<span class="nx-dim">None detected in the imported history.</span>', 'Behavior that tends to precede collisions');
      var rp = a.recommendedPrograms || [];
      h += card('Recommended programs', rp.length ? '<ul class="ins-list">' + rp.map(function (x) { return '<li>' + (typeof x === 'string' ? esc(x) : '<b>' + esc(x.label || x.name || x.key) + '</b>' + (x.expectedRiskReductionPct != null ? ' · −' + Math.round(x.expectedRiskReductionPct) + '% risk' : '') + (x.description || x.rationale ? '<br><span class="nx-dim ins-note">' + esc(x.description || x.rationale) + '</span>' : '')) + '</li>'; }).join('') + '</ul>' : '<span class="nx-dim">None.</span>', 'To bind with the policy');
      var pj = a.projection;
      if (pj) { var R = pj.risk || {}; h += card('90-day projection', (R.current != null ? '<div class="ins-claims" style="margin-bottom:var(--nx-sp-3)">' + [['Risk now', fmt.number(R.current), ''], ['Projected 90d', fmt.number(R.projected90d), R.band90d ? 'band ' + R.band90d[0] + '–' + R.band90d[1] : ''], ['Direction', dirHTML(R.direction), ''], ['Expected loss 90d', money((pj.expected || {}).expectedLossUsd90d), '']].map(function (c) { return '<div class="ins-stat"><div class="nx-eyebrow">' + c[0] + '</div><div class="ins-stat__v" style="font-size:var(--nx-text-xl)">' + c[1] + '</div><div class="ins-stat__s">' + c[2] + '</div></div>'; }).join('') + '</div>' : '') + forecast(pj.series), '', 'ins-span2'); }
      h += card('Limitations', list(a.limitations) || '<span class="nx-dim">None reported.</span>', 'Read before relying on this report', 'ins-span2');
      h += '</div><p class="ins-print-only nx-faint ins-note" style="margin-top:16px">Generated by Nexus Response · ' + esc(fmt.dateTime(new Date())) + '</p>';
      host.innerHTML = h; document.title = name + ' assessment — Nexus Response';
    }).catch(function (e) { host.innerHTML = '<a class="nx-btn nx-btn--ghost nx-btn--sm ins-back" href="#assessments">← Assessments</a>' + errBox(e, 'Assessment unavailable.'); });
  }

  /* ================= SHARE ================= */
  function share(kind, ref) {
    NX.api('/api/insurer/reports', { method: 'POST', body: { kind: kind, refId: ref } }).then(function (r) {
      var url = location.origin + (r.url || '/report/' + r.token);
      var inp = el('input.nx-input', { readonly: true, value: url, 'aria-label': 'Shareable link', onfocus: function (e) { e.target.select(); } });
      var copy = el('button.nx-btn.nx-btn--primary', { type: 'button', onclick: function () { (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject()).then(function () { copy.textContent = 'Copied'; }).catch(function () { inp.select(); document.execCommand && document.execCommand('copy'); copy.textContent = 'Copied'; }); } }, 'Copy link');
      NX.modal('Read-only link', el('div.nx-stack', el('p', { class: 'nx-dim', style: { margin: 0 } }, 'Anyone with this link can view a snapshot of this ' + kind + ' without signing in. It cannot be edited and expires in 30 days.'), el('div.nx-row', { style: { gap: '8px' } }, el('div.nx-grow', inp), copy), el('a', { href: url, target: '_blank', rel: 'noopener' }, 'Open the shared page')));
    }).catch(function (e) { NX.toast(e.status === 404 ? 'Sharing is not available on this backend yet' : e.message, 'error'); });
  }
  document.addEventListener('click', function (e) { var b = e.target.closest('[data-share]'); if (b) { var p = b.dataset.share.split(':'); share(p[0], p.slice(1).join(':')); } });

  /* ================= DIGEST (landing) ================= */
  function item(x) { return typeof x === 'string' ? { text: x } : { text: pick(x, 'headline', 'why', 'label', 'message', 'text', 'note', 'name') || '', sub: pick(x, 'detail', 'rationale', 'reason'), sev: x.severity, name: pick(x, 'name', 'fleetName'), fleetId: x.fleetId, id: x.id || x.incidentId, when: x.timestamp || x.at, where: x.address, type: x.eventType }; }
  function viewDigest() {
    var host = $('#view-digest'); host.hidden = false; host.replaceChildren(NX.skeleton(5));
    get('/api/insurer/digest', { period: 'weekly' }).then(function (D) {
      var att = (D.fleetsNeedingAttention || []).map(item), hs = (D.newHighSeverity || []).map(item), imp = (D.notableImprovements || []).map(item), acts = D.recommendedActions || [];
      var h = head('Weekly digest', 'What needs your attention', esc(D.period && typeof D.period === 'object' ? (D.period.from || '') + ' to ' + (D.period.to || '') : D.period ? fmt.label(D.period) + ' summary' : 'This week'), '<button class="nx-btn nx-btn--primary" data-share="digest:' + esc(typeof D.period === 'string' ? D.period : 'weekly') + '" type="button">Share read-only link</button>');
      h += '<div class="ins-headline">' + esc(D.headline || 'No exceptions this period.') + '</div>';
      h += '<div class="nx-kpis" style="margin-top:var(--nx-sp-4)">' + kpi('Fleets needing attention', String(att.length), att.length ? 'review below' : 'none', att.length ? 'nx-kpi--accent' : '') + kpi('New high-severity events', String(hs.length)) + kpi('Notable improvements', String(imp.length)) + kpi('Claims opened', fmt.number(D.claimsOpened)) + kpi('FNOLs sent', fmt.number(D.fnolsSent), 'first notice of loss') + '</div>';
      var fl = function (x, link) { return '<li class="ins-ex">' + (x.sev ? NX.badgeHTML(x.sev) : '') + '<div><b>' + (x.fleetId && link ? '<a href="#' + esc(x.fleetId) + '">' + esc(x.name || x.fleetId) + '</a>' : esc(x.name || x.type && fmt.label(x.type) || '')) + '</b> ' + esc(x.text) + (x.sub ? '<div class="nx-dim ins-note">' + esc(x.sub) + '</div>' : '') + (x.where || x.when ? '<div class="nx-dim ins-note">' + esc([x.when ? fmt.dateTime(x.when) : '', x.where].filter(Boolean).join(' · ')) + '</div>' : '') + '</div>' + (x.id ? '<button class="nx-btn nx-btn--sm nx-btn--ghost nx-no-print" data-share="incident:' + esc(x.id) + '" type="button">Share</button>' : '') + '</li>'; };
      h += '<div class="ins-dive-grid">' + card('Fleets needing attention', att.length ? '<ul class="ins-exl">' + att.map(function (x) { return fl(x, true); }).join('') + '</ul>' : '<span class="nx-dim">No fleet crossed an attention threshold this period.</span>');
      h += card('New high-severity events', hs.length ? '<ul class="ins-exl">' + hs.map(function (x) { return fl(x, true); }).join('') + '</ul>' : '<span class="nx-dim">None.</span>');
      h += card('Notable improvements', imp.length ? '<ul class="ins-exl">' + imp.map(function (x) { return fl(x, true); }).join('') + '</ul>' : '<span class="nx-dim">None this period.</span>');
      h += card('Recommended actions', acts.length ? '<ol class="ins-list">' + acts.map(function (x) { var i = item(x); return '<li>' + esc(i.text) + (i.sub ? '<br><span class="nx-dim ins-note">' + esc(i.sub) + '</span>' : '') + '</li>'; }).join('') + '</ol>' : '<span class="nx-dim">Nothing to do.</span>') + '</div>';
      h += '<p class="nx-dim ins-note" style="margin-top:var(--nx-sp-4)">Exceptions only. <a href="#portfolio">Open the full portfolio</a> · <a href="#projections">Projections</a></p>';
      host.innerHTML = h;
    }).catch(function (e) { host.hidden = true; $('#view-portfolio').hidden = false; var n = $('#err'); if (n && e.status !== 404) NX.toast('Digest unavailable: ' + e.message, 'warn'); });
  }

  /* ================= NEXUS DRIVE SCORE (per fleet) ================= */
  var COMP = { followingDistance: 'Following distance', braking: 'Braking', acceleration: 'Acceleration', cornering: 'Cornering', speeding: 'Speeding', distraction: 'Distraction', fatigue: 'Fatigue', nightDriving: 'Night driving', collisionHistory: 'Collision history' };
  function scoreColor(v) { return v >= 85 ? 'var(--nx-ok)' : v >= 70 ? 'var(--nx-info)' : v >= 55 ? 'var(--nx-warn)' : 'var(--nx-sev-high)'; }
  function ring(v, label) { var r = 52, c = 2 * Math.PI * r, p = Math.max(0, Math.min(100, v || 0)) / 100; return '<svg class="ins-ring" viewBox="0 0 130 130" role="img" aria-label="Drive score ' + Math.round(v) + '"><circle cx="65" cy="65" r="' + r + '" fill="none" stroke="var(--nx-surface-3)" stroke-width="12"/><circle cx="65" cy="65" r="' + r + '" fill="none" stroke="' + scoreColor(v) + '" stroke-width="12" stroke-linecap="round" stroke-dasharray="' + (c * p) + ' ' + c + '" transform="rotate(-90 65 65)"/><text x="65" y="68" text-anchor="middle" class="rv">' + Math.round(v) + '</text><text x="65" y="86" text-anchor="middle" class="rl">' + esc(label || 'of 100') + '</text></svg>'; }
  function viewDrive(id) {
    var host = $('#view-drive'); host.hidden = false; host.replaceChildren(NX.skeleton(6));
    Promise.all([get('/api/insurer/fleets/' + encodeURIComponent(id) + '/usage-based'), get('/api/insurer/drivers', { fleetId: id, limit: 100 }).catch(function () { return []; })]).then(function (r) {
      var U = r[0], DR = arr(r[1], 'drivers'), P = U.pricing || {}, name = fleetName(id), v = fleetVendor(id);
      var comps = {}, n = {}; DR.forEach(function (d) { Object.keys(d.components || {}).forEach(function (k) { if (num(d.components[k]) != null) { comps[k] = (comps[k] || 0) + d.components[k]; n[k] = (n[k] || 0) + 1; } }); });
      var cl = Object.keys(comps).map(function (k) { return { label: COMP[k] || fmt.label(k), score: comps[k] / n[k] }; }).sort(function (a, b) { return a.score - b.score; });
      var hist = (U.scoreHistory || []).map(function (p) { return { date: p.date, actual: p.score }; });
      var ds = num(U.driveScore), first = hist.length ? hist[0].actual : null, d90 = first != null && ds != null ? ds - first : null;
      var drivers = U.drivers || [], best, worst;
      if (Array.isArray(drivers)) { var sd = drivers.slice().sort(function (a, b) { return b.driveScore - a.driveScore; }); best = sd.slice(0, 5); worst = sd.slice(-5).reverse(); } else { best = drivers.best || []; worst = drivers.worst || []; }
      if (!best.length && DR.length) { var sd2 = DR.slice().sort(function (a, b) { return b.driveScore - a.driveScore; }); best = sd2.slice(0, 5); worst = sd2.slice(-5).reverse(); }
      var dt = function (L, title) { return '<div><h3 class="nx-eyebrow" style="margin-bottom:var(--nx-sp-2)">' + title + '</h3>' + (L.length ? '<div class="nx-table-wrap"><table class="nx-table"><thead><tr><th>Driver</th><th class="num">Score</th><th class="num">30d</th><th class="num">Events</th></tr></thead><tbody>' + L.map(function (d) { var t = num(d.trend30d); return '<tr><td>' + esc(d.name) + '</td><td class="num"><b style="color:' + scoreColor(d.driveScore) + '">' + fmt.number(d.driveScore) + '</b></td><td class="num"><span class="ins-trend ' + (t > 0 ? 'down' : t < 0 ? 'up' : 'flat') + '">' + (t == null ? '—' : (t > 0 ? '+' : '') + t) + '</span></td><td class="num">' + fmt.number(d.events30d) + '</td></tr>'; }).join('') + '</tbody></table></div>' : '<span class="nx-dim">No data.</span>') + '</div>'; };
      var cur = num(P.currentAdjustmentPct), proj = num(P.projectedRenewalAdjustmentPct), mo = num(P.monthlyAdjustmentUsd);
      var h = '<a class="nx-btn nx-btn--ghost nx-btn--sm ins-back nx-no-print" href="#portfolio">← Portfolio</a><div class="ins-subtabs nx-no-print"><a href="#' + esc(id) + '">Risk overview</a><a class="is-active" href="#' + esc(id) + '/drive">Nexus Drive Score</a></div>';
      h += head('Nexus Drive Score', esc(name), (v ? I.vendorChip(v) + ' · ' : '') + (U.policyPeriod ? 'Policy period ' + esc(fmt.date(U.policyPeriod.start)) + ' to ' + esc(fmt.date(U.policyPeriod.end)) : 'Behavior-based pricing view'), '<button class="nx-btn" data-share="fleet:' + esc(id) + '" type="button">Share read-only link</button><button class="nx-btn" id="btn-print" type="button">Print / save PDF</button>');
      h += '<div class="ins-dive-grid"><section class="nx-card"><div class="nx-card__head"><h2 class="nx-card__title">Current score</h2><span class="nx-dim ins-note">Higher is better</span></div><div class="nx-card__body ins-ringrow">' + ring(ds) + '<div><div class="ins-stat__v" style="color:' + scoreColor(ds) + '">' + (ds >= 85 ? 'Excellent' : ds >= 70 ? 'Good' : ds >= 55 ? 'Fair' : 'Needs work') + '</div><div class="nx-dim ins-note">' + (d90 == null ? '' : (d90 >= 0 ? '+' : '') + d90.toFixed(0) + ' points over ' + hist.length + ' days') + '</div><p class="nx-dim ins-note" style="margin:8px 0 0">Behavior is scored continuously from historical and current telematics and camera data. Pricing moves with the score.</p></div></div></section>';
      h += card('Pricing', '<div class="ins-claims" style="grid-template-columns:repeat(2,minmax(0,1fr))"><div class="ins-stat"><div class="nx-eyebrow">Current adjustment</div><div class="ins-price__v ' + (cur > 0 ? 'up' : cur < 0 ? 'down' : '') + '" style="font-size:var(--nx-text-3xl)">' + I.signed(cur) + '</div></div><div class="ins-stat"><div class="nx-eyebrow">Projected at renewal</div><div class="ins-price__v ' + (proj > 0 ? 'up' : proj < 0 ? 'down' : '') + '" style="font-size:var(--nx-text-3xl)">' + I.signed(proj) + '</div></div></div><p style="font-size:var(--nx-text-sm);margin:var(--nx-sp-3) 0 0">' + (mo != null ? 'About <b>' + money(Math.abs(mo)) + ' per month</b> ' + (mo > 0 ? 'above' : 'below') + ' the base premium' : '') + (P.basePremiumUsd != null ? ' of ' + money(P.basePremiumUsd) + ' per year' : '') + '.</p><p class="nx-faint ins-note" style="margin:var(--nx-sp-2) 0 0">Decision support only. Final pricing remains with underwriting.</p>');
      h += card('Score history', hist.length > 1 ? forecast(hist).replace(/<div class="ins-legend">.*<\/div>/, '') : '<span class="nx-dim">No history reported.</span>', 'Daily Nexus Drive Score', 'ins-span2');
      h += card('Score components', cl.length ? bars(cl.map(function (c) { return { label: c.label, score: c.score }; }), 'score', 'label', 100, scoreColor) : '<span class="nx-dim">Component scores unavailable.</span>', 'Fleet average of driver scores · lowest first');
      var wc = U.whatChanged30d || [];
      h += card('What changed in 30 days', wc.length ? '<ul class="ins-list ins-chg">' + wc.map(function (x) { var d = num(x.deltaPts); return '<li><span class="ins-trend ' + (d > 0 ? 'down' : d < 0 ? 'up' : 'flat') + '">' + (d > 0 ? '+' : '') + d + ' pts</span> ' + esc(x.label) + '</li>'; }).join('') + '</ul>' : '<span class="nx-dim">No significant changes.</span>', 'Positive = improved');
      var lv = U.topImprovementLevers || [];
      h += card('How to improve', lv.length ? '<ul class="ins-improve">' + lv.map(function (x) { return '<li><span class="gain">+' + fmt.number(x.potentialPts) + '</span><span>' + esc(x.label) + '<br><span class="nx-dim ins-note">Potential saving ' + money(x.potentialSavingsUsd) + ' per year</span></span></li>'; }).join('') + '</ul>' : '<span class="nx-dim">No levers identified.</span>', 'Ranked by potential saving');
      h += card('Drivers', '<div class="ins-bench">' + dt(best, 'Best drivers') + dt(worst, 'Needs coaching') + '</div>', '', 'ins-span2') + '</div>';
      host.innerHTML = h;
    }).catch(function (e) { host.innerHTML = '<a class="nx-btn nx-btn--ghost nx-btn--sm ins-back" href="#' + esc(id) + '">← Policyholder</a>' + errBox(e, 'Drive Score unavailable.'); });
  }

  /* ================= routing ================= */
  function match(h) { return h === '' || /^(projections|assess|assessments|assessment=|digest)/.test(h) || /\/drive$/.test(h); }
  function hide() { VIEWS.forEach(function (v) { $('#view-' + v).hidden = true; }); }
  function nav(h) { var k = h === '' || h === 'digest' ? 'digest' : /^projections/.test(h) ? 'projections' : /^assessment=/.test(h) || h === 'assessments' ? 'assessments' : h === 'assess' ? 'assess' : 'portfolio'; document.querySelectorAll('#ins-nav a').forEach(function (a) { a.classList.toggle('is-active', a.dataset.nav === k); a.setAttribute('aria-current', a.dataset.nav === k ? 'page' : 'false'); }); }
  function route(h) {
    if (h === '' || h === 'digest') viewDigest(); else if (/\/drive$/.test(h)) viewDrive(h.replace(/\/drive$/, '')); else if (/^projections/.test(h)) viewProjections((h.split('/')[1] || '')); else if (h === 'assess') viewAssess(); else if (h === 'assessments') viewList(); else if (/^assessment=/.test(h)) viewReport(h.slice(11));
  }
  document.addEventListener('click', function (e) {
    var r = e.target.closest('tr[data-pfleet]'); if (r) location.hash = '#projections/' + r.dataset.pfleet;
    var a = e.target.closest('tr[data-assess]'); if (a) location.hash = '#assessment=' + a.dataset.assess;
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Enter') { var r = e.target.closest && e.target.closest('tr[data-pfleet],tr[data-assess]'); if (r) r.click(); } });
  window.INS_V3 = { match: match, hide: hide, nav: nav, route: route };
  nav(decodeURIComponent(location.hash.slice(1)));
})();
