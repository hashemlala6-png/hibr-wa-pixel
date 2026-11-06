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

const REPLY_LOCK_STORE = 'hbpx-instagram-reply-locks';
const MESSAGE_REPLY_WINDOW_MS = 24 * 60 * 60 * 1000;

function validInstagramId(value) {
  return /^[0-9]{1,40}$/.test(String(value || ''));
}

async function acquireReplyLock(eventId) {
  const locks = store(REPLY_LOCK_STORE);
  const key = 'reply-' + crypto.createHash('sha256').update(eventId).digest('hex');
  const token = crypto.randomBytes(18).toString('hex');
  const now = Date.now();
  const lease = { token, acquiredAt: now, expiresAt: now + 120000 };
  const current = await locks.getWithMetadata(key, { consistency: 'strong', type: 'json' });
  if (!current) {
    const created = await locks.setJSON(key, lease, { onlyIfNew: true });
    return created.modified && created.etag ? { acquired: true, key, token } : { acquired: false };
  }
  if (Number(current.data?.expiresAt) > now) return { acquired: false };
  const replaced = await locks.setJSON(key, lease, { onlyIfMatch: current.etag });
  return replaced.modified && replaced.etag ? { acquired: true, key, token } : { acquired: false };
}

async function releaseReplyLock(lock) {
  if (!lock?.acquired) return;
  try {
    const locks = store(REPLY_LOCK_STORE);
    const current = await locks.getWithMetadata(lock.key, { consistency: 'strong', type: 'json' });
    if (!current || current.data?.token !== lock.token) return;
    await locks.setJSON(lock.key, {
      token: '',
      acquiredAt: 0,
      expiresAt: 0,
      releasedAt: Date.now()
    }, { onlyIfMatch: current.etag });
  } catch (error) {
    console.error('Instagram reply lock release failed', error?.message || error);
  }
}

async function postInstagram(path, token, payload, contentType) {
  const url = new URL('https://graph.instagram.com/' + API_VERSION + '/' + String(path).replace(/^\/+/, ''));
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': contentType
    },
    body: payload
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) {
    const error = new Error(clean(data.error?.message || data.error_description || 'Instagram API HTTP ' + response.status, 400));
    error.status = response.status;
    throw error;
  }
  return data;
}

async function sendReplyToInstagram(item, linked, token) {
  const text = clean(item.replyDraft?.text, 2000);
  if (!text) throw new Error('مسودة الرد فارغة.');
  if (text.length > 1000) throw new Error('حد الرد للإرسال 1000 حرف. اختصري النص قبل الإرسال.');

  if (item.eventType === 'message') {
    return postInstagram(linked.profile.userId + '/messages', token, JSON.stringify({
      recipient: { id: item.senderId },
      message: { text }
    }), 'application/json');
  }

  if (item.eventType === 'comment') {
    return postInstagram(item.commentId + '/replies', token, new URLSearchParams({ message: text }), 'application/x-www-form-urlencoded');
  }

  throw new Error('نوع الإشعار لا يدعم إرسال رد من هذا المسار.');
}

