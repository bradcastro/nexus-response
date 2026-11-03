# Capabilities Audit - Nexus Response (Mantis demo POC)

Audit date: 2026-11-02. Scope: every feature visible in the portals and API. Method: code read of `server.js` and `src/**`, plus live calls against a scratch server (`PORT=3062`, in-memory, `DEMO_MODE=1`, since stopped) and a browser load of each portal. Evidence strings below say exactly what was done.

## Classification key

| Class | Meaning |
|---|---|
| **A. Working & verified** | Real logic that runs end to end, and I exercised it. The *mechanics* are real; the *input data* may still be synthetic (stated in the row). |
| **B. Working with synthetic data** | Real logic, but the data it runs on (fleets, drivers, providers, dealers, history, telemetry) is generated in this repo, so outputs describe invented entities. |
| **C. Simulated action / illustrative output** | The visible result is produced by canned logic or a hand-weighted model. No external system is contacted, or the number has no validated meaning. Labelled "(simulated)" in the API where applicable. |
| **D. Planned / requires external integration** | Not implemented, or only meaningful with a real external system, credential, spec or dataset. |

Evidence vocabulary: **called** = HTTP request made to the scratch server and response inspected; **UI loaded** = portal opened in the browser pane, text read, no console errors seen (interaction beyond load was not exhaustively clicked); **code read** = source read only, not executed.

Global caveats: all data is invented/simulated; Mantis payloads are **assumed**; no vendor integration has been verified against real vendor traffic; there is no user authentication or role model (see `docs/BUYER_READINESS.md`).

---

## 1. Ingestion and platform

| Feature | Class | Evidence / notes |
|---|---|---|
| `POST /webhook/:provider` for motive, samsara, geotab, lytx, mantis, generic | A (mechanics) / B (payloads) | **called** with each provider's sample (`GET /api/demo/sample/:p`): all 6 returned 200 `accepted`, normalized into one incident schema. Payloads are this repo's own fixtures, not real vendor traffic. |
| Mantis adapter | B - **assumed spec** | **called** with `mantis.event.v1` sample; accepted. Field paths and signature header are assumptions (`docs/MANTIS.md`). Needs a real spec to count as an integration (D). |
| Idempotency / duplicate detection | A | **called**: re-POST of the same event returned `status: duplicate` and the original incident for all 6 providers. |
| Validation + rejection (422), malformed JSON (400), unknown provider (404) | A | **called**: `{"event_id":"x"}` -> 422 with reasons; `{bad` -> 400 `malformed_json`; `/webhook/foo` -> 404. |
| Ingest log, dead letter, replay | A | **called**: rejected entries listed by `/api/ingest/log?status=rejected`; `POST .../replay` returned 200 and re-ran validation (stayed rejected as expected for an unfixable payload; replay with a corrected body not exercised). |
| Batch ingest `POST /webhook/:p/batch` | A | **called** with 3 generic events: `accepted: 3`. |
| Per-fleet API keys (SHA-256 hashed) | A | **called**: key issued at fleet creation; webhook with key accepted (200); invalid key 401. Rotation endpoint code read only (rotation not exercised). |
| Vendor HMAC-SHA256 signature check | A | **called** on a second scratch run with `MANTIS_WEBHOOK_SECRET` set: valid signature 200, bad signature 401, missing 401. Other vendors use the same function (code read). |
| `REQUIRE_AUTH=1` | A | **called**: unauthenticated webhook -> 401. Covers ingest only. |
| Rate limiting (1200/min default, 429) | B/code read | **code read**; 429 path not triggered. |
| Ingest health (`/api/ingest/health`) | A | **called**: per fleet/vendor status (healthy/stale/failing/never_connected). The seeded "Bluegrass Dairy Transport (Geotab)" shows FAILING by design (also visible in Onboarding UI) - it demonstrates the feature, it is not a real outage. |
| SSE live stream `/api/stream` | A | **called**: connected (`event: hello`), then received `event: incident` within ~1 s of `POST /api/demo/simulate`. |
| Health `/health`, `/api/config` | A | **called**. |
| PostgreSQL storage | D (untested) | **code read** only. `docs/DEPLOY.md` states it has never been run on a live DB. |
| Legacy Motive/Samsara pollers; `dashboard.html` | D / UNKNOWN | Pollers not run (need real keys; off in demo mode). `/dashboard` serves HTTP 200 (**called**) but content not reviewed. Whether pollers work with current vendor APIs is UNKNOWN. |
| Debug endpoints `/api/debug/samsara`, `/api/debug/motive-*` | D / security risk | **called** `/api/debug/samsara`: 500 (no key set). They would proxy real vendor calls if keys were set. Not a product feature. |

