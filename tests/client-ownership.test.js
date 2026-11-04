'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizePhoneForMatch,
  sameClientContact,
  clientIdentityKey,
  ownsProject
} = require('../netlify/functions/client-ownership');

test('Iraqi WhatsApp variants normalize to the same canonical number', () => {
  const expected = '9647712345678';
  assert.equal(normalizePhoneForMatch('07712345678'), expected);
  assert.equal(normalizePhoneForMatch('+964 771 234 5678'), expected);
  assert.equal(normalizePhoneForMatch('00964-771-234-5678'), expected);
  assert.equal(normalizePhoneForMatch('9647712345678'), expected);
});

test('identity requires both matching email and matching WhatsApp', () => {
  const client = {email:'one@example.com', whatsapp:'07712345678'};
  assert.equal(sameClientContact(client, {email:' ONE@example.com ',whatsapp:'+9647712345678'}), true);
  assert.equal(sameClientContact(client, {email:'two@example.com',whatsapp:'07712345678'}), false);
  assert.equal(sameClientContact(client, {email:'one@example.com',whatsapp:'07799999999'}), false);
  assert.equal(sameClientContact(client, {email:'one@example.com'}), false);
});

test('same phone with different emails produces different identity keys', () => {
  const first = clientIdentityKey({id:'lead-1',email:'one@example.com',whatsapp:'07712345678'});
  const second = clientIdentityKey({id:'lead-2',email:'two@example.com',whatsapp:'07712345678'});
  assert.notEqual(first, second);
  assert.equal(first, clientIdentityKey({id:'lead-3',email:'ONE@example.com',whatsapp:'+9647712345678'}));
});

test('incomplete contact details do not merge two unrelated leads', () => {
  assert.notEqual(
    clientIdentityKey({id:'lead-a',whatsapp:'07712345678'}),
    clientIdentityKey({id:'lead-b',whatsapp:'07712345678'})
  );
  assert.notEqual(
    clientIdentityKey({id:'lead-a',email:'same@example.com'}),
    clientIdentityKey({id:'lead-b',email:'same@example.com'})
  );
});

test('legacy shared clientId alone never grants project access', () => {
  const account = {id:'email-account-a',clientId:'legacy-phone-group',email:'a@example.com',whatsapp:'07712345678'};
  const anotherProject = {clientId:'legacy-phone-group',accountId:'legacy-phone-group',clientEmail:'b@example.com'};
  assert.equal(ownsProject(anotherProject, account, {email:'b@example.com',whatsapp:'07712345678',clientId:'legacy-phone-group'}), false);
});

test('a project linked through an exact lead contact pair belongs to that account', () => {
  const account = {id:'email-account-a',email:'a@example.com',whatsapp:'07712345678'};
  const project = {id:'project-1',leadId:'lead-1',clientId:'legacy-phone-group'};
  assert.equal(ownsProject(project, account, {id:'lead-1',email:' A@example.com ',whatsapp:'+9647712345678'}), true);
});

test('unique account references and exact project contacts remain supported', () => {
  const account = {id:'account-a',email:'a@example.com',whatsapp:'07712345678'};
  assert.equal(ownsProject({accountId:'account-a'}, account), true);
  assert.equal(ownsProject({email:'A@example.com',whatsapp:'+9647712345678'}, account), true);
  assert.equal(ownsProject({clientId:'account-a'}, account), true);
});
