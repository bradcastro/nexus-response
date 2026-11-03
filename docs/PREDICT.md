# PREDICT - "get ahead of accidents" engine (ADDENDUM v3 s4)

Owner: predict agent. Code: `src/predict/**`, `src/routes/predict.js` (mounted at `/api/predict`). **Demo-calibrated, transparent model - not an actuarial product.** Weights are hand-set; they were tuned against the demo seed (in-sample) so the backtest looks realistic. Nothing is fitted to real loss data.

## 1. Data in
All incidents from `db.listIncidents` (live + seeded + `historical_import`), per fleet, plus `roster` (drivers, vehicles, `hasCamera`). False positives (`camera.aiVerdict=false_positive`) are dropped. Each incident becomes an *event* tagged with leading indicators (`features.js`):

| indicator | key | weight (beta) | camera-derived | detected from |
|---|---|---|---|---|
| Tailgating | `following_distance` | 0.55 | yes | `eventType=following_distance`, signal `following_distance_s` triggered, text "following distance" |
| Harsh braking | `harsh_braking` | 0.42 | no | `harsh_brake` |
| Harsh accel/cornering | `harsh_maneuver` | 0.22 | no | `harsh_accel`, `harsh_turn` |
| Phone use / distraction | `phone_use` | 0.78 | yes | `distracted`, signals `phone_use`, `eyes_off_road_s`, `smoking`, `seatbelt_unbuckled`, text "phone/looking down" |
| Drowsiness | `drowsiness` | 0.85 | yes | signal `drowsiness_score` triggered, text "drowsy/fatigue/eyes closed" |
| Speeding | `speeding` | 0.30 | no | `speeding` |
| Lane departure | `lane_departure` | 0.45 | yes | signal `lane_departure`, text "lane departure" |
| Camera-verified near-miss | `near_miss` | 0.38 | yes | `camera.aiVerdict=near_miss` or `forward_collision_warning` triggered |
| Night-hour risk events | `night_hours` | 0.25 | no | any behavior event 22:00-05:59 local (UTC-5) |
| DTC / maintenance backlog | `maintenance_backlog` | 0.28 | no | `fault_code/breakdown/tire/battery` events on the driver's vehicle (open ones count x2, severity-boosted) |

Collisions (outcome) = `eventType` collision|rollover that is not a false positive.

## 2. Formulas
1. **EWMA rate** per driver per indicator: `rate = sum_events exp(-age/tau) / (tau(1-exp(-span/tau))) * 7` events/week, `tau = 14d/ln2` (half-life 14 days). The denominator corrects for histories shorter than 90 days.
2. **Relative frequency** `f = ln(1 + rate / norm_k)` (cap 6). `norm_k` = portfolio-average driver rate for that indicator (camera-derived indicators normalised over camera-equipped drivers only). `f=0` none, `f=0.69` as frequent as the average driver.
3. **Escalation** `esc = clamp((w14 - w_prior/2 - 0.5) / 1.5, 0, 3)`: weighted behavior events in the last 14 days minus the average 14-day count of the preceding 28 days (the 2-4 week pre-collision signature). Weight 0.55.
4. **Collision probability (30d, per driver)** - weighted logistic:
   `z = beta0 + TEMP * ( sum_k beta_k f_k + 0.55 esc + 0.35 recentCollision )`, `p = soft_cap(P_MIN + (1-P_MIN) * sigmoid(z))`, TEMP=0.5, soft cap scale 0.4.
   `beta0` is solved by bisection so the **mean driver probability equals the portfolio reference rate** `BASE_P30`. `BASE_P30` is the portfolio's observed collision rate per driver-30d, Poisson-gamma shrunk to a 1.2% prior (prior weight 100 driver-months; clamp **0.6-1.5%**). The demo seed's raw collision frequency (~5% per driver-month) is several times industry norms, so the plausibility ceiling binds and `gamma` (max 1.5) carries the rest; absolute numbers are bounded to underwriter-plausible ranges (about 2-3 collisions per 100 vehicles per month in the worst demo fleets), rankings are the main signal.
