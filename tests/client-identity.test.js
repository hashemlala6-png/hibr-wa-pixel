'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {normalizeEmail,normalizeIraqiPhone,sameClientIdentity}=require('../netlify/functions/client-identity');

test('normalizes Iraqi mobile numbers with local, country-code and international prefixes',()=>{
  const expected='7721971156';
  assert.equal(normalizeIraqiPhone('0772 197 1156'),expected);
  assert.equal(normalizeIraqiPhone('+964 772 197 1156'),expected);
  assert.equal(normalizeIraqiPhone('00964 772 197 1156'),expected);
  assert.equal(normalizeIraqiPhone('9647721971156'),expected);
});

test('normalizes email casing and surrounding whitespace',()=>{
  assert.equal(normalizeEmail(' Owner@Example.com '),'owner@example.com');
});

test('requires both email and WhatsApp to match before reusing a client identity',()=>{
  const current={email:'owner@example.com',whatsapp:'0772 197 1156'};
  assert.equal(sameClientIdentity(current,{email:'OWNER@example.com',whatsapp:'+9647721971156'}),true);
  assert.equal(sameClientIdentity(current,{email:'owner@example.com',whatsapp:'0780 000 0000'}),false);
  assert.equal(sameClientIdentity(current,{email:'other@example.com',whatsapp:'0772 197 1156'}),false);
});

test('does not match identities with missing email or phone',()=>{
  assert.equal(sameClientIdentity({email:'',whatsapp:'07721971156'},{email:'',whatsapp:'07721971156'}),false);
  assert.equal(sameClientIdentity({email:'owner@example.com',whatsapp:''},{email:'owner@example.com',whatsapp:''}),false);
  assert.equal(sameClientIdentity(null,{email:'owner@example.com',whatsapp:'07721971156'}),false);
});
