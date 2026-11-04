'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {projectBelongsToAccount}=require('../netlify/functions/client-project-access');

test('matches project by client or account id',()=>{
  const account={id:'account-1',clientId:'client-1',email:'owner@example.com'};
  assert.equal(projectBelongsToAccount({clientId:'client-1'},account),true);
  assert.equal(projectBelongsToAccount({accountId:'account-1'},account),true);
});

test('matches clientEmail case-insensitively',()=>{
  const account={id:'account-1',email:'Owner@Example.com'};
  assert.equal(projectBelongsToAccount({clientEmail:' owner@example.COM '},account),true);
});

test('matches a linked lead by client id or normalized email',()=>{
  const account={id:'account-1',clientId:'client-1',email:'owner@example.com'};
  assert.equal(projectBelongsToAccount({leadId:'lead-1' },account,{clientId:'client-1'}),true);
  assert.equal(projectBelongsToAccount({leadId:'lead-2'},account,{email:'OWNER@example.com'}),true);
});

test('does not grant access to an unrelated client or to empty email values',()=>{
  const account={id:'account-1',email:''};
  assert.equal(projectBelongsToAccount({clientId:'client-2',clientEmail:''},account),false);
  assert.equal(projectBelongsToAccount({clientId:'client-2'},account,{clientId:'client-3',email:'other@example.com'}),false);
});

test('does not match without both project and account records',()=>{
  assert.equal(projectBelongsToAccount(null,{id:'account-1'}),false);
  assert.equal(projectBelongsToAccount({clientId:'client-1'},null),false);
});
