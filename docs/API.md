# Nexus Response - Backend API (actual shapes)

Run: `npm install && npm start` (default port 3000, `PORT=3111 npm start` to change). In-memory store by default; set `DATABASE_URL` for Postgres (JSONB).
Boot seeds the demo (5 fleets, 212 vehicles, ~150 incidents over 30 days) unless `DEMO_MODE=0`. Data is relative to "now" and deterministic.
All endpoints are JSON, CORS-enabled, no auth. `BASE=http://localhost:3000`.

Provider ids: `motive | samsara | geotab | lytx | generic`. Fleet ids: `fleet_gulfcoast`, `fleet_goodyear`, `fleet_piedmont`, `fleet_bluegrass`, `fleet_summit`.

## The Incident object
```
{ id:"NX-10151", provider, providerEventId, fleetId, fleetName,
  eventType: collision|rollover|harsh_brake|harsh_accel|harsh_turn|speeding|distracted|following_distance|fault_code|breakdown|tire|battery|other,
  category: collision|safety|diagnostic|roadside,  severity: critical|high|medium|low,
  status: pending|validating|dispatched|en_route|on_scene|resolved|dismissed,
  timestamp, receivedAt, resolvedAt?,
  vehicle:{ id, unit, vin, year, make, model, plate, odometer_mi, engine, oem },
  driver:{ id, name, phone, safetyScore },
  location:{ lat, lng, address, speed_mph, heading, road },
  trail:[ {lat,lng,t,speed_mph} ],               // ~10 pts before, event pt, 3 after (30s spacing)
  camera:{ provider, verified, aiVerdict, confidence(0-1), signals:[str],
           clips:[{url,type:"road|driver",durationSec,vendorUrl,placeholder:true}], snapshots:[{url,type,vendorUrl,placeholder}] },
     // aiVerdict: confirmed_collision|false_positive|near_miss|distraction|confirmed_event|no_video.  camera is ALWAYS an object (no_video when no camera).
     // clip/snapshot urls are local placeholder SVG frames: /media/snap/<incidentId>/<road|driver>.svg (render with <img>, not <video>).
  diagnostics: null | { dtcs:[{code,desc,system,severity,spn?,fmi?,recommendedAction,partsHint,drivable,estCostUsd,warrantyCategory}],
                        drivable:"yes|limp|no", engineHours, faultLampOn },
  roadside:{ needed, serviceType: tow_heavy|tow_light|tire|jump_start|fuel|mobile_mechanic|none, rationale,
             recommendedProvider:{id,name,etaMin,distanceMi,phone,rating,city,st}|null, assignedProvider:{...}|null, etaMin, alternatives:[{...}] },
  warranty: null | { oem, vinDecoded:{vin,valid,checkDigitOk,make,model,year,engine,vehicleClass,...}, inWarranty, coverage:"powertrain|bumper_to_bumper|emissions|none",
             expiresAt, milesRemaining, claimEligible, claimId|null, reason, activeCoverages:[...], windows:{bumper_to_bumper|powertrain|emissions:{active,expiresAt,milesRemaining,termYears,termMiles,label}},
             claimPacket: null | { status:"draft|ready|submitted", summary, evidence:[str], estimatedValueUsd, laborParts:[{code,parts,estimateUsd}], towEstimateUsd } },
  risk:{ eventScore:0-100, tags:[...] },
  timeline:[ {t, actor:"system|dispatcher|fleet|provider", action, note} ],
  raw: <original vendor payload> }
```
Notes: false-positive camera verdicts (confidence >= 0.8) are auto-dismissed (`status:"dismissed"`, timeline `auto_dismissed`). `fault_code` events whose codes are non-drivable become `breakdown`. `warranty` is null only when the VIN can't be decoded.

