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
Gulf Coast Freight (Motive, 38 trucks, Freightliner), Goodyear Towing (Motive, 22, Ford/Kenworth), Piedmont Logistics (Samsara, 54, Volvo/Peterbilt), Bluegrass Dairy Transport (Geotab, 31, Peterbilt), Summit Last-Mile Delivery (Lytx, 67 vans, Ford Transit/Mercedes Sprinter).

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
