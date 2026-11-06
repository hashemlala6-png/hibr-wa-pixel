'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function loadEndpoint({ project, deliveries = [], authDenied = false }) {
  const resolved = require.resolve('../netlify/functions/project-finance');
  delete require.cache[resolved];
  const originalLoad = Module._load;
  const stores = {
    'hbpx-projects': { [project.id]: project },
    'hbpx-deliveries': Object.fromEntries(deliveries.map(item => [item.id, item]))
  };
  const blobs = {
    connectLambda() {},
    getStore({ name }) {
      return {
        async get(key) { return stores[name]?.[key] || null; },
        async list({ prefix = '', cursor } = {}) {
          const keys = Object.keys(stores[name] || {}).filter(key => key.startsWith(prefix));
          const offset = cursor ? Number(cursor) : 0;
          const page = keys.slice(offset, offset + 2).map(key => ({ key }));
          return { blobs: page, cursor: offset + 2 < keys.length ? String(offset + 2) : undefined };
        }
      };
    }
  };
  Module._load = function(request, parent, isMain) {
    if (request === '@netlify/blobs') return blobs;
    if (request === './auth-utils' && parent && parent.filename === resolved) return {
      requireAdmin() { return authDenied ? { statusCode: 401, body: '{}' } : null; },
      json(statusCode, body) { return { statusCode, body: JSON.stringify(body) }; }
    };
    if (request === './project-financials' && parent && parent.filename === resolved) return {
      async getProjectFinancials() {
        return {
          contractSigned: true, total: 100000, paid: 10000, remaining: 90000,
          depositRequired: 10000, depositMet: true, fullyPaid: false, paymentCount: 1
        };
      }
    };
    return originalLoad.call(this, request, parent, isMain);
  };
  try { return require(resolved).handler; }
  finally { Module._load = originalLoad; delete require.cache[resolved]; }
}
function body(response) { return JSON.parse(response.body || '{}'); }

test('project financial summary returns latest preview and next owner action from paginated deliveries', async () => {
  const handler = loadEndpoint({
    project: { id: 'project-a', name: 'حملة شهرية', amount: 100000 },
    deliveries: [
      { id: 'delivery-1', projectId: 'project-a', stage: 'preview', createdAt: '2026-11-01T10:00:00.000Z', title: 'قديم' },
      { id: 'delivery-2', projectId: 'project-a', stage: 'preview', createdAt: '2026-11-03T10:00:00.000Z', title: 'أحدث', clientApproval: { decision: 'approved' } },
      { id: 'delivery-other', projectId: 'project-b', stage: 'preview', createdAt: '2026-11-04T10:00:00.000Z' }
    ]
  });
  const result = await handler({ httpMethod: 'GET', headers: {}, queryStringParameters: { projectId: 'project-a' } });
  assert.equal(result.statusCode, 200);
  assert.equal(body(result).latestPreview.title, 'أحدث');
  assert.equal(body(result).latestPreviewApproval, 'approved');
  assert.equal(body(result).nextStep, 'balance');
  assert.equal(body(result).financial.remaining, 90000);
});

test('project financial summary rejects unauthenticated owners and unknown projects', async () => {
  const unauthorized = loadEndpoint({ project: { id: 'project-a' }, authDenied: true });
  const denied = await unauthorized({ httpMethod: 'GET', headers: {}, queryStringParameters: { projectId: 'project-a' } });
  assert.equal(denied.statusCode, 401);

  const missing = loadEndpoint({ project: { id: 'project-a' } });
  const notFound = await missing({ httpMethod: 'GET', headers: {}, queryStringParameters: { projectId: 'absent' } });
  assert.equal(notFound.statusCode, 404);
});
