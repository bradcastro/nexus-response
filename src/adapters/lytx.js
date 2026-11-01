const { verifyHmac, num, clip, snap, compact, skeleton } = require('./common');
const BEH = (b = '') => {
  b = String(b).toLowerCase();
  if (/rollover/.test(b)) return 'rollover';
  if (/collision|crash/.test(b)) return 'collision';
  if (/hard brak|harsh brak/.test(b)) return 'harsh_brake';
  if (/hard acc|harsh acc/.test(b)) return 'harsh_accel';
  if (/corner|turn/.test(b)) return 'harsh_turn';
  if (/speed/.test(b)) return 'speeding';
  if (/cell|phone|distract|food|smok|drows/.test(b)) return 'distracted';
  if (/following|tailgat/.test(b)) return 'following_distance';
  if (/diagnostic|fault/.test(b)) return 'fault_code';
  if (/tire/.test(b)) return 'tire';
  if (/battery/.test(b)) return 'battery';
  return 'other';
};
function verify(req) { return verifyHmac(req, 'LYTX_WEBHOOK_SECRET', ['x-lytx-signature', 'x-webhook-signature']); }

function normalize(p) {
  const inc = skeleton('lytx', p.eventId, p.eventTimestamp);
  inc.raw = p;
  inc.eventType = BEH(p.behaviors && p.behaviors[0] && p.behaviors[0].name);
  const v = p.vehicle || {};
  inc.vehicle = { providerVehicleId: v.id != null ? String(v.id) : null, unit: v.name || null, vin: v.vin || null, plate: v.registrationNumber || null, make: v.make || null, model: v.model || null, year: num(v.year), odometer_mi: num(v.odometerMiles) };
  const d = p.driver || {};
  inc.driver = { providerDriverId: d.employeeNum != null ? String(d.employeeNum) : null, name: compact([d.firstName, d.lastName]).join(' ') || null, phone: d.mobile || null };
  const g = p.gps || {};
  inc.location = { lat: num(g.lat), lng: num(g.lon), address: g.address || null, speed_mph: num(g.speedMph), heading: num(g.heading) };
  const vid = p.video || {};
  inc.camera.clips = compact([clip(vid.forwardUrl, 'road', vid.durationSec || 12), clip(vid.driverUrl, 'driver', vid.durationSec || 12)]);
  inc.camera.snapshots = compact([snap(vid.snapshotUrl)]);
  const ml = p.mlResult || {};
  inc._hints = { gForce: num(p.triggerForce && (p.triggerForce.peakG ?? p.triggerForce.longitudinalG)), airbag: !!p.airbagDeployed, aiLabel: ml.label, aiConfidence: num(ml.confidence), facingForward: ml.driverFacingForward, roadSurface: p.roadSurface, postedLimit: num(p.postedSpeedLimitMph), speedAtEvent: inc.location.speed_mph };
  const gw = p.vehicleGateway || {};
  inc._dtcRaw = (gw.dtcs || []).map((x) => ({ spn: x.spn, fmi: x.fmi, code: x.code, desc: x.description }));
  inc._engineHours = num(gw.engineHours);
  inc._faultLamp = !!gw.milOn;
  inc._companyId = p.groupId || null;
  return inc;
}
module.exports = { provider: 'lytx', verify, normalize };
