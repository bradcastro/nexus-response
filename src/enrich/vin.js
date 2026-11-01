// VIN decoding: offline table for demo VINs; optional NHTSA vPIC lookup (VIN_ONLINE=1) with graceful fallback.
const { MODELS } = require('../data/ref');

const YEAR_CODES = 'ABCDEFGHJKLMNPRSTVWXY123456789';
const YEARS = {}; 'ABCDEFGHJKLMNPRSTVWXY123456789'.split('').forEach((c, i) => { YEARS[c] = 2010 + i; });

const TRANS = { A:1,B:2,C:3,D:4,E:5,F:6,G:7,H:8,J:1,K:2,L:3,M:4,N:5,P:7,R:9,S:2,T:3,U:4,V:5,W:6,X:7,Y:8,Z:9 };
const WEIGHTS = [8,7,6,5,4,3,2,10,0,9,8,7,6,5,4,3,2];
function checkDigit(vin) {
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const ch = vin[i]; const v = /\d/.test(ch) ? +ch : TRANS[ch] || 0;
    sum += v * WEIGHTS[i];
  }
  const r = sum % 11; return r === 10 ? 'X' : String(r);
}
function buildVin(modelKey, year, serial) {
  const m = MODELS[modelKey];
  const yc = Object.keys(YEARS).find((k) => YEARS[k] === year) || 'P';
  const body = m.wmi + m.code + '0' + yc + 'A' + String(serial).padStart(6, '0');
  const cd = checkDigit(body);
  return body.slice(0, 8) + cd + body.slice(9);
}

const WMI = {};
const CODE = {};
for (const [k, m] of Object.entries(MODELS)) {
  WMI[m.wmi] = { make: m.make, oem: m.oem };
  CODE[m.wmi + m.code] = { model: m.model, engine: m.engine, cls: m.cls, key: k };
}
// A few extra well-known WMIs so uploads from arbitrary vendors still decode.
Object.assign(WMI, {
  '1FU': { make: 'Freightliner', oem: 'Freightliner' }, '1XP': { make: 'Peterbilt', oem: 'Peterbilt' },
  '1FT': { make: 'Ford', oem: 'Ford' }, '1FD': { make: 'Ford', oem: 'Ford' }, '3HS': { make: 'International', oem: 'International' },
  '1HT': { make: 'International', oem: 'International' }, '1M1': { make: 'Mack', oem: 'Mack' }, 'WD3': { make: 'Mercedes-Benz', oem: 'Mercedes-Benz' },
});

function decodeOffline(vin) {
  if (!vin || typeof vin !== 'string' || vin.length !== 17) return null;
  vin = vin.toUpperCase();
  const w = WMI[vin.slice(0, 3)];
  const c = CODE[vin.slice(0, 8)];
  const year = YEARS[vin[9]] || null;
  if (!w && !c) return { vin, valid: false, source: 'offline', note: 'Unknown WMI' };
  return {
    vin, valid: true, checkDigitOk: checkDigit(vin) === vin[8], source: 'offline',
    make: w ? w.make : null, oem: w ? w.oem : null, model: c ? c.model : null, year,
    engine: c ? c.engine : null, vehicleClass: c ? (c.cls === 'heavy' ? 'Class 8 Truck' : 'Light/Medium Duty') : null,
    plant: vin[10], serial: vin.slice(11),
  };
}

const cache = new Map();
async function decodeOnline(vin) {
  if (cache.has(vin)) return cache.get(vin);
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 2500);
    const r = await fetch(`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${vin}?format=json`, { signal: ctl.signal });
    clearTimeout(t);
    const j = await r.json(); const x = j.Results && j.Results[0];
    if (!x || !x.Make) return null;
    const out = { vin, valid: true, source: 'nhtsa-vpic', make: x.Make, model: x.Model, year: +x.ModelYear || null, engine: [x.DisplacementL && x.DisplacementL + 'L', x.EngineModel].filter(Boolean).join(' ') || null, vehicleClass: x.VehicleType || null, gvwr: x.GVWR || null, plant: x.PlantCity || null };
    cache.set(vin, out); return out;
  } catch (e) { return null; }
}

async function decode(vin) {
  const off = decodeOffline(vin);
  if (process.env.VIN_ONLINE === '1' && vin && vin.length === 17 && !(off && off.model)) {
    const on = await decodeOnline(vin);
    if (on) return { ...(off || {}), ...on, oem: (off && off.oem) || on.make };
  }
  return off;
}

module.exports = { decode, decodeOffline, buildVin, checkDigit };
