// Mantis adapter - ASSUMED payload (docs/MANTIS.md). Replace field paths when the real spec arrives.
const { verifyHmac, num, clip, snap, compact, skeleton } = require('./common');
const TYPE = (t = '') => {
  t = String(t).toLowerCase();
  if (/rollover/.test(t)) return 'rollover';
  if (/collision|crash/.test(t) && !/forward/.test(t)) return 'collision';
  if (/brak/.test(t)) return 'harsh_brake';
  if (/accel/.test(t)) return 'harsh_accel';
  if (/corner|turn/.test(t)) return 'harsh_turn';
  if (/speed/.test(t)) return 'speeding';
  if (/phone|drows|fatigue|smok|distract|eyes/.test(t)) return 'distracted';
  if (/tailgat|following|forward_collision/.test(t)) return 'following_distance';
  if (/fault|dtc|diagnostic/.test(t)) return 'fault_code';
  if (/tire/.test(t)) return 'tire';
  if (/battery/.test(t)) return 'battery';
  return 'other';
};
const VERDICT = (c = '') => {
  c = String(c).toLowerCase().replace(/[\s-]/g, '_');
  if (/false/.test(c)) return 'false_positive';
  if (/confirmed_collision|collision/.test(c)) return 'confirmed_collision';
  if (/near/.test(c)) return 'near_miss';
  if (/distract|drows|phone/.test(c)) return 'distraction';
  if (/confirm/.test(c)) return 'confirmed_event';
  return null;
};
function verify(req) { return verifyHmac(req, 'MANTIS_WEBHOOK_SECRET', ['x-mantis-signature', 'x-webhook-signature']); }

function normalize(p) {
  const inc = skeleton('mantis', p.event_id || p.id, p.occurred_at || p.timestamp);
  inc.raw = p;
  inc.eventType = TYPE(p.event_type);
  const v = p.vehicle || {};
  inc.vehicle = { providerVehicleId: v.id != null ? String(v.id) : null, unit: v.unit || null, vin: v.vin || null, plate: v.plate || null, make: v.make || null, model: v.model || null, year: num(v.year), odometer_mi: num(v.odometer_mi) };
  const d = p.driver || {};
  inc.driver = { providerDriverId: d.id != null ? String(d.id) : null, name: d.name || null, phone: d.phone || null };
  const g = p.gps || {};
  inc.location = { lat: num(g.lat), lng: num(g.lng), address: g.address || null, speed_mph: num(g.speed_mph), heading: num(g.heading) };
  const m = p.media || {};
  inc.camera.clips = compact([clip(m.road_clip_url, 'road', m.clip_seconds || 16), clip(m.driver_clip_url, 'driver', m.clip_seconds || 16)]);
  inc.camera.snapshots = compact([snap(m.snapshot_url)]);
  const rf = p.road_facing || {}, df = p.driver_facing || {}, ai = p.ai || {}, ine = p.inertial || {};
  const sig = []; const strs = [];
  const add = (key, label, value, unit, triggered, text) => { if (value == null && !triggered) return; sig.push({ key, label, value: value == null ? null : value, unit: unit || null, triggered: !!triggered }); if (triggered && text) strs.push(text); };
  const spd = inc.location.speed_mph;
  add('following_distance_s', 'Following distance', num(rf.following_distance_s), 's', num(rf.following_distance_s) != null && rf.following_distance_s < 1.0, `Following distance ${rf.following_distance_s}s${spd != null ? ` at ${Math.round(spd)} mph` : ''} (< 1.0s)`);
  add('forward_collision_warning', 'Forward collision warning', rf.forward_collision_warning == null ? null : (rf.forward_collision_warning ? 1 : 0), null, rf.forward_collision_warning, 'Forward collision warning fired');
  add('lane_departure', 'Lane departure', rf.lane_departure == null ? null : (rf.lane_departure ? 1 : 0), null, rf.lane_departure, 'Lane departure without signal');
  add('drowsiness_score', 'Drowsiness score', num(df.drowsiness_score), 'score', num(df.drowsiness_score) != null && df.drowsiness_score >= 0.6, `Driver drowsiness score ${df.drowsiness_score} (threshold 0.6)`);
  add('phone_use', 'Phone use', df.phone_use == null ? null : (df.phone_use ? 1 : 0), null, df.phone_use, `Phone use detected${df.eyes_off_road_s ? ` (eyes off road ${df.eyes_off_road_s}s)` : ''}`);
  add('smoking', 'Smoking', df.smoking == null ? null : (df.smoking ? 1 : 0), null, df.smoking, 'Smoking detected in cab');
  add('seatbelt_unbuckled', 'Seatbelt', df.seatbelt_on == null ? null : (df.seatbelt_on ? 0 : 1), null, df.seatbelt_on === false, 'Seatbelt unbuckled');
  add('eyes_off_road_s', 'Eyes off road', num(df.eyes_off_road_s), 's', num(df.eyes_off_road_s) != null && df.eyes_off_road_s >= 2, `Eyes off road ${df.eyes_off_road_s}s`);
  inc.signals = sig;
  const verdict = VERDICT(ai.classification);
  const conf = num(ai.confidence);
  inc._hints = { gForce: num(ine.peak_g), airbag: !!ine.airbag_deployed, aiLabel: ai.classification, aiConfidence: conf, aiVerdict: verdict, vendorVerified: true, facingForward: df.facing_forward, roadSurface: p.road_surface, postedLimit: num(rf.speed_limit_mph), speedAtEvent: spd, extraSignals: strs, aiModel: ai.model };
  if (ai.classification && conf != null) strs.push(`Mantis AI: ${String(ai.classification).replace(/_/g, ' ')} (${Math.round(conf * 100)}%)`);
  const dg = p.diagnostics || {};
  inc._dtcRaw = (dg.dtcs || []).map((x) => ({ spn: x.spn, fmi: x.fmi, code: x.code, desc: x.description }));
  inc._engineHours = num(dg.engine_hours);
  inc._faultLamp = !!dg.mil;
  inc._companyId = p.org_id || null;
  return inc;
}
module.exports = { provider: 'mantis', verify, normalize };
