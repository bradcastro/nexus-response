// Machine-readable capability matrix. Classification is deliberately conservative; it is derived from reading the code
// and from scripts/check-consistency.js (which exercises the `working_verified` rows against a running server).
//   working_verified  : exercised end to end against the real code path (see `evidence`)
//   working_synthetic : works, but only on seeded / generated synthetic data or fixtures we authored
//   simulated         : the action/output is simulated or illustrative; nothing leaves the process
//   planned           : needs an external integration, or is not built / not verified
const C = (id, area, name, status, evidence, notes, extra) => ({ id, area, name, status, evidence, notes, ...(extra || {}) });
const CHECK = 'scripts/check-consistency.js';

const CAPABILITIES = [
  // ---- ingest ----
  C('ingest.webhook', 'ingest', 'Webhook ingest -> normalize -> enrich -> store -> SSE', 'working_verified', `${CHECK} posts a Mantis-shaped event to POST /webhook/mantis and reads the incident back; duplicate event id returns the original incident.`, 'Real code path. The inbound payloads used in the demo are fixtures authored in this repo (see adapters.* rows).'),
  C('ingest.apikeys', 'ingest', 'Per-fleet API keys (x-nexus-key) on webhooks', 'working_verified', `${CHECK} onboards a fleet, receives a key, and posts a webhook with it.`, 'Keys are hashed in the in-memory store. Vendor HMAC signature verification exists per adapter but is only exercised with self-generated signatures.'),
  C('ingest.log_replay', 'ingest', 'Ingest log, dead letter and replay', 'working_synthetic', 'Code path exercised in development against generated rejects (seed writes sample rejected events).', 'Not covered by the consistency script.'),
  C('adapters.mantis', 'adapters', 'Mantis adapter', 'working_synthetic', 'Round-trips payloads produced by src/fixtures/mantis.js.', 'ASSUMED payload (schema mantis.event.v1). It is NOT derived from the real Mantis webhook/API specification, which we do not have. Field names, header names and event vocabulary are proposals to validate with Mantis. See docs/MANTIS.md.', { assumedPayload: true }),
  C('adapters.motive_samsara_geotab_lytx', 'adapters', 'Motive / Samsara / Geotab / Lytx adapters', 'working_synthetic', 'Round-trip against fixtures in src/fixtures/*.js written by us from public-style field names.', 'Not validated against live vendor payloads or current vendor API versions.'),
  C('vendor.live_pull', 'adapters', 'Live vendor API pulls (Motive/Samsara pollers)', 'planned', 'Legacy motive-poller.js / samsara-poller.js exist and are OFF in demo mode; never run against real vendor accounts in this build.', 'Needs real vendor credentials, rate-limit handling, pagination and payload validation.'),
  // ---- incidents / dispatch ----
  C('incidents.lifecycle', 'dispatch', 'Incident list / status / notes / dismiss', 'working_verified', `${CHECK} changes status and adds a note on a guided-scenario incident.`, 'Operates on in-memory incidents.'),
  C('dispatch.tow', 'dispatch', 'Tow / roadside dispatch', 'simulated', 'POST /api/incidents/:id/dispatch sets status and assigned provider; responses carry simulated:true.', 'No provider is contacted. Provider directory and ETAs are synthetic.', { simulated: true }),
  C('dispatch.job_link', 'dispatch', 'Tow-driver job link (/job/:token)', 'simulated', 'Token page and status updates work inside the app; link is "texted" only in the timeline.', 'No SMS is sent.', { simulated: true }),
  C('dispatch.providers', 'dispatch', 'Provider directory, distance and ETA', 'working_synthetic', 'Static synthetic provider list; haversine distance, modeled ETA.', 'Not real providers or live availability.'),
  C('comms.sms_email_call', 'comms', 'SMS / email / call notifications and templates', 'simulated', 'POST /api/incidents/:id/notify renders a template and logs it; responses carry simulated:true, deliveredTo:"no external recipient".', 'No Twilio / email / telephony integration.', { simulated: true }),
  C('comms.real_sms', 'comms', 'Real SMS / email / voice delivery', 'planned', 'Not built.', 'Needs a messaging provider, consent handling and opt-out.'),
  C('ops.authorities', 'comms', 'Authority notification (police / EMS / DOT)', 'simulated', 'Authority brief and call script are generated; no call is placed.', 'Agency names are synthetic.', { simulated: true }),
  C('ops.fnol', 'insurer', 'FNOL submission to insurer', 'simulated', 'POST /api/incidents/:id/fnol creates a reference number locally; carrier names/policy numbers are synthetic.', 'No carrier integration.', { simulated: true }),
  C('warranty.packet', 'warranty', 'Warranty coverage windows and claim packet', 'working_synthetic', 'Computed from decoded VIN, odometer and a built-in OEM warranty table.', 'Coverage rules are simplified demo assumptions; not OEM-validated.'),
  C('warranty.submit', 'warranty', 'OEM warranty claim submission and status', 'simulated', 'POST /api/incidents/:id/warranty/submit and /warranty/status advance a local state machine; simulated:true.', 'No OEM portal integration; outcomes are simulated.', { simulated: true }),
  C('enrich.vin_dtc', 'enrich', 'VIN decode and DTC explanation', 'working_synthetic', 'Offline lookup tables embedded in src/enrich.', 'Subset of manufacturers and codes; not NHTSA or an OEM database.'),
  C('enrich.context', 'enrich', 'Trip / load / equipment inference', 'working_synthetic', 'Heuristic inference from seeded data; outputs are marked inferred.', 'Not measured data.'),
  C('camera.evidence', 'camera', 'Camera evidence (clips, snapshots)', 'simulated', 'Frames are generated placeholder SVGs at /media/snap/:id/*.svg; clip URLs from fixtures are not real media.', 'Real Mantis/Lytx/Samsara media retrieval is not built.', { simulated: true }),
  C('camera.ai_verdict', 'camera', 'Camera AI verdict and false-positive filtering', 'working_synthetic', 'Verdict/confidence come from the (fixture) vendor payload; Nexus applies an auto-dismiss rule at >=80% false-positive confidence.', 'Nexus does not run its own vision model.'),
  // ---- fleet ----
  C('fleet.portal', 'fleet', 'Fleet summaries, drivers, vehicles, map', 'working_synthetic', 'Computed from seeded incidents and roster.', 'GPS positions/trails are synthetic, not live.'),
  C('onboarding.fleets', 'fleet', 'Self-serve fleet onboarding and checklist', 'working_verified', `${CHECK} creates a fleet via POST /api/onboarding/fleets.`, 'In-memory unless a database is configured.'),
  C('import.historical', 'fleet', 'Historical CSV/JSON import and auto-assessment', 'working_synthetic', 'Preview/parse/map/import run on generated CSVs in development.', 'Not exercised against customer exports in this build.'),
  // ---- insurer ----
  C('insurer.portfolio', 'insurer', 'Insurer portfolio and fleet deep dive (event-based risk score)', 'working_synthetic', 'Computed from seeded incidents (last 30 days).', 'Risk score is a demo formula, not an actuarial model. Unit exposure (miles) is estimated.'),
  C('insurer.assessments', 'insurer', 'Prospect risk assessments and shareable reports', 'working_synthetic', 'Run on imported or seeded data; share links are unauthenticated capability URLs.', 'Pricing signal is indicative only.'),
  C('predict.engine', 'predict', 'Predictive risk indicators (leading-indicator model)', 'working_synthetic', 'Hand-weighted model on synthetic data. Responses carry provenance {data:"synthetic", validated:false}.', 'Illustrative only; not validated against real loss data; in-sample tuned.', { illustrative: true }),
  C('predict.backtest', 'predict', 'Walk-forward backtest and vendor comparison', 'working_synthetic', `${CHECK} asserts every endpoint reports the same vendor-comparison figures.`, 'Synthetic data, small sample, tuned in-sample. Not evidence of real-world performance of any vendor.', { illustrative: true }),
  C('predict.alerts', 'predict', 'Predictive alerts lifecycle (ack / action / dismiss)', 'working_synthetic', 'Rules over the synthetic model output; SSE event "alert".', 'Illustrative risk indicators, not forecasts of specific events.', { illustrative: true }),
  C('predict.whatif', 'predict', 'Intervention what-if simulator', 'working_synthetic', 'Applies assumed intervention effects.', 'Effect sizes and costs are assumptions, not measured.', { illustrative: true }),
  // ---- platform ----
  C('platform.sse', 'platform', 'Live updates (Server-Sent Events)', 'working_verified', `${CHECK} opens /api/stream and receives the hello event.`, 'Single process; no fan-out across instances.'),
  C('platform.demo_reset', 'platform', 'Demo reset and state', 'working_verified', `${CHECK} calls POST /api/demo/reset and compares counts with GET /api/demo/state.`, 'Gated by DEMO_MODE and refuses on a persistent database.'),
  C('platform.mantis_scenario', 'platform', 'Guided Mantis scenario', 'working_verified', `${CHECK} calls POST /api/demo/mantis-scenario and loads the incident.`, 'Creates a labeled synthetic event through the assumed Mantis adapter.'),
  C('platform.persistence', 'platform', 'Postgres persistence in production', 'planned', 'db.js contains a PostgreSQL implementation but it is not exercised by the demo (in-memory default).', 'Data is lost on restart unless verified separately against a real database.'),
  C('platform.auth', 'platform', 'User authentication and roles (dispatcher / fleet / insurer)', 'planned', 'Not built. Portals are open; only webhooks have optional API-key auth.', 'Needs SSO/RBAC and tenant isolation before any real data.'),
  C('platform.multitenancy', 'platform', 'Tenant isolation and audit trail', 'planned', 'Not built.', 'Required before handling real customer data.'),
];

function summary() {
  const by = {};
  for (const c of CAPABILITIES) by[c.status] = (by[c.status] || 0) + 1;
  return by;
}
function build() {
  return {
    generatedAt: new Date().toISOString(),
    statuses: {
      working_verified: 'Exercised end to end against the real code path (see evidence).',
      working_synthetic: 'Works, but only on seeded/synthetic data or fixtures authored in this repo.',
      simulated: 'The action or output is simulated/illustrative; nothing leaves the process (simulated:true, deliveredTo:"no external recipient").',
      planned: 'Needs an external integration, or is not built / not verified.',
    },
    honesty: ['All demo data is synthetic.', 'Every outbound action is simulated.', 'The Mantis payload is ASSUMED, not from the real Mantis specification.', 'Predictive outputs are illustrative, demo-calibrated and not validated; no claim of real-world superiority for any vendor.'],
    total: CAPABILITIES.length, counts: summary(), capabilities: CAPABILITIES,
  };
}
module.exports = { build, CAPABILITIES };
