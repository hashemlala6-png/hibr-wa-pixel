'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { attachClientOrderIdentity } = require('../netlify/functions/client-order-identity');
const { clientIdentityKey, sameClientContact } = require('../netlify/functions/client-ownership');

test('authenticated order leads retain the account email and canonical WhatsApp pair', () => {
  const account = {
    id: 'email-account-a',
    name: 'Client A',
    email: ' CLIENT@example.com ',
    whatsapp: '07712345678'
  };
  const lead = attachClientOrderIdentity({
    id: 'lead-order-a',
    activity: 'تصميم',
    status: 'new'
  }, account);

  assert.equal(lead.clientId, account.id);
  assert.equal(lead.email, 'client@example.com');
  assert.equal(lead.whatsapp, '9647712345678');
  assert.equal(lead.name, 'Client A');
  assert.equal(clientIdentityKey(lead), clientIdentityKey(account));
  assert.equal(sameClientContact(lead, account), true);
});

test('reused authenticated leads replace stale partial identity without losing history', () => {
  const account = {
    id: 'email-account-b',
    name: 'Client B',
    email: 'b@example.com',
    whatsapp: '+964 771 234 5678'
  };
  const previous = {
    id: 'lead-old',
    clientId: 'legacy-phone-group',
    name: 'Old name',
    whatsapp: '07799999999',
    activity: 'قديم',
    createdAt: '2026-01-01T00:00:00.000Z'
  };
  const lead = attachClientOrderIdentity(previous, account);

  assert.equal(lead.clientId, account.id);
  assert.equal(lead.email, account.email);
  assert.equal(lead.whatsapp, '9647712345678');
  assert.equal(lead.createdAt, previous.createdAt);
  assert.equal(lead.activity, previous.activity);
  assert.equal(clientIdentityKey(lead), clientIdentityKey(account));
});

test('authenticated order identity rejects incomplete account contact data', () => {
  assert.throws(
    () => attachClientOrderIdentity({id:'lead-x'}, {id:'account-x',email:'x@example.com'}),
    /ID, email, and WhatsApp/
  );
});
