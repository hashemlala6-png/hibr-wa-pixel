'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function loadSales(data) {
  const financialsResolved = require.resolve('../netlify/functions/project-financials');
  delete require.cache[financialsResolved];
  const resolved = require.resolve('../netlify/functions/sales');
  delete require.cache[resolved];
  const originalLoad = Module._load;
  const writes = [];
  const activity = [];
  const stores = data;
  const blobs = {
    connectLambda() {},
    getStore({ name }) {
      if (!stores[name]) stores[name] = {};
      const store = stores[name];
      return {
        async list({ prefix = '' } = {}) {
          return { blobs: Object.keys(store).filter(key => key.startsWith(prefix)).map(key => ({ key })) };
        },
        async get(key) { return stores[name][key] ?? null; },
        async setJSON(key, value) { stores[name][key] = JSON.parse(JSON.stringify(value)); writes.push({ name, key, value }); },
        async delete(key) { delete stores[name][key]; }
      };
    }
  };
  Module._load = function(request, parent, isMain) {
    if (request === '@netlify/blobs') return blobs;
    if (request === './auth-utils' && parent && parent.filename === resolved) {
      return { requireAdmin() { return null; }, json(statusCode, payload) { return { statusCode, body: JSON.stringify(payload) }; } };
    }
    if (request === './client-activity' && parent && parent.filename === resolved) {
      return { async logActivity(clientId, type, label, details) { activity.push({ clientId, type, label, details }); } };
    }
    if (request === './env' && parent && parent.filename === resolved) return { env() { return 'test'; } };
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return { handler: require(resolved).handler, writes, activity, stores };
  } finally {
    Module._load = originalLoad;
    delete require.cache[resolved];
  }
}
function body(response) { return JSON.parse(response.body || '{}'); }
function fixture({ contract = null, paid = 0, projectAmount = 100000 } = {}) {
  const data = {
    'hbpx-projects': { 'project-a': { id: 'project-a', leadId: 'lead-a', clientId: 'lead-identity', name: 'Project A', amount: projectAmount, status: 'planned' } },
    'hbpx-leads': { 'lead-a': { id: 'lead-a', email: 'a@example.com', whatsapp: '9647700000000' } },
    'hbpx-client-accounts': {},
    'hbpx-payments': {},
    'hbpx-quotes': {},
    'hbpx-contracts': {}
  };
  if (contract) data['hbpx-contracts']['contract-a'] = { id: 'contract-a', projectId: 'project-a', amount: projectAmount, status: 'signed', signedAt: '2026-11-06T10:00:00.000Z', ...contract };
  if (paid > 0) data['hbpx-payments']['payment-a'] = { id: 'payment-a', projectId: 'project-a', amount: paid, createdAt: '2026-11-06T11:00:00.000Z' };
  return data;
}

test('project cannot move to active before the customer signs a contract', async () => {
  const service = loadSales(fixture({ paid: 20000 }));
  const response = await service.handler({
    httpMethod: 'PATCH',
    body: JSON.stringify({ collection: 'projects', id: 'project-a', status: 'active' })
  });
  assert.equal(response.statusCode, 409);
  assert.match(body(response).error, /توقيع عقد/);
  assert.equal(service.stores['hbpx-projects']['project-a'].status, 'planned');
  assert.equal(service.writes.length, 0);
});

test('project cannot move to active when recorded payments are below the 10 percent deposit', async () => {
  const service = loadSales(fixture({ contract: {}, paid: 9999 }));
  const response = await service.handler({
    httpMethod: 'PATCH',
    body: JSON.stringify({ collection: 'projects', id: 'project-a', status: 'active' })
  });
  assert.equal(response.statusCode, 409);
  assert.match(body(response).error, /عربون 10%/);
  assert.equal(body(response).financial.depositRequired, 10000);
  assert.equal(body(response).financial.paid, 9999);
  assert.equal(service.stores['hbpx-projects']['project-a'].status, 'planned');
  assert.equal(service.writes.length, 0);
});

test('signed contract and full 10 percent deposit allow project activation', async () => {
  const service = loadSales(fixture({ contract: {}, paid: 10000 }));
  const response = await service.handler({
    httpMethod: 'PATCH',
    body: JSON.stringify({ collection: 'projects', id: 'project-a', status: 'active' })
  });
  assert.equal(response.statusCode, 200);
  assert.equal(service.stores['hbpx-projects']['project-a'].status, 'active');
  assert.equal(service.activity.length, 1);
});

test('new projects cannot bypass contract and deposit gates by requesting active at creation', async () => {
  const service = loadSales(fixture());
  const response = await service.handler({
    httpMethod: 'POST',
    body: JSON.stringify({ type: 'project', leadId: 'lead-a', name: 'Project B', amount: 5000, status: 'active' })
  });
  assert.equal(response.statusCode, 201);
  assert.equal(body(response).item.status, 'planned');
});
