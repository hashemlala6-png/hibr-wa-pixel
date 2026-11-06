'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function loadInbox({ events = {}, connection = null, denied = false, status = null, envOverrides = {} } = {}) {
  const resolved = require.resolve('../netlify/functions/instagram-inbox');
  delete require.cache[resolved];
  const originalLoad = Module._load;
  const stores = {
    'hbpx-instagram-events': events,
    'hbpx-instagram-login': { 'agency-instagram': connection },
    'hbpx-instagram-webhook-status': status ? { status } : {}
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
        async getWithMetadata(key) { return data[key] ? { data: JSON.parse(JSON.stringify(data[key])), etag: key + '-etag' } : null; },
        async setJSON(key, value, options = {}) {
          if (options.onlyIfNew && data[key]) return { modified: false };
          if (options.onlyIfMatch && options.onlyIfMatch !== key + '-etag') return { modified: false };
          data[key] = JSON.parse(JSON.stringify(value)); writes.push({ key, value });
          return { modified: true, etag: key + '-etag' };
        }
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
      env(name) { if (Object.prototype.hasOwnProperty.call(envOverrides,name)) return envOverrides[name]; return name === 'INSTAGRAM_WEBHOOK_VERIFY_TOKEN' ? 'private-verify-token' : name === 'INSTAGRAM_APP_SECRET' ? 'private-app-secret' : name === 'ADMIN_SESSION_SECRET' ? 'test-admin-session-secret' : name === 'INSTAGRAM_API_VERSION' ? 'v26.0' : name === 'URL' ? 'https://fabulous-bublanina-8d5626.netlify.app' : ''; }
    };
    return originalLoad.call(this, request, parent, isMain);
  };
  try { return { handler: require(resolved).handler, stores, writes }; }
  finally { Module._load = originalLoad; delete require.cache[resolved]; }
}
function body(response) { return JSON.parse(response.body || '{}'); }
function encryptedToken(value, secret = 'test-admin-session-secret') {
  const crypto = require('node:crypto');
  const key = crypto.createHash('sha256').update(secret).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('base64url'),
    data: data.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url')
  };
}
function webhookVerification() {
  const crypto = require('node:crypto');
  const hash = value => crypto.createHash('sha256').update(value).digest('hex');
  return {
    verifiedAt: '2026-11-06T13:00:00.000Z',
    verifyTokenFingerprint: hash('private-verify-token'),
    appSecretFingerprint: hash('private-app-secret')
  };
}

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
  assert.equal(data.verification.verifiedForCurrentConfig, false);
  assert.equal(data.verification.lastReceivedAt, null);
});


test('owner inbox verifies stored Meta handshake against current secrets and shows latest signed event', async () => {
  const crypto = require('node:crypto');
  const hash = value => crypto.createHash('sha256').update(value).digest('hex');
  const service = loadInbox({
    connection: { token: { iv: 'iv', data: 'cipher', tag: 'tag' }, profile: { userId: 'ig-123', username: 'hibr_pixels' } },
    events: {},
    status: {
      verifiedAt: '2026-11-06T13:00:00.000Z',
      verifyTokenFingerprint: hash('private-verify-token'),
      appSecretFingerprint: hash('private-app-secret'),
      lastReceivedAt: '2026-11-06T13:05:00.000Z',
      lastSignatureVerifiedAt: '2026-11-06T13:05:00.000Z',
      lastEventCount: 2,
      lastEventTypes: ['message','comment']
    }
  });
  const data = body(await service.handler({ httpMethod: 'GET', headers: {} }));
  assert.equal(data.verification.verifiedForCurrentConfig, true);
  assert.equal(data.verification.verifiedAt, '2026-11-06T13:00:00.000Z');
  assert.equal(data.verification.lastReceivedAt, '2026-11-06T13:05:00.000Z');
  assert.deepEqual(data.verification.lastEventTypes, ['message','comment']);
});


