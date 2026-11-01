// DTC decoder: ~40 common J1939 SPN/FMI and OBD-II codes.
// cols: key, desc, system, severity, drivable, recommendedAction, partsHint, estCostUsd, warrantyCategory
const T = [
  // ---- J1939 ----
  ['100:1', 'Engine oil pressure - extremely low', 'Engine', 'critical', 'no', 'Stop engine immediately. Tow to shop; inspect oil pump, pickup and bearings.', 'Oil pump, oil pressure sensor, engine bearings', 6800, 'powertrain'],
  ['110:0', 'Engine coolant temperature - extremely high', 'Cooling', 'critical', 'no', 'Shut down to prevent engine damage. Check coolant level, water pump, thermostat, fan clutch.', 'Water pump, thermostat, fan clutch, coolant', 2400, 'powertrain'],
  ['110:15', 'Engine coolant temperature - high (least severe)', 'Cooling', 'medium', 'yes', 'Reduce load and monitor; inspect cooling system at next stop.', 'Coolant, thermostat, radiator cap', 650, 'powertrain'],
  ['111:1', 'Engine coolant level - low', 'Cooling', 'high', 'limp', 'Top off coolant and pressure test for leaks (hoses, radiator, EGR cooler).', 'Coolant hoses, radiator, EGR cooler', 1100, 'powertrain'],
  ['102:1', 'Boost pressure - low', 'Engine', 'high', 'limp', 'Inspect charge-air piping for leaks; test turbocharger and wastegate/VGT actuator.', 'Turbocharger, VGT actuator, CAC hose', 3900, 'powertrain'],
  ['102:2', 'Boost pressure sensor - erratic', 'Engine', 'medium', 'yes', 'Replace/clean boost pressure sensor; inspect wiring.', 'Boost pressure sensor, harness connector', 420, 'powertrain'],
  ['157:1', 'Fuel rail pressure - low', 'Fuel', 'high', 'limp', 'Replace fuel filters; test high-pressure pump and rail pressure relief valve.', 'Fuel filters, HP fuel pump, rail pressure sensor', 3200, 'powertrain'],
  ['157:18', 'Fuel rail pressure - low (moderate)', 'Fuel', 'medium', 'yes', 'Check fuel filter restriction and lift-pump pressure.', 'Fuel filter, lift pump', 540, 'powertrain'],
  ['94:1', 'Fuel delivery pressure - low', 'Fuel', 'high', 'limp', 'Inspect fuel filters/lines for restriction or air ingress; test lift pump.', 'Fuel filter, lift pump, fuel line', 780, 'powertrain'],
  ['168:4', 'Battery potential - voltage below normal', 'Electrical', 'medium', 'yes', 'Load-test batteries and charging system; clean terminals; test alternator.', 'Battery, alternator, terminals', 520, 'bumper_to_bumper'],
  ['190:0', 'Engine speed - overspeed', 'Engine', 'high', 'limp', 'Inspect for runaway/turbo oil seal leak; verify transmission downshift behavior.', 'Turbo seals, ECM calibration', 1900, 'powertrain'],
  ['91:2', 'Accelerator pedal position - erratic', 'Engine', 'high', 'limp', 'Replace accelerator pedal assembly; check harness for chafing.', 'Accelerator pedal sensor, harness', 460, 'bumper_to_bumper'],
  ['105:0', 'Intake manifold temperature - extremely high', 'Engine', 'medium', 'yes', 'Check charge-air cooler for blockage/oil fouling.', 'Charge air cooler, intake temp sensor', 1500, 'powertrain'],
  ['175:0', 'Engine oil temperature - extremely high', 'Engine', 'high', 'limp', 'Check oil cooler, oil level and cooling system.', 'Oil cooler, thermostat', 1400, 'powertrain'],
  ['127:1', 'Transmission oil pressure - low', 'Transmission', 'critical', 'no', 'Do not drive. Check fluid level; inspect transmission pump and valve body.', 'Transmission pump, filter, valve body', 5200, 'powertrain'],
  ['177:0', 'Transmission oil temperature - extremely high', 'Transmission', 'high', 'limp', 'Reduce load; inspect transmission cooler and fluid condition.', 'Transmission cooler, ATF fluid', 1300, 'powertrain'],
  ['3251:0', 'DPF differential pressure - extremely high', 'Aftertreatment', 'high', 'limp', 'Truck derated. Run parked regen; if it fails, service or replace DPF.', 'DPF filter, DPF differential pressure sensor', 4300, 'emissions'],
  ['3719:16', 'DPF soot load - above normal', 'Aftertreatment', 'medium', 'yes', 'Initiate parked regeneration within 100 miles.', 'DPF cleaning service', 450, 'emissions'],
  ['3226:2', 'Aftertreatment outlet NOx sensor - erratic', 'Aftertreatment', 'medium', 'yes', 'Replace outlet NOx sensor; verify SCR efficiency.', 'NOx sensor (outlet)', 1250, 'emissions'],
  ['4364:18', 'SCR catalyst conversion efficiency - low', 'Aftertreatment', 'high', 'limp', 'Truck will derate. Inspect DEF quality/dosing; replace SCR catalyst if confirmed.', 'SCR catalyst, DEF doser, DEF pump', 5600, 'emissions'],
  ['1761:1', 'Diesel exhaust fluid tank level - low', 'Aftertreatment', 'medium', 'yes', 'Refill DEF immediately to avoid derate.', 'DEF fluid', 60, 'emissions'],
  ['5246:0', 'SCR operator inducement - severe', 'Aftertreatment', 'high', 'limp', 'Speed limited by inducement. Diagnose DEF supply/quality and SCR faults; clear after repair.', 'DEF pump, DEF heater, SCR system service', 2700, 'emissions'],
  ['411:1', 'EGR differential pressure - low', 'Emissions', 'medium', 'yes', 'Inspect EGR cooler and valve for carbon/leak.', 'EGR valve, EGR cooler', 2200, 'emissions'],
  ['116:1', 'Brake primary air pressure - low', 'Brakes', 'critical', 'no', 'Do not move vehicle. Inspect air compressor, governor, dryer and lines for leaks.', 'Air compressor, air dryer, brake chamber', 1900, 'bumper_to_bumper'],
  ['117:1', 'Brake secondary air pressure - low', 'Brakes', 'critical', 'no', 'Do not move vehicle. Check for air leaks and compressor output.', 'Air compressor, relay valve', 1500, 'bumper_to_bumper'],
  ['904:2', 'Front axle left wheel speed sensor - erratic', 'Brakes', 'medium', 'yes', 'ABS fault - clean/replace wheel speed sensor and tone ring.', 'Wheel speed sensor, tone ring', 380, 'bumper_to_bumper'],
  ['628:12', 'ECM programming memory - failure', 'Electrical', 'high', 'limp', 'Reflash ECM; replace module if fault persists.', 'Engine control module', 3600, 'powertrain'],
  ['639:2', 'J1939 data link - erratic', 'Electrical', 'medium', 'yes', 'Inspect CAN bus wiring, terminating resistors and connectors.', 'CAN harness, terminating resistor', 550, 'bumper_to_bumper'],
  ['1323:2', 'Engine cylinder 1 misfire - erratic', 'Engine', 'high', 'limp', 'Test injector and compression on cylinder 1.', 'Fuel injector, injector harness', 1850, 'powertrain'],
  ['3031:9', 'DEF tank temperature - abnormal update', 'Aftertreatment', 'low', 'yes', 'Check DEF tank heater circuit.', 'DEF tank heater, temp sensor', 700, 'emissions'],
  // ---- OBD-II ----
  ['P0300', 'Random/multiple cylinder misfire detected', 'Engine', 'high', 'limp', 'Inspect spark plugs/coils or injectors; check fuel pressure and vacuum leaks.', 'Spark plugs, ignition coils, injectors', 780, 'powertrain'],
  ['P0171', 'System too lean (Bank 1)', 'Fuel', 'medium', 'yes', 'Smoke-test intake for leaks; inspect MAF sensor and fuel pressure.', 'MAF sensor, intake gasket, fuel pump', 480, 'powertrain'],
  ['P0420', 'Catalyst system efficiency below threshold (Bank 1)', 'Emissions', 'medium', 'yes', 'Verify O2 sensor operation; replace catalytic converter if confirmed.', 'Catalytic converter, O2 sensor', 1900, 'emissions'],
  ['P0401', 'EGR flow insufficient', 'Emissions', 'medium', 'yes', 'Clean or replace EGR valve and passages.', 'EGR valve, EGR tube', 650, 'emissions'],
  ['P0087', 'Fuel rail/system pressure too low', 'Fuel', 'high', 'limp', 'Replace fuel filter; test high-pressure fuel pump.', 'Fuel filter, HP fuel pump', 2900, 'powertrain'],
  ['P0299', 'Turbo/supercharger underboost', 'Engine', 'high', 'limp', 'Check boost leaks and turbo actuator; inspect intercooler hoses.', 'Turbocharger, intercooler hose, wastegate', 3400, 'powertrain'],
  ['P0128', 'Coolant thermostat below regulating temperature', 'Cooling', 'low', 'yes', 'Replace thermostat.', 'Thermostat', 260, 'powertrain'],
  ['P0562', 'System voltage low', 'Electrical', 'medium', 'yes', 'Load-test battery; test alternator output.', 'Alternator, battery', 600, 'bumper_to_bumper'],
  ['P0700', 'Transmission control system malfunction', 'Transmission', 'high', 'limp', 'Scan TCM for specific codes; inspect fluid and solenoids.', 'TCM, shift solenoid pack', 2300, 'powertrain'],
  ['P0218', 'Transmission over-temperature condition', 'Transmission', 'high', 'limp', 'Inspect transmission cooler and fluid; reduce load.', 'Transmission cooler, ATF', 1100, 'powertrain'],
  ['P2002', 'Diesel particulate filter efficiency below threshold', 'Aftertreatment', 'high', 'limp', 'Perform forced regen; inspect/replace DPF.', 'DPF, DPF pressure sensor', 3800, 'emissions'],
  ['P20EE', 'SCR NOx catalyst efficiency below threshold', 'Aftertreatment', 'high', 'limp', 'Diagnose DEF dosing and SCR catalyst; expect derate if unresolved.', 'SCR catalyst, DEF injector', 4700, 'emissions'],
  ['P0524', 'Engine oil pressure too low', 'Engine', 'critical', 'no', 'Stop engine; inspect oil level/pump. Tow required.', 'Oil pump, oil pressure sensor', 5900, 'powertrain'],
  ['C0035', 'Left front wheel speed sensor circuit', 'Brakes', 'medium', 'yes', 'Inspect wheel speed sensor and wiring.', 'Wheel speed sensor', 340, 'bumper_to_bumper'],
  ['C2000-TPMS', 'Tire pressure monitoring - low pressure', 'Tires', 'medium', 'yes', 'Inspect and inflate tire; check for puncture.', 'Tire, valve stem, TPMS sensor', 320, 'bumper_to_bumper'],
];
const TABLE = {};
for (const r of T) {
  const [key, desc, system, severity, drivable, recommendedAction, partsHint, estCostUsd, warrantyCategory] = r;
  const e = { key, desc, system, severity, drivable, recommendedAction, partsHint, estCostUsd, warrantyCategory };
  if (key.includes(':')) { const [spn, fmi] = key.split(':'); e.spn = +spn; e.fmi = +fmi; e.code = `SPN ${spn} FMI ${fmi}`; }
  else e.code = key.replace('-TPMS', '');
  TABLE[key] = e;
}
const SEV_RANK = { low: 1, medium: 2, high: 3, critical: 4 };
const DRIVE_RANK = { yes: 0, limp: 1, no: 2 };

