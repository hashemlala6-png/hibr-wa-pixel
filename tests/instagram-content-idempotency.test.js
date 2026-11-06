'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function loadContent() {
  const resolved = require.resolve('../netlify/functions/instagram-content');
  delete require.cache[resolved];
  const originalLoad = Module._load;
  const stores = {};
  const writes = [];
  const blobs = {
    connectLambda() {},
    getStore({ name }) {
      stores[name] ||= {};
      return {
        async list({ prefix = '' } = {}) {
          return { blobs: Object.keys(stores[name]).filter(key => key.startsWith(prefix)).map(key => ({ key })) };
        },
        async get(key) { return stores[name][key] ?? null; },
        async setJSON(key, value) { stores[name][key] = value; writes.push({ name, key, value }); },
        async delete(key) { delete stores[name][key]; }
      };
    }
  };
  Module._load = function(request, parent, isMain) {
    if (parent && parent.filename === resolved && request === '@netlify/blobs') return blobs;
    if (parent && parent.filename === resolved && request === './auth-utils') {
      return { requireAdmin() { return null; }, json(statusCode, body) { return { statusCode, body: JSON.stringify(body) }; } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return { handler: require(resolved).handler, stores, writes };
  } finally {
    Module._load = originalLoad;
    delete require.cache[resolved];
  }
}

function body(response) { return JSON.parse(response.body || '{}'); }
const payload = clientRequestId => ({
  clientRequestId,
  title: 'حملة تعريفية',
  caption: 'نص عربي تجريبي للمسودة',
  format: 'CAROUSEL',
  mediaUrls: ['https://res.cloudinary.com/demo/image/upload/slide1.jpg', 'https://res.cloudinary.com/demo/image/upload/slide2.jpg'],
  source: 'ai-studio',
  clientId: 'client-a'
});

test('repeated carousel draft save requests with the same idempotency key return one stored draft', async () => {
  const service = loadContent();
  const event = { httpMethod: 'POST', headers: {}, body: JSON.stringify(payload('ai-carousel-request-20261106-abc123xyz')) };
  const first = await service.handler(event);
  const second = await service.handler({ ...event, body: JSON.stringify({ ...payload('ai-carousel-request-20261106-abc123xyz'), title: 'عنوان معدل بعد انتهاء المهلة' }) });
  const a = body(first), b = body(second);
  assert.equal(first.statusCode, 201);
  assert.equal(second.statusCode, 200);
  assert.equal(a.item.id, b.item.id);
  assert.equal(b.duplicate, true);
  assert.equal(b.item.title, 'حملة تعريفية');
  assert.equal(service.writes.length, 1);
});

test('invalid idempotency keys are rejected before creating a draft', async () => {
  const service = loadContent();
  const result = await service.handler({
    httpMethod: 'POST',
    headers: {},
    body: JSON.stringify(payload('short'))
  });
  assert.equal(result.statusCode, 400);
  assert.equal(service.writes.length, 0);
});

test('requests without an idempotency key keep the normal unique-draft behavior', async () => {
  const service = loadContent();
  const item = payload(undefined);
  const first = await service.handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify(item) });
  const second = await service.handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify(item) });
  assert.equal(first.statusCode, 201);
  assert.equal(second.statusCode, 201);
  assert.notEqual(body(first).item.id, body(second).item.id);
});
