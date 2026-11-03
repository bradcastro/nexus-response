// OEM warranty claim lifecycle on warranty.claimPacket (all SIMULATED):
// draft -> ready -> submitted -> under_review -> approved | denied | more_info_needed -> (under_review ->) ... -> paid
const crypto = require('crypto');
const ops = require('./data/ops');
const { hashStr, round } = require('./util');

const NEXT = {
  draft: ['ready', 'submitted'], ready: ['submitted'], submitted: ['under_review'], under_review: ['approved', 'denied', 'more_info_needed'],
  more_info_needed: ['under_review'], approved: ['paid'], denied: ['under_review'], paid: [],
};
const ACTION = { submitted: 'warranty_submitted', under_review: 'warranty_under_review', approved: 'warranty_approved', denied: 'warranty_denied', more_info_needed: 'warranty_more_info_needed', paid: 'warranty_paid' };
const MORE_INFO = ['Please upload the DEF quality test result and the last PM invoice.', 'Need technician notes and the freeze-frame data export for the listed fault codes.', 'Provide proof of scheduled service (last 2 oil/fuel-filter changes).'];
const DENIAL = ['Failure attributed to fluid contamination; maintenance records do not show required service intervals.', 'Component outside the emissions warranty mileage band on OEM-verified odometer.', 'Damage consistent with external impact; not a warranty failure.'];
const iso = (ms) => new Date(ms).toISOString();

function ensureMeta(inc) {
  const cp = inc.warranty && inc.warranty.claimPacket; if (!cp) return null;
  if (!cp.oemDesk) cp.oemDesk = (({ prefix, ...d }) => d)(ops.oemDesk(inc.warranty.oem));
  if (!cp.history) cp.history = [];
  if (cp.preAuthNumber === undefined) cp.preAuthNumber = (inc.warrantyDealer && inc.warrantyDealer.preAuthNumber) || null;
  return cp;
}
function claimNumber(inc) {
  const d = ops.oemDesk(inc.warranty.oem);
  return `${d.prefix}-${new Date(inc.timestamp).getUTCFullYear()}-${String(hashStr('cn' + inc.id) % 900000 + 100000)}`;
}
function preAuth(inc) {
  const cp = inc.warranty.claimPacket;
  if (cp.preAuthNumber) return cp.preAuthNumber;
  if (cp.estimatedValueUsd > 2500) { cp.preAuthNumber = `PA-${inc.warranty.oem.slice(0, 3).toUpperCase()}-${String(inc.id).replace(/\D/g, '')}`; if (inc.warrantyDealer) { inc.warrantyDealer.preAuthNumber = cp.preAuthNumber; } }
  return cp.preAuthNumber || null;
}
function push(inc, status, { note, actor = 'oem', at, extra } = {}) {
  const cp = ensureMeta(inc);
  const t = at || new Date().toISOString();
  cp.status = status;
  cp.history.push({ t, status, by: actor, note: note || '' });
  inc.timeline.push({ t, actor, action: ACTION[status] || 'warranty_' + status, note: note || status, meta: { claimId: inc.warranty.claimId, claimNumber: cp.claimNumber || null, status } });
  if (extra) Object.assign(cp, extra);
}

// idempotent. returns {created:boolean}
function submit(inc, { actor = 'fleet', at } = {}) {
  const cp = ensureMeta(inc);
  if (!cp) throw Object.assign(new Error('No warranty claim packet on this incident'), { status: 409 });
  if (!inc.warranty.claimEligible) throw Object.assign(new Error('Incident is not warranty eligible'), { status: 409 });
  if (cp.status === 'draft' || cp.status === 'ready') {
    const t = at || new Date().toISOString();
    cp.claimNumber = cp.claimNumber || claimNumber(inc);
    preAuth(inc);
    cp.submittedAt = t; cp.submittedTo = cp.oemDesk.portal; cp.confirmation = inc.warranty.claimId;
    push(inc, 'submitted', { actor, at: t, note: `Warranty claim ${inc.warranty.claimId} submitted to ${cp.oemDesk.portal}: claim # ${cp.claimNumber}, est. $${cp.estimatedValueUsd} (simulated)` });
    return { created: true, cp };
  }
  return { created: false, cp };
}

