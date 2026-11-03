'use strict';
/* Shared-password access gate for hosted demos.
   Enabled only when DEMO_PASSWORD is set (local dev stays open). Not per-user auth:
   one password, one signed session cookie. Vendor webhooks, health, and token-based
   public links (tow jobs, shared reports) stay reachable by design. */
const crypto = require('crypto');

const COOKIE = 'nx_gate';
const TTL_MS = 12 * 60 * 60 * 1000;
const OPEN_PREFIXES = ['/webhook', '/health', '/login', '/logout', '/shared', '/report', '/api/reports', '/job', '/api/jobs', '/favicon'];
const attempts = new Map(); // ip -> [timestamps]

function sign(value, secret) { return crypto.createHmac('sha256', secret).update(value).digest('hex'); }
function safeEq(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function readCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
function tooManyAttempts(ip) {
  const now = Date.now();
  const list = (attempts.get(ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  attempts.set(ip, list);
  return list.length >= 10;
}

function loginPage(next, error) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in · Nexus Response</title><link rel="icon" href="/shared/favicon.svg">
<link rel="stylesheet" href="/shared/brand.css"><script src="/shared/brand.js"></script>
<style>
body{display:grid;place-items:center;min-height:100vh;margin:0;padding:var(--nx-sp-4,16px);background:var(--nx-bg,#0b1220);color:var(--nx-text,#e6edf7);font-family:var(--nx-font-body,system-ui,sans-serif)}
.card{width:100%;max-width:380px;background:var(--nx-surface,#111a2e);border:1px solid var(--nx-border,#24324f);border-radius:12px;padding:28px}
.card img{height:34px;margin-bottom:18px}
h1{font-size:22px;margin:0 0 6px;letter-spacing:.02em}
p{margin:0 0 18px;color:var(--nx-text-dim,#9fb0cc);font-size:14px;line-height:1.5}
label{display:block;font-size:12px;margin-bottom:6px;color:var(--nx-text-dim,#9fb0cc)}
input{width:100%;box-sizing:border-box;padding:11px 12px;font-size:16px;border-radius:8px;border:1px solid var(--nx-border,#24324f);background:var(--nx-bg,#0b1220);color:inherit}
input:focus{outline:2px solid var(--nx-accent,#ff6a1a);outline-offset:1px}
button{margin-top:14px;width:100%;padding:12px;border:0;border-radius:8px;background:var(--nx-accent,#ff6a1a);color:#fff;font-weight:600;font-size:15px;cursor:pointer}
.err{margin-top:12px;color:#ff8a8a;font-size:13px}
.note{margin-top:16px;font-size:12px;color:var(--nx-text-faint,#8196b3)}
</style></head><body>
<form class="card" method="post" action="/login">
<img src="/shared/logo.svg" alt="Nexus Response">
<h1>Private demo</h1>
<p>Enter the access password you were given to view Nexus Response. Synthetic demo data only.</p>
<input type="hidden" name="next" value="${esc(next)}">
<label for="pw">Access password</label>
<input id="pw" name="password" type="password" autocomplete="current-password" autofocus required>
<button type="submit">Continue</button>
${error ? `<div class="err" role="alert">${esc(error)}</div>` : ''}
<div class="note">Shared access gate for the hosted demo. Not a user account.</div>
</form></body></html>`;
}

function safeNext(n) { return typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') && !n.startsWith('/login') ? n : '/'; }

function install(app, express) {
  const password = process.env.DEMO_PASSWORD;
  if (!password) return false;
  const secret = process.env.SESSION_SECRET || password;
  const secure = process.env.NODE_ENV === 'production' || process.env.TRUST_PROXY ? '; Secure' : '';

  const valid = (req) => {
    const c = readCookie(req, COOKIE);
    if (!c) return false;
    const [exp, sig] = c.split('.');
    return !!exp && !!sig && Number(exp) > Date.now() && safeEq(sig, sign(exp, secret));
  };

  const form = express.urlencoded({ extended: false, limit: '4kb' });
  app.get('/login', (req, res) => { res.set('Cache-Control', 'no-store').type('html').send(loginPage(safeNext(req.query.next))); });
  app.post('/login', form, (req, res) => {
    const ip = req.ip || 'unknown';
    const next = safeNext(req.body && req.body.next);
    if (tooManyAttempts(ip)) return res.status(429).set('Cache-Control', 'no-store').type('html').send(loginPage(next, 'Too many attempts. Try again in a few minutes.'));
    if (!safeEq(sign(String(req.body && req.body.password || ''), 'cmp'), sign(password, 'cmp'))) {
      attempts.get(ip).push(Date.now());
      return res.status(401).set('Cache-Control', 'no-store').type('html').send(loginPage(next, 'That password is not right.'));
    }
    const exp = String(Date.now() + TTL_MS);
    res.setHeader('Set-Cookie', `${COOKIE}=${exp}.${sign(exp, secret)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${TTL_MS / 1000}${secure}`);
    res.redirect(303, next);
  });
  app.all('/logout', (req, res) => {
    res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
    res.redirect(303, '/login');
  });

  app.use((req, res, next) => {
    if (OPEN_PREFIXES.some((p) => req.path === p || req.path.startsWith(p + '/'))) return next();
    if (valid(req)) return next();
    if (req.path.startsWith('/api/') || req.path.startsWith('/test/')) return res.status(401).json({ error: 'auth_required', message: 'Sign in at /login' });
    return res.redirect(302, '/login?next=' + encodeURIComponent(req.originalUrl));
  });
  console.log('[NEXUS] access gate enabled (DEMO_PASSWORD set)');
  return true;
}

module.exports = { install };
