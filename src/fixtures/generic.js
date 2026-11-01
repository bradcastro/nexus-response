// Generic / custom integration payload (flat, snake_case).
function build(s) {
  const p = {
    event_id: s.eventId, event_type: s.eventType, timestamp: s.timestamp, source: s.source || 'custom-integration',
    vin: s.vehicle.vin, plate: s.vehicle.plate, vehicle_id: s.vehicle.providerVehicleId, odometer_mi: s.odometer_mi, engine_hours: s.engineHours,
    driver_id: s.driver.providerDriverId, driver_name: s.driver.name, driver_phone: s.driver.phone,
    lat: s.location.lat, lng: s.location.lng, address: s.location.address, speed_mph: s.location.speed_mph, heading: s.location.heading,
  };
  if (s.gForce != null) p.g_force = s.gForce;
  if (s.airbag) p.airbag = true;
  if (s.hasCamera) { p.video_url = `https://media.nexus-demo.invalid/generic/${s.eventId}/clip.mp4`; p.snapshot_url = `https://media.nexus-demo.invalid/generic/${s.eventId}/frame.jpg`; if (s.aiLabel) { p.ai_label = s.aiLabel; p.ai_confidence = s.aiConfidence; } }
  if (s.dtcs && s.dtcs.length) { p.dtcs = s.dtcs.map((d) => (d.spn != null ? `SPN ${d.spn} FMI ${d.fmi}` : d.code)); p.mil = !!s.faultLamp; }
  if (s.roadSurface) p.road_surface = s.roadSurface;
  return p;
}
module.exports = { build };
