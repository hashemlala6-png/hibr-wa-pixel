'use strict';

const { clientIdentityKey } = require('./client-ownership');

/**
 * Build a fail-closed map from exact contact-pair identity to account ID.
 * When multiple accounts share the same normalized pair, the map stores null
 * so a lead is not silently assigned to whichever account happened to load last.
 */
function buildUniqueAccountPairMap(accounts = []) {
  const matches = new Map();
  for (const account of Array.isArray(accounts) ? accounts : []) {
    const accountId = String(account?.id || '').trim();
    if (!accountId) continue;
    const pairKey = clientIdentityKey(account);
    if (!pairKey || pairKey.startsWith('lead-')) continue;
    if (matches.has(pairKey)) {
      matches.set(pairKey, null);
    } else {
      matches.set(pairKey, accountId);
    }
  }
  return matches;
}

/**
 * Return a unique account ID only for an unambiguous exact pair.
 * Ambiguous or unregistered leads keep their pair-specific identity key.
 */
function resolveLeadAccountId(lead, accountPairMap) {
  const pairKey = clientIdentityKey(lead);
  const accountId = accountPairMap instanceof Map ? accountPairMap.get(pairKey) : null;
  return accountId || pairKey;
}

module.exports = { buildUniqueAccountPairMap, resolveLeadAccountId };
