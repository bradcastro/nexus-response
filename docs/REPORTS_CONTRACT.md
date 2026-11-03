# Reports and Records: API contract (v6)

Authoritative contract shared by the backend, the Reports UI (`public/reports/**`) and the Records UI (`public/records/**`). Backend may ADD fields; do not rename or remove. Everything is synthetic demo data and must say so (`meta.synthetic: true`). NOTE: `/api/reports/:token` is the existing public share-link route; the builder lives under `/api/report-builder/*` to avoid a clash.

## 1. Report builder

### GET /api/report-builder/catalog
```
{ areas: [ { id: "dispatch|fleet|insurer|claims", label, description,
    datasets: [ { id, label, description,
      fields: [ { id, label, type: "string|number|date|enum|boolean", enumValues?:[...], filterable:bool, groupable:bool, sortable:bool, aggregations?: ["count","sum","avg","min","max","median","p90","rate"] , unit? } ],
      defaultColumns: [fieldIds], defaultMetrics: [ {field, agg, label?} ] } ] } ],
  chartTypes: ["table","bar","line","area","pie","stacked_bar","scatter"],
  dateRangePresets: [ {id:"7d",label}, "30d","90d","ytd","all","custom" ],
  timeBuckets: ["none","day","week","month"],
  filterOps: { string:["eq","neq","contains","in"], number:["eq","gt","gte","lt","lte","between"], date:["gte","lte","between"], enum:["eq","neq","in"], boolean:["eq"] } }
```
Datasets (minimum): `incidents` (dispatch+fleet), `response_times` (dispatch: per incident timestamps to validate/dispatch/on-scene/resolved, minutes), `tow_providers`, `comms`, `sop` (dispatch); `vehicles`, `drivers`, `safety_events` (fleet); `warranty_claims` (claims, with lifecycle status, OEM, amount estimate, recovered amount, age, denial reason); `risk_snapshots` (insurer: weekly per fleet/driver: risk score, events per 1k miles, camera-verified share, drive score), `policyholders`/`fleet_portfolio` (insurer, by vendor).

### POST /api/report-builder/run
Request (all optional except dataset):
```
{ dataset, fleetIds?: [ids], dateRange: { preset?, from?, to?, field?: "timestamp" },
  filters: [ { field, op, value } ], groupBy: [fieldIds], timeBucket: "none|day|week|month",
  metrics: [ { field, agg, label? } ], columns: [fieldIds], sort: [ { field, dir: "asc|desc" } ],
  limit: 500, offset: 0, compareTo?: "previous_period" }
```
Response:
```
{ columns: [ { id, label, type, unit? } ], rows: [ { ... } ], totals: { ... }, rowCount, truncated: bool,
  chart: { suggested: "bar|line|...", x: colId, series: [colIds] },
  comparison?: { rows, deltaByMetric },
  meta: { dataset, generatedAt, period: { from, to }, synthetic: true, label: "Synthetic demo data", query: <echo>, notes: [] } }
```
Rows with `incidentId` / `claimId` fields should be drill-through capable (UIs link to `/dispatch/#<id>` and `/fleet/?fleet=<fleetId>#incident=<id>`). 400 on invalid dataset/field/op with `{error, message, field?}`.

### Saved reports
- `GET /api/report-builder/saved?area=&scope=` -> `[ { id, name, area, description, config: <run request>, chart: { type, x, series, options }, isTemplate, createdAt, updatedAt, lastRunAt } ]`. Includes built-in templates (isTemplate:true, read-only; duplicate to edit): at least 4 per area (dispatch, fleet, insurer, claims) such as: Incident volume by type and week; Response time by provider; False-positive rate; Open incident aging; Driver safety events by type; Warranty recovery by OEM; Claim status pipeline; Fleet risk trend; Drive Score distribution; Camera-verified share by vendor.
- `POST /api/report-builder/saved` `{name, area, description?, config, chart}` -> 201
- `PUT /api/report-builder/saved/:id`, `DELETE /api/report-builder/saved/:id` (templates: 409 `template_readonly`)
- `POST /api/report-builder/saved/:id/duplicate` -> 201
### Export / schedule / share
- `POST /api/report-builder/export` body = run request + `{format: "csv|json"}` -> file download (CSV with header row, synthetic-data footer line in JSON meta; CSV first line comment `# Synthetic demo data` is NOT used; instead name file `nexus-<dataset>-<date>-SYNTHETIC.csv`).
- `GET/POST/DELETE /api/report-builder/schedules` `{savedId, cadence: "daily|weekly|monthly", recipients: [emails], format}`; returns `simulated: true, status: "stored_not_sent", note: "Scheduling is simulated: no email is sent"`.
- Sharing: reuse `POST /api/insurer/reports` with `kind: "builder"`, `refId: <savedId>` (backend adds this kind; the snapshot is frozen result + config; same redaction and 30-day expiry).

## 2. Records / history explorer

### GET /api/records/search
Query: `type=incident|warranty_claim|risk_snapshot|comm` (default incident), `q` (free text over id, VIN, unit, driver, summary, claim number), `fleetId`, `from`, `to`, `status`, `category`, `severity`, `oem`, `vehicleId`, `driverId`, `sort`, `dir`, `limit` (default 25), `offset`.
-> `{ type, total, limit, offset, results: [ {...record summary with id, fleetId, fleetName, timestamp, title, status, tags:[...], links:{dispatch?, fleet?, api}} ], facets: { status:{value:count}, category:{...}, severity:{...}, fleet:{...}, oem:{...} }, meta:{synthetic:true,...} }`

### GET /api/records/claims
Warranty claims register: `?fleetId&status&oem&from&to&q&limit&offset` -> `{ total, results:[ { claimId, incidentId, fleetId, fleetName, vin, unit, oem, dealer, faultCodes:[...], warrantyBasis, status, submittedAt, decidedAt, paidAt, estimatedAmount, approvedAmount, recoveredAmount, denialReason?, ageDays, timeline:[ {at, status, note, simulated} ] } ], summary:{ count, byStatus, estimatedTotal, recoveredTotal, approvalRate, medianDaysToDecision } }` plus `GET /api/records/claims/:claimId`.

### GET /api/records/risk-history
`?scope=fleet|driver|vehicle|portfolio&id=<id>&bucket=day|week|month&from&to&metrics=riskScore,eventsPer1kMi,collisions,cameraVerifiedShare,driveScore&compareIds=a,b` ->
`{ scope, id, name, bucket, series: [ { metric, label, unit, points:[ {t, value, n} ] } ], events: [ {t, type, severity, incidentId, label} ] (markers for collisions/major events), annotations:[...], summary:{ first, last, change, direction }, meta:{ synthetic:true, label, limitations:[ "Derived from 90 days of seeded history; imported history extends it", ... ] } }`. Also `GET /api/records/entities?scope=driver&fleetId=` listing selectable entities (id, name, fleetId) for pickers.

### GET /api/records/incident/:id/history
Full timeline + comms + claim + camera evidence refs for one incident (reuse existing incident detail; add `related` incidents for same vehicle/driver in the last 90 days).

## 3. Honesty / UX rules (all agents)
- Label all output "Synthetic demo data". Simulated actions (schedule, email) say so.
- Loading: skeletons, "—" not 0 before data; zero only after a successful empty response; error + Retry.
- Fleet-scoped views (fleet portal) pass `fleetIds=[currentFleet]`; dispatch and insurer default to all fleets.
- Accessible (labels, keyboard), responsive at 375px, dark/light.
