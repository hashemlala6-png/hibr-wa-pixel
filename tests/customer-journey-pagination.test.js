'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const crypto = require('node:crypto');

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function loadHandler(relativePath, initial = {}) {
  const resolved = require.resolve(relativePath);
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
        async list({ prefix = '', limit = 100, cursor } = {}) {
          const keys = Object.keys(data).filter(key => key.startsWith(prefix));
          const offset = cursor ? Number(cursor) : 0;
          const selected = keys.slice(offset, offset + limit);
          const next = offset + selected.length < keys.length ? String(offset + selected.length) : null;
          return { blobs: selected.map(key => ({ key })), cursor: next };
        },
        async get(key) { return clone(data[key] ?? null); },
        async setJSON(key, value) {
          writes.push({ store: name, key, value: clone(value) });
          data[key] = clone(value);
        },
        async delete(key) { delete data[key]; }
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
    if (request === './platform-analytics' && parent && parent.filename === resolved) {
      return { async record() {} };
    }
    if (request === './client-auth-utils' && parent && parent.filename === resolved) {
      return {
        createClientSession(id) { return 'session-' + id; },
        getClientSession() { return null; },
        sessionCookie(token) { return 'hbpx_client=' + token; },
        clearCookie() { return 'hbpx_client=; Max-Age=0'; }
      };
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

function body(response) { return JSON.parse(response.body || '{}'); }

test('owner lead inbox reads leads across all Blobs pages', async () => {
  const leads = {};
  for (let i = 0; i < 205; i++) {
    const id = 'lead-' + String(i).padStart(4, '0');
    leads[id] = { id, name: 'Lead ' + i, status: 'new', createdAt: new Date(2026, 0, 1 + i).toISOString() };
  }
  const service = loadHandler('../netlify/functions/leads', { 'hbpx-leads': leads });
  const response = await service.handler({ httpMethod: 'GET', headers: {} });
  const result = body(response);
  assert.equal(response.statusCode, 200);
  assert.equal(result.leads.length, 205);
  assert.equal(result.leads[0].id, 'lead-0204');
});

test('client registration finds an approved lead beyond the first Blobs page and links it to the new account', async () => {
  const leads = {};
  for (let i = 0; i < 105; i++) {
    const id = 'lead-' + String(i).padStart(4, '0');
    leads[id] = {
      id, name: 'Another lead', email: 'other' + i + '@example.com',
      whatsapp: '964771111' + String(i).padStart(3, '0'),
      status: 'new', createdAt: new Date().toISOString()
    };
  }
  leads['lead-approved-late'] = {
    id: 'lead-approved-late',
    name: 'Approved customer',
    email: 'approved@example.com',
    whatsapp: '9647712345678',
    status: 'approved',
    clientId: 'lead-approved-late',
    createdAt: new Date().toISOString()
  };

  const originalSecret = process.env.CLIENT_SESSION_SECRET;
  process.env.CLIENT_SESSION_SECRET = 'test-client-session-secret-with-enough-entropy';
  try {
    const service = loadHandler('../netlify/functions/client-auth', {
      'hbpx-leads': leads,
      'hbpx-client-accounts': {},
      'hbpx-lead-index': {},
      'hbpx-client-auth-rate': {}
    });
    const email = 'APPROVED@example.com';
    const response = await service.handler({
      httpMethod: 'POST',
      queryStringParameters: { action: 'register' },
      headers: { 'x-forwarded-for': '192.0.2.80' },
      body: JSON.stringify({
        name: 'Approved customer',
        email,
        whatsapp: '+964 771 234 5678',
        password: 'secure-pass-123'
      })
    });
    const result = body(response);
    const accountId = 'email-' + crypto.createHash('sha256').update(email.toLowerCase()).digest('hex').slice(0, 48);

    assert.equal(response.statusCode, 201);
    assert.equal(result.authenticated, true);
    assert.equal(result.client.id, accountId);
    assert.ok(service.stores['hbpx-client-accounts'][accountId]);
    assert.equal(service.stores['hbpx-leads']['lead-approved-late'].clientId, accountId);
    assert.ok(service.stores['hbpx-lead-index']['client-' + accountId + '-lead-approved-late']);
  } finally {
    if (originalSecret === undefined) delete process.env.CLIENT_SESSION_SECRET;
    else process.env.CLIENT_SESSION_SECRET = originalSecret;
  }
});


test('owner client registry aggregates customers beyond the first Blobs page', async () => {
  const leads = {};
  for (let i = 0; i < 205; i++) {
    const id = 'lead-' + String(i).padStart(4, '0');
    leads[id] = {
      id,
      name: 'Client ' + i,
      email: 'client' + i + '@example.com',
      whatsapp: '96477' + String(10000000 + i),
      status: 'new',
      createdAt: new Date(2026, 0, 1 + i).toISOString()
    };
  }
  const service = loadHandler('../netlify/functions/clients', { 'hbpx-leads': leads });
  const response = await service.handler({ httpMethod: 'GET', headers: {} });
  const result = body(response);
  assert.equal(response.statusCode, 200);
  assert.equal(result.clients.length, 205);
});

test('client registration is denied when either contact differs from the approved lead', async () => {
  const originalSecret = process.env.CLIENT_SESSION_SECRET;
  process.env.CLIENT_SESSION_SECRET = 'test-client-session-secret-with-enough-entropy';
  try {
    const service = loadHandler('../netlify/functions/client-auth', {
      'hbpx-leads': {
        'lead-approved': {
          id: 'lead-approved',
          name: 'Approved customer',
          email: 'approved@example.com',
          whatsapp: '9647712345678',
          status: 'approved'
        }
      },
      'hbpx-client-accounts': {},
      'hbpx-lead-index': {},
      'hbpx-client-auth-rate': {}
    });
    const response = await service.handler({
      httpMethod: 'POST',
      queryStringParameters: { action: 'register' },
      headers: { 'x-forwarded-for': '192.0.2.81' },
      body: JSON.stringify({
        name: 'Someone else',
        email: 'other@example.com',
        whatsapp: '+964 771 234 5678',
        password: 'secure-pass-123'
      })
    });
    assert.equal(response.statusCode, 403);
    assert.match(body(response).error, /نفس البريد/);
    assert.equal(Object.keys(service.stores['hbpx-client-accounts']).length, 0);
    assert.equal(service.writes.some(write => write.store === 'hbpx-lead-index'), false);
  } finally {
    if (originalSecret === undefined) delete process.env.CLIENT_SESSION_SECRET;
    else process.env.CLIENT_SESSION_SECRET = originalSecret;
  }
});


test('full customer journey: website lead intake, owner approval, then matching client registration', async () => {
  const originalSecret = process.env.CLIENT_SESSION_SECRET;
  const notificationKeys = [
    'RESEND_API_KEY', 'CLIENT_APPROVAL_FROM_EMAIL', 'LEADS_FROM_EMAIL',
    'WHATSAPP_ACCESS_TOKEN', 'WHATSAPP_PHONE_NUMBER_ID',
    'WHATSAPP_CLIENT_APPROVAL_TEMPLATE_NAME', 'WHATSAPP_TEMPLATE_NAME',
    'LEADS_NOTIFY_EMAIL'
  ];
  const oldNotifications = Object.fromEntries(notificationKeys.map(key => [key, process.env[key]]));
  const originalFetch = global.fetch;
  process.env.CLIENT_SESSION_SECRET = 'e2e-client-session-secret-with-strong-entropy';
  for (const key of notificationKeys) delete process.env[key];
  global.fetch = async () => { throw new Error('External notification call is not expected in this test'); };

  const shared = {
    'hbpx-leads': {},
    'hbpx-client-accounts': {},
    'hbpx-lead-index': {},
    'hbpx-lead-rate': {},
    'hbpx-client-auth-rate': {}
  };

  try {
    const leadService = loadHandler('../netlify/functions/leads', shared);
    const intake = await leadService.handler({
      httpMethod: 'POST',
      headers: { 'x-forwarded-for': '192.0.2.90' },
      body: JSON.stringify({
        name: 'عميلة رحلة الاختبار',
        email: 'Journey@Example.com',
        whatsapp: '07712345678',
        service: 'design',
        budget: 'أحتاج توجيه',
        details: 'أحتاج هوية بصرية لمشروعي.',
        source: 'public-onboarding',
        website: ''
      })
    });
    const intakeBody = body(intake);
    assert.equal(intake.statusCode, 201);
    assert.ok(shared['hbpx-leads'][intakeBody.leadId]);
    assert.equal(shared['hbpx-leads'][intakeBody.leadId].status, 'new');

    const approval = await leadService.handler({
      httpMethod: 'PATCH',
      headers: { host: 'fabulous-bublanina-8d5626.netlify.app' },
      body: JSON.stringify({ id: intakeBody.leadId, status: 'approved' })
    });
    assert.equal(approval.statusCode, 200);
    assert.equal(body(approval).lead.status, 'approved');

    const accountService = loadHandler('../netlify/functions/client-auth', shared);
    const registration = await accountService.handler({
      httpMethod: 'POST',
      queryStringParameters: { action: 'register' },
      headers: { 'x-forwarded-for': '192.0.2.91' },
      body: JSON.stringify({
        name: 'عميلة رحلة الاختبار',
        email: 'journey@example.com',
        whatsapp: '+964 771 234 5678',
        password: 'customer-password-2026'
      })
    });
    const registrationBody = body(registration);
    const accountId = 'email-' + crypto.createHash('sha256').update('journey@example.com').digest('hex').slice(0, 48);

    assert.equal(registration.statusCode, 201);
    assert.equal(registrationBody.authenticated, true);
    assert.equal(registrationBody.client.id, accountId);
    assert.ok(shared['hbpx-client-accounts'][accountId]);
    assert.equal(shared['hbpx-leads'][intakeBody.leadId].status, 'approved');
    assert.equal(shared['hbpx-leads'][intakeBody.leadId].clientId, accountId);
    assert.ok(shared['hbpx-lead-index']['client-' + accountId + '-' + intakeBody.leadId]);
    assert.match(registration.headers['Set-Cookie'], /hbpx_client=session-/);
  } finally {
    if (originalSecret === undefined) delete process.env.CLIENT_SESSION_SECRET;
    else process.env.CLIENT_SESSION_SECRET = originalSecret;
    for (const key of notificationKeys) {
      if (oldNotifications[key] === undefined) delete process.env[key];
      else process.env[key] = oldNotifications[key];
    }
    global.fetch = originalFetch;
  }
});
