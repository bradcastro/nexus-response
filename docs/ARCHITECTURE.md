# Nexus Response — POC Architecture & Shared Contract

Audience for the demo: Mantis (telematics/fleet-safety stakeholders). Pitch: **one platform that ingests events from any telematics/camera vendor, normalizes them, and turns them into incident management + roadside assistance + OEM warranty claims + cross-fleet insurer risk analytics.**

## Pillars (what the demo must show)
1. **Incident management** (the hook): collision/harsh events -> validated -> dispatched -> resolved, with timeline.
2. **Camera-authenticated events**: video/snapshot + AI verdict + confidence proves an event is real (and what happened) before dispatch / claim.
3. **Roadside assistance w/ trouble codes**: DTC/fault codes arrive with the event; platform decodes them, recommends service type + parts, and pre-stages the right provider.
4. **OEM warranty claims streamlined**: VIN-based preloaded vehicle/warranty info + event evidence auto-assembles a claim packet.
5. **Multi-vendor ingestion**: Motive, Samsara, Geotab, Lytx (and generic) all normalize to ONE schema.
6. **Four audiences**: Platform backend, Dispatch center, Fleet customer portal, Insurance carrier portal (risk across many fleets/vendors).

## Layout / file ownership (agents must NOT edit files they don't own; request changes via docs/HANDOFFS.md)
| Path | Owner |
|---|---|
| `server.js`, `db.js`, `src/**`, `package.json`, `.env.example` | **backend** |
| `public/shared/**` (brand.css, brand.js, logo.svg), `public/index.html` (demo launcher/landing), `docs/BRAND.md` | **brand** |
| `public/dispatch/**` | **dispatch** |
| `public/fleet/**` | **fleet** |
| `public/insurer/**` | **insurer** |
| `dashboard.html`, `motive-poller.js`, `samsara-poller.js` | legacy, keep working; backend may reuse logic |

Server serves `public/` statically: `/` (launcher), `/dispatch/`, `/fleet/`, `/insurer/`. Health check moves to `/health`. Legacy `/dashboard` stays.
Portals are plain HTML + vanilla JS (no build step), may load libs from cdnjs/jsdelivr (Mapbox optional; prefer Leaflet+OSM tiles so no token is required). Each portal links `/shared/brand.css` and `/shared/brand.js`.

## Canonical Incident schema (JSON)
```
{
  id: "NX-…", provider: "motive|samsara|geotab|lytx|generic", providerEventId: "…",
  fleetId: "fleet_…", fleetName: "…",
  eventType: "collision|harsh_brake|harsh_accel|harsh_turn|speeding|rollover|distracted|following_distance|fault_code|breakdown|tire|battery|other",
  category: "collision|safety|diagnostic|roadside",
  severity: "critical|high|medium|low",
  status: "pending|validating|dispatched|en_route|on_scene|resolved|dismissed",
  timestamp, receivedAt,
  vehicle: { id, vin, year, make, model, plate, odometer_mi, engine, oem: "Freightliner|Peterbilt|Kenworth|Volvo|Ford|…" },
  driver:  { id, name, phone, safetyScore },
  location:{ lat, lng, address, speed_mph, heading, road },
  trail:   [ {lat,lng,t,speed_mph} ],            // GPS breadcrumb before/after event
  camera:  { provider, verified: bool, aiVerdict: "confirmed_collision|false_positive|near_miss|distraction|…",
             confidence: 0-1, clips:[{url,type:"road|driver",durationSec}], snapshots:[{url,type}],
             signals:[ "Impact g-force 4.2g","Airbag deploy flag","Driver facing forward" ] },
  diagnostics: { dtcs:[{code,desc,system,severity,spn?,fmi?,recommendedAction,partsHint}], drivable: "yes|limp|no",
                 engineHours, faultLampOn: bool } | null,
  roadside: { needed: bool, serviceType: "tow_heavy|tow_light|tire|jump_start|fuel|mobile_mechanic|none",
              recommendedProvider:{id,name,etaMin,distanceMi}|null, assignedProvider: {…}|null, etaMin },
  warranty: { oem, vinDecoded:{…}, inWarranty: bool, coverage:"powertrain|bumper_to_bumper|emissions|none",
              expiresAt, milesRemaining, claimEligible: bool, claimId|null,
              claimPacket: { status:"draft|ready|submitted", summary, evidence:[…], estimatedValueUsd } } | null,
  risk: { eventScore: 0-100, tags:[…] },
  timeline: [ {t, actor:"system|dispatcher|fleet|provider", action, note} ],
  raw: { … original vendor payload … }
}
```
Ingest adapters live in `src/adapters/<provider>.js` and export `{ provider, verify(req), normalize(payload) -> Incident }`.

