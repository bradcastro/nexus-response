// Static reference data: fleets, locations, roadside providers, vehicle models, names.
const FLEETS = [
  { id: 'fleet_gulfcoast', name: 'Gulf Coast Freight', vendor: 'motive', region: 'Gulf Coast (AL/MS/FL Panhandle)', vehicles: 38, home: 'Mobile, AL', models: [['fcascadia', 70], ['fm2', 30]], cameraPct: 0.82, events: 28, bias: 0.6, profile: { collision: 0.65, speeding: 0.8, harsh: 0.9, distraction: 0.7, diag: 1.0 }, regions: ['gulf'] },
  { id: 'fleet_goodyear', name: 'Goodyear Towing', vendor: 'motive', region: 'Wiregrass (AL/GA/FL Panhandle)', vehicles: 22, home: 'Enterprise, AL', models: [['ff550', 40], ['kt680', 30], ['kt880', 30]], cameraPct: 0.9, events: 12, bias: 0.4, profile: { collision: 0.6, speeding: 0.7, harsh: 0.8, distraction: 0.6, diag: 1.2 }, regions: ['wiregrass'] },
  { id: 'fleet_piedmont', name: 'Piedmont Logistics', vendor: 'samsara', region: 'Carolinas / North Georgia', vehicles: 54, home: 'Charlotte, NC', models: [['vnl', 60], ['p579', 40]], cameraPct: 0.74, events: 46, bias: 0.75, profile: { collision: 1.7, speeding: 1.6, harsh: 1.3, distraction: 1.2, diag: 0.9 }, regions: ['piedmont'] },
  { id: 'fleet_bluegrass', name: 'Bluegrass Dairy Transport', vendor: 'geotab', region: 'Kentucky / Tennessee', vehicles: 31, home: 'Lexington, KY', models: [['p579', 55], ['p567', 45]], cameraPct: 0.4, events: 14, bias: 0.3, profile: { collision: 0.5, speeding: 0.6, harsh: 0.7, distraction: 0.5, diag: 1.4 }, regions: ['bluegrass'] },
  { id: 'fleet_summit', name: 'Summit Last-Mile Delivery', vendor: 'lytx', region: 'Georgia / North Florida', vehicles: 67, home: 'Atlanta, GA', models: [['transit', 55], ['sprinter', 45]], cameraPct: 1.0, events: 50, bias: 0.55, profile: { collision: 1.1, speeding: 0.8, harsh: 1.8, distraction: 1.8, diag: 0.7 }, regions: ['metro'] },
];

