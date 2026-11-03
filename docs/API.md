# Nexus Response - Backend API (actual shapes)

Run: `npm install && npm start` (default port 3000, `PORT=3111 npm start` to change). In-memory store by default; set `DATABASE_URL` for Postgres (JSONB).
Boot seeds the demo (7 fleets, 287 vehicles, ~575 incidents over 90 days) unless `DEMO_MODE=0`. Data is relative to "now" and deterministic.
All endpoints are JSON, CORS-enabled, no auth. `BASE=http://localhost:3000`.

Provider ids: `motive | samsara | geotab | lytx | mantis | generic`. Fleet ids: `fleet_gulfcoast`, `fleet_goodyear`, `fleet_piedmont`, `fleet_bluegrass`, `fleet_summit`, `fleet_redline` (Mantis), `fleet_magnolia` (Mantis).

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
  raw: <original vendor payload>,
  // --- v2 context (null for dismissed false positives; see docs/INFERENCE.md) ---
  trip: { tripId, startedAt, startLocation:{lat,lng,address}, distanceMi, durationMin, idleMin,
          lastStop:{name,placeType,businessName,lat,lng,address,arrivedAt,departedAt,dwellMin,minutesBeforeIncident,milesSinceStop,contentHint},
          recentStops:[{name,placeType,arrivedAt,departedAt,dwellMin,businessName}],   // most recent first, [0] = lastStop
          timeline:[{t,kind:"drive|stop|idle|event",label}],
          telemetry:{ before:{avgEngineLoadPct,avgFuelMpg,avgSpeedMph,avgRpm,sampleCount}, after:{...}, deltaEngineLoadPct, deltaFuelMpg, series:[{t,engineLoadPct,fuelMpg,speedMph}] x60 } },
  equipment: { tractor:{class,make,model,year,engine,gvwrLb,tareLb,axles,fuelType},
               trailer:{attached,type,lengthFt,unitId,tareLb,maxPayloadLb,reefer:{setpointF,returnAirF,unitRunning,fuelPct}|null,detectedBy,cameraVerified,cameraBasis} },  // type "none" for vans/box trucks
  load: { estimatedWeightLb, weightRangeLb:[lo,hi], payloadPctOfMax, grossVehicleWeightLb, overweightRisk, method, confidence, basis:[str],
          contents:{category,label,examples,estimatedValueUsd:[lo,hi],hazmat,temperatureSensitive,spoilageRiskHours,confidence},
          cameraVisual:{cargoVisible,description,confidence}|null },
  warrantyDealer: null | { oem, coverage, nearest:{id,name,brand,type,address,lat,lng,distanceMi,driveEtaMin,phone,hours,open24x7,heavyDutyBays,hasPartsInStock}, alternates:[...], authorizationRequired, preAuthNumber|null, reason },
  roadside.towDestination?: { kind:"oem_dealer|nearest_shop|fleet_yard", name, address, lat, lng, distanceMi }
}
```
`risk.tags` additionally may include `hazmat_load`, `high_value_cargo`, `perishable_spoilage_clock`, `overweight_risk`, `shifting_load_risk`.
Notes: false-positive camera verdicts (confidence >= 0.8) are auto-dismissed (`status:"dismissed"`, timeline `auto_dismissed`). `fault_code` events whose codes are non-drivable become `breakdown`. `warranty` is null only when the VIN can't be decoded.

## Ingest
Providers: `motive|samsara|geotab|lytx|mantis|generic`. Auth: `x-nexus-key: nxk_live_...` (or `Authorization: Bearer ...`) and/or vendor HMAC (`x-<vendor>-signature: sha256=<hex>`). Optional in demo; `REQUIRE_AUTH=1` enforces. Status codes: 200 accepted/duplicate, 400 malformed JSON/empty body, 401 invalid/missing credentials, 403 key/provider mismatch, 404 unknown provider, 413 too large, 422 validation failed (`{error:"validation_failed", message, details[], logId}`), 429 rate limited (`Retry-After`), 500 processing failed (stored as dead letter, `logId`).
Idempotency: `(provider, providerEventId)`; a replay returns `{status:"duplicate", duplicate:true, incidentId}`. Events older than 24h in a batch are treated as backfill (no SSE, no alerts).
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

**GET /api/incidents/:id** -> Incident (404 `{error}`). **GET /api/incidents/:id/context** -> `{trip, equipment, load, warrantyDealer}` (same objects embedded in the incident; fields null when absent).
`curl $BASE/api/incidents/NX-10151/context`

**GET /api/incidents/:id/raw** -> `{id,provider,raw,clips,snapshots}`.

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

**POST /webhook/:provider/batch** - body `[event,...]` or `{"events":[...]}` (max 5000) -> `{received, batchId, accepted, duplicate, rejected, failed, results:[{index,status,incidentId?,error?,logId}]}`.
`curl -XPOST $BASE/webhook/samsara/batch -H 'x-nexus-key: nxk_live_...' -H 'content-type: application/json' -d @events.json`
**GET /api/ingest/log?fleetId=&status=&provider=&limit=** -> `{entries:[{id,receivedAt,provider,fleetId,status:"accepted|duplicate|rejected|failed",error,latencyMs,payloadBytes,incidentId,batchId,auth,statusCode,hasPayload,replayed}]}`; **GET /api/ingest/log/:id** adds `payload`/`rawBody` (dead letter).
**GET /api/ingest/health** -> `{generatedAt, integrations:[{fleetId,fleetName,provider,lastEventAt,events24h,errors24h,avgLatencyMs,status:"healthy|stale|failing|never_connected"}]}`
**POST /api/ingest/log/:id/replay** body `{payload?}` (optional corrected payload) -> `{replayOf,status,incidentId,error,logId,incident}`.

## Onboarding (new client fleets)
- **POST /api/onboarding/fleets** `{name, vendor:"motive|samsara|geotab|lytx|mantis|other", vehicles?, contactName, contactEmail, region?}` -> 201 `{fleet, apiKey (shown once), apiKeyInfo, webhookUrl, batchUrl, setupSteps:[str]}`; 422 with `details[]`.
- **GET /api/onboarding/fleets** (all fleets + keys metadata). **GET /api/onboarding/fleets/:id/checklist** -> `{fleetId,status:"demo|setup|live",percent,steps:[{key,label,done,doneAt}]}` (keys: account_created, api_key_issued, first_event_received, vehicles_mapped, history_imported, alerts_configured).
- **POST /api/onboarding/fleets/:id/test-event** `{eventType?}` -> `{status,incidentId,incident,payloadSent}` (goes through the real adapter, pushes SSE, flips fleet to `live`).
- **POST /api/onboarding/fleets/:id/rotate-key** -> `{apiKey}` (old keys revoked). **POST /api/onboarding/fleets/:id/vehicles** body JSON array, `{vehicles:[...]}` or `{csv:"unit,vin,plate,make,model,year,driver\n..."}` -> `{added,updated,vehicles,drivers,warnings[]}`. **PUT /api/onboarding/fleets/:id/alerts** `{emails,sms,minSeverity}`.
- Fleet objects from `/api/fleets` now include `onboarding:{status:"demo|setup|live",createdAt}`.

## Historical import (insurer assessment)
- **GET /api/import/templates/:vendor** (`motive|samsara|geotab|lytx|mantis|nexus|mileage`) -> `text/csv` sample; `?format=json` -> `{columns:[{column,mapsTo,description}],requiredFields,csv}`.
- **POST /api/import/preview** `{vendor, format:"csv|json", csv|data, mapping?}` -> `{vendor,detectedColumns,suggestedMapping,mapping,sample[5],warnings[],rows,kinds:{events,mileage,invalid}}`. `mapping` is `{nexusField: sourceColumn}`; fields: externalId,eventType,timestamp,date,vin,unit,plate,driver,lat,lng,speed,severity,address,video,dtc,miles,hours,odometer,followingDistance,drowsiness,phoneUse,seatbelt,aiClassification,aiConfidence,weight.
- **POST /api/import/jobs** `{fleetId | newFleet:{name,vendor,vehicles?,contactName?,contactEmail?}, vendor, format, csv|data, mapping?, purpose:"underwriting|onboarding"}` -> 202 `{job}`. Event rows and mileage rows (`vin,date,miles,hours`) can be in the same or separate jobs. Geotab speeds in km/h are converted.
- **GET /api/import/jobs/:id** -> `{id,status:"queued|running|completed|failed",progress,rowsTotal,rowsOk,rowsSkipped,errors[{row,message}],dataQuality:{dateRange,days,vehicles,drivers,fieldCoverage:{vin,driver,gps,speed,video,dtc,load},duplicates,mileageRows,milesTotal,qualityScore,notes[]},fleetId,assessmentId,...}`; **GET /api/import/jobs**; **DELETE /api/import/jobs/:id** removes its incidents.
- Data quality score = 20% VIN + 20% driver + 20% GPS + 10% speed + 10% video coverage + 15% parse rate + 5% history length (60d = full) - up to 10 for duplicates.
- Imported incidents have `source:"historical_import"`, `import:{jobId,row}`, status `resolved`; they never create SSE events, dispatch queues or roadside actions, and are hidden from the global `GET /api/incidents` unless `fleetId`/`source` is given or `includeImported=1`. Fleets created for underwriting (`purpose:"underwriting"`) are flagged `prospect` and excluded from the live insurer portfolio.

## Insurer assessments
- **POST /api/insurer/assessments** `{fleetId | jobId}` -> 201 assessment (also auto-created when an import job completes). **GET /api/insurer/assessments[?fleetId=]**, **GET /api/insurer/assessments/:id[?format=html]** (print view). **DELETE /api/insurer/assessments/:id** -> `{deleted,id,reportsDeleted}` (also deletes share-report tokens that point at it).
- **Low-confidence assessments**: if the history spans < 30 days or has < 15 real events, `lowConfidence`/`indicative` are `true`, `confidence` is capped at 0.35, and `pricing.suggestedPremiumAdjustmentPct` is damped toward 0 by the square of min(days/30, events/15) (never null; the undamped value is kept in `pricing.unclampedAdjustmentPct`; `pricing.indicative=true`, `lowConfidenceReasons[]` explain why). The list endpoint's `pricing` also carries `indicative`.
- **DELETE /api/onboarding/fleets/:id** removes an onboarded/imported (custom or prospect) fleet plus its incidents, assessments, reports, import jobs, API keys and alerts; seeded demo fleets return 409 `protected_fleet`.
- Shape: `{id,fleetId,fleetName,vendor,jobId,createdAt,window,events,vehicles,riskScore,riskTier,trend,confidence,dataQualityScore,dataQuality,eventsPerMillionMiles,exposure:{milesTotal,basis:"reported|estimated"},collisionRate,cameraCoveragePct,verifiedEventPct,scoreBreakdown[],topRiskFactors[],driverRiskDistribution:{low,moderate,elevated,high},unattributedEventsPct (top-level, 0-100; no longer inside driverRiskDistribution),lowConfidence,indicative,lowConfidenceReasons[],benchmark:{vsPortfolio:{portfolioAvgRiskScore,delta,percentileRiskier,peers},vsVendorPeers:{vendor,peerAvgRiskScore,delta,peers}},pricing:{suggestedPremiumAdjustmentPct,direction,baselineRiskScore,indicative,lowConfidence,confidenceLabel,unclampedAdjustmentPct?,lowConfidenceReasons?,rationale[]},projection (predict module's fleet projection when available, else a labeled fallback),preAccidentIndicators:[{key,severity,label,detail,driverId?}],recommendedPrograms:[{key,label,expectedRiskReductionPct,rationale}],limitations[]}`.

## New incident fields (v3)
`signals:[{key,label,value,unit,triggered}]` on every incident (rich driver/road-facing keys for Mantis). Mantis incidents: `provider:"mantis"`, `camera.verified/aiVerdict/confidence` taken from Mantis' own AI. Seed: 7 fleets (adds `fleet_redline`, `fleet_magnolia` on Mantis), 90 days of history, `timeline` action `coaching` on handled safety events. SSE: other modules may emit extra named events (e.g. `event: alert`) via `stream.publishEvent`.

## Dispatch operations (ADDENDUM v4) - everything outbound is SIMULATED
Phones are fictional `+1-xxx-555-01xx`; carriers, agencies and OEM portals are invented and labelled "(simulated)". Comms `status` is `"delivered (simulated)"` (also `simulated:true`). New timeline actors/actions: `actor:"oem"`, actions `notified_fleet_manager|notified_driver|notified_tow|notified_insurer|notified_authority|notified_cargo_owner|notified_oem`, `eta_shared`, `fnol_sent`, `job_link_sent`, `sop_step`, `warranty_under_review|warranty_approved|warranty_denied|warranty_more_info_needed|warranty_paid`, `provider_declined`, `eta_updated`; timeline entries may carry `meta`.
- **GET /api/incidents/:id/contacts** -> `{fleetManagers:[{name,phone,email,role}], driver:{id,name,phone,email,vehicle}, insurer:{carrier,policyNo,fnolLine,portal}, oem:{name,brand,warrantyDesk,portal,email,hours}, towProviders:[{id,name,phone,etaMin,rating,assigned}], authorities:[{agency,kind:"state_patrol|county_sheriff|ems|fire|dot|hazmat_response",phone,jurisdiction,recommended,urgency:"now|soon|no",reason}], cargoOwner:{name,phone,email}|null, dispatchCallback, simulated}`. Fleet-level: **GET /api/fleets/:id/contacts**.
- **POST /api/incidents/:id/notify** `{channel:"sms|email|call|push", to:{type:"fleet_manager|driver|tow|insurer|authority|cargo_owner|oem", id?, name?, phone?, email?}, template?, message?, subject?, outcome?, actor}` -> `{id,at,incidentId,fleetId,channel,to,subject,body,status:"delivered (simulated)",actor,template,outcome, incident}`; blank `to` fields are resolved from contacts (authority `id` may be a kind like `hazmat_response`). 422 on bad channel/missing template+message. **GET /api/incidents/:id/comms** -> `{comms:[...]}` (oldest first). **GET /api/comms?fleetId=&channel=&toType=&limit=** -> `{comms:[...]}` newest first (fleet inbox feed).
- **GET /api/comms/templates?kind=fleet_manager|driver|tow|insurer|authority|cargo_owner[&incidentId=]** -> `[{key,kind,label,channel,subject,body,variables[],edited, renderedSubject?, renderedBody?}]` (rendered when `incidentId` given). **PUT /api/comms/templates/:key** `{subject?,body}` edits; **DELETE** resets. Template keys: fm_incident_sms, fm_incident_email, fm_eta_update, driver_check_in, driver_eta, driver_breakdown, tow_dispatch, tow_call_script, insurer_fnol, insurer_update, authority_call, cargo_delay, cargo_perishable.
- **GET /api/incidents/:id/authority-brief** -> `{recommended:[{agency,kind,reason,urgency}], needsAuthorities, script, location:{lat,lng,address,road,direction,city,state,nearestMileMarker:null,crossStreet:null}, facts[], hazmat:{present,notes}|null, authorities[], simulated}`.
- **GET /api/incidents/:id/sop** -> `{kind:"collision|hazmat|breakdown|warranty|false_positive|safety", steps:[{key,label,required,done,doneAt,doneBy,hint,autoCompletedBy?,manual?}], percent, requiredDone, requiredTotal}`. Steps auto-complete from logged actions (camera_verified, dtc_decoded, dispatched, notified_*, eta_shared, fnol_sent, warranty_submitted, status resolved...). **POST /api/incidents/:id/sop/:stepKey** `{done,actor,note}` -> checklist (manual override; `done:false` reopens an auto-completed step).
- **POST /api/incidents/:id/dispatch** now also returns `jobLink:{token,url:"/job/<token>"}` (on the incident) and texts the link to the provider (simulated; `tow_dispatch` comms + `job_link_sent`).
- **Public tow job ticket (no auth, 7-day link):** **GET /api/jobs/:token** -> `{token,status:"sent|accepted|declined|arrived|completed",incidentId,provider,summary,serviceType,location:{lat,lng,address,road,direction,navUrl},vehicle,trailer,load:{weightClass,estimatedWeightLb,contents,confidence}|null,hazards[],dropoff:{kind,name,address,lat,lng,distanceMi}|null,contact:{dispatcher,driver,fleet},notes[],etaMin,events[],actions[],incidentStatus,expiresAt,simulated}`. **POST /api/jobs/:token/accept|decline|eta|arrived|complete** `{etaMin?,note?}` (`eta` requires etaMin 1-1440) -> updated ticket; updates the incident (accept -> `en_route`, arrived -> `on_scene`, complete -> `resolved`, decline -> `pending` and clears the assigned provider), timeline (actor `provider`) and SSE. 404 unknown, 410 expired, 409 closed job.
- **POST /api/incidents/:id/fnol** `{actor?,note?}` -> `{claimRef:"FNOL-...",carrier,policyNo,submittedAt,status:"received (simulated)",attached[],alreadySent}`; idempotent (201 first time, 200 afterwards). **GET /api/incidents/:id/fnol**.
- **OEM warranty claims (idempotent one-click):** **POST /api/incidents/:id/warranty/submit** `{actor?}` -> `{status:"submitted",claimStatus,confirmation:"WC-...",submittedTo:"<OEM portal> (simulated)",submittedAt,packetUrl,estimatedValueUsd,claimNumber,preAuthNumber,oemDesk,alreadySubmitted,simulated,incident}` (409 when not eligible). **NOTE:** the response is no longer the bare incident; the incident is under `incident`. **POST /api/fleets/:id/warranty/submit-ready** -> `{submitted,totalValueUsd,results[{incidentId,confirmation,claimNumber,estimatedValueUsd}]}` (only `ready` claims; safe to repeat).
  - Lifecycle on `warranty.claimPacket.status`: `draft -> ready -> submitted -> under_review -> approved | denied | more_info_needed -> (more_info_needed/denied -> under_review) ; approved -> paid`. New claimPacket fields: `claimNumber, preAuthNumber, oemDesk:{oem,name,warrantyDesk,portal,email,hours}, history:[{t,status,by,note}], submittedAt, submittedTo, approvedAmountUsd, paidAmountUsd, paidAt, paymentRef, denialReason, requestedInfo, oemResponse`.
  - **GET /api/incidents/:id/warranty/claim** -> lifecycle summary + `nextStatuses`, `nextActions`. **POST /api/incidents/:id/warranty/status** `{status, note?, actor?}` sets a status (409 `{allowed}` on illegal transitions) or `{simulate:true, outcome?:"approved|denied|more_info_needed"}` advances one step as the OEM desk would (the "simulate OEM response" action; deterministic ~78% approve / 14% more info / 8% deny when no outcome is given). Seed has claims in ready / under_review / more_info_needed / submitted / paid.

## Nexus Drive Score and occasional-user surfaces (insurer)
- **GET /api/insurer/drivers?fleetId=&limit=&order=best|worst** (default worst first) -> `[{driverId,name,fleetId,fleetName,vehicle,driveScore:0-100,band:"excellent|good|fair|poor",components:{followingDistance,braking,acceleration,cornering,speeding,distraction,fatigue,nightDriving,collisionHistory},trend30d,milesLast30d:null,events30d,collisions90d,cameraVerifiedPct,topIssue}]`. Higher is better. Each component = 100 - penalty x events in 30d (collision history over 90d); weights follow 14/12/6/6/14/16/10/6/16 percent.
- **GET /api/insurer/fleets/:id/usage-based** -> `{fleetId,fleetName,vendor,carrier,policyNo,policyPeriod:{start,end},driveScore,band,trend30d,scoreHistory:[{date,score}x9 weekly],pricing:{basePremiumUsd,currentAdjustmentPct,projectedRenewalAdjustmentPct,monthlyAdjustmentUsd,portfolioBaselineRisk,note},whatChanged30d:[{key,label,deltaPts,direction,now,before}],topImprovementLevers:[{key,label,area,potentialPts,potentialSavingsUsd}],drivers:{best[5],worst[5]},driverCount}`. Fleet drive score = 100 - 0.85 x risk score; adjustment = 0.4%/pt vs portfolio baseline (illustrative, not a rate filing); renewal projection uses the predict module's 90-day risk when available.
- **GET /api/insurer/digest?carrier=&period=daily|weekly|monthly** -> exceptions only: `{period,periodLabel,generatedAt,carrier,fleetsReviewed,headline,fleetsNeedingAttention:[{fleetId,name,why,severity,riskScore,riskTier}],newHighSeverity:[{incidentId,fleetId,fleetName,eventType,severity,timestamp,summary,cameraVerified,status}],notableImprovements:[{fleetId,name,detail}],claimsOpened,fnolsSent,recommendedActions[]}`. `carrier` = carrier id (`car_harbor|car_keystone|car_bayou`) or name fragment; each seeded fleet belongs to one carrier (`/contacts` shows it).
- **POST /api/insurer/reports** `{kind:"fleet|assessment|incident|digest", refId}` (digest: refId = optional carrier, `period`) -> 201 `{token,url:"/report/<token>",apiUrl,title,kind,expiresAt}`; **GET /api/reports/:token** (public, read-only, 30 days, no auth) -> `{token,kind,title,createdAt,expiresAt,readOnly:true,data}` (a frozen snapshot; phone numbers, emails and raw vendor payloads are stripped server-side: contact keys are omitted and phone-like text in notes becomes `[phone removed]`); 404 unknown/revoked, 410 expired. **GET /api/insurer/reports?fleetId=&kind=** lists metadata, **DELETE /api/insurer/reports/:token** revokes.
- Static pages: `/job/<token>` and `/report/<token>` serve `public/job/index.html` / `public/report/index.html` when present.


## Roadside providers
**GET /api/providers?lat=&lng=&service=&limit=** -> bare array sorted by distance: `[{id,name,city,st,lat,lng,heavy,services[],rating,phone,distanceMi,etaMin}]` (21 providers across AL/GA/FL/NC/SC/KY/TN/MS). `service` filters by capability (tow_heavy, tow_light, tire, jump_start, fuel, mobile_mechanic). Without lat/lng, distance/eta are null.
`curl "$BASE/api/providers?lat=31.32&lng=-85.85&service=tow_heavy&limit=3"`

## Dealers and places
**GET /api/dealers?oem=&lat=&lng=&limit=&heavy=1** -> bare array of OEM dealers/service centers (144; Freightliner, Peterbilt, Kenworth, Volvo, International, Mack, Ford, Mercedes-Benz; AL/FL/GA/NC/SC/KY/TN/MS/LA) sorted by distance: `[{id,name,brand,type:"dealer|service_center|mobile_service",address,lat,lng,phone,hours,open24x7,heavyDutyBays,hasPartsInStock,distanceMi,driveEtaMin}]`.
`curl "$BASE/api/dealers?oem=Volvo&lat=33.8&lng=-84.4&limit=3"`
**GET /api/places?lat=&lng=&radiusMi=&type=** -> bare array of known business stops (70 invented businesses): `[{id,name,businessName,placeType,city,st,lat,lng,address,contentHint,distanceMi}]`.

## Fleets (fleet portal)
**GET /api/fleets** -> `[{id,name,vendor,vehicles,drivers,region,home,cameraCoveragePct}]`
**GET /api/fleets/:id/summary** -> `{fleet, kpis:{cargoAtRiskUsd,incidentsWithLoadContext,openIncidents,mttrMin,eventsLast30d,roadsideCalls,warrantyRecoveredUsd,warrantyPendingUsd,warrantyClaimsPending,safetyScore,cameraVerifiedPct}, trend:[{date,count}x30], byType:{eventType:n}, byContent:{category:n}, topDrivers:[driverRow x5 lowest score], bestDrivers:[...], vehicles:[{id,unit,plate,year,make,model,status:"ok|attention|incident",lat,lng,speed_mph,openDtcs,openIncidents,hasCamera,driverId}]}`
driverRow = `{id,name,vehicleId,safetyScore,events30d,collisions30d,topBehavior}`
**GET /api/fleets/:id/vehicles[?trail=1]** -> roster `[{id,unit,vin,plate,year,make,model,oem,engine,odometer_mi,hasCamera,driverId,position:{lat,lng,speed_mph,heading,road,city,status},trail?:[{lat,lng,t,speed_mph}]}]`
**GET /api/fleets/:id/drivers** -> `[driverRow]` (all drivers, 30d stats).
`curl $BASE/api/fleets/fleet_summit/summary`

## Insurer portal
**GET /api/insurer/portfolio** -> `{totals:{fleets,vehicles,events30d,lossRatioProxy,avgRiskScore,verifiedEventPct,falsePositivesFiltered,estLossUsd,vendors}, fleets:[{id,name,vendor,vehicles,riskScore,riskTier:"low|moderate|elevated|high",events30dPer100veh,collisionRate,topRiskFactors[str],trend:"up|down|flat",cameraCoveragePct,verifiedEventPct,avgLoadPctOfMax,cargoExposureUsd}], byVendor:[{vendor,fleets,vehicles,avgRisk}], distribution:{low,moderate,elevated,high}, portfolioAvgByComponent:{...}}`
Risk score 0-100 (higher = riskier): weighted components collisions 35%, harsh events 20%, speeding 15%, distraction 15%, maintenance/DTC 15%, from per-100-vehicle 30-day rates; camera-identified false positives excluded. Tiers: <35 low, <50 moderate, <68 elevated, else high.
**GET /api/insurer/fleets/:id** -> `{fleet, riskScore, riskTier, trend, weights, scoreBreakdown:[{key,label,score,weight,contribution,count,ratePer100Veh,portfolioRatePer100Veh,detail}], kpis, driversRanked:[driverRow], recentVerifiedIncidents:[{id,timestamp,eventType,severity,driver,vehicle,address,aiVerdict,confidence,signals,clip,snapshot,eventScore}], weeklyTrend:[{weekStart,events,collisions,avgEventRisk}], cargoExposure:{avgLoadLb,avgLoadPctOfMax,byContent:[{category,incidents,estValueUsd}],hazmatEvents,perishableEvents,highValueEvents,overweightEvents,incidentsWithLoadContext,totalEstCargoExposureUsd}, pricingSignal:{suggestedPremiumAdjustmentPct,direction,confidence,rationale[],estMonthlyPremiumUsd,estAdjustmentUsdPerMonth}, benchmark:{portfolioAvgRiskScore,riskScoreDelta,riskRank,of,metrics:[{key,label,fleet,portfolio,deltaPct,percentileLowerIsBetter}]}}`
`curl $BASE/api/insurer/fleets/fleet_piedmont`

## Live stream
**GET /api/stream[?fleetId=]** - `text/event-stream`. First `event: hello`; then `event: incident` with `data:` = the full Incident plus `_change:"new"|"update"`. Heartbeat comment every 15s.
`curl -N $BASE/api/stream`; browser: `new EventSource('/api/stream').addEventListener('incident', e => JSON.parse(e.data))`

## Demo controls
**POST /api/demo/simulate** `{scenario, fleetId?, vehicleId?, provider?}` - scenarios: `collision_camera`, `dtc_breakdown`, `warranty_failure`, `false_positive`, `reefer_collision` (reefer after a food distributor, camera-verified box, ~38-44k lb perishable), `flatbed_steel_collision` (camera sees steel coils, ~42k lb), `warranty_dealer_breakdown` (in-warranty Freightliner/Volvo fault => nearest OEM dealer + `towDestination`), `hazmat_tanker_rollover` (critical rollover, fuel tanker, `hazmat_load`), `random` (also: speeding, harsh_brake, harsh_turn, distracted, following_distance, tire, battery). Builds a vendor-shaped payload for the fleet's vendor and sends it through the real adapter. Returns `{scenario, provider, incident, payload}` (`payload` = the raw vendor JSON, handy for a "before/after normalization" view).
`curl -XPOST $BASE/api/demo/simulate -H 'content-type: application/json' -d '{"scenario":"collision_camera"}'`
**POST /api/demo/seed?reset=1** -> `{ok,fleets,incidents,skipped}` (without reset it is a no-op when data exists). **GET /api/demo/scenarios**.

### Demo reset, state, guided scenario, capability matrix (defensibility endpoints)
All data is synthetic; every outbound action is simulated.

- **POST /api/demo/reset** -> `{ok,resetAt,seeded,predict,counts,note}`. Restores the in-memory store to the deterministic seeded state: drops custom/prospect fleets, all incidents (imports included), comms, jobs, reports, assessments, import jobs, ingest log, API keys/tokens, predictive alerts and caches; reseeds; rebuilds predictive state; broadcasts SSE `event: reset` `{resetAt,counts}` (clients should reload). Gate: allowed when `DEMO_MODE=1`, or `DEMO_MODE` unset with `NODE_ENV!=production`; **403 `reset_disabled`** when `DEMO_MODE=0`, when `NODE_ENV=production` without `DEMO_MODE=1`, or whenever `DATABASE_URL` is set (override only with `ALLOW_DEMO_RESET_ON_DATABASE=1`).
- **GET /api/demo/state** -> `{bootAt,resetAt,resets,mantisScenariosCreated,resetEnabled,resetDisabledReason,store,counts{fleets,customFleets,vehicles,drivers,incidents,importedIncidents,demoScenarioIncidents,comms,jobs,reports,assessments,importJobs,ingestLog,apiKeys,predictiveAlerts,sseClients},data:"synthetic",simulated:true}`. `resetAt` is `null` until the first reset.
- **POST /api/demo/mantis-scenario** `{fleetId?: fleet_redline|fleet_magnolia}` -> 201 `{incidentId,demoTag,synthetic,simulated,payloadAssumed,illustrative,label,fleet,vehicle,driver,event{signals,camera},deepLinks{dispatch:"/dispatch/#<id>",fleet,insurerFleet,insurerProjection,api,predictFleet},recommendedResponse{priority,actions[],rationale[],disclaimer}}`. Each call creates a NEW incident through the Mantis adapter (phone use, eyes-off-road 3.6 s, following distance 0.8 s, forward-collision warning, camera AI verdict `distraction`), stored with `incident.demo = {tag,synthetic:true,scenario,payloadAssumed:true,label}` and a `demo_scenario` timeline entry. Without `fleetId` it alternates between the two Mantis fleets. The Mantis payload shape is ASSUMED (docs/MANTIS.md).
- **GET /api/capabilities** -> `{generatedAt,statuses{},honesty[],total,counts{},capabilities:[{id,area,name,status,evidence,notes,simulated?,illustrative?,assumedPayload?}]}`; currently `total` = 35 entries (7 working_verified, 16 working_synthetic, 7 simulated, 5 planned; the endpoint's `total`/`counts` are authoritative; an earlier note of 36 was a miscount); `status` is one of `working_verified` (exercised end to end; `scripts/check-consistency.js` does it), `working_synthetic`, `simulated`, `planned`.

**Simulated markers.** Outbound action responses (`/dispatch`, `/notify`, `/fnol`, `/warranty/submit`, `/warranty/status`, `/fleets/:id/warranty/submit-ready`, `/authority-brief`, `/fleets/:id/contacts`, job tickets) include `simulated:true` and `deliveredTo:"no external recipient"`; comms log rows carry the same fields. The dispatch timeline entry says "(simulated: no provider is actually contacted)".

**Predictive payload labeling.** `/api/predict/{portfolio,backtest,fleet/:id,model,simulate-what-if}` responses include `illustrative:true`, `label`, `disclaimer` and `provenance{data:"synthetic",validated:false,method,assumptions[],limitations[]}`; alert rows carry `illustrative,label,disclaimer`; all `/api/predict/*` responses set header `X-Nexus-Data: synthetic-illustrative`. `portfolio.comparison` (Mantis vs all other vendors pooled) and `byVendor[]` come from one calculation (docs/PREDICT.md section 7). Insurer `GET /api/insurer/portfolio` `byVendor[].basis` states that its `avgRisk` is the event-based score (unweighted fleet mean), a different metric from predict's vehicle-weighted predicted risk.

**Consistency check.** `node scripts/check-consistency.js` (spawns its own server with `DEMO_MODE=1`, or `BASE_URL=http://host:port`; NOTE it calls `POST /api/demo/reset` on the target).

## Misc
- **GET /health** -> `{status,service,version,demoMode,store,incidents,sseClients,timestamp}`
- **GET /api/config** -> `{mapsKey,mapboxToken,demoMode,providers}`
- **GET /media/snap/:incidentId/:road|driver.svg** - generated dashcam placeholder frame.
- Legacy: `GET /dashboard`, `POST /test/trigger-event` (fires a random scenario) and `/api/debug/*` (these call third-party APIs with server-held keys): **404 unless `ENABLE_DEBUG=1`** (default off). Legacy pollers only start when `DEMO_MODE=0` or `ENABLE_LEGACY_POLLERS=1` and API keys are set.
- Static: everything in `public/` is served at `/` (`/dispatch/`, `/fleet/`, `/insurer/`).

- Onboarding alert recipients (`PUT /api/onboarding/fleets/:id/alerts`): stored only. The response carries `used:false, status:"stored_not_used"` and a note; notifications in this build are simulated and never read this list.
- Predict determinism: all predictive windows are anchored to the newest live event (rounded up to the hour), not wall-clock time, so `/api/predict/*` figures are identical across calls for the same store state (`generatedAt`/`computeMs` excepted).
