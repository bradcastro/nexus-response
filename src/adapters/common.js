const crypto = require('crypto');

// HMAC-SHA256 verification of the raw body. Skipped (returns ok) when no secret is configured (demo mode).
function verifyHmac(req, secretEnv, headers) {
  const secret = process.env[secretEnv];
  if (!secret) return { ok: true, skipped: true };
  const sig = headers.map((h) => req.headers[h]).find(Boolean);
  if (!sig) return { ok: false, error: 'missing signature header' };
  const raw = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
  const hex = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const given = String(sig).replace(/^sha256=/i, '');
  try {
    return { ok: crypto.timingSafeEqual(Buffer.from(hex), Buffer.from(given)) };
  } catch (e) { return { ok: false, error: 'bad signature' }; }
}

const num = (v) => (v == null || v === '' ? null : Number(v));
const clip = (url, type, durationSec = 12) => (url ? { url, type, durationSec } : null);
const snap = (url, type = 'road') => (url ? { url, type } : null);
const compact = (a) => a.filter(Boolean);

function skeleton(provider, id, ts) {
  return {
    provider, providerEventId: id != null ? String(id) : null, eventType: 'other', timestamp: ts ? new Date(ts).toISOString() : new Date().toISOString(),
    vehicle: {}, driver: {}, location: {}, trail: [],
    camera: { provider, verified: false, aiVerdict: 'no_video', confidence: 0, clips: [], snapshots: [], signals: [] },
    diagnostics: null, _dtcRaw: [], _hints: {}, raw: null,
  };
}
module.exports = { verifyHmac, num, clip, snap, compact, skeleton };
