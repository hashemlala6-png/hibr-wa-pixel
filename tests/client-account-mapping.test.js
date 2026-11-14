'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildUniqueAccountPairMap,
  resolveLeadAccountId
} = require('../netlify/functions/client-account-mapping');
const { clientIdentityKey } = require('../netlify/functions/client-ownership');

test('a lead attaches to the single account matching both normalized contacts', () => {
  const accounts = [
    {id:'account-a',email:' A@example.com ',whatsapp:'+964 771 234 5678'},
    {id:'account-b',email:'b@example.com',whatsapp:'07799999999'}
  ];
  const map = buildUniqueAccountPairMap(accounts);
  const lead = {id:'lead-a',email:'a@example.com',whatsapp:'07712345678'};
  assert.equal(resolveLeadAccountId(lead,map),'account-a');
});

test('duplicate accounts for the same exact contact pair do not claim a lead', () => {
  const pair = {email:'same@example.com',whatsapp:'07712345678'};
  const accounts = [
    {id:'account-a',...pair},
    {id:'account-b',...pair}
  ];
  const map = buildUniqueAccountPairMap(accounts);
  const lead = {id:'lead-same',...pair};
  assert.equal(map.get(clientIdentityKey(lead)),null);
  assert.equal(resolveLeadAccountId(lead,map),clientIdentityKey(lead));
  assert.notEqual(resolveLeadAccountId(lead,map),'account-a');
  assert.notEqual(resolveLeadAccountId(lead,map),'account-b');
});

test('accounts sharing a phone but using different emails remain isolated', () => {
  const accounts = [
    {id:'account-a',email:'a@example.com',whatsapp:'07712345678'},
    {id:'account-b',email:'b@example.com',whatsapp:'07712345678'}
  ];
  const map = buildUniqueAccountPairMap(accounts);
  assert.equal(resolveLeadAccountId(
    {id:'lead-a',email:'a@example.com',whatsapp:'+9647712345678'},map
  ),'account-a');
  assert.equal(resolveLeadAccountId(
    {id:'lead-b',email:'b@example.com',whatsapp:'07712345678'},map
  ),'account-b');
});

test('incomplete account contacts cannot claim leads through a partial match', () => {
  const accounts = [{id:'account-a',email:'a@example.com'}];
  const lead = {id:'lead-a',email:'a@example.com'};
  const map = buildUniqueAccountPairMap(accounts);
  assert.equal(resolveLeadAccountId(lead,map),'lead-lead-a');
});