5. **Fleet calibration**: `gamma = clamp((C_obs + 3)/(C_pred + 3), 0.6, 1.5)` (Poisson-gamma) scales the fleet's driver probabilities toward its own observed collisions.
6. **Risk score (0-100)**: `50 + 22 ln(p / BASE_P30)` (driver: its p; fleet: mean p x gamma). 50 = portfolio-average, +22 per e-fold.
7. **Projection**: for horizon `d`, each `f_k(d) = f_now + 0.5*slope*21(1-e^{-d/21}) + 0.5*(f_longrun - f_now)(1-e^{-d/45})` (half damped 14-day slope extrapolation, half reversion to the driver's own 90-day level); escalation decays `e^{-d/28}`. Fleet series is the mean over drivers. Expected collisions over 30/90 days = sum of daily `p_d * drivers * gamma / 30`.
8. **Band**: 80% interval, lognormal: `sigma = sqrt(1/(E+1) + ((0.10 + 0.30(1-confidence)) sqrt(d/30+0.2))^2)`, multiplier `exp(+-1.28 sigma)` on the rate, then re-mapped to score.
9. **Direction**: `(proj30 - now) + 0.7 (now - score 30 days ago)`; >= +2.5 worsening, <= -2.5 improving, else stable. On the seed: Summit worsening, Redline and Magnolia (Mantis) improving, others stable.
9b. **Probability bounds**: driver `collisionProb30d` clamped to [1%, 85%]; fleet `expected.collisionProb30d = clamp(1 - exp(-expected collisions), 2%, 90%)`; soft saturation scale 0.25 and hard ceiling 0.4 before the fleet gamma.
10. **Expected loss 90d** = collisions90 x ($62k + 0.35 x avg cargo value of that fleet's collisions) + incidents90 x $300 + breakdowns90 x $1,900 (all demo assumptions in `config.js` COST).
11. **Prediction confidence (0-1)** = 0.40 signal richness + 0.22 history (days/75) + 0.13 volume + 0.25 camera-verified share. Signal richness = sum of indicator weights weighted by *observability* (camera-derived indicators: camera coverage x min(1, share of camera drivers that ever show that signal / expected share)). This is how camera-first data lifts confidence quantitatively; non-camera fleets get wider bands and lower confidence rather than "safe" scores.
12. **Hotspots**: 6-mile greedy clustering of recency-weighted safety events over 60 days (collision x5, braking/distraction/tailgating ~1.2, speeding 0.8); `forming` = >=3 events in last 14 days and >=2x the prior rate.
13. **Patterns**: risk-weighted event counts by local hour (UTC-5) and day of week over 90 days.
14. **Vehicle breakdown probability**: `sigmoid(-3.9 + 1.0 min(openCritical,2) + 0.35 min(open,4) + 0.5 min(recurringCodes,3) + 0.06 min(ageOpenDays,20) + 0.25 min(diag30d,4) + 0.4 lamp + 0.3 (odo>450k))`.
15. **Interventions / what-if** (`config.js` INTERVENTIONS): each has per-indicator rate reductions applied to targeted drivers (top 12% by risk, drivers with the elevated indicator, vehicles with DTC backlog, or all), ramped in over 30 days, evaluated at 4 horizon points; savings = avoided collisions x loss per collision + avoided incidents x unit cost; `programCostUsd` uses per-driver cost assumptions. Effects are literature-style assumptions, not measured.

## 3. Alerts (`alerts.js`)
Kinds: `driver_risk_spike` (p >= 2.6x reference, or escalation >= 1.5 with p >= 1.7x, and >= 2 events/30d), `fatigue_pattern` (>= 2 drowsiness events/30d, or >= 3 night events plus lane/drowsy/braking), `following_distance_trend` (>= 3 tailgating events/30d, or f >= 2 and trend >= +50%), `hotspot_forming`, `vehicle_breakdown_risk` (p >= 20% with open/recurring codes), `maintenance_overdue` (open DTC >= 5 days).
Ids are deterministic (`PA-` + hash of kind|fleet|subject) so re-evaluation never duplicates. Severity is relative to the portfolio reference. Lifecycle `open -> acknowledged -> actioned | dismissed`; dismissed/actioned alerts are suppressed 14/10 days; open alerts whose condition clears (hysteresis at 0.8x thresholds) are auto-dismissed with `autoClosed:true`.
Generation: at boot from history (silent, no SSE), then re-evaluated for the fleet ~400 ms after each live incident (hooks: `pipeline.onIncident` and a wrapper around `stream.publish`); new/escalated alerts go out as SSE `event: alert` via `stream.publishEvent`. A poll (1.5 s) catches bulk changes (imports, reseeds). Alerts are also written with `db.put('alert', ...)` and rehydrated at boot. Fleets that contain only `historical_import` data never raise live alerts.

## 4. Backtest (honest)
Walk-forward daily replay (`analyze.js runBacktest`): each day uses only earlier events. A collision is **caught** if its driver was flagged (debounced: 2 consecutive daily evaluations above threshold; flag = p >= 2.6x reference or sharp escalation) between 12 hours and 30 days before. Reports recall, median lead (first flag in the window; capped at 30 d by construction), false alert episodes (14-day cooldown; episodes with no collision by that driver in the next 30 days; recent unresolved ones excluded) per 100 vehicles, precision, caught examples **and misses with reasons** (no precursor events / below threshold / unmatched driver).
Caveats: thresholds and weights were tuned on the same demo data (in-sample); collisions with no precursor are unpredictable; samples are small (63 collisions in the demo seed over 7 fleets).

### Demo-seed results (90-day seed, 574 incidents, 287 vehicles)
The live numbers are always in `/api/predict/portfolio` and `/api/predict/backtest`; they are deterministic for a given seed and store state (see 6c), so no figures are quoted here. Historical note from an older seed: ~71% recall, median warning ~12 days, ~12 false alert episodes per 100 vehicles over the window. By vendor: mantis 70% (7/10, conf 0.96, lead 11.7d), lytx 73%, samsara 88%, motive 67%, geotab 0% (0/4, conf 0.53, camera 32%). **Honest finding (synthetic data):** with this small seed Mantis recall/lead are comparable to other camera vendors; Mantis' measurable edge is prediction confidence (0.96 vs ~0.78), signal richness, and complete visibility vs geotab. The portfolio `insight` string only claims advantages the numbers support.

## 5. Limits
- Hand-set weights; relative frequency vs portfolio norms means a fleet's score depends on the portfolio it is compared against.
- Absent signal != safe: unobserved camera-derived indicators lower confidence but also understate risk.
- 90 days of history bounds EWMA/trend quality; fleets with < 30 days get wide bands.
- The demo seed's collision frequency exceeds the model's plausibility ceiling; fleets with many collisions are under-stated in absolute terms (gamma capped at 1.5).
- Local-time patterns assume UTC-5 for all fleets.
- Alerts are in-memory plus `db.put('alert')`; acknowledgement state survives restarts only with Postgres.

## 6b. Honesty and labeling
Every predictive payload is illustrative output of a hand-weighted model on **synthetic** data. `portfolio`, `backtest`, `fleet/:id`, `model` and `simulate-what-if` include `illustrative:true`, `label`, `disclaimer` and a `provenance` block (`src/predict/provenance.js`): `data:"synthetic"`, `validated:false`, `method`, `assumptions[]`, `limitations[]`. Human-readable backend text uses "modeled collision-risk indicator (illustrative)" rather than collision probability; JSON keys such as `collisionProb30d` are unchanged for UI compatibility. Nothing here is evidence of real-world performance of Mantis or any other vendor.

## 6c. Determinism
Earlier, backtest recall varied between calls (e.g. 61% vs 69%) because each fleet analysis and the calibration were anchored to `Date.now()` and were recomputed on a 5-minute cache TTL or at different times per fleet, shifting every window. The model clock is now `anchor()` in `data.js`: the newest non-imported event timestamp rounded up to the hour (fleets whose own data is >14 days older keep their historical rule). Same seed + same store state therefore gives identical output regardless of cache expiry; adding a live event moves the anchor. No `Math.random` is used in the model. `scripts/check-consistency.js` calls backtest and portfolio twice and asserts identical JSON (ignoring `generatedAt`/`computeMs`).

## 7. Vendor-comparison metrics: one calculation source
All vendor/group comparison figures come from `portfolio.js statsFor()` over the per-fleet analyses. `GET /portfolio` (`byVendor`, `comparison`, `insight`) and `GET /backtest` (overall) use it; `fleet/:id` and `backtest?fleetId=` expose the same per-fleet numbers. Aggregation rules:

| metric | aggregation | population |
|---|---|---|
| `cameraCoveragePct` | vehicle-weighted mean of fleet coverage | all vehicles in the group |
| `predictionConfidence` / `avgPredictionConfidence` | vehicle-weighted mean of fleet confidence | all fleets in the group |
| `avgRisk` | vehicle-weighted mean of predicted fleet risk | all fleets in the group |
| `recallPct` / `backtestRecallPct` | pooled: collisions flagged ahead / all collisions | all backtest collisions in the group |
| `avgLeadDays` (= `meanLeadDays`), `medianLeadDays` | pooled over every flagged-ahead collision (never a mean of fleet medians) | flagged-only; misses excluded; capped at 30 d |

`portfolio.comparison` = `{basis,population,aggregation,period,metrics,significant:false,significanceNote,mantis,otherVendors,delta}` where `mantis` and `otherVendors` are `statsFor` results `{n{fleets,vehicles,backtestCollisions,backtestCaught,leadSamples},avgRisk,predictionConfidence,cameraCoveragePct,recallPct,meanLeadDays,medianLeadDays}`. "Other vendors" is ONE pooled group, not an unweighted average of vendor rows. The earlier mismatch (11.2 vs 7.6 days) came from the intro using a caught-weighted mean while a UI section averaged vendor rows without weights; UIs should read `comparison` instead of averaging `byVendor` themselves. `backtest.basis` labels the overall backtest (`population`, `aggregation`, `period`, `n`). Per-fleet `medianLeadDays` on `portfolio.fleets[]` is that fleet's own median (basis: single fleet). The insurer portfolio's `byVendor[].avgRisk` (src/analytics.js) is a different, event-based metric and is labeled as such. Run `node scripts/check-consistency.js` to assert agreement.

On the current synthetic seed the pooled comparison shows Mantis higher on model confidence (0.96 vs 0.78) and camera coverage, comparable on recall (70% vs 68%) and slightly lower on mean lead time (12.4 vs 13.8 days); the generated `insight` text only states advantages the numbers support and always carries the synthetic/small-sample caveat.

## 6. Files
`config.js` constants/weights/interventions - `features.js` event tagging + driver state - `model.js` math - `analyze.js` fleet analysis, backtest, hotspots, what-if - `alerts.js` rules/store - `portfolio.js` - `data.js` loaders, cache, hooks, SSE - `fixture.js` synthetic 7-fleet/90-day generator - `selftest.js` (`node src/predict/selftest.js`, invariants incl. probability bounds) - `selftest-seed.js` (seeds in-process; asserts bounds and that directions differ across fleets) - `index.js` (`fleetProjection(fleetId)`, `onBoot`, `alerts`).
Extra endpoints beyond the addendum: `GET /api/predict/interventions`, `GET /api/predict/model`.
