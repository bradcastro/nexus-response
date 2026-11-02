# Mantis integration (ASSUMED payload - replace with the real spec)

> **Assumption notice.** We do not have Mantis's real webhook/API specification. Everything below (field names, header names, event vocabulary, signature scheme) is an **assumed shape** designed around what a camera-first telematics platform plausibly emits. The adapter (`src/adapters/mantis.js`) and fixture builder (`src/fixtures/mantis.js`) isolate every assumption so swapping in the real spec is a one-file change. Treat all of this as a proposal to validate with Mantis.

## Endpoint and auth
- `POST /webhook/mantis` (single event) and `POST /webhook/mantis/batch` (array of events or `{"events":[...]}`).
- Auth: per-fleet API key in `x-nexus-key` (or `Authorization: Bearer nxk_live_...`) **and/or** HMAC-SHA256 of the raw body in `x-mantis-signature` (`sha256=<hex>`, secret `MANTIS_WEBHOOK_SECRET`; ASSUMED header name).
- Idempotency key: `(mantis, event_id)`. Replays return the original incident.

## Assumed event payload (`schema: "mantis.event.v1"`)
```json
{
  "schema": "mantis.event.v1",
  "event_id": "mtx_9",
  "event_type": "drowsiness",
  "occurred_at": "2026-11-01T03:12:00Z",
  "org_id": "org_x",
  "vehicle": {
    "id": "55",
    "unit": "RRC-101",
    "vin": "3AKJHHDR3PA000042",
    "plate": "TN-RRC-101",
    "make": "Freightliner",
    "model": "Cascadia 126",
    "year": 2023,
    "odometer_mi": 180000
  },
  "driver": {
    "id": "d1",
    "name": "Lee Ortiz",
    "phone": "+16155550100"
  },
  "gps": {
    "lat": 36.16,
    "lng": -86.78,
    "speed_mph": 61,
    "heading": 270,
    "address": "I-40 WB, Nashville, TN"
  },
  "road_facing": {
    "following_distance_s": 2.1,
    "forward_collision_warning": false,
    "lane_departure": false,
    "speed_limit_mph": 55
  },
  "driver_facing": {
    "drowsiness_score": 0.82,
    "phone_use": false,
    "smoking": false,
    "seatbelt_on": true,
    "eyes_off_road_s": 2.4,
    "facing_forward": false
  },
  "ai": {
    "classification": "distraction",
    "confidence": 0.96,
    "model": "mantis-vision-v3"
  },
  "media": {
    "road_clip_url": "https://media.nexus-demo.invalid/mantis/mtx_9/road.mp4",
    "driver_clip_url": "https://media.nexus-demo.invalid/mantis/mtx_9/driver.mp4",
    "snapshot_url": "https://media.nexus-demo.invalid/mantis/mtx_9/road.jpg",
    "clip_seconds": 16
  }
}
```

| Field | Meaning | Used for |
|---|---|---|
| `event_id` | unique id | idempotency |
| `event_type` | `collision, rollover, harsh_braking, harsh_acceleration, harsh_cornering, speeding, tailgating, phone_use, drowsiness, smoking, driver_distraction, seatbelt_violation, lane_departure, vehicle_fault, tire_pressure, low_battery` | canonical `eventType` (phone/drowsy/smoking -> `distracted`; tailgating -> `following_distance`; seatbelt/lane -> `other`) |
| `occurred_at` | ISO-8601 UTC | timestamp |
| `org_id` | customer id | fleet resolution (when no API key) |
| `vehicle.{id,unit,vin,plate,odometer_mi}` | identity | roster match by VIN, then id |
| `gps.{lat,lng,speed_mph,heading,address}` | position | location, trail, roadside |
| `inertial.{peak_g,airbag_deployed}` | IMU | impact severity |
| `road_facing.{following_distance_s, forward_collision_warning, lane_departure, speed_limit_mph}` | forward camera analytics | `signals`, near-miss evidence |
| `driver_facing.{drowsiness_score, phone_use, smoking, seatbelt_on, eyes_off_road_s, facing_forward}` | in-cab camera analytics | `signals`, distraction evidence |
| `ai.{classification, confidence, model}` | Mantis' own AI verdict: `confirmed_collision, false_positive, near_miss, distraction, confirmed_event` | `camera.aiVerdict/confidence/verified` |
| `media.{road_clip_url, driver_clip_url, snapshot_url, clip_seconds}` | evidence | `camera.clips/snapshots` |
| `diagnostics.{mil, engine_hours, dtcs[{spn,fmi,code,description}]}` | engine data | DTC decoding, roadside, warranty |

## Normalization (what Nexus does with it)
- `camera.verified` is taken from **Mantis' own AI classification** (`ai.confidence >= 0.6`); we do not re-classify. `camera.aiVerdict` carries Mantis' verdict; `false_positive` with confidence >= 0.8 auto-dismisses the incident.
- `camera.signals` (human-readable evidence) and the top-level `signals[]` (structured: `{key,label,value,unit,triggered}`) are populated from the road/driver-facing blocks: `following_distance_s`, `forward_collision_warning`, `lane_departure`, `drowsiness_score`, `phone_use`, `smoking`, `seatbelt_unbuckled`, `eyes_off_road_s`.
- Everything else (VIN decode, DTC decode, roadside, warranty, trip/load context, risk) flows through the same enrichment as every other vendor.

## Why camera-first data matters in the demo
- Demo fleets `Redline Regional Carriers` (46 trucks) and `Magnolia Beverage Distribution` (29) run on Mantis: ~97-99% camera coverage, ~94-100% camera-verified events, rich driver-facing signals on every safety event, and an improving risk trend after auto-coaching (timeline action `coaching`).
- In the 90-day seed, precursor behaviours before collisions are captured most completely on Mantis (capture factor 1.0 vs 0.3 for a GPS-only vendor), which is why the predictive backtest has higher recall and lead time there. See `docs/PREDICT.md`.

## To replace the assumption with the real spec
1. Edit `src/adapters/mantis.js` (`normalize`, `verify`) to the real field paths/headers.
2. Update `src/fixtures/mantis.js` so simulations/tests emit the real shape.
3. Update the import column map (`VENDOR_COLS.mantis`) in `src/importer.js` if Mantis exports CSV.
4. No other file depends on the Mantis wire format.

Sample payloads: `GET /api/demo/sample/mantis` (collision) and `?kind=dtc`. Import template: `GET /api/import/templates/mantis`.
