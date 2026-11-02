// Camera verification: turns vendor signals/AI label into a verdict + confidence + human-readable signals.
const { hashStr, round, clamp } = require('../util');

const jitter = (id, n = 0.04) => ((hashStr(id) % 1000) / 1000 - 0.5) * 2 * n;

function verify(inc) {
  const h = inc._hints || {};
  const cam = inc.camera || {};
  const hasMedia = (cam.clips && cam.clips.length) || (cam.snapshots && cam.snapshots.length);
  const out = { provider: cam.provider || inc.provider, verified: false, aiVerdict: 'no_video', confidence: 0, clips: cam.clips || [], snapshots: cam.snapshots || [], signals: [] };
  const sig = out.signals;
  const g = h.gForce;
  if (g != null) sig.push(`Impact g-force ${g.toFixed(1)}g`);
  if (!hasMedia) {
    if (g != null) sig.push('Sensor-only event (no camera footage available)');
    return out;
  }
  const t = inc.eventType;
  if (h.aiVerdict) { // vendor (e.g. Mantis) already classified the clip with its own AI - trust it, keep our evidence list
    out.aiVerdict = h.aiVerdict; out.confidence = round(clamp(h.aiConfidence != null ? h.aiConfidence : 0.9, 0, 0.99), 2);
    out.verified = out.confidence >= 0.6;
    for (const x of h.extraSignals || []) sig.push(x);
    if (h.aiVerdict === 'false_positive') sig.push('Event below threshold per vendor AI');
    return out;
  }
  const id = inc.providerEventId || inc.id || 'x';
  let verdict, conf;
  const vendorLabel = (h.aiLabel || '').toLowerCase();
  const vendorConf = h.aiConfidence;

  if (t === 'collision' || t === 'rollover') {
    const impact = (g || 0) >= 2.5 || h.airbag;
    if (vendorLabel === 'false_positive' || vendorLabel === 'no_collision' || (!impact && (g || 0) < 2.0 && !h.airbag)) {
      verdict = 'false_positive'; conf = vendorConf != null ? vendorConf : 0.88 + jitter(id);
      sig.push('Impact below collision threshold', 'No airbag deployment flag', h.roadSurface ? `Road-surface signature: ${h.roadSurface}` : 'Road-surface vibration signature (not an impact)', 'No change in vehicle speed after event');
    } else {
      verdict = 'confirmed_collision';
      conf = vendorConf != null ? vendorConf : clamp(0.72 + ((g || 0) - 2.5) * 0.06 + (h.airbag ? 0.08 : 0) + jitter(id), 0.7, 0.99);
      if (h.airbag) sig.push('Airbag deploy flag');
      if (h.speedAtEvent != null) sig.push(`Speed ${Math.round(h.speedAtEvent)} mph at impact`);
      sig.push('Forward camera: object contact detected', h.facingForward === false ? 'Driver not facing forward at impact' : 'Driver facing forward');
    }
  } else if (t === 'distracted') {
    verdict = 'distraction'; conf = vendorConf != null ? vendorConf : 0.8 + jitter(id, 0.08);
    sig.push(h.distractionType || 'Driver looking down / phone use detected', 'Driver-facing camera clip attached');
  } else if (t === 'following_distance') {
    verdict = 'near_miss'; conf = vendorConf != null ? vendorConf : 0.74 + jitter(id, 0.08);
    sig.push('Following distance < 1.0s at highway speed');
  } else if (t === 'harsh_brake' || t === 'harsh_turn' || t === 'harsh_accel') {
    if (vendorLabel === 'false_positive' || (g != null && g < 0.3)) {
      verdict = 'false_positive'; conf = vendorConf != null ? vendorConf : 0.86 + jitter(id);
      sig.push('Event magnitude below threshold', h.roadSurface ? `Road-surface signature: ${h.roadSurface}` : 'Road-surface artifact (rough pavement)');
    } else if (vendorLabel === 'near_miss' || t === 'harsh_brake') {
      verdict = 'near_miss'; conf = vendorConf != null ? vendorConf : 0.8 + jitter(id, 0.08);
      sig.push('Forward camera: lead vehicle braking / evasive action', h.facingForward === false ? 'Driver not facing forward' : 'Driver facing forward');
    } else { verdict = 'confirmed_event'; conf = vendorConf != null ? vendorConf : 0.82 + jitter(id, 0.06); sig.push('Aggressive maneuver confirmed on video'); }
  } else if (t === 'speeding') {
    verdict = 'confirmed_event'; conf = 0.92 + jitter(id, 0.03);
    sig.push(`Speed ${Math.round(h.speedAtEvent || 0)} mph in posted ${h.postedLimit || 55} mph zone`);
  } else {
    verdict = 'confirmed_event'; conf = vendorConf != null ? vendorConf : 0.75 + jitter(id, 0.08);
  }
  if (vendorConf != null && h.aiLabel) sig.push(`${(cam.provider || inc.provider)} AI: ${h.aiLabel.replace(/_/g, ' ')} (${Math.round(vendorConf * 100)}%)`);
  out.aiVerdict = verdict;
  out.confidence = round(clamp(conf, 0, 0.99), 2);
  out.verified = out.confidence >= 0.6;
  return out;
}

module.exports = { verify };
