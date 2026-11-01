// Samsara webhook-shaped payload (SafetyEvent / DtcEvent).
const MAP = { collision: 'Crash', rollover: 'Rollover', harsh_brake: 'HarshBrake', harsh_accel: 'HarshAcceleration', harsh_turn: 'HarshTurn', speeding: 'MaxSpeed', distracted: 'MobileUsage', following_distance: 'FollowingDistance', tire: 'TirePressure', battery: 'LowBattery' };
function build(s) {
  const host = 'https://media.nexus-demo.invalid/samsara';
  const diag = s.dtcs && s.dtcs.length && ['fault_code', 'breakdown'].includes(s.eventType);
  const data = {
    vehicle: { id: s.vehicle.providerVehicleId, name: s.vehicle.unit, licensePlate: s.vehicle.plate, externalIds: { 'samsara.vin': s.vehicle.vin }, make: s.vehicle.make, model: s.vehicle.model, year: s.vehicle.year },
    driver: { id: s.driver.providerDriverId, name: s.driver.name, phone: s.driver.phone },
    gps: { latitude: s.location.lat, longitude: s.location.lng, reverseGeo: { formattedLocation: s.location.address }, speedMilesPerHour: s.location.speed_mph, headingDegrees: s.location.heading },
    odometerMeters: Math.round(s.odometer_mi * 1609.344), engineSeconds: Math.round((s.engineHours || 0) * 3600),
  };
  let eventType;
  if (diag) {
    eventType = 'DtcEvent';
    data.dtcs = s.dtcs.map((d) => ({ spnId: d.spn, fmiId: d.fmi, obdiiCode: d.code && !d.spn ? d.code : undefined, description: d.desc || undefined, txId: 0, occurrenceCount: 1 }));
    data.checkEngineLight = !!s.faultLamp;
  } else {
    eventType = 'SafetyEvent';
    data.behaviorLabels = [{ label: MAP[s.eventType] || 'Other', source: 'automatic' }];
    if (s.gForce != null) data.maxAccelerationGForce = s.gForce;
    if (s.airbag) data.airbagDeployed = true;
    if (s.hasCamera) {
      data.media = { forwardVideoUrl: `${host}/${s.eventId}/forward.mp4`, inwardVideoUrl: `${host}/${s.eventId}/inward.mp4`, forwardSnapshotUrl: `${host}/${s.eventId}/forward.jpg` };
      if (s.aiLabel) data.aiDetections = [{ label: s.aiLabel, confidence: s.aiConfidence }];
      if (s.facingForward != null) data.driverFacingForward = s.facingForward;
    }
    if (s.roadSurface) data.roadSurface = s.roadSurface;
    if (s.postedLimit) data.postedSpeedLimitMph = s.postedLimit;
  }
  return { eventId: s.eventId, eventType, eventMs: Date.parse(s.timestamp), orgId: s.companyId || 'org_samsara_demo', webhookId: 'wh_demo', data };
}
module.exports = { build };
