# Buyer / Partner Readiness Facts - Nexus Response (Mantis demo POC)

Status date: 2026-11-02. Method: every statement below was checked against the repo (`package.json`, `render.yaml`, `server.js`, `db.js`, `src/**`, `public/**`, `node_modules`) and, where marked, against a scratch server on `PORT=3062` (since stopped). Items that could not be established from the repo are marked **UNKNOWN**. Nothing here is a legal conclusion, a performance claim, a traction claim or a customer-savings claim.

Ground rules for anyone using this document externally:
- Mantis is a **prospective** partner. There is no relationship, agreement, endorsement or data-sharing arrangement implied by this repo.
- The Mantis adapter is built to an **assumed** payload (`docs/MANTIS.md`), not a real Mantis specification.
- All fleets, drivers, vehicles, dealers, tow providers, business stops, carriers, policy numbers and phone numbers in the demo are invented or simulated. Real vendor names (Motive, Samsara, Geotab, Lytx, Mantis) and OEM names (Freightliner, Peterbilt, etc.) are used descriptively.

Companion docs: `docs/CAPABILITIES.md` (feature-by-feature audit), `docs/KNOWN_LIMITATIONS.md`, `docs/DEMO.md`, `docs/DEPLOY.md`, `docs/ARCHITECTURE.md`, `docs/MANTIS.md`.

---

## 1. System architecture and deployment requirements

**Shape.** One Node.js process (Express 4) serving: static vanilla-JS portals from `public/` (no build step), a JSON API under `/api/*`, vendor webhooks under `/webhook/:provider`, and an SSE stream at `/api/stream`. Entry point `server.js` (about 390 lines) plus `src/**` (adapters, ingest, enrichment, context inference, predict, ops, claims, onboarding, importer, insurer analytics) and `db.js` (storage). Two legacy pollers (`motive-poller.js`, `samsara-poller.js`) and `dashboard.html` predate the platform.

**Runtime requirements (from `package.json` / `render.yaml`).**
- Node.js `>=18.0.0` (`engines`); `render.yaml` pins `NODE_VERSION=20`. Global `fetch` is used (Node 18+).
- Runtime dependencies: `express`, `cors`, `helmet`, `dotenv`, `pg`. Dev: `nodemon`. No build step, no bundler, no framework on the client.
- Start: `npm install && npm start` (`node server.js`). Port from `PORT` (default 3000). Health check: `GET /health`.

**Storage.**
- Default: **in-memory** (`db.js`), reseeded at boot when `DEMO_MODE` is not `0` (7 fleets, about 574 incidents observed at boot on 2026-11-02). All data is lost on restart. Memory caps exist per record kind (`MEM_CAP` in `db.js`).
- Optional: PostgreSQL when `DATABASE_URL` is set (JSONB incident store, idempotent migrations at boot, `nx_migrations` table). **Postgres mode has never been exercised against a live database** (stated in `docs/DEPLOY.md`; I found nothing contradicting it). Treat it as untested code. Note `db.js` sets `ssl: { rejectUnauthorized: false }` for hosts matching `render.com|amazonaws|neon.tech|supabase` (TLS without certificate verification).
- Some state is held only in process memory regardless of storage mode: rate-limit buckets, SSE client list, prediction model cache.

