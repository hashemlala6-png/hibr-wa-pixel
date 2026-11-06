'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

async function attemptPublish(item) {
  const resolved = require.resolve('../netlify/functions/instagram-publish');
  delete require.cache[resolved];
  const originalLoad = Module._load;
  const accessedStores = [];
  const data = { 'hbpx-instagram-content': { [item.id]: clone(item) } };
  const blobs = {
    connectLambda() {},
    getStore({ name }) {
      accessedStores.push(name);
      if (!data[name]) data[name] = {};
      return {
        async get(key) { return clone(data[name][key] ?? null); },
        async setJSON(key, value) { data[name][key] = clone(value); },
        async getWithMetadata() { throw new Error('Publish lock must not be accessed for blocked items'); }
      };
    }
  };

  Module._load = function(request, parent, isMain) {
    if (request === '@netlify/blobs') return blobs;
    if (request === './auth-utils' && parent && parent.filename === resolved) {
      return {
        requireAdmin() { return null; },
        json(statusCode, payload, headers = {}) {
          return { statusCode, body: JSON.stringify(payload), headers };
        }
      };
    }
    if (request === './env' && parent && parent.filename === resolved) return { env() { return undefined; } };
    return originalLoad.call(this, request, parent, isMain);
  };

  let handler;
  try {
    handler = require(resolved).handler;
  } finally {
    Module._load = originalLoad;
    delete require.cache[resolved];
  }

  const originalFetch = global.fetch;
  let externalCalls = 0;
  global.fetch = async () => { externalCalls++; throw new Error('Blocked publish guard must not call Meta'); };
  try {
    const response = await handler({
      httpMethod: 'POST',
      headers: { host: 'fabulous-bublanina-8d5626.netlify.app' },
      body: JSON.stringify({ id: item.id, action: 'start' })
    });
    return { response, body: JSON.parse(response.body || '{}'), externalCalls, accessedStores };
  } finally {
    global.fetch = originalFetch;
  }
}

test('Instagram publishing stops before Meta unless owner approval is complete and the item is not already published', async t => {
  const approvedBase = {
    id: 'post-guard-test',
    status: 'approved',
    approvedAt: new Date().toISOString(),
    approvedBy: 'owner',
    format: 'IMAGE',
    caption: 'Test caption',
    mediaUrls: ['https://cdn.example.com/test.jpg']
  };
  const cases = [
    {
      name: 'draft awaiting approval',
      item: { ...approvedBase, status: 'pending_approval', approvedAt: null, approvedBy: null },
      statusCode: 409
    },
    {
      name: 'approved status without owner approval stamp',
      item: { ...approvedBase, approvedBy: null },
      statusCode: 409
    },
    {
      name: 'already published item',
      item: { ...approvedBase, publishStatus: 'published', publishedAt: new Date().toISOString() },
      statusCode: 409
    },
    {
      name: 'publish already in progress',
      item: { ...approvedBase, publishStatus: 'publishing' },
      statusCode: 409
    },
    {
      name: 'uncertain provider outcome',
      item: { ...approvedBase, publishStatus: 'publish_uncertain' },
      statusCode: 409
    }
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const result = await attemptPublish(scenario.item);
      assert.equal(result.response.statusCode, scenario.statusCode);
      assert.equal(result.externalCalls, 0);
      assert.deepEqual(result.accessedStores, ['hbpx-instagram-content']);
    });
  }
});
