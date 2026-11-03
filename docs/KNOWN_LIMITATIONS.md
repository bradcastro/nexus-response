# Known Limitations - Nexus Response (Mantis demo POC)

Short, factual, and meant to be said out loud when asked. Details and evidence: `docs/CAPABILITIES.md`, `docs/BUYER_READINESS.md`. Date: 2026-11-02.

## What this is
A proof-of-concept demo. Not a product, not a pilot, not validated on any real customer, vendor or claims data. Mantis is a **prospective** partner; nothing here implies a relationship, endorsement or access to Mantis systems.

## Integration limits
- **Mantis adapter is built to an assumed payload** (`docs/MANTIS.md`). There is no Mantis spec, sandbox, credential or contact behind it. Field names, event types, signature header (`x-mantis-signature`) and the AI-verdict block are guesses. Adapting to the real spec is a small, isolated change (one adapter, one fixture file, one CSV column map), but it has not been done or tested.
- **No vendor adapter (Motive, Samsara, Geotab, Lytx, Mantis, generic) has been tested with real vendor traffic.** They are tested only with this repo's own synthetic fixtures.
- **Legacy pollers** (Motive, Samsara) are old code, off in demo mode, not run in this audit; whether they still work is UNKNOWN.
- **Every outbound action is simulated**: SMS/email/voice, tow dispatch and tow job-link texts, calls to authorities, FNOL to insurers, OEM warranty submissions and responses. API responses and timeline entries are labelled "(simulated)". Alert recipients configured in Onboarding are stored but never used.
- **CSV import** works on the repo's sample files; real vendor export layouts are unverified (Mantis export columns are assumed).

## Data limits
- **Everything is synthetic**: 7 fleets, drivers, vehicles, about 570 incidents over 90 days, tow providers, OEM dealers, business stops, carriers, policy numbers, phone numbers (fictional 555 numbers), contacts. Business names are invented; any resemblance to real businesses is unchecked (the seed includes a fleet named "Goodyear Towing" - confirm intent before external use).
- **Deterministic and generated with structure built in**: the seed deliberately plants pre-collision precursor patterns and gives each vendor a different "capture" factor (Mantis highest). Results that favour camera-first fleets are partly *inputs*, not findings.
- **No real video.** Clips are `.invalid` URLs; "camera frames" are generated placeholder SVGs.
- **Camera verification is not video analysis.** For Mantis events the verdict comes from the *assumed* AI block in the payload. For other vendors Nexus derives a verdict from sensor hints with a small hash-based jitter.
- **Load, cargo and value inference** run on simulated telemetry; the quoted accuracy compares the model with its own simulator, not with real trucks or scale tickets.
- **Reference tables are hand-entered**: about 40 fault codes, OEM warranty windows, dealer and provider lists. Accuracy against OEM documents or real directories is unknown.
- **In-memory by default**: all data resets on restart (the Render free plan also sleeps when idle; first request after sleep can take about 30 seconds per the README). PostgreSQL mode has never been run against a live database.
- Time-of-day patterns assume one timezone (UTC-5) for all fleets.

## Predictive model limits
- **Hand-weighted and uncalibrated.** Weights were set by the author and tuned against the same synthetic seed the backtest runs on (in-sample). Nothing is fitted to real losses.
- **Not validated on real claims or collisions.** Backtest recall/lead-time/false-alert figures describe the synthetic seed only. They vary run to run (observed 61% and 69% recall on the same server session after adding incidents) and must not be quoted as performance.
- The seed's collision frequency is several times typical industry rates, so the model clamps probabilities; absolute probabilities are not meaningful.
- Small sample (about 50-60 synthetic collisions across 7 fleets); no confidence intervals on the backtest itself.
- "Savings" from what-if interventions use assumed effect sizes and costs in `src/predict/config.js`. They are not customer savings and not forecasts.
- Insurer "pricing signal" / premium adjustment is a demo calculation, damped for thin history; it is not actuarial and not a rate filing.
- The "Mantis vs the rest" comparison is circular because of the seed's vendor capture factors.
- Absent signal is not safe: fleets without cameras show lower confidence and may be understated.

## Security limits
- **No user login, roles or permissions.** All portals and all `/api/*` routes except webhook ingest are open and writable by anyone who can reach the server. `REQUIRE_AUTH` only protects webhook ingest, and is `0` in the shipped Render blueprint.
- **No fleet/tenant isolation.** Any client can read or change any fleet's data; fleet switching is a UI dropdown.
- **No authenticated audit trail.** Timeline `actor` is client-supplied text.
- Open sensitive-looking routes: key rotation, fleet creation/deletion, report and job-link token listing, ingest log, raw payloads, demo seed/reset/simulate (anyone can reset the public demo), `/test/trigger-event`, `/api/debug/*` (which would call Motive/Samsara with server-held keys if configured).
- Content-Security-Policy is disabled; CORS is open (`*`); rate limiting is in-memory and IP based with no `trust proxy` configured.
- Webhook HMAC secrets are optional and per vendor (not per fleet).
- No penetration test, dependency audit or third-party security review has been done.

## Operational / commercial limits
- No monitoring, alerting, backups, load testing or capacity figures. Operating cost for a real deployment is UNKNOWN.
- Map tiles come from the public OpenStreetMap servers and fonts from Google Fonts; both need internet access and OSM's tile policy limits production use.
- No LICENSE file; IP and ownership questions (including AI-assisted code) need counsel and are UNKNOWN.
- No CI and no unit-test suite (only predictive self-tests and an API consistency script).

## What we do NOT claim
No real customers, pilots, partnerships, revenue, performance, accuracy, cost savings, regulatory approval, or Mantis endorsement. Do not describe demo outputs as results.
