#!/usr/bin/env node
/* Generates demo history exports (deterministic; dates are relative to the run day).
   Run:  node public/onboarding/samples/generate-samples.js [rows=300]
   Output: mantis-export.csv, motive-export.csv, samsara-export.csv in this folder. */
const fs = require('fs'), path = require('path');
const ROWS = parseInt(process.argv[2], 10) || 300;
let seed = 20261101;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const pick = (a, w) => { if (!w) return a[Math.floor(rnd() * a.length)]; let t = rnd() * w.reduce((x, y) => x + y, 0); for (let i = 0; i < a.length; i++) { t -= w[i]; if (t <= 0) return a[i]; } return a[a.length - 1]; };
const iso = d => d.toISOString().replace(/\.\d+Z$/, 'Z');
const csv = (cols, rows) => cols.join(',') + '\n' + rows.map(r => cols.map(c => { const v = r[c] == null ? '' : String(r[c]); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }).join(',')).join('\n') + '\n';

const VIN_CHARS = 'ABCDEFGHJKLMNPRSTUVWXYZ0123456789';
const MAKES = [['Freightliner', 'Cascadia', '1FUJGLDR'], ['Volvo', 'VNL 760', '4V4NC9EH'], ['Kenworth', 'T680', '1XKYD49X'], ['Peterbilt', '579', '1XPBD49X'], ['International', 'LT', '3HSDJAPR']];
// 17-char VIN with a valid ISO 3779 check digit (position 9), so VIN decoders accept it
const TRANS = { A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9, S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9 };
const WTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];
function vin(prefix) {
  let s = prefix.slice(0, 8) + '0' + 'N'; // position 9 placeholder, model year 2022 (N)
  while (s.length < 17) s += '0123456789'[Math.floor(rnd() * 10)];
  const sum = s.split('').reduce((a, c, i) => a + (/\d/.test(c) ? +c : TRANS[c]) * WTS[i], 0), cd = sum % 11;
  return s.slice(0, 8) + (cd === 10 ? 'X' : cd) + s.slice(9);
}
const FIRST = ['Marcus', 'Dana', 'Luis', 'Tamika', 'Ray', 'Priya', 'Jo', 'Andre', 'Kim', 'Wes', 'Elena', 'Curtis', 'Nate', 'Rosa', 'Hank', 'Lena', 'Omar', 'Beth', 'Tyrell', 'Gus', 'Mia', 'Dale', 'Ivy', 'Sam'];
const LAST = ['Hale', 'Ortiz', 'Brooks', 'Nguyen', 'Pruitt', 'Shah', 'Kemp', 'Dawson', 'Ellis', 'Tran', 'Mills', 'Reyes', 'Boone', 'Lacy', 'Stone', 'Quinn', 'Farah', 'Cole', 'Greer', 'Haas', 'Vega', 'Moody', 'Park', 'Wynn'];
function fleet(n, regionPts, unitPrefix) {
  return Array.from({ length: n }, (_, i) => {
    const m = MAKES[i % MAKES.length];
    return { vin: vin(m[2]), unit: unitPrefix + String(101 + i), driver: FIRST[i % FIRST.length] + ' ' + LAST[(i * 7 + 3) % LAST.length], first: FIRST[i % FIRST.length], last: LAST[(i * 7 + 3) % LAST.length], home: regionPts[i % regionPts.length], make: m[0] };
  });
}
const VALLEY = [[36.16, -86.78], [37.04, -88.6], [38.25, -85.76], [39.1, -84.51], [35.15, -90.05], [36.6, -87.3]];
const GULF = [[32.3, -90.18], [30.45, -91.18], [33.52, -86.8], [30.69, -88.04], [29.95, -90.07]];
const SOUTH = [[33.75, -84.39], [35.22, -80.84], [34.0, -81.03], [30.33, -81.66], [32.08, -81.09]];

