# Demo Guide - Mantis walkthrough (5-minute and 15-minute)

Date: 2026-11-02. Everything on screen is synthetic and every outbound action is simulated. Mantis is a **prospective** partner; the Mantis adapter is built to an **assumed** payload. Say so in the first minute, not when asked.

`<URL>` below means the public demo address. **UNKNOWN:** the Render URL is not recorded in the repo; confirm it and that it runs the current commit before the meeting.

## Pre-demo checklist (do 15-30 minutes before)

1. **Wake the Render free instance.** Free instances sleep when idle; the README says the first load can take about 30 seconds. Run `curl -s <URL>/health` until it returns `{"status":"online",...,"demoMode":true,"store":"memory"}`. Hit `/`, `/dispatch/`, `/fleet/`, `/insurer/` once each so the first click in the meeting is not a cold start. (Memory mode reseeds on every wake - data from yesterday is gone, which is fine.)
2. **Reset the demo to a known state.** Open `<URL>/tour/` and press **Reset demo**, or `curl -s -X POST <URL>/api/demo/reset -H 'content-type: application/json' -d '{}'`. It reseeds the deterministic data and clears created fleets, comms, jobs, reports, assessments, API keys and alerts. Confirm with `curl -s <URL>/api/demo/state` (expect `fleets: 7`, `customFleets: 0`, `resetEnabled: true`). If reset returns 403 `reset_disabled`, the instance is running with a database or `DEMO_MODE=0` - do not demo on it.
3. **Check the map tiles.** Open `<URL>/dispatch/`: the map should show street tiles with "(c) OpenStreetMap contributors". Tiles come from the public OSM servers; if they are grey, check internet access (the venue network may block `tile.openstreetmap.org`, `cdnjs.cloudflare.com` or `fonts.googleapis.com`). Have a screenshot ready as a fallback and do not apologise for it - it is a free public map service.
4. **Check the tour loads** (`<URL>/tour/`, shows "Mantis walkthrough") and `GET <URL>/api/capabilities` returns 200 (the "What's real" panel uses the same honesty statements).
5. **Browser hygiene:** one window, dark theme default, zoom 100-110%, no devtools, JS console clean (the portals produced no console errors in the 2026-11-02 audit). Clear `localStorage` for the site if a previous tour left step state (`nx-tour-v1`).
6. **Do not do live:** onboarding a client with a real email, importing real data, pointing any real vendor at the webhook, or typing anything real. Use the repo sample CSVs and the "Add a client" fake names only.
7. **Have the facts page open in another tab:** `docs/KNOWN_LIMITATIONS.md` and `docs/MANTIS.md` (the assumed payload).

## Things never to claim

- That Mantis has agreed to, reviewed, endorsed or provided anything. That we have a Mantis spec, sandbox, API keys or contact (we do not).
- That the Mantis data is real or that field names match Mantis's real API.
- That "camera verification" is Nexus analysing video. In the demo it is the (assumed) Mantis AI verdict carried in the payload; for other vendors it is a rule-based stand-in. No video is processed.
- That anything has been sent: no SMS, email, call, tow dispatch, FNOL or OEM claim leaves the server.
- That predictions, risk scores, "caught X% of collisions", lead times, projected savings, cargo values or premium adjustments are validated or represent real performance or customer savings.
- That Mantis fleets "perform better" or give earlier warnings: the demo data was generated with Mantis-style fleets capturing more signal, so that is an input.
- Customers, pilots, revenue, uptime, security certifications, scale or latency numbers. We have none to quote.
- That it is multi-user ready: there is no login, roles or tenant isolation yet.

## Five-minute walkthrough (use `<URL>/tour/` -> "Start the five-minute walkthrough")

The tour's five-minute mode has three screens (generate event; event to response; summary). The timestamps below are a pacing guide.

