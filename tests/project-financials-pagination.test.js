'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

test('project financial totals read every storage cursor page', async () => {
  const resolved = require.resolve('../netlify/functions/project-financials');
  delete require.cache[resolved];
  const originalLoad = Module._load;
  const pages = {
    'hbpx-payments': [
      [{ key: 'payment-1' }, { key: 'payment-2' }],
      [{ key: 'payment-3' }]
    ],
    'hbpx-contracts': [
      [{ key: 'contract-1' }]
    ]
  };
  const records = {
    'payment-1': { id:'payment-1', projectId:'project-a', amount:1000 },
    'payment-2': { id:'payment-2', projectId:'project-a', amount:2000 },
    'payment-3': { id:'payment-3', projectId:'project-a', amount:7000 },
    'contract-1': { id:'contract-1', projectId:'project-a', amount:100000, status:'signed', signedAt:'2026-11-06T10:00:00.000Z' }
  };
  const cursors = { 'hbpx-payments': 0, 'hbpx-contracts': 0 };
  const blobs = {
    getStore({ name }) {
      return {
        async list({ cursor } = {}) {
          const index = cursor ? Number(cursor) : 0;
          const page = pages[name][index] || [];
          return { blobs: page, cursor: index + 1 < pages[name].length ? String(index + 1) : undefined };
        },
        async get(key) { return records[key] || null; }
      };
    }
  };
  Module._load = function(request, parent, isMain) {
    if (request === '@netlify/blobs' && parent && parent.filename === resolved) return blobs;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const { getProjectFinancials } = require(resolved);
    const result = await getProjectFinancials('project-a');
    assert.equal(result.paid, 10000);
    assert.equal(result.paymentCount, 3);
    assert.equal(result.depositMet, true);
    assert.equal(result.fullyPaid, false);
  } finally {
    Module._load = originalLoad;
    delete require.cache[resolved];
  }
});
