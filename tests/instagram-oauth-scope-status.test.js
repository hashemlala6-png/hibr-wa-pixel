'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function loadHandler(connection, environment = {}) {
  const resolved = require.resolve('../netlify/functions/instagram-oauth');
  delete require.cache[resolved];
  const originalLoad = Module._load;
  const blobs = {
    connectLambda() {},
    getStore() { return { async get() { return connection; } }; }
  };
  Module._load = function(request, parent, isMain) {
    if (request === '@netlify/blobs') return blobs;
    if (request === './env' && parent && parent.filename === resolved) {
      return { env(name) {
        if (name === 'INSTAGRAM_API_VERSION') return environment.INSTAGRAM_API_VERSION || 'v26.0';
        return environment[name];
      } };
    }
    if (request === './auth-utils' && parent && parent.filename === resolved) {
      return {
        COOKIE_NAME: 'hbpx_admin',
        requireAdmin() { return null; },
        json(statusCode, payload, headers = {}) {
          return { statusCode, headers, body: JSON.stringify(payload) };
        }
      };
    }
    if (request === './client-activity' && parent && parent.filename === resolved) return { async logActivity() {} };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(resolved).handler;
  } finally {
    Module._load = originalLoad;
    delete require.cache[resolved];
  }
}

test('Instagram status never reports requested or legacy scopes as verified grants', async () => {
  const legacyScopes = [
    'instagram_business_basic',
    'instagram_business_content_publish',
    'instagram_business_manage_comments',
    'instagram_business_manage_insights',
    'instagram_business_manage_messages'
  ];
  const handler = loadHandler({
    provider: 'instagram-login',
    profile: { userId: '123', username: 'hibr_pixels', accountType: 'BUSINESS' },
    token: { iv: 'x', data: 'x', tag: 'x' },
    grantedScopes: legacyScopes
  });
  const response = await handler({
    httpMethod: 'GET',
    headers: {},
    queryStringParameters: { action: 'status' }
  });
  const body = JSON.parse(response.body);
  assert.equal(response.statusCode, 200);
  assert.equal(body.connected, true);
  assert.equal(body.configured, false);
  assert.equal(body.redirectUri, null);
  assert.deepEqual(body.requestedPermissions, legacyScopes);
  assert.equal(body.grantedPermissions, null);
  assert.equal(body.permissionsVerified, false);
  assert.match(body.permissionNote, /اختبار كل وظيفة/);
  assert.equal(Object.hasOwn(body, 'permissions'), false);
});


test('Instagram Login refuses to derive its redirect URI from request host headers', async () => {
  const handler = loadHandler(null, {
    INSTAGRAM_APP_ID: 'test-client-id',
    INSTAGRAM_APP_SECRET: 'test-client-secret',
    ADMIN_SESSION_SECRET: 'test-admin-session-secret-with-enough-entropy'
  });
  const response = await handler({
    httpMethod: 'GET',
    headers: {
      cookie: 'hbpx_admin=owner-session',
      host: 'attacker.example',
      'x-forwarded-host': 'attacker.example',
      'x-forwarded-proto': 'https'
    },
    queryStringParameters: { action: 'connect' }
  });
  const body = JSON.parse(response.body);
  assert.equal(response.statusCode, 503);
  assert.ok(body.missing.includes('INSTAGRAM_REDIRECT_URI (عنوان HTTPS ثابت ومسجل في Meta)'));
  assert.equal(body.redirectUri, null);
});

test('Instagram Login uses only the configured HTTPS callback and keeps Facebook Login disabled', async () => {
  const redirectUri = 'https://fabulous-bublanina-8d5626.netlify.app/.netlify/functions/instagram-oauth';
  const handler = loadHandler(null, {
    INSTAGRAM_APP_ID: 'test-client-id',
    INSTAGRAM_APP_SECRET: 'test-client-secret',
    ADMIN_SESSION_SECRET: 'test-admin-session-secret-with-enough-entropy',
    INSTAGRAM_REDIRECT_URI: redirectUri
  });
  const response = await handler({
    httpMethod: 'GET',
    headers: {
      cookie: 'hbpx_admin=owner-session',
      host: 'attacker.example',
      'x-forwarded-host': 'attacker.example',
      'x-forwarded-proto': 'https'
    },
    queryStringParameters: { action: 'connect' }
  });
  const body = JSON.parse(response.body);
  assert.equal(response.statusCode, 200);
  const authorizationUrl = new URL(body.authorizationUrl);
  assert.equal(authorizationUrl.searchParams.get('redirect_uri'), redirectUri);
  assert.equal(authorizationUrl.searchParams.get('enable_fb_login'), '0');
  assert.equal(body.redirectUri, redirectUri);
});
