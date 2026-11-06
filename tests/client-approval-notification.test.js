'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function loadLeads(initial) {
  const resolved = require.resolve('../netlify/functions/leads');
  delete require.cache[resolved];
  const originalLoad = Module._load;
  const writes = [];
  const stores = initial;
  const blobModule = {
    connectLambda() {},
    getStore({ name }) {
      if (!stores[name]) stores[name] = {};
      const data = stores[name];
      return {
        async list({ prefix = '' } = {}) {
          return { blobs: Object.keys(data).filter(key => key.startsWith(prefix)).map(key => ({ key })) };
        },
        async get(key) {
          return clone(data[key] ?? null);
        },
        async setJSON(key, value) {
          writes.push({ store: name, key, value: clone(value) });
          data[key] = clone(value);
        },
        async delete(key) {
          delete data[key];
        }
      };
    }
  };

  Module._load = function(request, parent, isMain) {
    if (request === '@netlify/blobs') return blobModule;
    if (request === './auth-utils' && parent && parent.filename === resolved) {
      return {
        requireAdmin() { return null; },
        json(statusCode, payload, headers = {}) {
          return { statusCode, body: JSON.stringify(payload), headers };
        }
      };
    }
    if (request === './client-activity' && parent && parent.filename === resolved) {
      return { async logActivity() {} };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const handler = require(resolved).handler;
    return { handler, stores, writes };
  } finally {
    Module._load = originalLoad;
    delete require.cache[resolved];
  }
}

function baseData(whatsapp) {
  return {
    'hbpx-leads': {
      'lead-test': {
        id: 'lead-test',
        name: 'عميل اختبار',
        email: '',
        whatsapp,
        service: 'design',
        status: 'new',
        createdAt: '2026-11-06T00:00:00.000Z'
      }
    },
    'hbpx-client-accounts': {},
    'hbpx-lead-index': {},
    'hbpx-lead-rate': {}
  };
}

const envKeys = [
  'RESEND_API_KEY',
  'CLIENT_APPROVAL_FROM_EMAIL',
  'LEADS_FROM_EMAIL',
  'WHATSAPP_ACCESS_TOKEN',
  'WHATSAPP_PHONE_NUMBER_ID',
  'WHATSAPP_CLIENT_APPROVAL_TEMPLATE_NAME',
  'WHATSAPP_CLIENT_APPROVAL_TEMPLATE_LANGUAGE'
];

async function withEnv(values, fn) {
  const saved = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  const originalFetch = global.fetch;
  try {
    for (const key of envKeys) delete process.env[key];
    Object.assign(process.env, values);
    return await fn();
  } finally {
    for (const key of envKeys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    global.fetch = originalFetch;
  }
}

async function approve(handler) {
  const response = await handler({
    httpMethod: 'PATCH',
    headers: { host: 'fabulous-bublanina-8d5626.netlify.app' },
    body: JSON.stringify({ id: 'lead-test', status: 'approved' })
  });
  return { response, body: JSON.parse(response.body || '{}') };
}

test('lead approval succeeds even when external notification providers are not configured', async () => {
  await withEnv({}, async () => {
    const service = loadLeads(baseData('07712345678'));
    const { response, body } = await approve(service.handler);

    assert.equal(response.statusCode, 200);
    assert.equal(body.lead.status, 'approved');
    assert.equal(body.customerNotifications.whatsapp, 'not_configured');
    assert.equal(service.stores['hbpx-leads']['lead-test'].status, 'approved');
  });
});

test('approval WhatsApp template uses the complete Iraqi international recipient number', async () => {
  await withEnv({
    WHATSAPP_ACCESS_TOKEN: 'test-token',
    WHATSAPP_PHONE_NUMBER_ID: 'test-phone-id',
    WHATSAPP_CLIENT_APPROVAL_TEMPLATE_NAME: 'client_approved',
    WHATSAPP_CLIENT_APPROVAL_TEMPLATE_LANGUAGE: 'ar'
  }, async () => {
    const service = loadLeads(baseData('+964 771 234 5678'));
    const calls = [];
    global.fetch = async (url, init) => {
      calls.push({ url: String(url), init, payload: JSON.parse(init.body) });
      return { ok: true, status: 200, async text() { return ''; } };
    };

    const { response, body } = await approve(service.handler);
    assert.equal(response.statusCode, 200);
    assert.equal(body.customerNotifications.whatsapp, 'sent');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].payload.to, '9647712345678');
    assert.equal(calls[0].payload.template.name, 'client_approved');
  });
});

test('invalid WhatsApp recipients are not sent to the Cloud API', async () => {
  await withEnv({
    WHATSAPP_ACCESS_TOKEN: 'test-token',
    WHATSAPP_PHONE_NUMBER_ID: 'test-phone-id',
    WHATSAPP_CLIENT_APPROVAL_TEMPLATE_NAME: 'client_approved'
  }, async () => {
    const service = loadLeads(baseData('123'));
    let calls = 0;
    global.fetch = async () => { calls++; throw new Error('External fetch must not be called'); };

    const { response, body } = await approve(service.handler);
    assert.equal(response.statusCode, 200);
    assert.equal(body.customerNotifications.whatsapp, 'invalid_recipient');
    assert.equal(calls, 0);
  });
});


function validLeadPayload(overrides = {}) {
  return {
    name: 'عميل اختبار',
    whatsapp: '07712345678',
    email: 'TEST@EXAMPLE.COM',
    service: 'design',
    budget: 'أحتاج توجيه',
    details: 'أحتاج تصاميم لمشروعي.',
    source: 'public-onboarding',
    ...overrides
  };
}

async function submitLead(handler, payload, ip = '192.0.2.10') {
  const response = await handler({
    httpMethod: 'POST',
    headers: { 'x-forwarded-for': ip },
    body: JSON.stringify(payload)
  });
  return { response, body: JSON.parse(response.body || '{}') };
}

test('public lead intake requires an email for later client-account matching', async () => {
  await withEnv({}, async () => {
    const service = loadLeads(baseData('07712345678'));
    const { response, body } = await submitLead(service.handler, validLeadPayload({ email: '' }));
    assert.equal(response.statusCode, 400);
    assert.match(body.error, /البريد الإلكتروني مطلوب/);
    assert.equal(Object.keys(service.stores['hbpx-leads']).length, 1);
  });
});

test('public lead intake rejects malformed WhatsApp numbers before saving', async () => {
  await withEnv({}, async () => {
    const service = loadLeads(baseData('07712345678'));
    const { response, body } = await submitLead(service.handler, validLeadPayload({ whatsapp: '123' }), '192.0.2.11');
    assert.equal(response.statusCode, 400);
    assert.match(body.error, /واتساب غير صحيح/);
    assert.equal(Object.keys(service.stores['hbpx-leads']).length, 1);
  });
});

test('valid public lead intake stores a normalized Iraqi WhatsApp number and required account contacts', async () => {
  await withEnv({}, async () => {
    const service = loadLeads(baseData('07712345678'));
    const { response, body } = await submitLead(service.handler, validLeadPayload(), '192.0.2.12');
    assert.equal(response.statusCode, 201);
    assert.equal(body.ok, true);
    const saved = service.stores['hbpx-leads'][body.leadId];
    assert.ok(saved);
    assert.equal(saved.email, 'test@example.com');
    assert.equal(saved.whatsapp, '9647712345678');
    assert.equal(saved.service, 'design');
    assert.equal(saved.details, 'أحتاج تصاميم لمشروعي.');
    assert.equal(body.notifications.email, 'not_configured');
    assert.equal(body.notifications.whatsapp, 'not_configured');
  });
});