// region tags: gulf, wiregrass, piedmont, bluegrass, metro
const LOCATIONS = [
  { road: 'I-10 EB', city: 'Mobile', st: 'AL', lat: 30.6954, lng: -88.0399, h: 80, r: ['gulf'] },
  { road: 'I-10 WB', city: 'Daphne', st: 'AL', lat: 30.6244, lng: -87.9036, h: 260, r: ['gulf'] },
  { road: 'I-65 NB', city: 'Evergreen', st: 'AL', lat: 31.4335, lng: -86.9547, h: 5, r: ['gulf', 'wiregrass'] },
  { road: 'I-65 SB', city: 'Greenville', st: 'AL', lat: 31.8296, lng: -86.6178, h: 185, r: ['gulf', 'wiregrass'] },
  { road: 'US-98 W', city: 'Hattiesburg', st: 'MS', lat: 31.3271, lng: -89.2903, h: 270, r: ['gulf'] },
  { road: 'I-59 NB', city: 'Laurel', st: 'MS', lat: 31.6941, lng: -89.1306, h: 30, r: ['gulf'] },
  { road: 'I-10 EB', city: 'Pensacola', st: 'FL', lat: 30.4757, lng: -87.2169, h: 85, r: ['gulf', 'wiregrass'] },
  { road: 'I-10 EB', city: 'Marianna', st: 'FL', lat: 30.7744, lng: -85.2268, h: 90, r: ['gulf', 'wiregrass'] },
  { road: 'US-84 E', city: 'Enterprise', st: 'AL', lat: 31.3152, lng: -85.8552, h: 95, r: ['wiregrass'] },
  { road: 'US-231 S', city: 'Dothan', st: 'AL', lat: 31.2232, lng: -85.3905, h: 180, r: ['wiregrass'] },
  { road: 'US-431 N', city: 'Eufaula', st: 'AL', lat: 31.8913, lng: -85.1455, h: 10, r: ['wiregrass'] },
  { road: 'US-84 W', city: 'Elba', st: 'AL', lat: 31.4146, lng: -86.0674, h: 265, r: ['wiregrass'] },
  { road: 'AL-167 N', city: 'Ozark', st: 'AL', lat: 31.4590, lng: -85.6405, h: 355, r: ['wiregrass'] },
  { road: 'I-65 NB', city: 'Montgomery', st: 'AL', lat: 32.3792, lng: -86.2999, h: 10, r: ['wiregrass', 'gulf'] },
  { road: 'US-82 E', city: 'Albany', st: 'GA', lat: 31.5785, lng: -84.1557, h: 100, r: ['wiregrass', 'metro'] },
  { road: 'I-85 NB', city: 'Gastonia', st: 'NC', lat: 35.2621, lng: -81.1873, h: 50, r: ['piedmont'] },
  { road: 'I-77 SB', city: 'Charlotte', st: 'NC', lat: 35.3392, lng: -80.8527, h: 180, r: ['piedmont'] },
  { road: 'I-85 SB', city: 'Charlotte', st: 'NC', lat: 35.2271, lng: -80.8895, h: 205, r: ['piedmont'] },
  { road: 'I-40 EB', city: 'Greensboro', st: 'NC', lat: 36.0726, lng: -79.7920, h: 85, r: ['piedmont'] },
  { road: 'I-26 WB', city: 'Hendersonville', st: 'NC', lat: 35.3187, lng: -82.4610, h: 280, r: ['piedmont'] },
  { road: 'I-85 NB', city: 'Spartanburg', st: 'SC', lat: 34.9496, lng: -81.9320, h: 40, r: ['piedmont'] },
  { road: 'I-85 SB', city: 'Greenville', st: 'SC', lat: 34.8526, lng: -82.3940, h: 220, r: ['piedmont'] },
  { road: 'I-26 EB', city: 'Columbia', st: 'SC', lat: 34.0007, lng: -81.0348, h: 120, r: ['piedmont'] },
  { road: 'I-85 NB', city: 'Atlanta', st: 'GA', lat: 33.8003, lng: -84.3963, h: 40, r: ['piedmont', 'metro'] },
  { road: 'I-40 WB', city: 'Statesville', st: 'NC', lat: 35.7827, lng: -80.8873, h: 270, r: ['piedmont'] },
  { road: 'I-64 EB', city: 'Lexington', st: 'KY', lat: 38.0406, lng: -84.4590, h: 90, r: ['bluegrass'] },
  { road: 'I-75 NB', city: 'Georgetown', st: 'KY', lat: 38.2098, lng: -84.5588, h: 10, r: ['bluegrass'] },
  { road: 'I-65 SB', city: 'Louisville', st: 'KY', lat: 38.2527, lng: -85.7585, h: 190, r: ['bluegrass'] },
  { road: 'I-65 NB', city: 'Elizabethtown', st: 'KY', lat: 37.6939, lng: -85.8591, h: 15, r: ['bluegrass'] },
  { road: 'Bluegrass Pkwy', city: 'Versailles', st: 'KY', lat: 38.0523, lng: -84.7300, h: 300, r: ['bluegrass'] },
  { road: 'I-75 SB', city: 'Richmond', st: 'KY', lat: 37.7479, lng: -84.2947, h: 185, r: ['bluegrass'] },
  { road: 'I-24 WB', city: 'Nashville', st: 'TN', lat: 36.1627, lng: -86.7816, h: 250, r: ['bluegrass'] },
  { road: 'I-71 SB', city: 'Carrollton', st: 'KY', lat: 38.6809, lng: -85.1800, h: 215, r: ['bluegrass'] },
  { road: 'I-285 EB', city: 'Atlanta', st: 'GA', lat: 33.9024, lng: -84.3050, h: 95, r: ['metro'] },
  { road: 'I-75 SB', city: 'Marietta', st: 'GA', lat: 33.9526, lng: -84.5499, h: 200, r: ['metro'] },
  { road: 'GA-400 NB', city: 'Alpharetta', st: 'GA', lat: 34.0754, lng: -84.2941, h: 10, r: ['metro'] },
  { road: 'I-20 WB', city: 'Atlanta', st: 'GA', lat: 33.7490, lng: -84.3300, h: 270, r: ['metro'] },
  { road: 'I-75 NB', city: 'Macon', st: 'GA', lat: 32.8407, lng: -83.6324, h: 20, r: ['metro'] },
  { road: 'I-95 SB', city: 'Jacksonville', st: 'FL', lat: 30.3322, lng: -81.6557, h: 190, r: ['metro'] },
  { road: 'I-16 EB', city: 'Savannah', st: 'GA', lat: 32.0809, lng: -81.0912, h: 110, r: ['metro'] },
  { road: 'I-85 SB', city: 'Newnan', st: 'GA', lat: 33.3807, lng: -84.7997, h: 215, r: ['metro'] },
];

