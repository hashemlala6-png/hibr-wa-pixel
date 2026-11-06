'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function loadSales() {
  const resolved = require.resolve('../netlify/functions/sales');
  delete require.cache[resolved];
  const originalLoad = Module._load;
  const stores = {
    'hbpx-projects': { 'project-a': { id: 'project-a', leadId: 'lead-a', status: 'planned', amount: 100000 } },
    'hbpx-contracts': { 'contract-a': { id:'contract-a', projectId:'project-a', amount:100000, status:'signed', signedAt:'2026-11-06T10:00:00.000Z' } },
    'hbpx-deliveries': { 'delivery-preview': { id:'delivery-preview', projectId:'project-a', stage:'preview', status:'ready', createdAt:'2026-11-06T11:00:00.000Z', clientApproval:{decision:'approved'} } },
    'hbpx-leads': { 'lead-a': { id: 'lead-a', email: 'client@example.com', whatsapp: '9647700000000' } },
    'hbpx-client-accounts': {},
    'hbpx-payments': {}
  };
  const blobs = {
    connectLambda() {},
    getStore({ name }) {
      stores[name] ||= {};
      const data = stores[name];
      return {
        async list({ prefix = '' } = {}) { return { blobs: Object.keys(data).filter(key => key.startsWith(prefix)).map(key => ({ key })) }; },
        async get(key) { return data[key] ?? null; },
        async setJSON(key, value) { data[key] = value; }
      };
    }
  };
  Module._load = function(request, parent, isMain) {
    if (request === '@netlify/blobs') return blobs;
    if (request === './auth-utils' && parent && parent.filename === resolved) return {
      requireAdmin() { return null; },
      json(statusCode, body) { return { statusCode, body: JSON.stringify(body) }; }
    };
    if (request === './client-activity' && parent && parent.filename === resolved) return { async logActivity() {} };
    return originalLoad.call(this, request, parent, isMain);
  };
  try { return { handler: require(resolved).handler, stores }; }
  finally { Module._load = originalLoad; delete require.cache[resolved]; }
}

function body(response) { return JSON.parse(response.body || '{}'); }

test('sales refuses to mark a payment as received unless the owner explicitly confirms receipt', async () => {
  const service = loadSales();
  const response = await service.handler({
    httpMethod: 'POST',
    body: JSON.stringify({ type: 'payment', projectId: 'project-a', amount: 1000, method: 'cash' })
  });
  assert.equal(response.statusCode, 400);
  assert.match(body(response).error, /استُلم فعلاً/);
  assert.equal(Object.keys(service.stores['hbpx-payments']).length, 0);
});

test('sales stores an owner-confirmed receipt as a recorded payment and not an online charge', async () => {
  const service = loadSales();
  const response = await service.handler({
    httpMethod: 'POST',
    body: JSON.stringify({ type: 'payment', projectId: 'project-a', amount: 1000, method: 'cash', note: 'وصل نقداً', receivedConfirmed: true })
  });
  const item = body(response).item;
  assert.equal(response.statusCode, 201);
  assert.equal(item.ownerConfirmedReceived, true);
  assert.equal(item.recordedBy, 'owner');
  assert.equal(item.amount, 1000);
  assert.equal(item.method, 'cash');
  assert.ok(item.receivedConfirmedAt);
});
