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

function countReceivedPayments(payments, projectId) {
  return payments
    .filter(p => p.projectId === projectId && ['received', 'paid', 'confirmed'].includes(String(p.status || 'received').toLowerCase()))
    .reduce((sum, p) => {
      const amount = Number(p.amount);
      return sum + (Number.isFinite(amount) && amount > 0 ? amount : 0);
    }, 0);
}

function canDownloadDelivery(accessLevel, fullyPaid) {
  const level = String(accessLevel || '').toLowerCase();
  return level === 'preview' || (level === 'final' && fullyPaid === true);
}

function latestSignedContract(projectId, contracts) {
  return (Array.isArray(contracts) ? contracts : [])
    .filter(item => item && item.projectId === projectId && item.status === 'signed' && item.signedAt)
    .slice()
    .sort((a, b) => (Date.parse(b.signedAt) || 0) - (Date.parse(a.signedAt) || 0))[0] || null;
}

function signedContractBlockReason(projectId, contracts, projectAmount) {
  const signed = latestSignedContract(projectId, contracts);
  if (!signed) return 'لا يمكن متابعة المشروع قبل توقيع العقد من العميل.';
  const amount = Number(signed.amount);
  if (!Number.isSafeInteger(amount) || amount <= 0) return 'قيمة العقد غير صالحة. حدّث العقد قبل المتابعة.';
  if (Number(projectAmount) !== amount) return 'قيمة العقد لا تطابق قيمة المشروع. صحّحي القيم قبل المتابعة.';
  const schedule = calculatePaymentSchedule(amount);
  if (!Number.isSafeInteger(Number(signed.depositAmount)) || Number(signed.depositAmount) !== schedule.depositAmount) return 'قيمة العربون في العقد غير مطابقة لنسبة 10%. صحّحي العقد قبل المتابعة.';
  if (!Number.isSafeInteger(Number(signed.balanceAmount)) || Number(signed.balanceAmount) !== schedule.balanceAmount) return 'قيمة الرصيد في العقد غير مطابقة لنسبة 90%. صحّحي العقد قبل المتابعة.';
  return null;
}

function activationBlockReason(projectId, contracts, payments, projectAmount) {
  const reason = signedContractBlockReason(projectId, contracts, projectAmount);
  if (reason) return reason;
  const signed = latestSignedContract(projectId, contracts);
  const schedule = calculatePaymentSchedule(Number(signed.amount));
  const paid = countReceivedPayments(payments, projectId);
  if (paid < schedule.depositAmount) return 'تم توقيع العقد، لكن لم يُسجّل استلام العربون كاملاً بعد. لا يمكن بدء التنفيذ.';
  return null;
}

module.exports = { calculatePaymentSchedule, countReceivedPayments, canDownloadDelivery, latestSignedContract, signedContractBlockReason, activationBlockReason };
