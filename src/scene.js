// Where the vehicle actually is relative to hard surfaces: on the roadway, on the shoulder, or off the road (ditch, embankment, trees).
// DEMO: estimates are SYNTHETIC. In production the inputs are: GPS position and accuracy from the camera or ELD,
// road centerline geometry (map data), terrain elevation (e.g. USGS 3DEP), camera frames, and the driver's own report.
// A dispatcher- or driver-reported value always overrides the estimate.
const { rngFrom } = require('./util');

const M_PER_YD = 0.9144;
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length) % arr.length];
const between = (rng, a, b) => Math.round(a + rng() * (b - a));

function estimate(inc) {
  const rng = rngFrom('scene:' + inc.id);
  const cam = inc.camera || {};
  const hasCamera = !!(cam.verified || (cam.clips && cam.clips.length) || (cam.snapshots && cam.snapshots.length));
  const source = hasCamera ? 'camera' : 'eld';
  const t = inc.eventType, roll = t === 'rollover', hit = t === 'collision';
  const r = rng();
  let position;
  if (roll) position = r < 0.15 ? 'on_roadway' : r < 0.4 ? 'shoulder' : 'off_road';
  else if (hit) position = r < 0.55 ? 'on_roadway' : r < 0.85 ? 'shoulder' : 'off_road';
  else position = r < 0.1 ? 'on_roadway' : 'shoulder';
  let off = 0, terrain = 'paved', dropFt = 0, surface = 'paved';
  if (position === 'shoulder') { off = between(rng, 2, 6); surface = pick(rng, ['paved', 'gravel']); }
  if (position === 'off_road') {
    off = roll ? between(rng, 8, 120) : between(rng, 5, 60);
    terrain = pick(rng, ['embankment', 'embankment', 'ditch', 'ditch', 'wooded', 'flat_field']);
    dropFt = terrain === 'embankment' ? between(rng, 6, 40) : terrain === 'ditch' ? between(rng, 3, 10) : 0;
    surface = pick(rng, ['grass', 'mud', 'gravel', 'soft_soil']);
  }
  const accM = hasCamera ? between(rng, 3, 8) : between(rng, 12, 40);
  return {
    position, offRoadDistanceM: off, terrain, dropFt, surface, gpsAccuracyM: accM, headingDeg: inc.location && inc.location.heading != null ? inc.location.heading : null,
    source, confidence: hasCamera ? 'medium' : 'low', reported: false, estimate: true,
    basis: hasCamera
      ? 'Estimated from the GPS position and the camera frames. Confirm with the driver before committing equipment.'
      : 'ELD location only (no camera). Position is approximate. Call the driver for landmarks before committing equipment.',
  };
}

// What the recovery crew should plan for, derived from the scene.
function access(sc) {
  if (!sc) return [];
  const out = [], off = sc.offRoadDistanceM || 0, acc = sc.gpsAccuracyM || 0;
  if (sc.position === 'off_road') {
    const reach = Math.ceil((off + (sc.reported ? 0 : acc)) * 1.25);
    out.push(`Winch line and cable for at least ${reach} m (${Math.round(reach * 3.281)} ft) of reach: truck is about ${off} m (${Math.round(off / M_PER_YD)} yd) off the road${sc.reported ? '' : ', plus position uncertainty'}`);
    if (sc.terrain === 'embankment') out.push(`Slope recovery: about ${sc.dropFt} ft drop. Bring anchor points, snatch blocks and a long-reach or rotator rig; consider a second unit to hold the line`);
    if (sc.terrain === 'ditch') out.push(`Ditch recovery: about ${sc.dropFt} ft down. Plan a pull angle that avoids rolling the truck further`);
    if (sc.terrain === 'wooded') out.push('Wooded area: bring a chainsaw and clear a path before rigging');
    if (['mud', 'soft_soil', 'grass'].includes(sc.surface)) out.push(`Soft ground (${sc.surface.replace('_', ' ')}): bring recovery mats or timbers; the ground may not hold a heavy wrecker`);
  } else if (sc.position === 'on_roadway') out.push('Truck is in a travel lane: traffic control and quick clearance needed');
  else if (sc.position === 'shoulder') out.push('Truck is on the shoulder: work from the shoulder side if you can, use traffic control');
  if (!sc.reported && sc.confidence !== 'high') out.push('Position is an estimate: confirm distance from the road with the driver before you commit equipment');
  return out;
}

const label = (sc) => !sc ? 'Unknown' : sc.position === 'on_roadway' ? 'On the roadway' : sc.position === 'shoulder' ? `On the shoulder, about ${sc.offRoadDistanceM} m off the lane` : `Off the road, about ${sc.offRoadDistanceM} m (${Math.round(sc.offRoadDistanceM / M_PER_YD)} yd) from pavement`;

module.exports = { estimate, access, label, M_PER_YD };
