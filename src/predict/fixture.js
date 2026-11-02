// Synthetic fixture generator (tests + dev before the 90-day seed lands). Deterministic. 7 fleets, ~300 vehicles, 90 days,
// precursor ramps before ~60-85% of collisions, decoy escalations, vendor-dependent signal visibility.
const { rngFrom, pick, int, range, weighted, round } = require('../util');
const DAY = 86400000;

const FLEETS = [
  { id: 'fleet_gulfcoast', name: 'Gulf Coast Freight', vendor: 'motive', n: 38, cam: 0.82, haz: 1.0, base: [30.69, -88.04] },
  { id: 'fleet_goodyear', name: 'Goodyear Towing', vendor: 'motive', n: 22, cam: 0.9, haz: 0.8, base: [31.31, -85.85] },
  { id: 'fleet_piedmont', name: 'Piedmont Logistics', vendor: 'samsara', n: 54, cam: 0.74, haz: 1.5, base: [35.22, -80.84] },
  { id: 'fleet_bluegrass', name: 'Bluegrass Dairy Transport', vendor: 'geotab', n: 31, cam: 0.4, haz: 0.8, base: [38.04, -84.5] },
  { id: 'fleet_summit', name: 'Summit Last-Mile Delivery', vendor: 'lytx', n: 67, cam: 1.0, haz: 1.2, base: [33.75, -84.39] },
  { id: 'fleet_redline', name: 'Redline Regional Carriers', vendor: 'mantis', n: 46, cam: 0.98, haz: 1.1, base: [36.16, -86.78], improving: true },
  { id: 'fleet_magnolia', name: 'Magnolia Beverage Distribution', vendor: 'mantis', n: 29, cam: 0.98, haz: 1.0, base: [32.3, -90.18], improving: true },
];
// P(vendor/camera detects indicator) -- Mantis driver-facing AI sees everything; others partial.
const DETECT = {
  mantis: { following_distance: 0.95, harsh_braking: 1, harsh_maneuver: 1, phone_use: 0.92, drowsiness: 0.9, speeding: 1, lane_departure: 0.9 },
  lytx: { following_distance: 0.7, harsh_braking: 1, harsh_maneuver: 1, phone_use: 0.7, drowsiness: 0.15, speeding: 1, lane_departure: 0.3 },
  samsara: { following_distance: 0.65, harsh_braking: 1, harsh_maneuver: 1, phone_use: 0.6, drowsiness: 0.1, speeding: 1, lane_departure: 0.25 },
  motive: { following_distance: 0.6, harsh_braking: 1, harsh_maneuver: 1, phone_use: 0.55, drowsiness: 0.08, speeding: 1, lane_departure: 0.2 },
  geotab: { following_distance: 0.1, harsh_braking: 1, harsh_maneuver: 1, phone_use: 0.05, drowsiness: 0, speeding: 1, lane_departure: 0 },
};
const BASE_RATE = { harsh_braking: 0.011, harsh_maneuver: 0.011, speeding: 0.010, following_distance: 0.006, phone_use: 0.005, drowsiness: 0.0015, lane_departure: 0.002 };
const RAMP = { following_distance: 0.14, harsh_braking: 0.11, phone_use: 0.08, drowsiness: 0.06, speeding: 0.08, lane_departure: 0.05, harsh_maneuver: 0.05 };
const SIG = {
  following_distance: ['Following distance < 1.2s at highway speed'], phone_use: ['Driver looking down / phone use detected', 'Driver-facing camera clip attached'],
  drowsiness: ['Driver drowsiness: eyes closed >1.5s', 'Driver-facing camera clip attached'], lane_departure: ['Lane departure without signal'],
  harsh_braking: ['Forward camera: lead vehicle braking / evasive action'], harsh_maneuver: ['Aggressive maneuver confirmed on video'], speeding: ['Speed 78 mph in posted 65 mph zone'],
};
const ETYPE = { following_distance: 'following_distance', harsh_braking: 'harsh_brake', harsh_maneuver: 'harsh_turn', phone_use: 'distracted', drowsiness: 'distracted', speeding: 'speeding', lane_departure: 'harsh_turn' };
const FIRST = ['Marcus', 'Dana', 'Luis', 'Priya', 'Tom', 'Keisha', 'Wes', 'Ana', 'Jordan', 'Reggie', 'Sam', 'Lena', 'Omar', 'Cole', 'Tasha', 'Víctor', 'Beth', 'Hank'];
const LAST = ['Reed', 'Nguyen', 'Brooks', 'Patel', 'Hayes', 'Ortiz', 'Dunn', 'Pruitt', 'Lowe', 'Shaw', 'Boone', 'Cruz', 'Vance', 'Mills', 'Teague', 'Gaines'];