const PROVIDERS = [
  { id: 'prov_goodyear', name: 'Goodyear Towing & Recovery', city: 'Enterprise', st: 'AL', lat: 31.3152, lng: -85.8552, heavy: true, services: ['tow_heavy', 'tow_light', 'jump_start', 'mobile_mechanic', 'fuel'], rating: 4.9 },
  { id: 'prov_azalea', name: 'Azalea City Wrecker', city: 'Mobile', st: 'AL', lat: 30.6954, lng: -88.0399, heavy: true, services: ['tow_heavy', 'tow_light', 'jump_start'], rating: 4.7 },
  { id: 'prov_bayou', name: 'Bayou Diesel Mobile Repair', city: 'Mobile', st: 'AL', lat: 30.7, lng: -88.15, heavy: false, services: ['mobile_mechanic', 'tire', 'jump_start', 'fuel'], rating: 4.6 },
  { id: 'prov_panhandle', name: 'Panhandle Heavy Haul Recovery', city: 'Pensacola', st: 'FL', lat: 30.4213, lng: -87.2169, heavy: true, services: ['tow_heavy', 'tow_light'], rating: 4.8 },
  { id: 'prov_capital', name: 'Capital City Roadside', city: 'Montgomery', st: 'AL', lat: 32.3668, lng: -86.3, heavy: true, services: ['tow_heavy', 'tow_light', 'tire', 'jump_start', 'fuel'], rating: 4.5 },
  { id: 'prov_wiregrass', name: 'Wiregrass Mobile Diesel', city: 'Dothan', st: 'AL', lat: 31.2232, lng: -85.3905, heavy: false, services: ['mobile_mechanic', 'tire', 'jump_start', 'fuel'], rating: 4.7 },
  { id: 'prov_magnolia', name: 'Magnolia Tire & Truck Service', city: 'Hattiesburg', st: 'MS', lat: 31.3271, lng: -89.2903, heavy: false, services: ['tire', 'mobile_mechanic', 'jump_start'], rating: 4.4 },
  { id: 'prov_magic', name: 'Magic City Tow & Tire', city: 'Birmingham', st: 'AL', lat: 33.5186, lng: -86.8104, heavy: true, services: ['tow_heavy', 'tow_light', 'tire'], rating: 4.6 },
  { id: 'prov_peach', name: 'Peach State Heavy Towing', city: 'Macon', st: 'GA', lat: 32.8407, lng: -83.6324, heavy: true, services: ['tow_heavy', 'tow_light', 'jump_start'], rating: 4.6 },
  { id: 'prov_metroatl', name: 'Metro ATL Rapid Tow', city: 'Atlanta', st: 'GA', lat: 33.749, lng: -84.388, heavy: true, services: ['tow_heavy', 'tow_light', 'tire', 'jump_start', 'fuel'], rating: 4.5 },
  { id: 'prov_northatl', name: 'North Fulton Mobile Mechanics', city: 'Alpharetta', st: 'GA', lat: 34.0754, lng: -84.2941, heavy: false, services: ['mobile_mechanic', 'tire', 'jump_start'], rating: 4.8 },
  { id: 'prov_coastalga', name: 'Coastal Georgia Truck Rescue', city: 'Savannah', st: 'GA', lat: 32.0809, lng: -81.0912, heavy: true, services: ['tow_heavy', 'tow_light', 'tire'], rating: 4.4 },
  { id: 'prov_rivercity', name: 'River City Wrecker', city: 'Jacksonville', st: 'FL', lat: 30.3322, lng: -81.6557, heavy: true, services: ['tow_heavy', 'tow_light', 'jump_start', 'fuel'], rating: 4.5 },
  { id: 'prov_capitalfl', name: 'Big Bend Roadside', city: 'Tallahassee', st: 'FL', lat: 30.4383, lng: -84.2807, heavy: true, services: ['tow_heavy', 'tow_light', 'tire', 'jump_start'], rating: 4.6 },
  { id: 'prov_queen', name: 'Queen City Heavy Recovery', city: 'Charlotte', st: 'NC', lat: 35.2271, lng: -80.8431, heavy: true, services: ['tow_heavy', 'tow_light', 'jump_start'], rating: 4.7 },
  { id: 'prov_triad', name: 'Triad Roadside Pros', city: 'Greensboro', st: 'NC', lat: 36.0726, lng: -79.792, heavy: false, services: ['tire', 'mobile_mechanic', 'jump_start', 'fuel', 'tow_light'], rating: 4.5 },
  { id: 'prov_upstate', name: 'Upstate Truck & Tire', city: 'Greenville', st: 'SC', lat: 34.8526, lng: -82.394, heavy: true, services: ['tow_heavy', 'tire', 'mobile_mechanic'], rating: 4.6 },
  { id: 'prov_blueridge', name: 'Blue Ridge Wrecker', city: 'Asheville', st: 'NC', lat: 35.5951, lng: -82.5515, heavy: true, services: ['tow_heavy', 'tow_light', 'jump_start'], rating: 4.3 },
  { id: 'prov_bluegrass', name: 'Bluegrass Heavy Rescue', city: 'Lexington', st: 'KY', lat: 38.0406, lng: -84.5037, heavy: true, services: ['tow_heavy', 'tow_light', 'tire', 'mobile_mechanic'], rating: 4.8 },
  { id: 'prov_derby', name: 'Derby City Roadside', city: 'Louisville', st: 'KY', lat: 38.2527, lng: -85.7585, heavy: true, services: ['tow_heavy', 'tow_light', 'tire', 'jump_start', 'fuel'], rating: 4.5 },
  { id: 'prov_volunteer', name: 'Volunteer State Towing', city: 'Nashville', st: 'TN', lat: 36.1627, lng: -86.7816, heavy: true, services: ['tow_heavy', 'tow_light', 'jump_start'], rating: 4.4 },
];

