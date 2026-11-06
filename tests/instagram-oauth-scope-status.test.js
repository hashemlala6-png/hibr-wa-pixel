'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function loadHandler(connection) {
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
      return { env(name) { return name === 'INSTAGRAM_API_VERSION' ? 'v26.0' : undefined; } };
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
  assert.deepEqual(body.requestedPermissions, legacyScopes);
  assert.equal(body.grantedPermissions, null);
  assert.equal(body.permissionsVerified, false);
  assert.match(body.permissionNote, /اختبار كل وظيفة/);
  assert.equal(Object.hasOwn(body, 'permissions'), false);
});
