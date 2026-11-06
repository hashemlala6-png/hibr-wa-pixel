'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function loadHealth({ env = {}, connection = null, textResult = null, textError = null } = {}) {
  const resolved = require.resolve('../netlify/functions/system-health');
  delete require.cache[resolved];
  const originalLoad = Module._load;
  const writes = [];
  const calls = [];
  const blobs = {
    connectLambda(event) { calls.push({ type: 'connectLambda', event }); },
    getStore({ name }) {
      return {
        async list() {
          if (name === 'hbpx-leads') return { blobs: [] };
          return { blobs: [] };
        },
        async get(key) {
          if (name === 'hbpx-instagram-login' && key === 'agency-instagram') return connection;
          if (name === 'hbpx-system-health' && key === 'latest-ai-text-test') return null;
          return null;
        },
        async setJSON(key, value) { writes.push({ name, key, value }); }
      };
    }
  };
  Module._load = function(request, parent, isMain) {
    if (request === '@netlify/blobs' && parent && parent.filename === resolved) return blobs;
    if (request === './env' && parent && parent.filename === resolved) return { env(name) { return env[name] || ''; } };
    if (request === './auth-utils' && parent && parent.filename === resolved) {
      return {
        requireAdmin(event) { return event.authorized === false ? { statusCode: 401, body: '{}' } : null; },
        json(statusCode, body) { return { statusCode, body: JSON.stringify(body) }; }
      };
    }
    if (request === './ai-provider' && parent && parent.filename === resolved) {
      return {
        configuredProviders() {
          const list = [];
          if (env.OPENAI_API_KEY) list.push({ provider: 'openai', model: env.OPENAI_TEXT_MODEL || 'gpt-6-luna' });
          if (env.ANTHROPIC_API_KEY) list.push({ provider: 'anthropic', model: env.ANTHROPIC_TEXT_MODEL || 'claude-sonnet-4-6' });
          return list;
        },
        async requestText() {
          if (textError) throw new Error(textError);
          return textResult || { text: 'جاهز', provider: 'openai', model: 'gpt-6-luna', fallbackUsed: false };
        }
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return { handler: require(resolved).handler, calls, writes };
  } finally {
    Module._load = originalLoad;
    delete require.cache[resolved];
  }
}

function body(response) { return JSON.parse(response.body || '{}'); }

test('system health requires an owner session', async () => {
  const service = loadHealth();
  const response = await service.handler({ httpMethod: 'GET', headers: {}, authorized: false });
  assert.equal(response.statusCode, 401);
  assert.equal(service.calls.length, 1);
});

test('system health reports configuration separately from tested operational status and never returns secrets', async () => {
  const service = loadHealth({
    env: {
      OPENAI_API_KEY: 'openai-private-secret',
      ANTHROPIC_API_KEY: 'anthropic-private-secret',
      RESEND_API_KEY: 'resend-private-secret',
      LEADS_NOTIFY_EMAIL: 'owner@example.com',
      LEADS_FROM_EMAIL: 'verified@example.com',
      WHATSAPP_ACCESS_TOKEN: 'whatsapp-private-secret',
      WHATSAPP_PHONE_NUMBER_ID: '12345',
      WHATSAPP_TEMPLATE_NAME: 'owner_alert',
      WHATSAPP_OWNER_NUMBER: '9647700000000'
    },
    connection: {
      token: { iv: 'cipher', data: 'cipher', tag: 'cipher' },
      profile: { username: 'hibr_pixels' },
      expiresAt: '2099-01-01T00:00:00.000Z'
    }
  });
  const response = await service.handler({ httpMethod: 'GET', headers: {}, authorized: true });
  const result = body(response);
  assert.equal(response.statusCode, 200);
  assert.equal(result.configuration.aiText.state, 'configured');
  assert.equal(result.configuration.aiText.primary, 'openai');
  assert.equal(result.configuration.email.state, 'configured');
  assert.equal(result.configuration.ownerWhatsApp.state, 'configured');
  assert.equal(result.persistent.storage.state, 'operational');
  assert.equal(result.persistent.instagram.state, 'linked_unverified');
  assert.equal(result.policy.secretsReturned, false);
  const serialized = JSON.stringify(result);
  for (const secret of ['openai-private-secret', 'anthropic-private-secret', 'resend-private-secret', 'whatsapp-private-secret']) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('missing service variables are shown as missing rather than healthy', async () => {
  const service = loadHealth();
  const response = await service.handler({ httpMethod: 'GET', headers: {}, authorized: true });
  const result = body(response);
  assert.equal(result.configuration.aiText.state, 'missing');
  assert.equal(result.configuration.email.state, 'missing');
  assert.equal(result.configuration.instagram.state, 'missing');
  assert.equal(result.persistent.instagram.state, 'not_connected');
});

test('owner-triggered text test performs a small provider request and stores a bounded result', async () => {
  const service = loadHealth({
    env: { OPENAI_API_KEY: 'openai-private-secret' },
    textResult: { text: 'جاهز', provider: 'openai', model: 'gpt-6-luna', fallbackUsed: false }
  });
  const response = await service.handler({
    httpMethod: 'POST',
    headers: {},
    authorized: true,
    body: JSON.stringify({ action: 'test_text_ai' })
  });
  const result = body(response);
  assert.equal(response.statusCode, 200);
  assert.equal(result.test.state, 'operational');
  assert.equal(result.test.provider, 'openai');
  assert.equal(result.output, 'جاهز');
  assert.equal(service.writes.length, 1);
  assert.equal(service.writes[0].key, 'latest-ai-text-test');
});

test('text test is not attempted when no provider is configured', async () => {
  const service = loadHealth();
  const response = await service.handler({
    httpMethod: 'POST',
    headers: {},
    authorized: true,
    body: JSON.stringify({ action: 'test_text_ai' })
  });
  assert.equal(response.statusCode, 503);
  assert.equal(body(response).test.state, 'not_run');
  assert.equal(service.writes.length, 0);
});

test('provider failures are surfaced and are not recorded as successful tests', async () => {
  const service = loadHealth({ env: { ANTHROPIC_API_KEY: 'private' }, textError: 'رصيد المزود غير كافٍ.' });
  const response = await service.handler({
    httpMethod: 'POST',
    headers: {},
    authorized: true,
    body: JSON.stringify({ action: 'test_text_ai' })
  });
  assert.equal(response.statusCode, 502);
  assert.equal(body(response).test.state, 'error');
  assert.equal(service.writes[0].value.state, 'error');
});

test('owner WhatsApp readiness accounts for the documented server-side recipient fallback', async () => {
  const service = loadHealth({
    env: {
      WHATSAPP_ACCESS_TOKEN: 'private',
      WHATSAPP_PHONE_NUMBER_ID: '12345',
      WHATSAPP_TEMPLATE_NAME: 'owner_alert'
    }
  });
  const result = body(await service.handler({ httpMethod: 'GET', headers: {}, authorized: true }));
  assert.equal(result.configuration.ownerWhatsApp.state, 'configured');
  assert.equal(result.configuration.ownerWhatsApp.configuredFields, 4);
  assert.equal(result.configuration.ownerWhatsApp.recipientSource, 'server_default');
  assert.equal(JSON.stringify(result).includes('9647721971156'), false);
});