function generate({ asOf = Date.parse('2026-11-01T18:00:00Z'), days = 90, seed = 'predict-fixture', scale = 1 } = {}) {
  const ctxs = [];
  let nid = 20000;
  for (const F of FLEETS) {
    const rng = rngFrom(`${seed}:${F.id}`);
    const nVeh = Math.max(6, Math.round(F.n * scale));
    const fleet = { id: F.id, name: F.name, vendor: F.vendor };
    const drivers = [], vehicles = [], incidents = [];
    const nDrv = Math.round(nVeh * 1.12);
    for (let i = 0; i < nDrv; i++) drivers.push({ id: `drv_${F.id.slice(6, 9)}_${i}`, name: `${pick(rng, FIRST)} ${pick(rng, LAST)}`, vehicleId: null, m: Math.exp((rng() + rng() + rng() - 1.5) * 1.1) });
    for (let i = 0; i < nVeh; i++) {
      const d = drivers[i % drivers.length];
      const v = { id: `veh_${F.id.slice(6, 9)}_${i}`, unit: `${F.id.slice(6, 9).toUpperCase()}-${100 + i}`, plate: `XX-${100 + i}`, make: 'Freightliner', model: 'Cascadia', year: int(rng, 2019, 2026), odometer_mi: int(rng, 40000, 600000), hasCamera: rng() < F.cam, driverId: d.id, vin: `1FUJ${i}` };
      d.vehicleId = v.id; vehicles.push(v);
    }
    drivers.forEach((d, i) => { if (!d.vehicleId) d.vehicleId = vehicles[i % nVeh].id; });
    const det = DETECT[F.vendor];
    const vehOf = new Map(vehicles.map((v) => [v.id, v]));
    const start = asOf - days * DAY;
    const loc = () => ({ lat: round(F.base[0] + range(rng, -0.5, 0.5), 4), lng: round(F.base[1] + range(rng, -0.5, 0.5), 4), road: pick(rng, ['I-65', 'I-40', 'I-24', 'US-84', 'I-10', 'I-85']) , address: '' });
    const hot = [loc(), loc(), loc()];
    const mk = (d, ts, type, extra = {}) => {
      const v = vehOf.get(d.vehicleId); const l = rng() < 0.35 ? { ...pick(rng, hot), lat: 0, lng: 0 } : loc();
      if (l.lat === 0) { const h = pick(rng, hot); l.lat = round(h.lat + range(rng, -0.03, 0.03), 4); l.lng = round(h.lng + range(rng, -0.03, 0.03), 4); }
      l.address = `${l.road}, ${F.name.split(' ')[0]} region`;
      const hasCam = v.hasCamera;
      const sigs = extra.signals || [];
      return {
        id: 'NX-' + (nid++), provider: F.vendor, fleetId: F.id, fleetName: F.name, eventType: type, category: type === 'fault_code' ? 'diagnostic' : type === 'collision' ? 'collision' : 'safety',
        severity: extra.severity || (type === 'collision' ? 'critical' : 'medium'), status: extra.status || 'resolved', timestamp: new Date(ts).toISOString(),
        vehicle: { id: v.id, unit: v.unit, plate: v.plate }, driver: { id: d.id, name: d.name }, location: l,
        camera: { aiVerdict: extra.verdict || (hasCam ? (type === 'collision' ? 'confirmed_collision' : 'confirmed_event') : 'no_video'), verified: hasCam && rng() < (F.vendor === 'mantis' ? 0.95 : 0.7), clips: hasCam ? [{ url: 'x' }] : [], signals: sigs },
        diagnostics: extra.diagnostics || null, timeline: extra.timeline || [], load: null,
      };
    };
    const impl = new Set(); // dedupe
    // baseline behavior events
    for (const d of drivers) {
      const v = vehOf.get(d.vehicleId);
      const coachDay = F.improving ? 40 + rng() * 15 : null;
      for (const [k, r0] of Object.entries(BASE_RATE)) {
        const pd = (det[k] || 0) * (['following_distance', 'phone_use', 'drowsiness', 'lane_departure'].includes(k) && !v.hasCamera ? 0 : 1);
        if (!pd) continue;
        let mult = d.m;
        for (let day = 0; day < days; day++) {
          let rr = r0 * mult * pd;
          if (F.improving && day > 45) rr *= 0.62;
          if (rng() < rr) pushEv(d, k, start + (day + rng()) * DAY, false);
        }
      }
      // DTC
      for (let day = 0; day < days; day++) if (rng() < 0.0035 * d.m) {
        const t = start + (day + rng()) * DAY; const age = (asOf - t) / DAY; const open = age < 6 && rng() < 0.7;
        incidents.push(mk(d, t, 'fault_code', { status: open ? 'dispatched' : 'resolved', severity: rng() < 0.4 ? 'high' : 'medium', diagnostics: { dtcs: [{ code: pick(rng, ['P20EE', 'P0401', 'SPN3251', 'P2002']), desc: 'Aftertreatment fault', severity: rng() < 0.4 ? 'high' : 'medium' }], drivable: rng() < 0.2 ? 'limp' : 'yes', faultLampOn: open } }));
      }
    }
    function pushEv(d, k, ts, precursor) {
      const night = precursor && rng() < 0.4;
      if (night) { const dd = new Date(ts); dd.setUTCHours(int(rng, 3, 9)); ts = dd.getTime(); }
      if (ts >= asOf - 3600000 || ts < start) return;
      const coached = F.improving && rng() < 0.4 ? [{ t: new Date(ts + 3600000).toISOString(), actor: 'fleet', action: 'resolved', note: 'Coaching logged; event closed' }] : [];
      incidents.push(mk(drivers.find((x) => x.id === d.id), ts, ETYPE[k], { signals: SIG[k], severity: k === 'speeding' ? 'low' : 'medium', verdict: k === 'following_distance' && rng() < 0.3 ? 'near_miss' : undefined, timeline: coached }));
    }
    // collisions with precursors
    const collisionDrivers = [];
    for (const d of drivers) {
      const lam = 0.022 * F.haz * Math.pow(d.m, 1.4) * (days / 30);
      let n = 0, L = Math.exp(-lam), p = 1; do { n++; p *= rng(); } while (p > L); n--;
      for (let c = 0; c < n; c++) {
        const t = start + (3 + rng() * (days - 3.2)) * DAY;
        incidents.push(mk(d, t, 'collision', { severity: 'critical', signals: ['Impact g-force 4.6g', 'Airbag deploy flag'] }));
        collisionDrivers.push(d.id);
        const hasPre = rng() < (F.vendor === 'mantis' ? 0.92 : F.vendor === 'geotab' ? 0.62 : 0.78);
        if (hasPre) ramp(d, t, rng() < 0.75);
      }
    }
    // decoys: escalate with no collision
    for (const d of drivers) if (!collisionDrivers.includes(d.id) && rng() < (F.vendor === 'mantis' ? 0.05 : 0.07)) ramp(d, start + (20 + rng() * (days - 25)) * DAY + 14 * DAY, false);
    function ramp(d, tEnd, strong) {
      const len = int(rng, 14, 28);
      for (const [k, peak] of Object.entries(RAMP)) {
        const pd = det[k] || 0; if (!pd || (['following_distance', 'phone_use', 'drowsiness', 'lane_departure'].includes(k) && !vehOf.get(d.vehicleId).hasCamera)) continue;
        for (let day = 0; day < len; day++) {
          const frac = (day + 1) / len; const rr = peak * frac * (strong ? 1 : 0.45) * pd * (F.improving && tEnd > start + 50 * DAY ? 0.7 : 1);
          if (rng() < rr) pushEv(d, k, tEnd - (len - day) * DAY + rng() * DAY, true);
        }
      }
    }
    incidents.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    ctxs.push({ fleet, drivers: drivers.map(({ m, ...r }) => r), vehicles, incidents, asOf });
  }
  return ctxs;
}
module.exports = { generate, FLEETS };
