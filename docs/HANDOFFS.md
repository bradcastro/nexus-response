# Handoffs (append-only)

## [brand -> dispatch, fleet, insurer] Using brand.css / brand.js
Status: DONE (stable names; do not rename. Request additions here.)

**Include** (in `<head>`; script in head so saved theme applies before paint):
```html
<link rel="icon" href="/shared/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/shared/brand.css">
<script src="/shared/brand.js"></script>
```
Dark is default. Fleet/insurer: call `NX.theme.defaultTo('light')` once (user's saved choice still wins).

**Shell markup**
```html
<div class="nx-app">                     <!-- add .nx-app--nosidebar for no sidebar, .nx-app--fill for 100vh app -->
  <div id="nx-topbar"></div>             <!-- replaced by NX.topbar() -->
  <aside class="nx-sidebar">
    <div class="nx-eyebrow nx-sidebar__label">Queues</div>
    <button class="nx-nav is-active">Open <span class="nx-nav__count">12</span></button>
  </aside>
  <main class="nx-main">                 <!-- .nx-main--flush for edge-to-edge (maps) -->
    <div class="nx-page-head"><div><h1>Title</h1><p>sub</p></div></div>
    <div class="nx-kpis"><div class="nx-kpi nx-kpi--accent"><div class="nx-kpi__label">Open</div><div class="nx-kpi__value">12</div><div class="nx-kpi__delta is-down">-3 vs yday</div></div></div>
  </main>
</div>
<script>NX.topbar('Dispatch');</script>  <!-- 'Dispatch' | 'Fleet' | 'Insurer'; opts {sidebar,live,right:[nodes],mount} -->
```

**JS (window.NX)**: `theme.get/set/toggle/defaultTo`, `el(tag.class#id, attrs, ...children)`, `esc`, `fmt.{ago,number,compact,currency,pct,date,time,dateTime,duration,label}`, `badge(value[,variant])` (element; `badgeHTML` string; works for severity, status, or any label with variant ok|warn|info|danger|accent|plain), `sevColor(sev[,resolved])` / `statusColor` (CSS `var()` string; pass `true` for the computed hex, needed for canvas/Leaflet), `toast(msg,type[,ms])` (info|success|error|warn|critical), `api(path,{method,body,query,toast})` (JSON; throws Error with `.status`), `sse(url,fn(data,type),{events:['incident'],onStatus})` returns `{close}` and drives the topbar live dot (`NX.setLive('live'|'reconnecting'|'off')`), `tabs(rootEl)`, `modal(title,body,{footer,wide})`, `skeleton(n)`, `empty(title,text)`, `severities`, `statuses`.

**Component classes**
- Layout: `nx-app nx-topbar nx-sidebar nx-nav(.is-active) nx-main nx-page-head nx-grid(--2|--3|--4) nx-row nx-stack nx-grow nx-bg-grid`
- Surfaces: `nx-card(__head,__title,__body,__foot,--flush,--interactive,--alert)`, `nx-kpis`, `nx-kpi(__label,__value,__delta,--accent|--critical|--ok)`, `nx-kv` (dl)
- Badges: `nx-badge--critical|high|medium|low|pending|validating|dispatched|en_route|on_scene|resolved|dismissed|ok|warn|info|danger|accent|plain`
- Buttons: `nx-btn` + `--primary|--ghost|--danger|--sm|--lg|--block`, `.is-loading`; `nx-icon-btn`; form: `nx-input nx-select nx-textarea nx-label`
- Table: `nx-table-wrap > table.nx-table` (`td.num`, `td.id`, `tr.is-selected`, `tr[data-click]`, add `.nx-new` to a fresh row to flash)
- `nx-chips > nx-chip(.is-active)`, `nx-timeline > li.nx-timeline__item.is-system|dispatcher|fleet|provider(.is-latest) {__time,__action,__note}`, `nx-tabs > nx-tab(.is-active)` + `nx-tabpanel[data-panel]`
- Feedback: `nx-modal-backdrop > nx-modal(__head,__body,__foot)`, `nx-toasts/nx-toast`, `nx-empty`, `nx-skel(--lg|--block)`, `nx-meter > i[style=width:%;--c:color]`, `nx-live` + `nx-live-dot(--off|--warn)`, `nx-pulse-critical`
- Text: `nx-eyebrow nx-mono nx-num nx-dim nx-faint nx-sr nx-hide`; fonts `--nx-font-ui|display|mono`
- Tokens: all colors via `var(--nx-*)`; never hard-code hex so both themes work. Print: `.nx-no-print` hides elements.

**Contract notes**: launcher links to `/dispatch/#<incidentId>` after a simulated event; dispatch should open that incident if the hash is present. Launcher expects `POST /api/demo/simulate` to return the incident (or `{incident}`) with `id, severity, status, provider`; anything else is shown as raw JSON. Launcher pings `/health` for the live dot.

## [insurer -> backend] Insurer API response shapes the portal reads
Status: DONE (superseded by follow-up entry below)
The insurer portal (`public/insurer/`) codes to ARCHITECTURE.md and is tolerant of key aliases, but this is exactly what it reads. Please match, or tell me where you differ.
- `GET /api/insurer/portfolio`: `totals{fleets,vehicles,events30d,lossRatioProxy}`; `fleets[]` each `{id,name,vendor,region?,vehicles,riskScore (0-100, higher = riskier),riskTier (e.g. low|moderate|elevated|high|severe),events30dPer100veh,collisionRate (percent, e.g. 3.1 not 0.031),cameraCoveragePct (0-100),verifiedEventPct (0-100),trend:"up|down|flat" (up = risk rising),topRiskFactors:[string]}`; `byVendor[{vendor,fleets,avgRisk}]`; `distribution` as `{tierName:count}`. Optional: per-fleet `events30d`; top-level `claims:{total,verified,unverified,falsePositive,evidencePackets,timeToFirstNoticeSec}` (otherwise the portal derives it from `/api/incidents?limit=500`).
- `GET /api/insurer/fleets/:id`: fleet fields at top level or under `fleet` (`drivers` under `fleet` should be a number); `scoreBreakdown` as `{speeding,harsh,collisions,distraction,maintenance}` each 0-100 (or `{value,portfolioAvg}`); `benchmark{riskScore,events30dPer100veh,collisionRate,cameraCoveragePct,verifiedEventPct}` = portfolio averages; `drivers[{name,riskScore,events,topFactors[]}]` ranked; `recentIncidents[]` canonical Incident objects with `camera`; `suggestedPremiumAdjustmentPct` (number, +surcharge / -credit) and `pricing.rationale` (string or string[]); `improvements[{action,estimatedScoreGain,detail?}]`.
Acceptance: `/insurer/` renders all sections with no "—" placeholders in the policyholder table or deep dive.

## [dispatch -> backend] Shapes the Dispatch console reads
Status: DONE (verified against live backend on :3000; all shapes match docs/API.md. Dispatch adapted: bare-array providers, svg clip urls rendered as <img>, camera.aiVerdict no_video treated as no camera. No remaining gaps.)
Dispatch codes to ARCHITECTURE.md; it tolerates `[...]` or `{incidents:[...]}` for lists/providers, and an incident or `{incident}` from POST actions. Please confirm:
- `GET /api/incidents` returns FULL incidents (trail, camera, diagnostics, roadside, warranty, timeline); list view uses `location`, `vehicle.unit|plate`, `driver.name`, `camera`, `diagnostics.dtcs`, `roadside`, `warranty.claimEligible`. Add `vehicle.unit` (fleet unit number) if available.
- `GET /api/providers?lat&lng` items: `{id,name,lat,lng,etaMin,distanceMi,services:[...]}` (lat/lng needed to draw provider markers + route line).
- `/dispatch` should set `status:'dispatched'` and `roadside.assignedProvider`; `/dismiss` and `/status` return the updated incident and also push on `/api/stream` (`event: incident`).
- Camera clips/snapshots: use `url:null` (not `{}`) when no media; real URLs render in `<video>/<img>`.
- `GET /api/incidents/:id/warranty-packet?format=html` opens in a new tab from the Warranty panel.
Acceptance: select any seeded incident in /dispatch/ and all six panels populate; simulate `collision_camera` shows a critical alert.

## [backend -> dispatch, fleet, insurer, brand] Backend is live - read docs/API.md
status: DONE
- Run: `cd "Nexus Response" && npm install && PORT=3000 npm start` (in-memory, auto-seeds 5 fleets / 212 vehicles / ~150 incidents; `DEMO_MODE=0` to start empty). Exact response shapes + a curl per endpoint are in `docs/API.md`.
- **dispatch**: poll `GET /api/incidents?status=pending,dispatched,en_route,on_scene` and listen to `GET /api/stream` (`event: incident`, payload = full Incident + `_change:"new"|"update"`). Actions: `POST /api/incidents/:id/dispatch|dismiss|status|notes`. Headline demo button: `POST /api/demo/simulate {"scenario":"collision_camera"}` (also `dtc_breakdown`, `warranty_failure`, `false_positive`, `random`); the response includes the raw vendor `payload` for a before/after normalization panel. `GET /api/providers?lat=&lng=&service=` returns a BARE ARRAY.
- **camera media**: clips/snapshots are generated placeholder SVG frames (`/media/snap/<id>/road.svg`, `.../driver.svg`) - render with `<img>`, not `<video>`. `camera` is always an object (`aiVerdict:"no_video"` when no camera). False positives >=80% confidence arrive already `dismissed` (timeline entry `auto_dismissed`) - show them in a "filtered by AI" view.
- **fleet**: `GET /api/fleets`, `/api/fleets/:id/summary` (kpis, 30-day trend, byType, topDrivers/bestDrivers, vehicles with lat/lng), `/api/fleets/:id/vehicles?trail=1`, `/api/fleets/:id/drivers`. Warranty: `GET /api/incidents/:id/warranty-packet` (JSON) or `?format=html` (print view, open in a new tab); `POST /api/incidents/:id/warranty/submit` marks the claim submitted. Pass `?fleetId=` on `/api/incidents` and `/api/stream`.
- **insurer**: `GET /api/insurer/portfolio` and `/api/insurer/fleets/:id` (scoreBreakdown, pricingSignal, benchmark, driversRanked, recentVerifiedIncidents, weeklyTrend). Tiers: low/moderate/elevated/high (Elite low, Bluegrass/Summit moderate, Gulf Coast elevated, Piedmont high at seed time).
- **brand**: backend does not write to `public/`. If `public/index.html` is missing, `/` shows a tiny fallback page. Demo-launcher idea: buttons that call `/api/demo/simulate` so a presenter can fire events live.
- Known: legacy `dashboard.html` expects the old flat incident shape and will only partly render against the new canonical shape (legacy only).

## [fleet -> backend] Seed data for the default fleet (Gulf Coast Freight)
Status: DONE (every fleet now has 3-4 seeded claims: paid/submitted/ready; 2-3 vehicles with open DTC incidents; recovered $ counts paid/approved; submitted counts as pending)
The fleet portal defaults to the first fleet in `/api/fleets` (Gulf Coast Freight). In the current seed it has 0 warranty-eligible incidents (Warranty tab empty, `warrantyRecoveredUsd` 0) and every vehicle has `openDtcs: 0`, so the DTC badges on the map and the "Open trouble codes" vehicle filter are empty for most fleets. Nice-to-have: seed 2-4 warranty claims (mix of ready/submitted/paid, one paid so recovered > 0) and 2-3 vehicles with openDtcs > 0 and an unresolved `diagnostics` incident for each fleet, especially Gulf Coast. Also: `claimPacket.status` of `paid`/`approved` is supported by the portal; `warrantyRecoveredUsd` should count those.
Acceptance: `/fleet/?fleet=fleet_gulfcoast` shows non-empty Warranty tab and at least one amber DTC pin with a count badge on the map.

## [fleet -> brand] FYI only
Status: DONE
Fleet portal needs no brand changes. Used: nx-kpis, nx-card, nx-table, nx-chip, nx-timeline, nx-meter, badges, NX.sse/api/topbar. Local styles live in public/fleet/fleet.css (drawer, map pins, chart).

## [insurer -> backend] Insurer API response shapes (follow-up)
Status: DONE. Verified against live backend (docs/API.md shapes); insurer portal now reads the real shapes with no placeholders. Remaining notes (optional, no action required): portfolio `topRiskFactors` are long sentences (portal shows the text before ":" as a chip and the full text as a tooltip); `claims` totals (time-to-first-notice, evidence packets) are derived client-side from `/api/incidents`.

## [dispatch -> backend] Tow-to-dealer action (ADDENDUM v2)
Status: DONE (backend-ingest: dispatch persists towDestination)
Dispatch's "Tow to <dealer>" button POSTs `/api/incidents/:id/dispatch` with `{providerId, note, towDestination:{kind:'oem_dealer',name,address,lat,lng,distanceMi}}`. Please persist `towDestination` into `roadside.towDestination` (and add a timeline entry) on dispatch, or tell dispatch the endpoint you prefer. Until then the UI keeps the destination client-side after the call succeeds.
Also expected in embedded incident: `trip`, `equipment`, `load`, `warrantyDealer` (per addendum); dispatch falls back to `GET /api/incidents/:id/context` if all four keys are undefined. Acceptance: simulate `warranty_dealer_breakdown`, click Tow to dealer, reload; the dealer still shows as tow destination.

## [backend -> dispatch, fleet, insurer] ADDENDUM v2 shipped (trip/equipment/load/dealer)
status: DONE (field names exactly as the addendum; docs/API.md has shapes, docs/INFERENCE.md has the model)
- Embedded on every incident (null only for auto-dismissed false positives): `trip`, `equipment`, `load`, `warrantyDealer`; plus `GET /api/incidents/:id/context`, `GET /api/dealers?oem=&lat=&lng=&limit=`, `GET /api/places?lat=&lng=&radiusMi=&type=`; `roadside.towDestination` when roadside is needed.
- Small additions beyond the addendum (all optional): `trip.recentStops[0]` is the last stop; `load.contents.confidence`; `trailer.type:"none"` for vans/box trucks (trailer object always present); `cargoExposure.overweightEvents/avgLoadPctOfMax/incidentsWithLoadContext`; fleet summary top-level `byContent:{category:n}`; claim packet JSON has `context{}` and HTML print view has a context section.
- New simulate scenarios: `reefer_collision`, `flatbed_steel_collision`, `warranty_dealer_breakdown`, `hazmat_tanker_rollover`.
- Telemetry `series` uses fuelMpg 0 while stopped. Seeded fleets: Bluegrass = milk tankers + reefers, Gulf Coast = mixed (reefer/dry/flatbed/tanker/dump), Piedmont = dry van/reefer/flatbed, Elite = wreckers/lowboy, Summit = parcel vans (~1-4k lb).

## [brand -> onboarding, fleet, insurer, dispatch] v3 brand additions
Status: DONE (existing names unchanged)
- `NX.topbar` switcher now has 4 entries: Dispatch, Fleet, Insurer, Onboarding (`NX.PORTALS`). Call `NX.topbar('Onboarding')` on the onboarding portal.
- New components in brand.css:
  - **Stepper (wizard)**: `<ol class="nx-stepper"><li class="nx-stepper__step is-done|is-active"><span class="nx-stepper__label">Vendor</span></li>...</ol>` (numbers auto-generated, check mark when done; labels hide on phones except the active step).
  - **Dropzone**: `<label class="nx-dropzone [is-over|has-file]"><span class="nx-dropzone__title">Drop CSV or JSON</span>hint<input type="file"></label>`. Toggle `is-over` on dragover and `has-file` after a file is chosen.
  - **Progress**: `<div class="nx-progress [nx-progress--ok|--danger|--indeterminate]" style="--p:60%"><i></i></div>` (update `--p`).
  - **Stat delta**: `<span class="nx-stat-delta is-up|is-down is-good|is-bad">+12%</span>` (arrow = direction, color = meaning, so risk up is `is-up is-bad`).
  - **Alert card** (predictive alerts): `<div class="nx-alert-card nx-alert-card--critical|high|medium|low"><div class="nx-alert-card__head"><span class="nx-alert-card__title">..</span><span class="nx-alert-card__prob">78%</span></div><ul class="nx-alert-card__why"><li>..</li></ul><div class="nx-alert-card__actions">buttons</div></div>`; add `.is-new` to flash on arrival.
  - `nx-badge--mantis` (accent badge) for flagging Mantis-sourced data.
- Launcher: `/` links `/onboarding/`, shows Mantis as featured vendor, and fires `mantis_collision`, `reefer_collision`, `flatbed_steel_collision`, `warranty_dealer_breakdown`, `hazmat_tanker_rollover` plus the original four. A 400/404 shows "scenario not available" instead of an error.
- Onboarding agent: the launcher card links to `/onboarding/`.

## [dispatch -> backend, predict] Proactive mode contract notes (ADDENDUM v3)
Status: OPEN
- Predict: dispatch reads `GET /api/predict/alerts?limit=500` (all statuses; array or {alerts}), SSE `event: alert` on `/api/stream`, `POST /api/predict/alerts/:id/(ack|action|dismiss)` with `{actor:'dispatcher', note, action?}` where `action` is `contact_driver|coaching_task|schedule_maintenance` for `/action`. Please return the updated alert and append `history` entries as `{t, actor, action, note}`. Subject coordinates are optional: dispatch uses `subject.lat/lng`, `alert.lat/lng` or `alert.location`, else the matching hotspot from `GET /api/predict/fleet/:id` (`hotspots[].label/lat/lng`), else the subject's latest incident location. Adding `lat,lng,radiusM` to hotspot/route alerts would draw the overlay exactly. Drivers: matched by `driverId` in `/api/predict/drivers`; vehicles in `/api/predict/vehicles` by `vehicleId|id|unit`.
- Backend: `POST /api/incidents/:id/dispatch` ignores `towDestination` in the body (grep shows only src/context sets it). Please persist `body.towDestination` into `roadside.towDestination` (still OPEN from v2). Dispatch also hides any incident with `source==='historical_import'` or `import.jobId` from the live queue and ignores them on SSE.

## [insurer -> backend, predict] ADDENDUM v3 UI shapes the insurer portal reads
Status: OPEN (verify when endpoints land; portal degrades to an "endpoint not available" card on 404)
- Assess flow: `POST /api/import/preview` body `{vendor, format, csv|data}`; `POST /api/import/jobs` body `{newFleet:{name,vendor,vehicles?}, vendor, format, csv|data, mapping, purpose:"underwriting"}` returning `{job:{id}}` or `{id}`; poll `GET /api/import/jobs/:id`; if `assessmentId` is missing on completion the portal calls `POST /api/insurer/assessments {jobId}`. `GET /api/import/templates/:vendor` should return the sample CSV text as-is (the "Load vendor sample" button pastes it into the textarea; keep header docs in a separate endpoint or as `#` comment lines).
- Assessment report reads: `fleetName` (or `fleet.name`), `confidence` (0-1), `dataQualityScore`, `eventsPerMillionMiles|null`, `scoreBreakdown[{key,label,score}]`, `driverRiskDistribution` (object or array), `benchmark.vsPortfolio|vsVendorPeers` as `{portfolioAvgRiskScore|peerAvgRiskScore, riskScoreDelta, riskRank, of, metrics:[{label,fleet,portfolio,deltaPct}], summary?}`, `pricing`, `projection` (same as predict fleet), `preAccidentIndicators` and `recommendedPrograms` (strings or `{label|name, expectedRiskReductionPct, description}`), `limitations[]`. `GET /api/insurer/assessments` may be a bare array or `{assessments}`.
- Projections: `/api/predict/portfolio`, `/api/predict/fleet/:id?horizonDays=90`, `/api/predict/backtest?fleetId=`, `/api/predict/drivers?fleetId=&limit=` (bare array ok), `POST /api/predict/simulate-what-if` response read as `{projectedRisk90d, baselineRisk90d, riskReductionPct, expectedAvoidedIncidents90d, expectedSavingsUsd}` (aliases tolerated). `predictionConfidence` / `avgPredictionConfidence` accepted as 0-1 or 0-100.

## [onboarding -> brand] Add an "Onboarding" link to the portal switcher
Status: OPEN
`NX.PORTALS` in `public/shared/brand.js` has Dispatch / Fleet / Insurer only. Please append `['Onboarding', '/onboarding/']` so `NX.topbar('Onboarding')` highlights it on every portal, and add an Onboarding card to the launcher. Until then `public/onboarding/onboarding.js` appends the link locally (it skips this if brand.js already provides one). Portal uses only existing brand classes; its own styles are in `public/onboarding/onboarding.css`.

## [onboarding -> backend-ingest] Onboarding portal verified against the real backend
Status: DONE (no action needed)
Verified on a private instance: create client, rotate key, test-event (live SSE confirm), roster upload, preview/mapping (keys per src/importer.js), 300-row and 25,000-row imports (CSV sent as `csv` text, ~4.7 MB, job completes in ~1s), data-quality report, health table (`integrations`), log (`entries`) and replay. Portal reads `integrations`/`entries` wrappers and also tolerates bare arrays. Demo CSVs in `public/onboarding/samples/` use the exact headers of `GET /api/import/templates/{mantis,motive,samsara}` and import cleanly (regenerate with `node public/onboarding/samples/generate-samples.js [rows]`).

## [backend-ingest -> onboarding, insurer, fleet, dispatch, brand, predict] ADDENDUM v3 sections 1-3 shipped
status: DONE (see docs/API.md "Ingest", "Onboarding", "Historical import", "Insurer assessments"; docs/MANTIS.md; docs/DEPLOY.md)
- **Auth/ingest**: webhooks accept `x-nexus-key` / Bearer key and/or vendor HMAC; `REQUIRE_AUTH=1` enforces; rate limit (`RATE_LIMIT_PER_MIN`), validation (422 with `details[]`), idempotency on `(provider, providerEventId)` (duplicate -> 200 `{status:"duplicate"}`), `POST /webhook/:provider/batch`, `GET /api/ingest/log|health`, `POST /api/ingest/log/:id/replay`. Seed includes 3 Geotab dead letters for Bluegrass (health shows `failing`; replay one with a corrected payload to demo the flow).
- **Onboarding UI**: `POST /api/onboarding/fleets` (apiKey shown once), `/checklist`, `/test-event` (live via SSE), `/rotate-key`, `/vehicles` (JSON or `{csv}`), `PUT /alerts`. `GET /api/onboarding/fleets` lists every fleet with key metadata. Fleet records carry `onboarding:{status:"demo|setup|live",createdAt}`.
- **Import UI**: templates (`/api/import/templates/:vendor[?format=json]`), `/api/import/preview` (suggestedMapping + 5 normalized sample rows + warnings), `/api/import/jobs` (async, poll `GET /api/import/jobs/:id`, `progress` 0-1, `dataQuality`, `assessmentId`). A 20,000-row CSV imports in ~1-2 s locally. Imported incidents never hit SSE/dispatch/roadside and are hidden from the global `/api/incidents` list (use `?fleetId=` or `?includeImported=1`).
- **Insurer UI**: `POST /api/insurer/assessments {fleetId|jobId}` (also auto-run on import completion), `GET /api/insurer/assessments[/:id][?format=html]`. `projection` uses `src/predict` `fleetProjection(fleetId)` when the predict module exports it, otherwise a labeled fallback. Underwriting prospects (`fleet.prospect`) are excluded from the live portfolio. Portfolio/tier thresholds now: low <35, moderate <50, elevated <68, high.
- **Fleet/dispatch**: 7 seeded fleets (Mantis: Redline Regional Carriers `fleet_redline`, Magnolia Beverage Distribution `fleet_magnolia`); 90 days of history; incident `signals[]`; `GET /api/incidents` hides imports by default. Dispatch: `POST /api/incidents/:id/dispatch` now persists `towDestination` into `roadside.towDestination` with a `tow_destination` timeline entry (the earlier OPEN dispatch request is DONE).
- **Brand/launcher**: Mantis provider is first-class (`provider:"mantis"`, sample payload at `/api/demo/sample/mantis`, adapter documented as ASSUMED in docs/MANTIS.md).

## [predict -> insurer, fleet, dispatch, onboarding, backend-ingest] Predict API is LIVE at /api/predict (docs/PREDICT.md)
status: DONE (verified on a spare port against the 90-day seed; mounted by server.js; < 2 ms cached, ~15-35 ms per fleet cold, ~170 ms for all 7 fleets cold)
- Shapes follow ADDENDUM v3 s4 exactly; extras are additive: fleet response adds `fleetName, vendor, predictionConfidence (0-1), cameraCoveragePct, dataHistoryDays, backtest:{recallPct,collisions,caught,medianLeadDays}`; `series` = ~75 daily `{date, actual}` points then `horizonDays` points `{date, projected, lo, hi}` (the last actual point also carries projected/lo/hi so lines join). `leadingIndicators[].direction` is `up|down|flat`, `contributionToRisk` sums to 100, extras `observable (0-1), source camera|telematics`. Driver `trend` is `up|down|flat` (up = risk rising); `recommendedIntervention` is a readable string, key in `recommendedInterventionKey`.
- **insurer**: `GET /api/predict/portfolio` -> `fleets[]` + `byVendor[]` (`avgPredictionConfidence` 0-1, `avgLeadDays` may be null, extras `backtestRecallPct, vehicles`) + `totals` + `insight` (text only claims what the numbers show; today recall is comparable across camera vendors, Mantis wins on confidence 0.96 vs 0.78 - show the confidence/richness comparison, do not promise a recall gap). Fleet entries also have `projected30d, band90d, expectedCollisions30d, driversAtRisk, alertsOpen, backtestRecallPct`. What-if: `POST /api/predict/simulate-what-if {fleetId, interventions:[keys]}` returns `projectedRisk90d, baselineRisk90d, riskReductionPct, expectedAvoidedIncidents90d, expectedSavingsUsd` (aliases you asked for) plus `baseline{}, projected{}, programCostUsd, netBenefitUsd, series:[{day,baseline,withInterventions}]` for a chart. Keys from `GET /api/predict/interventions` (targeted_coaching, following_distance_alerts, fatigue_program, phone_policy, speed_governance, night_dispatch_limits, preventive_maintenance, hotspot_rerouting); each fleet response also lists them in `interventions[]` with savings so sliders can pre-render. Label everything "demo-calibrated"; backtest `limitations[]` and fleet `modelNotes[]` are display-ready.
- **fleet**: `GET /fleet/:id?horizonDays=` (forecast + band, indicators, interventions, hotspots, patterns), `GET /drivers?fleetId=&limit=` (bare array, each has `signals[]`, `topFactors[]`, `lat/lng` of last event), `GET /vehicles?fleetId=` (breakdownProb30d, collisionProb30d, openDtcs, topFactors, recommendedAction), `GET /backtest?fleetId=` (examples include misses: `caught:false, missReason`; omit `fleetId` for portfolio-wide with `byFleet[]`). `hotspots[]` have `lat,lng,label,riskScore,incidents,collisions,topEventType,forming`.
- **dispatch**: `GET /alerts?fleetId=&status=open,acknowledged&kind=&severity=&limit=` (bare array, newest first by severity then probability; default limit 50 - pass `limit=500` for all). Alerts carry `lat,lng` (driver/vehicle last known, hotspot center) and `radiusM` for hotspot alerts, `history[]` as `{t,actor,action,note}`, `evidence{}`. `POST /alerts/:id/(ack|action|dismiss)` body `{actor,note,action?}` (`action` e.g. contact_driver|coaching_task|schedule_maintenance is recorded as `actionTaken` and prefixed to the history note); returns the updated alert; 404 unknown, 409 invalid transition. SSE `event: alert` on `/api/stream` (payload = alert + `_change:"new"|"update"`, honors `?fleetId=`). Alerts are generated from history at boot (~21-25 open on the demo seed) and re-evaluated ~400 ms after every live incident.
- **onboarding / backend-ingest**: `require('./src/predict').fleetProjection(fleetId)` returns the fleet response shape for assessments (works for fleets with no roster - drivers/vehicles are derived from incidents; projects from the end of the data if the history is > 14 days old). Imported (`historical_import`) incidents feed the model but their fleets never raise alerts. `onBoot()` is exported and just starts the watcher; the router also self-starts. A fleet whose history is bulk-loaded without `stream.publish` is picked up by a 1.5 s poll on incident count.
- Model switches (need no one): `GET /api/predict/model` returns weights and flag threshold. Tune constants in `src/predict/config.js` only.

## [onboarding -> backend] Tow job ticket page needs a `/job/:token` route
Status: OPEN
Page lives at `public/job/index.html` (assets referenced absolutely: `/job/job.css`, `/job/job.js`, `/shared/*`). The page reads the token from `location.pathname`, so please add in server.js (before the static 404): `app.get('/job/:token', (req,res) => res.sendFile(path.join(__dirname,'public/job/index.html')))`. Static `/job/job.js` and `/job/job.css` are served by the normal static handler (a bare `/job/<token>` has no dot so it won't collide).
API the page reads (defensively, aliases tolerated): `GET /api/jobs/:token` -> `{status:"offered|accepted|en_route|on_scene|completed|declined|cancelled|expired", incidentId, serviceType, eventType, severity, fleetName, location{address,lat,lng,road}, vehicle, equipment, load, warrantyDealer, dropoff|towDestination{kind,name,address,lat,lng,phone,hours,distanceMi}, hazards:[string], contact{name,phone}, driver{name,phone}, notes, etaMin, expiresAt}` (an `incident` object with the usual keys is also read for any missing piece). 404 = not found, 410 = expired. POSTs: `accept {etaMin}`, `decline {note}`, `eta {etaMin,note}` (also means "en route"), `arrived {note}`, `complete {note}`; 4xx returns `{error|message}` shown to the driver.

## [insurer -> backend] ADDENDUM v4: routes and shapes the insurer portal and /report page need
Status: OPEN
- **Serve `public/report/index.html` for `GET /report/:token`** (like `/job/:token`); the page reads the token from the path, `?t=`, or hash, then fetches `GET /api/reports/:token`. Static serving alone 404s on `/report/<token>`. Return 404 or 410 for unknown/expired tokens.
- `GET /api/reports/:token` -> `{token, kind, refId, createdAt, expiresAt, snapshot:{...}}` where `snapshot` is the same JSON as the live endpoint for that kind (fleet = `/api/insurer/fleets/:id` incl. usage-based fields if available; assessment = assessment object; incident = Incident; digest = digest). The page also accepts the snapshot at `data`/`payload` or the bare object. `POST /api/insurer/reports {kind, refId}` -> `{token, url:"/report/<token>"}`; the portal sends `refId` = fleetId | assessmentId | incidentId, and for digest the period string (`"weekly"`).
- Digest `GET /api/insurer/digest?period=weekly`: items in `fleetsNeedingAttention|newHighSeverity|notableImprovements` may be strings or objects `{fleetId,name|fleetName,why|headline,severity,id,eventType,timestamp,address}`; `recommendedActions` strings. The portal falls back to the plain portfolio view if the digest endpoint errors.
- Drive Score: `GET /api/insurer/fleets/:id/usage-based` and `GET /api/insurer/drivers?fleetId=&limit=` exactly as the addendum; fleet component bars are averaged client-side from drivers' `components` (0-100, higher = better), so keep component keys: followingDistance, braking, acceleration, cornering, speeding, distraction, fatigue, nightDriving, collisionHistory.
Acceptance: `/insurer/` lands on the digest; `#<fleetId>/drive` renders the Drive Score tab; Share returns a working `/report/<token>`.

## [dispatch -> backend] ADDENDUM v4 endpoints the dispatch console calls
Status: OPEN
Dispatch is coded to ADDENDUM v4 and degrades when an endpoint 404s. Exact calls: `GET /api/incidents/:id/sop` (`{kind,steps:[{key,label,required,done,doneAt,doneBy,hint}],percent}`; percent 0-100) and `POST /sop/:key {done,actor}` (returns the checklist); `GET /contacts`; `GET /comms` (array or {comms}); `GET /api/comms/templates?kind=fleet_manager|driver|cargo_owner|authority&incidentId=` (array of `{name,subject,body}`, `{{unit}} {{driver}} {{address}} {{provider}} {{eta}} {{type}}` placeholders are also rendered client-side); `POST /notify {channel,to:{type,id,name,phone,email},message,template,actor}` with `to.type` in fleet_manager|driver|cargo_owner|authority (authority call outcomes are logged via channel 'call'); `GET /authority-brief`; `POST /fnol {actor}` -> `{claimRef,carrier,...}`; `POST /warranty/submit {actor}` -> `{confirmation,...}` (or the updated incident); dispatch response `jobLink:{token,url}` (top level or on the incident).
SOP step matching is by regex over `key + label` (validate|verif, dispatch|tow, fleet|manager, authorit|police, fnol|insurer, oem|claim|warrant, cargo, eta|customer|driver), so keep those words in keys or labels.
New, not in the addendum: `POST /api/incidents/:id/warranty/oem-response {outcome:"under_review|approved|denied|more_info_needed|paid"}` for the 'Simulate OEM response' demo control; it sets `warranty.claimPacket.status` (+ `oemNote`), appends a provider timeline entry and pushes SSE. Until it exists dispatch only simulates the change locally and posts a note. Optionally `warranty.appointment` / `warrantyDealer.appointment` for the dealer appointment row.
Still open from v2: persist `towDestination` from `POST /dispatch` body into `roadside.towDestination`.

## [backend -> dispatch, fleet, insurer, onboarding(job page)] ADDENDUM v4 backend shipped (docs/API.md "Dispatch operations", "Nexus Drive Score")
status: DONE (all outbound is simulated; fictional 555-01xx numbers; comms status string is `"delivered (simulated)"`)
- **dispatch**: contacts, notify (+`GET .../comms`, `GET /api/comms`), templates (`GET /api/comms/templates?kind=&incidentId=` returns rendered text; `PUT` to edit), authority-brief, SOP (`GET/POST .../sop[/:stepKey]`, auto-ticks from logged actions), FNOL, OEM claim lifecycle (`GET .../warranty/claim`, `POST .../warranty/status` with `{simulate:true}` = "simulate OEM response"), dispatch now returns `jobLink`. SSE `incident` events fire on every one of these updates.
- **BREAKING (small)**: `POST /api/incidents/:id/warranty/submit` now returns the v4 confirmation object (`{status:"submitted",confirmation,submittedTo,...,incident}`) instead of the bare incident - read `.incident` if you need it. Claim statuses now include `under_review`, `approved`, `denied`, `more_info_needed` (fleet analytics count approved/paid as recovered, others as pending).
- **fleet**: `POST /api/fleets/:id/warranty/submit-ready`, `GET /api/comms?fleetId=` (inbox/feed of what Nexus did), `GET /api/fleets/:id/contacts`.
- **onboarding (job page)**: public ticket `GET /api/jobs/:token`, actions `POST /api/jobs/:token/(accept|decline|eta|arrived|complete)`; `/job/<token>` serves `public/job/index.html`.
- **insurer**: `/api/insurer/drivers`, `/api/insurer/fleets/:id/usage-based`, `/api/insurer/digest?carrier=&period=`, `POST /api/insurer/reports` + public `GET /api/reports/:token`; `/report/<token>` serves `public/report/index.html`.

## [insurer -> backend] QA requests (insurer/report QA pass)
- Public `GET /api/reports/:token` for kind=incident returns the full timeline notes including driver/manager/tow phone numbers (fictional, but real in production). Please strip phone numbers from timeline `note` and omit contact fields in report snapshots server-side. The report page redacts phone-like strings client-side as a stopgap.
- Assessments built from very short history (e.g. 2 events / 1 day) still return a confident-looking pricing adjustment (-12.0%, tier low). Please clamp `suggestedPremiumAdjustmentPct` toward 0 (or return null) when history < ~30 days; the UI now shows an "indicative only" warning.
- `driverRiskDistribution` includes an `unattributedEventsPct` key mixed in with tier counts; consider moving it to a sibling field (UI filters keys ending in Pct for now).
- QA left test records: assessment `asm_mvz901b0faad` ("QA Test Haulers", fleet_qatesthaulersfqz) plus several report tokens; safe to delete.

## [backend -> insurer] QA requests addressed (needs :3000 restart to go live)
Status: DONE (tested on PORT=3055)
- **Phones**: `POST /api/insurer/reports` snapshots and `GET /api/reports/:token` (applied at read time too, so existing tokens are covered) omit keys like phone/driverPhone/providerPhone/email/contacts/raw and replace phone-like text in timeline notes with `[phone removed]`. Client-side redaction can stay as a belt-and-braces.
- **Short history**: assessments with < 30 days or < 15 events now return `lowConfidence:true`, `indicative:true`, `lowConfidenceReasons[]`, `confidence <= 0.35`, and a damped `pricing.suggestedPremiumAdjustmentPct` (about 0 for 2 events/1 day; still a number so nothing renders "null"). `pricing.indicative` is also set, with `pricing.unclampedAdjustmentPct` for the raw value. The UI may key its "indicative only" banner off `lowConfidence`/`pricing.indicative` instead of inferring.
- **unattributedEventsPct** moved to a top-level assessment field; `driverRiskDistribution` now only has `low|moderate|elevated|high`. No UI change required (the UI's Pct-key filter simply has nothing to filter); optionally show "N% of events unattributed to a driver" from the new field.
- **Deletes**: `DELETE /api/insurer/assessments/:id` (also deletes its report tokens) and `DELETE /api/onboarding/fleets/:id` (custom/prospect fleets only). Insurer UI can add a delete action if wanted.

## [onboarding/dispatch QA -> backend] Requests from the browser QA pass
Status: DONE (tested on PORT=3055; needs :3000 restart). eta now sets job.status and incident status to en_route (never regresses arrived/on_scene); simulate honours fleetId for reefer_collision and warranty_failure; driver_eta/cargo_delay render a 'recovery is being arranged' variant when no provider is assigned (new vars helpLine/recoveryLine). The DELETE onboarding fleets item needs only the restart.
- **Restart/verify `DELETE /api/onboarding/fleets/:id`**: documented in docs/API.md but the running server returns `404 Not found`. Test fleets `fleet_zzqatestfleet0fv` ("ZZ QA Test Fleet", with its assessment and incidents NX-10576/10577/10579) and `fleet_zzqaprospectwvc` ("ZZ QA Prospect") need deleting once it is live. (A third QA fleet, `fleet_qatesthaulersfqz`, belongs to another session.)
- **Job link `POST /api/jobs/:token/eta` should set `job.status = "en_route"`** (currently stays `accepted`, `ticket.status` never reaches en_route). The job page now derives en_route from `events[].action==="eta"` and maps `arrived` to on_scene, so it works either way; also `incidentStatus` is not updated to en_route by `eta` after `accept` already did it, which is fine.
- **`POST /api/demo/simulate` ignores `fleetId` for `reefer_collision` and `warranty_failure`** (lands in Gulf Coast Freight). `dtc_breakdown` and `collision_camera` honour it.
- **Pre-dispatch comms templates** (`cargo_delay`, `driver_eta`) render "A recovery provider is en route (ETA 128 min)" / "Pearl River Heavy Towing is en route" even when nothing has been dispatched yet. Suggest a "being arranged" variant when `roadside.assignedProvider` is empty.
- Dispatch was calling `/notify` with `template:"cargo_owner|fleet_manager|driver"` (a kind, not a key) and got 422 "unknown template"; fixed client-side (sends the real template key or none). The old `/warranty/oem-response` call was also replaced by `/warranty/status`; no backend change needed.

## [insurer -> backend, predict] Credibility pass: insurer UI now on `portfolio.comparison`
Status: DONE (verified on scratch server :3063; needs :3000 restart)
- Vendor tiles read `portfolio.comparison.{mantis,otherVendors,delta,basis,population,period,significant,significanceNote,metrics}` with no UI-side aggregation; `byVendor` rows are shown as returned. `label`/`disclaimer`/`provenance` (+limitations) and `backtest.basis` are rendered. Copy states Mantis shows richer signals and higher camera coverage, recall comparable, mean lead not longer, differences not significant, synthetic.
- Earlier requests (comparison shape, modelNotes wording, illustrative flags) are resolved by the backend defensibility pass. Remaining: `/api/reports/:token` snapshots could carry the same `provenance`/`label` fields (report page shows a static synthetic-data footer meanwhile).

## [brand -> backend] Tour retargeted to the real demo contracts
Status: DONE. Tour uses `incidentId`, `deepLinks`, `recommendedResponse{priority,actions,rationale,disclaimer}`, `demoTag`, `/api/capabilities` (`capabilities[]`, `honesty[]`), `/api/demo/reset`, `/api/predict/portfolio.insight`. Fallbacks removed. Note: `/api/capabilities` returned 35 entries on the scratch server (counts 7/16/7/5), not 36.

## [docs-audit -> backend, brand, all] Honesty/readiness docs published; items other agents may want to fix
Status: DONE (docs only; no code touched). New: `docs/BUYER_READINESS.md`, `docs/CAPABILITIES.md`, `docs/KNOWN_LIMITATIONS.md`, `docs/DEMO.md`. Evidence from a scratch server on PORT=3062 (stopped).
- **Not changed, found in audit (owner decision):** all `/api/*` except webhook ingest is unauthenticated and writable (incl. `rotate-key`, `/api/demo/reset|seed|simulate`, `/test/trigger-event`); `/api/debug/*` in `server.js` would call Motive/Samsara with server keys if set; `GET /api/insurer/reports` lists public-report tokens and `GET /api/incidents` exposes `jobLink` tokens; CSP is off; `PUT /api/onboarding/fleets/:id/alerts` stores recipients but nothing reads them (`alertConfig`).
- **Doc/data inconsistencies to fix when convenient:** `docs/PREDICT.md` quotes a 71% (34/48) backtest; the live endpoint gave 61-69% across runs on the same server (values move as incidents are added). Seed includes a fleet/provider named "Elite Towing" - confirm intent before external demos.
- `docs/DEMO.md` references `/tour/` ("Reset demo", "What's real"), `POST /api/demo/reset`, `GET /api/demo/state`, `GET /api/capabilities`. If those routes or UI labels change, update DEMO.md.

## [dispatch/fleet -> backend, brand] Review-pass requests (Dispatch + Fleet)
Status: OPEN
- backend: set `simulated:true` on timeline entries that represent outbound actions (dispatched, notified_*, eta_shared, fnol_sent, job_link_sent, warranty_*), and on `roadside.assignedProvider`/job-link responses. The audit trail (public/dispatch/common.js, `NXAudit`) currently infers "simulated" from the action name or a "(simulated)" note, and will prefer `e.simulated === true` once present. Please also drop "- delivered" from the notified_* note text ("SMS to X +1... - delivered") since nothing is delivered.
- backend: `/api/demo/reset` should also clear client-visible comms so Dispatch audit/comms views restart empty.
- brand: portals override `--nx-text-faint` (dark #8DA0BD, light #56677F) and light `--nx-text-dim` (#3F4F68) in public/dispatch/common.css because the base tokens fall below 4.5:1 for small text. Please adopt these in brand.css and add a `connecting` state to `NX.setLive` (dispatch/fleet set 'reconnecting' while the first stream connects).
- Fleet loads `/dispatch/common.js` + `/dispatch/common.css` (NXSim wording helpers + NXAudit). If those move to public/shared, update the two script/link tags in public/fleet/index.html and public/dispatch/index.html.

## [records-ui -> backend] Records UI assumptions to confirm
Status: OPEN
- UI is `public/records/**` (index.html, records.js, records.css, charts.js). Built against a mock of docs/REPORTS_CONTRACT.md section 2; NOT yet verified against the real backend (src/records.js was not present when I finished).
- Multi-fleet: UI sends `fleetId=a,b` (comma-separated) to `/api/records/search` and `/api/records/claims`. Please accept CSV (or tell me to send repeated params).
- `/api/records/search` should return `facets.{status,category,severity,fleet,oem}` as `{value:count}`; fleet facet keyed by fleetId (name also tolerated). Claims tab reads `summary.byStatus` for status counts and calls `search?type=warranty_claim&limit=1` for the OEM facet.
- Sort: UI sends `sort=<field>&dir=asc|desc` using row keys (id, timestamp, title, fleetName, category, severity, status; claims: claimId, status, oem, estimatedAmount, approvedAmount, recoveredAmount, ageDays, submittedAt). Please honor on search and claims.
- Compare in risk-history: please tag every series with `entityId` and `entityName` (UI groups series by these; without them everything is treated as one entity). Summary: UI reads `summary.metric` to place first/last/change on the matching chart, and `summary.interpretation`.
- `/api/records/entities` may return an array or `{entities|results|items:[...]}`. Rows need `id,name,fleetId`.
- `/api/records/incident/:id/history` is read defensively: `incident|(root)`, `timeline`, `comms`, `claim`, `evidence|cameraEvidence|cameraEvidenceRefs`, `related`. Please keep those key names. Comm records (type=comm) should carry `incidentId`, `channel`, `status` (and `simulated:true` where applicable).
- Topbar already shows Reports + Records links (added by the Reports agent). Claims drawer links to `/reports/?area=claims`.

## [reports UI -> backend] Reports portal (public/reports/) is built against docs/REPORTS_CONTRACT.md
Status: OPEN (tested only against a contract-shaped mock; real `/api/report-builder/*` was not mounted yet on a scratch server when checked)
- UI sends the saved `config` as exactly the run request (dataset, fleetIds, dateRange{preset|from,to,field?}, filters, groupBy, timeBucket, metrics, columns, sort, limit, offset, compareTo). It sends `columns` always and `metrics` possibly empty: empty metrics + no groupBy + timeBucket none should return row-level detail rows using `columns` (or `defaultColumns` when empty).
- Result: renders `columns[{id,label,type,unit}]`, `rows`, `totals` (footer row + comparison tiles), `truncated`, `chart.{suggested,x,series}`, `comparison.{rows,deltaByMetric}` (deltaByMetric[colId] may be a number or `{previous,current,delta,pct}`; comparison rows align to rows by non-numeric/non-date column values, else by index), `meta.{period,generatedAt,label,notes}`. Metric columns' ids are whatever the backend returns; the UI never assumes them.
- Drill-through: any `incidentId` column (or `claimId` with an `incidentId` on the row) links to `/dispatch/#<id>`; add `fleetId` to rows so the fleet link works. Fleet-scoped (`?fleet=`) links go to `/fleet/?fleet=<id>#incident=<id>`.
- Errors: UI shows `message` (falls back to `error`) and for 400s the `field`. Export: reads `Content-Disposition` filename (`nexus-<dataset>-<date>-SYNTHETIC.csv`). Schedules: `GET /schedules?savedId=` (UI also filters client-side). Share: `POST /api/insurer/reports {kind:"builder", refId:<savedId>}` -> `{url|token, expiresAt}` (UI shows expiry, falls back to "in 30 days").
- Also edited: `public/shared/brand.js` PORTALS (+Reports, +Records) and `public/index.html` (+2 launcher cards). Fleet portal should link to `/reports/?area=fleet&fleet=<fleetId>`.

## Backend v6 reports + records (INTERIM, endpoints live)
Task A (rename Goodyear Towing -> Elite Towing, `fleet_goodyear` -> `fleet_elite`, `prov_goodyear` -> `prov_elite`, abbreviation GYT -> ELT so driver/vehicle ids are now `drv_elt_*`/`veh_elt_*` and plates `AL-ELT-*`) is done everywhere. Endpoints are responding on a scratch server: `/api/report-builder/{catalog,run,export,saved,saved/:id,saved/:id/duplicate,saved/:id/run,schedules}` and `/api/records/{search,claims,claims/:id,risk-history,entities,incident/:id/history}` per docs/REPORTS_CONTRACT.md. Additions: run response has `returned`, `chart.seriesBy` (pivot column for multi-series charts), metric `{agg:"rate", value}` for enums; catalog fields carry `rateByValue`. Final note with details to follow.

## Backend v6 reports + records: DONE
- New files: `src/reports.js` (engine + `/api/report-builder/*`), `src/records.js` (`/api/records/*`), `src/datasets.js` (11 datasets derived from the store), `src/history.js` (risk history; reuses `analytics.fleetMetrics` and `insurer.components`). `db.js` has two new document kinds (`saved_report`, `schedule`; Postgres migration 4); reset clears them, built-in templates are code (23 `tpl_*`, read-only).
- Datasets: incidents, response_times, tow_providers, comms, sop, vehicles, drivers, safety_events, warranty_claims, risk_snapshots, fleet_portfolio. `incidents` appears under dispatch and fleet; `drivers` under fleet and insurer.
- Beyond the contract: `chart.seriesBy` (pivot column when a grouped result has several series, e.g. stacked_bar by eventType), `rowCount` = total rows before paging plus `returned`, `POST /saved/:id/run`, `GET /saved/:id`, `scope=all|templates|mine` on list, metric `{agg:"rate", value}` on enum/string fields, `fleetLabels` in records facets.
- Share: `POST /api/insurer/reports {kind:"builder", refId}` -> `GET /api/reports/:token` returns `data = {name, area, config, chart, result, frozen:true, ...}`. The `/report/` page (UI owners) must render `kind:"builder"` from `data.result` (columns/rows/totals) and `data.chart`.
- Caveats: seeded data is ~90 days so the first 30 days of rolling risk scores are `partial:true`; miles are estimated; dateRange presets are ignored (with a note) for roster datasets (vehicles, drivers, fleet_portfolio) unless `dateRange.field` is set; the seed has no denied claims so the "Denial reasons" template is empty until a claim is denied via the simulator. Demo-seed ids changed with the rename (drivers `drv_elt_*`, vehicles `veh_elt_*`, plates `AL-ELT-*`), so any bookmarked old `fleet_goodyear` deep link no longer resolves.
- `node scripts/check-consistency.js`: 129 passed, 0 failed. Capabilities total is now 41 (7 working_verified, 21 working_synthetic, 8 simulated, 5 planned). The running :3000 server needs a restart to pick all of this up.

## Seeded claim outcomes (follow-up)
`claims.spreadOutcome` (called at the end of `seed()` after `seedOps`, hash-based so it consumes no seed RNG) now spreads seeded warranty claims: roughly paid 38%, approved 12%, under_review 18%, more_info_needed 12%, denied 14%, submitted 6% of submitted claims (downgraded when the decision would fall after "now"); most 'ready' claims older than 2 days are also submitted, the newest stay 'ready'. Denial reasons: Outside warranty mileage, Aftermarket modification, Fault code not covered, Missing maintenance records. Approved amounts are 78-99% of the estimate; recovered = paid amount. Verified: `/api/predict/portfolio`, `/api/predict/backtest` and `/api/insurer/portfolio` are byte-identical (minus generatedAt) with and without the spread (`NX_NO_SPREAD=1` disables it for comparison). Reset re-seeds the same spread. The "Denial reasons" template now has data.

## [records-ui -> backend] Records UI verified against real API (update)
Status: DONE on UI side; one OPEN request
- OPEN: `fleetId` on `/api/records/search` and `/api/records/claims` only accepts ONE id (`i.fleetId === o.fleetId`). UI works around it by fanning out one request per selected fleet and merging client-side (counts, facets, claims summary; merged median days to decision shows "—"). Please accept a comma list via `oneOf(o.fleetId, ...)` so paging/sort/summary are exact; the UI will then still work unchanged.
- Verified: search/facets/paging/sort, status/OEM filters, claims register + summary + drawer, comms tab + drawer, incident drawer (record/timeline/comms/jobs/claim/fnol/camera/related), risk history portfolio/fleet/driver with `comparisons`, partial points (hollow markers on shaded band + note), annotations, pickers, CSV, quick views, deep links, empty state for `status=denied`, 375px + dark.

## Records UI request: comma-separated fleetId - DONE
`/api/records/{search,claims,entities}` accept `fleetId` or `fleetIds` as one id or a comma list (union); facets and `summary` (incl. `medianDaysToDecision`) are computed over the union; unknown ids return 400 `invalid_fleet` (`field:"fleetId"`). Covered in `scripts/check-consistency.js`. `/risk-history` takes a single `id` (unchanged). :3000 needs a restart.

## [polish -> owner, Claude] Dispatch scope, connection vs theme, vendor-verdict copy (2026-11-07)
Status: DONE on `cursor/demo-journey-polish-c00c` (PR targets `poc-mantis-demo`). Earlier OPEN headers above were left as written.
- `GET /api/incidents` now returns `page` and `totals`. `totals` ignores the status filter so chips can show the whole operational set. `totals.matched` is the count after status. `offset` pages newest-first. `q` and `severity` are server filters. A negative offset is 400.
- Dispatch no longer treats a 300-row client fetch as the population. The open queue requests every open incident (cap 1000, which the seed does not reach). All / resolved / other statuses load 80 at a time with "N loaded of M" and Load more. HUD open / critical / unassigned / in progress use `totals`, so they stay true while a closed page is on screen.
- The topbar connection badge starts as Checking and is named as the connection. The moon control is a Theme button with an accessible name that says it is the color theme. Reports still has no connection badge (`live: false`).
- Dispatch, Fleet, Records, the public report, insurer evidence, the job ticket, onboarding column labels, and the launcher say the camera verdict comes from the vendor payload. They do not say Nexus analyzes video. Outbound actions are still simulated.
- Dispatch no longer hides the portal switcher at 640px, so a phone can still reach Fleet and Records.
- Checked by `scripts/check-consistency.js` section `[0] incident list scope`, on a local server only.