## 2. Enrichment and inference

| Feature | Class | Evidence / notes |
|---|---|---|
| VIN decode (offline WMI/model table + check digit) | B | **code read**; decoded values visible in warranty packets/UI. Covers only the demo model table plus a few extra WMIs. Online NHTSA vPIC lookup (`VIN_ONLINE=1`) off by default, not exercised (D). |
| DTC / fault-code decode (about 40 J1939 SPN/FMI and OBD-II codes: description, severity, drivable, action, parts hint, cost) | B | **code read**; decoded DTCs visible in dispatch queue ("1 DTC", "2 DTC") and incident JSON. Table is hand-entered; cost and wording are illustrative, not authoritative. |
| "Camera verification" verdict and confidence | **C** | **code read** (`src/enrich/camera.js`) + **called**. For **Mantis**, the verdict is taken from the *assumed* `ai.classification/confidence` block in the payload (not computed by Nexus). For **all other vendors** Nexus synthesizes a verdict from sensor hints (g-force, airbag flag, event type, vendor label) plus a small deterministic hash jitter on the confidence. **No video or image is analyzed anywhere.** Clip URLs in fixtures are `*.invalid`; the "camera frames" are generated placeholder SVGs (`/media/snap/:id/:type.svg`, **called**, 200). |
| Driver-/road-facing signals (following distance, drowsiness, phone use, seatbelt, eyes-off-road) | B/C | Present only when the (assumed) Mantis payload carries them; **called** with the sample. Not real detections. |
| False-positive auto-dismiss | B | **code read** + visible in seed and in the `false_positive` scenario (**called** via simulate). Rule: vendor/assumed-AI false-positive at high confidence. |
| Event risk score and tags | C | **code read** (`src/enrich/risk.js`): fixed base scores plus increments; not validated. |
| Roadside need, service type and provider ranking | B | **called** (`/api/providers`, incident `roadside`). Provider directory is ~30 invented businesses; ETA/distance from haversine, not real routing or availability. |
| OEM warranty evaluation and claim packet assembly | B/C | **called** (`GET .../warranty-packet` JSON and `?format=html`, 200). Coverage windows are hard-coded approximations per OEM (`src/enrich/warranty.js`), unverified against OEM terms. |
| Trip, trailer, load weight and cargo-contents inference | B/C | **code read** + **called** (`/api/incidents/:id/context`). The input telemetry is *simulated* from a hidden ground truth (`src/context/simulate.js`); the inference then estimates it back (`docs/INFERENCE.md`). The accuracy figure in that doc (about 5% error) measures the model against its own simulator, **not real trucks**. Cargo categories rely on invented business stops (`src/context/places.js`). |
| OEM dealer network and tow-to-dealer routing | B | **called** (`/api/dealers`). Dealer names are invented. |
| Places / business-stop lookup | B | **called** (`/api/places`). |

## 3. Dispatch portal (`/dispatch/`)

