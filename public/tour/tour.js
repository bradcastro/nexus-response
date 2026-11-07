/* Guided Mantis tour. Vanilla JS on top of brand.js (NX) and panels.js. */
(function () {
  'use strict';
  var el = NX.el;
  var KEY = 'nx-tour-v1';
  var FALLBACK_FLEET = 'fleet_redline';

  var FULL = [
    { id: 'generate', label: 'Generate event' },
    { id: 'open', label: 'Open in Dispatch' },
    { id: 'evidence', label: 'Review evidence' },
    { id: 'recommend', label: 'Recommended response' },
    { id: 'fleet', label: 'Follow into Fleet' },
    { id: 'audit', label: 'Audit and value' }
  ];
  var EXEC = [
    { id: 'generate', label: 'Generate event' },
    { id: 'respond', label: 'Event to response' },
    { id: 'summary', label: 'Summary' }
  ];

  var S = load();
  function load() {
    try { var s = JSON.parse(localStorage.getItem(KEY)); if (s && typeof s === 'object') return s; } catch (e) { /* none */ }
    return { mode: null, step: 0, scenario: null, applied: false };
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify({ mode: S.mode, step: S.step, scenario: S.scenario, applied: S.applied })); } catch (e) { /* ignore */ } }
  var cache = { inc: null, comms: null, busy: false };

  var $app = document.getElementById('tour');
  function steps() { return S.mode === 'exec' ? EXEC : FULL; }

  /* ---------------- helpers ---------------- */
  function errBox(err, retry, what) {
    var status = err && err.status;
    var msg = status === 404 ? 'This backend does not have that endpoint yet.' : (status ? 'The backend returned an error (' + status + ').' : 'The backend could not be reached. Check that the server is running.');
    return el('div.t-error', { role: 'alert' }, el('b', (what || 'Something went wrong') + '. '), msg, err && err.message ? el('div.t-error__d.nx-mono', String(err.message).slice(0, 200)) : null,
      retry ? el('div.t-actions', el('button.nx-btn.nx-btn--sm', { onclick: retry }, 'Try again')) : null);
  }
  function synthBanner() {
    return el('div.t-synth', el('span.t-tag.t-tag--m', 'Synthetic'), el('span', (S.scenario && S.scenario.demoTag ? 'Demo tag ' + S.scenario.demoTag + '. ' : '') + 'Synthetic event. Not real Mantis data. The Mantis adapter is built to an ', el('b', 'assumed'), ' payload (docs/MANTIS.md).'));
  }
  function incId() { return S.scenario && S.scenario.incidentId; }
  function dispatchUrl() { return (S.scenario && S.scenario.deepLinks && S.scenario.deepLinks.dispatch) || ('/dispatch/#' + encodeURIComponent(incId() || '')); }
  function fleetUrl() {
    if (S.scenario && S.scenario.deepLinks && S.scenario.deepLinks.fleet) return S.scenario.deepLinks.fleet;
    var f = (cache.inc && cache.inc.fleetId) || FALLBACK_FLEET;
    return '/fleet/?fleet=' + encodeURIComponent(f) + '#incident=' + encodeURIComponent(incId() || '');
  }
  function loadInc(force) {
    if (!incId()) return Promise.reject(new Error('No event generated yet'));
    if (cache.inc && cache.inc.id === incId() && !force) return Promise.resolve(cache.inc);
    return NX.api('/api/incidents/' + encodeURIComponent(incId())).then(function (i) { cache.inc = i; return i; });
  }
  function withInc(host, render) {
    host.append(NX.skeleton(4));
    function go(force) {
      loadInc(force).then(function (inc) { host.innerHTML = ''; render(inc); }).catch(function (e) {
        host.innerHTML = ''; host.append(errBox(e, function () { host.innerHTML = ''; host.append(NX.skeleton(4)); go(true); }, 'Could not load the incident'));
        if (e && e.status === 404) host.append(el('p.t-meta', 'The event may have been cleared by a reset. Go back to step 1 to generate a new one.'));
      });
    }
    go(false);
  }

  /* POST /api/demo/mantis-scenario -> 201 {incidentId, demoTag, deepLinks, recommendedResponse{priority,actions[],rationale[],disclaimer}, label, payloadAssumed} */
  function normScenario(r) {
    return { incidentId: r.incidentId, demoTag: r.demoTag, label: r.label, deepLinks: r.deepLinks || {}, recommended: r.recommendedResponse || null, payloadAssumed: r.payloadAssumed !== false, fleet: r.fleet, createdAt: new Date().toISOString() };
  }

  function recommendation() {
    var rr = (S.scenario && S.scenario.recommended) || {};
    return { priority: rr.priority, actions: rr.actions || [], rationale: rr.rationale || [], disclaimer: rr.disclaimer };
  }

  function evidenceCard(inc, compact) {
    var cam = inc.camera || {};
    var snap = (cam.snapshots && cam.snapshots[0]) || (cam.clips && cam.clips[0]);
    var wrap = el('div.t-evidence');
    var media = el('figure.t-media');
    if (snap && snap.url) {
      media.append(el('img', { src: snap.url, alt: 'Camera frame (' + (snap.type || 'road') + ' view), placeholder image for the synthetic event', loading: 'lazy' }));
      media.append(el('figcaption', snap.placeholder ? 'Placeholder frame. Real Mantis media is not connected.' : 'Camera frame'));
    } else media.append(el('div.t-media__none', 'No frame in this payload'));
    var facts = el('div.t-facts',
      el('div.t-fact', el('span.nx-eyebrow', 'Vendor verdict'), el('b', cam.aiVerdict ? NX.fmt.label(cam.aiVerdict) : 'None')),
      el('div.t-fact', el('span.nx-eyebrow', 'Confidence'), el('b.nx-mono', cam.confidence != null ? Math.round(cam.confidence * 100) + '%' : 'n/a')),
      el('div.t-fact', el('span.nx-eyebrow', 'Verified by camera'), el('b', cam.verified ? 'Yes' : 'No')),
      el('div.t-fact', el('span.nx-eyebrow', 'Source'), el('b', NX.fmt.label(inc.provider || ''))));
    wrap.append(media, facts);
    var sigs = (cam.signals || []);
    if (sigs.length) wrap.append(el('div.t-block', el('div.nx-eyebrow', 'Camera signals'), el('ul.t-list', sigs.map(function (s) { return el('li', s); }))));
    var ds = inc.signals || [];
    if (ds.length && !compact) wrap.append(signalTable(ds));
    else if (ds.length) {
      var trig = ds.filter(function (s) { return s.triggered; });
      wrap.append(el('div.t-block', el('div.nx-eyebrow', 'Triggered driver and road signals'), trig.length ? el('ul.t-list', trig.map(function (s) { return el('li', (s.key === 'seatbelt_unbuckled' ? 'Seatbelt unbuckled' : s.label) + ': ' + fmtSig(s)); })) : el('p.t-meta', 'None triggered on this event.')));
    }
    return wrap;
  }
  function fmtSig(s) {
    if (s.unit === 's' || s.unit === 'g' || s.unit === 'score') return s.value + ' ' + s.unit;
    if (s.value === 1 || s.value === true) return 'yes';
    if (s.value === 0 || s.value === false) return 'no';
    return String(s.value) + (s.unit ? ' ' + s.unit : '');
  }
  var DRIVER = ['drowsiness_score', 'phone_use', 'smoking', 'seatbelt_unbuckled', 'eyes_off_road_s', 'facing_forward'];
  function signalTable(ds) {
    function group(title, rows, note) {
      return el('div.t-block', el('div.nx-eyebrow', title), rows.length ? el('div.t-sigs', rows.map(function (s) {
        return el('div', { class: 't-sig' + (s.triggered ? ' is-on' : '') }, el('span', s.key === 'seatbelt_unbuckled' ? 'Seatbelt unbuckled' : s.label), el('b.nx-mono', fmtSig(s)), el('span.t-sig__st', s.triggered ? 'Triggered' : 'Normal'));
      })) : el('p.t-meta', note));
    }
    var drv = ds.filter(function (s) { return DRIVER.indexOf(s.key) > -1; });
    var road = ds.filter(function (s) { return DRIVER.indexOf(s.key) === -1; });
    return el('div', group('Driver-facing signals', drv, 'No driver-facing signals in this payload.'), group('Road-facing signals', road, 'No road-facing signals in this payload.'));
  }

  function auditList(inc) {
    var tl = inc.timeline || [];
    if (!tl.length) return el('p.t-meta', 'No timeline entries yet.');
    return el('ol.t-timeline', tl.map(function (t) {
      var sim = /simulated/i.test((t.note || '') + (t.action || '')) || t.simulated;
      return el('li', el('span.t-timeline__t.nx-mono', NX.fmt.time(t.t)), el('span.t-timeline__a', NX.badge(t.actor || 'system', 'plain')),
        el('span.t-timeline__n', el('b', NX.fmt.label(t.action || '')), t.note ? ' ' + t.note : '', sim ? ' ' : null, sim ? NX.capBadge('simulated') : null));
    }));
  }

  /* ---------------- actions ---------------- */
  function generate(btn, host) {
    btn.classList.add('is-loading'); host.querySelectorAll('.t-error').forEach(function (n) { n.remove(); });
    NX.api('/api/demo/mantis-scenario', { method: 'POST', body: {} }).then(function (r) {
      if (!r || !r.incidentId) throw new Error('The response did not include an incident id');
      S.scenario = normScenario(r); S.applied = false; cache = { inc: null, comms: null }; save();
      NX.toast('Synthetic Mantis event created: ' + incId(), 'success'); render();
    }).catch(function (e) {
      btn.classList.remove('is-loading'); host.append(errBox(e, function () { generate(btn, host); }, 'Could not create the synthetic event'));
    });
  }

  function applyResponse(btn, host) {
    btn.classList.add('is-loading'); host.querySelectorAll('.t-error').forEach(function (n) { n.remove(); });
    NX.api('/api/comms/templates', { query: { kind: 'fleet_manager' } }).catch(function () { return []; }).then(function (tpl) {
      var list = Array.isArray(tpl) ? tpl : (tpl && tpl.templates) || [];
      var body = { channel: 'sms', to: { type: 'fleet_manager' }, actor: 'dispatcher' };
      if (list[0] && list[0].key) body.template = list[0].key; else body.message = 'Nexus: driver coaching check-in recommended for incident ' + incId() + ' (demo).';
      return NX.api('/api/incidents/' + encodeURIComponent(incId()) + '/notify', { method: 'POST', body: body });
    }).then(function () {
      S.applied = true; save(); cache.inc = null; cache.comms = null; NX.toast('Fleet manager notified (simulated)', 'success'); render();
    }).catch(function (e) {
      btn.classList.remove('is-loading'); host.append(errBox(e, function () { applyResponse(btn, host); }, 'Could not notify the fleet manager'));
    });
  }

  function resetDemo() {
    var m;
    var go = el('button.nx-btn.nx-btn--danger', { onclick: function () {
      go.classList.add('is-loading');
      NX.api('/api/demo/reset', { method: 'POST', body: {} }).then(function () {
        m.close(); S = { mode: S.mode, step: 0, scenario: null, applied: false }; cache = { inc: null, comms: null }; save();
        NX.toast('Demo data reset', 'success'); render();
      }).catch(function (e) {
        go.classList.remove('is-loading');
        var box = m.el.querySelector('.t-reset-err'); box.innerHTML = ''; box.append(errBox(e, null, 'Reset failed'));
      });
    } }, 'Reset demo data');
    m = NX.modal('Reset demo data?', el('div', el('p', 'This restores the demo backend to its starting data and clears events you generated, including any dispatch or notification actions on them. It affects everyone using this demo server.'), el('p.t-meta', 'Your place in this tour is also cleared.'), el('div.t-reset-err')),
      { footer: [el('button.nx-btn', { onclick: function () { m.close(); } }, 'Cancel'), go] });
  }

  /* ---------------- step renderers ---------------- */
  var R = {};
  R.generate = function (host) {
    host.append(el('h2', '1. Generate a synthetic Mantis event'),
      el('p.t-lede', 'Start the way a Mantis customer\'s day would: a camera flags an event on a truck. Nexus turns the event into something a dispatcher can act on.'),
      synthBanner());
    if (S.scenario && S.scenario.incidentId) {
      host.append(el('div.t-done', el('b', 'Event created: '), el('span.nx-mono', S.scenario.incidentId), S.scenario.label ? el('p.t-meta', S.scenario.label) : null));
      host.append(el('div.t-actions', el('button.nx-btn', { onclick: function (e) { generate(e.currentTarget, host); } }, 'Generate a different event'), el('button.nx-btn.nx-btn--primary', { onclick: next }, S.mode === 'exec' ? 'Continue' : 'Continue to Dispatch')));
    } else {
      host.append(el('div.t-actions', el('button.nx-btn.nx-btn--primary.nx-btn--lg', { onclick: function (e) { generate(e.currentTarget, host); } }, 'Generate synthetic Mantis event')));
    }
  };
  R.open = function (host) {
    host.append(el('h2', '2. Open the incident in Dispatch'), el('p.t-lede', 'The event is now in the dispatcher\'s queue. Open it there and come back to this tab.'));
    var url = dispatchUrl();
    host.append(el('div.t-open', el('div', el('div.nx-eyebrow', 'Incident'), el('b.nx-mono', incId())), el('a.nx-btn.nx-btn--primary.nx-btn--lg', { href: url, target: '_blank', rel: 'noopener', onclick: function () { host.querySelector('.t-open__ok').hidden = false; } }, 'Open in Dispatch ↗')));
    host.append(el('p.t-open__ok.t-meta', { hidden: true }, 'Opened in a new tab. Look for the camera verdict and the recommended provider, then return here and choose Next.'));
    host.append(el('div.t-look', el('div.nx-eyebrow', 'What to look for in Dispatch'), el('ul.t-list', el('li', 'The incident card with severity and status'), el('li', 'The camera verdict and driver-facing signals'), el('li', 'The recommended roadside provider and the action buttons'))));
    host.append(el('p.t-meta', 'Prefer to stay here? Skip ahead: the next step shows the same evidence.'));
  };
  R.evidence = function (host) {
    host.append(el('h2', '3. Review the camera evidence and driver-facing signals'), el('p.t-lede', 'Before anyone rolls a truck, the camera helps answer: did this really happen, and what was going on in the cab?'), synthBanner());
    var body = el('div'); host.append(body);
    withInc(body, function (inc) { body.append(evidenceCard(inc, false)); });
  };
  function recommendBlock() {
    var rec = recommendation();
    return el('div.t-rec', el('div.nx-eyebrow', 'Recommended response' + (rec.priority ? ' - ' + NX.fmt.label(rec.priority) : '')),
      rec.actions.length ? el('ol.t-actions-list', rec.actions.map(function (a) { return el('li', el('b', a.action || String(a)), a.channel ? el('span.t-meta', ' (' + a.channel + ')') : null); })) : el('p.t-meta', 'The backend returned no actions.'),
      el('div.nx-eyebrow', 'Why'), rec.rationale.length ? el('ul.t-list', rec.rationale.map(function (s) { return el('li', s); })) : el('p.t-meta', 'No rationale provided.'),
      rec.disclaimer ? el('p.t-meta', rec.disclaimer) : null);
  }
  R.recommend = function (host) {
    host.append(el('h2', '4. See the recommended response, and why'), el('p.t-lede', 'Nexus proposes a next step and shows its reasoning, so the dispatcher can accept or override it.'));
    var body = el('div'); host.append(body);
    withInc(body, function (inc) { body.append(recommendBlock()); });
  };
  function followBlock(host, inc) {
    var wrap = el('div.t-follow');
    if (S.applied) {
      wrap.append(el('div.t-done', NX.capBadge('simulated'), ' ', el('b', 'Fleet manager notified. '), el('p.t-meta', 'The message is logged only. Nothing was sent to a real person.')));
    } else {
      wrap.append(el('p', 'Follow the recommendation: notify the fleet manager so the driver check-in can happen. ', NX.capBadge('simulated')),
        el('div.t-actions', el('button.nx-btn.nx-btn--primary', { onclick: function (e) { applyResponse(e.currentTarget, wrap); } }, 'Notify fleet manager')));
    }
    return wrap;
  }
  R.fleet = function (host) {
    host.append(el('h2', '5. Follow the response into the fleet view'), el('p.t-lede', 'The fleet manager sees what Nexus did without chasing anyone. Notify the fleet manager, then open the fleet portal.'));
    var body = el('div'); host.append(body);
    withInc(body, function (inc) {
      body.append(followBlock(body, inc));
      body.append(el('div.t-actions', el('a.nx-btn.nx-btn--lg', { href: fleetUrl(), target: '_blank', rel: 'noopener' }, 'Open in Fleet portal ↗')));
      var cm = el('div.t-block', el('div.nx-eyebrow', 'Messages logged for this incident'), NX.skeleton(2)); body.append(cm);
      NX.api('/api/incidents/' + encodeURIComponent(inc.id) + '/comms').then(function (r) {
        var list = (r && r.comms) || []; cm.innerHTML = ''; cm.append(el('div.nx-eyebrow', 'Messages logged for this incident'));
        if (!list.length) cm.append(el('p.t-meta', 'None yet. Use Notify fleet manager above to see the fleet notification.'));
        else cm.append(el('ul.t-comms', list.map(function (c) { return el('li', el('div', el('b', NX.fmt.label((c.to && c.to.type) || 'recipient')), ' via ' + c.channel + ' ', NX.capBadge('simulated')), el('div.t-meta', c.subject || c.body || '')); })));
      }).catch(function () { cm.innerHTML = ''; cm.append(el('p.t-meta', 'Message log unavailable.')); });
    });
  };
  R.audit = function (host) {
    host.append(el('h2', '6. Review the audit trail and business value'), el('p.t-lede', 'Every step is recorded. Below: the audit trail for this event, then what it could be worth, with what is measured separated from what is illustrative.'));
    var body = el('div'); host.append(body);
    withInc(body, function (inc) {
      body.append(el('section.t-area', el('h3.t-area__title', 'Audit trail'), el('p.t-meta', inc.id + ' - ' + (inc.timeline || []).length + ' entries. Actions marked Simulated were not sent to real parties.'), auditList(inc)));
      body.append(el('h3.t-h3', 'Business value'), TourPanels.valuePanel({ inc: inc }));
      body.append(el('h3.t-h3', 'What is real'), TourPanels.whatsReal());
    });
  };

  /* executive mode */
  R.respond = function (host) {
    host.append(el('h2', '2. From event to response'), el('p.t-lede', 'Evidence, recommendation and the follow-through on one screen.'), synthBanner());
    var body = el('div'); host.append(body);
    withInc(body, function (inc) {
      body.append(el('div.t-two', el('div', el('h3.t-h3', 'Camera evidence'), evidenceCard(inc, true)), el('div', el('h3.t-h3', 'Recommended response'), recommendBlock(), followBlock(body, inc))));
      body.append(el('div.t-actions', el('a.nx-btn', { href: dispatchUrl(), target: '_blank', rel: 'noopener' }, 'Open in Dispatch ↗'), el('a.nx-btn', { href: fleetUrl(), target: '_blank', rel: 'noopener' }, 'Open in Fleet ↗')));
    });
  };
  R.summary = function (host) {
    host.append(el('h2', '3. Summary'));
    var body = el('div'); host.append(body);
    withInc(body, function (inc) {
      var cam = inc.camera || {}, tl = inc.timeline || [];
      var sys = tl.filter(function (t) { return t.actor === 'system'; }).length;
      var card = el('div.t-summary',
        el('div.nx-eyebrow', 'Five-minute walkthrough summary'),
        el('h3.t-summary__h', 'One Mantis-style event, from camera to documented outcome'),
        el('ol.t-summary__flow',
          el('li', el('b', 'Event. '), 'Synthetic Mantis ', NX.fmt.label(inc.eventType || 'event').toLowerCase(), ' event on ', (inc.vehicle && (inc.vehicle.unit || inc.vehicle.plate)) || 'a truck', ' (', inc.fleetName || 'demo fleet', ').'),
          el('li', el('b', 'Verification. '), cam.aiVerdict ? NX.fmt.label(cam.aiVerdict) + (cam.confidence != null ? ', ' + Math.round(cam.confidence * 100) + '% confidence' : '') + '.' : 'No camera verdict.'),
          el('li', el('b', 'Dispatcher action. '), (recommendation().actions[0] && recommendation().actions[0].action) || 'See recommended response.'),
          el('li', el('b', 'Fleet communication. '), S.applied ? 'Fleet manager notified (simulated).' : 'Not yet sent. Go back and choose Notify fleet manager.'),
          el('li', el('b', 'Documented outcome. '), tl.length + ' timeline entries, ' + sys + ' completed automatically.')),
        el('div.nx-eyebrow', 'What is real'), NX.capLegend(),
        el('p.t-meta', 'Mantis is a prospective partner. The adapter is built to an assumed payload and no real Mantis data is connected.'),
        el('div.t-actions', el('button.nx-btn', { onclick: function () { openModal('What is real', TourPanels.whatsReal()); } }, 'See the full capability list'), el('button.nx-btn', { onclick: function () { openModal('Business value', TourPanels.valuePanel({ inc: inc })); } }, 'See business value and hypotheses')));
      body.append(card);
    });
  };

  function openModal(title, node) { NX.modal(title, node, { wide: true, footer: [el('button.nx-btn', { onclick: function () { document.querySelector('.nx-modal-backdrop') && document.querySelector('.nx-modal-backdrop').remove(); } }, 'Close')] }); }

  /* ---------------- shell ---------------- */
  function next() { var n = steps().length; if (S.step < n - 1) { S.step++; save(); render(true); } }
  function back() { if (S.step > 0) { S.step--; save(); render(true); } }
  function restartMode() { S.mode = null; S.step = 0; save(); render(true); }

  function render(scroll) {
    $app.innerHTML = '';
    if (!S.mode) return renderStart();
    var list = steps(), cur = list[S.step];
    var pct = Math.round(((S.step + 1) / list.length) * 100);
    var bar = el('div.t-progress', { role: 'group', 'aria-label': 'Tour progress' },
      el('div.t-progress__top', el('b.nx-mono', 'Step ' + (S.step + 1) + ' of ' + list.length), el('span.t-progress__lbl', cur.label), el('span.nx-grow'),
        el('button.nx-btn.nx-btn--ghost.nx-btn--sm', { onclick: restartMode }, S.mode === 'exec' ? 'Switch to guided tour' : 'Switch to 5-minute mode')),
      el('div.nx-progress', { role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct), 'aria-label': 'Tour progress' }, (function () { var i = el('i'); i.style.setProperty('--p', pct + '%'); return i; })()),
      el('ol.t-dots', list.map(function (s, i) { return el('li', { class: i < S.step ? 'is-done' : (i === S.step ? 'is-active' : ''), 'aria-current': i === S.step ? 'step' : null }, el('button', { onclick: function () { if (i === 0 || incId()) { S.step = i; save(); render(true); } }, 'aria-label': 'Step ' + (i + 1) + ': ' + s.label, disabled: i > 0 && !incId() }, el('span', String(i + 1)), el('em', s.label))); })));
    var host = el('article.nx-card.t-step', { 'aria-live': 'polite' });
    if (cur.id !== 'generate' && !incId()) {
      host.append(el('h2', cur.label), el('div.t-note.t-note--warn', 'No synthetic event yet. Go back to step 1 and generate one.'), el('div.t-actions', el('button.nx-btn.nx-btn--primary', { onclick: function () { S.step = 0; save(); render(true); } }, 'Go to step 1')));
    } else R[cur.id](host);
    var last = S.step === list.length - 1;
    var nav = el('div.t-nav',
      el('button.nx-btn', { onclick: back, disabled: S.step === 0 }, '← Back'),
      el('span.nx-grow'),
      !last && el('button.nx-btn.nx-btn--ghost', { onclick: next, title: 'Skip this step' }, 'Skip'),
      !last && el('button.nx-btn.nx-btn--primary', { onclick: next, disabled: cur.id === 'generate' && !incId() }, 'Next →'),
      last && el('button.nx-btn.nx-btn--primary', { onclick: restartMode }, 'Restart tour'));
    $app.append(bar, host, nav);
    if (scroll) window.scrollTo({ top: 0 });
  }

  function renderStart() {
    $app.append(
      el('div.t-start',
        el('div.t-card-pick.nx-card.nx-card--interactive', { tabindex: '0', role: 'button', onclick: function () { pick('exec'); }, onkeydown: kd('exec') },
          el('div.nx-eyebrow', 'About 5 minutes'), el('h2', 'Five-minute walkthrough'), el('p', 'Three screens: generate an event, see evidence and the recommended response together, finish with a summary card. Best for an executive overview.'), el('span.nx-btn.nx-btn--primary', 'Start the five-minute walkthrough')),
        el('div.t-card-pick.nx-card.nx-card--interactive', { tabindex: '0', role: 'button', onclick: function () { pick('full'); }, onkeydown: kd('full') },
          el('div.nx-eyebrow', 'About 10 minutes'), el('h2', 'Guided tour'), el('p', 'Six steps through Dispatch and Fleet: event, evidence, recommended response with rationale, follow-through, audit trail and business value.'), el('span.nx-btn', 'Start the guided tour'))));
  }
  function kd(m) { return function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(m); } }; }
  function pick(m) { S.mode = m; S.step = 0; save(); render(true); }

  /* header controls */
  document.getElementById('t-reset').addEventListener('click', resetDemo);
  document.getElementById('t-real').addEventListener('click', openReal);
  function openReal() { NX.modal("What's real in this demo", TourPanels.whatsReal(), { wide: true }); }

  NX.topbar('Tour', { sidebar: false, live: true });
  // live indicator reflects reachability
  function ping() { fetch('/health').then(function (r) { NX.setLive(r.ok ? 'live' : 'off'); }).catch(function () { NX.setLive('off'); }); }
  ping(); setInterval(ping, 10000);

  var q = new URLSearchParams(location.search);
  if (q.get('mode') === 'exec' || q.get('mode') === 'full') { if (S.mode !== q.get('mode')) { S.mode = q.get('mode'); S.step = 0; save(); } }
  render();
  if (location.hash === '#whats-real') openReal();
  window.addEventListener('hashchange', function () { if (location.hash === '#whats-real') openReal(); });
})();
