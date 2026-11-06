'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Module = require('node:module');

const SESSION_SECRET = 'instagram-test-session-secret';

function encryptedToken(token) {
  const key = crypto.createHash('sha256').update(SESSION_SECRET).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('base64url'),
    data: data.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url')
  };
}

function response(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return data; }
  };
}

function loadOAuth(connection) {
  const resolved = require.resolve('../netlify/functions/instagram-oauth');
  delete require.cache[resolved];
  const originalLoad = Module._load;
  const writes = [];
  const data = { 'agency-instagram': connection };
  const blobs = {
    connectLambda() {},
    getStore() {
      return {
        async get(key) { return data[key] ?? null; },
        async setJSON(key, value) { data[key] = value; writes.push(value); },
        async delete(key) { delete data[key]; }
      };
    }
  };
  Module._load = function(request, parent, isMain) {
    if (request === '@netlify/blobs' && parent && parent.filename === resolved) return blobs;
    if (request === './env' && parent && parent.filename === resolved) return {
      env(name) {
        if (name === 'ADMIN_SESSION_SECRET') return SESSION_SECRET;
        if (name === 'INSTAGRAM_API_VERSION') return 'v26.0';
        return '';
      }
    };
    if (request === './auth-utils' && parent && parent.filename === resolved) return {
      COOKIE_NAME: 'hbpx_admin',
      requireAdmin() { return null; },
      json(statusCode, body, headers = {}) { return { statusCode, body: JSON.stringify(body), headers }; }
    };
    if (request === './client-activity' && parent && parent.filename === resolved) return { async logActivity() {} };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return { handler: require(resolved).handler, writes, data };
  } finally {
    Module._load = originalLoad;
    delete require.cache[resolved];
  }
}

test('Instagram profile verification sends access token as Bearer header, never in URL', async () => {
  const token = 'private-instagram-token-never-in-url';
  const service = loadOAuth({
    provider: 'instagram-login',
    profile: { userId: 'old-id', username: 'hibr_pixels', accountType: 'BUSINESS' },
    token: encryptedToken(token),
    expiresAt: '2099-01-01T00:00:00.000Z'
  });
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, init = {}) => {
    requests.push({ url: new URL(String(url)), headers: init.headers || {} });
    return response({ user_id: '123456', username: 'hibr_pixels', account_type: 'BUSINESS' });
  };
  try {
    const result = await service.handler({
      httpMethod: 'POST',
      headers: {},
      body: JSON.stringify({ action: 'verify' })
    });
    const data = JSON.parse(result.body);
    assert.equal(result.statusCode, 200);
    assert.equal(data.account.userId, '123456');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url.searchParams.has('access_token'), false);
    assert.equal(requests[0].headers.Authorization, 'Bearer ' + token);
    assert.equal(JSON.stringify(data).includes(token), false);
    assert.equal(service.writes.length, 1);
  } finally {
    global.fetch = originalFetch;
  }
}

function loadInsights(connection) {
  const resolved = require.resolve('../netlify/functions/instagram-insights');
  delete require.cache[resolved];
  const originalLoad = Module._load;
  const snapshots = [];
  const blobs = {
    connectLambda() {},
    getStore({ name }) {
      return {
        async get(key) {
          if (name === 'hbpx-instagram-login' && key === 'agency-instagram') return connection;
          return null;
        },
        async setJSON(key, value) { snapshots.push({ key, value }); },
        async list() { return { blobs: [] }; }
      };
    }
  };
  Module._load = function(request, parent, isMain) {
    if (request === '@netlify/blobs' && parent && parent.filename === resolved) return blobs;
    if (request === './env' && parent && parent.filename === resolved) return {
      env(name) {
        if (name === 'ADMIN_SESSION_SECRET') return SESSION_SECRET;
        if (name === 'INSTAGRAM_API_VERSION') return 'v26.0';
        return '';
      }
    };
    if (request === './auth-utils' && parent && parent.filename === resolved) return {
      requireAdmin() { return null; },
      json(statusCode, body, headers = {}) { return { statusCode, body: JSON.stringify(body), headers }; }
    };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return { handler: require(resolved).handler, snapshots };
  } finally {
    Module._load = originalLoad;
    delete require.cache[resolved];
  }
}

test('Instagram insights sends every graph request with Bearer auth and does not expose the token in URLs or snapshot', async () => {
  const token = 'private-insights-token-never-in-url';
  const service = loadInsights({
    provider: 'instagram-login',
    profile: { userId: '123456', username: 'hibr_pixels', accountType: 'BUSINESS' },
    token: encryptedToken(token),
    expiresAt: '2099-01-01T00:00:00.000Z'
  });
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    requests.push({ url: parsed, headers: init.headers || {} });
    if (parsed.pathname.endsWith('/me/media')) return response({ data: [] });
    if (parsed.pathname.endsWith('/me/insights')) {
      const metric = parsed.searchParams.get('metric');
      return response({ data: [{ name: metric, total_value: { value: 42 } }] });
    }
    return response({ user_id: '123456', username: 'hibr_pixels', account_type: 'BUSINESS', followers_count: 100, media_count: 20 });
  };
  try {
    const result = await service.handler({
      httpMethod: 'POST',
      headers: {},
      body: JSON.stringify({ action: 'sync', days: 7 })
    });
    const data = JSON.parse(result.body);
    assert.equal(result.statusCode, 200);
    assert.equal(requests.length, 8);
    for (const request of requests) {
      assert.equal(request.url.searchParams.has('access_token'), false);
      assert.equal(request.headers.Authorization, 'Bearer ' + token);
      assert.equal(request.url.hostname, 'graph.instagram.com');
    }
    assert.equal(data.snapshot.profile.username, 'hibr_pixels');
    assert.equal(data.snapshot.metrics.length, 6);
    assert.equal(service.snapshots.length, 1);
    const serialized = JSON.stringify({ response: data, snapshot: service.snapshots });
    assert.equal(serialized.includes(token), false);
  } finally {
    global.fetch = originalFetch;
  }
}
