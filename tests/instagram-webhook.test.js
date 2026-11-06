'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Module = require('node:module');

const APP_SECRET = 'instagram-webhook-app-secret';
const VERIFY_TOKEN = 'owner-generated-verify-token-with-enough-entropy';

function loadWebhook({ secret = APP_SECRET, verifyToken = VERIFY_TOKEN } = {}) {
  const resolved = require.resolve('../netlify/functions/instagram-webhook');
  delete require.cache[resolved];
  const originalLoad = Module._load;
  const records = {};
  const writes = [];
  const blobs = {
    connectLambda() {},
    getStore() {
      return {
        async get(key) { return records[key] || null; },
        async setJSON(key, value) { records[key] = value; writes.push({ key, value }); }
      };
    }
  };
  Module._load = function(request, parent, isMain) {
    if (request === '@netlify/blobs' && parent && parent.filename === resolved) return blobs;
    if (request === './env' && parent && parent.filename === resolved) return {
      env(name) {
        if (name === 'INSTAGRAM_APP_SECRET') return secret;
        if (name === 'INSTAGRAM_WEBHOOK_VERIFY_TOKEN') return verifyToken;
        return '';
      }
    };
    if (request === './auth-utils' && parent && parent.filename === resolved) {
      return { json(statusCode, body, headers = {}) { return { statusCode, body: JSON.stringify(body), headers }; } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try { return { handler: require(resolved).handler, records, writes }; }
  finally { Module._load = originalLoad; delete require.cache[resolved]; }
}
function signature(raw) {
  return 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(Buffer.from(raw, 'utf8')).digest('hex');
}
function body(response) { return JSON.parse(response.body || '{}'); }

test('Instagram webhook verification responds with challenge only for the configured token', async () => {
  const service = loadWebhook();
  const good = await service.handler({
    httpMethod: 'GET',
    queryStringParameters: { 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': 'challenge-12345' }
  });
  assert.equal(good.statusCode, 200);
  assert.equal(good.body, 'challenge-12345');
  assert.match(good.headers['Content-Type'], /text\/plain/);
  const bad = await service.handler({
    httpMethod: 'GET',
    queryStringParameters: { 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong-token', 'hub.challenge': 'challenge-12345' }
  });
  assert.equal(bad.statusCode, 403);
});

test('Instagram webhook verifies raw-body HMAC, stores message events, and deduplicates retries', async () => {
  const service = loadWebhook();
  const payload = JSON.stringify({
    object: 'instagram',
    entry: [{ id: 'instagram-account-123', time: 1793971200, messaging: [{
      sender: { id: 'customer-scoped-id' }, recipient: { id: 'instagram-account-123' },
      timestamp: 1793971200000, message: { mid: 'message-abc', text: 'أريد معرفة أسعار التصميم' }
    }] }]
  });
  const event = { httpMethod: 'POST', headers: { 'x-hub-signature-256': signature(payload) }, body: payload };
  const first = await service.handler(event);
  assert.equal(first.statusCode, 200);
  assert.equal(body(first).saved, 1);
  assert.equal(service.writes.length, 1);
  const saved = Object.values(service.records)[0];
  assert.equal(saved.eventType, 'message');
  assert.equal(saved.accountId, 'instagram-account-123');
  assert.equal(saved.senderId, 'customer-scoped-id');
  assert.equal(saved.text, 'أريد معرفة أسعار التصميم');
  assert.equal(saved.externalAction, false);
  const retry = await service.handler(event);
  assert.equal(retry.statusCode, 200);
  assert.equal(body(retry).duplicates, 1);
  assert.equal(service.writes.length, 1);
});

test('Instagram webhook rejects missing or invalid signatures before storing any event', async () => {
  const service = loadWebhook();
  const payload = JSON.stringify({ object: 'instagram', entry: [{ id: '123', messaging: [{ sender: { id: 'c' }, message: { text: 'hello' } }] }] });
  const missing = await service.handler({ httpMethod: 'POST', headers: {}, body: payload });
  const invalid = await service.handler({ httpMethod: 'POST', headers: { 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) }, body: payload });
  assert.equal(missing.statusCode, 401);
  assert.equal(invalid.statusCode, 401);
  assert.equal(service.writes.length, 0);
});

test('Instagram webhook rejects invalid JSON and oversized bodies after signature check', async () => {
  const service = loadWebhook();
  const invalidJson = '{not json';
  const badJson = await service.handler({ httpMethod: 'POST', headers: { 'x-hub-signature-256': signature(invalidJson) }, body: invalidJson });
  assert.equal(badJson.statusCode, 400);
  const huge = 'a'.repeat(1024 * 1024 + 1);
  const oversized = await service.handler({ httpMethod: 'POST', headers: { 'x-hub-signature-256': signature(huge) }, body: huge });
  assert.equal(oversized.statusCode, 413);
});
