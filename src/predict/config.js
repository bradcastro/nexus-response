// Predict engine constants. DEMO-CALIBRATED: weights are hand-set from published fleet-safety research directions
// (tailgating, phone use and fatigue are the strongest leading indicators of rear-end/lane-departure crashes), then tuned
// against the synthetic + seeded demo data so the backtest is realistic. They are NOT fitted to real loss data.
// Documented in docs/PREDICT.md.

const DAY = 86400000;

// Indicators. ref = "typical" weekly EWMA rate per driver (f = rate/ref, capped at F_CAP). beta = logit weight per unit f.
// camera = needs a camera (driver-facing or road-facing AI) to be observed at all.
const INDICATORS = [
  { key: 'following_distance', label: 'Tailgating / following distance', beta: 0.55, ref: 0.30, camera: true, minShare: 0.20, unit: 'events' },
  { key: 'harsh_braking', label: 'Harsh braking', beta: 0.42, ref: 0.35, camera: false, unit: 'events' },
  { key: 'harsh_maneuver', label: 'Harsh acceleration / cornering', beta: 0.22, ref: 0.35, camera: false, unit: 'events' },
  { key: 'phone_use', label: 'Phone use / distraction', beta: 0.78, ref: 0.20, camera: true, minShare: 0.15, unit: 'events' },
  { key: 'drowsiness', label: 'Drowsiness / fatigue', beta: 0.85, ref: 0.12, camera: true, minShare: 0.05, unit: 'events' },
  { key: 'speeding', label: 'Speeding', beta: 0.30, ref: 0.35, camera: false, unit: 'events' },
  { key: 'lane_departure', label: 'Lane departure', beta: 0.45, ref: 0.15, camera: true, minShare: 0.06, unit: 'events' },
  { key: 'near_miss', label: 'Camera-verified near-misses', beta: 0.38, ref: 0.15, camera: true, minShare: 0.1, unit: 'events' },
  { key: 'night_hours', label: 'Night-hour risk events', beta: 0.25, ref: 0.20, camera: false, unit: 'events' },
  { key: 'maintenance_backlog', label: 'DTC / maintenance backlog', beta: 0.28, ref: 0.20, camera: false, unit: 'events', vehicle: true },
];
const IND = Object.fromEntries(INDICATORS.map((i) => [i.key, i]));
const BEHAVIOR_KEYS = INDICATORS.filter((i) => i.key !== 'maintenance_backlog' && i.key !== 'night_hours').map((i) => i.key);

const MODEL = {
  F_CAP: 6,                     // cap on f = ln(1 + rate/norm)
  HALF_LIFE_DAYS: 14,           // EWMA half-life for driver indicator rates
  BETA_ESCALATION: 0.55,        // extra weight for a 2-4 week escalation (the pre-accident signature)
  BETA_PRIOR_COLLISION: 0.35,   // driver had a collision in the last 90d
  P_MIN: 0.004,                 // floor: baseline exposure risk of a driver with no flagged behavior (= BASE_P30 / 3, set with the base)
  BASE_P30: 0.012,              // reference 30-day collision probability for the average portfolio driver. MUTABLE: calibrate() re-bases it to the portfolio's observed collision rate (floor 0.8%, cap 8%)
  BASE_PRIOR: 0.012, BASE_PRIOR_WEIGHT: 100, // Poisson-gamma prior for that re-basing (prior mean 1.2% worth 100 driver-months)
  CENTER_F: 0.35,               // typical f for an average driver (most weeks have no event for most indicators)
  TEMP: 0.5,                    // global scale on the weighted sum (spreads the probability distribution so the top of the ranking is not saturated)
  P_HARD: 0.4,                  // ceiling after the fleet gamma multiplier
  P_CAP: 0.25,                   // soft-saturation scale and hard ceiling for any single driver's 30-day probability
  GAMMA_PRIOR: 3,               // Poisson-gamma pseudo-collisions for fleet calibration shrinkage
  GAMMA_MIN: 0.6, GAMMA_MAX: 1.5,
  TZ_OFFSET_H: -5,              // local time for hour-of-day patterns (demo fleets are US Eastern/Central)
  NIGHT_HOURS: [22, 23, 0, 1, 2, 3, 4, 5],
  RISK_REF_PER_100: 1.5,        // reference collisions per 100 vehicles per 30d => score 50
  RISK_SLOPE: 22,               // score = 50 + slope * ln(rate/ref)
  LOOKBACK_DAYS: 90,
  TREND_WINDOW: 14,
  TREND_BASE_WINDOW: 28,
  PROJ_DAMP_DAYS: 21,
};

