require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const fs = require('fs');

const db = require('./db');
const ingest = require('./src/ingest');
const ingestLog = require('./src/ingest/log');
const adapters = require('./src/adapters');
const pipeline = require('./src/pipeline');
const stream = require('./src/stream');
const roster = require('./src/roster');
const seeder = require('./src/seed');
const analytics = require('./src/analytics');
const roadside = require('./src/enrich/roadside');
const packet = require('./src/packet');
const media = require('./src/media');
const scenarios = require('./src/scenarios');
const fixtures = require('./src/fixtures');
const { rngFrom, haversineMi, round } = require('./src/util');
const dealersMod = require('./src/context/dealers');
const { PLACES } = require('./src/context/places');
const { startPoller } = require('./motive-poller');
const { startSamsaraPoller } = require('./samsara-poller');

const app = express();
const PORT = process.env.PORT || 3000;
const DEMO = process.env.DEMO_MODE !== '0';
const STATUSES = ['pending', 'validating', 'dispatched', 'en_route', 'on_scene', 'resolved', 'dismissed'];

// Behind a reverse proxy (Render) set TRUST_PROXY=1 (or a hop count / 'loopback') so req.ip is the real client IP, not the proxy's.
if (process.env.TRUST_PROXY) { const tp = process.env.TRUST_PROXY; app.set('trust proxy', /^\d+$/.test(tp) ? parseInt(tp, 10) : tp === 'true' || tp === '1' ? 1 : tp); }
const DEBUG_ROUTES = process.env.ENABLE_DEBUG === '1';
const debugOnly = (req, res, next) => (DEBUG_ROUTES ? next() : res.status(404).json({ error: 'Not found' }));

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ─── Middleware ───────────────────────────────────────────────────────────────
// OSM tile servers reject requests with no Referer, so keep the origin on cross-origin requests
app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false, referrerPolicy: { policy: 'strict-origin-when-cross-origin' } }));
app.use(cors());
// Keep the raw body for webhook HMAC verification.
app.use(express.json({ limit: '30mb', verify: (req, res, buf) => { req.rawBody = buf; } }));

// Optional shared-password gate for hosted demos (only when DEMO_PASSWORD is set).
require('./src/gate').install(app, express);

// ─── Static portals ───────────────────────────────────────────────────────────
const PUBLIC = path.join(__dirname, 'public');
app.use(express.static(PUBLIC, { extensions: ['html'] }));

// ─── Health + legacy dashboard + config ───────────────────────────────────────
app.get('/health', wrap(async (req, res) => res.json({ status: 'online', service: 'Nexus Response', version: '2.0.0', demoMode: DEMO, store: db.usingPostgres() ? 'postgres' : 'memory', requireAuth: process.env.REQUIRE_AUTH === '1', incidents: await db.countIncidents(), sseClients: stream.count(), timestamp: new Date().toISOString() })));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/api/config', (req, res) => res.json({ mapsKey: process.env.GOOGLE_MAPS_KEY || null, mapboxToken: process.env.MAPBOX_TOKEN || null, demoMode: DEMO, providers: Object.keys(adapters) }));

// ─── Webhooks, batch ingest, ingest log/health/replay (src/ingest) ───────────
app.use(ingest.router);
const onboarding = require('./src/onboarding');
const importer = require('./src/importer');
const assess = require('./src/assess');
app.use(onboarding.router);
app.use(importer.router);
app.use(assess.router);
const opsMod = require('./src/ops');
app.use(opsMod.router);
app.use(require('./src/insurer').router);
app.use(require('./src/demo').router);
app.use('/api/report-builder', require('./src/reports').router);
app.use('/api/records', require('./src/records').router);
// pages for link-based, no-login views (other agents own the HTML)
for (const [route, dir] of [['/job/:token', 'job'], ['/report/:token', 'report']]) app.get(route, (req, res, next) => { const f = path.join(PUBLIC, dir, 'index.html'); fs.existsSync(f) ? res.sendFile(f) : next(); });
// Predictive risk router (owned by the predict agent). Optional: the server runs without it.
try { app.use('/api/predict', require('./src/routes/predict')); console.log('[NEXUS] predict router mounted at /api/predict'); }
catch (e) { if (e.code !== 'MODULE_NOT_FOUND' || !/routes\/predict|predict/.test(e.message)) console.error('[NEXUS] predict router failed to load:', e.message); }

