/* Shared by Dispatch and Fleet portals (owned by dispatch): consistent "simulated" wording + incident audit trail. */
(function () {
  'use strict';
  var esc = NX.esc, fmt = NX.fmt;

  /* ---------------- Simulated clarity ---------------- */
  var TEXT = {
    tow: 'no real tow dispatched',
    message: 'no real message sent',
    eta: 'no real message sent to the driver',
    claim: 'no real claim submitted to the OEM',
    fnol: 'no real notice sent to the insurer',
    authority: 'no real call placed to any agency',
    call: 'no real call placed',
    all: 'no real message sent, no real tow dispatched',
    generic: 'nothing real was sent'
  };
  function pill() {
    // reuse the shared capability badge when it exists; keep a local fallback so the portals never break
    if (NX.capBadge) return NX.capBadge('simulated', 'Simulated').outerHTML;
    return '<span class="nx-badge nx-badge--simulated">Simulated</span>';
  }
  var Sim = {
    TEXT: TEXT,
    pill: pill,
    // "Simulated — no real tow dispatched" as one inline unit
    line: function (kind, cls) { return '<span class="sim-line' + (cls ? ' ' + cls : '') + '">' + pill() + '<span class="sim-line__t">— ' + esc(TEXT[kind] || TEXT.generic) + '</span></span>'; },
    // block form used under buttons, in modals, and in confirmations
    note: function (kind, cls) { return '<div class="sim-block' + (cls ? ' ' + cls : '') + '">' + Sim.line(kind) + '</div>'; },
    node: function (kind) { var d = document.createElement('div'); d.innerHTML = Sim.note(kind); return d.firstChild; },
    // toast body: "<message>" + simulated line
    toast: function (msg, kind) { var s = document.createElement('span'); s.className = 'sim-toast'; s.innerHTML = '<span class="sim-toast__m">' + msg + '</span>' + Sim.line(kind); return s; }
  };
  window.NXSim = Sim;

  /* ---------------- Audit trail ---------------- */
  // Outbound = would have reached a person, tow company, insurer, agency or OEM. In the demo none of it is real.
  var OUTBOUND = /dispatch|notified_|^notify|eta_shared|eta_updated|fnol|job_link|tow_destination|warranty_(submitted|under_review|approved|denied|more_info|paid)|^submitted|authority|provider_declined/i;
  var TITLES = {
    received: 'Event received', normalized: 'Event normalized', vin_decoded: 'VIN decoded', camera_verified: 'Vendor camera verdict', roadside_recommended: 'Roadside recommended',
    context_inferred: 'Trip and load context inferred', job_link_sent: 'Job ticket link sent', eta_shared: 'ETA shared', fnol_sent: 'First notice of loss sent',
    notified_fleet_manager: 'Fleet manager notified', notified_driver: 'Driver notified', notified_tow: 'Tow provider notified', notified_insurer: 'Insurer notified',
    notified_authority: 'Authorities contacted', notified_cargo_owner: 'Cargo owner notified', notified_oem: 'OEM notified', sop_step: 'Checklist step',
    warranty_submitted: 'OEM claim submitted', warranty_under_review: 'OEM claim under review', warranty_approved: 'OEM claim approved', warranty_denied: 'OEM claim denied',
    warranty_more_info_needed: 'OEM asked for more information', warranty_paid: 'OEM claim paid', dispatched: 'Tow dispatched', note: 'Note added'
  };
  var USERS = { dispatcher: 'Dispatcher', fleet: 'Fleet user', driver: 'Driver', user: 'User', admin: 'Admin' };
  function whoOf(actor) {
    var a = String(actor || 'system').toLowerCase();
    if (a === 'system' || a === 'nexus' || a === 'camera' || a === 'api') return { kind: 'system', label: 'System' };
    if (a === 'oem') return { kind: 'external', label: 'OEM desk' };
    return { kind: 'user', label: USERS[a] || fmt.label(a) };
  }
  function isSim(e) { return e.simulated === true || (e.meta && e.meta.simulated) || /simulated/i.test(e.note || '') || OUTBOUND.test(e.action || ''); }
  function stamp(t) { var d = new Date(t); return isNaN(d) ? '—' : d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }); }
  function cleanNote(n) { return String(n || '').replace(/\s*\(simulated\)\s*/ig, ' ').replace(/\s+-\s+delivered\b/ig, '').replace(/\btexted to\b/ig, 'queued for').replace(/\s+\./g, '.').trim(); }

  // events: [{t, kind:'system'|'user'|'external', who, sim, title, note, detail, id}] oldest first
  function build(inc, comms) {
    var out = [], byId = {};
    (comms || []).forEach(function (c) { if (c && c.id) byId[c.id] = c; });
    var used = {};
    (inc.timeline || []).forEach(function (e) {
      var w = whoOf(e.actor), ev = { t: e.t, kind: w.kind, who: w.label, sim: w.kind === 'external' || isSim(e), title: TITLES[e.action] || fmt.label(e.action), note: cleanNote(e.note) };
      var cid = e.meta && e.meta.commsId;
      if (cid && byId[cid]) { used[cid] = 1; ev.detail = byId[cid].body; ev.channel = byId[cid].channel; }
      out.push(ev);
    });
    (comms || []).forEach(function (c) {
      if (!c || used[c.id]) return;
      var w = whoOf(c.actor), to = c.to || {};
      out.push({ t: c.at || c.createdAt, kind: w.kind, who: w.label, sim: true, title: ({ sms: 'SMS', email: 'Email', call: 'Call', push: 'Push notification' }[c.channel] || 'Message') + ' to ' + (to.name || fmt.label(to.type || 'contact')), note: c.subject ? cleanNote(c.subject) : '', detail: c.body, channel: c.channel });
    });
    out.sort(function (a, b) { return new Date(a.t) - new Date(b.t); });
    return out;
  }

  var state = { filter: 'all' };
  var FILTERS = [['all', 'All'], ['system', 'System'], ['user', 'User actions'], ['sim', 'Simulated']];
  function match(e, f) { return f === 'all' || (f === 'sim' ? e.sim : f === 'user' ? (e.kind === 'user' || e.kind === 'external') : e.kind === f); }
  function html(inc, comms, opts) {
    opts = opts || {};
    var all = build(inc, comms), f = state.filter, list = all.filter(function (e) { return match(e, f); });
    var counts = {}; FILTERS.forEach(function (x) { counts[x[0]] = all.filter(function (e) { return match(e, x[0]); }).length; });
    var h = '<div class="au"><div class="au-legend"><span><b>System</b> recorded by the platform automatically</span><span><b>User</b> an action taken by a person</span><span>' + pill() + ' would reach someone outside Nexus; nothing real is sent in this demo</span></div>' +
      '<div class="au-filters" role="group" aria-label="Filter audit events">' + FILTERS.map(function (x) { return '<button class="nx-chip' + (f === x[0] ? ' is-active' : '') + '" data-afilter="' + x[0] + '">' + x[1] + ' <b>' + counts[x[0]] + '</b></button>'; }).join('') + '</div>';
    if (!list.length) return h + '<p class="nx-dim au-empty">' + (all.length ? 'No events match this filter.' : 'No events recorded for this incident yet.') + '</p></div>';
    h += '<ol class="au-list">' + list.map(function (e) {
      return '<li class="au-row au-' + e.kind + (e.sim ? ' is-sim' : '') + '"><div class="au-time nx-mono">' + esc(stamp(e.t)) + '</div><div class="au-body"><div class="au-top"><b class="au-title">' + esc(e.title) + '</b>' +
        '<span class="au-who au-who--' + e.kind + '">' + (e.kind === 'system' ? 'System' : e.kind === 'external' ? esc(e.who) : 'User · ' + esc(e.who)) + '</span>' + (e.sim ? pill() : '') + '</div>' +
        (e.note ? '<div class="au-note">' + esc(e.note) + '</div>' : '') + (e.detail ? '<div class="au-detail">' + esc(e.detail) + '</div>' : '') +
        (e.sim ? '<div class="au-simline">' + esc('Simulated — ' + (e.kind === 'external' ? 'no real OEM response was received' : /dispatch|tow|provider/i.test(e.title) ? TEXT.tow : /claim|oem/i.test(e.title) ? TEXT.claim : /first notice/i.test(e.title) ? TEXT.fnol : /authorit/i.test(e.title) ? TEXT.authority : TEXT.message)) + '</div>' : '') + '</div></li>';
    }).join('') + '</ol></div>';
    return h;
  }
  // returns true when the click was an audit filter change (caller re-renders)
  function onClick(e) { var b = e.target.closest && e.target.closest('[data-afilter]'); if (!b) return false; state.filter = b.dataset.afilter; return true; }
  window.NXAudit = { build: build, html: html, onClick: onClick, count: function (inc, comms) { return build(inc, comms).length; } };
})();
