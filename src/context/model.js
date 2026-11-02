// Physical + business model shared by the telemetry simulator (ground truth) and the inference engine (nominal calibration).
// The simulator adds per-vehicle bias + noise; inference only sees telemetry, so estimates are genuinely derived (and imperfect).
const CLASSES = {
  class8_sleeper: { gvwr: 80000, tare: 19500, axles: 5, fuelType: 'diesel', ref: { g1: 37000, m1: 8.3, l1: 28, g2: 80000, m2: 6.0, l2: 62 } },
  class8_day_cab: { gvwr: 80000, tare: 17000, axles: 5, fuelType: 'diesel', ref: { g1: 37000, m1: 8.3, l1: 28, g2: 80000, m2: 6.0, l2: 62 } },
  class6_boxtruck: { gvwr: 26000, tare: 14500, axles: 2, fuelType: 'diesel', ref: { g1: 15000, m1: 9.5, l1: 30, g2: 26000, m2: 7.0, l2: 64 } },
  class3_pickup: { gvwr: 19500, tare: 11500, axles: 2, fuelType: 'diesel', ref: { g1: 15000, m1: 9.5, l1: 30, g2: 26000, m2: 7.0, l2: 64 } },
  van: { gvwr: 9500, tare: 5600, axles: 2, fuelType: 'gasoline', ref: { g1: 5700, m1: 17.5, l1: 26, g2: 9500, m2: 14.0, l2: 58 } },
};
// model key -> tractor class (+ weight overrides)
const MODEL_CLASS = {
  fcascadia: { cls: 'class8_sleeper' }, vnl: { cls: 'class8_sleeper' }, p579: { cls: 'class8_sleeper' }, kt680: { cls: 'class8_sleeper' },
  p567: { cls: 'class8_day_cab' }, kt880: { cls: 'class8_day_cab' },
  fm2: { cls: 'class6_boxtruck' }, ff550: { cls: 'class3_pickup', gvwr: 19500, tare: 11500 },
  transit: { cls: 'van', gvwr: 9500, tare: 5600 }, sprinter: { cls: 'van', gvwr: 9990, tare: 5900, fuelType: 'diesel' },
};
const TRAILERS = {
  reefer: { lengthFt: 53, tare: 17500 }, dry_van: { lengthFt: 53, tare: 14200 }, flatbed: { lengthFt: 48, tare: 10800 },
  tanker: { lengthFt: 40, tare: 13500 }, lowboy: { lengthFt: 48, tare: 22000 }, dump: { lengthFt: 24, tare: 15500 },
  car_hauler: { lengthFt: 75, tare: 16000 }, container_chassis: { lengthFt: 40, tare: 7500 }, none: { lengthFt: null, tare: 0 },
};
const MISC_LB = 400; // driver + fuel/def delta + straps

function coeffs(cls) {
  const r = CLASSES[cls].ref;
  const gm1 = 1 / r.m1, gm2 = 1 / r.m2;
  const b = (gm2 - gm1) / (r.g2 - r.g1);
  return { a: gm1 - b * r.g1, b, r };
}
const speedLoadF = (v) => Math.pow(Math.max(v, 20) / 62, 1.6);
const speedMpgF = (v) => Math.max(0.6, 1 - 0.0008 * Math.pow(v - 58, 2));
function loadAt(cls, g) { const { r } = coeffs(cls); return r.l1 + ((r.l2 - r.l1) * (g - r.g1)) / (r.g2 - r.g1); }
function mpgAt(cls, g) { const { a, b } = coeffs(cls); return 1 / (a + b * g); }
function gFromLoadNorm(cls, ln) { const { r } = coeffs(cls); return r.g1 + ((ln - r.l1) * (r.g2 - r.g1)) / (r.l2 - r.l1); }
function gFromMpgNorm(cls, mn) { const { a, b } = coeffs(cls); return (1 / mn - a) / b; }
const dgPerLoadPt = (cls) => { const { r } = coeffs(cls); return (r.g2 - r.g1) / (r.l2 - r.l1); };
const dgPerInvMpg = (cls) => 1 / coeffs(cls).b;

// content categories
const CONTENT = {
  perishable_food: { label: 'Perishable foods (likely)', examples: ['Dairy', 'Produce', 'Fresh meat'], rate: [1.4, 2.4], temp: true },
  frozen_food: { label: 'Frozen foods (likely)', examples: ['Frozen entrees', 'Ice cream', 'Frozen meat'], rate: [2.0, 3.5], temp: true },
  dry_grocery: { label: 'Dry grocery / packaged goods (likely)', examples: ['Canned goods', 'Snacks', 'Paper products'], rate: [0.9, 1.6] },
  beverage: { label: 'Bottled beverages (likely)', examples: ['Bottled water', 'Soft drinks'], rate: [0.5, 0.9] },
  building_materials: { label: 'Building materials (likely)', examples: ['Drywall', 'Roofing', 'Cement bags'], rate: [0.25, 0.5] },
  steel: { label: 'Steel products (likely)', examples: ['Steel coils', 'Rebar', 'Structural beams'], rate: [0.8, 1.5] },
  lumber: { label: 'Lumber (likely)', examples: ['Dimensional lumber', 'Plywood'], rate: [0.35, 0.6] },
  machinery: { label: 'Machinery / equipment (likely)', examples: ['Industrial machinery', 'Construction equipment'], rate: [1.5, 4.0] },
  vehicles: { label: 'Vehicles / equipment on deck (likely)', examples: ['Disabled vehicle', 'Heavy equipment'], rate: [0.6, 2.0] },
  fuel_liquid: { label: 'Flammable liquid - fuel (likely)', examples: ['Gasoline', 'Diesel fuel'], rate: [0.45, 0.7], hazmat: true },
  hazmat: { label: 'Hazardous materials (likely)', examples: ['Industrial chemicals'], rate: [1.0, 2.5], hazmat: true },
  aggregate: { label: 'Aggregate (likely)', examples: ['Crushed stone', 'Sand', 'Gravel'], rate: [0.01, 0.03] },
  parcel: { label: 'Parcels / e-commerce packages (likely)', examples: ['Parcels', 'E-commerce packages'], rate: [4, 12] },
  unknown: { label: 'General freight (low confidence)', examples: ['Mixed consumer goods'], rate: [0.6, 1.6] },
};
module.exports = { CLASSES, MODEL_CLASS, TRAILERS, MISC_LB, coeffs, speedLoadF, speedMpgF, loadAt, mpgAt, gFromLoadNorm, gFromMpgNorm, dgPerLoadPt, dgPerInvMpg, CONTENT };