## HTTP API (backend implements; portals consume). All JSON. Dispatch sees all fleets; fleet portal passes `?fleetId=`.
- `POST /webhook/:provider` — vendor webhook (motive|samsara|geotab|lytx|generic) -> normalize -> enrich -> save -> SSE push.
- `GET  /api/incidents?fleetId=&status=&category=&limit=` -> `{incidents:[Incident]}` (newest first)
- `GET  /api/incidents/:id` -> `Incident`
- `POST /api/incidents/:id/dispatch` body `{providerId?, note?}`; `/dismiss` body `{reason}`; `/status` body `{status, note}`; `/notes` body `{note, actor}` — all append to timeline, return updated Incident.
- `GET  /api/incidents/:id/warranty-packet` -> printable claim packet JSON (+ `?format=html` for print view)
- `GET  /api/providers?lat=&lng=` -> roadside providers sorted by distance w/ ETA
- `GET  /api/fleets` -> `[ {id,name,vendor,vehicles,drivers,region} ]`
- `GET  /api/fleets/:id/summary` -> `{fleet, kpis:{openIncidents,mttrMin,eventsLast30d,roadsideCalls,warrantyRecoveredUsd,safetyScore}, trend:[{date,count}], byType:{…}, topDrivers:[…], vehicles:[{id,plate,status,lat,lng,openDtcs}]}`
- `GET  /api/insurer/portfolio` -> `{totals:{fleets,vehicles,events30d,lossRatioProxy}, fleets:[{id,name,vendor,vehicles,riskScore,riskTier,events30dPer100veh,collisionRate,topRiskFactors:[…],trend:"up|down|flat",cameraCoveragePct,verifiedEventPct}], byVendor:[{vendor,fleets,avgRisk}], distribution:{tiers…}}`
- `GET  /api/insurer/fleets/:id` -> deep dive: score breakdown (speeding, harsh events, collisions, distraction, maintenance/DTC backlog), drivers ranked, recent verified incidents, pricing signal (`suggestedPremiumAdjustmentPct`), benchmarking vs portfolio.
- `GET  /api/stream` — Server-Sent Events: `event: incident` (new/updated Incident). Portals use it for live updates.
- `POST /api/demo/seed?reset=1` — loads ~5 fleets x multi-vendor, ~150 historical incidents (seeded deterministic RNG) + drivers/vehicles. Called automatically at boot when `DEMO_MODE` != `0`.
- `POST /api/demo/simulate` body `{scenario}` — fires a realistic live event. Scenarios: `collision_camera` (headline), `dtc_breakdown` (roadside + trouble codes), `warranty_failure` (OEM claim), `false_positive`, `random`. Goes through the same adapters as real webhooks.
- `GET /health`

## Demo fleets (seed; keep these names so all UIs agree)
Gulf Coast Freight (Motive, 38 trucks, Freightliner), Elite Towing (Motive, 22, Ford/Kenworth), Piedmont Logistics (Samsara, 54, Volvo/Peterbilt), Bluegrass Dairy Transport (Geotab, 31, Peterbilt), Summit Last-Mile Delivery (Lytx, 67 vans, Ford Transit/Mercedes Sprinter).

## Brand (brand agent finalizes in docs/BRAND.md + shared/brand.css; others consume tokens)
Name: Nexus Response. Tagline: "Every event, resolved." Feel: mission-control / emergency-ops: dark navy base, signal-orange accent for urgency, clean data-dense UI, light-theme variant for fleet + insurer portals. CSS custom properties are the contract (`--nx-*`).

## Collaboration protocol
Agents coordinate through `docs/HANDOFFS.md` (append-only). Format:
`## [from -> to] short title` / status `OPEN|DONE` / what you need / acceptance check. Before finishing, every agent reads HANDOFFS.md for items addressed to them, does them if in their files, and appends new requests for others. The orchestrator runs follow-up rounds from OPEN items.

---
# ADDENDUM v2 — Incident Context Intelligence (trip, load, trailer, dealer)