## Ingest
**POST /webhook/:provider** - vendor payload -> normalize -> enrich -> save -> SSE. Optional HMAC-SHA256 of the raw body when `<PROVIDER>_WEBHOOK_SECRET` is set (header `x-<provider>-signature` or `x-webhook-signature`, value `sha256=<hex>`). 401 bad signature, 404 unknown provider, 400 empty body.
Response: `{received:true, incidentId, incident}`
```
curl -s $BASE/api/demo/sample/samsara > /tmp/p.json      # vendor-shaped sample (?kind=dtc for a fault payload)
curl -s -XPOST $BASE/webhook/samsara -H 'content-type: application/json' -d @/tmp/p.json
```
**GET /api/demo/sample/:provider?kind=collision|dtc** -> the vendor-shaped sample payload.

## Incidents
**GET /api/incidents?fleetId=&status=&category=&provider=&since=&limit=** (status may be comma list; default limit 100, max 1000; newest first by event timestamp) -> `{incidents:[Incident]}`
`curl "$BASE/api/incidents?fleetId=fleet_piedmont&status=pending,dispatched&limit=20"`

**GET /api/incidents/:id** -> Incident (404 `{error}`). **GET /api/incidents/:id/raw** -> `{id,provider,raw,clips,snapshots}`.

Mutations return the updated Incident, append to `timeline`, and push an SSE `incident` event:
- **POST /api/incidents/:id/dispatch** `{providerId?, note?, actor?}` -> sets `roadside.assignedProvider` (given provider, else recommended), `status:"dispatched"`.
  `curl -XPOST $BASE/api/incidents/NX-10151/dispatch -H 'content-type: application/json' -d '{"providerId":"prov_goodyear","note":"closest heavy"}'`
- **POST /api/incidents/:id/dismiss** `{reason, actor?}` -> `status:"dismissed"`.
- **POST /api/incidents/:id/status** `{status, note?, actor?}` (400 if invalid status; `resolved` sets `resolvedAt`).
- **POST /api/incidents/:id/notes** `{note, actor?}` (actor default `dispatcher`; use `fleet`/`provider`/`system` as needed).
- **POST /api/incidents/:id/warranty/submit** -> claimPacket.status = `submitted` (409 if no claim).

**GET /api/incidents/:id/warranty-packet** -> printable claim JSON:
`{claimId,status,eligible,generatedAt,oem,incident,claimant,vehicle,driver,location,coverage:{determination,type,reason,expiresAt,milesRemaining,windows},failure:[{code,description,system,severity,recommendedAction,parts,estimateUsd}],faultLampOn,drivable,summary,evidence[],media,estimate:{partsAndLaborUsd,towUsd,totalUsd,lines},timeline,attestation}`
Add `?format=html` for a print-styled page (open in a new tab). 404 if the VIN could not be decoded.

## Roadside providers
**GET /api/providers?lat=&lng=&service=&limit=** -> bare array sorted by distance: `[{id,name,city,st,lat,lng,heavy,services[],rating,phone,distanceMi,etaMin}]` (21 providers across AL/GA/FL/NC/SC/KY/TN/MS). `service` filters by capability (tow_heavy, tow_light, tire, jump_start, fuel, mobile_mechanic). Without lat/lng, distance/eta are null.
`curl "$BASE/api/providers?lat=31.32&lng=-85.85&service=tow_heavy&limit=3"`

## Fleets (fleet portal)
**GET /api/fleets** -> `[{id,name,vendor,vehicles,drivers,region,home,cameraCoveragePct}]`
**GET /api/fleets/:id/summary** -> `{fleet, kpis:{openIncidents,mttrMin,eventsLast30d,roadsideCalls,warrantyRecoveredUsd,warrantyPendingUsd,warrantyClaimsPending,safetyScore,cameraVerifiedPct}, trend:[{date,count}x30], byType:{eventType:n}, topDrivers:[driverRow x5 lowest score], bestDrivers:[...], vehicles:[{id,unit,plate,year,make,model,status:"ok|attention|incident",lat,lng,speed_mph,openDtcs,openIncidents,hasCamera,driverId}]}`
driverRow = `{id,name,vehicleId,safetyScore,events30d,collisions30d,topBehavior}`
**GET /api/fleets/:id/vehicles[?trail=1]** -> roster `[{id,unit,vin,plate,year,make,model,oem,engine,odometer_mi,hasCamera,driverId,position:{lat,lng,speed_mph,heading,road,city,status},trail?:[{lat,lng,t,speed_mph}]}]`
**GET /api/fleets/:id/drivers** -> `[driverRow]` (all drivers, 30d stats).
`curl $BASE/api/fleets/fleet_summit/summary`

