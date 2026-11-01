const { clamp } = require('../util');
const BASE = { collision: 72, rollover: 85, distracted: 55, harsh_brake: 40, harsh_accel: 30, harsh_turn: 35, speeding: 30, following_distance: 25, fault_code: 35, breakdown: 45, tire: 35, battery: 25, other: 20 };

function score(inc) {
  let s = BASE[inc.eventType] ?? 20;
  const tags = [];
  const cam = inc.camera || {};
  if (cam.aiVerdict === 'false_positive') { tags.push('false_positive'); return { eventScore: 5, tags }; }
  if (cam.verified) { tags.push('camera_verified'); s += 6; }
  const g = inc._hints && inc._hints.gForce;
  if (inc._hints && inc._hints.airbag) { tags.push('airbag_deployed'); s += 6; }
  if (g != null && g >= 4) { tags.push('high_impact'); s += 4; }
  if (inc.location && inc.location.speed_mph >= 65) { tags.push('high_speed'); s += 7; }
  const d = inc.diagnostics;
  if (d && d.dtcs && d.dtcs.length) {
    const sev = d.dtcs.reduce((m, x) => ({ low: 1, medium: 2, high: 3, critical: 4 }[x.severity] > m ? { low: 1, medium: 2, high: 3, critical: 4 }[x.severity] : m), 0);
    s += sev * 4;
    if (d.drivable === 'limp') tags.push('derate');
    if (d.drivable === 'no') { tags.push('non_drivable'); s += 6; }
    if (d.dtcs.some((x) => x.system === 'Aftertreatment')) tags.push('aftertreatment');
    if (d.dtcs.some((x) => x.system === 'Brakes')) { tags.push('brake_system'); s += 5; }
  }
  if (inc.warranty && inc.warranty.claimEligible) tags.push('warranty_recoverable');
  if (inc.driver && inc.driver.safetyScore != null && inc.driver.safetyScore < 70) { tags.push('low_driver_score'); s += 6; }
  const hr = new Date(inc.timestamp).getUTCHours();
  const local = (hr + 24 - 5) % 24; // approx US Eastern/Central
  if (local >= 22 || local < 5) { tags.push('night'); s += 4; }
  return { eventScore: Math.round(clamp(s, 0, 100)), tags };
}
module.exports = { score };