// key -> model spec. wmi(3) + code(5) are used to build/decode VINs.
const MODELS = {
  fcascadia: { oem: 'Freightliner', make: 'Freightliner', model: 'Cascadia 126', wmi: '3AK', code: 'JHHDR', engine: 'Detroit DD15 14.8L', cls: 'heavy', mpy: 95000 },
  fm2:       { oem: 'Freightliner', make: 'Freightliner', model: 'M2 106', wmi: '1FV', code: 'ACWDA', engine: 'Cummins L9 8.9L', cls: 'heavy', mpy: 55000 },
  vnl:       { oem: 'Volvo', make: 'Volvo', model: 'VNL 860', wmi: '4V4', code: 'NC9EH', engine: 'Volvo D13 12.8L', cls: 'heavy', mpy: 100000 },
  p579:      { oem: 'Peterbilt', make: 'Peterbilt', model: '579', wmi: '1XP', code: 'BDP9X', engine: 'PACCAR MX-13 12.9L', cls: 'heavy', mpy: 98000 },
  p567:      { oem: 'Peterbilt', make: 'Peterbilt', model: '567', wmi: '1XP', code: 'CD49X', engine: 'Cummins X15 14.9L', cls: 'heavy', mpy: 85000 },
  kt680:     { oem: 'Kenworth', make: 'Kenworth', model: 'T680', wmi: '1XK', code: 'YD9X0', engine: 'PACCAR MX-13 12.9L', cls: 'heavy', mpy: 70000 },
  kt880:     { oem: 'Kenworth', make: 'Kenworth', model: 'T880', wmi: '1XK', code: 'ZD4X5', engine: 'Cummins X15 14.9L', cls: 'heavy', mpy: 45000 },
  ff550:     { oem: 'Ford', make: 'Ford', model: 'F-550 Super Duty', wmi: '1FD', code: 'UF5HT', engine: '6.7L Power Stroke V8 Diesel', cls: 'light', mpy: 35000 },
  transit:   { oem: 'Ford', make: 'Ford', model: 'Transit 250 Cargo', wmi: '1FT', code: 'BR2X8', engine: '3.5L EcoBoost V6', cls: 'light', mpy: 32000 },
  sprinter:  { oem: 'Mercedes-Benz', make: 'Mercedes-Benz', model: 'Sprinter 2500 Cargo', wmi: 'W1Y', code: '4DC3X', engine: '3.0L OM642 V6 Turbo Diesel', cls: 'light', mpy: 30000 },
};

const FIRST = ['James','Marcus','Luis','Tyrone','Derek','Carlos','Brandon','Wesley','Terrell','Kevin','Antonio','Jamal','Ray','Dale','Travis','Cody','Hector','Raymond','Calvin','Darnell','Shawn','Greg','Miguel','Andre','Lamar','Nate','Robert','Chris','Keith','Dwayne','Maria','Tasha','Angela','Denise','Brittany','Keisha','Sandra','Latoya','Rachel','Monica'];
const LAST = ['Johnson','Williams','Brown','Jones','Garcia','Miller','Davis','Rodriguez','Martinez','Hernandez','Wilson','Anderson','Thomas','Taylor','Moore','Jackson','Martin','Lee','Thompson','White','Harris','Clark','Lewis','Robinson','Walker','Young','Allen','King','Wright','Scott','Hill','Green','Adams','Baker','Nelson','Carter','Mitchell','Perez','Roberts','Turner'];

module.exports = { FLEETS, LOCATIONS, PROVIDERS, MODELS, FIRST, LAST };
