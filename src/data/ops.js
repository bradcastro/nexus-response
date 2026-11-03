// Operational reference data for dispatch workflows. EVERYTHING here is fictional/simulated:
// phone numbers use the 555-01xx range, agency / carrier / OEM-portal names are invented.
const { hashStr } = require('../util');

const AREA = { AL: ['205', '251', '334'], FL: ['850', '904'], GA: ['404', '912'], NC: ['704', '336'], SC: ['864', '803'], KY: ['502', '859'], TN: ['615', '865'], MS: ['601', '228'], LA: ['504', '225'], OH: ['513', '614'] };
const STATE_NAME = { AL: 'Alabama', FL: 'Florida', GA: 'Georgia', NC: 'North Carolina', SC: 'South Carolina', KY: 'Kentucky', TN: 'Tennessee', MS: 'Mississippi', LA: 'Louisiana', OH: 'Ohio' };
function phone(seed, st = 'AL') {
  const h = hashStr(String(seed));
  const a = AREA[st] || ['555'];
  return `+1-${a[h % a.length]}-555-01${String(h % 100).padStart(2, '0')}`;
}

const CARRIERS = [
  { id: 'car_harbor', name: 'Harbor Mutual Commercial (simulated)', fnolLine: null },
  { id: 'car_keystone', name: 'Keystone Fleet Underwriters (simulated)', fnolLine: null },
  { id: 'car_bayou', name: 'Bayou Specialty Insurance (simulated)', fnolLine: null },
];
CARRIERS.forEach((c) => { c.fnolLine = phone('fnol' + c.id, 'AL'); c.portal = c.name.split(' (')[0] + ' Claims Portal'; });
const FLEET_CARRIER = { fleet_gulfcoast: 'car_bayou', fleet_elite: 'car_bayou', fleet_piedmont: 'car_keystone', fleet_bluegrass: 'car_harbor', fleet_summit: 'car_keystone', fleet_redline: 'car_harbor', fleet_magnolia: 'car_bayou' };
const carrierOf = (fleetId) => CARRIERS.find((c) => c.id === (FLEET_CARRIER[fleetId] || CARRIERS[hashStr(fleetId) % CARRIERS.length].id));
const policyNo = (fleetId) => `CP-${String(hashStr('pol' + fleetId) % 9000000 + 1000000)}`;

// OEM warranty desks (invented portal names)
const OEM_DESKS = {
  Freightliner: { name: 'Cascadia Warranty Services Desk', portal: 'FleetWarranty Connect', prefix: 'FWC' },
  Peterbilt: { name: 'Marquee Truck Warranty Desk', portal: 'Marquee Claims Portal', prefix: 'MQW' },
  Kenworth: { name: 'Summit Truck Claims Desk', portal: 'Summit Warranty Gateway', prefix: 'SMW' },
  Volvo: { name: 'NorthStar Warranty Hub', portal: 'NorthStar Claims Portal', prefix: 'NSW' },
  Ford: { name: 'Pro Fleet Warranty Gateway', portal: 'ProFleet Warranty Online', prefix: 'PFW' },
  'Mercedes-Benz': { name: 'StarCare Commercial Warranty', portal: 'StarCare Claims Portal', prefix: 'SCW' },
  International: { name: 'Navigator Warranty Network', portal: 'Navigator Claims Hub', prefix: 'NVW' },
  Mack: { name: 'Bulldog Claims Center', portal: 'Bulldog Warranty Portal', prefix: 'BDW' },
};
function oemDesk(oem) {
  const d = OEM_DESKS[oem] || { name: `${oem || 'OEM'} Warranty Desk`, portal: `${oem || 'OEM'} Warranty Portal`, prefix: 'OEM' };
  return { oem, name: d.name, warrantyDesk: phone('desk' + oem, 'GA'), portal: d.portal + ' (simulated)', email: `warranty-desk@${String(oem || 'oem').toLowerCase().replace(/\W/g, '')}-sim.example`, hours: 'Mon-Fri 7a-7p ET', prefix: d.prefix };
}

