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

// ---- TOTP (RFC 6238) voor twee-staps­verificatie, zonder externe dependency ----
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const b of buf) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(str) {
  str = String(str).toUpperCase().replace(/=+$/, '').replace(/\s/g, '');
  let bits = 0, value = 0; const out = [];
  for (const c of str) { const idx = B32.indexOf(c); if (idx < 0) continue; value = (value << 5) | idx; bits += 5; if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; } }
  return Buffer.from(out);
}
function totpAt(secretB32, counter) {
  const key = base32Decode(secretB32);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const h = crypto.createHmac('sha1', key).update(buf).digest();
  const off = h[h.length - 1] & 0xf;
  const code = ((h[off] & 0x7f) << 24 | (h[off + 1] & 0xff) << 16 | (h[off + 2] & 0xff) << 8 | (h[off + 3] & 0xff)) % 1e6;
  return String(code).padStart(6, '0');
}
function verifyTotp(secretB32, token) {
  token = String(token || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(token) || !secretB32) return false;
  const c = Math.floor(Date.now() / 1000 / 30);
  for (let w = -1; w <= 1; w++) { if (totpAt(secretB32, c + w) === token) return true; }
  return false;
}
function genTotpSecret() { return base32Encode(crypto.randomBytes(20)); }
function otpauthUrl(secret, email) {
  return `otpauth://totp/Budomatch:${encodeURIComponent(email)}?secret=${secret}&issuer=Budomatch&algorithm=SHA1&digits=6&period=30`;
}
// Herstelcodes (backup codes): eenmalig te tonen, hashed opgeslagen
function genRecoveryCodes(n = 8) {
  const codes = [];
  for (let i = 0; i < n; i++) {
    const raw = crypto.randomBytes(5).toString('hex').toUpperCase(); // 10 hex chars
    codes.push(raw.slice(0, 5) + '-' + raw.slice(5));
  }
  return codes;
}
function hashRecovery(code) {
  const norm = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return crypto.createHash('sha256').update(norm).digest('hex');
}

module.exports = { hashPassword, verifyPassword, sign, verify, parseCookies, setAuthCookie, clearAuthCookie, verifyTotp, genTotpSecret, otpauthUrl, genRecoveryCodes, hashRecovery };
