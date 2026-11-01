const { verifyHmac, num, clip, snap, compact, skeleton } = require('./common');
const LABEL = (l = '') => {
  l = String(l).toLowerCase();
  if (/rollover/.test(l)) return 'rollover';
  if (/crash|collision/.test(l)) return 'collision';
  if (/harshbrak|hardbrak/.test(l)) return 'harsh_brake';
  if (/harshacc|hardacc/.test(l)) return 'harsh_accel';
  if (/harshturn|corner/.test(l)) return 'harsh_turn';
  if (/speed/.test(l)) return 'speeding';
  if (/mobile|distract|drows|inattent/.test(l)) return 'distracted';
  if (/following/.test(l)) return 'following_distance';
  if (/tire/.test(l)) return 'tire';
  if (/battery/.test(l)) return 'battery';
  return 'other';
};
function verify(req) { return verifyHmac(req, 'SAMSARA_WEBHOOK_SECRET', ['x-samsara-signature', 'x-webhook-signature']); }

function normalize(payload) {
  const d = payload.data || {};
  const inc = skeleton('samsara', payload.eventId, payload.eventMs || payload.eventTime);
  inc.raw = payload;
  const isDtc = /dtc|fault/i.test(payload.eventType || '') || (d.dtcs && d.dtcs.length && !d.behaviorLabels);
  inc.eventType = isDtc ? 'fault_code' : LABEL(d.behaviorLabels && d.behaviorLabels[0] && d.behaviorLabels[0].label);
  const v = d.vehicle || {};
  inc.vehicle = { providerVehicleId: v.id != null ? String(v.id) : null, unit: v.name || null, vin: (v.externalIds && v.externalIds['samsara.vin']) || v.vin || null, plate: v.licensePlate || null, make: v.make || null, model: v.model || null, year: num(v.year), odometer_mi: d.odometerMeters != null ? Math.round(d.odometerMeters / 1609.344) : null };
  const dr = d.driver || {};
  inc.driver = { providerDriverId: dr.id != null ? String(dr.id) : null, name: dr.name || null, phone: dr.phone || null };
  const g = d.gps || {};
  inc.location = { lat: num(g.latitude), lng: num(g.longitude), address: (g.reverseGeo && g.reverseGeo.formattedLocation) || null, speed_mph: num(g.speedMilesPerHour), heading: num(g.headingDegrees) };
  const m = d.media || {};
  inc.camera.clips = compact([clip(m.forwardVideoUrl, 'road'), clip(m.inwardVideoUrl, 'driver')]);
  inc.camera.snapshots = compact([snap(m.forwardSnapshotUrl)]);
  const ai = (d.aiDetections && d.aiDetections[0]) || {};
  inc._hints = { gForce: num(d.maxAccelerationGForce), airbag: !!d.airbagDeployed, aiLabel: ai.label, aiConfidence: num(ai.confidence), facingForward: d.driverFacingForward, roadSurface: d.roadSurface, postedLimit: num(d.postedSpeedLimitMph), speedAtEvent: num(g.speedMilesPerHour) };
  inc._dtcRaw = (d.dtcs || []).map((x) => ({ spn: x.spnId, fmi: x.fmiId, code: x.obdiiCode, desc: x.description }));
  inc._engineHours = d.engineSeconds != null ? Math.round(d.engineSeconds / 360) / 10 : null;
  inc._faultLamp = d.checkEngineLight != null ? !!d.checkEngineLight : inc._dtcRaw.length > 0;
  inc._companyId = payload.orgId || null;
  return inc;
}
module.exports = { provider: 'samsara', verify, normalize };
