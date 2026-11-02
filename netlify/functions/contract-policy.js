'use strict';

function calculatePaymentSchedule(amount) {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new TypeError('amount must be a positive safe integer');
  }
  const depositAmount = Math.round(amount * 0.10);
  return {
    currency: 'IQD',
    depositRate: 10,
    balanceRate: 90,
    depositAmount,
    balanceAmount: amount - depositAmount,
    depositDue: 'عند التعاقد وقبل بدء التنفيذ',
    balanceDue: 'بعد موافقة العميل على المحتوى وقبل التسليم النهائي'
  };
}

function activationBlockReason(projectId, contracts, payments) {
  const signed = contracts.find(c => c.projectId === projectId && c.status === 'signed' && c.signedAt);
  if (!signed) return 'لا يمكن بدء المشروع قبل توقيع عقده من العميل.';
  const schedule = calculatePaymentSchedule(Number(signed.amount));
  const deposit = Number.isSafeInteger(signed.depositAmount) && signed.depositAmount >= 0
    ? signed.depositAmount : schedule.depositAmount;
  // Old payment rows were created only through the owner-authenticated manual recording endpoint.
  // New rows must explicitly carry the received state; pending/rejected rows never count.
  const paid = payments
    .filter(p => p.projectId === projectId && (!p.status || p.status === 'received'))
    .reduce((sum, p) => sum + (Number.isFinite(Number(p.amount)) ? Number(p.amount) : 0), 0);
  if (paid < deposit) return 'تم توقيع العقد، لكن لم يُسجّل استلام العربون كاملاً بعد. لا يمكن بدء التنفيذ.';
  return null;
}

module.exports = { calculatePaymentSchedule, activationBlockReason };
