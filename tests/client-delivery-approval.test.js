'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function loadApproval(data) {
  const resolved = require.resolve('../netlify/functions/client-deliveries');
  delete require.cache[resolved];
  const originalLoad = Module._load;
  const activity = [];
  const blobs = {
    connectLambda() {},
    getStore({ name }) {
      const store = data[name] ||= {};
      return {
        async get(key) { return store[key] ?? null; },
        async setJSON(key, value) { store[key] = JSON.parse(JSON.stringify(value)); }
      };
    }
  };
  Module._load = function(request, parent, isMain) {
    if (parent && parent.filename === resolved && request === '@netlify/blobs') return blobs;
    if (parent && parent.filename === resolved && request === './auth-utils') return {
      json(statusCode, body) { return { statusCode, body: JSON.stringify(body) }; }
    };
    if (parent && parent.filename === resolved && request === './client-auth-utils') return {
      getClientSession(event) { return event.session || null; }
    };
    if (parent && parent.filename === resolved && request === './client-activity') return {
      async logActivity(clientId, type, label, details) { activity.push({ clientId, type, label, details }); }
    };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return { handler: require(resolved).handler, activity, data };
  } finally {
    Module._load = originalLoad;
    delete require.cache[resolved];
  }
}
function fixture() {
  return {
    'hbpx-client-accounts': {
      'acct-a': { id: 'acct-a', name: 'Client A', email: 'a@example.com', whatsapp: '9647700000000' },
      'acct-b': { id: 'acct-b', name: 'Client B', email: 'b@example.com', whatsapp: '9647711111111' }
    },
    'hbpx-leads': {
      'lead-a': { id: 'lead-a', email: 'a@example.com', whatsapp: '9647700000000' },
      'lead-b': { id: 'lead-b', email: 'b@example.com', whatsapp: '9647711111111' }
    },
    'hbpx-projects': {
      'project-a': { id: 'project-a', leadId: 'lead-a' },
      'project-b': { id: 'project-b', leadId: 'lead-b' }
    },
    'hbpx-deliveries': {
      'delivery-a': { id: 'delivery-a', projectId: 'project-a', stage: 'preview', status: 'ready', watermarked: true, lowResolution: true },
      'delivery-b': { id: 'delivery-b', projectId: 'project-b', stage: 'preview', status: 'ready', watermarked: true, lowResolution: true }
    }
  };
}

function body(response) { return JSON.parse(response.body || '{}'); }

test('customer can approve their own protected preview and the owner receives an internal activity', async () => {
  const data = fixture();
  const service = loadApproval(data);
  const response = await service.handler({
    httpMethod: 'POST',
    headers: {},
    session: { sub: 'acct-a' },
    body: JSON.stringify({ deliveryId: 'delivery-a', decision: 'approved', note: 'موافق على المحتوى' })
  });
  assert.equal(response.statusCode, 200);
  assert.equal(body(response).decision, 'approved');
  assert.equal(data['hbpx-deliveries']['delivery-a'].clientApproval.decision, 'approved');
  assert.equal(service.activity.length, 1);
  assert.equal(service.activity[0].clientId, 'acct-a');
});

test('customer cannot approve another account preview even with its real delivery ID', async () => {
  const data = fixture();
  const before = JSON.parse(JSON.stringify(data['hbpx-deliveries']['delivery-b']));
  const service = loadApproval(data);
  const response = await service.handler({
    httpMethod: 'POST',
    headers: {},
    session: { sub: 'acct-a' },
    body: JSON.stringify({ deliveryId: 'delivery-b', decision: 'approved' })
  });
  assert.equal(response.statusCode, 404);
  assert.deepEqual(data['hbpx-deliveries']['delivery-b'], before);
  assert.equal(service.activity.length, 0);
});

test('requesting changes requires an explanatory note and preserves preview for owner follow-up', async () => {
  const data = fixture();
  const service = loadApproval(data);
  const short = await service.handler({
    httpMethod: 'POST',
    session: { sub: 'acct-a' },
    headers: {},
    body: JSON.stringify({ deliveryId: 'delivery-a', decision: 'needs_changes', note: 'لا' })
  });
  assert.equal(short.statusCode, 400);
  const result = await service.handler({
    httpMethod: 'POST',
    session: { sub: 'acct-a' },
    headers: {},
    body: JSON.stringify({ deliveryId: 'delivery-a', decision: 'needs_changes', note: 'يرجى تعديل العنوان' })
  });
  assert.equal(result.statusCode, 200);
  assert.equal(data['hbpx-deliveries']['delivery-a'].clientApproval.decision, 'needs_changes');
});

test('a customer cannot record approval on a final delivery', async () => {
  const data = fixture();
  data['hbpx-deliveries']['delivery-a'].stage = 'final';
  const service = loadApproval(data);
  const response = await service.handler({
    httpMethod: 'POST',
    session: { sub: 'acct-a' },
    headers: {},
    body: JSON.stringify({ deliveryId: 'delivery-a', decision: 'approved' })
  });
  assert.equal(response.statusCode, 404);
  assert.equal(service.activity.length, 0);
});

test('a customer cannot reverse an approval on the same preview', async () => {
  const data = fixture();
  data['hbpx-deliveries']['delivery-a'].clientApproval = { decision: 'approved', at: '2026-11-06T12:00:00.000Z' };
  const service = loadApproval(data);
  const response = await service.handler({
    httpMethod: 'POST',
    session: { sub: 'acct-a' },
    headers: {},
    body: JSON.stringify({ deliveryId: 'delivery-a', decision: 'needs_changes', note: 'بدل رأيي' })
  });
  assert.equal(response.statusCode, 409);
  assert.equal(service.activity.length, 0);
});
