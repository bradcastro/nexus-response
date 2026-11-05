// Roadside recommender: service type from event/DTC, provider list with ETA from haversine distance.
const { PROVIDERS, HAZMAT_TEAMS, HAZMAT_CERTIFIED } = require('../data/ref');
const { haversineMi, round } = require('../util');

let providers = PROVIDERS.map((p) => ({ ...p, phone: `+1${p.lat.toFixed(3).replace(/\D/g, '').slice(0, 3)}555${String(Math.abs(Math.round(p.lng * 100)) % 10000).padStart(4, '0')}`, available24x7: true, hazmatCertified: HAZMAT_CERTIFIED.includes(p.id) }));
const setProviders = (p) => { providers = p; };
const getProviders = () => providers;

function etaFor(distMi) { return Math.round(8 + (distMi * 1.3) / 48 * 60); } // 8 min dispatch lag + road factor @48mph

function listNear(lat, lng, service) {
  return providers
    .filter((p) => !service || p.services.includes(service))
    .filter((p) => service !== 'tow_heavy' || p.heavy)
    .map((p) => {
      const d = lat != null && lng != null ? haversineMi(lat, lng, p.lat, p.lng) : null;
      return { ...p, distanceMi: d == null ? null : round(d, 1), etaMin: d == null ? null : etaFor(d) };
    })
    .sort((a, b) => (a.distanceMi ?? 1e9) - (b.distanceMi ?? 1e9));
}

function serviceFor(inc, vehicleCls) {
  const t = inc.eventType;
  const dx = inc.diagnostics;
  const tow = vehicleCls === 'heavy' ? 'tow_heavy' : 'tow_light';
  const v = inc.camera && inc.camera.aiVerdict;
  if (v === 'false_positive') return { serviceType: 'none', reason: 'Camera verification: false positive - no assistance needed' };
  if (t === 'rollover') return { serviceType: 'tow_heavy', reason: 'Rollover - heavy recovery required' };
  if (t === 'collision') {
    const g = inc._hints && inc._hints.gForce;
    return { serviceType: tow, reason: v === 'confirmed_collision' ? 'Camera-confirmed collision - vehicle likely not drivable' : (g && g > 3 ? 'High-g impact - tow staged pending validation' : 'Collision reported - tow staged pending validation') };
  }
  if (t === 'tire') return { serviceType: 'tire', reason: 'Tire event - mobile tire service' };
  if (t === 'battery') return { serviceType: 'jump_start', reason: 'Battery/charging fault - jump start & load test' };
  if (dx && dx.dtcs && dx.dtcs.length) {
    const tpms = dx.dtcs.some((d) => d.system === 'Tires');
    if (tpms) return { serviceType: 'tire', reason: 'TPMS fault - tire inspection' };
    if (dx.dtcs.some((d) => d.code === 'SPN 168 FMI 4' || d.code === 'P0562') && dx.drivable === 'yes') return { serviceType: 'jump_start', reason: 'Low system voltage' };
    if (dx.drivable === 'no') return { serviceType: tow, reason: `Non-drivable fault (${dx.dtcs[0].code}) - tow to repair facility` };
    if (dx.drivable === 'limp') return { serviceType: 'mobile_mechanic', reason: `Derate/limp-mode fault (${dx.dtcs[0].code}) - dispatch mobile mechanic with ${dx.dtcs[0].partsHint.split(',')[0]}` };
    if (inc.eventType === 'breakdown') return { serviceType: 'mobile_mechanic', reason: 'Breakdown with active fault - mobile mechanic' };
  }
  if (t === 'breakdown') return { serviceType: 'mobile_mechanic', reason: 'Breakdown reported - mobile mechanic' };
  return { serviceType: 'none', reason: 'No roadside assistance indicated' };
}

function recommend(inc, vehicleCls) {
  const { serviceType, reason } = serviceFor(inc, vehicleCls);
  const base = { needed: serviceType !== 'none', serviceType, recommendedProvider: null, assignedProvider: null, etaMin: null, rationale: reason, alternatives: [] };
  if (!base.needed || !inc.location || inc.location.lat == null) return base;
  const list = listNear(inc.location.lat, inc.location.lng, serviceType);
  if (!list.length) return base;
  const slim = (p) => ({ hazmatCertified: !!p.hazmatCertified, id: p.id, name: p.name, etaMin: p.etaMin, distanceMi: p.distanceMi, phone: p.phone, rating: p.rating, city: p.city, st: p.st });
  base.recommendedProvider = slim(list[0]);
  base.etaMin = list[0].etaMin;
  base.alternatives = list.slice(1, 3).map(slim);
  return base;
}

const teamPhone = (t) => `+1${String(Math.abs(Math.round(t.lat * 1000)) % 1000).padStart(3, '0')}555${String(Math.abs(Math.round(t.lng * 100)) % 10000).padStart(4, '0')}`;
function listHazmatTeams(lat, lng, limit = 3) {
  return HAZMAT_TEAMS.map((t) => {
    const d = lat != null && lng != null ? haversineMi(lat, lng, t.lat, t.lng) : null;
    return { ...t, phone: teamPhone(t), available24x7: true, distanceMi: d == null ? null : round(d, 1), etaMin: d == null ? null : etaFor(d) + 12 };
  }).sort((a, b) => (a.distanceMi ?? 1e9) - (b.distanceMi ?? 1e9)).slice(0, limit);
}
// Hazmat load: recommend the nearest hazmat-certified tow provider, even if a non-certified one is closer.
function preferHazmat(inc) {
  const rs = inc.roadside, ld = inc.load;
  if (!rs || !rs.needed || rs.assignedProvider || !(ld && ld.contents && ld.contents.hazmat) || !inc.location || inc.location.lat == null) return;
  if (!String(rs.serviceType).startsWith('tow')) return;
  const list = listNear(inc.location.lat, inc.location.lng, rs.serviceType);
  const cert = list.filter((p) => p.hazmatCertified);
  if (!cert.length) { rs.rationale += ' Hazmat load: no hazmat-certified provider on file nearby; request a hazmat team.'; return; }
  const slim = (p) => ({ hazmatCertified: !!p.hazmatCertified, id: p.id, name: p.name, etaMin: p.etaMin, distanceMi: p.distanceMi, phone: p.phone, rating: p.rating, city: p.city, st: p.st });
  const rest = list.filter((p) => !p.hazmatCertified);
  const ordered = [...cert, ...rest];
  const nearestOverall = list[0];
  rs.recommendedProvider = slim(ordered[0]); rs.etaMin = ordered[0].etaMin; rs.alternatives = ordered.slice(1, 3).map(slim);
  rs.rationale += nearestOverall.id !== ordered[0].id ? ` Hazmat load: nearest hazmat-certified provider chosen over the closer ${nearestOverall.name}.` : ' Hazmat load: nearest provider is hazmat-certified.';
}
const isHazmatCertified = (id) => !!(providers.find((p) => p.id === id) || {}).hazmatCertified;

module.exports = { preferHazmat, listHazmatTeams, isHazmatCertified, recommend, listNear, serviceFor, setProviders, getProviders, etaFor };
