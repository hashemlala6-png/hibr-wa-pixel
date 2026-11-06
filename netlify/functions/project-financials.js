'use strict';

const { getStore } = require('@netlify/blobs');

const amount = value => {
  const parsed = Number(String(value == null ? '' : value).replace(/[^0-9.]/g, ''));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

async function readAll(name, prefix) {
  const store = getStore({ name, consistency: 'strong' });
  const rows = [];
  let cursor;
  do {
    const page = await store.list({ prefix, limit: 100, cursor });
    for (const blob of page.blobs || []) {
      const record = await store.get(blob.key, { type: 'json' }).catch(() => null);
      if (record) rows.push(record);
    }
    cursor = page.cursor;
  } while (cursor);
  return rows;
}

async function getProjectFinancials(projectId, fallbackAmount = 0) {
  const id = String(projectId || '').trim();
  if (!id) throw new Error('Project ID is required for financial checks.');

  const [payments, contracts] = await Promise.all([
    readAll('hbpx-payments', 'payment-'),
    readAll('hbpx-contracts', 'contract-')
  ]);
  const matchingPayments = payments.filter(payment => payment.projectId === id);
  const matchingContracts = contracts
    .filter(contract => contract.projectId === id && contract.status === 'signed' && contract.signedAt)
    .sort((a, b) => new Date(b.signedAt).getTime() - new Date(a.signedAt).getTime());
  const signedContract = matchingContracts[0] || null;
  const total = amount(signedContract?.amount) || amount(fallbackAmount);
  const paid = matchingPayments.reduce((sum, payment) => sum + amount(payment.amount), 0);
  const depositRequired = total > 0 ? Math.ceil(total * 0.10) : 0;
  const remaining = Math.max(total - paid, 0);

  return {
    projectId: id,
    contractSigned: Boolean(signedContract),
    contractId: signedContract?.id || null,
    total,
    paid,
    remaining,
    depositPercent: 10,
    balancePercent: 90,
    depositRequired,
    depositMet: Boolean(signedContract && total > 0 && paid >= depositRequired),
    fullyPaid: Boolean(signedContract && total > 0 && paid >= total),
    paymentCount: matchingPayments.length,
    policySource: signedContract?.paymentPolicy ? 'signed-contract' : 'default-10-90'
  };
}

module.exports = { getProjectFinancials };