// ─── Incidents ────────────────────────────────────────────────────────────────
const addTimeline = db.addTimeline;
async function mutate(req, res, fn, extra) {
  const out = await db.updateIncident(req.params.id, async (inc) => { const r = await fn(inc); return r || inc; });
  if (!out) return res.status(404).json({ error: 'Incident not found' });
  stream.publish(out, 'update');
  res.json(extra ? { ...out, ...extra } : out);
}

app.get('/api/incidents', wrap(async (req, res) => {
  const { fleetId, status, category, provider, since, source } = req.query;
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 1000);
  // historical imports are hidden from global lists unless a fleet/source is requested explicitly
  const notSource = !fleetId && !source && req.query.includeImported !== '1' ? 'historical_import' : undefined;
  res.json({ incidents: await db.listIncidents({ fleetId, status, category, provider, since, limit, source, notSource }) });
}));

app.get('/api/incidents/:id', wrap(async (req, res) => {
  const inc = await db.getIncident(req.params.id);
  if (!inc) return res.status(404).json({ error: 'Incident not found' });
  res.json(inc);
}));

app.get('/api/incidents/:id/context', wrap(async (req, res) => {
  const inc = await db.getIncident(req.params.id);
  if (!inc) return res.status(404).json({ error: 'Incident not found' });
  res.json({ trip: inc.trip || null, equipment: inc.equipment || null, load: inc.load || null, warrantyDealer: inc.warrantyDealer || null });
}));

app.get('/api/incidents/:id/raw', wrap(async (req, res) => {
  const inc = await db.getIncident(req.params.id);
  if (!inc) return res.status(404).json({ error: 'Incident not found' });
  res.json({ id: inc.id, provider: inc.provider, raw: inc.raw, rawPayload: inc.raw, clips: inc.camera && inc.camera.clips, snapshots: inc.camera && inc.camera.snapshots });
}));

