'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function fixture() {
  return {
    'hbpx-client-accounts': {
      'acct-a': {id:'acct-a',clientId:'legacy-phone-group',name:'Client A',email:'a@example.com',whatsapp:'7712345678'},
      'acct-b': {id:'acct-b',clientId:'legacy-phone-group',name:'Client B',email:'b@example.com',whatsapp:'7712345678'}
    },
    'hbpx-leads': {
      'lead-a': {id:'lead-a',clientId:'legacy-phone-group',email:'a@example.com',whatsapp:'07712345678'},
      'lead-b': {id:'lead-b',clientId:'legacy-phone-group',email:'b@example.com',whatsapp:'+9647712345678'}
    },
    'hbpx-projects': {
      'project-a': {id:'project-a',clientId:'legacy-phone-group',accountId:'legacy-phone-group',leadId:'lead-a',name:'Project A'},
      'project-b': {id:'project-b',clientId:'legacy-phone-group',accountId:'legacy-phone-group',leadId:'lead-b',name:'Project B'},
      'project-unlinked': {id:'project-unlinked',clientId:'legacy-phone-group',accountId:'legacy-phone-group',name:'Unlinked legacy project'}
    },
    'hbpx-tasks': {
      'task-a': {id:'task-a',projectId:'project-a',title:'Task A',status:'todo'},
      'task-b': {id:'task-b',projectId:'project-b',title:'Task B',status:'todo'}
    },
    'hbpx-payments': {
      'payment-a': {id:'payment-a',projectId:'project-a',amount:1000},
      'payment-b': {id:'payment-b',projectId:'project-b',amount:2000}
    },
    'hbpx-invoices': {
      'invoice-a': {id:'invoice-a',projectId:'project-a',total:1000},
      'invoice-b': {id:'invoice-b',projectId:'project-b',total:2000}
    },
    'hbpx-contracts': {
      'contract-a': {id:'contract-a',projectId:'project-a',title:'Contract A',terms:'A'.repeat(40),status:'pending_signature'},
      'contract-b': {id:'contract-b',projectId:'project-b',title:'Contract B',terms:'B'.repeat(40),status:'pending_signature'}
    },
    'hbpx-subscriptions': {
      'subscription-a': {id:'subscription-a',projectId:'project-a',name:'Subscription A'},
      'subscription-b': {id:'subscription-b',projectId:'project-b',name:'Subscription B'}
    },
    'hbpx-deliveries': {
      'delivery-a': {id:'delivery-a',projectId:'project-a',title:'Delivery A',url:'https://example.com/a.pdf'},
      'delivery-b': {id:'delivery-b',projectId:'project-b',title:'Delivery B',url:'https://example.com/b.pdf'}
    },
    'hbpx-result-plans': {}
  };
}

function loadHandler(relativePath, data, sessionSub) {
  const resolved = require.resolve(relativePath);
  delete require.cache[resolved];
  const originalLoad = Module._load;
  const writes = [];
  const stores = data;
  const blobModule = {
    connectLambda() {},
    getStore({name}) {
      if (!stores[name]) stores[name] = {};
      const store = stores[name];
      return {
        async list({prefix = ''} = {}) {
          return {blobs:Object.keys(store).filter(key=>key.startsWith(prefix)).map(key=>({key}))};
        },
        async get(key) {
          return clone(store[key] ?? null);
        },
        async setJSON(key, value) {
          writes.push({store:name,key,value:clone(value)});
          store[key] = clone(value);
        },
        async delete(key) {
          delete store[key];
        }
      };
    }
  };
  Module._load = function(request, parent, isMain) {
    if (request === '@netlify/blobs') return blobModule;
    if (request === './auth-utils' && parent && parent.filename === resolved) {
      return {json(statusCode, payload) { return {statusCode, body:JSON.stringify(payload)}; }};
    }
    if (request === './client-auth-utils' && parent && parent.filename === resolved) {
      return {getClientSession(event) { return event.session || null; }};
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const handler = require(resolved).handler;
    return {handler,writes,stores};
  } finally {
    Module._load = originalLoad;
    delete require.cache[resolved];
  }
}

function responseBody(response) {
  return JSON.parse(response.body || '{}');
}

test('customer APIs isolate same-phone accounts with a legacy shared clientId', async () => {
  const data = fixture();

  const clientA = loadHandler('../netlify/functions/client.js', data);
  const resultA = await clientA.handler({httpMethod:'GET',session:{sub:'acct-a'},headers:{}});
  const payloadA = responseBody(resultA);
  assert.equal(resultA.statusCode,200);
  assert.deepEqual(payloadA.projects.map(p=>p.id),['project-a']);
  assert.deepEqual(payloadA.projects[0].tasks.map(t=>t.title),['Task A']);
  assert.deepEqual(payloadA.projects[0].invoices.map(i=>i.total),[1000]);
  assert.deepEqual(payloadA.projects[0].deliveries.map(d=>d.title),['Delivery A']);

  const clientB = loadHandler('../netlify/functions/client.js', data);
  const resultB = await clientB.handler({httpMethod:'GET',session:{sub:'acct-b'},headers:{}});
  const payloadB = responseBody(resultB);
  assert.equal(resultB.statusCode,200);
  assert.deepEqual(payloadB.projects.map(p=>p.id),['project-b']);
  assert.deepEqual(payloadB.projects[0].tasks.map(t=>t.title),['Task B']);

  const agreementsA = loadHandler('../netlify/functions/client-agreements.js', data);
  const agreementResultA = await agreementsA.handler({httpMethod:'GET',session:{sub:'acct-a'},headers:{}});
  const agreementsPayloadA = responseBody(agreementResultA);
  assert.equal(agreementResultA.statusCode,200);
  assert.deepEqual(agreementsPayloadA.contracts.map(c=>c.id),['contract-a']);
  assert.deepEqual(agreementsPayloadA.subscriptions.map(s=>s.id),['subscription-a']);

  const agreementsB = loadHandler('../netlify/functions/client-agreements.js', data);
  const agreementResultB = await agreementsB.handler({httpMethod:'GET',session:{sub:'acct-b'},headers:{}});
  const agreementsPayloadB = responseBody(agreementResultB);
  assert.equal(agreementResultB.statusCode,200);
  assert.deepEqual(agreementsPayloadB.contracts.map(c=>c.id),['contract-b']);
  assert.deepEqual(agreementsPayloadB.subscriptions.map(s=>s.id),['subscription-b']);

  const before = clone(data['hbpx-contracts']['contract-b']);
  const signingAttempt = loadHandler('../netlify/functions/client-agreements.js', data);
  const forbidden = await signingAttempt.handler({
    httpMethod:'POST',
    session:{sub:'acct-a'},
    headers:{},
    body:JSON.stringify({contractId:'contract-b',signedName:'Client A',acceptTerms:true})
  });
  assert.equal(forbidden.statusCode,404);
  assert.deepEqual(data['hbpx-contracts']['contract-b'],before);
  assert.equal(signingAttempt.writes.length,0);

  const ownSigning = loadHandler('../netlify/functions/client-agreements.js', data);
  const allowed = await ownSigning.handler({
    httpMethod:'POST',
    session:{sub:'acct-a'},
    headers:{},
    body:JSON.stringify({contractId:'contract-a',signedName:'Client A',acceptTerms:true})
  });
  assert.equal(allowed.statusCode,200);
  assert.equal(data['hbpx-contracts']['contract-a'].status,'signed');
});