| Feature | Class | Evidence / notes |
|---|---|---|
| Incident queue, filters (status, severity, category, fleet, vendor), counts, SLA chips | B | **UI loaded** (31 open, 300 total in scratch run; no console errors); `GET /api/incidents` **called**. |
| Map with markers (Leaflet + OSM tiles) | B | **UI loaded** on the fleet portal map (attribution present); dispatch map is code-driven by `public/dispatch/app.js` (**code read**). Tiles are from the public OSM server and need internet access. |
| Incident detail: timeline, signals, DTCs, roadside, warranty, trip/load | B | **called** (`GET /api/incidents/:id`, `/context`, `/raw`). |
| Dispatch a provider (`POST .../dispatch`), status changes, notes, dismiss | A (logic) / B (data) | **called**: dispatch -> status `dispatched`, job link created; `status`, `notes` returned 200. Dispatching *does not contact any real provider*. |
| Tow job link: `POST` creates `/job/<token>`; provider page and actions | A (logic) / **C** (delivery) | **called**: token issued, `GET /api/jobs/:token` 200, `/job/:token` page 200, actions `accept` and `complete` 200 and moved the incident (`en_route`, `resolved`). `en_route`/`on_scene` are not valid action names (valid: accept, decline, eta, arrived, complete). The "text to provider" is simulated (timeline: "texted ... (simulated)"); no SMS is sent. |
| Notify (SMS/email/call/push) to driver, fleet manager, tow, insurer, authority, cargo owner, OEM; comms log; editable templates | **C** | **called**: `POST .../notify` with a template -> 200, logged as `delivered (simulated)`; `GET /api/comms`, `/api/incidents/:id/comms`, `/api/comms/templates` 200. Nothing leaves the server. |
| Authority brief (agencies to call, call script, jurisdiction) | **C** | **called**: returns recommendations and a script; agency names suffixed "(simulated)" and numbers are fictional 555-01xx. Rules are heuristic (state/county/EMS/fire/DOT/hazmat flags). |
| SOP checklist per incident type | B | **called** (`GET .../sop` 200). Step completion posts exist (`POST .../sop/:stepKey`; unknown key returned a 4xx with the valid keys, correct behaviour). |
| FNOL to insurer | **C** | **called**: `POST .../fnol` -> 201 with a generated claim ref, status `received (simulated)`. |
| OEM warranty claim lifecycle (submit, under review, approved/denied/more info, paid) | **C** | **called**: submit -> `submitted`; `POST .../warranty/status {simulate:true}` advanced under_review -> approved -> paid. The "OEM" responses are canned text (`src/claims.js`). No OEM portal is contacted. |
| Proactive mode (predictive alerts in dispatch) | **C** | **UI loaded** (counter "Proactive 27"); backed by `/api/predict/alerts` (**called**, returned alerts; `POST .../alerts/:id/ack` -> 200). See Predict section. |
| Camera evidence panel | **C** | Shows placeholder SVG frames labelled "NEXUS DEMO FRAME" (**called** `/media/snap/...`). |
| Warranty packet print/HTML view | B/C | **called** `?format=html` 200. |

## 4. Fleet portal (`/fleet/`)

| Feature | Class | Evidence / notes |
|---|---|---|
| Fleet switcher (7 demo fleets), KPIs, attention list, events chart, live fleet map | B | **UI loaded** (fleet_gulfcoast; no console errors; map attribution present); `/api/fleets`, `/summary`, `/vehicles`, `/drivers` **called** (200). Vehicle positions/trails are generated. No tenant isolation: any visitor can pick any fleet. |
| Driver scores ("Nexus Drive Score"), coaching flags | C | **called** `/api/fleets/:id/drivers` and `/api/insurer/drivers`. Score formula is a hand-built composite, not validated. |
| Warranty: "Submit all ready" | C | **called** `POST /api/fleets/:id/warranty/submit-ready`: 3 claims submitted, totalling $9,400 estimated, all simulated. |
| Comms feed / contacts | C | **called** `/api/comms?fleetId=`, `/api/fleets/:id/contacts` (fictional contacts). |
| Early-warning alert card, 90-day projection | C | **UI loaded** (alert text visible); backed by predict API. |
| Cargo exposure ($) | C | **UI loaded**; derived from inferred load and invented $/lb ranges. |

## 5. Insurer portal (`/insurer/`) and public reports

| Feature | Class | Evidence / notes |
|---|---|---|
| Weekly digest, portfolio view, fleet deep-dive, benchmarks, risk tiers | B/C | **UI loaded** (banner reads "SYNTHETIC DEMO DATA / SIMULATED ... not validated on real-world claims data"; no console errors); `/api/insurer/portfolio`, `/digest`, `/fleets/:id` **called** (200). |
| Usage-based view (miles, events per million miles, premium signal) | C | **called** `/api/insurer/fleets/:id/usage-based` 200. Carrier names/policy numbers are invented; any pricing adjustment is an illustrative signal. |
| Risk assessment (`POST /api/insurer/assessments`, HTML print view) | C | **called**: 201 for a seeded fleet; `?format=html` 200. Low-history assessments are damped and flagged `lowConfidence` (**code read** + documented). Not an actuarial or filed rate. |
| Public read-only report links (`/report/:token`, kinds fleet, assessment, incident, digest) | A (logic) | **called**: all four kinds created (201); `/report/:token` page 200; 30-day expiry; PII keys redacted (**code read**). Links are guessable only by enumerating the open list endpoint (see BUYER_READINESS section 7). |
| Delete assessment / report | A | **code read** (`DELETE /api/insurer/assessments/:id`, `/reports/:token`); not exercised. |

