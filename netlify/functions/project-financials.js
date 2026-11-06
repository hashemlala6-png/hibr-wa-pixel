'use strict';

const { getStore } = require('@netlify/blobs');
const { blobOptions } = require('./blob-config');

const amount = require('./money');

async function readAll(name, prefix) {
  const store = getStore(blobOptions(name, 'strong'));
  const page = await store.list({ prefix, limit: 1000 });
  const rows = [];
  for (const blob of page.blobs || []) {
    const record = await store.get(blob.key, { type: 'json' }).catch(() => null);
    if (record) rows.push(record);
  }
  return rows;
}

async function readProjectFinancialData() {
  const [payments, contracts] = await Promise.all([
    readAll('hbpx-payments', 'payment-'),
    readAll('hbpx-contracts', 'contract-')
  ]);
  return { payments, contracts };
}

async function getProjectFinancials(projectId, fallbackAmount = 0, financialData = null) {
  const id = String(projectId || '').trim();
  if (!id) throw new Error('Project ID is required for financial checks.');

  const data = financialData || await readProjectFinancialData();
  const payments = Array.isArray(data.payments) ? data.payments : [];
  const contracts = Array.isArray(data.contracts) ? data.contracts : [];
  const projectPayments = payments.filter(payment => payment.projectId === id);
  const signedContracts = contracts
    .filter(contract => contract.projectId === id && contract.status === 'signed' && contract.signedAt)
    .sort((a, b) => new Date(b.signedAt).getTime() - new Date(a.signedAt).getTime());
  const signedContract = signedContracts[0] || null;
  // Contract-bound payments cannot migrate to a later signed agreement.
  // Legacy rows without contractId remain credited only while one signed agreement exists.
  const matchingPayments = signedContract
    ? projectPayments.filter(payment => {
      const paymentContractId = String(payment.contractId || '').trim();
      return paymentContractId
        ? paymentContractId === String(signedContract.id || '')
        : signedContracts.length === 1;
    })
    : [];
  // Without a signed agreement, every receipt stays visible but cannot count toward a deposit or balance.
  const unallocatedPayments = projectPayments.filter(payment => !matchingPayments.includes(payment));
  const total = amount(signedContract?.amount) || amount(fallbackAmount);
  const paid = matchingPayments.reduce((sum, payment) => sum + amount(payment.amount), 0);
  const unallocatedPaid = unallocatedPayments.reduce((sum, payment) => sum + amount(payment.amount), 0);
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
    unallocatedPaid,
    unallocatedPaymentCount: unallocatedPayments.length,
    policySource: signedContract?.paymentPolicy ? 'signed-contract' : 'default-10-90'
  };
}

module.exports = { getProjectFinancials, readProjectFinancialData };
