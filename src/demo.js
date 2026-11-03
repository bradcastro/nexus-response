// Demo controls: reset to known seeded state, state summary, guided Mantis scenario, capability matrix.
const express = require('express');
const db = require('../db');
const roster = require('./roster');
const stream = require('./stream');
const pipeline = require('./pipeline');
const seeder = require('./seed');
const fixtures = require('./fixtures');
const scenarios = require('./scenarios');
const capabilities = require('./capabilities');
const { rngFrom } = require('./util');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const clock = { bootAt: new Date().toISOString(), resetAt: null, resets: 0, scenarios: 0 };

// Reset is allowed only in demo deployments: DEMO_MODE=1, or DEMO_MODE unset in a non-production, in-memory process.
// It is always refused when DEMO_MODE=0, when NODE_ENV=production without DEMO_MODE=1, and on a persistent database.
function resetGate() {
  const dm = process.env.DEMO_MODE;
  if (dm === '0') return { ok: false, why: 'DEMO_MODE=0: reset is disabled' };
  if (process.env.DATABASE_URL && process.env.ALLOW_DEMO_RESET_ON_DATABASE !== '1') return { ok: false, why: 'a persistent database (DATABASE_URL) is configured; reset refuses to wipe it' };
  if (dm === '1') return { ok: true };
  if (dm === undefined && process.env.NODE_ENV !== 'production') return { ok: true };
  return { ok: false, why: 'set DEMO_MODE=1 to enable reset' };
}

async function counts() {
  const all = await db.listIncidents({ limit: 100000, clone: false });
  const n = async (k) => (await db.list(k, { limit: 100000 })).length;
  const alertsMod = require('./predict/alerts');
  const rs = roster.all();
  return {
    fleets: rs.length, customFleets: rs.filter((f) => f.custom || f.prospect).length, vehicles: rs.reduce((s, f) => s + f.vehicles.length, 0), drivers: rs.reduce((s, f) => s + f.drivers.length, 0),
    incidents: all.length, importedIncidents: all.filter((i) => i.source === 'historical_import').length, demoScenarioIncidents: all.filter((i) => i.demo && i.demo.tag).length,
    comms: await n('comms'), jobs: await n('job'), reports: await n('report'), assessments: await n('assessment'), importJobs: await n('import_job'), ingestLog: await n('ingest_log'), apiKeys: await n('api_key'),
    predictiveAlerts: alertsMod.counts(), sseClients: stream.count(),
  };
}

router.post('/api/demo/reset', wrap(async (req, res) => {
  const g = resetGate();
  if (!g.ok) return res.status(403).json({ error: 'reset_disabled', message: g.why, demoMode: process.env.DEMO_MODE === undefined ? 'unset' : process.env.DEMO_MODE });
  // 1. drop user-created fleets, then every stored document and incident (imports included)
  roster.set(roster.all().filter((f) => !f.custom && !f.prospect));
  await db.clearIncidents({ keepImported: false });
  for (const k of Object.keys(db.KINDS)) await db.clearKind(k);
  // 2. reseed the deterministic demo dataset (roster, incidents, claims, comms, jobs, ingest log)
  const r = await seeder.seed({ reset: true });
  // 3. rebuild derived predictive state so it is ready before this call returns
  let predict = null;
  try {
    const data = require('./predict/data');
    data.reset(); await data.ensureCalib(true); await data.evaluateAll({ silent: true }); data.state.bootAlertsDone = true;
    predict = 'rebuilt';
  } catch (e) { predict = 'rebuild_failed: ' + e.message; }
  clock.resetAt = new Date().toISOString(); clock.resets++;
  const c = await counts();
  stream.publishEvent('reset', { resetAt: clock.resetAt, counts: { fleets: c.fleets, vehicles: c.vehicles, incidents: c.incidents } });
  res.json({ ok: true, resetAt: clock.resetAt, seeded: r, predict, counts: c, note: 'In-memory store restored to the deterministic seeded state. Custom fleets, imports, assessments, reports, comms, jobs, ingest log and API keys were cleared. Clients should reload.' });
}));

router.get('/api/demo/state', wrap(async (req, res) => {
  const g = resetGate();
  res.json({ bootAt: clock.bootAt, resetAt: clock.resetAt, resets: clock.resets, mantisScenariosCreated: clock.scenarios, resetEnabled: g.ok, resetDisabledReason: g.ok ? null : g.why, store: db.usingPostgres() ? 'postgres' : 'memory', counts: await counts(), data: 'synthetic', simulated: true });
}));

router.get('/api/capabilities', (req, res) => res.json(capabilities.build()));

