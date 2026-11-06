'use strict';

const { getStore, connectLambda } = require('@netlify/blobs');
const { requireAdmin, json } = require('./auth-utils');
const { env } = require('./env');
const crypto = require('crypto');

const EVENT_STORE = 'hbpx-instagram-events';
const STATUS_STORE = 'hbpx-instagram-webhook-status';
const CONNECTION_STORE = 'hbpx-instagram-login';
const CONNECTION_KEY = 'agency-instagram';
const PREFIX = 'event-';
const clean = (value, max = 4000) => String(value == null ? '' : value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);

function store(name) {
  return getStore({ name, consistency: 'strong' });
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
    if (clean(body.action, 40) !== 'save_reply_draft') return json(400, { error: 'الإجراء غير معروف.' });
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
