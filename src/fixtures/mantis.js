// Mantis camera-first telematics webhook payload (ASSUMED schema "mantis.event.v1" - see docs/MANTIS.md).
const TYPE = { collision: 'collision', rollover: 'rollover', harsh_brake: 'harsh_braking', harsh_accel: 'harsh_acceleration', harsh_turn: 'harsh_cornering', speeding: 'speeding', following_distance: 'tailgating', fault_code: 'vehicle_fault', breakdown: 'vehicle_fault', tire: 'tire_pressure', battery: 'low_battery' };
function build(s) {
  const m = s.mantis || {};
  const host = 'https://media.nexus-demo.invalid/mantis';
  let type = TYPE[s.eventType];
  if (s.eventType === 'distracted') type = { phone: 'phone_use', drowsy: 'drowsiness', smoking: 'smoking' }[s.distractionKind] || 'driver_distraction';
  if (s.eventType === 'other') type = s.otherKind === 'lane' ? 'lane_departure' : 'seatbelt_violation';
  const p = {
    schema: 'mantis.event.v1', event_id: s.eventId, event_type: type || 'other', occurred_at: s.timestamp, org_id: s.companyId || 'org_mantis_demo',
    vehicle: { id: s.vehicle.providerVehicleId, unit: s.vehicle.unit, vin: s.vehicle.vin, plate: s.vehicle.plate, make: s.vehicle.make, model: s.vehicle.model, year: s.vehicle.year, odometer_mi: s.odometer_mi },
    driver: { id: s.driver.providerDriverId, name: s.driver.name, phone: s.driver.phone },
    gps: { lat: s.location.lat, lng: s.location.lng, speed_mph: s.location.speed_mph, heading: s.location.heading, address: s.location.address },
  };
  if (s.gForce != null) p.inertial = { peak_g: s.gForce, airbag_deployed: !!s.airbag };
  if (s.hasCamera) {
    p.road_facing = { following_distance_s: m.followS, forward_collision_warning: !!m.fcw, lane_departure: !!m.laneDeparture, speed_limit_mph: s.postedLimit || 55 };
    p.driver_facing = { drowsiness_score: m.drowsiness, phone_use: !!m.phone, smoking: !!m.smoking, seatbelt_on: m.seatbelt !== false, eyes_off_road_s: m.eyesOff, facing_forward: s.facingForward !== false };
    p.ai = { classification: s.aiLabel, confidence: s.aiConfidence, model: 'mantis-vision-v3' };
    p.media = { road_clip_url: `${host}/${s.eventId}/road.mp4`, driver_clip_url: `${host}/${s.eventId}/driver.mp4`, snapshot_url: `${host}/${s.eventId}/road.jpg`, clip_seconds: 16 };
  }
  if (s.dtcs && s.dtcs.length) p.diagnostics = { mil: !!s.faultLamp, engine_hours: s.engineHours, dtcs: s.dtcs.map((d) => ({ spn: d.spn, fmi: d.fmi, code: d.code, description: d.desc })) };
  if (s.roadSurface) p.road_surface = s.roadSurface;
  return p;
}
module.exports = { build };