app.post('/api/incidents/:id/dispatch', wrap(async (req, res) => {
  const { providerId, note, actor } = req.body || {};
  let notFoundProvider = false;
  const inc0 = await db.getIncident(req.params.id);
  if (!inc0) return res.status(404).json({ error: 'Incident not found' });
  await mutate(req, res, async (inc) => {
    const rs = inc.roadside || (inc.roadside = { needed: false, serviceType: 'none', recommendedProvider: null, assignedProvider: null, etaMin: null });
    let chosen = rs.recommendedProvider;
    if (providerId) {
      const list = roadside.listNear(inc.location.lat, inc.location.lng, rs.serviceType !== 'none' ? rs.serviceType : null);
      const p = list.find((x) => x.id === providerId) || roadside.listNear(inc.location.lat, inc.location.lng).find((x) => x.id === providerId);
      if (p) chosen = { id: p.id, name: p.name, etaMin: p.etaMin, distanceMi: p.distanceMi, phone: p.phone, rating: p.rating, city: p.city, st: p.st };
    }
    rs.assignedProvider = chosen ? { ...chosen } : null;
    const td = req.body && req.body.towDestination;
    if (td && typeof td === 'object' && td.name) {
      rs.towDestination = { kind: td.kind || 'nearest_shop', name: td.name, address: td.address || null, lat: td.lat != null ? td.lat : null, lng: td.lng != null ? td.lng : null, distanceMi: td.distanceMi != null ? td.distanceMi : null };
      addTimeline(inc, actor || 'dispatcher', 'tow_destination', `Tow destination set: ${td.name}${td.distanceMi ? ` (${td.distanceMi} mi)` : ''}`);
    }
    if (chosen) rs.etaMin = chosen.etaMin;
    inc.status = 'dispatched';
    if (chosen) { const jl = await opsMod.createJob(inc, chosen, actor, req); if (jl) { inc.jobLink = jl; addTimeline(inc, actor || 'dispatcher', 'job_link_sent', `Job link ${jl.url} texted to ${chosen.name} (simulated)`); } }
    if (chosen && inc.load && inc.load.contents && inc.load.contents.hazmat) {
      const ok = roadside.isHazmatCertified(chosen.id);
      addTimeline(inc, 'system', 'hazmat_check', ok ? `Hazmat check: ${chosen.name} is hazmat-certified for this load.` : `Hazmat check: ${chosen.name} is NOT hazmat-certified. Provider told hazmat is required (simulated); hazmat response team needed on scene.`);
    }
    addTimeline(inc, actor || 'dispatcher', 'dispatched', `${chosen ? `Dispatched ${chosen.name} at the owner's request (${rs.serviceType}${chosen.etaMin ? `, ETA ${chosen.etaMin} min` : ''})` : 'Marked dispatched (no roadside provider)'}${note ? ' - ' + note : ''} (simulated: no provider is actually contacted)`);
  }, { simulated: true, deliveredTo: 'no external recipient' });
}));

app.post('/api/incidents/:id/dismiss', wrap(async (req, res) => {
  const { reason, actor } = req.body || {};
  await mutate(req, res, (inc) => { inc.status = 'dismissed'; addTimeline(inc, actor || 'dispatcher', 'dismissed', reason || 'Dismissed'); });
}));

app.post('/api/incidents/:id/status', wrap(async (req, res) => {
  const { status, note, actor } = req.body || {};
  if (!STATUSES.includes(status)) return res.status(400).json({ error: `status must be one of ${STATUSES.join(', ')}` });
  await mutate(req, res, (inc) => {
    inc.status = status;
    if (status === 'resolved') inc.resolvedAt = new Date().toISOString();
    addTimeline(inc, actor || (['en_route', 'on_scene'].includes(status) ? 'provider' : 'dispatcher'), status, note || `Status changed to ${status}`);
  });
}));

app.post('/api/incidents/:id/notes', wrap(async (req, res) => {
  const { note, actor } = req.body || {};
  if (!note) return res.status(400).json({ error: 'note is required' });
  await mutate(req, res, (inc) => { addTimeline(inc, actor || 'dispatcher', 'note', note); });
}));

app.get('/api/incidents/:id/warranty-packet', wrap(async (req, res) => {
  const inc = await db.getIncident(req.params.id);
  if (!inc) return res.status(404).json({ error: 'Incident not found' });
  const pk = packet.build(inc);
  if (!pk) return res.status(404).json({ error: 'No warranty data for this incident (VIN not decodable)' });
  if (req.query.format === 'html') return res.type('html').send(packet.html(pk));
  res.json(pk);
}));

// ─── Providers, fleets, analytics ─────────────────────────────────────────────
app.get('/api/providers', (req, res) => {
  const lat = req.query.lat != null ? parseFloat(req.query.lat) : null;
  const lng = req.query.lng != null ? parseFloat(req.query.lng) : null;
  let list = roadside.listNear(lat, lng, req.query.service || null);
  if (req.query.limit) list = list.slice(0, parseInt(req.query.limit, 10));
  res.json(list);
});

app.get('/api/dealers', (req, res) => {
  const lat = req.query.lat != null ? parseFloat(req.query.lat) : null, lng = req.query.lng != null ? parseFloat(req.query.lng) : null;
  res.json(dealersMod.list({ oem: req.query.oem, lat, lng, limit: req.query.limit ? parseInt(req.query.limit, 10) : undefined, heavyOnly: req.query.heavy === '1' }));
});
app.get('/api/places', (req, res) => {
  const lat = req.query.lat != null ? parseFloat(req.query.lat) : null, lng = req.query.lng != null ? parseFloat(req.query.lng) : null;
  const r = req.query.radiusMi ? parseFloat(req.query.radiusMi) : null;
  let rows = PLACES.map((p) => ({ ...p, distanceMi: lat != null && lng != null ? round(haversineMi(lat, lng, p.lat, p.lng), 1) : null }));
  if (req.query.type) rows = rows.filter((p) => p.placeType === req.query.type);
  if (r != null && lat != null) rows = rows.filter((p) => p.distanceMi <= r);
  rows.sort((a, b) => (a.distanceMi ?? 1e9) - (b.distanceMi ?? 1e9));
  res.json(rows);
});

app.get('/api/fleets', (req, res) => res.json(roster.all().map(roster.publicFleet)));
app.get('/api/fleets/:id/summary', wrap(async (req, res) => {
  const s = await analytics.fleetSummary(req.params.id);
  if (!s) return res.status(404).json({ error: 'Fleet not found' });
  res.json(s);
}));
app.get('/api/fleets/:id/vehicles', (req, res) => {
  const f = roster.getFleet(req.params.id);
  if (!f) return res.status(404).json({ error: 'Fleet not found' });
  res.json(f.vehicles.map((v) => ({ id: v.id, unit: v.unit, vin: v.vin, plate: v.plate, year: v.year, make: v.make, model: v.model, oem: v.oem, engine: v.engine, odometer_mi: v.odometer_mi, hasCamera: v.hasCamera, driverId: v.driverId, position: v.position, ...(req.query.trail ? { trail: seeder.vehicleTrail(v) } : {}) })));
});
app.get('/api/fleets/:id/drivers', wrap(async (req, res) => {
  const f = roster.getFleet(req.params.id);
  if (!f) return res.status(404).json({ error: 'Fleet not found' });
  const incs = await db.listIncidents({ fleetId: f.id, since: new Date(Date.now() - 30 * 86400000).toISOString(), limit: 100000 });
  res.json(analytics.driverRows(f, incs));
}));
app.get('/api/insurer/portfolio', wrap(async (req, res) => res.json(await analytics.portfolio())));
app.get('/api/insurer/fleets/:id', wrap(async (req, res) => {
  const d = await analytics.fleetDeepDive(req.params.id);
  if (!d) return res.status(404).json({ error: 'Fleet not found' });
  res.json(d);
}));

// ─── SSE ──────────────────────────────────────────────────────────────────────
app.get('/api/stream', (req, res) => stream.subscribe(req, res, { fleetId: req.query.fleetId }));

// ─── Placeholder camera media ─────────────────────────────────────────────────
app.get('/media/snap/:id/:type.svg', wrap(async (req, res) => {
  const inc = await db.getIncident(req.params.id);
  res.type('image/svg+xml').set('Cache-Control', 'public, max-age=300').send(media.frame(inc, req.params.type));
}));

// ─── Demo controls ────────────────────────────────────────────────────────────
app.post('/api/demo/seed', wrap(async (req, res) => {
  const reset = req.query.reset === '1' || req.query.reset === 'true' || (req.body && req.body.reset);
  const r = await seeder.seed({ reset: !!reset });
  res.json({ ok: true, ...r });
}));

app.post('/api/demo/simulate', wrap(async (req, res) => {
  const b = req.body || {};
  const name = b.scenario || 'random';
  const rng = Math.random;
  const sc = scenarios.scenarioSpec(name, rng, { fleetId: b.fleetId, vehicleId: b.vehicleId, timestamp: new Date().toISOString() });
  const provider = b.provider && adapters[b.provider] ? b.provider : sc.fleet.vendor;
  const payload = fixtures.build(provider, sc.spec);
  const incident = await pipeline.ingest(provider, payload, { contextHint: sc.contextHint });
  console.log(`[NEXUS] simulate ${sc.name} -> ${incident.id} ${provider} ${incident.fleetName}`);
  res.json({ scenario: sc.name, provider, incident, payload });
}));
app.get('/api/demo/sample/:provider', (req, res) => {
  if (!adapters[req.params.provider]) return res.status(404).json({ error: 'Unknown provider' });
  res.json(fixtures.sample(req.params.provider, req.query.kind));
});
app.get('/api/demo/scenarios', (req, res) => res.json({ scenarios: scenarios.SCENARIOS, extra: ['speeding', 'harsh_brake', 'harsh_turn', 'distracted', 'following_distance', 'tire', 'battery'] }));

// Legacy test trigger (kept): now fires a random scenario through the real adapters.
app.post('/test/trigger-event', debugOnly, wrap(async (req, res) => {
  const sc = scenarios.scenarioSpec('random', Math.random, { timestamp: new Date().toISOString() });
  const incident = await pipeline.ingest(sc.fleet.vendor, fixtures.build(sc.fleet.vendor, sc.spec), { contextHint: sc.contextHint });
  res.json({ success: true, incident });
}));

// ─── Samsara Debug ────────────────────────────────────────────────────────────
app.get('/api/debug/samsara', debugOnly, async (req, res) => {
  const apiKey = process.env.SAMSARA_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'SAMSARA_API_KEY not set in Render environment' });

  const results = {};
  const date14 = new Date();
  date14.setDate(date14.getDate() - 14);

  const endpoints = [
    `https://api.samsara.com/fleet/safety-events?startTime=${encodeURIComponent(date14.toISOString())}&endTime=${encodeURIComponent(new Date().toISOString())}`,
    `https://api.samsara.com/fleet/safety-events`,
    `https://api.samsara.com/fleet/vehicles`,
    `https://api.samsara.com/fleet/drivers`,
  ];

  for (const url of endpoints) {
    try {
      const r = await fetch(url, {
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
      });
      const text = await r.text();
      let data;
      try { data = JSON.parse(text); } catch { data = text.substring(0, 300); }
      results[url] = {
        status: r.status,
        keys: typeof data === 'object' ? Object.keys(data) : null,
        recordCount: data?.data?.length ?? null,
        sample: JSON.stringify(data).substring(0, 500)
      };
    } catch(e) {
      results[url] = { error: e.message };
    }
  }
  res.json(results);
});