// City -> county (invented fallback when unknown)
const COUNTY = { Mobile: 'Mobile', Daphne: 'Baldwin', Evergreen: 'Conecuh', Greenville: 'Butler', Hattiesburg: 'Forrest', Laurel: 'Jones', Pensacola: 'Escambia', Marianna: 'Jackson', Enterprise: 'Coffee', Dothan: 'Houston', Eufaula: 'Barbour', Elba: 'Coffee', Ozark: 'Dale', Montgomery: 'Montgomery', Albany: 'Dougherty', Gastonia: 'Gaston', Charlotte: 'Mecklenburg', Greensboro: 'Guilford', Hendersonville: 'Henderson', Spartanburg: 'Spartanburg', Columbia: 'Richland', Atlanta: 'Fulton', Statesville: 'Iredell', Lexington: 'Fayette', Georgetown: 'Scott', Louisville: 'Jefferson', Elizabethtown: 'Hardin', Versailles: 'Woodford', Richmond: 'Madison', Nashville: 'Davidson', Carrollton: 'Carroll', Marietta: 'Cobb', Alpharetta: 'Fulton', Macon: 'Bibb', Jacksonville: 'Duval', Savannah: 'Chatham', Newnan: 'Coweta', Cincinnati: 'Hamilton', Florence: 'Boone', Columbus: 'Franklin', Dayton: 'Montgomery', 'Bowling Green': 'Warren', Knoxville: 'Knox', Chattanooga: 'Hamilton', Cookeville: 'Putnam', Jackson: 'Hinds', Vicksburg: 'Warren', 'Baton Rouge': 'East Baton Rouge', Slidell: 'St. Tammany', Meridian: 'Lauderdale', McComb: 'Pike', Tupelo: 'Lee', Gulfport: 'Harrison' };

const MANAGER_FIRST = ['Dana', 'Chris', 'Jordan', 'Taylor', 'Morgan', 'Riley', 'Casey', 'Avery'];
const MANAGER_LAST = ['Whitfield', 'Okafor', 'Delgado', 'Brennan', 'Castillo', 'Nakamura', 'Prescott', 'Holloway'];
function fleetManagers(fleet) {
  const st = (fleet.home || '').split(', ').pop() || 'AL';
  if (fleet.contact && fleet.contact.email && fleet.custom) return [{ name: fleet.contact.name || 'Fleet contact', phone: phone('fm' + fleet.id, st), email: fleet.contact.email, role: 'Fleet Manager' }];
  const h = hashStr('mgr' + fleet.id);
  const mk = (i, role) => { const n = `${MANAGER_FIRST[(h + i * 3) % 8]} ${MANAGER_LAST[(h + i * 5) % 8]}`; return { name: n, phone: phone('fm' + fleet.id + i, st), email: `${n.toLowerCase().replace(/\W+/g, '.')}@${fleet.id.replace('fleet_', '')}-sim.example`, role }; };
  return [mk(0, 'Fleet Manager'), mk(1, 'Safety Manager'), mk(2, 'On-call Supervisor')];
}