// ---- guided Mantis scenario ----
const MANTIS_FLEETS = ['fleet_redline', 'fleet_magnolia'];
router.post('/api/demo/mantis-scenario', wrap(async (req, res) => {
  const b = req.body || {};
  const fleet = roster.getFleet(MANTIS_FLEETS.includes(b.fleetId) ? b.fleetId : MANTIS_FLEETS[clock.scenarios % 2]);
  if (!fleet) return res.status(409).json({ error: 'no_mantis_fleet', message: 'Seeded Mantis fleets are missing; call POST /api/demo/reset first.' });
  const cams = fleet.vehicles.filter((v) => v.hasCamera);
  const n = ++clock.scenarios;
  const demoTag = `mantis-demo-${Date.now().toString(36)}-${n}`;
  const rng = rngFrom('mantis-scenario:' + demoTag);
  const v = cams[Math.floor(rng() * cams.length)] || fleet.vehicles[0];
  const sc = scenarios.scenarioSpec('distracted', rng, { fleetId: fleet.id, vehicleId: v.id, timestamp: new Date().toISOString() });
  const spec = sc.spec;
  spec.eventId = `mantis_demo_${demoTag}`;
  spec.eventType = 'distracted'; spec.distractionKind = 'phone'; spec.hasCamera = true; spec.aiLabel = 'distraction'; spec.aiConfidence = 0.94;
  spec.mantis = { ...(spec.mantis || {}), phone: true, eyesOff: 3.6, followS: 0.8, fcw: true, drowsiness: 0.12, seatbelt: true, smoking: false, laneDeparture: false };
  spec.location = { ...spec.location, speed_mph: 62 };
  const payload = fixtures.build('mantis', spec);
  const inc = await pipeline.ingest('mantis', payload, {});
  const out = await db.updateIncident(inc.id, (i) => {
    i.demo = { tag: demoTag, synthetic: true, scenario: 'mantis_driver_distraction', payloadAssumed: true, label: 'SYNTHETIC DEMO EVENT - Mantis payload shape is assumed, not from the real Mantis spec' };
    db.addTimeline(i, 'system', 'demo_scenario', 'Synthetic demo event created by the guided Mantis scenario (assumed payload; nothing is sent to any external party).');
    return i;
  });
  stream.publish(out, 'update');
  const fm = (require('./data/ops').fleetManagers ? require('./data/ops').fleetManagers(fleet) : [])[0];
  res.status(201).json({
    incidentId: out.id, demoTag, synthetic: true, simulated: true, payloadAssumed: true, illustrative: true,
    label: 'Synthetic Mantis driver-distraction event on demo data',
    fleet: { id: fleet.id, name: fleet.name, vendor: fleet.vendor }, vehicle: { unit: out.vehicle.unit, plate: out.vehicle.plate }, driver: out.driver && out.driver.name,
    event: { eventType: out.eventType, severity: out.severity, camera: { aiVerdict: out.camera.aiVerdict, confidence: out.camera.confidence }, signals: (out.signals || []).filter((s) => s.triggered).map((s) => ({ key: s.key, label: s.label, value: s.value, unit: s.unit })) },
    deepLinks: { dispatch: `/dispatch/#${out.id}`, fleet: `/fleet/?fleet=${fleet.id}#incident=${out.id}`, insurerFleet: `/insurer/#${fleet.id}`, insurerProjection: `/insurer/#projections/${fleet.id}`, api: `/api/incidents/${out.id}`, predictFleet: `/api/predict/fleet/${fleet.id}` },
    recommendedResponse: {
      priority: 'coaching_same_day', simulated: true, deliveredTo: 'no external recipient',
      actions: [
        { step: 1, action: 'Review the driver-facing clip and the road-facing clip together', channel: 'dispatch console' },
        { step: 2, action: `Check in with ${out.driver && out.driver.name || 'the driver'} by phone when it is safe to do so, via ${fm ? fm.name : 'the fleet manager'} (simulated: no message is sent)`, channel: 'comms (simulated)' },
        { step: 3, action: 'Queue a same-day coaching conversation on phone use and following distance', channel: 'fleet portal' },
        { step: 4, action: 'No tow or roadside dispatch is needed; vehicle is drivable', channel: 'n/a' },
      ],
      rationale: [
        'Phone use with eyes off the road for several seconds at highway speed is recorded together with a following distance under one second and a forward-collision warning.',
        'Camera AI verified the distraction (assumed Mantis payload; synthetic confidence), so this is a verified behavior event rather than an unverified threshold alert.',
        'These are leading indicators in the illustrative risk model: they raise the driver\'s modeled risk indicator but do not show that a collision will occur.',
        'The response is coaching, not enforcement; the event is synthetic and no real driver is involved.',
      ],
      disclaimer: 'Illustrative recommendation on synthetic data. Nothing is dispatched, sent or submitted.',
    },
  });
}));

module.exports = { router, counts, resetGate };
