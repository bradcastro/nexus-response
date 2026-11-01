// Shared helpers: seeded RNG, geo math, misc.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashStr(s) {
  let h = 2166136261;
  s = String(s);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
const rngFrom = (s) => mulberry32(typeof s === 'number' ? s : hashStr(s));
const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];
const int = (rng, a, b) => Math.floor(a + rng() * (b - a + 1));
const range = (rng, a, b) => a + rng() * (b - a);
function weighted(rng, entries) { // [[value, weight], ...]
  const total = entries.reduce((s, e) => s + e[1], 0);
  let r = rng() * total;
  for (const [v, w] of entries) { if ((r -= w) <= 0) return v; }
  return entries[entries.length - 1][0];
}
function haversineMi(lat1, lng1, lat2, lng2) {
  const R = 3958.8, toR = (d) => (d * Math.PI) / 180;
  const dLat = toR(lat2 - lat1), dLng = toR(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toR(lat1)) * Math.cos(toR(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
const round = (n, d = 0) => { const p = 10 ** d; return Math.round(n * p) / p; };
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const iso = (d) => new Date(d).toISOString();
const clone = (o) => JSON.parse(JSON.stringify(o));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
module.exports = { mulberry32, hashStr, rngFrom, pick, int, range, weighted, haversineMi, round, clamp, iso, clone, sleep };