Goal: when an incident happens, Nexus already knows **what the truck was doing and what it was hauling**. All of this is *inferred/estimated* and MUST be labeled with `confidence` (0-1) and `basis` (list of human-readable evidence strings) so the UI can show "how we know".

## New optional fields on Incident (all objects may be null for vehicles with no data)
```
trip: {
  tripId, startedAt, startLocation:{lat,lng,address}, distanceMi, durationMin, idleMin,
  lastStop: { name, placeType: "food_distributor|grocery_dc|cold_storage|steel_yard|lumber_yard|building_supply|fuel_stop|truck_stop|port|manufacturer|farm|quarry|retail_dc|parcel_hub|unknown",
              businessName, lat, lng, address, arrivedAt, departedAt, dwellMin, minutesBeforeIncident, milesSinceStop },
  recentStops: [ {name, placeType, arrivedAt, departedAt, dwellMin} ],   // last 3-5
  timeline: [ {t, kind:"drive|stop|idle|event", label} ],
  telemetry: {                               // 10-15 min windows around last stop departure
    before: { avgEngineLoadPct, avgFuelMpg, avgSpeedMph, avgRpm, sampleCount },   // last stop-approach window
    after:  { avgEngineLoadPct, avgFuelMpg, avgSpeedMph, avgRpm, sampleCount },   // post-departure window
    deltaEngineLoadPct, deltaFuelMpg, series:[ {t, engineLoadPct, fuelMpg, speedMph} ]   // ~60 pts spanning the stop and the incident
  }
} | null

equipment: {   // tractor + trailer
  tractor: { class: "class8_sleeper|class8_day_cab|class6_boxtruck|class3_pickup|van", make, model, year, engine, gvwrLb, tareLb, axles, fuelType },
  trailer: { attached: bool, type: "reefer|dry_van|flatbed|tanker|lowboy|dump|car_hauler|container_chassis|none", lengthFt, unitId, tareLb, maxPayloadLb,
             reefer: { setpointF, returnAirF, unitRunning: bool, fuelPct } | null,
             detectedBy: "camera|gps_pairing|telematics_aux|manual|inferred",
             cameraVerified: bool, cameraBasis: "string e.g. 'Rear/road cam sees 53ft reefer box with TK unit'" } | null
} | null

load: {
  estimatedWeightLb, weightRangeLb:[lo,hi], payloadPctOfMax, grossVehicleWeightLb, overweightRisk: bool,
  method: "engine_load_delta|fuel_economy_delta|mpg_vs_empty_baseline|camera_flatbed_visual|combined",
  contents: { category: "perishable_food|frozen_food|dry_grocery|beverage|building_materials|steel|lumber|machinery|vehicles|fuel_liquid|hazmat|aggregate|parcel|unknown",
              label: "Perishable foods (likely)", examples:["Dairy","Produce"], estimatedValueUsd:[lo,hi], hazmat: bool, temperatureSensitive: bool,
              spoilageRiskHours: number|null },
  confidence, basis: [ "Reefer unit running at 34F", "Last stop: Sysco Foodservice (food_distributor) 41 min before event", "Engine load +27% and fuel economy -2.1 mpg after departure => ~38-44k lb added" ],
  cameraVisual: { cargoVisible: bool, description: "e.g. 'Flatbed with 3 steel coils visible'", confidence }|null
} | null

warrantyDealer: {   // only when warranty.inWarranty && an OEM-coverable fault; recommended OEM service location
  oem, coverage, nearest: { id, name, brand, type:"dealer|service_center|mobile_service", address, lat, lng, distanceMi, driveEtaMin, phone, hours, open24x7: bool, heavyDutyBays: bool, hasPartsInStock: bool|null },
  alternates: [ same shape x2-3 ],
  authorizationRequired: bool, preAuthNumber: string|null, reason: "short string why this dealer"
} | null

// Add to roadside when applicable (no change to existing keys): roadside.towDestination: {kind:"oem_dealer|nearest_shop|fleet_yard", name, address, lat, lng, distanceMi}
```
Contents must also feed `risk.tags` (e.g. "hazmat_load", "high_value_cargo", "perishable_spoilage_clock") and the claim/packet (`warranty.claimPacket.evidence` adds trip + load context; cargo loss exposure added to packet summary).