// ─── Motive Safety Debug ──────────────────────────────────────────────────────
app.get('/api/debug/motive-safety-list', debugOnly, async (req, res) => {
  const apiKey = process.env.MOTIVE_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'No API key' });

  const results = {};
  const date14 = new Date();
  date14.setDate(date14.getDate() - 14);

  const endpoints = [
    `https://api.gomotive.com/v1/driver_safety_events?per_page=5&start_time=${encodeURIComponent(date14.toISOString())}`,
    `https://api.gomotive.com/v1/driver_safety_events?per_page=5&start_date=${date14.toISOString().split('T')[0]}`,
    `https://api.gomotive.com/v1/driver_safety_events?per_page=5`,
    `https://api.gomotive.com/v2/driver_safety_events?per_page=5`,
  ];

  for (const url of endpoints) {
    try {
      const r = await fetch(url, { headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' } });
      const text = await r.text();
      let data;
      try { data = JSON.parse(text); } catch { data = text.substring(0, 500); }
      results[url] = {
        status: r.status,
        keys: typeof data === 'object' ? Object.keys(data) : null,
        recordCount: Array.isArray(data?.driver_safety_events) ? data.driver_safety_events.length : null,
        videoFields: data?.driver_safety_events?.[0] ? Object.keys(data.driver_safety_events[0]).filter(k =>
          k.includes('video') || k.includes('clip') || k.includes('media') ||
          k.includes('image') || k.includes('camera') || k.includes('snap')) : null,
        sample: JSON.stringify(data).substring(0, 600)
      };
    } catch(e) {
      results[url] = { error: e.message };
    }
  }
  res.json(results);
});