// Move to a target status along the legal path (used by seed + simulate). base = ms timestamp for first step.
function applyStatus(inc, to, { note, actor = 'oem', at, outcomeExtra } = {}) {
  const cp = ensureMeta(inc);
  const allowed = NEXT[cp.status] || [];
  if (!allowed.includes(to)) throw Object.assign(new Error(`Cannot move claim from ${cp.status} to ${to}`), { status: 409, allowed });
  const t = at || new Date().toISOString();
  const est = cp.estimatedValueUsd || 0;
  let msg = note, extra = {};
  if (to === 'under_review') msg = msg || `${cp.oemDesk.name}: claim ${cp.claimNumber} assigned to a warranty reviewer (simulated)`;
  if (to === 'approved') { const amt = Math.round(est * 0.92); extra = { approvedAmountUsd: amt, oemResponse: { receivedAt: t, status: 'approved', message: 'Approved for parts and labor per coverage.', approvedAmountUsd: amt } }; msg = msg || `Approved $${amt.toLocaleString('en-US')} (simulated OEM response)`; }
  if (to === 'denied') { const why = (outcomeExtra && outcomeExtra.reason) || DENIAL[hashStr(inc.id) % DENIAL.length]; extra = { denialReason: why, oemResponse: { receivedAt: t, status: 'denied', message: why } }; msg = msg || `Denied: ${why}`; }
  if (to === 'more_info_needed') { const need = (outcomeExtra && outcomeExtra.requested) || MORE_INFO[hashStr(inc.id) % MORE_INFO.length]; extra = { requestedInfo: need, oemResponse: { receivedAt: t, status: 'more_info_needed', message: need, requestedInfo: need } }; msg = msg || `More information needed: ${need}`; }
  if (to === 'paid') { const amt = cp.approvedAmountUsd || Math.round(est * 0.92); extra = { paidAmountUsd: amt, paidAt: t, paymentRef: 'PAY-' + String(hashStr('pay' + inc.id) % 900000 + 100000), oemResponse: { receivedAt: t, status: 'paid', message: `Payment of $${amt.toLocaleString('en-US')} issued.` } }; msg = msg || `Paid $${amt.toLocaleString('en-US')} (ref ${extra.paymentRef}, simulated)`; }
  push(inc, to, { note: msg, actor: actor, at: t, extra });
  return cp;
}
// choose next OEM response for the demo. outcome forces approved|denied|more_info_needed at the review step.
function simulateNext(inc, outcome) {
  const cp = ensureMeta(inc);
  switch (cp.status) {
    case 'submitted': return 'under_review';
    case 'under_review': {
      if (outcome && ['approved', 'denied', 'more_info_needed'].includes(outcome)) return outcome;
      const r = hashStr('rev' + inc.id + (cp.history.length)) % 100;
      return r < 78 ? 'approved' : r < 92 ? 'more_info_needed' : 'denied';
    }
    case 'more_info_needed': return 'under_review';
    case 'denied': return 'under_review';
    case 'approved': return 'paid';
    default: return null;
  }
}
// walk a (submitted) claim to a target status with realistic spacing, for seed data
function advanceTo(inc, target, baseMs, rng) {
  const cp = ensureMeta(inc); let t = baseMs;
  const path = { under_review: ['under_review'], approved: ['under_review', 'approved'], more_info_needed: ['under_review', 'more_info_needed'], denied: ['under_review', 'denied'], paid: ['under_review', 'approved', 'paid'] }[target] || [];
  for (const st of path) { t += (3 + Math.floor((rng ? rng() : 0.5) * 30)) * 3600000; applyStatus(inc, st, { at: iso(t) }); }
}
function summary(inc) {
  const cp = ensureMeta(inc); if (!cp) return null;
  return {
    claimId: inc.warranty.claimId, claimNumber: cp.claimNumber || null, status: cp.status, preAuthNumber: cp.preAuthNumber || null, oemDesk: cp.oemDesk, estimatedValueUsd: cp.estimatedValueUsd,
    approvedAmountUsd: cp.approvedAmountUsd || null, paidAmountUsd: cp.paidAmountUsd || null, requestedInfo: cp.requestedInfo || null, denialReason: cp.denialReason || null, oemResponse: cp.oemResponse || null,
    submittedAt: cp.submittedAt || null, history: cp.history, nextStatuses: NEXT[cp.status] || [], simulated: true,
    nextActions: cp.status === 'draft' || cp.status === 'ready' ? ['submit'] : cp.status === 'more_info_needed' ? ['upload_info', 'simulate_oem_response'] : cp.status === 'denied' ? ['appeal', 'simulate_oem_response'] : cp.status === 'paid' ? [] : ['simulate_oem_response'],
  };
}

