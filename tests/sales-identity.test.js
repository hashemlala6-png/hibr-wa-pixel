'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const {
  clientIdentityKey
} = require('../netlify/functions/client-ownership');

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function loadSales(data) {
  const financeResolved = require.resolve('../netlify/functions/project-financials');
  delete require.cache[financeResolved];
  const resolved = require.resolve('../netlify/functions/sales');
  delete require.cache[resolved];
  const originalLoad = Module._load;
  const activity = [];
  const writes = [];
  const blobModule = {
    connectLambda() {},
    getStore({name}) {
      if (!data[name]) data[name] = {};
      const store = data[name];
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
      return {
        requireAdmin() { return null; },
        json(statusCode, payload) { return {statusCode,body:JSON.stringify(payload)}; }
      };
    }
    if (request === './client-activity' && parent && parent.filename === resolved) {
      return {async logActivity(clientId,type,label,details) { activity.push({clientId,type,label,details}); }};
    }
    if (request === './env' && parent && parent.filename === resolved) {
      return {env() { return 'test'; }};
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const handler = require(resolved).handler;
    return {handler,activity,writes,data};
  } finally {
    Module._load = originalLoad;
    delete require.cache[resolved];
  }
}

function responseBody(response) {
  return JSON.parse(response.body || '{}');
}

function baseData() {
  return {
    'hbpx-payments': {},
    'hbpx-contracts': {},
    'hbpx-deliveries': {},
    'hbpx-client-accounts': {
      'email-account-a': {id:'account-a',email:'a@example.com',whatsapp:'07712345678'}
    },
    'hbpx-leads': {
      'lead-a': {id:'lead-a',clientId:'legacy-phone-group',email:'a@example.com',whatsapp:'07712345678'},
      'lead-b': {id:'lead-b',clientId:'legacy-phone-group',email:'b@example.com',whatsapp:'+9647712345678'}
    },
    'hbpx-projects': {
      'project-legacy': {id:'project-legacy',leadId:'lead-b',clientId:'legacy-phone-group',accountId:'legacy-phone-group',name:'Legacy project'},
      'project-orphan': {id:'project-orphan',clientId:'legacy-phone-group',name:'Unlinked project'}
    }
  };
}

test('sales records use an exact account match or an isolated lead identity, never a legacy shared ID', async () => {
  const service = loadSales(baseData());
  const createdA = await service.handler({
    httpMethod:'POST',
    body:JSON.stringify({type:'project',leadId:'lead-a',name:'Project A',amount:1000})
  });
  const itemA = responseBody(createdA).item;
  assert.equal(createdA.statusCode,201);
  assert.equal(itemA.clientId,'account-a');
  assert.equal(itemA.accountId,'account-a');

  const createdB = await service.handler({
    httpMethod:'POST',
    body:JSON.stringify({type:'project',leadId:'lead-b',name:'Project B',amount:2000})
  });
  const itemB = responseBody(createdB).item;
  const expectedB = clientIdentityKey(service.data['hbpx-leads']['lead-b']);
  assert.equal(createdB.statusCode,201);
  assert.equal(itemB.clientId,expectedB);
  assert.equal(itemB.accountId,null);
  assert.notEqual(itemB.clientId,'legacy-phone-group');

  service.data['hbpx-contracts']['contract-project-b']={id:'contract-project-b',projectId:itemB.id,amount:2000,status:'signed',signedAt:'2026-11-06T10:00:00.000Z'};
  service.data['hbpx-deliveries']['delivery-project-b']={id:'delivery-project-b',projectId:itemB.id,stage:'preview',status:'ready',createdAt:'2026-11-06T11:00:00.000Z',clientApproval:{decision:'approved'}};
  const payment = await service.handler({
    httpMethod:'POST',
    body:JSON.stringify({type:'payment',projectId:itemB.id,amount:500,method:'transfer',receivedConfirmed:true})
  });
  assert.equal(payment.statusCode,201);
  assert.equal(responseBody(payment).item.clientId,expectedB);
  assert.equal(service.activity.at(-1).clientId,expectedB);

  const changed = await service.handler({
    httpMethod:'PATCH',
    body:JSON.stringify({collection:'projects',id:itemB.id,status:'paused'})
  });
  assert.equal(changed.statusCode,200);
  assert.equal(service.data['hbpx-projects'][itemB.id].status,'paused');
  assert.equal(service.activity.at(-1).clientId,expectedB);

  const listed = await service.handler({httpMethod:'GET'});
  const reviewIds = responseBody(listed).ownershipReview.map(x=>x.id);
  assert.ok(reviewIds.includes('project-legacy'));
  assert.ok(reviewIds.includes('project-orphan'));
  assert.ok(!reviewIds.includes(itemA.id));
  assert.ok(!reviewIds.includes(itemB.id));
});

test('sales refuses project and quote creation when the referenced lead does not exist', async () => {
  const service = loadSales(baseData());
  const project = await service.handler({
    httpMethod:'POST',
    body:JSON.stringify({type:'project',leadId:'lead-missing',name:'Missing lead',amount:1000})
  });
  const quote = await service.handler({
    httpMethod:'POST',
    body:JSON.stringify({type:'quote',leadId:'lead-missing',amount:1000})
  });
  assert.equal(project.statusCode,404);
  assert.equal(quote.statusCode,404);
  assert.equal(service.data['hbpx-projects']['project-missing'],undefined);
});