// event pools: [label, weight, severity weights low/med/high/critical]
const DAY_HOURS = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 0, 1, 2, 3, 4];
const HOUR_W = [3, 4, 5, 6, 7, 7, 7, 7, 7, 7, 6, 5, 4, 3, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2];
function when(daysBack) {
  const d = new Date(Date.now() - rnd() * daysBack * 86400000);
  d.setUTCHours(pick(DAY_HOURS, HOUR_W), Math.floor(rnd() * 60), Math.floor(rnd() * 60), 0);
  if (d > new Date()) d.setUTCDate(d.getUTCDate() - 1);
  return d;
}
const sevFor = (kind) => kind === 'collision' ? pick(['high', 'critical'], [3, 2]) : pick(['low', 'medium', 'high'], [5, 4, 1]);
function build(vendor, { n, trucks, unitPrefix, region, kinds, videoRate, withSignals }) {
  const fl = fleet(trucks, region, unitPrefix), rows = [];
  for (let i = 0; i < n; i++) {
    const v = fl[Math.floor(Math.pow(rnd(), 1.4) * fl.length)];  // some trucks are repeat offenders
    const k = pick(kinds.map(x => x[0]), kinds.map(x => x[2]));
    const kind = kinds.find(x => x[0] === k);
    const t = when(90), h = v.home;
    const lat = +(h[0] + (rnd() - .5) * 1.6).toFixed(5), lng = +(h[1] + (rnd() - .5) * 1.8).toFixed(5);
    const speed = kind[1] === 'collision' ? Math.round(18 + rnd() * 45) : kind[1] === 'speeding' ? Math.round(74 + rnd() * 14) : Math.round(28 + rnd() * 42);
    const sev = sevFor(kind[1]);
    const video = rnd() < videoRate ? `https://clips.${vendor}.example/${vendor}/${t.getTime().toString(36)}${i}.mp4` : '';
    rows.push({ i, kind: kind[0], norm: kind[1], v, t, lat, lng, speed, sev, video, id: `${vendor.slice(0, 3)}-${(1000000 + i * 37).toString(36)}` });
  }
  rows.sort((a, b) => a.t - b.t);
  return rows;
}
// kinds: [vendor label, normalized kind, weight]
const MANTIS_KINDS = [['forward_collision_warning', 'near_miss', 12], ['tailgating', 'following_distance', 18], ['drowsiness', 'drowsy', 9], ['phone_use', 'distracted', 12], ['seatbelt', 'seatbelt', 5], ['lane_departure', 'lane_departure', 10], ['harsh_brake', 'harsh_brake', 14], ['speeding', 'speeding', 12], ['collision', 'collision', 3]];
const MOTIVE_KINDS = [['Hard Brake', 'harsh_brake', 26], ['Hard Acceleration', 'harsh_accel', 10], ['Hard Corner', 'harsh_turn', 12], ['Speeding', 'speeding', 22], ['Distracted Driving', 'distracted', 8], ['Tailgating', 'following_distance', 13], ['Collision', 'collision', 3], ['Stop Sign Violation', 'other', 6]];
const SAMSARA_KINDS = [['Harsh Braking', 'harsh_brake', 25], ['Harsh Acceleration', 'harsh_accel', 10], ['Harsh Turn', 'harsh_turn', 12], ['Speeding', 'speeding', 22], ['Mobile Usage', 'distracted', 8], ['Following Distance', 'following_distance', 14], ['Crash', 'collision', 3], ['Rolling Stop', 'other', 6]];
const usDate = d => { const p = n => String(n).padStart(2, '0'); const h = d.getUTCHours(); return `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}/${d.getUTCFullYear()} ${p(h % 12 || 12)}:${p(d.getUTCMinutes())} ${h < 12 ? 'AM' : 'PM'}`; };

const out = (f, s) => { fs.writeFileSync(path.join(__dirname, f), s); console.log(f, s.split('\n').length - 2, 'rows'); };

// Mantis: camera-first, driver-facing signals, ~96% with clip. Headers match GET /api/import/templates/mantis.
let r = build('mantis', { n: ROWS, trucks: 24, unitPrefix: 'RL-', region: VALLEY, kinds: MANTIS_KINDS, videoRate: .96 });
out('mantis-export.csv', csv(['event_id', 'event_type', 'occurred_at', 'vehicle_unit', 'vin', 'driver_name', 'lat', 'lng', 'speed_mph', 'following_distance_s', 'drowsiness_score', 'phone_use', 'seatbelt_on', 'ai_classification', 'ai_confidence', 'clip_url'],
  r.map(x => ({ event_id: x.id, event_type: x.kind, occurred_at: iso(x.t), vehicle_unit: x.v.unit, vin: x.v.vin, driver_name: x.v.driver, lat: x.lat, lng: x.lng, speed_mph: x.speed,
    following_distance_s: x.norm === 'following_distance' ? (0.6 + rnd() * 0.9).toFixed(1) : '', drowsiness_score: x.norm === 'drowsy' ? (0.6 + rnd() * 0.38).toFixed(2) : (rnd() * 0.2).toFixed(2),
    phone_use: x.norm === 'distracted', seatbelt_on: x.norm !== 'seatbelt', ai_classification: x.video ? (x.norm === 'collision' ? 'confirmed_collision' : x.norm === 'near_miss' ? 'near_miss' : x.norm === 'distracted' || x.norm === 'drowsy' ? 'distraction' : 'confirmed_event') : '',
    ai_confidence: x.video ? (0.82 + rnd() * 0.16).toFixed(2) : '', clip_url: x.video }))));

// Motive: Title Case labels, US date format, ~38% with video. Headers match GET /api/import/templates/motive.
r = build('motive', { n: ROWS, trucks: 20, unitPrefix: 'GC-', region: GULF, kinds: MOTIVE_KINDS, videoRate: .38 });
out('motive-export.csv', csv(['Event ID', 'Event Type', 'Start Time', 'Vehicle', 'VIN', 'Driver', 'Latitude', 'Longitude', 'Speed (mph)', 'Severity', 'Video URL', 'Location'],
  r.map(x => ({ 'Event ID': x.id, 'Event Type': x.kind, 'Start Time': usDate(x.t), Vehicle: x.v.unit, VIN: x.v.vin, Driver: x.v.driver, Latitude: x.lat, Longitude: x.lng, 'Speed (mph)': x.speed, Severity: x.sev, 'Video URL': x.video, Location: '' }))));

// Samsara: ISO time, ~22% with media. Headers match GET /api/import/templates/samsara.
r = build('samsara', { n: ROWS, trucks: 22, unitPrefix: 'PD-', region: SOUTH, kinds: SAMSARA_KINDS, videoRate: .22 });
out('samsara-export.csv', csv(['Event ID', 'Behavior', 'Time', 'Vehicle Name', 'VIN', 'Driver Name', 'Latitude', 'Longitude', 'Speed (mph)', 'Severity', 'Media URL'],
  r.map(x => ({ 'Event ID': x.id, Behavior: x.kind, Time: iso(x.t), 'Vehicle Name': x.v.unit, VIN: x.v.vin, 'Driver Name': x.v.driver, Latitude: x.lat, Longitude: x.lng, 'Speed (mph)': x.speed, Severity: x.sev, 'Media URL': x.video }))));
