// Geotab (MyGeotab data feed / webhook relay) payload. Note: speed in km/h, odometer in meters.
const RULE = { collision: 'Possible Accident', rollover: 'Possible Rollover', harsh_brake: 'Harsh Braking', harsh_accel: 'Harsh Acceleration', harsh_turn: 'Harsh Cornering', speeding: 'Speeding', distracted: 'Driver Distraction', following_distance: 'Following Distance', tire: 'Tire Pressure', battery: 'Battery Voltage' };
function build(s) {
  const host = 'https://media.nexus-demo.invalid/geotab';
  const [fn, ...ln] = String(s.driver.name).split(' ');
  const d = {
    id: s.eventId, activeFrom: s.timestamp, database: s.companyId || 'demo_database',
    device: { id: s.vehicle.providerVehicleId, name: s.vehicle.unit, vehicleIdentificationNumber: s.vehicle.vin, licensePlate: s.vehicle.plate, engineVehicleIdentificationNumber: s.vehicle.vin },
    driver: { id: s.driver.providerDriverId, firstName: fn, lastName: ln.join(' '), mobilePhone: s.driver.phone },
    latitude: s.location.lat, longitude: s.location.lng, address: s.location.address, speedKph: Math.round(s.location.speed_mph * 1.60934 * 10) / 10, bearing: s.location.heading,
    odometerMeters: Math.round(s.odometer_mi * 1609.344), engineHours: s.engineHours,
  };
  if (s.dtcs && s.dtcs.length && ['fault_code', 'breakdown'].includes(s.eventType)) {
    d.type = 'FaultData';
    d.faultData = s.dtcs.map((x) => ({ diagnostic: { code: x.spn != null ? x.spn : x.code, name: x.desc || (x.spn != null ? `SPN ${x.spn}` : x.code) }, failureMode: { code: x.fmi != null ? x.fmi : 0, name: 'FMI' }, faultState: 'Active', count: 1, dateTime: s.timestamp, malfunctionLamp: !!s.faultLamp }));
  } else {
    d.type = 'ExceptionEvent';
    d.rule = { id: 'b_' + (RULE[s.eventType] || 'Other').replace(/\W/g, ''), name: RULE[s.eventType] || 'Other' };
    if (s.gForce != null) d.peakAccelerationG = s.gForce;
    if (s.airbag) d.airbagDeployed = true;
    if (s.hasCamera) {
      d.camera = { partner: 'Surfsight', clipUrl: `${host}/${s.eventId}/clip.mp4`, snapshotUrl: `${host}/${s.eventId}/frame.jpg` };
      if (s.aiLabel) d.camera.ai = { label: s.aiLabel, confidence: s.aiConfidence };
    }
    if (s.roadSurface) d.roadSurface = s.roadSurface;
  }
  return { apiVersion: 'v1', type: d.type, data: d };
}
module.exports = { build };
