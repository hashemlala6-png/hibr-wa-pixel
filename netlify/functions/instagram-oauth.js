const crypto = require('crypto');
const { getStore, connectLambda } = require('@netlify/blobs');
const { env } = require('./env');
const { requireAdmin, json, COOKIE_NAME } = require('./auth-utils');
const { logActivity } = require('./client-activity');
const { blobOptions } = require('./blob-config');

const STORE_NAME = 'hbpx-instagram-login';
const CONNECTION_KEY = 'agency-instagram';
const AGENCY_ACTIVITY_ID = 'hibr-wa-pixel';
const API_VERSION = env('INSTAGRAM_API_VERSION') || 'v26.0';
const SCOPES = [
  'instagram_business_basic',
  'instagram_business_content_publish',
  'instagram_business_manage_comments',
  'instagram_business_manage_insights',
  'instagram_business_manage_messages'
];

function store() {
  return getStore(blobOptions(STORE_NAME, 'eventual'));
}
function secretKey() {
  const secret = env('ADMIN_SESSION_SECRET');
  if (!secret) throw new Error('ADMIN_SESSION_SECRET غير مضبوط في Netlify.');
  return crypto.createHash('sha256').update(secret).digest();
}
function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', secretKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64url'), data: encrypted.toString('base64url'), tag: cipher.getAuthTag().toString('base64url') };
}
function decrypt(box) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', secretKey(), Buffer.from(box.iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(box.tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(box.data, 'base64url')), decipher.final()]).toString('utf8');
}
function cookieValue(event) {
  const headers = event.headers || {};
  const raw = headers.cookie || headers.Cookie || '';
  const name = COOKIE_NAME + '=';
  const part = raw.split(';').map(x => x.trim()).find(x => x.startsWith(name));
  return part ? decodeURIComponent(part.slice(name.length)) : '';
}
function signState(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', secretKey()).update(body).digest('base64url');
  return body + '.' + signature;
}
function verifyState(value, event) {
  const parts = String(value || '').split('.');
  if (parts.length !== 2) return false;
  const expected = crypto.createHmac('sha256', secretKey()).update(parts[0]).digest();
  let actual;
  try { actual = Buffer.from(parts[1], 'base64url'); } catch { return false; }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return false;
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch { return false; }
  const now = Date.now(), session = cookieValue(event);
  const fingerprint = crypto.createHash('sha256').update(session).digest('base64url');
  return Boolean(session && payload && Number(payload.expiresAt) > now &&
    Number(payload.issuedAt) <= now + 60000 &&
    Number(payload.expiresAt) - Number(payload.issuedAt) <= 10 * 60 * 1000 &&
    payload.sessionFingerprint === fingerprint);
}
function callbackUri() {
  const configured = clean(env('INSTAGRAM_REDIRECT_URI'), 1000);
  if (!configured) return '';
  try {
    const url = new URL(configured);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password ||
      url.search || url.hash || url.pathname !== '/.netlify/functions/instagram-oauth') return '';
    return url.toString();
  } catch {
    return '';
  }
}
function redirect(location) {
  return { statusCode: 302, headers: { Location: location, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }, body: '' };
}
function pageRedirect(query) { return redirect('/instagram.html' + (query ? '?' + query : '')); }
function clean(value, max = 500) { return String(value == null ? '' : value).trim().slice(0, max); }
async function responseJson(response) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) {
    const message = data.error?.message || data.error_description || data.message || ('Meta API HTTP ' + response.status);
    throw new Error(clean(message, 500));
  }
  return data;
}
async function readConnection() { return await store().get(CONNECTION_KEY, { type: 'json' }); }
async function writeConnection(value) { await store().setJSON(CONNECTION_KEY, value); }
async function profileFor(token) {
  const url = new URL('https://graph.instagram.com/' + API_VERSION + '/me');
  url.searchParams.set('fields', 'user_id,username,account_type');
  const data = await responseJson(await fetch(url, {
    headers: { Authorization: 'Bearer ' + token }
  }));
  return { userId: String(data.user_id || data.id || ''), username: clean(data.username, 100), accountType: clean(data.account_type, 50) };
}
async function exchangeCode(code, redirectUri) {
  const body = new URLSearchParams({
    client_id: env('INSTAGRAM_APP_ID'),
    client_secret: env('INSTAGRAM_APP_SECRET'),
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
    code
  });
  const short = await responseJson(await fetch('https://api.instagram.com/oauth/access_token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body
  }));
  const shortToken = clean(short.access_token, 12000);
  if (!shortToken) throw new Error('لم يُرجع Instagram رمز وصول قصير الأجل.');
  const longUrl = new URL('https://graph.instagram.com/access_token');
  longUrl.searchParams.set('grant_type', 'ig_exchange_token');
  longUrl.searchParams.set('client_secret', env('INSTAGRAM_APP_SECRET'));
  longUrl.searchParams.set('access_token', shortToken);
  const long = await responseJson(await fetch(longUrl));
  const accessToken = clean(long.access_token, 12000);
  if (!accessToken) throw new Error('لم يُرجع Instagram رمز الوصول طويل الأجل.');
  const profile = await profileFor(accessToken);
  if (!profile.userId || !profile.username) throw new Error('تم استلام الرمز لكن تعذر قراءة هوية حساب Instagram.');
  const seconds = Number(long.expires_in) || 5184000, now = new Date();
  return {
    provider: 'instagram-login', profile, token: encrypt(accessToken),
    connectedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + seconds * 1000).toISOString(),
    expiresIn: seconds, lastVerifiedAt: now.toISOString(),
    lastRefreshedAt: null, requestedScopes: SCOPES, permissionsVerified: false
  };
}
async function startConnect(event) {
  const appId = env('INSTAGRAM_APP_ID'), appSecret = env('INSTAGRAM_APP_SECRET');
  const redirectUri = callbackUri();
  if (!appId || !appSecret || !redirectUri || !env('ADMIN_SESSION_SECRET')) {
    return json(503, {
      error: 'إعداد ربط Instagram غير مكتمل.',
      missing: [
        ...(!appId ? ['INSTAGRAM_APP_ID'] : []),
        ...(!appSecret ? ['INSTAGRAM_APP_SECRET'] : []),
        ...(!redirectUri ? ['INSTAGRAM_REDIRECT_URI (عنوان HTTPS ثابت ومسجل في Meta)'] : []),
        ...(!env('ADMIN_SESSION_SECRET') ? ['ADMIN_SESSION_SECRET'] : [])
      ],
      redirectUri: redirectUri || null
    });
  }
  const session = cookieValue(event);
  if (!session) return json(401, { error: 'انتهت جلسة المالك. سجّلي الدخول من جديد.' });
  const issuedAt = Date.now();
  const state = signState({
    nonce: crypto.randomBytes(24).toString('base64url'),
    issuedAt, expiresAt: issuedAt + 10 * 60 * 1000,
    sessionFingerprint: crypto.createHash('sha256').update(session).digest('base64url')
  });
  const url = new URL('https://www.instagram.com/oauth/authorize');
  url.searchParams.set('client_id', appId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  // Keep the flow on Instagram Login; do not offer or fall back to Facebook Login.
  url.searchParams.set('enable_fb_login', '0');
  url.searchParams.set('scope', SCOPES.join(','));
  url.searchParams.set('state', state);
  return json(200, { authorizationUrl: url.toString(), redirectUri, requestedPermissions: SCOPES });
}
async function callback(event) {
  const q = event.queryStringParameters || {};
  const error = clean(q.error_description || q.error, 400);
  if (error) return pageRedirect('instagram_error=' + encodeURIComponent(error));
  const code = clean(q.code, 3000);
  if (!code || !verifyState(q.state, event)) {
    return pageRedirect('instagram_error=' + encodeURIComponent('تعذر التحقق من جلسة الربط أو انتهت صلاحية رابط التفويض. أعيدي المحاولة من لوحة المالك.'));
  }
  try {
    const redirectUri = callbackUri();
    if (!redirectUri) throw new Error('لم يتم ضبط عنوان العودة HTTPS الثابت INSTAGRAM_REDIRECT_URI.');
    const connection = await exchangeCode(code, redirectUri);
    await writeConnection(connection);
    await logActivity(AGENCY_ACTIVITY_ID, 'integration', 'تم ربط حساب Instagram الرسمي عبر Instagram Login', {
      provider: 'instagram-login', username: connection.profile.username, accountType: connection.profile.accountType
    });
    return pageRedirect('connected=1');
  } catch (error) {
    return pageRedirect('instagram_error=' + encodeURIComponent(clean(error.message || 'فشل ربط Instagram.', 300)));
  }
}
async function status() {
  const connection = await readConnection();
  const redirectUri = callbackUri() || null;
  const configured = Boolean(env('INSTAGRAM_APP_ID') && env('INSTAGRAM_APP_SECRET') && env('ADMIN_SESSION_SECRET') && redirectUri);
  return json(200, {
    connected: Boolean(connection && connection.token && connection.profile),
    configured, redirectUri, apiVersion: API_VERSION, requestedPermissions: connection?.requestedScopes || SCOPES,
    grantedPermissions: null,
    permissionsVerified: false,
    permissionNote: 'هذه الصلاحيات التي طلبها التطبيق؛ لا يتوفر تأكيد موثوق بمنحها جميعاً من رد التفويض وحده. يجب اختبار كل وظيفة بعد الربط.',
    account: connection ? connection.profile : null,
    connectedAt: connection ? connection.connectedAt : null,
    expiresAt: connection ? connection.expiresAt : null,
    lastVerifiedAt: connection ? connection.lastVerifiedAt : null,
    lastRefreshedAt: connection ? connection.lastRefreshedAt : null
  });
}
async function verifyConnection() {
  const connection = await readConnection();
  if (!connection || !connection.token) return json(404, { error: 'لا يوجد حساب Instagram مربوط.' });
  try {
    const profile = await profileFor(decrypt(connection.token));
    connection.profile = profile; connection.lastVerifiedAt = new Date().toISOString();
    await writeConnection(connection);
    return json(200, { ok: true, account: profile, checkedAt: connection.lastVerifiedAt });
  } catch (error) {
    return json(502, { error: 'تعذر التحقق من الحساب: ' + clean(error.message, 300) });
  }
}
async function refreshToken() {
  const connection = await readConnection();
  if (!connection || !connection.token) return json(404, { error: 'لا يوجد حساب Instagram مربوط.' });
  const lastAction = new Date(connection.lastRefreshedAt || connection.connectedAt || 0).getTime();
  if (Date.now() - lastAction < 24 * 60 * 60 * 1000) {
    return json(409, { error: 'لا يحتاج الرمز إلى تحديث الآن. يمكن تحديث رمز Instagram طويل الأجل بعد مرور 24 ساعة على الأقل.' });
  }
  try {
    const url = new URL('https://graph.instagram.com/refresh_access_token');
    url.searchParams.set('grant_type', 'ig_refresh_token');
    url.searchParams.set('access_token', decrypt(connection.token));
    const data = await responseJson(await fetch(url));
    const newToken = clean(data.access_token, 12000);
    if (!newToken) throw new Error('لم يُرجع Instagram رمزاً جديداً.');
    const seconds = Number(data.expires_in) || 5184000;
    connection.token = encrypt(newToken);
    connection.expiresAt = new Date(Date.now() + seconds * 1000).toISOString();
    connection.lastRefreshedAt = new Date().toISOString();
    connection.profile = await profileFor(newToken);
    connection.lastVerifiedAt = new Date().toISOString();
    await writeConnection(connection);
    return json(200, { ok: true, account: connection.profile, expiresAt: connection.expiresAt });
  } catch (error) {
    return json(502, { error: 'تعذر تحديث رمز Instagram: ' + clean(error.message, 300) });
  }
}
exports.handler = async event => {
  connectLambda(event);
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  const denied = requireAdmin(event);
  if (denied) return denied;
  const q = event.queryStringParameters || {};
  const action = clean(q.action || 'status', 40);
  try {
    if (event.httpMethod === 'GET') {
      if (action === 'connect') return await startConnect(event);
      if (action === 'callback' || q.code || q.error || q.error_description) return await callback(event);
      if (action === 'status') return await status();
      return json(400, { error: 'الإجراء غير معروف.' });
    }
    if (event.httpMethod === 'POST') {
      let body = {};
      try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'بيانات غير صالحة.' }); }
      if (body.action === 'verify') return await verifyConnection();
      if (body.action === 'refresh') return await refreshToken();
      if (body.action === 'disconnect') {
        await store().delete(CONNECTION_KEY);
        await logActivity(AGENCY_ACTIVITY_ID, 'integration', 'تم فصل حساب Instagram من نظام حبر وبكسل', { provider: 'instagram-login' });
        return json(200, { ok: true });
      }
      return json(400, { error: 'الإجراء غير معروف.' });
    }
    return json(405, { error: 'Method not allowed' });
  } catch (error) {
    return json(500, { error: clean(error.message || 'تعذر تشغيل ربط Instagram.', 500) });
  }
};
