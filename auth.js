const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');
const { createSession, sessionCookie, clearCookie, verifySession, json } = require('./auth-utils');
const { env } = require('./session-core');

const presenceStore = () => getStore({ name: 'hbpx-presence', consistency: 'strong' });
const authStore = () => getStore({ name: 'hbpx-auth-rate', consistency: 'strong' });

function hashToken(token) { return crypto.createHash('sha256').update(token).digest('hex'); }
async function limited(ip) {
  try {
    const store = authStore();
    const key = `admin:${ip || 'unknown'}`;
    const now = Date.now();
    const row = await store.get(key, { type: 'json' });
    if (row && row.reset > now && row.count >= 12) return true;
    await store.setJSON(key, { count: row && row.reset > now ? row.count + 1 : 1, reset: row && row.reset > now ? row.reset : now + 15 * 60 * 1000 });
  } catch { /* rate limiting must never block authentication */ }
  return false;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'GET' && (event.queryStringParameters || {}).action === 'me') {
    return json(200, { authenticated: verifySession(event) });
  }
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
  const action = (event.queryStringParameters || {}).action || '';
  if (action === 'logout') {
    const header = event.headers?.cookie || event.headers?.Cookie || '';
    const match = header.split(';').map(x => x.trim()).find(x => x.startsWith('hbpx_admin='));
    if (match) { try { await presenceStore().delete(`owner-${hashToken(decodeURIComponent(match.slice(11)))}`); } catch {} }
    return json(200, { authenticated: false }, { 'Set-Cookie': clearCookie() });
  }
  if (action !== 'login') return json(400, { error: 'طلب تسجيل دخول غير صالح.' });
  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'بيانات الدخول غير صالحة.' }); }
  if (await limited(event.headers?.['x-forwarded-for'] || event.headers?.['client-ip'] || 'unknown')) return json(429, { error: 'محاولات كثيرة. حاول بعد دقائق.' });
  const expected = env('ADMIN_PASSWORD');
  if (!expected) return json(503, { error: 'إعداد دخول المالك ناقص في Netlify.' });
  const supplied = String(body.password || '');
  const a = Buffer.from(supplied), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return json(401, { error: 'كلمة المرور غير صحيحة.' });
  let token;
  try { token = createSession(); } catch { return json(503, { error: 'إعداد جلسة المالك ناقص في Netlify.' }); }
  try { await presenceStore().setJSON(`owner-${hashToken(token)}`, { kind: 'owner', updatedAt: new Date().toISOString(), page: '/admin.html' }); } catch {}
  return json(200, { authenticated: true }, { 'Set-Cookie': sessionCookie(token) });
};