// ---- comms templates ({{vars}} rendered per incident) ----
const TEMPLATES = [
  { key: 'fm_incident_sms', kind: 'fleet_manager', label: 'Fleet manager - incident alert (SMS)', channel: 'sms', subject: null, body: '[{{fleetName}}] {{severity}} {{eventType}}: {{vehicle}} driven by {{driver}} at {{location}}. {{camera}} Nexus ref {{incidentId}}. Reply 1 to acknowledge.' },
  { key: 'fm_incident_email', kind: 'fleet_manager', label: 'Fleet manager - incident summary (email)', channel: 'email', subject: '{{severity}} {{eventType}} - {{vehicle}} - {{incidentId}}', body: 'Hello,\n\nNexus Response detected a {{severity}} {{eventType}} involving {{vehicle}} (driver {{driver}}).\nLocation: {{location}}\nTime: {{time}}\nEvidence: {{camera}}\nCargo: {{cargo}}\nResponse: {{response}}\n\nWe are coordinating directly with the driver and the recovery provider. Full details: {{incidentId}}.\n\n- Nexus Response Dispatch (simulated message)' },
  { key: 'fm_eta_update', kind: 'fleet_manager', label: 'Fleet manager - ETA update (SMS)', channel: 'sms', subject: null, body: '[{{fleetName}}] Update {{incidentId}}: {{provider}} is on the way to {{vehicle}}, ETA {{eta}}. Destination: {{towDestination}}.' },
  { key: 'driver_check_in', kind: 'driver', label: 'Driver - safety check-in (SMS)', channel: 'sms', subject: null, body: 'Hi {{driverFirst}}, this is {{fleetName}} dispatch. We detected a {{eventType}} on your truck. Are you OK? Reply 1 = OK, 2 = need help. Stay clear of traffic if safe.' },
  { key: 'driver_eta', kind: 'driver', label: 'Driver - help is coming (SMS)', channel: 'sms', subject: null, body: 'Hi {{driverFirst}}, {{helpLine}} Please stay with the vehicle, hazards on. Dispatch ref {{incidentId}}.' },
  { key: 'driver_breakdown', kind: 'driver', label: 'Driver - breakdown instructions (SMS)', channel: 'sms', subject: null, body: 'Hi {{driverFirst}}: fault codes {{codes}} reported on your truck. Pull over safely, hazards on, do not continue if oil pressure/coolant warnings are on. Service {{provider}} ETA {{eta}}.' },
  { key: 'tow_dispatch', kind: 'tow', label: 'Tow provider - job dispatch (SMS)', channel: 'sms', subject: null, body: 'NEXUS JOB {{incidentId}}: {{serviceType}} for {{vehicle}} at {{location}}. {{hazards}} Tap to accept & set ETA: {{jobLink}}' },
  { key: 'tow_call_script', kind: 'tow', label: 'Tow provider - call script', channel: 'call', subject: null, body: 'Calling {{provider}}: we need {{serviceType}} at {{location}} ({{road}}). Vehicle: {{vehicle}}. Load: {{cargo}}. Hazards: {{hazards}} Destination: {{towDestination}}. Job ticket link sent by text.' },
  { key: 'insurer_fnol', kind: 'insurer', label: 'Insurer - first notice of loss (email)', channel: 'email', subject: 'FNOL {{incidentId}} - {{fleetName}} - {{eventType}}', body: 'First notice of loss.\nInsured: {{fleetName}}  Policy: {{policyNo}}\nDate/time: {{time}}\nLocation: {{location}}\nVehicle: {{vehicle}}  Driver: {{driver}}\nDescription: {{eventType}} ({{severity}}). {{camera}}\nCargo: {{cargo}}\nAttachments: dashcam clips, trip & load context, evidence summary.\n\n- Nexus Response (simulated submission)' },
  { key: 'insurer_update', kind: 'insurer', label: 'Insurer - status update (email)', channel: 'email', subject: 'Update {{incidentId}} - {{fleetName}}', body: 'Update on {{incidentId}}: current status {{status}}. Recovery provider {{provider}} (ETA {{eta}}). No injuries reported to date: {{injuries}}.\n- Nexus Response (simulated)' },
  { key: 'authority_call', kind: 'authority', label: 'Authority - call script', channel: 'call', subject: null, body: 'Hello, this is Nexus Response dispatch calling on behalf of {{fleetName}}. We are reporting a {{eventType}} on {{road}} near {{city}}, GPS location {{location}}, involving a {{vehicle}}{{trailer}}. Injuries: {{injuries}}. {{hazmatLine}}Lanes blocked: {{lanes}}. Driver {{driver}} is on scene. Callback number: {{callback}}.' },
  { key: 'cargo_delay', kind: 'cargo_owner', label: 'Cargo owner - delay notice (email)', channel: 'email', subject: 'Shipment delay - {{incidentId}}', body: 'Hello {{cargoOwner}},\n\nYour shipment ({{cargo}}) on {{vehicle}} was involved in a {{eventType}} at {{location}}. {{recoveryLine}} {{spoilage}}\nWe will update you as soon as the load is moving again.\n\n- Nexus Response Dispatch (simulated)' },
  { key: 'cargo_perishable', kind: 'cargo_owner', label: 'Cargo owner - perishable alert (SMS)', channel: 'sms', subject: null, body: 'URGENT {{incidentId}}: {{cargo}} delayed at {{location}}. {{spoilage}} Reefer: {{reefer}}. Reply to arrange a transfer truck.' },
];
module.exports = { phone, STATE_NAME, CARRIERS, carrierOf, policyNo, oemDesk, COUNTY, fleetManagers, TEMPLATES, FLEET_CARRIER };
