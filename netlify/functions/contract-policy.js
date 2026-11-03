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

function activationBlockReason(projectId, contracts, payments, projectAmount) {
  const signed = contracts.find(c => c.projectId === projectId && c.status === 'signed' && c.signedAt);
  if (!signed) return 'لا يمكن بدء المشروع قبل توقيع عقده من العميل.';
  const amount = Number(signed.amount);
  if (!Number.isSafeInteger(amount) || amount <= 0) return 'قيمة العقد غير صالحة. حدّث العقد قبل بدء التنفيذ.';
  if (Number(projectAmount) !== amount) return 'قيمة العقد لا تطابق قيمة المشروع. صحّحي القيم قبل بدء التنفيذ.';
  const schedule = calculatePaymentSchedule(amount);
  if (!Number.isSafeInteger(Number(signed.depositAmount)) || Number(signed.depositAmount) !== schedule.depositAmount) return 'قيمة العربون في العقد غير مطابقة لنسبة 10%. صحّحي العقد قبل بدء التنفيذ.';
  const paid = countReceivedPayments(payments, projectId);
  if (paid < schedule.depositAmount) return 'تم توقيع العقد، لكن لم يُسجّل استلام العربون كاملاً بعد. لا يمكن بدء التنفيذ.';
  return null;
}

module.exports = { calculatePaymentSchedule, countReceivedPayments, canDownloadDelivery, activationBlockReason };
