'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { calculatePaymentSchedule, activationBlockReason } = require('../netlify/functions/contract-policy');

test('calculates exact 10/90 split for IQD amounts', () => {
  const p = calculatePaymentSchedule(100000);
  assert.equal(p.depositAmount, 10000);
  assert.equal(p.balanceAmount, 90000);
  assert.equal(p.depositAmount + p.balanceAmount, 100000);
});

test('keeps total exact when 10 percent requires rounding', () => {
  const p = calculatePaymentSchedule(100001);
  assert.equal(p.depositAmount, 10000);
  assert.equal(p.balanceAmount, 90001);
  assert.equal(p.depositAmount + p.balanceAmount, 100001);
});

test('rejects zero, negative, fractional and unsafe amounts', () => {
  for (const amount of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => calculatePaymentSchedule(amount), TypeError);
  }
});

test('blocks activation if no signed contract exists', () => {
  assert.match(activationBlockReason('p1', [], []), /توقيع عقده/);
});

test('blocks activation if contract is signed but deposit is missing', () => {
  const contracts = [{ projectId: 'p1', status: 'signed', signedAt: '2026-01-01', amount: 100000 }];
  assert.match(activationBlockReason('p1', contracts, []), /العربون كاملاً/);
});

test('blocks activation if recorded deposit is short', () => {
  const contracts = [{ projectId: 'p1', status: 'signed', signedAt: '2026-01-01', amount: 100000 }];
  const payments = [{ projectId: 'p1', amount: 9999 }];
  assert.match(activationBlockReason('p1', contracts, payments), /العربون كاملاً/);
});

test('allows activation only after the full deposit is recorded', () => {
  const contracts = [{ projectId: 'p1', status: 'signed', signedAt: '2026-01-01', amount: 100000 }];
  const payments = [{ projectId: 'p1', amount: 6000 }, { projectId: 'p1', amount: 4000 }];
  assert.equal(activationBlockReason('p1', contracts, payments), null);
});

test('ignores payments belonging to other projects', () => {
  const contracts = [{ projectId: 'p1', status: 'signed', signedAt: '2026-01-01', amount: 100000 }];
  const payments = [{ projectId: 'p2', amount: 10000 }];
  assert.match(activationBlockReason('p1', contracts, payments), /العربون كاملاً/);
});
