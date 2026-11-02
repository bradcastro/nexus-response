# Incident Context Intelligence - how Nexus infers trip, load and contents

Everything under `trip`, `equipment`, `load` and `warrantyDealer` is **inferred or estimated**, and `load` always carries `confidence` (0-1) and `basis` (human-readable evidence). Code: `src/context/`.

## Pipeline
1. `simulate.js` (demo only) creates a hidden *ground truth* for the trip (what was loaded, where, when) and the **telemetry that load would physically cause** (30 s samples of engine load %, MPG, speed, RPM). In production this stage is replaced by real vendor telemetry (J1939 engine load, fuel rate, speed).
2. `index.js` turns the samples into the `trip` object: last-stop approach window (`before`) and post-departure cruise window (`after`), plus a ~60-point `series`.
3. `infer.js` sees **only** observables (telemetry windows, tractor/trailer spec, stop types, reefer state, camera) and produces `load`. It never reads the ground truth.
4. `index.js` adds the OEM `warrantyDealer`, `roadside.towDestination`, risk tags and claim-packet evidence.

## Physics model (nominal calibration, `model.js`)
Per tractor class two reference points define a linear fuel-use and engine-load curve versus gross vehicle weight (GVW):

| class | empty GVW | empty mpg / load | full GVW | full mpg / load |
|---|---|---|---|---|
| class 8 (sleeper / day cab) | 37,000 lb | 8.3 mpg / 28% | 80,000 lb | 6.0 mpg / 62% |
| class 6 box truck | 15,000 | 9.5 / 30% | 26,000 | 7.0 / 64% |
| van | 5,700 | 17.5 / 26% | 9,500 | 14.0 / 58% |

- gallons per mile `= a + b*GVW` (linear between the two points; mpg = 1/that)
- engine load `= l1 + (l2-l1)*(GVW-g1)/(g2-g1)`
- speed corrections: load scales with `(v/62)^1.6`; mpg with `1 - 0.0008*(v-58)^2`. Inference divides these out using the window's average speed.
- `GVW = tractor tare + trailer tare + 400 lb (driver/fuel) + payload`. Tare and max payload come from `equipment` (e.g. 53 ft reefer 17,500 lb, flatbed 10,800, milk/fuel tanker 13,500/15,000).

The simulator perturbs these curves with a per-vehicle bias (load +-3.5%, mpg +-3%), road-grade swings and sensor noise, so the inference is genuinely approximate (demo accuracy: ~5% mean error, ~85-90% of true weights fall inside the reported range).

## Weight estimate
1. **Speed-normalise** each window: `loadNorm = load / (v/62)^1.6`, `mpgNorm = mpg / f(v)`.
2. **Absolute estimates** after departure: invert the load curve and the mpg curve to a GVW, subtract tare => `payload_load`, `payload_mpg`.
3. **Differential estimate** across the last stop (cancels per-vehicle bias): `change = avg( dLoadNorm * lb-per-load-pt , d(1/mpgNorm) / b )`. If `change > 6% of the GVW span` => load was *added* (pickup); `< -6%` => *dropped* (delivery); otherwise *steady* (load carried through, e.g. a fuel stop).
   - pickup: `payload = payload_before + change`, where `payload_before` is assumed 0 if the pre-stop window reads near-empty (< 8% of max payload), else the absolute pre-stop estimate.
4. **Camera** (flatbeds): visible unit count x nominal unit weight (steel coil ~14,000 lb, lumber bundle ~3,500 lb).
5. **Combine** (weights): pickup `delta 0.6, load-abs 0.2, mpg-abs 0.2`; otherwise `0.5/0.5`; camera adds weight 0.25. `method` = `combined`, `camera_flatbed_visual` (flatbed + camera), or `mpg_vs_empty_baseline` (no load change observed).
6. **Confidence** `= 0.48 + 0.27*agreement + 0.08 (>=20 samples/window) + 0.07 (pickup observed) + 0.10 (camera)`, capped 0.30-0.95, where `agreement = 1 - 3*stdev(estimates)/payload`. Range `= payload +- max(6%, 1.4*stdev, 900 lb) * (1.15 + (1-confidence))` - low confidence means a wider range.
7. `overweightRisk` when payload > 99% of max payload or the range's upper bound exceeds max by 6%.

## Contents inference
Rule table on **supplier stop** (the last stop if load was added there, else the most recent source-type stop in `recentStops`), **trailer type**, **reefer state** and **camera**:

| evidence | category |
|---|---|
| reefer, setpoint <= 10F | `frozen_food` (+ food_distributor/cold_storage stop raises confidence) |
| reefer, setpoint > 10F | `perishable_food` |
| tanker + farm stop | `perishable_food` (raw milk, insulated) |
| tanker + fuel terminal (port, contentHint fuel) | `fuel_liquid`, `hazmat: true` |
| tanker + chemical terminal | `hazmat` |
| flatbed + camera sees coils / steel_yard | `steel`; lumber_yard => `lumber`; building_supply => `building_materials` |
| dump + quarry | `aggregate`; lowboy => `machinery`; car hauler => `vehicles` |
| van + parcel_hub | `parcel`; dry van + grocery_dc => `dry_grocery`; beverage bottler => `beverage`; manufacturer => `machinery`; retail_dc => `unknown` (general freight) |

Value range = weight range x per-category $/lb range (`model.js CONTENT`). `spoilageRiskHours` is set for temperature-sensitive cargo (shorter when the reefer unit is not running). A near-zero payload becomes "Empty / deadheading".

## Warranty dealer + tow destination
`warrantyDealer` exists only when `warranty.inWarranty && warranty.claimEligible`. Nearest in-network dealer for the OEM (heavy-duty bays required for trucks) by haversine distance, drive ETA = distance x 1.3 / 45 mph, 3 alternates. `authorizationRequired` when the estimate exceeds $2,500 (a pre-auth number is issued once the claim is ready). `roadside.towDestination`: `oem_dealer` for in-warranty non-drivable/derated faults, otherwise `fleet_yard` if within 70 mi, else `nearest_shop`.

## Risk + claims
Tags: `hazmat_load`, `high_value_cargo` (upper value >= $50k), `perishable_spoilage_clock`, `overweight_risk`, `shifting_load_risk` (loaded flatbed in collision/hard-maneuver). Claim packets get trip + load evidence lines, a cargo-exposure sentence in `summary`, and `cargoExposureUsd`.

## Limits (be honest in the pitch)
Estimates assume steady-state cruise windows, a known empty/loaded calibration for each tractor class, and trailer tare from fleet records. Grade, wind and driving style add error; the confidence/range fields exist to expose that. All business names, dealers and places in the demo are invented.
