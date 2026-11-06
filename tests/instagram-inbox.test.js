'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function loadInbox({ events = {}, connection = null, denied = false } = {}) {
  const resolved = require.resolve('../netlify/functions/instagram-inbox');
  delete require.cache[resolved];
  const originalLoad = Module._load;
  const stores = {
    'hbpx-instagram-events': events,
    'hbpx-instagram-login': { 'agency-instagram': connection }
  };
  const writes = [];
  const blobs = {
    connectLambda() {},
    getStore({ name }) {
      stores[name] ||= {};
      const data = stores[name];
      return {
        async list({ prefix = '' } = {}) { return { blobs: Object.keys(data).filter(key => key.startsWith(prefix)).map(key => ({ key })) }; },
        async get(key) { return data[key] ?? null; },
        async setJSON(key, value) { data[key] = JSON.parse(JSON.stringify(value)); writes.push({ key, value }); }
      };
    }
  };
  Module._load = function(request, parent, isMain) {
    if (request === '@netlify/blobs' && parent && parent.filename === resolved) return blobs;
    if (request === './auth-utils' && parent && parent.filename === resolved) return {
      requireAdmin() { return denied ? { statusCode: 401, body: '{}' } : null; },
      json(statusCode, body) { return { statusCode, body: JSON.stringify(body) }; }
    };
    if (request === './env' && parent && parent.filename === resolved) return {
      env(name) { return name === 'INSTAGRAM_WEBHOOK_VERIFY_TOKEN' ? 'private-verify-token' : name === 'INSTAGRAM_APP_SECRET' ? 'private-app-secret' : name === 'URL' ? 'https://fabulous-bublanina-8d5626.netlify.app' : ''; }
    };
    return originalLoad.call(this, request, parent, isMain);
  };
  try { return { handler: require(resolved).handler, stores, writes }; }
  finally { Module._load = originalLoad; delete require.cache[resolved]; }
}
function body(response) { return JSON.parse(response.body || '{}'); }

test('owner inbox filters webhook events to the currently connected Instagram account', async () => {
  const service = loadInbox({
    connection: { token: { iv: 'iv', data: 'cipher', tag: 'tag' }, profile: { userId: 'ig-123', username: 'hibr_pixels' } },
    events: {
      'event-one': { id: 'event-one', accountId: 'ig-123', eventType: 'message', text: 'مرحبا', receivedAt: '2026-11-06T10:00:00.000Z' },
      'event-two': { id: 'event-two', accountId: 'another-ig', eventType: 'message', text: 'private', receivedAt: '2026-11-06T10:01:00.000Z' }
    }
  });
  const response = await service.handler({ httpMethod: 'GET', headers: {} });
  const data = body(response);
  assert.equal(response.statusCode, 200);
  assert.equal(data.connected, true);
  assert.equal(data.items.length, 1);
  assert.equal(data.items[0].text, 'مرحبا');
  assert.equal(data.policy.automaticRepliesEnabled, false);
  assert.equal(data.webhookConfigured, true);
  assert.equal(data.callbackUrl, 'https://fabulous-bublanina-8d5626.netlify.app/.netlify/functions/instagram-webhook');
});

test('owner can save an internal reply draft without sending a message', async () => {
  const event = { id: 'event-message', accountId: 'ig-123', eventType: 'message', senderId: 'customer-1', text: 'السعر؟', status: 'received' };
  const service = loadInbox({
    connection: { token: { iv: 'iv', data: 'cipher', tag: 'tag' }, profile: { userId: 'ig-123', username: 'hibr_pixels' } },
    events: { [event.id]: event }
  });
  const response = await service.handler({
    httpMethod: 'POST', headers: {},
    body: JSON.stringify({ action: 'save_reply_draft', id: event.id, reply: 'أهلاً بك، يسعدنا معرفة تفاصيل مشروعك.' })
  });
  const result = body(response);
  assert.equal(response.statusCode, 200);
  assert.equal(result.sent, false);
  assert.equal(result.externalAction, false);
  assert.equal(result.item.status, 'reply_draft_saved');
  assert.equal(result.item.replyDraft.text, 'أهلاً بك، يسعدنا معرفة تفاصيل مشروعك.');
  assert.equal(service.stores['hbpx-instagram-events'][event.id].replyDraft.sentAt, null);
  assert.equal(service.writes.length, 1);
});

test('owner inbox refuses draft replies for another Instagram account and unauthenticated requests', async () => {
  const event = { id: 'event-message', accountId: 'other-ig', eventType: 'message', senderId: 'customer-1', text: 'السعر؟' };
  const connection = { token: { iv: 'iv', data: 'cipher', tag: 'tag' }, profile: { userId: 'ig-123', username: 'hibr_pixels' } };
  const deniedService = loadInbox({
    denied: true,
    connection,
    events: { [event.id]: event }
  });
  const denied = await deniedService.handler({ httpMethod: 'GET', headers: {} });
  assert.equal(denied.statusCode, 401);

  const service = loadInbox({ connection, events: { [event.id]: event } });
  const wrongAccount = await service.handler({
    httpMethod: 'POST', headers: {},
    body: JSON.stringify({ action: 'save_reply_draft', id: event.id, reply: 'رد مقترح' })
  });
  assert.equal(wrongAccount.statusCode, 404);
  assert.equal(service.writes.length, 0);
});
