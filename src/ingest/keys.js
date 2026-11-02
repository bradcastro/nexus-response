// Per-fleet API keys: nxk_live_<32 hex>. Only a SHA-256 hash is stored (plaintext shown once at issue/rotate).
const crypto = require('crypto');
const db = require('../../db');
const hash = (k) => crypto.createHash('sha256').update(k).digest('hex');

async function issueKey(fleetId, label = 'default') {
  const key = 'nxk_live_' + crypto.randomBytes(16).toString('hex');
  const h = hash(key);
  const rec = { id: 'key_' + crypto.randomBytes(5).toString('hex'), fleetId, ukey: h, prefix: key.slice(0, 13) + '...' + key.slice(-4), label, status: 'active', createdAt: new Date().toISOString(), lastUsedAt: null, revokedAt: null };
  await db.put('api_key', rec, { ukey: h });
  return { key, record: publicKey(rec) };
}
const publicKey = (r) => ({ id: r.id, fleetId: r.fleetId, prefix: r.prefix, label: r.label, status: r.status, createdAt: r.createdAt, lastUsedAt: r.lastUsedAt, revokedAt: r.revokedAt });
async function revokeAll(fleetId) {
  const keys = await db.list('api_key', { fleetId, limit: 1000 });
  for (const k of keys) if (k.status === 'active') { k.status = 'revoked'; k.revokedAt = new Date().toISOString(); await db.put('api_key', k, { ukey: k.ukey }); }
}
async function rotateKey(fleetId) { await revokeAll(fleetId); return issueKey(fleetId, 'rotated'); }
async function listKeys(fleetId) { return (await db.list('api_key', { fleetId, limit: 100 })).map(publicKey); }

const touched = new Map();
async function lookup(plain) {
  if (!plain || !/^nxk_live_[0-9a-f]{32}$/.test(plain)) return null;
  const rec = await db.findByKey('api_key', hash(plain));
  if (!rec) return null;
  const t = Date.now();
  if (!touched.has(rec.id) || t - touched.get(rec.id) > 60000) { touched.set(rec.id, t); rec.lastUsedAt = new Date().toISOString(); db.put('api_key', rec, { ukey: rec.ukey }).catch(() => {}); }
  return rec;
}
const fromRequest = (req) => {
  const h = req.headers['x-nexus-key'];
  if (h) return String(h).trim();
  const a = req.headers.authorization;
  if (a && /^Bearer\s+nxk_/i.test(a)) return a.replace(/^Bearer\s+/i, '').trim();
  return null;
};
module.exports = { issueKey, rotateKey, revokeAll, listKeys, lookup, fromRequest, hash };