// ---- deterministic spread of seeded claim outcomes (hash-based; consumes no seed RNG so incident data is unchanged) ----
const SEED_DENIALS = ['Outside warranty mileage', 'Aftermarket modification', 'Fault code not covered', 'Missing maintenance records'];
const SEED_MORE_INFO = ['Please upload the last two PM invoices.', 'Need technician notes and the freeze-frame export for the listed fault codes.', 'Provide proof of scheduled service (last 2 oil/fuel-filter changes).'];
// target mix by hash bucket (0-99): paid 38, approved 12, under_review 18, more_info_needed 12, denied 14, submitted 6
const OUTCOME_BANDS = [[38, 'paid'], [50, 'approved'], [68, 'under_review'], [80, 'more_info_needed'], [94, 'denied'], [100, 'submitted']];
function spreadOutcome(inc, nowMs) {
  const cp = inc.warranty && inc.warranty.claimPacket;
  if (!cp || cp.status === 'draft') return false;
  const h = hashStr('outcome' + inc.id), b = h % 100;
  // most claims older than 2 days that were only 'ready' get submitted too; the newest stay ready (to-do for the fleet)
  if (cp.status === 'ready' && (nowMs - +new Date(inc.receivedAt) < 2 * 86400000 || hashStr('rdy' + inc.id) % 100 >= 65 || !inc.warranty.claimEligible)) return false;
  let target = OUTCOME_BANDS.find(([hi]) => b < hi)[1];
  ensureMeta(inc);
  const hrs = (k) => 3 + (hashStr('step' + k + inc.id) % 30);
  const subAt = +new Date(cp.submittedAt || (cp.status === 'ready' ? new Date(+new Date(inc.receivedAt) + (2 + hashStr('sub' + inc.id) % 18) * 3600000).toISOString() : null) || ((inc.timeline.find((e) => e.action === 'warranty_submitted') || {}).t) || new Date(+new Date(inc.receivedAt) + 300 * 60000));
  if (subAt > nowMs) return false;
  const PATH = { submitted: [], under_review: ['under_review'], more_info_needed: ['under_review', 'more_info_needed'], denied: ['under_review', 'denied'], approved: ['under_review', 'approved'], paid: ['under_review', 'approved', 'paid'] };
  // downgrade until the path fits before "now" (recent claims cannot already be decided)
  const order = ['paid', 'approved', 'denied', 'more_info_needed', 'under_review', 'submitted'];
  const fits = (t) => { let at = subAt; for (let k = 0; k < PATH[t].length; k++) at += hrs(k) * 3600000; return at <= nowMs; };
  while (!fits(target) && target !== 'submitted') target = order[order.indexOf(target) + 1];
  // rebuild the lifecycle from the submission point
  cp.history = [{ t: new Date(subAt).toISOString(), status: 'submitted', by: 'fleet', note: 'Submitted (simulated)' }];
  inc.timeline = inc.timeline.filter((e) => !/^(warranty_submitted|warranty_under_review|warranty_approved|warranty_denied|warranty_more_info_needed|warranty_paid)$/.test(e.action));
  for (const k of ['approvedAmountUsd', 'paidAmountUsd', 'paidAt', 'paymentRef', 'denialReason', 'requestedInfo', 'oemResponse']) delete cp[k];
  cp.claimNumber = cp.claimNumber || claimNumber(inc); preAuth(inc);
  cp.status = 'submitted'; cp.submittedAt = new Date(subAt).toISOString(); cp.submittedTo = cp.oemDesk.portal; cp.confirmation = inc.warranty.claimId;
  inc.timeline.push({ t: cp.submittedAt, actor: 'fleet', action: 'warranty_submitted', note: `Warranty claim ${inc.warranty.claimId} submitted to ${cp.oemDesk.portal}: claim # ${cp.claimNumber}, est. $${cp.estimatedValueUsd} (simulated)`, meta: { claimId: inc.warranty.claimId, claimNumber: cp.claimNumber, status: 'submitted' } });
  let at = subAt;
  PATH[target].forEach((st, k) => {
    at += hrs(k) * 3600000; const t = iso(at);
    if (st === 'denied') applyStatus(inc, st, { at: t, outcomeExtra: { reason: SEED_DENIALS[hashStr('deny' + inc.id) % SEED_DENIALS.length] } });
    else if (st === 'more_info_needed') applyStatus(inc, st, { at: t, outcomeExtra: { requested: SEED_MORE_INFO[hashStr('info' + inc.id) % SEED_MORE_INFO.length] } });
    else if (st === 'approved') {
      applyStatus(inc, st, { at: t });
      const frac = 0.78 + (hashStr('amt' + inc.id) % 22) / 100; // approved 78-99% of the estimate
      const amt = Math.round((cp.estimatedValueUsd || 0) * frac);
      cp.approvedAmountUsd = amt; cp.oemResponse.approvedAmountUsd = amt; cp.history[cp.history.length - 1].note = `Approved $${amt.toLocaleString('en-US')} (simulated OEM response)`;
      inc.timeline[inc.timeline.length - 1].note = cp.history[cp.history.length - 1].note;
    } else applyStatus(inc, st, { at: t });
  });
  inc.timeline.sort((x, y) => (x.t < y.t ? -1 : x.t > y.t ? 1 : 0));
  return true;
}
module.exports = { spreadOutcome, NEXT, ensureMeta, submit, applyStatus, simulateNext, advanceTo, summary, claimNumber };
