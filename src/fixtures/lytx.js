// Lytx DriveCam-style event payload (ML-vision labels included).
const BEHAV = { collision: 'Collision', rollover: 'Rollover', harsh_brake: 'Hard Braking', harsh_accel: 'Hard Acceleration', harsh_turn: 'Hard Cornering', speeding: 'Speeding', distracted: 'Cell Phone', following_distance: 'Following Distance', tire: 'Tire Pressure', battery: 'Low Battery', fault_code: 'Vehicle Diagnostic', breakdown: 'Vehicle Diagnostic' };
function build(s) {
  const host = 'https://media.nexus-demo.invalid/lytx';
  const [fn, ...ln] = String(s.driver.name).split(' ');
  const p = {
    eventId: s.eventId, eventTimestamp: s.timestamp, groupId: s.companyId || 'lytx_grp_demo', eventSource: 'DriveCam',
    behaviors: [{ id: 'b_' + (BEHAV[s.eventType] || 'Other').toLowerCase().replace(/\W/g, ''), name: BEHAV[s.eventType] || 'Other' }],
    vehicle: { id: s.vehicle.providerVehicleId, name: s.vehicle.unit, vin: s.vehicle.vin, registrationNumber: s.vehicle.plate, make: s.vehicle.make, model: s.vehicle.model, year: s.vehicle.year, odometerMiles: s.odometer_mi },
    driver: { employeeNum: s.driver.providerDriverId, firstName: fn, lastName: ln.join(' '), mobile: s.driver.phone },
    gps: { lat: s.location.lat, lon: s.location.lng, address: s.location.address, speedMph: s.location.speed_mph, heading: s.location.heading },
  };
  if (s.gForce != null) p.triggerForce = { longitudinalG: s.gForce, lateralG: Math.round(s.gForce * 0.35 * 10) / 10, peakG: s.gForce };
  if (s.airbag) p.airbagDeployed = true;
  if (s.hasCamera) {
    p.video = { forwardUrl: `${host}/${s.eventId}/road.mp4`, driverUrl: `${host}/${s.eventId}/driver.mp4`, snapshotUrl: `${host}/${s.eventId}/road.jpg`, durationSec: 12 };
    p.mlResult = { label: s.aiLabel || null, confidence: s.aiConfidence != null ? s.aiConfidence : null, model: 'lytx-ml-v4', driverFacingForward: s.facingForward !== false };
  }
  if (s.dtcs && s.dtcs.length) p.vehicleGateway = { milOn: !!s.faultLamp, engineHours: s.engineHours, dtcs: s.dtcs.map((d) => ({ spn: d.spn, fmi: d.fmi, code: d.code, description: d.desc })) };
  if (s.roadSurface) p.roadSurface = s.roadSurface;
  if (s.postedLimit) p.postedSpeedLimitMph = s.postedLimit;
  return p;
}
module.exports = { build };
