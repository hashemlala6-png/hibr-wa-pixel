const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');
const { requireAdmin, verifySession, json } = require('./auth-utils');

const store = () => getStore({ name: 'hbpx-presence', consistency: 'strong' });
const ACTIVE_MS = 5 * 60 * 1000;
const clean = (v, n = 500) => String(v ?? '').trim().slice(0, n);

function hash(v) {
  return crypto.createHash('sha256').update(String(v || '')).digest('hex').slice(0, 40);
}
function cookies(header = '') {
  return header.split(';').reduce((o, p) => {
    const i = p.indexOf('=');
    if (i > -1) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
    return o;
  }, {});
}
function geoOf(context) {
  const g = context?.geo || {};
  return {
    city: clean(g.city || '', 80),
    country: clean(g.country?.name || g.country || '', 80),
    countryCode: clean(g.country?.code || g.country?.iso_code || '', 12),
    region: clean(g.subdivision?.name || g.subdivision || '', 80)
  };
}
function deviceOf(ua) {
  const x = String(ua || '');
  if (/bot|crawler|spider|slurp/i.test(x)) return 'bot';
  if (/tablet|ipad/i.test(x)) return 'tablet';
  if (/mobile|android|iphone/i.test(x)) return 'mobile';
  return 'desktop';
}
function pageLabel(url) {
  try {
    const u = new URL(url || '/', 'https://local.invalid');
    return clean((u.pathname || '/').replace(/\/$/, '') || '/', 180);
  } catch { return clean(url || '/', 180); }
}
function visitorCookie(id) {
  return `hbpx_visitor=${encodeURIComponent(id)}; Max-Age=${60 * 60 * 24 * 30}; Path=/; Secure; SameSite=Lax`;
}

async function upsert(key, record) {
  await store().setJSON(key, { ...record, updatedAt: new Date().toISOString() });
}

exports.handler = async (event, context) => {
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  const action = event.queryStringParameters?.action || 'heartbeat';

  if (event.httpMethod === 'POST' && action === 'heartbeat') {
    let b = {};
    try { b = JSON.parse(event.body || '{}'); } catch {}
    const mode = ['visitor', 'client', 'owner'].includes(b.mode) ? b.mode : 'visitor';
    const now = new Date().toISOString();
    const ua = clean(event.headers?.['user-agent'] || event.headers?.['User-Agent'] || '', 400);
    const geo = geoOf(context);
    const page = pageLabel(b.page);

    if (mode === 'owner') {
      if (!verifySession(event)) return json(401, { error: 'جلسة المالك منتهية.' });
      const token = cookies(event.headers?.cookie || event.headers?.Cookie || '').hbpx_admin;
      const sid = hash(token);
      await upsert(`owner-${sid}`, { id: `owner-${sid}`, kind: 'owner', accountId: 'owner', page, geo, device: deviceOf(ua), userAgent: ua, createdAt: now });
      return json(200, { ok: true, kind: 'owner' });
    }

    let id = '';
    const cookieMap = cookies(event.headers?.cookie || event.headers?.Cookie || '');
    if (mode === 'visitor') {
      id = clean(cookieMap.hbpx_visitor, 100) || crypto.randomBytes(18).toString('hex');
    } else {
      // لا نخزن Token مساحة العميل نفسه؛ نخزن بصمته فقط.
      const token = clean(b.clientToken, 2000);
      if (!token) return json(400, { error: 'clientToken مطلوب.' });
      id = `client-${hash(token)}`;
    }
    const key = `${mode}-${mode === 'visitor' ? hash(id) : hash(id)}`;
    await upsert(key, { id: key, kind: mode, page, geo, device: deviceOf(ua), userAgent: ua, createdAt: now });
    const headers = mode === 'visitor' && !cookieMap.hbpx_visitor ? { 'Set-Cookie': visitorCookie(id) } : {};
    return json(200, { ok: true, kind: mode }, headers);
  }

  const auth = requireAdmin(event);
  if (auth) return auth;
  if (event.httpMethod === 'POST' && action === 'logout-presence') {
    const token = cookies(event.headers?.cookie || event.headers?.Cookie || '').hbpx_admin;
    if (token) await store().delete(`owner-${hash(token)}`);
    return json(200, { ok: true });
  }
  if (event.httpMethod === 'GET' && action === 'active') {
    const cutoff = Date.now() - ACTIVE_MS;
    const result = await store().list({ prefix: '' });
    const sessions = [];
    for (const item of result.blobs || []) {
      try {
        const x = await store().get(item.key, { type: 'json' });
        if (!x || new Date(x.updatedAt || x.createdAt).getTime() < cutoff) continue;
        sessions.push({ id: x.id, kind: x.kind, accountId: x.accountId || null, page: x.page || '/', geo: x.geo || {}, device: x.device || 'unknown', createdAt: x.createdAt, updatedAt: x.updatedAt });
      } catch {}
    }
    sessions.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    const owners = sessions.filter(x => x.kind === 'owner');
    const visitors = sessions.filter(x => x.kind === 'visitor');
    const clients = sessions.filter(x => x.kind === 'client');
    const accounts = new Set(owners.map(x => x.accountId || 'owner')).size;
    return json(200, {
      activeForMinutes: ACTIVE_MS / 60000,
      counts: { total: sessions.length, visitors: visitors.length, clients: clients.length, ownerSessions: owners.length, ownerAccounts: accounts },
      sessions
    });
  }
  return json(405, { error: 'Method not allowed' });
};
