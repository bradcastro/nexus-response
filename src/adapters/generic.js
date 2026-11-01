const { verifyHmac, num, clip, snap, compact, skeleton } = require('./common');
const TYPES = ['collision','harsh_brake','harsh_accel','harsh_turn','speeding','rollover','distracted','following_distance','fault_code','breakdown','tire','battery','other'];
function verify(req) { return verifyHmac(req, 'GENERIC_WEBHOOK_SECRET', ['x-nexus-signature', 'x-webhook-signature']); }

function normalize(p) {
  const inc = skeleton('generic', p.event_id || p.id, p.timestamp || p.occurred_at);
  inc.raw = p;
  const t = String(p.event_type || p.type || 'other').toLowerCase().replace(/[\s-]/g, '_');
  inc.eventType = TYPES.includes(t) ? t : (/crash|accident/.test(t) ? 'collision' : /brak/.test(t) ? 'harsh_brake' : /dtc|fault/.test(t) ? 'fault_code' : 'other');
  inc.vehicle = { providerVehicleId: p.vehicle_id != null ? String(p.vehicle_id) : null, vin: p.vin || null, plate: p.plate || null, make: p.make || null, model: p.model || null, year: num(p.year), odometer_mi: num(p.odometer_mi) };
  inc.driver = { providerDriverId: p.driver_id != null ? String(p.driver_id) : null, name: p.driver_name || null, phone: p.driver_phone || null };
  inc.location = { lat: num(p.lat), lng: num(p.lng ?? p.lon), address: p.address || null, speed_mph: num(p.speed_mph), heading: num(p.heading) };
  inc.camera.clips = compact([clip(p.video_url, 'road')]);
  inc.camera.snapshots = compact([snap(p.snapshot_url)]);
  inc._hints = { gForce: num(p.g_force), airbag: !!p.airbag, aiLabel: p.ai_label, aiConfidence: num(p.ai_confidence), roadSurface: p.road_surface, speedAtEvent: num(p.speed_mph) };
  inc._dtcRaw = (p.dtcs || []).map((c) => (typeof c === 'string' ? c : c));
  inc._engineHours = num(p.engine_hours);
  inc._faultLamp = p.mil != null ? !!p.mil : inc._dtcRaw.length > 0;
  inc._companyId = p.fleet_id || null;
  if (p.severity) inc._severityHint = p.severity;
  return inc;
}
module.exports = { provider: 'generic', verify, normalize };
