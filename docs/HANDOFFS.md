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
- **insurer**: `GET /api/insurer/portfolio` and `/api/insurer/fleets/:id` (scoreBreakdown, pricingSignal, benchmark, driversRanked, recentVerifiedIncidents, weeklyTrend). Tiers: low/moderate/elevated/high (Goodyear low, Bluegrass/Summit moderate, Gulf Coast elevated, Piedmont high at seed time).
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