## New endpoints
- `GET /api/incidents/:id/context` -> `{trip, equipment, load, warrantyDealer}` (same objects as embedded; embedded too in GET /api/incidents/:id).
- `GET /api/dealers?oem=&lat=&lng=&limit=` -> bare array of OEM dealers/service centers (seeded for FL/AL/GA/NC/SC/KY/TN/MS/LA; Freightliner, Peterbilt, Kenworth, Volvo, Ford, Mercedes, International, Mack) sorted by distance with driveEtaMin.
- `GET /api/places?lat=&lng=&radiusMi=` (optional) -> known business stops used by the inference (seed ~60: Sysco/US Foods style food distributors (use generic invented-but-plausible names like "Gulf Foodservice Distribution Center", NOT real brand names), cold storage, steel yards, lumber yards, ports, quarries, parcel hubs, truck stops).
- `POST /api/demo/simulate` gains scenarios: `reefer_collision` (reefer trailer after food distributor, camera verified reefer box, ~38-44k lb perishable), `flatbed_steel_collision` (camera sees steel coils on flatbed, ~42k lb, high-value, shifting-load risk), `warranty_dealer_breakdown` (in-warranty DEF/aftertreatment or turbo fault on Freightliner/Volvo => nearest OEM dealer with distance/ETA + tow destination), `hazmat_tanker_rollover` (critical; hazmat flag, spill risk).
- Insurer: `GET /api/insurer/fleets/:id` adds `cargoExposure:{ avgLoadLb, byContent:[{category,incidents,estValueUsd}], hazmatEvents, perishableEvents, highValueEvents, totalEstCargoExposureUsd }` and portfolio fleets get `avgLoadPctOfMax`, `cargoExposureUsd`.
- Fleet: `GET /api/fleets/:id/summary` kpis add `cargoAtRiskUsd`, `incidentsWithLoadContext`; `byContent` breakdown.

## Inference model (backend; deterministic & explainable; document in docs/INFERENCE.md)
Weight estimate: combine (a) engine-load delta before/after the last stop, (b) fuel-economy delta vs. empty baseline for that tractor class (empty class 8 ~ 8.0-8.5 mpg tractor+53ft box; loaded 80k lb ~ 5.5-6.5), (c) trailer type tare/max payload, (d) camera visual for flatbeds. Content type from last-stop placeType + trailer type + reefer state + camera. Pickup stops with dwell > 15 min and load increase imply a pickup; delivery drops imply decrease. Always output basis strings and confidence; low-confidence = wider range.

## Ownership (unchanged) — backend: src/**, server.js, db.js; dispatch/fleet/insurer: their folders. Backend finishes first on shapes; UI agents code to this addendum and verify when backend lands (check periodically; backend writes docs/API.md update).

---
# ADDENDUM v3 — Client-ready ingestion, historical import, predictive risk, Mantis

Context: no real data yet. The platform must be READY to receive real vendor data, onboard clients, let insurers load a fleet's history from any existing telematics system to assess risk, and PROJECT forward (get ahead of accidents). **Mantis** is the telematics/camera platform being pitched to: it must be a first-class provider (`provider:"mantis"`), several demo fleets run on it, and the demo should show that camera-first Mantis data yields better verification AND better prediction. (We do not have Mantis's real API spec: build the adapter to a documented ASSUMED payload in docs/MANTIS.md, flagged clearly as an assumption to replace with the real spec.)

## 1. Ingestion readiness (backend-ingest owns)
- **Per-fleet API keys** `nxk_live_…` (hashed at rest). Webhooks authenticate via header `x-nexus-key` (or `Authorization: Bearer`) and/or vendor HMAC signature. `REQUIRE_AUTH=1` enforces; demo mode leaves it optional so sims keep working. Rate limit + body size limit + schema validation with clear 4xx errors.
- **Idempotency**: dedupe on `(provider, providerEventId)`; replays return the existing incident.
- **Ingest log + dead letter**: every inbound request is recorded `{id, receivedAt, provider, fleetId, status:"accepted|duplicate|rejected|failed", error, latencyMs, payloadBytes, incidentId}`; failures are stored with raw payload and can be replayed.
  - `GET /api/ingest/log?fleetId=&status=&limit=`; `GET /api/ingest/health` -> per fleet/provider `{fleetId, provider, lastEventAt, events24h, errors24h, avgLatencyMs, status:"healthy|stale|failing|never_connected"}`; `POST /api/ingest/log/:id/replay`.