## Insurer portal
**GET /api/insurer/portfolio** -> `{totals:{fleets,vehicles,events30d,lossRatioProxy,avgRiskScore,verifiedEventPct,falsePositivesFiltered,estLossUsd,vendors}, fleets:[{id,name,vendor,vehicles,riskScore,riskTier:"low|moderate|elevated|high",events30dPer100veh,collisionRate,topRiskFactors[str],trend:"up|down|flat",cameraCoveragePct,verifiedEventPct}], byVendor:[{vendor,fleets,vehicles,avgRisk}], distribution:{low,moderate,elevated,high}, portfolioAvgByComponent:{...}}`
Risk score 0-100 (higher = riskier): weighted components collisions 35%, harsh events 20%, speeding 15%, distraction 15%, maintenance/DTC 15%, from per-100-vehicle 30-day rates; camera-identified false positives excluded. Tiers: <30 low, <44 moderate, <60 elevated, else high.
**GET /api/insurer/fleets/:id** -> `{fleet, riskScore, riskTier, trend, weights, scoreBreakdown:[{key,label,score,weight,contribution,count,ratePer100Veh,portfolioRatePer100Veh,detail}], kpis, driversRanked:[driverRow], recentVerifiedIncidents:[{id,timestamp,eventType,severity,driver,vehicle,address,aiVerdict,confidence,signals,clip,snapshot,eventScore}], weeklyTrend:[{weekStart,events,collisions,avgEventRisk}], pricingSignal:{suggestedPremiumAdjustmentPct,direction,confidence,rationale[],estMonthlyPremiumUsd,estAdjustmentUsdPerMonth}, benchmark:{portfolioAvgRiskScore,riskScoreDelta,riskRank,of,metrics:[{key,label,fleet,portfolio,deltaPct,percentileLowerIsBetter}]}}`
`curl $BASE/api/insurer/fleets/fleet_piedmont`

## Live stream
**GET /api/stream[?fleetId=]** - `text/event-stream`. First `event: hello`; then `event: incident` with `data:` = the full Incident plus `_change:"new"|"update"`. Heartbeat comment every 15s.
`curl -N $BASE/api/stream`; browser: `new EventSource('/api/stream').addEventListener('incident', e => JSON.parse(e.data))`

## Demo controls
**POST /api/demo/simulate** `{scenario, fleetId?, vehicleId?, provider?}` - scenarios: `collision_camera`, `dtc_breakdown`, `warranty_failure`, `false_positive`, `random` (also: speeding, harsh_brake, harsh_turn, distracted, following_distance, tire, battery). Builds a vendor-shaped payload for the fleet's vendor and sends it through the real adapter. Returns `{scenario, provider, incident, payload}` (`payload` = the raw vendor JSON, handy for a "before/after normalization" view).
`curl -XPOST $BASE/api/demo/simulate -H 'content-type: application/json' -d '{"scenario":"collision_camera"}'`
**POST /api/demo/seed?reset=1** -> `{ok,fleets,incidents,skipped}` (without reset it is a no-op when data exists). **GET /api/demo/scenarios**.

## Misc
- **GET /health** -> `{status,service,version,demoMode,store,incidents,sseClients,timestamp}`
- **GET /api/config** -> `{mapsKey,mapboxToken,demoMode,providers}`
- **GET /media/snap/:incidentId/:road|driver.svg** - generated dashcam placeholder frame.
- Legacy: `GET /dashboard`, `POST /test/trigger-event` (fires a random scenario), `/api/debug/*`. Legacy pollers only start when `DEMO_MODE=0` or `ENABLE_LEGACY_POLLERS=1` and API keys are set.
- Static: everything in `public/` is served at `/` (`/dispatch/`, `/fleet/`, `/insurer/`).
