'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const parseMoney = require('../netlify/functions/money');

test('money parser preserves decimal precision and valid thousands separators', () => {
  assert.equal(parseMoney(1250.75), 1250.75);
  assert.equal(parseMoney('1,250.75'), 1250.75);
  assert.equal(parseMoney('1250'), 1250);
});

test('money parser rejects negative, malformed, excessive precision, and non-finite values', () => {
  for (const value of ['-100', '-1,000.50', '1,00', '1.234', '12abc', '', null, Infinity, NaN]) {
    assert.equal(parseMoney(value), 0, String(value));
  }
});

function loadFinancials(data) {
  const resolved = require.resolve('../netlify/functions/project-financials');
  delete require.cache[resolved];
  const originalLoad = Module._load;
  const blobs = {
    getStore({ name }) {
      const rows = data[name] || {};
      return {
        async list({ prefix = '' } = {}) {
          return { blobs: Object.keys(rows).filter(key => key.startsWith(prefix)).map(key => ({ key })) };
        },
        async get(key) { return rows[key] || null; }
      };
    }
  };
  Module._load = function(request, parent, isMain) {
    if (request === '@netlify/blobs' && parent && parent.filename === resolved) return blobs;
    return originalLoad.call(this, request, parent, isMain);
  };
  try { return require(resolved).getProjectFinancials; }
  finally { Module._load = originalLoad; delete require.cache[resolved]; }
}

test('payments from an older signed agreement cannot satisfy the latest contract balance', async () => {
  const getProjectFinancials = loadFinancials({
    'hbpx-payments': {
      'payment-old': { id: 'payment-old', projectId: 'project-a', contractId: 'contract-old', amount: 100000 },
      'payment-legacy': { id: 'payment-legacy', projectId: 'project-a', amount: 5000 },
      'payment-current': { id: 'payment-current', projectId: 'project-a', contractId: 'contract-current', amount: 20000 }
    },
    'hbpx-contracts': {
      'contract-old': { id: 'contract-old', projectId: 'project-a', amount: 100000, status: 'signed', signedAt: '2026-10-01T10:00:00.000Z' },
      'contract-current': { id: 'contract-current', projectId: 'project-a', amount: 200000, status: 'signed', signedAt: '2026-11-06T10:00:00.000Z' }
    }
  });
  const result = await getProjectFinancials('project-a', 200000);
  assert.equal(result.contractId, 'contract-current');
  assert.equal(result.total, 200000);
  assert.equal(result.paid, 20000);
  assert.equal(result.remaining, 180000);
  assert.equal(result.depositMet, true);
  assert.equal(result.fullyPaid, false);
  assert.equal(result.unallocatedPaid, 105000);
  assert.equal(result.unallocatedPaymentCount, 2);
});

test('legacy unlinked payments remain credited when there is exactly one signed agreement', async () => {
  const getProjectFinancials = loadFinancials({
    'hbpx-payments': {
      'payment-legacy': { id: 'payment-legacy', projectId: 'project-a', amount: 10000 },
      'payment-bound': { id: 'payment-bound', projectId: 'project-a', contractId: 'contract-a', amount: 2500 }
    },
    'hbpx-contracts': {
      'contract-a': { id: 'contract-a', projectId: 'project-a', amount: 100000, status: 'signed', signedAt: '2026-11-06T10:00:00.000Z' }
    }
  });
  const result = await getProjectFinancials('project-a', 100000);
  assert.equal(result.paid, 12500);
  assert.equal(result.unallocatedPaid, 0);
  assert.equal(result.paymentCount, 2);
});

test('a draft contract does not displace legacy payments from the sole signed agreement', async () => {
  const getProjectFinancials = loadFinancials({
    'hbpx-payments': {
      'payment-legacy': { id: 'payment-legacy', projectId: 'project-a', amount: 10000 }
    },
    'hbpx-contracts': {
      'contract-a': { id: 'contract-a', projectId: 'project-a', amount: 100000, status: 'signed', signedAt: '2026-11-05T10:00:00.000Z' },
      'contract-draft': { id: 'contract-draft', projectId: 'project-a', amount: 125000, status: 'draft' }
    }
  });
  const result = await getProjectFinancials('project-a', 100000);
  assert.equal(result.contractId, 'contract-a');
  assert.equal(result.paid, 10000);
  assert.equal(result.unallocatedPaid, 0);
});
