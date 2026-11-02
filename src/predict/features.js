// Turn canonical incidents into prepared "events" with indicator tags, and compute per-driver indicator state at time t.
const { DAY, INDICATORS, IND, MODEL } = require('./config');

const RX = {
  following: /following distance|tailgat|headway/i,
  phone: /phone|looking down|cell|texting|handheld|distract|seat ?belt|smok/i,
  drowsy: /drows|fatigue|eyes? closed|yawn|microsleep|nodding/i,
  lane: /lane (departure|drift|weav)|lane-departure|drifting/i,
  coach: /coach/i,
};
const HARSH_BRAKE = new Set(['harsh_brake']);
const HARSH_MAN = new Set(['harsh_accel', 'harsh_turn']);
const MAINT = new Set(['fault_code', 'breakdown', 'tire', 'battery']);
const COLL = new Set(['collision', 'rollover']);
const BEHAVIOR_TYPES = new Set(['harsh_brake', 'harsh_accel', 'harsh_turn', 'speeding', 'distracted', 'following_distance']);

const isFalsePositive = (i) => !!(i.camera && i.camera.aiVerdict === 'false_positive');
const toMs = (t) => (typeof t === 'number' ? t : Date.parse(t));
const localHour = (ms) => (((new Date(ms).getUTCHours() + MODEL.TZ_OFFSET_H) % 24) + 24) % 24;

function sevRank(s) { return { critical: 4, high: 3, medium: 2, low: 1 }[s] || 0; }

// -> event object or null (false positives are dropped entirely)
function prepare(inc) {
  if (!inc || isFalsePositive(inc)) return null;
  const ts = toMs(inc.timestamp);
  if (!Number.isFinite(ts)) return null;
  const type = inc.eventType;
  const sigs = (inc.camera && inc.camera.signals) || [];
  const sigText = sigs.join(' | ');
  const tags = new Set();
  if (type === 'following_distance' || RX.following.test(sigText)) tags.add('following_distance');
  if (HARSH_BRAKE.has(type)) tags.add('harsh_braking');
  if (HARSH_MAN.has(type)) tags.add('harsh_maneuver');
  if (type === 'speeding') tags.add('speeding');
  if (type === 'distracted' || (type !== 'collision' && type !== 'rollover' && RX.phone.test(sigText))) {
    if (RX.drowsy.test(sigText)) tags.add('drowsiness'); else tags.add('phone_use');
  }
  if (RX.drowsy.test(sigText)) tags.add('drowsiness');
  // structured signals[] (Mantis driver/road-facing keys; other vendors get one derived signal)
  for (const sg of inc.signals || []) {
    if (!sg || !sg.triggered) continue;
    if (sg.key === 'following_distance_s') tags.add('following_distance');
    else if (sg.key === 'lane_departure') tags.add('lane_departure');
    else if (sg.key === 'drowsiness_score') tags.add('drowsiness');
    else if (sg.key === 'phone_use' || sg.key === 'eyes_off_road_s' || sg.key === 'smoking' || sg.key === 'seatbelt_unbuckled') tags.add('phone_use');
    else if (sg.key === 'forward_collision_warning') tags.add('near_miss');
  }
  if (RX.lane.test(sigText) || type === 'lane_departure') tags.add('lane_departure');
  if (inc.camera && inc.camera.aiVerdict === 'near_miss') tags.add('near_miss');
  const behavior = [...tags].filter((k) => k !== 'near_miss').length > 0;
  const hour = localHour(ts);
  if (behavior && MODEL.NIGHT_HOURS.includes(hour)) tags.add('night_hours');
  const coll = COLL.has(type);
  const maint = MAINT.has(type);
  const open = ['pending', 'validating', 'dispatched', 'en_route', 'on_scene'].includes(inc.status);
  const dtcs = (inc.diagnostics && inc.diagnostics.dtcs) || [];
  const tl = inc.timeline || [];
  const coachT = tl.filter((e) => RX.coach.test(`${e.action || ''} ${e.note || ''}`)).map((e) => toMs(e.t)).filter(Number.isFinite);
  return {
    id: inc.id, ts, type, severity: inc.severity, tags: [...tags], coll, maint, open, hour, dow: ((new Date(ts + MODEL.TZ_OFFSET_H * 3600000).getUTCDay()) + 7) % 7,
    driverId: inc.driver && inc.driver.id, driverName: inc.driver && inc.driver.name, vehicleId: inc.vehicle && inc.vehicle.id,
    lat: inc.location && inc.location.lat, lng: inc.location && inc.location.lng, road: inc.location && (inc.location.road || inc.location.address), address: inc.location && inc.location.address,
    verified: !!(inc.camera && (inc.camera.verified || (inc.camera.clips && inc.camera.clips.length))), hasCamera: !!(inc.camera && inc.camera.aiVerdict !== 'no_video'),
    sevRank: sevRank(inc.severity), signals: sigs, coachT,
    dtc: maint ? { codes: dtcs.map((d) => d.code), maxSev: dtcs.reduce((m, d) => Math.max(m, sevRank(d.severity)), 0), drivable: inc.diagnostics && inc.diagnostics.drivable, lamp: !!(inc.diagnostics && inc.diagnostics.faultLampOn), desc: dtcs[0] && dtcs[0].desc, cost: dtcs.reduce((s, d) => s + (d.estCostUsd || 0), 0) } : null,
    cargoMid: inc.load && inc.load.contents && inc.load.contents.estimatedValueUsd ? (inc.load.contents.estimatedValueUsd[0] + inc.load.contents.estimatedValueUsd[1]) / 2 : 0,
    imported: inc.source === 'historical_import',
    beh: [...tags].filter((k) => IND[k] && k !== 'night_hours' && k !== 'near_miss' && k !== 'maintenance_backlog').reduce((s, k) => s + IND[k].beta / 0.4, 0),
  };
}

