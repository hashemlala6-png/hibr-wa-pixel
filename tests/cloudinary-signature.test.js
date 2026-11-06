'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Module = require('node:module');

const CLOUD_SECRET = 'cloudinary-private-api-secret';

function loadSignature({ env = {}, denied = false } = {}) {
  const resolved = require.resolve('../netlify/functions/instagram-media-signature');
  delete require.cache[resolved];
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === './env' && parent && parent.filename === resolved) return {
      env(name) { return env[name] || ''; }
    };
    if (request === './auth-utils' && parent && parent.filename === resolved) return {
      requireAdmin() { return denied ? { statusCode: 401, body: '{}' } : null; },
      json(statusCode, body, headers = {}) { return { statusCode, body: JSON.stringify(body), headers }; }
    };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require(resolved).handler;
  } finally {
    Module._load = originalLoad;
    delete require.cache[resolved];
  }
}
function body(response) { return JSON.parse(response.body || '{}'); }

test('Cloudinary returns a short-lived signature scoped to the selected media type and fixed folder', async () => {
  const handler = loadSignature({
    env: {
      CLOUDINARY_CLOUD_NAME: 'hibr-cloud',
      CLOUDINARY_API_KEY: 'public-api-key',
      CLOUDINARY_API_SECRET: CLOUD_SECRET
    }
  });
  const response = await handler({
    httpMethod: 'POST',
    headers: {},
    body: JSON.stringify({ resourceType: 'image' })
  });
  const result = body(response);
  assert.equal(response.statusCode, 200);
  assert.equal(result.resourceType, 'image');
  assert.equal(result.folder, 'hibr-wa-pixel/instagram');
  assert.equal(result.overwrite, false);
  assert.equal(result.uploadUrl, 'https://api.cloudinary.com/v1_1/hibr-cloud/image/upload');
  const signed = {
    folder: result.folder,
    overwrite: 'false',
    public_id: result.publicId,
    timestamp: String(result.timestamp)
  };
  const source = Object.keys(signed).sort().map(key => key + '=' + signed[key]).join('&');
  const expected = crypto.createHash('sha1').update(source + CLOUD_SECRET).digest('hex');
  assert.equal(result.signature, expected);
  assert.equal(result.expiresAt, new Date((result.timestamp + 3600) * 1000).toISOString());
  assert.equal(JSON.stringify(result).includes(CLOUD_SECRET), false);
});

test('Cloudinary signature refuses an unauthenticated owner request', async () => {
  const handler = loadSignature({
    env: { CLOUDINARY_CLOUD_NAME: 'hibr-cloud', CLOUDINARY_API_KEY: 'public', CLOUDINARY_API_SECRET: CLOUD_SECRET },
    denied: true
  });
  const response = await handler({ httpMethod: 'POST', headers: {}, body: '{"resourceType":"image"}' });
  assert.equal(response.statusCode, 401);
});

test('Cloudinary signature rejects unsupported types and missing configuration', async () => {
  const configured = loadSignature({
    env: { CLOUDINARY_CLOUD_NAME: 'hibr-cloud', CLOUDINARY_API_KEY: 'public', CLOUDINARY_API_SECRET: CLOUD_SECRET }
  });
  const badType = await configured({ httpMethod: 'POST', headers: {}, body: '{"resourceType":"raw"}' });
  assert.equal(badType.statusCode, 400);
  const missing = loadSignature({ env: { CLOUDINARY_CLOUD_NAME: 'hibr-cloud' } });
  const unavailable = await missing({ httpMethod: 'POST', headers: {}, body: '{"resourceType":"image"}' });
  assert.equal(unavailable.statusCode, 503);
});
