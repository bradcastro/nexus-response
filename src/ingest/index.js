// Production-style ingest: auth (API key / vendor HMAC), rate limit, validation, idempotency, ingest log + dead letter, batch, replay.
const express = require('express');
const crypto = require('crypto');
const adapters = require('../adapters');
const pipeline = require('../pipeline');
const roster = require('../roster');
const db = require('../../db');
const log = require('./log');
const keys = require('./keys');

const REQUIRE_AUTH = () => process.env.REQUIRE_AUTH === '1';
const RATE = () => parseInt(process.env.RATE_LIMIT_PER_MIN, 10) || 1200;
const MAX_SINGLE = 1024 * 1024;
const MAX_BATCH_EVENTS = parseInt(process.env.MAX_BATCH_EVENTS, 10) || 5000;

// ---------- rate limit (fixed 60s window per key id / ip) ----------
const buckets = new Map();
function rateLimit(identity, cost = 1) {
  const now = Date.now();
  let b = buckets.get(identity);
  if (!b || b.reset <= now) { b = { count: 0, reset: now + 60000 }; buckets.set(identity, b); if (buckets.size > 5000) for (const [k, v] of buckets) if (v.reset <= now) buckets.delete(k); }
  b.count += cost;
  return { ok: b.count <= RATE(), limit: RATE(), remaining: Math.max(0, RATE() - b.count), retryAfter: Math.ceil((b.reset - now) / 1000) };
}

// ---------- auth ----------
async function authenticate(req, provider) {
  const adapter = adapters[provider];
  const plain = keys.fromRequest(req);
  if (plain) {
    const rec = await keys.lookup(plain);
    if (!rec || rec.status !== 'active') return { ok: false, code: 401, error: 'invalid_api_key', message: 'API key is invalid or revoked. Rotate it in the onboarding portal.' };
    const fleet = roster.getFleet(rec.fleetId);
    if (fleet && provider !== 'generic' && fleet.vendor !== provider && fleet.vendor !== 'other') return { ok: false, code: 403, error: 'provider_mismatch', message: `This key belongs to a ${fleet.vendor} fleet; use /webhook/${fleet.vendor}.` };
    return { ok: true, via: 'api_key', fleetId: rec.fleetId, keyId: rec.id };
  }
  const h = adapter.verify(req);
  if (!h.skipped) return h.ok ? { ok: true, via: 'hmac' } : { ok: false, code: 401, error: 'invalid_signature', message: h.error || 'Vendor signature did not match the raw body.' };
  if (REQUIRE_AUTH()) return { ok: false, code: 401, error: 'unauthorized', message: 'Send your fleet API key in header x-nexus-key (or Authorization: Bearer nxk_live_...), or a valid vendor signature.' };
  return { ok: true, via: 'none' };
}

// ---------- validation (on the normalized event) ----------
function validate(inc) {
  const errors = [], warnings = [];
  const t = +new Date(inc.timestamp);
  if (!inc.timestamp || isNaN(t)) errors.push(`timestamp is missing or not a valid date${inc.raw ? ' (' + JSON.stringify(findTs(inc.raw)) + ')' : ''}`);
  else if (t > Date.now() + 86400000) errors.push('timestamp is more than 24h in the future');
  else if (t < Date.now() - 3650 * 86400000) errors.push('timestamp is older than 10 years');
  const { lat, lng, speed_mph } = inc.location || {};
  if (lat == null || lng == null || isNaN(lat) || isNaN(lng)) errors.push('location.lat/lng missing');
  else {
    if (lat < -90 || lat > 90) errors.push(`location.lat out of range (-90..90): ${lat}`);
    if (lng < -180 || lng > 180) errors.push(`location.lng out of range (-180..180): ${lng}`);
  }
  if (speed_mph != null && (speed_mph < 0 || speed_mph > 220)) errors.push(`speed out of range: ${speed_mph}`);
  const v = inc.vehicle || {};
  if (!v.vin && !v.providerVehicleId && !v.plate && !v.unit) errors.push('vehicle identifier missing (vin, vehicle id, plate or unit)');
  if (v.vin && !/^[A-HJ-NPR-Z0-9]{17}$/i.test(v.vin)) warnings.push(`vin '${v.vin}' is not a valid 17-character VIN`);
  return { errors, warnings };
}

const findTs = (o) => { const e = o.event || o.data || o; return e.occurred_at || e.timestamp || e.eventTimestamp || e.activeFrom || e.eventMs || e.eventTime || undefined; };
const bytesOf = (o) => { try { return Buffer.byteLength(JSON.stringify(o)); } catch { return 0; } };

