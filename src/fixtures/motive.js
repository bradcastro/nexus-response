// Motive (KeepTruckin) webhook-shaped payload.
const MAP = { collision: 'collision', rollover: 'rollover', harsh_brake: 'hard_brake', harsh_accel: 'hard_acceleration', harsh_turn: 'hard_turn', speeding: 'speeding', distracted: 'distracted_driving', following_distance: 'following_distance', fault_code: 'fault_code', breakdown: 'fault_code', tire: 'tire_pressure', battery: 'low_battery', other: 'other' };
const nm = (n) => { const p = String(n || 'Unknown Driver').split(' '); return [p[0], p.slice(1).join(' ')]; };
function build(s) {
  const [fn, ln] = nm(s.driver && s.driver.name);
  const host = 'https://media.nexus-demo.invalid/motive';
  const ev = {
    id: s.eventId, type: MAP[s.eventType] || 'other', occurred_at: s.timestamp, company_id: s.companyId || 'co_motive_demo',
    vehicle: { id: s.vehicle.providerVehicleId, number: s.vehicle.unit, vin: s.vehicle.vin, make: s.vehicle.make, model: s.vehicle.model, year: s.vehicle.year, license_plate: s.vehicle.plate },
    driver: { id: s.driver.providerDriverId, first_name: fn, last_name: ln, phone_number: s.driver.phone },
    location: { lat: s.location.lat, lon: s.location.lng, formatted_address: s.location.address },
    speed_mph: s.location.speed_mph, bearing: s.location.heading, odometer: s.odometer_mi, engine_hours: s.engineHours,
  };
  if (s.gForce != null) ev.g_force = s.gForce;
  if (s.airbag) ev.airbag_deployed = true;
  if (s.hasCamera) {
    ev.video_url = `${host}/events/${s.eventId}/forward.mp4`; ev.dashcam_url = ev.video_url; ev.snapshot_url = `${host}/events/${s.eventId}/forward.jpg`;
    if (s.driverFacing) ev.driver_facing_video_url = `${host}/events/${s.eventId}/driver.mp4`;
    if (s.aiLabel) ev.ai_detection = { label: s.aiLabel, confidence: s.aiConfidence };
    if (s.facingForward != null) ev.driver_facing_forward = s.facingForward;
  }
  if (s.dtcs && s.dtcs.length) { ev.fault_codes = s.dtcs.map((d) => ({ code: d.code || null, spn: d.spn, fmi: d.fmi, description: d.desc || null, source_address: 0 })); ev.mil_status = !!s.faultLamp; }
  if (s.roadSurface) ev.road_surface = s.roadSurface;
  if (s.postedLimit) ev.posted_speed_limit_mph = s.postedLimit;
  return { event: ev };
}
module.exports = { build };