- **Batch ingest**: `POST /webhook/:provider/batch` array payloads.
- **Persistence**: Postgres schema is full-fidelity (incidents JSONB, fleets, vehicles, drivers, import_jobs, ingest_log, api_keys, alerts) with idempotent migrations at boot; in-memory remains default. Document in docs/DEPLOY.md (env vars, Render steps, backups).
- **Mantis adapter**: `src/adapters/mantis.js` (+ fixtures). Mantis payloads are camera-first: include driver-facing signals (drowsiness, phone use, seatbelt, smoking, lane departure), road-facing (following distance seconds, forward collision warning), and clip URLs. Normalization must populate `camera` richly and a `signals` list; mark `camera.verified` from Mantis' own AI classification.
- **Mantis demo fleets** (add to seed; keep the 5 existing): `Redline Regional Carriers` (Mantis, 46 trucks, Freightliner/Volvo, region: TN/KY/OH valley), `Magnolia Beverage Distribution` (Mantis, 29, beverage reefer + dry vans, region: MS/LA/AL). Mantis fleets: camera coverage ~97-99%, verified-event ~90%+, rich driver-facing signals, and a visibly IMPROVING risk trend after coaching interventions (shows value of Mantis feedback loop). Existing fleets keep their vendors (some with weaker camera coverage so the contrast is real).
- Seed history extends to **90 days** (daily granularity retained) with **precursor patterns**: before many collisions, the involved driver shows a 2-4 week escalation in leading indicators (tailgating, harsh braking, phone/drowsy flags, night hours, speeding) so the predictive backtest can honestly "catch" them. Some collisions have no precursor (realism). Mantis fleets have more precursor signal captured (driver-facing) so prediction works better there.

## 2. Client onboarding (backend-ingest + onboarding UI)
- `POST /api/onboarding/fleets` body `{name, vendor:"motive|samsara|geotab|lytx|mantis|other", vehicles?:number, contactName, contactEmail, region?}` -> `{fleet, apiKey (shown once), webhookUrl, setupSteps:[…vendor-specific text]}`; `GET /api/onboarding/fleets/:id/checklist` -> `{steps:[{key:"account_created|api_key_issued|first_event_received|vehicles_mapped|history_imported|alerts_configured", label, done, doneAt}], percent}`; `POST /api/onboarding/fleets/:id/test-event` sends a synthetic event through the real adapter; `POST /api/onboarding/fleets/:id/rotate-key`; `POST /api/onboarding/fleets/:id/vehicles` bulk roster upload (JSON array or CSV text: unit, vin, plate, make, model, year, driver).
- Fleet record gains `onboarding:{status:"demo|setup|live", createdAt}`.

## 3. Historical import (insurer assessment) (backend-ingest owns)
- `GET /api/import/templates/:vendor` (text/csv sample + header docs for motive|samsara|geotab|lytx|mantis|nexus).
- `POST /api/import/preview` body `{vendor, format:"csv|json", data|csv, mapping?}` -> `{detectedColumns:[…], suggestedMapping:{nexusField: sourceColumn}, sample:[normalized x5], warnings:[…], rows}`.
- `POST /api/import/jobs` body `{fleetId | newFleet:{name,vendor,vehicles?}, vendor, format, data|csv, mapping?, purpose:"underwriting|onboarding"}` -> `{job}`; job processes asynchronously (chunked, progress) -> `GET /api/import/jobs/:id` `{id,status:"queued|running|completed|failed", progress:0-1, rowsTotal, rowsOk, rowsSkipped, errors:[{row,message}], dataQuality:{dateRange:{from,to}, days, vehicles, drivers, fieldCoverage:{vin,driver,gps,speed,video,dtc,load}, duplicates, qualityScore:0-100, notes:[…]}, fleetId, assessmentId}`; `GET /api/import/jobs` list.
- Imported incidents carry `source:"historical_import"`, `import:{jobId}`; they feed analytics/risk/predict but NEVER create dispatch alerts, SSE `incident` pushes, or roadside actions.
- Also accept time-series style rows (events with `eventType,timestamp,vin,driver,lat,lng,speed,severity`) and **trip/mileage rows** (`vin,date,miles,hours`) so exposure (events per million miles) can be computed; mileage optional (fallback estimate flagged).
- **Assessment**: auto-run on import completion; `POST /api/insurer/assessments` body `{fleetId|jobId}` -> `{id, fleetId, createdAt, riskScore, riskTier, confidence, dataQualityScore, eventsPerMillionMiles|null, collisionRate, scoreBreakdown, topRiskFactors, driverRiskDistribution, benchmark:{vsPortfolio, vsVendorPeers}, pricing:{suggestedPremiumAdjustmentPct, rationale}, projection:{…same as predict fleet projection}, preAccidentIndicators:[…], recommendedPrograms:[…], limitations:[…]}`; `GET /api/insurer/assessments/:id`, `GET /api/insurer/assessments`. Printable `?format=html`.