// Core: one event. Never throws. Returns {status, code, incident?, error?, details?, logId}
async function handleEvent(provider, payload, ctx = {}) {
  const t0 = process.hrtime.bigint();
  const ms = () => Number(process.hrtime.bigint() - t0) / 1e6;
  const base = { provider, fleetId: ctx.fleetId || null, payloadBytes: ctx.payloadBytes != null ? ctx.payloadBytes : bytesOf(payload), batchId: ctx.batchId, auth: ctx.auth, receivedAt: new Date().toISOString() };
  const finish = async (r, extra = {}) => {
    const entry = await log.record({ ...base, ...extra, status: r.status, error: r.error || null, latencyMs: ms(), incidentId: r.incident ? r.incident.id : (r.incidentId || null), payload: r.status === 'rejected' || r.status === 'failed' ? payload : undefined, statusCode: r.code, fleetId: (r.incident && r.incident.fleetId) || base.fleetId });
    return { ...r, logId: entry.id };
  };
  try {
    const adapter = adapters[provider];
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return finish({ status: 'rejected', code: 422, error: 'payload must be a JSON object' });
    let inc;
    try { inc = adapter.normalize(payload); } catch (e) { return finish({ status: 'rejected', code: 422, error: `could not normalize ${provider} payload: ${e.message}` }); }
    if (!inc.providerEventId) { inc.providerEventId = 'h_' + crypto.createHash('sha1').update(JSON.stringify(payload)).digest('hex').slice(0, 16); inc.idempotency = 'content-hash'; }
    const v = validate(inc);
    if (v.errors.length) return finish({ status: 'rejected', code: 422, error: v.errors.join('; '), details: v.errors });
    const dup = await db.findByProviderEvent(provider, inc.providerEventId);
    if (dup) return finish({ status: 'duplicate', code: 200, incident: dup, error: null });
    const age = Date.now() - +new Date(inc.timestamp);
    const backfill = ctx.backfill != null ? ctx.backfill : age > 24 * 3600 * 1000;
    if (v.warnings.length) inc.ingestWarnings = v.warnings;
    if (backfill) inc.backfill = true;
    const incident = await pipeline.processIncident(inc, { fleetId: ctx.fleetId, silent: backfill, test: ctx.test });
    if (!backfill) markLive(incident.fleetId).catch(() => {});
    return finish({ status: 'accepted', code: 200, incident, warnings: v.warnings });
  } catch (e) {
    console.error(`[NEXUS] ingest failure (${provider}):`, e.stack || e.message);
    return finish({ status: 'failed', code: 500, error: e.message });
  }
}

async function markLive(fleetId) {
  const f = roster.getFleet(fleetId);
  if (f && f.onboarding && f.onboarding.status === 'setup') {
    f.onboarding.status = 'live'; f.onboarding.firstEventAt = new Date().toISOString();
    await db.saveFleet({ ...roster.publicFleet(f), id: f.id, custom: !!f.custom, onboarding: f.onboarding });
  }
}

// ---------- router ----------
const router = express.Router();

async function gate(req, res, provider, cost = 1) {
  if (!adapters[provider]) { res.status(404).json({ error: 'unknown_provider', message: `Unknown provider '${provider}'`, supported: Object.keys(adapters) }); return null; }
  const ipl = rateLimit('ip:' + req.ip, 1);
  if (!ipl.ok) { res.set('Retry-After', ipl.retryAfter).status(429).json({ error: 'rate_limited', message: `Rate limit ${ipl.limit}/min per client exceeded`, retryAfterSec: ipl.retryAfter }); return null; }
  const auth = await authenticate(req, provider);
  if (!auth.ok) {
    await log.record({ provider, status: 'rejected', error: `${auth.error}: ${auth.message}`, payloadBytes: req.rawBody ? req.rawBody.length : 0, payload: null, statusCode: auth.code, auth: 'failed' });
    res.status(auth.code).json({ error: auth.error, message: auth.message }); return null;
  }
  const rl = rateLimit(auth.keyId || req.ip, cost);
  res.set({ 'X-RateLimit-Limit': rl.limit, 'X-RateLimit-Remaining': rl.remaining });
  if (!rl.ok) { res.set('Retry-After', rl.retryAfter).status(429).json({ error: 'rate_limited', message: `Rate limit ${rl.limit}/min exceeded`, retryAfterSec: rl.retryAfter }); await log.record({ provider, fleetId: auth.fleetId, status: 'rejected', error: 'rate_limited', statusCode: 429, auth: auth.via }); return null; }
  return auth;
}