| Time | Click / show | Say | Do NOT say |
|---|---|---|---|
| 0:00-0:40 | Open `/tour/`. Point at the banner. Click **What's real** and read the first lines aloud. | "Everything here is synthetic. The Mantis connection is built to a payload we assumed, because we don't have your spec. The goal is to show where Mantis-style camera events could go after the event, not to claim an integration." | Anything implying Mantis involvement or real data. |
| 0:40-1:30 | Start the five-minute walkthrough. Screen 1: generate the synthetic Mantis event (driver-distraction: phone use, eyes off road, short following distance, forward-collision warning, AI verdict "distraction"). | "This goes through the same webhook path any vendor would use, using the assumed Mantis schema. It's normalized into one incident format, the same one used for Motive, Samsara, Geotab and Lytx." | "Mantis sends this." (It is our guess at what it might send.) |
| 1:30-3:15 | Screen 2 (event to response): show the evidence (signals, AI verdict and confidence as carried in the payload, GPS, vehicle), then the recommended response with its rationale. Use the link to open it in **Dispatch** and show the same incident in the queue and timeline. | "The recommendation is rules over the event's own data: severity, signals, driver history. It's a suggestion with the reasoning shown. It does not contact anyone. Notice the labels that say simulated." | "The AI decided." / "Nexus verified the video." |
| 3:15-4:15 | Summary card: what changed on the incident (timeline entries), then **Fleet** view of the same driver/vehicle to show coaching context. | "The point is a documented trail from camera event to action, visible to the fleet. The actions are simulated; wiring them to real tow, SMS or claims systems is integration work we haven't done." | Any dollar value as savings. |
| 4:15-5:00 | Close on honesty and next step. | "What we'd need from you: the real event payload spec, a sandbox or sample events, and your view on which workflows matter. What we'd do: replace the assumed adapter, run your samples through, and report what maps cleanly and what doesn't." | Commitments about timelines, pricing or terms. |

## Fifteen-minute deep version

Use the launcher (`/`) scenario buttons and the portals; keep `docs/KNOWN_LIMITATIONS.md` ready.

| Time | Where | What to do | Talking points / caveats |
|---|---|---|---|
| 0:00-1:30 | `/tour/` -> What's real | Frame: synthetic, assumed Mantis payload, simulated actions, no auth yet. | State limits up front; it makes everything later more credible. |
| 1:30-4:00 | `/` launcher -> "Send Mantis event" then "Camera-verified collision". Open **Dispatch** | Watch the card arrive live (SSE). Open the incident: signals, AI verdict, clips panel, timeline. | Clips are placeholder frames labelled "NEXUS DEMO FRAME"; the verdict for Mantis is from the assumed payload's `ai` block. Live arrival is real SSE. |
| 4:00-6:30 | Dispatch -> dispatch a provider, open the tow **job link** (`/job/<token>`), press Accept / Arrived / Complete on the job page, then the comms log and the authority-call panel (exact labels may differ: look for "Comms log" and "Authority call") | Show the status flowing back into the incident timeline. | The "text to the tow driver" and every agency call are simulated; providers are invented. The job-link page and state changes are real code. |
| 6:30-8:30 | Launcher -> "Breakdown + trouble codes" and "Warranty breakdown to dealer"; in Dispatch open the warranty packet and **Submit OEM claim**, then advance the claim status | Fault codes decoded; recommended service type; claim packet assembled with evidence; claim status moves along a lifecycle. | Code table is about 40 codes, hand-entered. Warranty windows are approximations. The "OEM" replies are canned. |
| 8:30-10:00 | Launcher -> "False positive filtered" | Show an event dismissed before a truck rolls. | Works because the vendor/assumed-AI verdict says false positive; Nexus applies a rule on it. |
| 10:00-12:00 | **Onboarding**: show the client list and ingest health, click the sample Mantis CSV import (`public/onboarding/samples/mantis-export.csv`) with a fake client name | Day-one assessment from history; data-quality score; key shown once; Mantis setup steps are marked ASSUMED. | Only the repo's sample files; real export layouts unverified. Delete the test fleet afterwards (or Reset). |
| 12:00-14:00 | **Insurer** and **Fleet**: portfolio, a Mantis fleet's projection, the early-warning alert | Show how the same normalized data supports a different audience, and the SYNTHETIC banner. If asked about the "Mantis vs others" view, say the demo data was generated to include richer signals from camera-first fleets. | Do not quote backtest percentages, lead times or savings. If a number is on screen, say "illustrative, in-sample, not validated". |
| 14:00-15:00 | Close | Same close as the five-minute version. | |