const TAU = MODEL.HALF_LIFE_DAYS / Math.LN2;
// f = ln(1 + rate/norm): log-relative frequency (0 = none, ln2 = as frequent as the portfolio norm, saturating at F_CAP).
const toF = (rate, norm) => Math.min(MODEL.F_CAP, Math.log1p(Math.max(0, rate) / Math.max(norm, 1e-4)));
const fromF = (f, norm) => Math.expm1(f) * Math.max(norm, 1e-4);
// weight of one event of age a (days): exp(-a/TAU) normalised so Σ over available span = weekly rate
function decayNorm(spanDays) { return TAU * (1 - Math.exp(-Math.max(1, spanDays) / TAU)); }

// Per-driver indicator state at time t. evs: events (sorted asc) for this driver; mEvs: events for the driver's vehicle (maintenance).
// norm: portfolio norm weekly rate per indicator. spanDays: available history (days) at time t.
function driverState(evs, mEvs, t, spanDays, norm) {
  const span = Math.max(1, spanDays);
  const dn = decayNorm(spanDays);
  const rate = {}, uni = {}; // weekly EWMA rates; uniform-window counts
  for (const k of INDICATORS) { rate[k.key] = 0; uni[k.key] = 0; }
  let w14 = 0, wPrior = 0, collW = 0, n30 = 0;
  const counts30 = {};
  for (let i = evs.length - 1; i >= 0; i--) {
    const e = evs[i];
    if (e.ts >= t) continue;
    const age = (t - e.ts) / DAY;
    if (age > MODEL.LOOKBACK_DAYS) break;
    const w = Math.exp(-age / TAU);
    for (const k of e.tags) { rate[k] += w; if (age <= span) uni[k] += 1; if (age <= 30) counts30[k] = (counts30[k] || 0) + 1; }
    if (e.coll) collW += Math.exp(-age / 60);
    const bw = e.beh;
    if (bw) { if (age <= MODEL.TREND_WINDOW) w14 += bw; else if (age <= MODEL.TREND_WINDOW + MODEL.TREND_BASE_WINDOW) wPrior += bw; }
  }
  if (mEvs) {
    for (let i = mEvs.length - 1; i >= 0; i--) {
      const e = mEvs[i]; if (e.ts >= t) continue;
      const age = (t - e.ts) / DAY; if (age > MODEL.LOOKBACK_DAYS) break;
      const sevBoost = 1 + 0.25 * Math.max(0, (e.dtc ? e.dtc.maxSev : 0) - 1);
      const openBoost = e.open || (e.ts > t - 3 * DAY) ? 2 : 1;
      rate.maintenance_backlog += Math.exp(-age / TAU) * openBoost * sevBoost; if (age <= span) uni.maintenance_backlog += 1;
      if (age <= 30) counts30.maintenance_backlog = (counts30.maintenance_backlog || 0) + 1;
    }
  }
  const f = {}, raw = {}, flr = {};
  for (const k of INDICATORS) {
    flr[k.key] = toF((uni[k.key] / span) * 7, norm[k.key]);
    const wk = (rate[k.key] / dn) * 7; // events/week
    raw[k.key] = wk;
    f[k.key] = toF(wk, norm[k.key]);
  }
  const esc = Math.max(0, Math.min(3, (w14 - wPrior / (MODEL.TREND_BASE_WINDOW / MODEL.TREND_WINDOW) - 0.5) / 1.5));
  return { f, flr, raw, esc, fcoll: Math.min(1, collW), counts30 };
}

module.exports = { toF, fromF, prepare, driverState, decayNorm, isFalsePositive, toMs, localHour, BEHAVIOR_TYPES, RX, TAU };