async function sendOwnerApprovedReply(body) {
  if (body.confirmed !== true) return json(400, { error: 'يلزم تأكيد المالكة الصريح قبل أي إرسال خارجي.' });
  const id = clean(body.id, 180);
  if (!id || !id.startsWith(PREFIX)) return json(400, { error: 'معرّف الإشعار غير صالح.' });

  let lock = null;
  try {
    lock = await acquireReplyLock(id);
    if (!lock.acquired) return json(409, { error: 'يوجد طلب إرسال آخر لهذا الإشعار. حدّثي الوارد قبل المحاولة مجدداً.' });

    const s = store(EVENT_STORE);
    const item = await s.get(id, { type: 'json', consistency: 'strong' });
    if (!item) return json(404, { error: 'الإشعار غير موجود.' });
    const linked = await connection();
    if (!linked?.token || !linked?.profile?.userId || item.accountId !== String(linked.profile.userId)) {
      return json(404, { error: 'الإشعار لا يخص حساب Instagram المرتبط حالياً.' });
    }
    if (!item.replyDraft?.text) return json(409, { error: 'احفظي مسودة الرد أولاً ثم أرسليها بعد مراجعتها.' });
    if (item.replyDraft.sentAt || item.replyDraft.sendStatus === 'sent') {
      return json(409, { error: 'تم إرسال هذا الرد بالفعل. لا يمكن إرساله مرة ثانية.' });
    }
    if (['sending', 'uncertain'].includes(item.replyDraft.sendStatus)) {
      return json(409, { error: 'حالة الإرسال غير محسومة أو ما زالت قيد التنفيذ. تحققي من Instagram يدوياً قبل أي محاولة أخرى.' });
    }
    if (!['message', 'comment'].includes(item.eventType)) {
      return json(409, { error: 'نوع الإشعار لا يدعم إرسال رد.' });
    }

    const token = decryptToken(linked.token);
    const replyText = clean(item.replyDraft.text, 2000);
    if (!replyText) return json(400, { error: 'مسودة الرد فارغة.' });
    if (replyText.length > 1000) return json(400, { error: 'حد الرد للإرسال 1000 حرف. اختصري النص قبل الإرسال.' });
    if (item.eventType === 'message') {
      if (!validInstagramId(item.senderId) || !validInstagramId(linked.profile.userId)) {
        return json(409, { error: 'معرّف الحساب أو المرسل غير صالح؛ لم نرسل الرسالة.' });
      }
      const rawTimestamp = Number(item.timestamp || Date.parse(item.receivedAt || ''));
      const occurredAt = rawTimestamp > 0 && rawTimestamp < 1000000000000 ? rawTimestamp * 1000 : rawTimestamp;
      const nowMs = Date.now();
      if (!Number.isFinite(occurredAt) || occurredAt <= 0 || occurredAt > nowMs + 5 * 60 * 1000 ||
          nowMs - occurredAt > MESSAGE_REPLY_WINDOW_MS) {
        return json(409, { error: 'انتهت نافذة الرد القياسية البالغة 24 ساعة أو تعذر التحقق من وقت الرسالة الواردة. لم نرسل شيئاً.' });
      }
    } else if (!validInstagramId(item.commentId)) {
      return json(409, { error: 'معرّف التعليق غير متاح أو غير صالح؛ لم ننشر رداً.' });
    }

    const now = new Date().toISOString();
    item.replyDraft.approvedAt = now;
    item.replyDraft.approvedBy = 'owner';
    item.replyDraft.sendStatus = 'sending';
    item.replyDraft.sendStartedAt = now;
    item.replyDraft.sendError = null;
    item.status = 'reply_sending';
    item.updatedAt = now;
    await s.setJSON(id, item);

    let result;
    try {
      result = await sendReplyToInstagram(item, linked, token);
    } catch (error) {
      const uncertain = !Number.isInteger(error.status) || error.status >= 500;
      item.replyDraft.sendStatus = uncertain ? 'uncertain' : 'failed';
      item.replyDraft.sendError = clean(error.message || 'تعذر إرسال الرد.', 500);
      item.status = uncertain ? 'reply_send_uncertain' : 'reply_send_failed';
      item.updatedAt = new Date().toISOString();
      await s.setJSON(id, item);
      return json(uncertain ? 502 : 409, {
        item,
        sent: false,
        externalAction: true,
        uncertain,
        error: item.replyDraft.sendError,
        message: uncertain
          ? 'لم نتمكن من تأكيد نتيجة Instagram. تحققي من الحساب يدوياً ولا تعيدي الإرسال قبل التأكد.'
          : 'رفض Instagram الرد ولم يؤكد إرساله. راجعي السبب ثم احفظي مسودة جديدة.'
      });
    }

    const providerId = clean(result.message_id || result.id || result.recipient_id, 180);
    if (!providerId) {
      item.replyDraft.sendStatus = 'uncertain';
      item.replyDraft.sendError = 'استجاب Instagram دون معرّف تأكيد للرد.';
      item.status = 'reply_send_uncertain';
      item.updatedAt = new Date().toISOString();
      await s.setJSON(id, item);
      return json(502, {
        item, sent: false, uncertain: true, externalAction: true,
        error: item.replyDraft.sendError,
        message: 'استجاب Instagram دون معرّف تأكيد. تحققي من الحساب يدوياً ولا تعيدي الإرسال.'
      });
    }

    const sentAt = new Date().toISOString();
    item.replyDraft.sendStatus = 'sent';
    item.replyDraft.sentAt = sentAt;
    item.replyDraft.providerId = providerId;
    item.replyDraft.sendError = null;
    item.status = 'reply_sent';
    item.updatedAt = sentAt;
    await s.setJSON(id, item);
    return json(200, {
      ok: true, sent: true, externalAction: true, item,
      message: item.eventType === 'message' ? 'أكد Instagram إرسال الرسالة الخاصة.' : 'أكد Instagram نشر الرد على التعليق.'
    });
  } finally {
    await releaseReplyLock(lock);
  }
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
          replyDraftsRequireOwnerReview: true,
          manualReplySendEnabled: true,
          manualReplyRequiresExplicitOwnerConfirmation: true,
          automaticRepliesEnabled: false,
          externalActionRequiresFreshOwnerConfirmation: true
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
    if (action === 'send_reply') return await sendOwnerApprovedReply(body);
    if (action !== 'save_reply_draft') return json(400, { error: 'الإجراء غير معروف.' });
    const id = clean(body.id, 180), reply = clean(body.reply, 2000);
    if (!id || !id.startsWith(PREFIX)) return json(400, { error: 'معرّف الإشعار غير صالح.' });
    if (!reply) return json(400, { error: 'اكتبي مسودة رد أولاً.' });

    const s = store(EVENT_STORE);
    const item = await s.get(id, { type: 'json' });
    if (!item) return json(404, { error: 'الإشعار غير موجود.' });
    if (!['message', 'comment'].includes(item.eventType) ||
        (item.eventType === 'message' && !item.senderId) ||
        (item.eventType === 'comment' && !item.commentId)) {
      return json(409, { error: 'هذا الإشعار لا يحتوي معرّفاً صالحاً لرد مناسب.' });
    }
    if (item.replyDraft?.sentAt || ['sending', 'sent', 'uncertain'].includes(item.replyDraft?.sendStatus)) {
      return json(409, { error: 'لا يمكن استبدال مسودة رد أُرسلت أو ما زالت نتيجة إرسالها غير محسومة.' });
    }
    const linked = await connection();
    if (!linked?.profile?.userId || item.accountId !== String(linked.profile.userId)) {
      return json(404, { error: 'الإشعار لا يخص حساب Instagram المرتبط حالياً.' });
    }

    const now = new Date().toISOString();
    item.replyDraft = { text: reply, savedAt: now, savedBy: 'owner', approvedAt: null, approvedBy: null, sentAt: null, sendStatus: 'draft', sendError: null };
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