test('rotating either webhook secret invalidates old verification and hides stale delivery timestamps', async t => {
  const crypto = require('node:crypto');
  const hash = value => crypto.createHash('sha256').update(value).digest('hex');
  const status = {
    verifiedAt: '2026-11-06T13:00:00.000Z',
    verifyTokenFingerprint: hash('private-verify-token'),
    appSecretFingerprint: hash('private-app-secret'),
    lastReceivedAt: '2026-11-06T13:05:00.000Z',
    lastSignatureVerifiedAt: '2026-11-06T13:05:00.000Z',
    lastEventCount: 2,
    lastEventTypes: ['message','comment']
  };
  const variants = [
    { name: 'Verify Token', envOverrides: { INSTAGRAM_WEBHOOK_VERIFY_TOKEN: 'rotated-verify-token' } },
    { name: 'App Secret', envOverrides: { INSTAGRAM_APP_SECRET: 'rotated-app-secret' } }
  ];
  for (const variant of variants) {
    await t.test(variant.name, async () => {
      const service = loadInbox({
        connection: { token: { iv: 'iv', data: 'cipher', tag: 'tag' }, profile: { userId: 'ig-123', username: 'hibr_pixels' } },
        events: {},
        status,
        envOverrides: variant.envOverrides
      });
      const data = body(await service.handler({ httpMethod: 'GET', headers: {} }));
      assert.equal(data.verification.verifiedForCurrentConfig, false);
      assert.equal(data.verification.verifiedAt, null);
      assert.equal(data.verification.lastReceivedAt, null);
      assert.deepEqual(data.verification.lastEventTypes, []);
    });
  }
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
  assert.equal(result.item.replyDraft.sendStatus, 'draft');
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


test('owner can inspect the live Instagram account webhook subscription without exposing its token', async () => {
  const originalFetch = global.fetch;
  const connection = {
    token: encryptedToken('long-lived-instagram-token'),
    profile: { userId: 'ig-123', username: 'hibr_pixels' }
  };
  let requestUrl, requestHeaders;
  global.fetch = async (url, options = {}) => {
    requestUrl = new URL(url);
    requestHeaders = options.headers || {};
    return {
      ok: true, status: 200,
      async json() { return { data: [{ id: 'ig-123', subscribed_fields: ['messages', 'comments'] }] }; }
    };
  };
  try {
    const service = loadInbox({ connection });
    const response = await service.handler({
      httpMethod: 'GET', headers: {},
      queryStringParameters: { action: 'webhook_subscription' }
    });
    const data = body(response);
    assert.equal(response.statusCode, 200);
    assert.equal(requestUrl.origin, 'https://graph.instagram.com');
    assert.equal(requestUrl.pathname, '/v26.0/me/subscribed_apps');
    assert.equal(requestHeaders.Authorization, 'Bearer long-lived-instagram-token');
    assert.equal(data.subscribed, true);
    assert.deepEqual(data.subscribedFields, ['comments', 'messages']);
    assert.equal(data.callbackVerified, false);
    assert.equal(JSON.stringify(data).includes('long-lived-instagram-token'), false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('owner can explicitly subscribe the connected account to comments and messages after callback verification', async () => {
  const originalFetch = global.fetch;
  const connection = {
    token: encryptedToken('long-lived-instagram-token'),
    profile: { userId: 'ig-123', username: 'hibr_pixels' }
  };
  const requests = [];
  global.fetch = async (url, options = {}) => {
    const parsed = new URL(url);
    requests.push({ url: parsed, method: options.method || 'GET', authorization: options.headers?.Authorization });
    if ((options.method || 'GET') === 'POST') {
      return { ok: true, status: 200, async json() { return { success: true }; } };
    }
    return {
      ok: true, status: 200,
      async json() { return { data: [{ id: 'ig-123', subscribed_fields: ['comments', 'messages'] }] }; }
    };
  };
  try {
    const service = loadInbox({ connection, status: webhookVerification() });
    const response = await service.handler({
      httpMethod: 'POST', headers: {},
      body: JSON.stringify({ action: 'subscribe_webhooks' })
    });
    const data = body(response);
    assert.equal(response.statusCode, 200);
    assert.equal(data.ok, true);
    assert.equal(data.subscribed, true);
    assert.equal(data.externalMessageSent, false);
    assert.match(data.message, /لم نرسل أي رسالة أو تعليق/);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].method, 'POST');
    assert.equal(requests[0].url.pathname, '/v26.0/me/subscribed_apps');
    assert.equal(requests[0].url.searchParams.get('subscribed_fields'), 'comments,messages');
    assert.equal(requests[0].authorization, 'Bearer long-lived-instagram-token');
    assert.equal(requests[1].method, 'GET');
  } finally {
    global.fetch = originalFetch;
  }
});

test('Instagram webhook subscription cannot be changed before the current callback secrets are verified', async () => {
  const originalFetch = global.fetch;
  let externalCalls = 0;
  global.fetch = async () => { externalCalls++; throw new Error('Unexpected network call'); };
  try {
    const service = loadInbox({
      connection: {
        token: encryptedToken('long-lived-instagram-token'),
        profile: { userId: 'ig-123', username: 'hibr_pixels' }
      }
    });
    const response = await service.handler({
      httpMethod: 'POST', headers: {},
      body: JSON.stringify({ action: 'subscribe_webhooks' })
    });
    assert.equal(response.statusCode, 409);
    assert.match(body(response).error, /توثيق Callback URL/);
    assert.equal(externalCalls, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Instagram webhook subscription fails closed when Meta does not confirm every required field', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (_url, options = {}) => {
    if (options.method === 'POST') {
      return { ok: true, status: 200, async json() { return { success: true }; } };
    }
    return {
      ok: true, status: 200,
      async json() { return { data: [{ id: 'ig-123', subscribed_fields: ['comments'] }] }; }
    };
  };
  try {
    const service = loadInbox({
      connection: {
        token: encryptedToken('long-lived-instagram-token'),
        profile: { userId: 'ig-123', username: 'hibr_pixels' }
      },
      status: webhookVerification()
    });
    const response = await service.handler({
      httpMethod: 'POST', headers: {},
      body: JSON.stringify({ action: 'subscribe_webhooks' })
    });
    assert.equal(response.statusCode, 409);
    assert.equal(body(response).subscribed, false);
    assert.deepEqual(body(response).missingFields, ['messages']);
  } finally {
    global.fetch = originalFetch;
  }
});


test('a message reply is sent only after explicit owner confirmation and within the 24-hour window', async () => {
  const now = Date.now();
  const event = {
    id: 'event-send-message', accountId: '123456', eventType: 'message',
    senderId: '987654', timestamp: now - 60 * 1000, status: 'reply_draft_saved',
    replyDraft: { text: 'أهلاً بك، يسعدنا مساعدتك.', savedAt: new Date(now).toISOString(), sendStatus: 'draft', sentAt: null }
  };
  const service = loadInbox({
    connection: { token: encryptedToken('long-lived-instagram-token'), profile: { userId: '123456', username: 'hibr_pixels' } },
    events: { [event.id]: event }
  });
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (url, options = {}) => {
    request = { url: new URL(String(url)), options };
    return { ok: true, status: 200, async json() { return { recipient_id: '987654', message_id: 'message-ack-1' }; } };
  };
  try {
    const response = await service.handler({
      httpMethod: 'POST', headers: {},
      body: JSON.stringify({ action: 'send_reply', id: event.id, confirmed: true })
    });
    const data = body(response);
    assert.equal(response.statusCode, 200);
    assert.equal(data.sent, true);
    assert.equal(data.externalAction, true);
    assert.equal(data.item.replyDraft.sendStatus, 'sent');
    assert.equal(data.item.replyDraft.approvedBy, 'owner');
    assert.equal(data.item.replyDraft.providerId, 'message-ack-1');
    assert.equal(request.url.origin, 'https://graph.instagram.com');
    assert.equal(request.url.pathname, '/v26.0/123456/messages');
    assert.equal(request.options.headers.Authorization, 'Bearer long-lived-instagram-token');
    assert.deepEqual(JSON.parse(request.options.body), { recipient: { id: '987654' }, message: { text: 'أهلاً بك، يسعدنا مساعدتك.' } });
  } finally { global.fetch = originalFetch; }
});

test('a public comment reply uses the comment edge and records the provider confirmation', async () => {
  const event = {
    id: 'event-send-comment', accountId: '123456', eventType: 'comment',
    senderId: '987654', commentId: '555666', timestamp: Date.now(),
    replyDraft: { text: 'شكراً على تعليقك.', savedAt: new Date().toISOString(), sendStatus: 'draft', sentAt: null }
  };
  const service = loadInbox({
    connection: { token: encryptedToken('long-lived-instagram-token'), profile: { userId: '123456', username: 'hibr_pixels' } },
    events: { [event.id]: event }
  });
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (url, options = {}) => {
    request = { url: new URL(String(url)), options };
    return { ok: true, status: 200, async json() { return { id: 'comment-reply-1' }; } };
  };
  try {
    const response = await service.handler({
      httpMethod: 'POST', headers: {},
      body: JSON.stringify({ action: 'send_reply', id: event.id, confirmed: true })
    });
    const data = body(response);
    assert.equal(response.statusCode, 200);
    assert.equal(data.sent, true);
    assert.equal(data.item.replyDraft.providerId, 'comment-reply-1');
    assert.equal(request.url.pathname, '/v26.0/555666/replies');
    assert.equal(request.options.headers.Authorization, 'Bearer long-lived-instagram-token');
    assert.equal(new URLSearchParams(request.options.body).get('message'), 'شكراً على تعليقك.');
  } finally { global.fetch = originalFetch; }
});

test('Instagram reply refuses missing owner confirmation and stale direct messages without contacting Meta', async () => {
  const staleEvent = {
    id: 'event-stale-message', accountId: '123456', eventType: 'message',
    senderId: '987654', timestamp: Date.now() - 25 * 60 * 60 * 1000,
    replyDraft: { text: 'رد قديم', savedAt: new Date().toISOString(), sendStatus: 'draft', sentAt: null }
  };
  const service = loadInbox({
    connection: { token: encryptedToken('long-lived-instagram-token'), profile: { userId: '123456', username: 'hibr_pixels' } },
    events: { [staleEvent.id]: staleEvent }
  });
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls++; throw new Error('Meta must not be called'); };
  try {
    const noApproval = await service.handler({
      httpMethod: 'POST', headers: {},
      body: JSON.stringify({ action: 'send_reply', id: staleEvent.id })
    });
    assert.equal(noApproval.statusCode, 400);
    assert.equal(calls, 0);

    const expired = await service.handler({
      httpMethod: 'POST', headers: {},
      body: JSON.stringify({ action: 'send_reply', id: staleEvent.id, confirmed: true })
    });
    assert.equal(expired.statusCode, 409);
    assert.match(body(expired).error, /24 ساعة/);
    assert.equal(calls, 0);
    assert.equal(service.stores['hbpx-instagram-events'][staleEvent.id].replyDraft.sendStatus, 'draft');
  } finally { global.fetch = originalFetch; }
});

test('a reply with uncertain provider outcome is locked against a duplicate send', async () => {
  const event = {
    id: 'event-uncertain-message', accountId: '123456', eventType: 'message',
    senderId: '987654', timestamp: Date.now() - 1000,
    replyDraft: { text: 'رد اختبار', savedAt: new Date().toISOString(), sendStatus: 'draft', sentAt: null }
  };
  const service = loadInbox({
    connection: { token: encryptedToken('long-lived-instagram-token'), profile: { userId: '123456', username: 'hibr_pixels' } },
    events: { [event.id]: event }
  });
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls++; throw new Error('network interrupted'); };
  try {
    const first = await service.handler({
      httpMethod: 'POST', headers: {},
      body: JSON.stringify({ action: 'send_reply', id: event.id, confirmed: true })
    });
    assert.equal(first.statusCode, 502);
    assert.equal(body(first).uncertain, true);
    assert.equal(service.stores['hbpx-instagram-events'][event.id].replyDraft.sendStatus, 'uncertain');

    const second = await service.handler({
      httpMethod: 'POST', headers: {},
      body: JSON.stringify({ action: 'send_reply', id: event.id, confirmed: true })
    });
    assert.equal(second.statusCode, 409);
    assert.equal(calls, 1);
  } finally { global.fetch = originalFetch; }
});

test('an already-sent reply cannot be overwritten by saving a new draft', async () => {
  const event = {
    id: 'event-already-sent', accountId: '123456', eventType: 'comment',
    senderId: '987654', commentId: '555666',
    replyDraft: { text: 'تم الرد', savedAt: new Date().toISOString(), sentAt: new Date().toISOString(), sendStatus: 'sent' }
  };
  const service = loadInbox({
    connection: { token: encryptedToken('long-lived-instagram-token'), profile: { userId: '123456', username: 'hibr_pixels' } },
    events: { [event.id]: event }
  });
  const response = await service.handler({
    httpMethod: 'POST', headers: {},
    body: JSON.stringify({ action: 'save_reply_draft', id: event.id, reply: 'رد جديد' })
  });
  assert.equal(response.statusCode, 409);
  assert.equal(service.writes.length, 0);
});


test('Arabic direct-message replies are checked by UTF-8 byte length before the external request', async () => {
  const event = {
    id: 'event-arabic-byte-limit', accountId: '123456', eventType: 'message',
    senderId: '987654', timestamp: Date.now() - 1000,
    replyDraft: { text: 'ا'.repeat(501), savedAt: new Date().toISOString(), sendStatus: 'draft', sentAt: null }
  };
  const service = loadInbox({
    connection: { token: encryptedToken('long-lived-instagram-token'), profile: { userId: '123456', username: 'hibr_pixels' } },
    events: { [event.id]: event }
  });
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls++; throw new Error('Meta must not be called'); };
  try {
    const response = await service.handler({
      httpMethod: 'POST', headers: {},
      body: JSON.stringify({ action: 'send_reply', id: event.id, confirmed: true })
    });
    assert.equal(response.statusCode, 400);
    assert.match(body(response).error, /1000 بايت UTF-8/);
    assert.equal(Buffer.byteLength(event.replyDraft.text, 'utf8'), 1002);
    assert.equal(calls, 0);
    assert.equal(service.stores['hbpx-instagram-events'][event.id].replyDraft.sendStatus, 'draft');
  } finally { global.fetch = originalFetch; }
});
