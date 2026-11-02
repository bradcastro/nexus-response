// Core math: weighted logistic collision probability, score mapping, calibration, projections.
const { INDICATORS, IND, MODEL, ALERT } = require('./config');

const sigmoid = (z) => 1 / (1 + Math.exp(-z));
const logit = (p) => Math.log(p / (1 - p));
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const round = (n, d = 0) => { const p = 10 ** d; return Math.round(n * p) / p; };

// z = beta0 + sum(beta_k * f_k) + betaEsc*esc + betaColl*fcoll
function linear(state, beta0, scale) {
  let z = 0;
  for (const k of INDICATORS) z += k.beta * state.f[k.key];
  z += MODEL.BETA_ESCALATION * state.esc + MODEL.BETA_PRIOR_COLLISION * state.fcoll;
  return beta0 + MODEL.TEMP * z;
}
// p = P_MIN + (1-P_MIN) * sigmoid(z): even a driver with zero flagged behavior carries baseline exposure risk.
// Soft saturation (monotonic) keeps the top of the ranking from piling up at a hard cap: p = cap * (1 - exp(-raw/cap)).
const soft = (raw) => MODEL.P_CAP * (1 - Math.exp(-raw / MODEL.P_CAP));
const prob = (state, beta0) => soft(MODEL.P_MIN + (1 - MODEL.P_MIN) * sigmoid(linear(state, beta0)));

// 50 at reference rate; +/-22 per e-fold.
function scoreFromRatio(ratio) { return clamp(50 + MODEL.RISK_SLOPE * Math.log(Math.max(ratio, 1e-3)), 0, 100); }
const driverScore = (p) => scoreFromRatio(p / MODEL.BASE_P30);

function setBase(base) { MODEL.BASE_P30 = base; MODEL.P_MIN = base / 3; }

// Bisect beta0 so the mean probability across the calibration population equals BASE_P30.
function solveBeta0(states) {
  if (!states.length) return logit(MODEL.BASE_P30) - 3;
  let lo = -20, hi = 5;
  for (let it = 0; it < 50; it++) {
    const mid = (lo + hi) / 2;
    let m = 0; for (const s of states) m += prob(s, mid);
    m /= states.length;
    if (m > MODEL.BASE_P30) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
}

// Contribution of each indicator to a state's linear predictor (for explanations).
function contributions(state) {
  const out = INDICATORS.map((k) => ({ key: k.key, label: k.label, contrib: MODEL.TEMP * k.beta * state.f[k.key] }));
  out.push({ key: 'escalation', label: '2-4 week escalation', contrib: MODEL.TEMP * MODEL.BETA_ESCALATION * state.esc });
  out.push({ key: 'prior_collision', label: 'Recent collision', contrib: MODEL.TEMP * MODEL.BETA_PRIOR_COLLISION * state.fcoll });
  return out.sort((a, b) => b.contrib - a.contrib);
}

// Damped trend extrapolation of the f vector.
function projectState(now, prev14, deltaDays) {
  const damp = MODEL.PROJ_DAMP_DAYS * (1 - Math.exp(-deltaDays / MODEL.PROJ_DAMP_DAYS));
  const f = {};
  const rev = 1 - Math.exp(-deltaDays / 45);
  for (const k of INDICATORS) {
    const slope = (now.f[k.key] - prev14.f[k.key]) / MODEL.TREND_WINDOW;
    // half damped-slope extrapolation, half reversion toward the driver's own long-run level
    f[k.key] = clamp(now.f[k.key] + 0.5 * slope * damp + 0.5 * rev * ((now.flr ? now.flr[k.key] : now.f[k.key]) - now.f[k.key]), 0, MODEL.F_CAP);
  }
  return { f, flr: now.flr, esc: now.esc * Math.exp(-deltaDays / 28), fcoll: now.fcoll * Math.exp(-deltaDays / 60), raw: now.raw };
}

// Scale f for targeted drivers/indicators (intervention what-if).
function applyEffects(state, effects) {
  const f = { ...state.f };
  for (const [k, e] of Object.entries(effects)) if (f[k] != null) f[k] = Math.log1p(Math.expm1(f[k]) * (1 - e)); // cut the underlying rate by e
  // escalation is a behavioural trend: coaching also cools it by the mean behavioural effect
  const effs = Object.entries(effects).filter(([k]) => k !== 'maintenance_backlog').map(([, e]) => e);
  const mean = effs.length ? effs.reduce((a, b) => a + b, 0) / effs.length : 0;
  return { ...state, f, esc: state.esc * (1 - mean * 0.8) };
}

function bandMultiplier(expectedEvents, confidence, deltaDays, z = 1.28) {
  const sPois = 1 / Math.sqrt(expectedEvents + 1);
  const sModel = (0.10 + 0.30 * (1 - confidence)) * Math.sqrt(deltaDays / 30 + 0.2);
  const s = Math.sqrt(sPois * sPois + sModel * sModel);
  return { lo: Math.exp(-z * s), hi: Math.exp(z * s), sigma: s };
}

module.exports = { setBase, sigmoid, logit, clamp, round, linear, prob, driverScore, scoreFromRatio, solveBeta0, contributions, projectState, applyEffects, bandMultiplier };