// Backtest / alert thresholds on the absolute driver 30d collision probability.
const ALERT = {
  FLAG_MULT: 2.6,              // driver flagged when model p30 >= 2.6x the reference (portfolio-average) driver
  WATCH_MULT: 1.9,
  ESC_FLAG: 1.5, ESC_MIN_MULT: 1.7,   // or: sharp 2-4 week escalation AND p30 >= 1.7x reference
  get P_FLAG() { return MODEL.BASE_P30 * this.FLAG_MULT; },
  get P_WATCH() { return MODEL.BASE_P30 * this.WATCH_MULT; },
  get ESC_MIN_P() { return MODEL.BASE_P30 * this.ESC_MIN_MULT; },
  LEAD_WINDOW_DAYS: 30,        // collision counted as "caught" if driver flagged within 30d before it
  COOLDOWN_DAYS: 14,
  MIN_HISTORY_DAYS: 14,
};

// Money: demo assumptions (labelled in docs/PREDICT.md).
const COST = { collisionUsd: 62000, nonCollisionIncidentUsd: 300, maintenanceEventUsd: 950, breakdownUsd: 1900, cargoShare: 0.35 };

// Intervention library: effect = fractional reduction of indicator f for targeted drivers; targeting rule = who is targeted.
const INTERVENTIONS = [
  { key: 'targeted_coaching', label: 'Targeted coaching for top-risk drivers', target: 'top_drivers', topN: 0.12, effects: { following_distance: 0.35, harsh_braking: 0.35, harsh_maneuver: 0.30, phone_use: 0.30, speeding: 0.30, lane_departure: 0.25, near_miss: 0.30 }, costPerDriverUsd: 180, assumption: 'Coaching of the highest-risk 12% of drivers reduces their targeted behaviors 25-35% within 6-8 weeks.' },
  { key: 'following_distance_alerts', label: 'In-cab following-distance alerts (tailgating)', target: 'indicator:following_distance', effects: { following_distance: 0.40, near_miss: 0.15 }, costPerDriverUsd: 60, assumption: 'Real-time audible alerts reduce tailgating ~40% for drivers who tailgate regularly.' },
  { key: 'fatigue_program', label: 'Fatigue management (rest rules + drowsiness alerts)', target: 'indicator:drowsiness', effects: { drowsiness: 0.50, lane_departure: 0.30, night_hours: 0.25 }, costPerDriverUsd: 120, assumption: 'Fatigue alerts + rest-window enforcement cut drowsiness events ~50%.' },
  { key: 'phone_policy', label: 'Phone-use enforcement (camera-detected, same-day coaching)', target: 'indicator:phone_use', effects: { phone_use: 0.55 }, costPerDriverUsd: 70, assumption: 'Same-day camera-triggered coaching reduces phone use ~55%.' },
  { key: 'speed_governance', label: 'Speed governance / speed alerts', target: 'indicator:speeding', effects: { speeding: 0.45, harsh_braking: 0.10 }, costPerDriverUsd: 50, assumption: 'Speed limiter or alert policy lowers speeding events ~45%.' },
  { key: 'night_dispatch_limits', label: 'Night dispatch / hours-of-service guardrails', target: 'indicator:night_hours', effects: { night_hours: 0.45, drowsiness: 0.25 }, costPerDriverUsd: 90, assumption: 'Limiting late-night dispatch lowers night exposure ~45%.' },
  { key: 'preventive_maintenance', label: 'Preventive maintenance sweep (clear DTC backlog)', target: 'vehicles_with_dtc', effects: { maintenance_backlog: 0.70, harsh_braking: 0.05 }, costPerDriverUsd: 140, assumption: 'Clearing open fault codes removes ~70% of maintenance-backlog risk.' },
  { key: 'hotspot_rerouting', label: 'Re-route / brief drivers around forming hotspots', target: 'all', effects: { harsh_braking: 0.08, near_miss: 0.10, following_distance: 0.05 }, costPerDriverUsd: 15, assumption: 'Route briefings reduce exposure at hotspots ~8-10%.' },
];

module.exports = { DAY, INDICATORS, IND, BEHAVIOR_KEYS, MODEL, ALERT, COST, INTERVENTIONS };
