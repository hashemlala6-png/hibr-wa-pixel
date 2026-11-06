const crypto = require('crypto');
const { getStore, connectLambda } = require('@netlify/blobs');
const { env } = require('./env');
const { requireAdmin, json } = require('./auth-utils');

const CONNECTION_STORE = 'hbpx-instagram-login';
const SNAPSHOT_STORE = 'hbpx-instagram-analytics';
const CONNECTION_KEY = 'agency-instagram';
const API_VERSION = env('INSTAGRAM_API_VERSION') || 'v26.0';
const METRICS = ['views', 'reach', 'accounts_engaged', 'total_interactions', 'follows_and_unfollows', 'profile_links_taps'];

function store(name) {
  const options = { name, consistency: 'eventual' };
  const siteID = env('NETLIFY_SITE_ID') || env('SITE_ID');
  const token = env('NETLIFY_AUTH_TOKEN');
  if (siteID && token) { options.siteID = siteID; options.token = token; }
  return getStore(options);
}
function clean(v, n = 500) { return String(v == null ? '' : v).trim().slice(0, n); }
function secretKey() {
  const secret = env('ADMIN_SESSION_SECRET');
  if (!secret) throw new Error('ADMIN_SESSION_SECRET غير مضبوط في Netlify.');
  return crypto.createHash('sha256').update(secret).digest();
}
function decrypt(box) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', secretKey(), Buffer.from(box.iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(box.tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(box.data, 'base64url')), decipher.final()]).toString('utf8');
}
function dayOffset(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
async function graph(path, token, params = {}) {
  const url = new URL('https://graph.instagram.com/' + API_VERSION + '/' + path.replace(/^\/+/, ''));
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  url.searchParams.set('access_token', token);
  const response = await fetch(url);
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) throw new Error(clean(data.error?.message || 'Instagram API HTTP ' + response.status, 400));
  return data;
}
function numericValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}
function normalizeMetric(metric, name) {
  const total = metric?.total_value?.value;
  if (total && typeof total === 'object' && !Array.isArray(total)) {
    const values = {};
    for (const [key, value] of Object.entries(total)) {
      const n = numericValue(value);
      if (n !== null) values[key] = n;
    }
    return { name, value: Object.keys(values).length ? values : null, available: Object.keys(values).length > 0 };
  }
  const direct = numericValue(total);
  if (direct !== null) return { name, value: direct, available: true };
  const rows = Array.isArray(metric?.values) ? metric.values : [];
  const numbers = rows.map(x => numericValue(x.value)).filter(x => x !== null);
  if (numbers.length) return { name, value: numbers.reduce((a, b) => a + b, 0), points: rows.length, available: true };
  const single = numericValue(metric?.value);
  return { name, value: single, available: single !== null };
}
async function loadLatest() {
  const s = store(SNAPSHOT_STORE), rows = [];
  let cursor;
  do {
    const page = await s.list({ prefix: 'snapshot-', limit: 100, cursor });
    for (const blob of page.blobs || []) {
      const item = await s.get(blob.key, { type: 'json' }).catch(() => null);
      if (item) rows.push(item);
    }
    cursor = page.cursor;
  } while (cursor && rows.length < 200);
  return rows.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null;
}
async function sync(days) {
  const connection = await store(CONNECTION_STORE).get(CONNECTION_KEY, { type: 'json' });
  if (!connection?.token || !connection?.profile?.userId) return json(409, { error: 'لا يوجد حساب Instagram مربوط. اربطي الحساب أولاً.' });
  const token = decrypt(connection.token);
  const since = dayOffset(days - 1), until = new Date().toISOString().slice(0, 10);
  const profilePromise = graph('me', token, { fields: 'user_id,username,account_type,followers_count,media_count' })
    .catch(async () => graph('me', token, { fields: 'user_id,username,account_type' }));
  const mediaPromise = graph('me/media', token, {
    fields: 'id,caption,media_type,media_product_type,timestamp,permalink,like_count,comments_count',
    limit: 12
  }).catch(error => ({ error: error.message, data: [] }));
  const metricResults = await Promise.all(METRICS.map(async name => {
    try {
      const data = await graph('me/insights', token, {
        metric: name, period: 'day', metric_type: 'total_value', since, until
      });
      const entry = (data.data || []).find(x => x.name === name) || (data.data || [])[0] || null;
      if (!entry) return { name, value: null, available: false, note: 'لم تُرجع Meta بيانات لهذا المؤشر.' };
      return normalizeMetric(entry, name);
    } catch (error) {
      return { name, value: null, available: false, error: clean(error.message, 300) };
    }
  }));
  const [profileResult, mediaResult] = await Promise.all([profilePromise, mediaPromise]);
  const profile = {
    userId: String(profileResult.user_id || profileResult.id || connection.profile.userId),
    username: clean(profileResult.username || connection.profile.username, 100),
    accountType: clean(profileResult.account_type || connection.profile.accountType, 50),
    followersCount: numericValue(profileResult.followers_count),
    mediaCount: numericValue(profileResult.media_count)
  };
  const media = (mediaResult.data || []).map(x => ({
    id: String(x.id || ''), caption: clean(x.caption, 350),
    mediaType: clean(x.media_type, 30), productType: clean(x.media_product_type, 30),
    timestamp: x.timestamp || null,
    permalink: /^https:\/\/(www\.)?instagram\.com\//i.test(String(x.permalink || '')) ? x.permalink : null,
    likes: numericValue(x.like_count), comments: numericValue(x.comments_count)
  }));
  const permissionRequired = metricResults.every(x => !x.available);
  const stamp = new Date().toISOString();
  const snapshot = {
    id: 'snapshot-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex'),
    createdAt: stamp, range: { since, until, days }, profile,
    metrics: metricResults, media, mediaError: mediaResult.error || null,
    verified: true, source: 'instagram-login', permissionRequired,
    note: 'بيانات مباشرة من Instagram API. المؤشرات غير المتاحة تُعرض كغير متاحة ولا تُعامل كصفر.'
  };
  await store(SNAPSHOT_STORE).setJSON(snapshot.id, snapshot);
  return json(200, { snapshot });
}

exports.handler = async event => {
  connectLambda(event);
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  const denied = requireAdmin(event);
  if (denied) return denied;
  try {
    if (event.httpMethod === 'GET') return json(200, { latest: await loadLatest(), apiVersion: API_VERSION, metrics: METRICS });
    if (event.httpMethod === 'POST') {
      let body = {};
      try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'بيانات غير صالحة.' }); }
      if (body.action !== 'sync') return json(400, { error: 'الإجراء غير معروف.' });
      const days = [7, 14, 30, 90].includes(Number(body.days)) ? Number(body.days) : 30;
      return await sync(days);
    }
    return json(405, { error: 'Method not allowed' });
  } catch (error) {
    return json(502, { error: 'تعذر قراءة تحليلات Instagram: ' + clean(error.message, 400) });
  }
};
