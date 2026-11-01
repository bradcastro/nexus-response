const { verifyHmac, num, clip, snap, compact, skeleton } = require('./common');
const MAP = (t = '') => {
  t = String(t).toLowerCase();
  if (/rollover/.test(t)) return 'rollover';
  if (/collision|crash|accident/.test(t)) return 'collision';
  if (/hard_brake|harsh_brak/.test(t)) return 'harsh_brake';
  if (/hard_accel|harsh_accel/.test(t)) return 'harsh_accel';
  if (/hard_turn|harsh_turn|corner/.test(t)) return 'harsh_turn';
  if (/speed/.test(t)) return 'speeding';
  if (/distract|phone|cell/.test(t)) return 'distracted';
  if (/following/.test(t)) return 'following_distance';
  if (/fault|dtc/.test(t)) return 'fault_code';
  if (/tire|tyre/.test(t)) return 'tire';
  if (/battery/.test(t)) return 'battery';
  return 'other';
};

function verify(req) {
  // Legacy header names preserved: x-motive-signature / x-webhook-signature (value "sha256=<hex>")
  return verifyHmac(req, 'MOTIVE_WEBHOOK_SECRET', ['x-motive-signature', 'x-webhook-signature']);
}

function normalize(payload) {
  const e = payload.event || payload;
  const inc = skeleton('motive', e.id, e.occurred_at || e.timestamp);
  inc.raw = payload;
  inc.eventType = MAP(e.type || e.event_type);
  const v = e.vehicle || {};
  inc.vehicle = { providerVehicleId: v.id != null ? String(v.id) : null, unit: v.number || null, vin: v.vin || e.vin || null, plate: v.license_plate || null, make: v.make || null, model: v.model || null, year: num(v.year), odometer_mi: num(e.odometer) };
  const d = e.driver || {};
  inc.driver = { providerDriverId: d.id != null ? String(d.id) : null, name: d.name || compact([d.first_name, d.last_name]).join(' ') || null, phone: d.phone_number || d.phone || null };
  const l = e.location || {};
  inc.location = { lat: num(l.lat ?? e.lat), lng: num(l.lon ?? l.lng ?? e.lon), address: l.formatted_address || l.address || null, speed_mph: num(e.speed_mph), heading: num(e.bearing) };
  const vid = e.video_url || e.dashcam_url;
  inc.camera.clips = compact([clip(vid, 'road'), clip(e.driver_facing_video_url, 'driver')]);
  inc.camera.snapshots = compact([snap(e.snapshot_url)]);
  inc._hints = { gForce: num(e.g_force), airbag: !!e.airbag_deployed, aiLabel: e.ai_detection && e.ai_detection.label, aiConfidence: e.ai_detection && num(e.ai_detection.confidence), facingForward: e.driver_facing_forward, roadSurface: e.road_surface, postedLimit: num(e.posted_speed_limit_mph), speedAtEvent: num(e.speed_mph) };
  inc._dtcRaw = (e.fault_codes || []).map((f) => ({ spn: f.spn, fmi: f.fmi, code: f.code, desc: f.description }));
  inc._engineHours = num(e.engine_hours);
  inc._faultLamp = e.mil_status != null ? !!e.mil_status : inc._dtcRaw.length > 0;
  inc._companyId = e.company_id || e.fleet_id || null;
  return inc;
}
module.exports = { provider: 'motive', verify, normalize };
