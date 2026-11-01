const { verifyHmac, num, clip, snap, compact, skeleton } = require('./common');
const RULE = (r = '') => {
  r = String(r).toLowerCase();
  if (/rollover/.test(r)) return 'rollover';
  if (/accident|collision|crash/.test(r)) return 'collision';
  if (/harsh brak|hard brak/.test(r)) return 'harsh_brake';
  if (/harsh acc|hard acc/.test(r)) return 'harsh_accel';
  if (/corner|turn/.test(r)) return 'harsh_turn';
  if (/speed/.test(r)) return 'speeding';
  if (/distract|phone|fatigue/.test(r)) return 'distracted';
  if (/following/.test(r)) return 'following_distance';
  if (/tire|tyre/.test(r)) return 'tire';
  if (/battery|voltage/.test(r)) return 'battery';
  return 'other';
};
function verify(req) { return verifyHmac(req, 'GEOTAB_WEBHOOK_SECRET', ['x-geotab-signature', 'x-webhook-signature']); }

function normalize(payload) {
  const d = payload.data || payload;
  const inc = skeleton('geotab', d.id, d.activeFrom || d.dateTime);
  inc.raw = payload;
  const isFault = payload.type === 'FaultData' || (d.faultData && d.faultData.length);
  inc.eventType = isFault ? 'fault_code' : RULE(d.rule && d.rule.name);
  const dev = d.device || {};
  inc.vehicle = { providerVehicleId: dev.id != null ? String(dev.id) : null, unit: dev.name || null, vin: dev.vehicleIdentificationNumber || dev.engineVehicleIdentificationNumber || null, plate: dev.licensePlate || null, make: null, model: null, year: null, odometer_mi: d.odometerMeters != null ? Math.round(d.odometerMeters / 1609.344) : null };
  const dr = d.driver || {};
  inc.driver = { providerDriverId: dr.id != null ? String(dr.id) : null, name: compact([dr.firstName, dr.lastName]).join(' ') || dr.name || null, phone: dr.mobilePhone || null };
  inc.location = { lat: num(d.latitude), lng: num(d.longitude), address: d.address || null, speed_mph: d.speedKph != null ? Math.round(d.speedKph / 1.60934) : null, heading: num(d.bearing) };
  const cam = d.camera || {};
  inc.camera.provider = cam.partner || 'geotab';
  inc.camera.clips = compact([clip(cam.clipUrl, 'road')]);
  inc.camera.snapshots = compact([snap(cam.snapshotUrl)]);
  inc._hints = { gForce: num(d.peakAccelerationG), airbag: !!d.airbagDeployed, aiLabel: cam.ai && cam.ai.label, aiConfidence: cam.ai && num(cam.ai.confidence), roadSurface: d.roadSurface, speedAtEvent: inc.location.speed_mph };
  inc._dtcRaw = (d.faultData || []).map((f) => ({ spn: typeof f.diagnostic.code === 'number' ? f.diagnostic.code : undefined, fmi: f.failureMode && f.failureMode.code, code: typeof f.diagnostic.code === 'string' ? f.diagnostic.code : undefined, desc: f.diagnostic.name }));
  inc._engineHours = num(d.engineHours);
  inc._faultLamp = (d.faultData || []).some((f) => f.malfunctionLamp);
  inc._companyId = d.database || null;
  return inc;
}
module.exports = { provider: 'geotab', verify, normalize };
