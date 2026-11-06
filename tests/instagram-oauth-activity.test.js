'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const SESSION_SECRET = 'instagram-oauth-activity-test-secret';
const REDIRECT_URI = 'https://fabulous-bublanina-8d5626.netlify.app/.netlify/functions/instagram-oauth';

function response(data, status = 200) {
  return { ok: status >= 200 && status < 300, status, async json() { return data; } };
}

function loadOAuth({ failActivity = false, initialConnection = null } = {}) {
  const resolved = require.resolve('../netlify/functions/instagram-oauth');
  delete require.cache[resolved];
  const originalLoad = Module._load;
  const records = { connection: initialConnection, activityCalls: [], storeWrites: 0, deletes: 0 };
  const blobs = {
    connectLambda() {},
    getStore() {
      return {
        async get(key) { return key === 'agency-instagram' ? records.connection : null; },
        async setJSON(key, value) {
          if (key === 'agency-instagram') records.connection = value;
          records.storeWrites++;
        },
        async delete(key) {
          if (key === 'agency-instagram') records.connection = null;
          records.deletes++;
        }
      };
    }
  };
  Module._load = function(request, parent, isMain) {
    if (request === '@netlify/blobs' && parent && parent.filename === resolved) return blobs;
    if (request === './env' && parent && parent.filename === resolved) return {
      env(name) {
        return ({
          ADMIN_SESSION_SECRET: SESSION_SECRET,
          INSTAGRAM_APP_ID: 'test-instagram-app-id',
          INSTAGRAM_APP_SECRET: 'test-instagram-app-secret',
          INSTAGRAM_REDIRECT_URI: REDIRECT_URI,
          INSTAGRAM_API_VERSION: 'v26.0'
        })[name] || '';
      }
    };
    if (request === './auth-utils' && parent && parent.filename === resolved) return {
      COOKIE_NAME: 'hbpx_admin',
      requireAdmin() { return null; },
      json(statusCode, body, headers = {}) { return { statusCode, body: JSON.stringify(body), headers }; }
    };
    if (request === './client-activity' && parent && parent.filename === resolved) return {
      async logActivity(...args) {
        records.activityCalls.push(args);
        if (failActivity) throw new Error('activity store unavailable');
      }
    };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return { handler: require(resolved).handler, records };
  } finally {
    Module._load = originalLoad;
    delete require.cache[resolved];
  }
}

const ownerEvent = {
  headers: { cookie: 'hbpx_admin=owner-session-token' },
  queryStringParameters: {}
};

test('Instagram connect and disconnect activity is attributed to the agency', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'netlify', 'functions', 'instagram-oauth.js'), 'utf8');
  assert.match(source, /const AGENCY_ACTIVITY_ID\s*=\s*['"]hibr-wa-pixel['"]/);
  assert.equal((source.match(/recordIntegrationActivity\(/g) || []).length, 3);
  assert.match(source, /logActivity\(AGENCY_ACTIVITY_ID,\s*['"]integration['"]/);
});

test('OAuth remains successful when the secondary activity feed fails after the connection is stored', async () => {
  const service = loadOAuth({ failActivity: true });
  const originalFetch = global.fetch;
  const originalError = console.error;
  console.error = () => {};
  global.fetch = async url => {
    const parsed = new URL(String(url));
    if (parsed.hostname === 'api.instagram.com') return response({ access_token: 'short-lived-test-token', user_id: '98765' });
    if (parsed.hostname === 'graph.instagram.com' && parsed.pathname === '/access_token') {
      return response({ access_token: 'long-lived-test-token', token_type: 'bearer', expires_in: 5184000 });
    }
    if (parsed.hostname === 'graph.instagram.com' && parsed.pathname.endsWith('/me')) {
      return response({ user_id: '98765', username: 'hibr_pixels', account_type: 'BUSINESS' });
    }
    throw new Error('Unexpected test URL: ' + parsed.toString());
  };
  try {
    const connect = await service.handler({
      ...ownerEvent,
      httpMethod: 'GET',
      queryStringParameters: { action: 'connect' }
    });
    assert.equal(connect.statusCode, 200);
    const authorizeUrl = new URL(JSON.parse(connect.body).authorizationUrl);
    const state = authorizeUrl.searchParams.get('state');
    assert.ok(state);

    const callback = await service.handler({
      ...ownerEvent,
      httpMethod: 'GET',
      queryStringParameters: { code: 'single-use-test-code', state }
    });
    assert.equal(callback.statusCode, 302);
    assert.equal(callback.headers.Location, '/instagram.html?connected=1');
    assert.equal(service.records.connection.profile.username, 'hibr_pixels');
    assert.equal(service.records.connection.provider, 'instagram-login');
    assert.equal(service.records.storeWrites, 1);
    assert.equal(service.records.activityCalls.length, 1);
  } finally {
    global.fetch = originalFetch;
    console.error = originalError;
  }
});

test('disconnect remains successful when the secondary activity feed fails after token removal', async () => {
  const service = loadOAuth({ failActivity: true, initialConnection: { token: { iv: 'x', data: 'y', tag: 'z' }, profile: { username: 'hibr_pixels' } } });
  const originalError = console.error;
  console.error = () => {};
  try {
    const result = await service.handler({
      ...ownerEvent,
      httpMethod: 'POST',
      body: JSON.stringify({ action: 'disconnect' })
    });
    assert.equal(result.statusCode, 200);
    assert.deepEqual(JSON.parse(result.body), { ok: true });
    assert.equal(service.records.connection, null);
    assert.equal(service.records.deletes, 1);
    assert.equal(service.records.activityCalls.length, 1);
  } finally {
    console.error = originalError;
  }
});