## 4. Predictive risk — "get ahead of accidents" (predict agent owns src/predict/**, src/routes/predict.js, docs/PREDICT.md)
Router mounted by backend-ingest at `/api/predict`. Transparent, explainable model (no black box): EWMA/trend on leading indicators (following-distance/tailgating, harsh braking/accel/turn, phone use, drowsiness/fatigue, speeding, night/long-duty hours, DTC/maintenance backlog, camera-verified near-miss), Poisson-style event rates, per-driver and per-fleet, per-location hotspot clustering, time-of-day/day-of-week patterns, logistic-style collision probability from weighted indicators. Document formulas, weights and limits; label as demo-calibrated.
- `GET /api/predict/fleet/:id?horizonDays=90` -> `{fleetId, generatedAt, horizonDays, risk:{current, projected30d, projected90d, band90d:[lo,hi], direction:"improving|stable|worsening"}, series:[{date, actual?, projected?, lo?, hi?}], expected:{incidents30d, collisions30d, collisionProb30d, expectedLossUsd90d}, leadingIndicators:[{key,label,value,unit,trendPct,direction,weight,contributionToRisk}], interventions:[{key,label,expectedRiskReductionPct,expectedAvoidedIncidents90d,expectedSavingsUsd,targets:[driverIds]}], hotspots:[{lat,lng,label,riskScore,incidents,topEventType}], patterns:{byHour:[24 numbers], byDow:[7]}, modelNotes:[…]}`
- `GET /api/predict/drivers?fleetId=&limit=` -> ranked `[{driverId,name,fleetId,fleetName,riskNow,riskProjected30d,collisionProb30d,trend,signals:[{key,label,value,trendPct}],daysSinceLastCoaching,recommendedIntervention,lastIncidentAt}]`
- `GET /api/predict/vehicles?fleetId=` -> breakdown/collision-risk by vehicle from DTC lifecycles & event history.
- `GET /api/predict/alerts?fleetId=&status=&limit=` -> `[{id,createdAt,fleetId,fleetName,kind:"driver_risk_spike|fatigue_pattern|following_distance_trend|hotspot_forming|vehicle_breakdown_risk|maintenance_overdue",severity,subject:{type:"driver|vehicle|route",id,name},headline,rationale:[…],probability,horizonHours,recommendedAction,expectedImpact,status:"open|acknowledged|actioned|dismissed",history:[…]}]`; `POST /api/predict/alerts/:id/(ack|action|dismiss)` body `{note,actor}`. New alerts SSE `event: alert` on `/api/stream`. Alerts are generated at boot from seed, and re-evaluated on each new live incident.
- `GET /api/predict/backtest?fleetId=` -> `{fleetId, window, collisions, caught, recallPct, medianLeadDays, falseAlertsPer100Veh, examples:[{incidentId,driverName,warningAt,incidentAt,leadDays,signals:[…]}], limitations}` (honest: show misses too).
- `GET /api/predict/portfolio` -> `{fleets:[{fleetId,name,vendor,risk,projected90d,direction,expectedLossUsd90d,cameraCoveragePct,predictionConfidence}], byVendor:[{vendor,avgRisk,avgPredictionConfidence,avgLeadDays,cameraCoveragePct}], totals:{expectedLossUsd90d,alertsOpen,driversAtRisk}, insight:"Mantis fleets: …"}` — makes the Mantis camera-first advantage quantitatively visible (higher prediction confidence/lead time because of driver-facing signals).
- `POST /api/predict/simulate-what-if` body `{fleetId, interventions:[keys]}` -> projected risk/savings (used by UI sliders).

