'use strict';

const { getStore, connectLambda } = require('@netlify/blobs');
const { requireAdmin, json } = require('./auth-utils');
const { env } = require('./env');
const { blobOptions } = require('./blob-config');
const crypto = require('crypto');

const EVENT_STORE = 'hbpx-instagram-events';
const STATUS_STORE = 'hbpx-instagram-webhook-status';
const CONNECTION_STORE = 'hbpx-instagram-login';
const CONNECTION_KEY = 'agency-instagram';
const API_VERSION = env('INSTAGRAM_API_VERSION') || 'v26.0';
const REQUIRED_WEBHOOK_FIELDS = ['comments', 'messages'];
const PREFIX = 'event-';
const clean = (value, max = 4000) => String(value == null ? '' : value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);

function store(name) {
  return getStore(blobOptions(name, 'strong'));
}
async function readEvents() {
  const s = store(EVENT_STORE), rows = [];
  let cursor;
  do {
    const page = await s.list({ prefix: PREFIX, limit: 100, cursor });
    for (const blob of page.blobs || []) {
      const item = await s.get(blob.key, { type: 'json' }).catch(() => null);
      if (item) rows.push(item);
    }
    cursor = page.cursor;
  } while (cursor && rows.length < 500);
  return rows.sort((a, b) => Number(b.timestamp || 0) - Number(a.timestamp || 0)).slice(0, 200);
}
async function connection() {
  return store(CONNECTION_STORE).get(CONNECTION_KEY, { type: 'json' });
}
function decryptToken(box) {
  const secret = env('ADMIN_SESSION_SECRET');
  if (!secret) throw new Error('ADMIN_SESSION_SECRET غير مضبوط في Netlify.');
  if (!box?.iv || !box?.data || !box?.tag) throw new Error('رمز Instagram المخزن غير صالح.');
  const key = crypto.createHash('sha256').update(secret).digest();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(box.tag, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(box.data, 'base64url')),
    decipher.final()
  ]).toString('utf8');
}
async function instagramGraph(path, token, method = 'GET', params = {}) {
  const url = new URL('https://graph.instagram.com/' + API_VERSION + '/' + String(path).replace(/^\/+/, ''));
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, {
    method,
    headers: { Authorization: 'Bearer ' + token }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) {
    const message = data.error?.message || data.error_description || 'Instagram API HTTP ' + response.status;
    throw new Error(clean(message, 500));
  }
  return data;
}
function normalizeSubscribedFields(data) {
  const rows = Array.isArray(data?.data) ? data.data : [];
  return [...new Set(rows.flatMap(row => Array.isArray(row?.subscribed_fields) ? row.subscribed_fields : []))]
    .map(value => clean(value, 80))
    .filter(Boolean)
    .sort();
}
async function readAccountWebhookSubscription(linked) {
  if (!linked?.token || !linked?.profile?.userId) {
    return json(409, { error: 'لا يوجد حساب Instagram مربوط. اربطي الحساب أولاً.' });
  }
  const token = decryptToken(linked.token);
  const data = await instagramGraph('me/subscribed_apps', token);
  const subscribedFields = normalizeSubscribedFields(data);
  const missingFields = REQUIRED_WEBHOOK_FIELDS.filter(field => !subscribedFields.includes(field));
  return {
    connected: true,
    username: clean(linked.profile.username, 100),
    subscribedFields,
    requiredFields: REQUIRED_WEBHOOK_FIELDS,
    missingFields,
    subscribed: missingFields.length === 0
  };
}
function configFingerprint(value) {
  return value ? crypto.createHash('sha256').update(String(value)).digest('hex') : '';
}
async function webhookStatus() {
  const [record, verifyToken, appSecret] = await Promise.all([
    store(STATUS_STORE).get('status', { type: 'json' }).catch(() => null),
    Promise.resolve(env('INSTAGRAM_WEBHOOK_VERIFY_TOKEN')),
    Promise.resolve(env('INSTAGRAM_APP_SECRET'))
  ]);
  const configured = Boolean(verifyToken && appSecret);
  const verifiedForCurrentConfig = Boolean(configured && record?.verifiedAt
    && record.verifyTokenFingerprint === configFingerprint(verifyToken)
    && record.appSecretFingerprint === configFingerprint(appSecret));
  return {
    configured,
    verifiedForCurrentConfig,
    verifiedAt: verifiedForCurrentConfig ? record.verifiedAt : null,
    lastReceivedAt: verifiedForCurrentConfig ? record.lastReceivedAt || null : null,
    lastSignatureVerifiedAt: verifiedForCurrentConfig ? record.lastSignatureVerifiedAt || null : null,
    lastEventCount: verifiedForCurrentConfig && Number.isFinite(Number(record?.lastEventCount)) ? Number(record.lastEventCount) : null,
    lastEventTypes: verifiedForCurrentConfig && Array.isArray(record?.lastEventTypes) ? record.lastEventTypes.slice(0, 10) : []
  };
}

