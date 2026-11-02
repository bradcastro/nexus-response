// OEM dealer / service network (invented business names).
const { haversineMi, round, hashStr } = require('../util');
const CITIES = [
  ['Mobile', 'AL', 30.69, -88.1], ['Montgomery', 'AL', 32.37, -86.3], ['Dothan', 'AL', 31.22, -85.39], ['Birmingham', 'AL', 33.52, -86.8],
  ['Pensacola', 'FL', 30.46, -87.22], ['Tallahassee', 'FL', 30.45, -84.28], ['Jacksonville', 'FL', 30.33, -81.66], ['Ocala', 'FL', 29.19, -82.14], ['Orlando', 'FL', 28.5, -81.4],
  ['Macon', 'GA', 32.84, -83.63], ['Atlanta', 'GA', 33.78, -84.45], ['Savannah', 'GA', 32.08, -81.12], ['Albany', 'GA', 31.58, -84.16], ['Tifton', 'GA', 31.46, -83.51],
  ['Charlotte', 'NC', 35.25, -80.85], ['Greensboro', 'NC', 36.06, -79.8], ['Raleigh', 'NC', 35.78, -78.64], ['Asheville', 'NC', 35.55, -82.55],
  ['Greenville', 'SC', 34.85, -82.4], ['Columbia', 'SC', 34.0, -81.03], ['Spartanburg', 'SC', 34.95, -81.93],
  ['Lexington', 'KY', 38.04, -84.5], ['Louisville', 'KY', 38.25, -85.76], ['Elizabethtown', 'KY', 37.69, -85.86], ['Nashville', 'TN', 36.16, -86.78], ['Chattanooga', 'TN', 35.05, -85.3], ['Memphis', 'TN', 35.12, -89.97],
  ['Jackson', 'MS', 32.3, -90.18], ['Cincinnati', 'OH', 39.1, -84.51], ['Columbus', 'OH', 39.96, -83.0], ['Knoxville', 'TN', 35.96, -83.92], ['Gulfport', 'MS', 30.37, -89.09], ['Hattiesburg', 'MS', 31.33, -89.29], ['New Orleans', 'LA', 29.95, -90.07], ['Baton Rouge', 'LA', 30.45, -91.15],
];
const PREFIX = { Mobile: 'Mobile Bay', Montgomery: 'Capital City', Dothan: 'Wiregrass', Birmingham: 'Magic City', Pensacola: 'Emerald Coast', Tallahassee: 'Big Bend', Jacksonville: 'First Coast', Ocala: 'Horse Country', Orlando: 'Central Florida', Macon: 'Peach State', Atlanta: 'Metro ATL', Savannah: 'Lowcountry', Albany: 'Southwest Georgia', Tifton: 'Tift County', Charlotte: 'Queen City', Greensboro: 'Triad', Raleigh: 'Triangle', Asheville: 'Blue Ridge', Greenville: 'Upstate', Columbia: 'Midlands', Spartanburg: 'Spartan', Lexington: 'Bluegrass', Louisville: 'Derby City', Elizabethtown: 'Lincoln Trail', Nashville: 'Music City', Chattanooga: 'Scenic City', Memphis: 'Mid-South', Jackson: 'Magnolia', Cincinnati: 'Queen City Ohio', Columbus: 'Buckeye', Knoxville: 'Smoky Mountain', Gulfport: 'Gulf Shore', Hattiesburg: 'Pine Belt', 'New Orleans': 'Crescent City', 'Baton Rouge': 'Capital Region' };
const HEAVY = ['Freightliner', 'Peterbilt', 'Kenworth', 'Volvo', 'International', 'Mack'];
const SUFFIX = ['Truck Center', 'Truck & Trailer Sales', 'Heavy Duty Service', 'Diesel Service Center', 'Fleet Service Center'];
const HOURS = ['Mon-Fri 7a-6p', 'Mon-Sat 6a-9p', 'Mon-Fri 7a-5p, Sat 8a-12p', '24/7 emergency service'];
const dealers = [];
function add(brand, ci, kindIdx, heavy) {
  const [city, st, lat, lng] = CITIES[ci];
  const h = hashStr(brand + city);
  const open24 = h % 4 === 0;
  const type = h % 10 === 0 ? 'mobile_service' : h % 5 === 0 ? 'service_center' : 'dealer';
  const nm = heavy ? `${PREFIX[city]} ${SUFFIX[h % SUFFIX.length]}` : `${PREFIX[city]} Commercial Vehicle ${type === 'service_center' ? 'Service' : 'Center'}`;
  dealers.push({
    id: `dlr_${brand.toLowerCase().replace(/\W/g, '')}_${city.toLowerCase().replace(/\W/g, '')}`, name: `${nm} (${brand})`, brand, type,
    address: `${100 + (h % 8900)} ${['Industrial Blvd', 'Truck Center Dr', 'Commerce Pkwy', 'Fleet St', 'Highway 80 W'][h % 5]}, ${city}, ${st}`,
    lat: +(lat + ((h % 100) - 50) / 3000).toFixed(4), lng: +(lng + (((h >> 8) % 100) - 50) / 3000).toFixed(4),
    phone: `+1${['251', '334', '850', '404', '912', '704', '864', '859', '502', '615', '601'][h % 11]}555${String(1000 + (h % 8999))}`,
    hours: open24 ? '24/7 emergency service' : HOURS[h % 3], open24x7: open24, heavyDutyBays: heavy && type !== 'mobile_service' || (heavy && open24),
    hasPartsInStock: h % 7 === 0 ? null : h % 3 !== 0,
  });
}
HEAVY.forEach((b, bi) => CITIES.forEach((c, ci) => { if ((ci + bi) % 2 === 0) add(b, ci, bi, true); }));
CITIES.forEach((c, ci) => { add('Ford', ci, 0, false); if (ci % 2 === 0) add('Mercedes-Benz', ci, 0, false); });
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
const ALIAS = { mercedes: 'Mercedes-Benz', mercedesbenz: 'Mercedes-Benz' };
function list({ oem, lat, lng, limit, heavyOnly } = {}) {
  const o = oem ? (ALIAS[norm(oem)] || oem) : null;
  let rows = dealers.filter((d) => !o || norm(d.brand) === norm(o)).filter((d) => !heavyOnly || d.heavyDutyBays);
  rows = rows.map((d) => {
    const dist = lat != null && lng != null ? haversineMi(lat, lng, d.lat, d.lng) : null;
    return { ...d, distanceMi: dist == null ? null : round(dist, 1), driveEtaMin: dist == null ? null : Math.round((dist * 1.3 / 45) * 60) };
  }).sort((a, b) => (a.distanceMi ?? 1e9) - (b.distanceMi ?? 1e9));
  return limit ? rows.slice(0, limit) : rows;
}
module.exports = { list, dealers, CITIES };