function parse(input) {
  if (input == null) return null;
  if (typeof input === 'object') {
    if (input.spn != null) return { key: `${input.spn}:${input.fmi != null ? input.fmi : 0}`, spn: +input.spn, fmi: input.fmi != null ? +input.fmi : 0, desc: input.desc || input.description };
    if (input.code) { const p = parse(String(input.code)); if (p) { p.desc = p.desc || input.desc || input.description; } return p; }
    return null;
  }
  const s = String(input).trim().toUpperCase();
  let m = s.match(/SPN\s*[:=]?\s*(\d+)\D+FMI\s*[:=]?\s*(\d+)/);
  if (m) return { key: `${+m[1]}:${+m[2]}`, spn: +m[1], fmi: +m[2] };
  m = s.match(/^(\d{1,5})[-:\/](\d{1,2})$/);
  if (m) return { key: `${+m[1]}:${+m[2]}`, spn: +m[1], fmi: +m[2] };
  m = s.match(/^([PCBU][0-9A-F]{4})/);
  if (m) return { key: m[1] };
  if (s === 'C2000') return { key: 'C2000-TPMS' };
  return { key: s };
}

function decodeOne(input) {
  const p = parse(input);
  if (!p) return null;
  const e = TABLE[p.key] || (p.spn != null && Object.values(TABLE).find((x) => x.spn === p.spn));
  if (e) return { code: e.code, desc: e.desc, system: e.system, severity: e.severity, spn: e.spn, fmi: e.fmi, recommendedAction: e.recommendedAction, partsHint: e.partsHint, drivable: e.drivable, estCostUsd: e.estCostUsd, warrantyCategory: e.warrantyCategory };
  return {
    code: p.spn != null ? `SPN ${p.spn} FMI ${p.fmi}` : p.key, desc: p.desc || 'Unrecognized fault code - manufacturer-specific', system: 'Unknown', severity: 'medium',
    spn: p.spn, fmi: p.fmi, recommendedAction: 'Read freeze-frame data with OEM tool; schedule diagnostic inspection.', partsHint: 'TBD after diagnosis', drivable: 'yes', estCostUsd: 500, warrantyCategory: 'bumper_to_bumper',
  };
}

function decodeAll(list) {
  const out = (list || []).map(decodeOne).filter(Boolean);
  const seen = new Set();
  return out.filter((d) => (seen.has(d.code) ? false : seen.add(d.code)));
}

function summarize(dtcs) {
  let sev = 'low', drivable = 'yes';
  for (const d of dtcs) {
    if (SEV_RANK[d.severity] > SEV_RANK[sev]) sev = d.severity;
    if (DRIVE_RANK[d.drivable] > DRIVE_RANK[drivable]) drivable = d.drivable;
  }
  return { severity: dtcs.length ? sev : null, drivable };
}

module.exports = { decodeOne, decodeAll, summarize, TABLE, SEV_RANK, count: Object.keys(TABLE).length };