## 6. Onboarding and import (`/onboarding/`)

| Feature | Class | Evidence / notes |
|---|---|---|
| Create client, issue API key (shown once), webhook URL, vendor-specific setup steps | A | **called**: `POST /api/onboarding/fleets` -> 201; **UI loaded**. Mantis setup steps are explicitly marked "ASSUMED - confirm with Mantis docs". |
| Checklist (account, key, first event, vehicles...) | A | **called** `.../checklist` 200. |
| "Send test event" through the real ingest path | A | **called**: accepted, incident created, fleet status moves setup -> live on first event (**code read**). |
| Roster upload (CSV/JSON) | A | **called**: CSV with 1 vehicle -> `added: 1`. |
| Alert recipients config (`PUT .../alerts`) | **C / D** | **called** 200, but the configuration is only **stored**; nothing in the code sends alerts (grep: `alertConfig` is read nowhere else). |
| Historical import: templates, preview/column mapping, async job, data-quality score, auto-assessment | A (logic) / B (data) | **called** with the repo sample `public/onboarding/samples/mantis-export.csv` (300 rows): preview OK, job completed 300/300, quality score 100, assessment auto-created. Real vendor export formats not verified (Mantis columns assumed). Imported events never raise alerts/SSE (**code read**). |
| Delete onboarded fleet | A | **called**: deleting created fleets 200 (with cascade counts); seeded fleet -> 409 `protected_fleet`. |

## 7. Predictive risk ("get ahead of accidents")

| Feature | Class | Evidence / notes |
|---|---|---|
| Driver collision probability (30 d), fleet risk score, 30/90-day projection with bands | **C** | **called** `/api/predict/fleet/:id`, `/drivers`, `/vehicles`, `/portfolio`, `/model` (all 200). `/api/predict/model` itself returns `label: demo-calibrated` and "weights are hand-set ... not fitted to real loss data". |
| Alerts (risk spike, fatigue pattern, tailgating trend, hotspot forming, breakdown risk, maintenance) with lifecycle ack/action/dismiss | C (logic real) | **called**: 27-29 open alerts at boot; `ack` -> 200. Rules are thresholds on the hand-weighted scores. |
| Backtest | **C** | **called** `/api/predict/backtest`: on this run 33 of 48 collisions "caught" (69%), median lead about 11.6 days, about 10.5 false alert episodes per 100 vehicles. Numbers shift between runs and with added incidents (an earlier call in the same session gave 61%). **In-sample on synthetic data tuned by the author; not evidence of real predictive performance.** |
| What-if interventions with projected savings (`POST /api/predict/simulate-what-if`) | **C** | **called** with `targeted_coaching`: returned projected risk and "expectedSavingsUsd". Intervention effect sizes and costs are assumptions in `src/predict/config.js`. **Do not present as customer savings.** |
| Hotspots, time-of-day patterns | C | present in `/api/predict/fleet/:id` response keys (`hotspots`, `patterns`). Local time assumed UTC-5 for all fleets (per `docs/PREDICT.md`). |
| "Mantis vs the rest" comparison | **C - circular** | The seed generator gives each vendor a "capture" factor (`CAPTURE` in `src/seed.js`: mantis 1.0, lytx 0.85, samsara 0.7, motive 0.55, geotab 0.3), so camera-first fleets show richer precursors **by construction**. Any Mantis advantage in the demo is an input assumption, not a finding. `docs/PREDICT.md` itself says Mantis recall is comparable to other camera vendors; the visible edge is prediction *confidence*. |

## 8. Demo controls and launcher

