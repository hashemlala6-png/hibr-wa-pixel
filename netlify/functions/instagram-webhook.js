'use strict';

const crypto = require('crypto');
const { getStore, connectLambda } = require('@netlify/blobs');
const { blobOptions } = require('./blob-config');
const { env } = require('./env');
const { json } = require('./auth-utils');

const STORE = 'hbpx-instagram-events';
const STATUS_STORE = 'hbpx-instagram-webhook-status';
const PREFIX = 'event-';
const MAX_BODY_BYTES = 1024 * 1024;
const clean = (value, max = 4000) => String(value == null ? '' : value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);

function eventStore() {
  return getStore(blobOptions(STORE, 'strong'));
}
function webhookStatusStore() {
  return getStore(blobOptions(STATUS_STORE, 'strong'));
}
function configFingerprint(value) {
  return value ? crypto.createHash('sha256').update(String(value)).digest('hex') : '';
}
async function updateWebhookStatus(patch) {
  const s = webhookStatusStore();
  const current = await s.get('status', { type: 'json' }).catch(() => null);
  await s.setJSON('status', {
    ...(current || {}),
    ...patch,
    updatedAt: new Date().toISOString()
  });
}
function response(statusCode, body, contentType = 'application/json; charset=utf-8') {
  return {
    statusCode,
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    },
    body
  };
}
function safeEqualText(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function rawBody(event) {
  const value = String(event.body || '');
  return event.isBase64Encoded ? Buffer.from(value, 'base64') : Buffer.from(value, 'utf8');
}
function verifySignature(raw, supplied, secret) {
  const value = String(supplied || '');
  if (!/^sha256=[a-f0-9]{64}$/i.test(value)) return false;
  const expected = crypto.createHmac('sha256', secret).update(raw).digest();
  const actual = Buffer.from(value.slice(7), 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
function eventRecord(entry, payload, receivedAt) {
  const messaging = payload.messaging || null;
  const change = payload.change || null;
  const message = messaging?.message || null;
  const value = change?.value && typeof change.value === 'object' ? change.value : {};
  const eventType = messaging
    ? (message ? 'message' : messaging.postback ? 'postback' : messaging.read ? 'read' : messaging.delivery ? 'delivery' : 'messaging_event')
    : (String(change?.field || '').includes('comments') ? 'comment' : 'change');
  const accountId = clean(entry.id, 120);
  const messageId = clean(message?.mid || message?.id, 180);
  const commentId = clean(value.comment_id || (eventType === 'comment' ? value.id : ''), 180);
  const senderId = clean(messaging?.sender?.id || value.from?.id || value.from_id || value.sender_id, 180);
  const recipientId = clean(messaging?.recipient?.id || value.to?.id || value.recipient_id, 180);
  const timestamp = Number(messaging?.timestamp || value.timestamp || entry.time || Date.now());
  const text = clean(message?.text || value.text || value.message, 4000);
  const field = clean(change?.field || (messaging ? 'messages' : 'unknown'), 60);
  const mediaId = clean(value.media?.id || value.media_id, 180);
  const attachments = Array.isArray(message?.attachments)
    ? message.attachments.slice(0, 5).map(attachment => ({
        type: clean(attachment.type, 40),
        url: /^https:\/\//i.test(String(attachment.payload?.url || '')) ? clean(attachment.payload.url, 1800) : null
      }))
    : [];
  const eventKey = messageId || commentId || crypto.createHash('sha256')
    .update(JSON.stringify({ accountId, eventType, senderId, recipientId, timestamp, field, text, value }))
    .digest('hex');
  const fingerprint = crypto.createHash('sha256')
    .update([accountId, eventType, field, eventKey].join('|'))
    .digest('hex');

  return {
    id: PREFIX + fingerprint,
    accountId,
    eventType,
    field,
    senderId,
    recipientId,
    senderUsername: clean(value.from?.username || value.username, 100),
    messageId: messageId || null,
    commentId: commentId || null,
    mediaId: mediaId || null,
    attachments,
    text,
    timestamp,
    receivedAt,
    replyDraft: null,
    status: 'received',
    externalAction: false
  };
}
function normalizeEvents(body, receivedAt) {
  if (!body || body.object !== 'instagram' || !Array.isArray(body.entry)) {
    throw new Error('هيكل إشعار Instagram غير متوقع.');
  }
  const rows = [];
  for (const entry of body.entry) {
    if (!entry || typeof entry !== 'object' || !entry.id) continue;
    for (const message of Array.isArray(entry.messaging) ? entry.messaging : []) {
      rows.push(eventRecord(entry, { messaging: message }, receivedAt));
    }
    for (const change of Array.isArray(entry.changes) ? entry.changes : []) {
      rows.push(eventRecord(entry, { change }, receivedAt));
    }
  }
  return rows;
}

async function verifyHandshake(event) {
  const verifyToken = env('INSTAGRAM_WEBHOOK_VERIFY_TOKEN');
  if (!verifyToken) return response(503, JSON.stringify({ error: 'INSTAGRAM_WEBHOOK_VERIFY_TOKEN غير مضبوط في Netlify.' }));
  const query = event.queryStringParameters || {};
  if (query['hub.mode'] !== 'subscribe' || !query['hub.challenge'] || !safeEqualText(query['hub.verify_token'], verifyToken)) {
    return response(403, JSON.stringify({ error: 'رفض التحقق من Webhook.' }));
  }
  await updateWebhookStatus({
    verifiedAt: new Date().toISOString(),
    verifyTokenFingerprint: configFingerprint(verifyToken),
    appSecretFingerprint: configFingerprint(env('INSTAGRAM_APP_SECRET')),
    verificationMethod: 'meta-hub-challenge'
  });
  return response(200, String(query['hub.challenge']), 'text/plain; charset=utf-8');
}

async function receive(event) {
  const secret = env('INSTAGRAM_APP_SECRET');
  if (!secret) return json(503, { error: 'INSTAGRAM_APP_SECRET غير مضبوط في Netlify.' });
  const raw = rawBody(event);
  if (!raw.length || raw.length > MAX_BODY_BYTES) return json(raw.length ? 413 : 400, { error: 'حجم إشعار Webhook غير صالح.' });
  const headers = event.headers || {};
  const signature = headers['x-hub-signature-256'] || headers['X-Hub-Signature-256'];
  if (!verifySignature(raw, signature, secret)) return json(401, { error: 'توقيع Meta غير صالح؛ لم نحفظ الإشعار.' });

  let body;
  try { body = JSON.parse(raw.toString('utf8')); }
  catch { return json(400, { error: 'جسم Webhook ليس JSON صالحاً.' }); }
  let events;
  try { events = normalizeEvents(body, new Date().toISOString()); }
  catch (error) { return json(400, { error: clean(error.message, 240) }); }

  const store = eventStore();
  let saved = 0, duplicates = 0;
  for (const item of events) {
    const existing = await store.get(item.id, { type: 'json' }).catch(() => null);
    if (existing) { duplicates++; continue; }
    await store.setJSON(item.id, item);
    saved++;
  }
  const receivedAt = new Date().toISOString();
  await updateWebhookStatus({
    lastReceivedAt: receivedAt,
    lastSignatureVerifiedAt: receivedAt,
    lastEventCount: events.length,
    lastEventTypes: [...new Set(events.map(item => item.eventType))].slice(0, 10)
  });
  return json(200, {
    ok: true,
    received: events.length,
    saved,
    duplicates,
    externalAction: false,
    message: 'تم استلام إشعار Instagram والتحقق من توقيعه وحفظه للمراجعة فقط. لم يُرسل أي رد.'
  });
}

exports.handler = async event => {
  connectLambda(event);
  if (event.httpMethod === 'GET') return verifyHandshake(event);
  if (event.httpMethod === 'POST') return receive(event);
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  return json(405, { error: 'Method not allowed' });
};
