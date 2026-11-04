'use strict';

const crypto = require('crypto');

function normalizeEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

// Canonical Iraqi phone representation for identity comparisons and WhatsApp API recipients.
function normalizePhoneForMatch(value) {
  let digits = String(value ?? '').replace(/\D/g, '');
  if (digits.startsWith('00964')) digits = '964' + digits.slice(5);
  if (digits.startsWith('964')) {
    let national = digits.slice(3);
    if (national.startsWith('0')) national = national.slice(1);
    return '964' + national;
  }
  if (digits.startsWith('0')) return '964' + digits.slice(1);
  if (digits.length === 10) return '964' + digits;
  return digits;
}

function contactEmail(record) {
  return normalizeEmail(record?.email || record?.clientEmail || '');
}

function contactPhone(record) {
  return normalizePhoneForMatch(record?.whatsapp || record?.phone || record?.clientWhatsapp || '');
}

// A shared identity is valid only when BOTH verified contact fields match.
function sameClientContact(left, right) {
  const leftEmail = contactEmail(left);
  const rightEmail = contactEmail(right);
  const leftPhone = contactPhone(left);
  const rightPhone = contactPhone(right);
  return Boolean(leftEmail && rightEmail && leftPhone && rightPhone &&
    leftEmail === rightEmail && leftPhone === rightPhone);
}

function clientIdentityKey(record) {
  const email = contactEmail(record);
  const phone = contactPhone(record);
  if (email && phone) {
    const digest = crypto.createHash('sha256').update(email + '\n' + phone).digest('hex').slice(0, 24);
    return 'client-' + digest;
  }
  // Missing one identity field? Do not merge by phone or email alone.
  const leadId = String(record?.id || '').trim();
  return 'lead-' + (leadId || crypto.randomBytes(12).toString('hex'));
}

function ownsProject(project, account, lead = null) {
  const accountId = String(account?.id || '').trim();
  if (!accountId || !project) return false;

  // A linked lead is the strongest legacy ownership reference. It must match BOTH contacts;
  // a stale/shared clientId must never override a different linked lead.
  if (String(project.leadId || '').trim()) {
    return sameClientContact(lead, account) || sameClientContact(project, account);
  }

  // Projects without a lead link require either a unique account ID or both exact contacts.
  if (String(project.accountId || '') === accountId) return true;
  if (String(project.clientId || '') === accountId) return true;
  return sameClientContact(project, account);
}

module.exports = {
  normalizeEmail,
  normalizePhoneForMatch,
  sameClientContact,
  clientIdentityKey,
  ownsProject
};