exports.handler = async event => {
  connectLambda(event);
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  const denied = requireAdmin(event);
  if (denied) return denied;

  try {
    if (event.httpMethod === 'GET') {
      const query = event.queryStringParameters || {};
      if (clean(query.action, 50) === 'webhook_subscription') {
        const linked = await connection();
        const result = await readAccountWebhookSubscription(linked);
        if (result?.statusCode) return result;
        const verification = await webhookStatus();
        return json(200, {
          ...result,
          callbackVerified: verification.verifiedForCurrentConfig,
          note: result.subscribed
            ? 'حساب Instagram مشترك في حقول الرسائل والتعليقات.'
            : 'الحساب غير مشترك في كل الحقول المطلوبة؛ يلزم إكمال التفعيل من حساب المالكة.'
        });
      }
      const [linked, verification] = await Promise.all([connection(), webhookStatus()]);
      const accountId = String(linked?.profile?.userId || '');
      const items = accountId ? (await readEvents()).filter(item => item.accountId === accountId) : [];
      let callbackUrl = '';
      const siteUrl = env('URL') || env('DEPLOY_PRIME_URL');
      if (siteUrl) {
        try { callbackUrl = new URL('/.netlify/functions/instagram-webhook', siteUrl).toString(); } catch {}
      }
      return json(200, {
        connected: Boolean(accountId && linked?.token),
        account: linked?.profile ? { userId: accountId, username: clean(linked.profile.username, 100) } : null,
        webhookConfigured: verification.configured,
        verification,
        callbackUrl,
        items,
        policy: {
          approvalRequired: true,
          receivedEventsArePrivate: true,
          draftsOnly: true,
          automaticRepliesEnabled: false,
          externalAction: false
        }
      });
    }

    if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });
    let body = {};
    try { body = JSON.parse(event.body || '{}'); }
    catch { return json(400, { error: 'بيانات الطلب غير صالحة.' }); }
    const action = clean(body.action, 40);
    if (action === 'subscribe_webhooks') {
      const linked = await connection();
      if (!linked?.token || !linked?.profile?.userId) {
        return json(409, { error: 'لا يوجد حساب Instagram مربوط. اربطي الحساب أولاً.' });
      }
      const verification = await webhookStatus();
      if (!verification.verifiedForCurrentConfig) {
        return json(409, {
          error: 'يجب أولاً توثيق Callback URL في لوحة Meta باستخدام Verify Token الحالي. لم نغيّر اشتراك الحساب.'
        });
      }
      const token = decryptToken(linked.token);
      await instagramGraph('me/subscribed_apps', token, 'POST', {
        subscribed_fields: REQUIRED_WEBHOOK_FIELDS.join(',')
      });
      const checked = await readAccountWebhookSubscription(linked);
      if (checked?.statusCode) return checked;
      if (!checked.subscribed) {
        return json(409, {
          ok: false,
          subscribed: false,
          subscribedFields: checked.subscribedFields,
          missingFields: checked.missingFields,
          error: 'استجاب Instagram لطلب التفعيل، لكن فحص الاشتراك لم يؤكد كل الحقول المطلوبة. راجعي إعدادات Webhooks وصلاحيات Meta.'
        });
      }
      return json(200, {
        ok: true,
        subscribed: true,
        subscribedFields: checked.subscribedFields,
        externalMessageSent: false,
        message: 'تم تفعيل اشتراك حساب Instagram في استقبال الرسائل والتعليقات والتحقق منه. لم نرسل أي رسالة أو تعليق.'
      });
    }
    if (action !== 'save_reply_draft') return json(400, { error: 'الإجراء غير معروف.' });
    const id = clean(body.id, 180), reply = clean(body.reply, 2000);
    if (!id || !id.startsWith(PREFIX)) return json(400, { error: 'معرّف الإشعار غير صالح.' });
    if (!reply) return json(400, { error: 'اكتبي مسودة رد أولاً.' });

    const s = store(EVENT_STORE);
    const item = await s.get(id, { type: 'json' });
    if (!item) return json(404, { error: 'الإشعار غير موجود.' });
    if (!['message', 'comment'].includes(item.eventType) || !item.senderId) {
      return json(409, { error: 'هذا الإشعار لا يحتوي رسالة أو تعليقاً قابلاً لإعداد رد.' });
    }
    const linked = await connection();
    if (!linked?.profile?.userId || item.accountId !== String(linked.profile.userId)) {
      return json(404, { error: 'الإشعار لا يخص حساب Instagram المرتبط حالياً.' });
    }

    const now = new Date().toISOString();
    item.replyDraft = { text: reply, savedAt: now, savedBy: 'owner', approvedAt: null, sentAt: null };
    item.status = 'reply_draft_saved';
    item.updatedAt = now;
    await s.setJSON(id, item);
    return json(200, {
      ok: true, item, sent: false, externalAction: false,
      message: 'حُفظت مسودة الرد للمراجعة فقط. لم تُرسل إلى Instagram.'
    });
  } catch (error) {
    console.error('Instagram inbox error', error?.message || error);
    return json(500, { error: 'تعذر تحميل صندوق وارد Instagram أو حفظ مسودة الرد.' });
  }
};