app.get('/api/debug/motive-safety/:eventId', debugOnly, async (req, res) => {
  const apiKey = process.env.MOTIVE_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'No API key' });
  const results = {};
  const endpoints = [
    `https://api.gomotive.com/v1/driver_safety_events/${req.params.eventId}`,
    `https://api.gomotive.com/v2/driver_safety_events/${req.params.eventId}`,
    `https://api.gomotive.com/v1/driver_performance_events/${req.params.eventId}`,
  ];
  for (const url of endpoints) {
    try {
      const r = await fetch(url, { headers: { 'x-api-key': apiKey } });
      const text = await r.text();
      let data; try { data = JSON.parse(text); } catch { data = text.substring(0, 400); }
      results[url] = { status: r.status, data };
    } catch(e) { results[url] = { error: e.message }; }
  }
  res.json(results);
});

// ─── Error handling ───────────────────────────────────────────────────────────
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.use((req, res, next) => {
  if (req.method === 'GET' && req.accepts('html') && !fs.existsSync(path.join(PUBLIC, 'index.html')) && req.path === '/') {
    return res.type('html').send('<h1>Nexus Response</h1><p>Backend online. Portals: <a href="/dispatch/">dispatch</a> <a href="/fleet/">fleet</a> <a href="/insurer/">insurer</a>. API docs: docs/API.md. <a href="/health">/health</a></p>');
  }
  next();
});
app.use(async (err, req, res, next) => {
  if (res.headersSent) return;
  const isHook = req.path.startsWith('/webhook/');
  if (err.type === 'entity.too.large') {
    if (isHook) await ingestLog.record({ provider: req.path.split('/')[2], status: 'rejected', error: 'payload too large', statusCode: 413 }).catch(() => {});
    return res.status(413).json({ error: 'payload_too_large', message: 'Request body exceeds the 30MB limit' });
  }
  if (err instanceof SyntaxError && isHook) {
    const raw = req.rawBody ? req.rawBody.toString('utf8').slice(0, 20000) : null;
    const entry = await ingestLog.record({ provider: req.path.split('/')[2], status: 'rejected', error: 'malformed JSON: ' + err.message, statusCode: 400, rawBody: raw, payloadBytes: req.rawBody ? req.rawBody.length : 0, auth: 'unknown' }).catch(() => ({}));
    return res.status(400).json({ error: 'malformed_json', message: err.message, logId: entry.id });
  }
  console.error('[NEXUS] Error:', err.stack || err.message);
  res.status(err.status || (err instanceof SyntaxError ? 400 : 500)).json({ error: err instanceof SyntaxError ? 'Invalid JSON' : err.message || 'Internal error' });
});

