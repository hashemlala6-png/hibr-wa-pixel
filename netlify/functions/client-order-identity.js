'use strict';

const { normalizeEmail, normalizePhoneForMatch } = require('./client-ownership');

/**
 * Preserve the account's full, canonical identity on every lead created by an
 * authenticated order. Customer grouping requires both email and WhatsApp.
 */
function attachClientOrderIdentity(lead, account) {
  const accountId = String(account?.id || '').trim();
  const email = normalizeEmail(account?.email);
  const whatsapp = normalizePhoneForMatch(account?.whatsapp);
  if (!accountId || !email || !whatsapp) {
    throw new TypeError('A client account with an ID, email, and WhatsApp number is required.');
  }
  return {
    ...lead,
    clientId: accountId,
    name: String(account?.name || lead?.name || '').trim(),
    email,
    whatsapp
  };
}

module.exports = { attachClientOrderIdentity };
