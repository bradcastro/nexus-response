const builders = { motive: require('./motive'), samsara: require('./samsara'), geotab: require('./geotab'), lytx: require('./lytx'), mantis: require('./mantis'), generic: require('./generic') };

// A static example spec used for GET /api/demo/sample/:provider
const SAMPLE_SPEC = {
  eventId: 'evt_demo_0001', eventType: 'collision', timestamp: '2026-11-01T15:42:10.000Z',
  vehicle: { providerVehicleId: '88213', unit: 'GC-114', vin: '3AKJHHDR3PA000042', make: 'Freightliner', model: 'Cascadia 126', year: 2023, plate: 'AL-GCF-114' },
  driver: { providerDriverId: 'drv_5521', name: 'Marcus Johnson', phone: '+12515550142' },
  location: { lat: 30.6954, lng: -88.0399, address: 'I-10 EB near Exit 22, Mobile, AL', speed_mph: 62, heading: 80 },
  gForce: 4.6, airbag: true, aiLabel: 'collision', aiConfidence: 0.94, facingForward: true, hasCamera: true, driverFacing: true,
  mantis: { followS: 0.9, fcw: true, drowsiness: 0.12, seatbelt: true, eyesOff: 0.6 },
  odometer_mi: 214330, engineHours: 5120, faultLamp: false,
};
const SAMPLE_DTC_SPEC = { ...SAMPLE_SPEC, eventId: 'evt_demo_0002', eventType: 'fault_code', gForce: null, airbag: false, hasCamera: false, faultLamp: true, dtcs: [{ spn: 3251, fmi: 0 }, { spn: 4364, fmi: 18 }] };

const build = (provider, spec) => (builders[provider] || builders.generic).build(spec);
const sample = (provider, kind = 'collision') => build(provider, kind === 'dtc' ? SAMPLE_DTC_SPEC : SAMPLE_SPEC);
module.exports = { build, sample, builders };