// ─── Start ────────────────────────────────────────────────────────────────────
async function boot() {
  await db.listProviders(); // warm PG connection / run migrations
  const restored = await onboarding.loadPersisted();
  if (restored) console.log(`[NEXUS] restored ${restored} onboarded fleet(s) from the database`);
  await importer.bootRecover();
  if (DEMO) {
    const r = await seeder.seed({ reset: false });
    console.log(`[NEXUS] Demo data ${r.skipped ? 'already present' : 'seeded'}: ${r.fleets} fleets, ${r.incidents} incidents`);
  } else {
    // still need rosters for enrichment; seed roster only (no incidents) when DEMO_MODE=0
    roster.set(seeder.buildRoster());
    const all = await db.listIncidents({ limit: 100000, clone: false });
    pipeline.seedCounter(Math.max(10000, ...all.map((i) => { const m = /^NX-(\d+)$/.exec(i.id); return m ? +m[1] : 0; })));
  }
  try { const pr = require('./src/predict'); if (pr && typeof pr.onBoot === 'function') await pr.onBoot({ db, roster, pipeline, stream }); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') console.error('[NEXUS] predict onBoot failed:', e.message); }
  await new Promise((resolve) => app.listen(PORT, resolve));
  console.log(`[NEXUS] Server running on port ${PORT} (${db.usingPostgres() ? 'postgres' : 'in-memory'} store, demo ${DEMO ? 'ON' : 'OFF'})`);
  console.log(`[NEXUS] Portals: / /dispatch/ /fleet/ /insurer/   API: /api/*   Webhooks: POST /webhook/{${Object.keys(adapters).join('|')}}`);
  if (!DEMO || process.env.ENABLE_LEGACY_POLLERS === '1') { startPoller(); startSamsaraPoller(); }
  else console.log('[NEXUS] Legacy Motive/Samsara pollers off in demo mode (set ENABLE_LEGACY_POLLERS=1 to enable)');
}
if (require.main === module) boot().catch((e) => { console.error('[NEXUS] Boot failed:', e); process.exit(1); });

module.exports = app;