## 5. UI deliverables
- **Onboarding portal** `public/onboarding/**` (new agent): wizard to add a client fleet (pick vendor — Mantis featured), shows webhook URL + API key (copy), vendor-specific setup steps, 'send test event' with live confirmation via SSE, roster upload, historical import wizard (drop CSV/JSON → preview/mapping → job progress → data quality report → 'View assessment'), integration health table (from /api/ingest/health) + ingest log w/ replay.
- **Insurer**: 'Assess a new fleet' flow (upload history -> assessment report incl. projection and pre-accident indicators) + 'Projections' tab (portfolio forecast, Mantis vs others, what-if).
- **Fleet**: 'Ahead of risk' view (forecast chart with band, leading indicators, at-risk drivers w/ interventions + what-if, hotspots map, alert feed, backtest 'what we would have caught').
- **Dispatch**: 'Proactive' queue mode: predictive alerts distinct from live incidents, ack/action, link to driver/vehicle.
- **Launcher/brand**: add Onboarding card, Mantis featured in the vendor strip, 'predict' story step, refreshed demo script.

## Ownership additions
backend-ingest: server.js, db.js, src/** EXCEPT src/predict/** and src/routes/predict.js; predict agent: those paths + docs/PREDICT.md; onboarding agent: public/onboarding/**. Others unchanged.

---
# ADDENDUM v4 — Dispatch is the daily driver; everyone else is an occasional user

## Product principle (from the founder)
- **Dispatch center = used all day, every day.** Dispatchers assess breakdowns, validate incidents, dispatch tow companies, alert fleet managers, call authorities when needed, coordinate with other parties (drivers, OEM dealers, insurers, cargo owners). Dispatch UX must be optimized for speed, checklists and zero missed steps, not for analytics.
- **Fleets, tow companies, insurers = occasional users.** They should mostly be pulled in by notification and receive link-based, no-login views: job ticket links for tow providers, exceptions-only digests and shareable read-only reports for insurers, instant-notify for fleet managers. Dashboards exist but are not the primary touchpoint.
- **Insurance model is usage/behavior-based (like Tesla's insurance concept):** continuous driver/fleet behavior scoring from historical + current data, pricing signal that moves with behavior, transparent "what changed and how to improve". Do NOT use Tesla branding/names; call ours "Nexus Drive Score".
- **One-click OEM warranty claim**: when an in-warranty fault/incident exists, a single action submits the pre-assembled claim packet (VIN, fault codes, evidence, trip/load context, dealer, pre-auth) to the OEM warranty channel (SIMULATED in POC: returns confirmation number, logs on timeline).
- All outbound comms/claim submissions in the POC are SIMULATED (no real SMS/email/phone/OEM calls). Mark clearly in UI as 'simulated in demo' and log everything; use obviously fictional phone numbers (555-01xx) and invented agency/OEM-portal names.

## New backend endpoints (backend owns)
- `GET /api/incidents/:id/contacts` -> resolved directory `{fleetManagers:[{name,phone,email,role}], driver:{…}, insurer:{carrier,policyNo,fnolLine}, oem:{name,warrantyDesk,portal}, towProviders:[{id,name,phone,etaMin,rating}], authorities:[{agency,kind:"state_patrol|county_sheriff|ems|fire|dot|hazmat_response",phone,jurisdiction,recommended:bool,reason}], cargoOwner:{name,phone}|null}`
- `POST /api/incidents/:id/notify` body `{channel:"sms|email|call|push", to:{type, id?, name?, phone?, email?}, template?, message?, actor}` -> logs `{id, at, channel, to, subject, body, status:"delivered(simulated)", actor}` to the incident timeline + comms log. `GET /api/incidents/:id/comms`; `GET /api/comms/templates?kind=fleet_manager|driver|tow|insurer|authority|cargo_owner` (rendered with incident variables; editable text).
- `GET /api/incidents/:id/authority-brief` -> `{recommended:[{agency,reason,urgency:"now|soon|no"}], needsAuthorities:bool, script:"what to say, with location, injuries unknown/known, vehicle, trailer, hazmat/placard, lanes blocked", location:{lat,lng,address,road,direction,nearestMileMarker|null,crossStreet|null}, facts:[…], hazmat:{present,notes}|null}`
- `GET /api/incidents/:id/sop` -> checklist `{kind, steps:[{key,label,required,done,doneAt,doneBy,hint,autoCompletedBy?}], percent}` varying by incident type (collision, breakdown/DTC, hazmat, false positive, warranty); steps auto-complete when matching actions are logged (validated camera, dispatched tow, notified fleet manager, authority called, insurer FNOL sent, OEM claim submitted, customer ETA shared). `POST /api/incidents/:id/sop/:stepKey` body `{done,actor,note}`.
- `POST /api/incidents/:id/warranty/submit` (exists): make it one-click: idempotent; returns `{status:"submitted", confirmation:"WC-…", submittedTo:"<OEM warranty portal> (simulated)", submittedAt, packetUrl, estimatedValueUsd}`; also `POST /api/fleets/:id/warranty/submit-ready` for all 'ready' claims. Auto-ticks SOP step + timeline.
- `POST /api/incidents/:id/fnol` -> first notice of loss to the fleet's carrier (simulated) `{claimRef:"FNOL-…", carrier, submittedAt, attached:[camera clips,trip,load,evidence]}`.
- Tow job links: `POST /api/incidents/:id/dispatch` response gains `jobLink:{token,url:"/job/<token>"}`; `GET /api/jobs/:token` (public, no auth; job ticket: location, vehicle, trailer/load/weight class, hazards, drop-off destination, contact, notes, status), `POST /api/jobs/:token/(accept|decline|eta|arrived|complete)` body `{etaMin?, note?}` -> updates incident timeline/status.
- **Usage-based insurance (insurer)**: `GET /api/insurer/drivers?fleetId=&limit=` -> `[{driverId,name,fleetId,fleetName,driveScore:0-100,band,components:{followingDistance,braking,acceleration,cornering,speeding,distraction,fatigue,nightDriving,collisionHistory},trend30d,milesLast30d|null,events30d,cameraVerifiedPct}]`; `GET /api/insurer/fleets/:id/usage-based` -> `{fleetId, policyPeriod:{start,end}, driveScore, scoreHistory:[{date,score}], pricing:{basePremiumUsd, currentAdjustmentPct, projectedRenewalAdjustmentPct, monthlyAdjustmentUsd}, whatChanged30d:[{label,deltaPts}], topImprovementLevers:[{label,potentialPts,potentialSavingsUsd}], drivers:[top5 best, top5 worst]}`.
- **Occasional-user surfaces**: `GET /api/insurer/digest?carrier=&period=weekly` -> exceptions-only `{period, headline, fleetsNeedingAttention:[{fleetId,name,why,severity}], newHighSeverity:[…], notableImprovements:[…], claimsOpened:n, fnolsSent:n, recommendedActions:[…]}`; `POST /api/insurer/reports` body `{kind:"fleet|assessment|incident|digest", refId}` -> `{token,url:"/report/<token>"}`; `GET /api/reports/:token` -> JSON of the snapshot (public, read-only, time-limited 30d, no auth).

## UI ownership for this round
- **dispatch** (public/dispatch/**): the daily-driver upgrade — see below. 
- **insurer** (public/insurer/** and public/report/**): Nexus Drive Score / usage-based view, exceptions-only digest as the landing view, share-link creation, public read-only report page `/report/<token>`.
- **fleet** (public/fleet/**): one-click OEM claim (single + submit-all-ready), notification inbox/feed of what Nexus did for them (comms log), simplified 'What needs my attention' home.
- **onboarding agent** (public/job/**): the mobile-first tow provider job-ticket page `/job/<token>`: big accept/decline, ETA stepper, hazard banner, tap-to-navigate/call, status buttons; works on a phone with no login.
- **backend**: everything under 'New backend endpoints'; seed realistic contacts/templates/authorities/SOPs; insurer endpoints computed from existing history.

## Dispatch daily-driver requirements
Incident workflow as a guided SOP: validate (camera/AI/DTC) -> classify -> decide (dismiss / dispatch / escalate) -> act in one place. Right pane gets 'Actions' strip with big buttons: Validate, Dispatch tow (picks provider, shows job link sent), Notify fleet manager (template editor, send), Call authorities (shows authority brief + script, log call outcome), Send FNOL to insurer, Submit OEM claim (one click, confirmation), Notify cargo owner (when perishable/hazmat), Share ETA with driver. SOP checklist with progress ring pinned in the detail header; items auto-tick. Contacts directory tab with click-to-call. Comms log tab. Shift view: counts, SLA timers (time-to-validate, time-to-dispatch), unacknowledged criticals, handoff notes. Keyboard-first. Mark everything as simulated in demo.
