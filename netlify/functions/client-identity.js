'use strict';

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeIraqiPhone(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('00964')) digits = digits.slice(5);
  else if (digits.startsWith('964')) digits = digits.slice(3);
  else if (digits.startsWith('0')) digits = digits.slice(1);
  return digits;
}

function sameClientIdentity(left, right) {
  const leftEmail = normalizeEmail(left?.email);
  const rightEmail = normalizeEmail(right?.email);
  const leftPhone = normalizeIraqiPhone(left?.whatsapp || left?.phone);
  const rightPhone = normalizeIraqiPhone(right?.whatsapp || right?.phone);
  return Boolean(leftEmail && rightEmail && leftPhone && rightPhone
    && leftEmail === rightEmail && leftPhone === rightPhone);
}

module.exports = { normalizeEmail, normalizeIraqiPhone, sameClientIdentity };