**Hosting facts in the repo.**
- `render.yaml` (Render blueprint): one `web` service `nexus-response-demo`, `runtime: node`, **`plan: free`**, `buildCommand: npm install`, `startCommand: npm start`, `healthCheckPath: /health`, env `NODE_VERSION=20`, `DEMO_MODE=1`, `REQUIRE_AUTH=0`. No database is declared in the blueprint.
- `README.md` has a "Deploy to Render" button pointing to `github.com/bradcastro/nexus-response` (branch `poc-mantis-demo`). README states the free plan sleeps after inactivity and the first load can take about 30 seconds (this is the repo's own statement; I did not measure it).
- **UNKNOWN:** whether the public demo instance is currently deployed, its URL, which branch/commit it runs, and whether it matches this working tree (the working tree has uncommitted changes from other agents; `git status` shows modified files under `public/`).
- Render free-plan behaviour (sleep, no persistent disk, resource limits, SLA) is Render's, not verified here. A free instance has no uptime commitment that I can substantiate.

**Production deployment requirements (from `docs/DEPLOY.md`, not tested end to end).** `DEMO_MODE=0`, `REQUIRE_AUTH=1`, `DATABASE_URL`, vendor webhook secrets, TLS in front (the platform provides it on Render), `trust proxy` configured if IP rate limiting is to be meaningful behind a load balancer (**not set in `server.js`**), backups on the database. None of this has been run as a production deployment.

---

## 2. Code, asset and IP ownership - facts only

**This section lists facts. It is not legal advice and reaches no legal conclusion. Ownership, licensing and IP questions need qualified counsel and are UNKNOWN until counsel answers them.**

| Question | Fact found | Status |
|---|---|---|
| Repo owner on GitHub | `origin` = `https://github.com/bradcastro/nexus-response.git`. Commit authors: "Brad Castro" and "bradcastro" (GitHub noreply) - 43 commits total. | Fact |
| License file in repo | **None.** No `LICENSE*` file is tracked (`git ls-files` finds none) and `package.json` has no `license` field. | Fact. Legal effect of having no license: **UNKNOWN - counsel** |
| Copyright notices / headers | None found in source files. | Fact |
| Contributors other than the owner | Git history shows only the owner's identities. Some commits carry a `Co-Authored-By: Claude ...` trailer (AI assistance, see below). No outside human contributors in git history. | Fact. Whether any contractor/employer/third party has rights: **UNKNOWN** |
| AI-assisted code | Much of the code was written with Claude Code (Anthropic's coding assistant); commit trailers record this. | Fact. **Who owns AI-assisted code, and whether any restrictions or disclosure obligations apply, is a legal question: UNKNOWN - needs counsel** (including review of the applicable Anthropic terms for the account used) |
| Brand / name | "Nexus Response" name, logo (`public/shared/logo*.svg`), palette and fonts are in `public/shared/` and `docs/BRAND.md`. | **UNKNOWN:** trademark clearance/registration for "Nexus Response" has not been checked anywhere in the repo |
| Fleet name "Goodyear Towing" and provider "Goodyear Towing & Recovery" | Present in the seed data (`src/data/ref.js`). The owner's account email domain is `goodyeartowing.com`. | **UNKNOWN** whether these names are intentionally the owner's real business or coincide with other real businesses. "Goodyear" is also a well-known tire brand. Review before showing externally |
| Datasets | All demo data is generated in code (`src/data/ref.js`, `src/seed.js`, `src/context/places.js`, `src/context/dealers.js`, `src/predict/fixture.js`). Business names are stated in code comments as invented. No real customer, vendor or telematics data is in the repo. | Fact. Coincidental similarity of invented names to real businesses: **UNKNOWN** (not checked) |
| OEM warranty terms | `src/enrich/warranty.js` hard-codes approximate coverage terms per OEM (e.g. years/miles). They are hand-entered, not sourced from OEM documents. | Fact. Accuracy: **UNKNOWN** |
| Vendor payload shapes | Motive/Samsara/Geotab/Lytx adapters are written from the author's understanding of public vendor APIs; Mantis is explicitly assumed. No vendor documentation or SDK is vendored. | Fact. Whether adapters match current vendor APIs: **UNKNOWN** (not validated against live vendor traffic in this audit) |

**Third-party dependencies (from `package-lock.json` / installed `node_modules`; 111 installed packages).**

Direct dependencies:

| Package | Version installed | License (from its package.json) |
|---|---|---|
| express | 4.22.3 | MIT |
| cors | 2.8.6 | MIT |
| helmet | 7.2.0 | MIT |
| dotenv | 16.6.1 | BSD-2-Clause |
| pg | 8.23.1 | MIT |
| nodemon (dev) | 3.1.14 | MIT |

Whole tree by license string: MIT 102, ISC 9, BSD-2-Clause 1 (dotenv), BSD-3-Clause 1 (`qs`), BlueOak-1.0.0 1 (`minimatch`), and 1 with **no license field in its package.json** (`fsevents`, an optional macOS-only dependency pulled in by nodemon's file watcher; its license could not be determined from the installed metadata - UNKNOWN). No copyleft (GPL/AGPL) license string was found in the tree. This is a metadata check, not a license compliance review.

Client-side/third-party assets loaded at runtime by the browser:
- **Leaflet 1.9.4** (JS and CSS) from `cdnjs.cloudflare.com` (dispatch portal `public/dispatch/index.html`; the fleet portal also shows a Leaflet map). Leaflet's own license is believed to be BSD-2-Clause but is not vendored in the repo - not verified here.
- **Map tiles from OpenStreetMap** (`https://tile.openstreetmap.org/{z}/{x}/{y}.png`, `public/dispatch/app.js`). The map shows the attribution "(c) OpenStreetMap contributors". OSM data is under the ODbL; the OpenStreetMap Foundation tile servers have a published usage policy that restricts heavy/commercial/production use and requires a valid Referer/User-Agent (the repo already works around a 403 by setting a `strict-origin-when-cross-origin` referrer policy - commit `d489948`). **Compliance with that policy at any scale beyond a small demo is UNKNOWN; production use would need a commercial tile provider or self-hosted tiles.**
- **Fonts:** Barlow Condensed, IBM Plex Sans, IBM Plex Mono via Google Fonts (`fonts.googleapis.com`). These are published by Google Fonts under open font licenses (believed SIL OFL; not verified in repo). Loading from Google Fonts sends visitor requests to Google.
- Optional: NHTSA vPIC (`vpic.nhtsa.dot.gov`) for VIN lookup when `VIN_ONLINE=1` (off by default); optional Google/Mapbox keys are read from env and returned by `/api/config` but are not required (`GOOGLE_MAPS_KEY`, `MAPBOX_TOKEN`).
- Deep links built in the job page to Google Maps / Apple Maps (links only, no API calls).

---

## 3. Dependencies on the platform used to build the product

- **Built with Claude Code assistance** (Anthropic). Commit trailers and repo docs (`docs/HANDOFFS.md` shows multiple coordinated agents) are consistent with that.
- **No runtime dependency on Claude Code, Anthropic APIs or any AI service.** I grepped the source for Anthropic/OpenAI/LLM client usage and found none; `package.json` contains no AI SDK. All "AI" behaviour in the product is either (a) the assumed vendor AI verdict carried in the incoming Mantis payload, (b) hand-written rules/heuristics, or (c) a hand-weighted statistical formula (see `docs/PREDICT.md`, `docs/INFERENCE.md`).
- **Code is plain Node.js and vanilla JS in an ordinary git repo**; it can be cloned and run without the original tooling (`npm install && npm start`).
- **Hosting:** Render (blueprint in `render.yaml`). Moving to another host requires only a Node 18+ process plus optionally Postgres.
- **Any transfer restrictions** (terms of the build tooling, hosting accounts, GitHub repository ownership/transfer mechanics, any third-party terms tied to the accounts used): **UNKNOWN - not determinable from the repo; confirm with counsel.**

---

## 4. Integrations: live vs. synthetic-payload only

Honest summary: **there is no live integration with any vendor that has been verified in this audit.** Every adapter has been exercised only with payloads produced by this repo's own fixture builder (`src/fixtures/*`), served at `GET /api/demo/sample/:provider`. Adapters implement the author's best understanding of each vendor's shape; none has been validated against real vendor traffic or current vendor documentation.

| Vendor | Inbound path | Auth implemented | Tested with | Verified live with vendor? | Notes |
|---|---|---|---|---|---|
| Motive | `POST /webhook/motive` (+`/batch`) | Fleet API key and/or HMAC-SHA256 (`x-motive-signature` / `x-webhook-signature`, `MOTIVE_WEBHOOK_SECRET`) | Synthetic sample, 6-vendor sweep on 2026-11-02: accepted, duplicate detected | **No / UNKNOWN** | Header names are preserved from original code; the original (pre-platform) Motive poller used the real Motive API at some point (see legacy row) |
| Samsara | `POST /webhook/samsara` | same pattern, `SAMSARA_WEBHOOK_SECRET` | Synthetic sample: accepted | **No / UNKNOWN** | |
| Geotab | `POST /webhook/geotab` | same, `GEOTAB_WEBHOOK_SECRET` | Synthetic sample: accepted | **No / UNKNOWN** | Geotab typically needs a Data Feed/Add-In relay; the setup text in onboarding describes this but it is unverified |
| Lytx | `POST /webhook/lytx` | same, `LYTX_WEBHOOK_SECRET` | Synthetic sample: accepted | **No / UNKNOWN** | |
| Mantis | `POST /webhook/mantis` | same, `MANTIS_WEBHOOK_SECRET`, header `x-mantis-signature` (**assumed**) | Synthetic sample (schema `mantis.event.v1`, invented): accepted; also tested HMAC valid/invalid with a test secret on a scratch server | **No. No Mantis specification, sandbox, credentials or contact exist in the repo** | All field paths (`gps`, `road_facing`, `driver_facing`, `ai`, `media`, `inertial`, `diagnostics`), event vocabulary, and the signature scheme are assumptions. One-file change to adapt (`src/adapters/mantis.js`, `src/fixtures/mantis.js`, `VENDOR_COLS.mantis` in `src/importer.js`) per `docs/MANTIS.md` |
| Generic | `POST /webhook/generic` | same, `GENERIC_WEBHOOK_SECRET`, `x-nexus-signature` | Synthetic sample: accepted | n/a - Nexus's own flat JSON format | Intended fallback for any other source |
| Legacy Motive poller | outbound polling of `https://api.gomotive.com` (`MOTIVE_API_KEY`) | API key in env | **Not run in this audit** | **UNKNOWN** whether it still works; it predates the platform and bypasses the new pipeline (writes via `saveIncident`) | Off in demo mode; runs only if `DEMO_MODE=0` or `ENABLE_LEGACY_POLLERS=1` and a key is set |
| Legacy Samsara poller | outbound polling of `https://api.samsara.com` (`SAMSARA_API_KEY`) | API key in env | **Not run in this audit** | **UNKNOWN** | same |
| CSV import (all vendors incl. Mantis) | `POST /api/import/jobs` | none (open) | Repo-supplied synthetic CSVs (`public/onboarding/samples/*.csv`); a 300-row Mantis-style file imported with 300/300 rows OK and data-quality score 100 | **No** - real vendor export formats not verified; Mantis export columns are assumed | |

Outbound "integrations" - all **simulated** (no network call is made): SMS/email/push/call to drivers, fleet managers, tow providers, authorities, cargo owners; FNOL to insurer; OEM warranty portal submission; tow job-link texting. The API responses and timeline entries are labelled "(simulated)" and `simulated: true`. There is no SMS/email/telephony/OEM-portal/insurer integration in the code (no Twilio/SendGrid/etc. dependency).

---

## 5. External services, licenses, operating costs, maintenance

Required to run the demo: a Node 18+ host. Nothing else.

| Item | Needed for | Cost / terms |
|---|---|---|
| Render free web service | Public demo hosting | Plan per `render.yaml`. Current Render pricing and limits: **UNKNOWN here (not verified)** |
| GitHub repository | Source, deploy button | Account-level; cost UNKNOWN |
| OSM tiles / cdnjs / Google Fonts | Map and fonts in the browser | Free public services; usage policy applies (see section 2); no SLA |
| PostgreSQL (optional) | Durable storage | Not provisioned; untested; cost UNKNOWN |
| NHTSA vPIC (optional) | Online VIN decode | Public API; off by default |

What does **not** exist and would be needed for a real service: SMS/email/voice provider, OEM warranty portals/EDI, insurer FNOL integration, real tow-network or dispatch partners, real map/geocoding/routing provider, video storage/streaming for camera clips (current clips are `.invalid` URLs plus generated placeholder SVG frames), log/monitoring/alerting stack, secret management, backup/restore procedures, and a real vendor-credential flow. **Operating cost for production: UNKNOWN - no sizing, load test or cost model exists.**

Maintenance needs visible in the code: keeping adapters in sync with vendor API changes; updating hard-coded reference tables (DTC table about 40 codes, OEM warranty windows, dealer/provider lists); re-validating or replacing the hand-weighted predictive model; dependency updates (`npm audit` was not run as part of this audit); in-memory state and rate limiting need redesign for more than one instance.

---

## 6. Authentication, roles, data isolation, credentials, audit logging - exactly what exists

### What EXISTS (verified by code read; items marked [T] also exercised on a scratch server)
- **Per-fleet API keys** for webhook ingest. Format `nxk_live_<32 hex>`; only the **SHA-256 hash** is stored; plaintext shown once at creation/rotation; keys can be rotated (old keys revoked) and have `active/revoked` status and `lastUsedAt`. Accepted via `x-nexus-key` or `Authorization: Bearer nxk_live_...`. [T: valid key accepted; invalid key 401; key for a Mantis fleet used on `/webhook/mantis`]. A key is bound to a fleet and a vendor: using it on a different vendor's webhook returns 403 `provider_mismatch` (code read).
- **Vendor HMAC-SHA256 verification** of the raw request body, constant-time compare, per-vendor secret from env. **Only enforced when the secret env var is set.** [T: with `MANTIS_WEBHOOK_SECRET` set - valid signature accepted, bad signature 401, missing signature 401]. The secret is global per vendor, not per fleet, so a valid signature does not identify which fleet the event belongs to.
- **`REQUIRE_AUTH=1`** rejects webhook requests that have neither a valid key nor a valid signature (401). [T] Default is **off** (`render.yaml` sets `REQUIRE_AUTH=0`), so the demo accepts unauthenticated webhooks.
- **Rate limiting** on webhook routes: fixed 60-second window, default 1,200 requests/minute per client IP and per key id (`RATE_LIMIT_PER_MIN`; batches cost 1 + events/100); returns 429 with `Retry-After`. In-memory, per process. No `trust proxy` setting, so behind a reverse proxy the client IP seen may be the proxy's (code read; not tested behind a proxy).
- **Payload limits:** JSON body 30 MB; single webhook event 1 MB; batch up to 5,000 events.
- **Ingest log / dead letter / replay:** every webhook attempt (accepted, duplicate, rejected, failed) is recorded with status, auth method, latency, payload (for rejects/failures); `GET /api/ingest/log`, `/api/ingest/health`, `POST /api/ingest/log/:id/replay`. [T] This is an integration log, not a user audit trail.
- **Incident timeline** (per-incident append-only list of actions with timestamp, `actor`, action, note) and a **communications log** (`/api/comms`) record what dispatch/fleet/job-link actions occurred. The `actor` is a **free-text field supplied by the client request body** (default "dispatcher"); it is **not** an authenticated identity.
- **Public report links** (`/report/:token`): random 24-hex tokens, 30-day expiry, PII keys (phone/email/contact) redacted from the snapshot at write and read time (per HANDOFFS; code present in `src/insurer.js` `redactPII`).
- **Tow job links** (`/job/:token`): random 32-hex token, 7-day expiry (observed `expiresAt`).
- Helmet security headers (HSTS, `X-Content-Type-Options`, frame options etc.) are on, with the two overrides listed below. CORS is open (`Access-Control-Allow-Origin: *`).

### What does NOT exist (stated plainly)
- **No user login.** There are no user accounts, passwords, sessions, SSO or MFA anywhere in the product.
- **No roles or permissions.** Dispatcher, fleet manager, insurer and onboarding "roles" are only different static pages. Any visitor can open any portal and switch between fleets with a dropdown/URL parameter.
- **No portal or API authentication.** Every `/api/*` route other than webhook ingest is open to anyone who can reach the server, including write routes (dispatch, dismiss, status, notes, notify, FNOL, warranty submit/status, onboarding fleet create, key rotate, roster upload, import, assessments, reports, predict alert actions, demo simulate/seed). [T: with `REQUIRE_AUTH=1` and a secret set, unauthenticated `GET /api/incidents`, `/api/onboarding/fleets`, `/api/ingest/log`, `/api/comms`, `/api/insurer/reports` all returned 200, and unauthenticated `POST .../dismiss` and `POST /api/demo/simulate` returned 200.] `REQUIRE_AUTH` protects **only** webhook ingest.
- **No fleet data isolation.** There is no tenant boundary in the API: any client can read any fleet's incidents, drivers, vehicles, claims and comms by id. The "fleet sees only its own trucks" statement on the launcher page is a UI convention, not an enforced control. API keys scope only *ingest*, not reads.
- **No authenticated audit logging** (see actor note above) and no log of who read what.
- **No encryption at rest, field-level protection or data-retention policy** in the app (in-memory by default; Postgres untested). Raw vendor payloads are stored on each incident (`GET /api/incidents/:id/raw` serves them to anyone).
- **No CSRF/anti-abuse layer** beyond the webhook rate limit; the 30 MB JSON body limit applies to all routes.

---

## 7. Security review gaps (found by inspection and scratch-server tests)

Ordered by what I would fix first for any non-demo exposure:

1. **All non-webhook API routes are unauthenticated and writable** (section 6). Anyone can dismiss or dispatch incidents, create fleets, rotate/issue keys (`POST /api/onboarding/fleets/:id/rotate-key` returns a fresh key for any fleet, and revokes the old one), delete onboarded fleets, import data, and trigger simulated comms.
2. **API key exposure path:** `rotate-key` is open, so an attacker can both lock a customer out and obtain a valid ingest key for that fleet.
3. **Unauthenticated debug endpoints that call third-party APIs with server-held credentials:** `GET /api/debug/samsara`, `/api/debug/motive-safety-list`, `/api/debug/motive-safety/:eventId` in `server.js`. They use `SAMSARA_API_KEY` / `MOTIVE_API_KEY` if set and return truncated upstream responses to any caller. (With keys unset they return 500; observed.) Remove or protect before any keys are configured.
4. **Public link tokens are enumerable:** `GET /api/insurer/reports` lists all report tokens, and `GET /api/incidents` includes each incident's `jobLink` token, so the "private link" model is not private while the list routes are open. Job-link actions (`POST /api/jobs/:token/...`) change incident state with no other check.
5. **Content-Security-Policy is disabled** (`helmet({ contentSecurityPolicy: false })`) and cross-origin resource policy is off (done deliberately to make OSM tiles/CDN load). Combined with open CORS (`*`) this weakens XSS and cross-site defenses. Portals build HTML strings in client JS; an escaping review was not performed.
6. **HMAC secrets optional and global per vendor.** With no secret and `REQUIRE_AUTH=0` (the shipped Render blueprint), anyone can inject events into any fleet (events are routed to a fleet by VIN/vehicle id/org id match in the payload).
7. **Rate limiting is in-memory and IP-based without `trust proxy`**; no limit on non-webhook routes.
8. **Postgres TLS:** `rejectUnauthorized: false` for known hosted providers.
9. **SSE stream open** (`/api/stream?fleetId=`): anyone can subscribe to any fleet's live events; the `fleetId` filter is client-controlled.
10. **Dependency hygiene not audited:** `npm audit` not run; lockfile present.
11. **`POST /api/demo/reset` and `/api/demo/seed` are unauthenticated**: anyone who finds the public demo URL can wipe the instance's state, including during a live demo (reset is refused when `DATABASE_URL` is set or `DEMO_MODE=0`, per `docs/API.md`).
11b. **Raw payload retention:** incident `raw` and ingest-log rejected payloads are stored verbatim and are retrievable via open routes.
12. **No input hardening review** (e.g. CSV import formula/size abuse beyond row caps, HTML-injection in comms templates editable via open `PUT /api/comms/templates/:key`).

None of these were exploited beyond the read/write probes noted. No penetration test or third-party security review has been done: **UNKNOWN / not done**.

---

## 8. Known limitations and remaining production work (prioritized)

Full limitation list: `docs/KNOWN_LIMITATIONS.md`. Prioritized work, assuming the goal is a real pilot with a real partner:

**P0 - blockers for any real data or any public exposure beyond the demo**
1. Authentication, user accounts and role-based access for all portals and `/api/*`; enforce per-fleet tenant isolation on every read and write; authenticated `actor` on timeline/comms; remove or protect `/api/debug/*`, `/api/demo/*`, `/test/trigger-event`, `rotate-key`.
2. Obtain a **real Mantis specification and sandbox**, rewrite `src/adapters/mantis.js` and fixtures to it, and validate with real (or Mantis-supplied sample) payloads. Do the same for any other vendor intended for a pilot. Until then the Mantis integration is a proposal.
3. Verify PostgreSQL mode on a staging database (migrations, restore, `rejectUnauthorized`), define retention, backups, and encryption.
4. Counsel review of IP/ownership (including AI-assisted code), licensing (add an explicit license/ownership statement), trademark and name clearance, data-handling terms with any partner, and any privacy law obligations for driver/location/video data (all UNKNOWN today).

**P1 - needed before customers rely on outputs**
5. Replace simulated outbound actions with real integrations (SMS/voice/email, tow dispatch networks, OEM warranty portals, insurer FNOL) or clearly keep them as "recommendations only".
6. Camera verification: today non-Mantis "verification" is a rule-based synthesis from sensor hints, not video analysis. A real design needs vendor-provided AI verdicts and/or a video pipeline and media storage.
7. Predictive model: collect real labelled outcomes (collisions/claims), fit and calibrate, validate out of sample, document model governance. Current model is hand-weighted and tuned on the same synthetic data it is demonstrated on.
8. Load inference and reference data: validate against real J1939/engine telemetry and scale tickets; replace invented dealer/provider/business datasets with licensed or partner data; verify OEM warranty terms against OEM documents.
9. Observability, alerting and an operations runbook; load/soak test; multi-instance design (move rate limiting, SSE and prediction cache out of process memory).

**P2 - hardening and polish**
10. Enable CSP and a tighter CORS policy; self-host or license map tiles and fonts; self-host Leaflet with SRI.
11. Dependency audit and update process; automated tests (the repo has only `src/predict/selftest*.js` and `scripts/check-consistency.js`, a script that exercises the API against a server; neither was run by this audit) and CI.
12. Pricing/underwriting outputs (premium adjustment signals) should not be shown to real carriers without actuarial and regulatory review (UNKNOWN requirements).

---

## 9. Consolidated list of UNKNOWNs

- Whether the public Render demo is live, its URL, and that it matches the current tree.
- Legal ownership/IP status of the code (including AI-assisted portions), absence of a license file, trademark status of "Nexus Response", rights in invented names, and any transfer restrictions on tooling/hosting accounts.
- Real-world accuracy of every vendor adapter, including all Mantis field names, event vocabulary and signature scheme.
- Whether the legacy Motive/Samsara pollers still work against current vendor APIs.
- PostgreSQL mode behaviour on a live database.
- Operating costs, capacity, uptime, load behaviour; Render free-plan terms.
- Compliance with OSM tile usage policy at any scale; font and Leaflet license texts (not vendored).
- License of the optional `fsevents` package; `npm audit` status.
- Accuracy of hard-coded OEM warranty terms, DTC descriptions and costs, and the inferred load/weight/value outputs against real-world data.
- Regulatory requirements for the underwriting/pricing signals and for handling driver/location/video data.
- Whether any real business is represented by the invented names (notably "Goodyear Towing").