| Feature | Class | Evidence / notes |
|---|---|---|
| Launcher `/` with scenario buttons ("Run live demo") | A | **UI loaded**; backing `POST /api/demo/simulate` **called** (200; also with `scenario: collision`). Scenarios: collision_camera, dtc_breakdown, warranty_failure, false_positive, reefer_collision, flatbed_steel_collision, warranty_dealer_breakdown, hazmat_tanker_rollover, random. |
| `POST /api/demo/seed` | A | **called**: `skipped: true` when data exists (`reset` option present in code). |
| `GET /api/demo/sample/:provider`, `/api/demo/scenarios` | A | **called**. |
| `/tour/` guided walkthrough (five-minute and guided modes, "What's real", Reset demo) | A (page) / C (content) | First probe returned 404 mid-audit while another agent was still building it; re-checked on a restarted scratch server: `GET /tour/` 200, **UI loaded** (title "Mantis walkthrough", banner "Synthetic data; Mantis is a prospective partner", no console errors). Steps beyond the landing screen were not clicked through. |
| `GET /api/capabilities` | A | Re-checked: 200; 41 entries (`total`=41; 7 working_verified, 21 working_synthetic, 8 simulated, 5 planned) plus honesty statements. This is the backend agent's self-classification; it differs in granularity from this document, and where the two differ this document's evidence column governs. |
| `POST /api/demo/reset`, `GET /api/demo/state` | A | **called**: reset returned `ok` with counts (7 fleets, 574 incidents, 0 custom fleets) and rebuilt predictive state; state endpoint reports `resetEnabled: true`. Gate: refuses when `DATABASE_URL` set or `DEMO_MODE=0` (API.md; code not stress-tested). The reset endpoint is itself unauthenticated. |
| `POST /api/demo/mantis-scenario` | A (mechanics) / B (data) | **called**: 201, created a new incident through the Mantis adapter (phone use, eyes-off-road, short following distance, AI verdict "distraction"), tagged `synthetic`, `payloadAssumed`, with deep links and a recommended response. |
| `/test/trigger-event` (legacy) | A | **code read**: fires a random scenario through the real adapters. Open endpoint. |

## 9. Cross-cutting

| Feature | Class | Evidence / notes |
|---|---|---|
| Authentication, user accounts, roles | **D - not implemented** | **code read** + **called** (open endpoints with `REQUIRE_AUTH=1`). |
| Tenant/fleet data isolation | **D - not implemented** | same. |
| Authenticated audit trail | **D - not implemented** | Timeline `actor` is client-supplied free text. |
| Real outbound comms (SMS/email/voice) | **D** | none in code; no provider dependency. |
| OEM warranty portal / insurer FNOL integrations | **D** | none in code. |
| Real video/clip handling and AI | **D** | none; placeholders only. |
| Brand/theme (dark/light), responsive layout | B | **UI loaded** (dark default); mobile layout not tested in this audit. |
| Automated tests / CI | D (minimal) | Only `src/predict/selftest*.js` and `scripts/check-consistency.js` (an API consistency script that resets its target); neither was run by this audit. No CI config. |

---

## Top audit findings (things that could undermine confidence)

1. No authentication/authorization/tenant isolation anywhere except webhook ingest; every write route is public.
2. "Camera verified" for non-Mantis vendors is a rule-based synthesis, and for Mantis is the assumed payload's own verdict - there is no video analysis in the product.
3. The predictive model, backtest and "Mantis edge" are in-sample on data generated with the conclusion built in (vendor capture factors).
4. Mantis integration is entirely to an assumed spec.
5. All outbound actions (SMS, FNOL, OEM claims, tow texts, authority calls) are simulated; alert-recipient config does nothing.
6. Postgres mode and the legacy pollers were not verified. (`/tour`, `/api/capabilities`, `/api/demo/reset` and `/api/demo/mantis-scenario` landed during the audit and were re-checked: 200.)
7. Inferred load/weight/value figures are accurate only against their own simulator.
8. Seed data includes a fleet/provider named "Elite Towing" - confirm intent before external demos.

## Final re-check

Re-run on a restarted scratch server (`PORT=3062`) after other agents' changes landed: `/tour/`, `/api/capabilities`, `/api/demo/state`, `POST /api/demo/reset` and `POST /api/demo/mantis-scenario` all responded 200/201 as described above. The earlier endpoint sweep (webhooks, dispatch flow, claims, comms, reports, onboarding, import, predict) was run on the pre-change code and was not repeated in full; re-run `node scripts/check-consistency.js` (documented in `docs/API.md`; it calls reset on its target) for a fresh end-to-end check. Scratch servers were stopped by port after each run.
