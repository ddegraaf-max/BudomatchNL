// lib/auth.js — wachtwoord-hashing (scrypt) + JWT (HMAC-SHA256), zonder externe dependencies
const crypto = require('crypto');

const SECRET = process.env.SESSION_SECRET || 'budomatch-dev-secret-change-me';

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const test = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex'), b = Buffer.from(test, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
function sign(payload, days = 30) {
  const body = { ...payload, exp: Date.now() + days * 864e5 };
  const data = b64(body);
  const sig = crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}
function verify(token) {
  if (!token || !token.includes('.')) return null;
  const [data, sig] = token.split('.');
  const expect = crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
  if (sig !== expect) return null;
  try {
    const body = JSON.parse(Buffer.from(data, 'base64url').toString());
    if (!body.exp || body.exp < Date.now()) return null;
    return body;
  } catch { return null; }
}

// cookie helpers
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('='); if (i < 0) return;
    out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function setAuthCookie(res, token, secure) {
  res.setHeader('Set-Cookie',
    `bm_token=${token}; HttpOnly; Path=/; Max-Age=${30 * 86400}; SameSite=Lax${secure ? '; Secure' : ''}`);
}
function clearAuthCookie(res) {
  res.setHeader('Set-Cookie', 'bm_token=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
}

module.exports = { hashPassword, verifyPassword, sign, verify, parseCookies, setAuthCookie, clearAuthCookie };
