const crypto = require('crypto');

function env(name) {
  // Netlify Functions expose process.env reliably at runtime.
  // Keep Netlify.env as a secondary compatibility path.
  try {
    const value = process?.env?.[name];
    if (value !== undefined && value !== null && String(value).length) return String(value);
  } catch {}
  try {
    const value = globalThis.Netlify?.env?.get?.(name);
    return value === undefined || value === null ? '' : String(value);
  } catch { return ''; }
}

function secretFor(role) {
  return role === 'admin'
    ? (env('ADMIN_SESSION_SECRET') || env('ADMIN_PASSWORD'))
    : (env('CLIENT_SESSION_SECRET') || env('ADMIN_SESSION_SECRET') || env('ADMIN_PASSWORD'));
}

function b64(value) { return Buffer.from(value).toString('base64url'); }
function sign(value, secret) { return crypto.createHmac('sha256', secret).update(value).digest('base64url'); }

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function timingSafe(a, b) {
  try {
    const aa = Buffer.from(a), bb = Buffer.from(b);
    return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
  } catch { return false; }
}

function createSession(role, subject, maxAge) {
  const secret = secretFor(role);
  if (!secret) throw new Error(`${role === 'admin' ? 'ADMIN_PASSWORD / ADMIN_SESSION_SECRET' : 'CLIENT_SESSION_SECRET / ADMIN_SESSION_SECRET'} غير مضبوط في Netlify.`);
  const payload = JSON.stringify({ sub: subject || role, role, exp: Date.now() + maxAge * 1000 });
  return `${b64(payload)}.${sign(payload, secret)}`;
}

function verifySession(event, role, cookieName) {
  const secret = secretFor(role);
  if (!secret) return null;
  const cookies = parseCookies(event.headers?.cookie || event.headers?.Cookie || '');
  const token = cookies[cookieName];
  if (!token) return null;
  const [encoded, signature] = token.split('.');
  if (!encoded || !signature) return null;
  let payload;
  try { payload = Buffer.from(encoded, 'base64url').toString('utf8'); } catch { return null; }
  let data;
  try { data = JSON.parse(payload); } catch { return null; }
  if (data.role !== role || !data.sub || Number(data.exp) < Date.now()) return null;
  const expected = sign(payload, secret);
  return timingSafe(signature, expected) ? data : null;
}

function cookie(name, token, maxAge, sameSite = 'Lax') {
  return `${name}=${encodeURIComponent(token)}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=${sameSite}`;
}
function clearCookie(name, sameSite = 'Lax') {
  return `${name}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=${sameSite}`;
}
function json(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extraHeaders },
    body: JSON.stringify(body)
  };
}

module.exports = { createSession, verifySession, cookie, clearCookie, parseCookies, json, env };
