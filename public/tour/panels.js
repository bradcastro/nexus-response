/* Tour panels: "What's real" (capability matrix) and "Business value". Vanilla, depends on brand.js (NX). */
(function () {
  'use strict';
  var el = NX.el;

  /* ---------------- What's real ---------------- */
  // Provisional list used only when GET /api/capabilities is unavailable. Deliberately conservative.
  var PROVISIONAL = [
    { name: 'Mantis event adapter', status: 'working_synthetic', notes: 'Built to an ASSUMED payload (docs/MANTIS.md). Not validated against a real Mantis spec or feed.' },
    { name: 'Camera evidence on incidents', status: 'working_synthetic', notes: 'Clips and frames are placeholders; AI verdicts come from the synthetic payload.' },
    { name: 'Dispatch queue, incident detail, timeline', status: 'working_synthetic', notes: 'Runs on seeded and generated demo data.' },
    { name: 'Tow dispatch, fleet/driver notifications, FNOL, OEM claim submit', status: 'simulated', notes: 'Logged to the timeline only. Nothing is sent to a real provider, carrier or OEM.' },
    { name: 'Live Mantis integration (real events)', status: 'planned', notes: 'Needs Mantis API access and an agreed specification.' },
    { name: 'Real roadside provider network and dealer integrations', status: 'planned', notes: 'Provider and dealer data are invented demo records.' }
  ];

  function normCaps(r) {
    var arr = Array.isArray(r) ? r : (r && (r.capabilities || r.features || r.items || r.matrix)) || [];
    if (!Array.isArray(arr) && typeof arr === 'object') arr = Object.keys(arr).map(function (k) { var v = arr[k]; return typeof v === 'string' ? { key: k, status: v } : Object.assign({ key: k }, v); });
    return arr.map(function (c) {
      var status = c.status || c.classification || c.kind || c.level || c.class;
      var ev = c.evidence; if (Array.isArray(ev)) ev = ev.join('; '); else if (ev && typeof ev === 'object') ev = ev.summary || ev.note || JSON.stringify(ev);
      return { name: c.name || c.label || c.title || c.feature || c.key, area: c.area || c.group || c.category || '', status: NX.capKind(status) || 'planned', rawStatus: status, notes: c.notes || c.note || c.description || '', evidence: ev || '' };
    });
  }

  // returns an element; fills asynchronously
  function whatsReal(opts) {
    opts = opts || {};
    var root = el('div.t-real');
    root.append(el('p.t-lede', 'Every feature in this demo is classified into one of four kinds, so you can see what is working, what runs on synthetic data, what is simulated, and what still needs an integration.'), NX.capLegend());
    var body = el('div.t-real__body', NX.skeleton(4));
    root.append(body);
    NX.api('/api/capabilities').then(function (r) {
      var caps = normCaps(r);
      if (!caps.length) throw new Error('empty capability list');
      draw(body, caps, false, r);
      if (r && Array.isArray(r.honesty) && r.honesty.length) body.append(el('div.t-note', el('b', 'Ground rules. '), r.honesty.join(' ')));
    }).catch(function (err) {
      draw(body, normCaps(PROVISIONAL), true, null, err);
    });
    return root;
  }

  function draw(body, caps, provisional, raw, err) {
    body.innerHTML = '';
    if (provisional) {
      body.append(el('div.t-note.t-note--warn', el('b', 'Provisional list. '), 'The live capability endpoint (/api/capabilities) did not respond' + (err && err.status ? ' (' + err.status + ')' : '') + ', so this is a short client-side summary. It will be replaced by the backend classification when available.'));
    } else if (raw && raw.generatedAt) {
      body.append(el('p.t-meta', 'Classification from the backend, generated ' + NX.fmt.dateTime(raw.generatedAt) + '.'));
    }
    // counts
    var counts = {}; caps.forEach(function (c) { counts[c.status] = (counts[c.status] || 0) + 1; });
    body.append(el('div.t-counts', Object.keys(NX.capabilities).map(function (k) { return el('span.t-count', NX.capBadge(k), el('b.nx-mono', String(counts[k] || 0))); })));
    var groups = {}; var order = [];
    caps.forEach(function (c) { var g = c.area || 'Features'; if (!groups[g]) { groups[g] = []; order.push(g); } groups[g].push(c); });
    order.forEach(function (g) {
      body.append(el('div.nx-eyebrow.t-group', g));
      var list = el('div.t-matrix', { role: 'list' });
      groups[g].forEach(function (c) {
        list.append(el('div.t-matrix__row', { role: 'listitem' },
          el('div.t-matrix__name', c.name),
          el('div.t-matrix__badge', NX.capBadge(c.status)),
          el('div.t-matrix__why', c.notes || '', c.evidence ? el('div.t-matrix__ev', el('span.nx-eyebrow', 'Evidence '), c.evidence) : null)));
      });
      body.append(list);
    });
  }

  /* ---------------- Business value ---------------- */
  function count(arr, fn) { var n = 0; arr.forEach(function (x) { if (fn(x)) n++; }); return n; }
  function secBetween(a, b) { return Math.max(0, Math.round((new Date(b) - new Date(a)) / 1000)); }

  // Computes metrics from seeded/synthetic data only. Returns {areas:[...]}.
  function computeValue(inc, fleetIncidents, kpis) {
    var areas = [];
    var tl = (inc && inc.timeline) || [];
    var first = tl[0] && tl[0].t;
    var rec = tl.filter(function (t) { return t.action === 'roadside_recommended'; })[0];
    var disp = tl.filter(function (t) { return t.actor === 'dispatcher' && /dispatch/i.test(t.action); })[0];
    var systemSteps = count(tl, function (t) { return t.actor === 'system'; });
    var humanSteps = tl.length - systemSteps;
    var all = fleetIncidents || [];
    var times = all.map(function (i) { return +new Date(i.timestamp); }).filter(function (n) { return n; });
    var period = times.length ? NX.fmt.date(Math.min.apply(null, times)) + ' to ' + NX.fmt.date(Math.max.apply(null, times)) : 'period unavailable';
    var srcFleet = (inc && inc.fleetName) || 'the demo fleet';

    // 1 faster coordination
    var a1 = { key: 'coordination', title: 'Faster coordination', measured: [], assumptions: [], illustrative: 'A like-for-like comparison with a manual process would need a measured baseline from a real operation. None exists here.' };
    if (rec && first) a1.measured.push({ label: 'Event received to recommended roadside action', value: secBetween(first, rec.t) + ' s', src: 'This synthetic event\'s timeline (' + inc.id + ')' });
    if (kpis && kpis.mttrMin != null) a1.measured.push({ label: 'Mean time to resolve, ' + srcFleet, value: NX.fmt.duration(kpis.mttrMin), src: 'Seeded fleet summary, last 30 days (synthetic)' });
    a1.assumptions = ['Timestamps are generated by the demo backend, not by a live fleet.', 'The recommendation is produced automatically; any later step depends on when a person acts.'];
    areas.push(a1);

    // 2 less manual work
    areas.push({ key: 'manual', title: 'Less manual work', measured: inc ? [
      { label: 'Steps completed automatically on this event', value: systemSteps + ' of ' + tl.length, src: 'Timeline entries by actor "system" (' + inc.id + ')' },
      { label: 'Steps that needed a person', value: String(humanSteps), src: 'Timeline entries by dispatcher, fleet or provider' }] : [],
      assumptions: ['Each automatic step is one lookup or entry a dispatcher would otherwise do by hand (VIN decode, camera check, provider ranking, context lookup).', 'Minutes saved are not estimated: no time-and-motion data exists.'],
      illustrative: 'Time saved per step is not measured, so no hours are claimed.' });

    // 3 fewer unnecessary responses
    var fp = count(all, function (i) { return i.camera && (i.camera.aiVerdict === 'false_positive'); });
    var dismissed = count(all, function (i) { return i.status === 'dismissed'; });
    areas.push({ key: 'unnecessary', title: 'Fewer unnecessary responses', measured: all.length ? [
      { label: 'Camera-classified false positives', value: fp + ' of ' + all.length + ' events', src: srcFleet + ', ' + period + ' (seeded + generated demo events)' },
      { label: 'Events dismissed without dispatch', value: dismissed + ' of ' + all.length, src: 'Same dataset' }] : [],
      assumptions: ['Seeded false-positive rates are set by the demo generator, so the percentage is not evidence of real-world rates.', 'Only counts events; does not price an avoided tow.'],
      illustrative: 'What a real avoided response is worth depends on the fleet and provider contract. No value is stated.' });

    // 4 documentation
    var checks = inc ? [
      ['Camera verdict and confidence', inc.camera && inc.camera.aiVerdict],
      ['Camera clips or frames', inc.camera && ((inc.camera.clips || []).length || (inc.camera.snapshots || []).length)],
      ['Driver and vehicle identified', inc.driver && inc.driver.name && inc.vehicle && inc.vehicle.vin],
      ['Location and speed', inc.location && inc.location.address],
      ['GPS trail around the event', inc.trail && inc.trail.length],
      ['Trip and last-stop context', inc.trip],
      ['Equipment and load estimate', inc.load && inc.equipment],
      ['Warranty and VIN decode', inc.warranty],
      ['Timeline of actions', tl.length > 3]
    ] : [];
    var have = count(checks, function (c) { return !!c[1]; });
    areas.push({ key: 'documentation', title: 'More complete incident documentation', measured: inc ? [
      { label: 'Evidence fields present on this event', value: have + ' of ' + checks.length, src: 'Field check on ' + inc.id + ' (synthetic)' }] : [],
      detail: checks, assumptions: ['The checklist is our own list of fields, not an industry standard.', 'Some fields (load, trip) are inferred estimates with a stated confidence, not measurements.'],
      illustrative: 'Whether this is "more complete" than a fleet\'s current process is not measured.' });

    // 5 warranty
    var elig = count(all, function (i) { return i.warranty && i.warranty.claimEligible; });
    var inw = count(all, function (i) { return i.warranty && i.warranty.inWarranty; });
    areas.push({ key: 'warranty', title: 'Potential warranty recovery', measured: all.length ? [
      { label: 'Events flagged claim-eligible', value: elig + ' of ' + all.length, src: srcFleet + ', ' + period + ' (demo eligibility rule)' },
      { label: 'Events on in-warranty vehicles', value: String(inw), src: 'Same dataset, VIN decode in demo' }] : [],
      assumptions: ['Eligibility is a simplified demo rule on seeded VIN and fault data.', 'No claim is submitted to an OEM and none has been accepted. No dollar value is stated.'],
      illustrative: 'Actual recovery depends on OEM acceptance and the fleet\'s warranty terms. Treat as potential only.' });
    return { areas: areas, period: period, n: all.length };
  }

  var HYPOTHESES = [
    { q: 'Who pays?', h: 'Hypotheses to test: (a) the fleet, as an add-on to a camera subscription; (b) the insurer, for documented, camera-verified incidents; (c) roadside and recovery providers, per job. We have not tested any of these.' },
    { q: 'How could it fit into Mantis\'s offering?', h: 'Possible shapes: an embedded response module inside the Mantis experience, a referral or integration partnership, or a white-labelled workflow. Which one fits is for Mantis to say.' },
    { q: 'What would we need from Mantis?', h: 'Questions: which event types and fields are available, how events are delivered (webhook, API, batch), media access and retention, data-sharing rights, and who owns the fleet relationship.' },
    { q: 'What would prove value?', h: 'Question: a joint pilot on a small fleet, measuring time to dispatch, unnecessary responses and documentation completeness against that fleet\'s own baseline.' }
  ];

  var portfolioInsight = null;
  function leadNote() {
    return el('div', el('p.t-meta', 'We do not claim that Mantis flags problems earlier. In the current synthetic data Mantis fleets show a slightly lower mean warning lead than the other vendors pooled, with higher camera coverage and richer signals. The differences are small and not statistically significant.'), portfolioInsight ? el('p.t-meta', el('b', 'Backend figures (synthetic): '), portfolioInsight) : el('p.t-meta', 'Backend comparison figures were not available.'));
  }

  function valuePanel(ctx) {
    var root = el('div.t-value');
    root.append(el('div.t-note', el('b', 'How to read this. '), 'Every number below is computed in your browser from seeded or synthetic demo data, with the source and period shown. ', NX.el('span.t-tag.t-tag--ill', 'Illustrative'), ' marks what is not measured. No dollar savings or pricing are claimed.'));
    var body = el('div.t-value__body', NX.skeleton(5));
    root.append(body);
    var fleetId = ctx.inc && ctx.inc.fleetId;
    Promise.all([
      fleetId ? NX.api('/api/incidents', { query: { fleetId: fleetId, limit: 300 } }).catch(function () { return null; }) : Promise.resolve(null),
      fleetId ? NX.api('/api/fleets/' + encodeURIComponent(fleetId) + '/summary').catch(function () { return null; }) : Promise.resolve(null)
    ,NX.api('/api/predict/portfolio').catch(function () { return null; })
    ]).then(function (r) {
      portfolioInsight = r[2] && r[2].insight;
      var list = r[0] && (r[0].incidents || r[0]);
      var res = computeValue(ctx.inc, Array.isArray(list) ? list : [], r[1] && r[1].kpis);
      body.innerHTML = '';
      if (!ctx.inc) body.append(el('div.t-note.t-note--warn', 'Generate a synthetic event first (step 1) to see event-level measurements. Fleet-level figures need the same event to pick a fleet.'));
      res.areas.forEach(function (a) { body.append(areaCard(a)); });
      body.append(el('section.t-area', el('h3.t-area__title', 'Does camera-first data warn earlier?'), el('div.t-tagrow', el('span.t-tag.t-tag--ill', 'Not claimed')), leadNote()));
      body.append(hypothesesCard());
    });
    return root;
  }

  function areaCard(a) {
    var c = el('section.t-area', el('h3.t-area__title', a.title));
    if (a.measured.length) {
      c.append(el('div.t-tagrow', el('span.t-tag.t-tag--m', 'Measured on demo data')));
      a.measured.forEach(function (m) { c.append(el('div.t-metric', el('div.t-metric__v.nx-mono', m.value), el('div.t-metric__l', m.label, el('div.t-metric__s', 'Source: ' + m.src)))); });
    } else {
      c.append(el('div.t-tagrow', el('span.t-tag.t-tag--ill', 'Nothing measured yet')), el('p.t-meta', 'No data available from the backend for this area.'));
    }
    if (a.detail && a.detail.length) {
      c.append(el('ul.t-checks', a.detail.map(function (d) { return el('li', { class: d[1] ? 'is-yes' : 'is-no' }, el('span.t-checks__g', { 'aria-hidden': 'true' }, d[1] ? '✓' : '–'), d[0], el('span.nx-sr', d[1] ? ' present' : ' missing')); })));
    }
    c.append(el('div.t-tagrow', el('span.t-tag.t-tag--ill', 'Illustrative')), el('p.t-meta', a.illustrative));
    c.append(el('details.t-assume', el('summary', 'Assumptions'), el('ul', a.assumptions.map(function (s) { return el('li', s); }))));
    return c;
  }

  function hypothesesCard() {
    return el('section.t-area.t-area--hyp',
      el('h3.t-area__title', 'Who pays, and how it could fit'),
      el('div.t-tagrow', el('span.t-tag.t-tag--hyp', 'Hypotheses and questions, not findings')),
      el('p.t-meta', 'Mantis is a prospective partner. Nothing here describes an agreement, a price or a commitment. These are questions to explore together.'),
      HYPOTHESES.map(function (x) { return el('div.t-hyp', el('b', x.q), el('p', x.h)); }));
  }

  window.TourPanels = { whatsReal: whatsReal, valuePanel: valuePanel, computeValue: computeValue };
})();