router.post('/webhook/:provider', async (req, res) => {
  const provider = req.params.provider.toLowerCase();
  const auth = await gate(req, res, provider); if (!auth) return;
  const size = req.rawBody ? req.rawBody.length : bytesOf(req.body);
  if (size > MAX_SINGLE) return res.status(413).json({ error: 'payload_too_large', message: `Single-event payloads are limited to ${MAX_SINGLE} bytes; use /webhook/${provider}/batch` });
  if (!req.body || typeof req.body !== 'object' || !Object.keys(req.body).length) {
    await log.record({ provider, fleetId: auth.fleetId, status: 'rejected', error: 'empty or non-JSON body (send Content-Type: application/json)', statusCode: 400, auth: auth.via, payloadBytes: size, payload: null });
    return res.status(400).json({ error: 'bad_request', message: 'Empty or non-JSON body. Send Content-Type: application/json.' });
  }
  const r = await handleEvent(provider, req.body, { fleetId: auth.fleetId, auth: auth.via, payloadBytes: size });
  if (r.status === 'accepted') return res.status(200).json({ received: true, status: 'accepted', incidentId: r.incident.id, logId: r.logId, warnings: r.warnings && r.warnings.length ? r.warnings : undefined, incident: r.incident });
  if (r.status === 'duplicate') return res.status(200).json({ received: true, status: 'duplicate', duplicate: true, incidentId: r.incident.id, logId: r.logId, incident: r.incident });
  if (r.status === 'rejected') return res.status(r.code).json({ error: 'validation_failed', message: r.error, details: r.details, logId: r.logId });
  return res.status(500).json({ error: 'processing_failed', message: 'Event stored in dead letter; it can be replayed.', logId: r.logId });
});

router.post('/webhook/:provider/batch', async (req, res) => {
  const provider = req.params.provider.toLowerCase();
  let events = Array.isArray(req.body) ? req.body : req.body && Array.isArray(req.body.events) ? req.body.events : null;
  const auth = await gate(req, res, provider, 1 + Math.floor((events ? events.length : 0) / 100)); if (!auth) return;
  if (!events) return res.status(400).json({ error: 'bad_request', message: 'Body must be a JSON array of events, or {"events":[...]}' });
  if (events.length > MAX_BATCH_EVENTS) return res.status(413).json({ error: 'batch_too_large', message: `Max ${MAX_BATCH_EVENTS} events per batch` });
  const batchId = 'bat_' + Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
  const counts = { accepted: 0, duplicate: 0, rejected: 0, failed: 0 };
  const results = [];
  for (let i = 0; i < events.length; i++) {
    const r = await handleEvent(provider, events[i], { fleetId: auth.fleetId, auth: auth.via, batchId });
    counts[r.status]++;
    results.push({ index: i, status: r.status, incidentId: r.incident ? r.incident.id : undefined, error: r.error || undefined, logId: r.logId });
    if (i % 200 === 199) await new Promise((rr) => setImmediate(rr)); // keep the event loop breathing
  }
  res.status(200).json({ received: events.length, batchId, ...counts, results });
});

router.get('/api/ingest/log', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 2000);
  res.json({ entries: await log.list({ fleetId: req.query.fleetId, status: req.query.status, provider: req.query.provider, limit }) });
});
router.get('/api/ingest/log/:id', async (req, res) => {
  const e = await log.get(req.params.id);
  if (!e) return res.status(404).json({ error: 'Log entry not found' });
  res.json(e);
});
router.get('/api/ingest/health', async (req, res) => res.json({ generatedAt: new Date().toISOString(), integrations: await log.health() }));

router.post('/api/ingest/log/:id/replay', async (req, res) => {
  const e = await log.get(req.params.id);
  if (!e) return res.status(404).json({ error: 'Log entry not found' });
  let payload = req.body && req.body.payload;
  if (!payload) { payload = e.payload; if (!payload && e.rawBody) { try { payload = JSON.parse(e.rawBody); } catch { /* still malformed */ } } }
  if (!payload || typeof payload !== 'object') return res.status(409).json({ error: 'nothing_to_replay', message: 'No stored payload (or it is not valid JSON). POST {"payload": {...corrected...}} to replay a fixed version.' });
  if (!adapters[e.provider]) return res.status(409).json({ error: 'unknown_provider' });
  const r = await handleEvent(e.provider, payload, { fleetId: e.fleetId, auth: 'replay', backfill: false });
  e.replayedAt = new Date().toISOString(); e.replayStatus = r.status; e.replayIncidentId = r.incident ? r.incident.id : null; e.replayLogId = r.logId;
  await log.update(e);
  res.json({ replayOf: e.id, status: r.status, incidentId: r.incident ? r.incident.id : null, error: r.error || null, logId: r.logId, incident: r.incident || null });
});

module.exports = { router, handleEvent, authenticate, validate, markLive, rateLimit };