## Q&A preparation (honest answers)

**Is this a real API / is it connected to Mantis?**
No to the second part. It is a real, working webhook API (`POST /webhook/mantis`, per-fleet API keys, optional HMAC, idempotency, validation, dead-letter log and replay), but the Mantis payload it expects is our assumption. We have not seen a Mantis spec or sandbox, and nothing has been tested with real Mantis traffic.

**What's simulated?**
All data (fleets, drivers, vehicles, history, tow providers, dealers, carriers, phone numbers). All outbound actions (SMS, email, calls to authorities, tow dispatch texts, FNOL, OEM warranty submissions/responses). The camera clips (placeholders). The predictive scores and backtest (hand-weighted, tuned on the synthetic data). The load/cargo inference (runs on simulated telemetry). Real and working: the ingest mechanics, normalization, the incident workflow, job-link state changes, import and data-quality scoring, live updates.

**Does it actually analyse the video?**
No. There is no video handling. For Mantis events the product uses the AI verdict and confidence supplied in the (assumed) payload. For other vendors the demo derives a verdict from sensor data with simple rules.

**How accurate is the prediction?**
Unknown. It has never been tested on real outcomes. The demo model is hand-weighted and was tuned against the same synthetic data it's shown on, so its backtest only shows the mechanics. We would need real labelled event and claim history to calibrate and validate it.

**Do Mantis fleets look better in the demo?**
Yes, because the synthetic data was built so camera-first fleets capture more pre-incident signal. Treat it as an assumption we'd test on real data, not a result.

**Who owns it? Can we license or acquire it?**
The repository is under the personal GitHub account `bradcastro` and the code has been written with Claude Code assistance. There is no LICENSE file. I am not giving a legal answer on ownership of AI-assisted code, licensing, trademark ("Nexus Response" has not been cleared) or transfer - those need counsel. Do not offer terms in the meeting.

**What would an integration require?**
From Mantis: the real event/webhook (or API) specification and auth scheme, sample payloads or a sandbox, field definitions (especially the AI verdict, signals, units, media URLs and retention), and a technical contact. From us: replace the assumed adapter and fixtures (one-file change per `docs/MANTIS.md`), map identifiers (org, vehicle, driver) to fleets, test with real samples, then production hardening: authentication and roles, tenant isolation, durable database (Postgres mode is untested), monitoring, a security review, and real connectors for any action we want to be non-simulated (SMS, tow networks, OEM, insurers). No timeline or cost estimate exists.

**Is it secure? Is customer data safe?**
Not yet for real data. Ingest is protected by per-fleet API keys (stored hashed) and optional HMAC signatures, with rate limiting and an ingest log. There is no user login, no roles, and no tenant isolation on the portals and API; the debug and demo endpoints are open. It is a demo environment with synthetic data only.

**Can it scale / what does it cost to run?**
Unknown. Single Node process, in-memory by default; no load tests or cost model. The demo runs on a Render free instance.

**What would you build first with us?**
(Suggest, not commit.) Replace the assumed adapter with the real one, run sample events through the full flow, and agree one workflow (for example collision verification to tow dispatch, or coaching follow-up) to make non-simulated end to end.

**Who are the competitors / why would customers want this?**
Not covered by this repo. Do not improvise numbers; say you have no market data to share.

## After the demo
- Press **Reset demo** on `/tour/` (or `POST /api/demo/reset`) so the next viewer starts clean; delete any fleets you created.
- Note any Mantis feedback on the payload verbatim; update `docs/MANTIS.md` rather than relying on memory.
- Do not send the live URL widely: the instance has open write endpoints and no authentication.
