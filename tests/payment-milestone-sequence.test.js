'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function loadSales(data) {
  const financePath = require.resolve('../netlify/functions/project-financials');
  delete require.cache[financePath];
  const resolved = require.resolve('../netlify/functions/sales');
  delete require.cache[resolved];
  const originalLoad = Module._load;
  const stores = data;
  const blobs = {
    connectLambda() {},
    getStore({ name }) {
      stores[name] ||= {};
      return {
        async list({ prefix = '' } = {}) { return { blobs: Object.keys(stores[name]).filter(key => key.startsWith(prefix)).map(key => ({ key })) }; },
        async get(key) { return stores[name][key] ?? null; },
        async setJSON(key, value) { stores[name][key] = JSON.parse(JSON.stringify(value)); }
      };
    }
  };
  Module._load = function(request, parent, isMain) {
    if (request === '@netlify/blobs') return blobs;
    if (request === './auth-utils' && parent && parent.filename === resolved) return { requireAdmin() { return null; }, json(statusCode, body) { return { statusCode, body: JSON.stringify(body) }; } };
    if (request === './client-activity' && parent && parent.filename === resolved) return { async logActivity() {} };
    return originalLoad.call(this, request, parent, isMain);
  };
  try { return { handler: require(resolved).handler, stores }; }
  finally { Module._load = originalLoad; delete require.cache[resolved]; delete require.cache[financePath]; }
}
function fixture() {
  return {
    'hbpx-projects': { 'project-a': { id:'project-a', leadId:'lead-a', status:'active', amount:100000 } },
    'hbpx-leads': { 'lead-a': { id:'lead-a', email:'a@example.com', whatsapp:'9647700000000' } },
    'hbpx-client-accounts': {},
    'hbpx-contracts': { 'contract-a': { id:'contract-a', projectId:'project-a', amount:100000, status:'signed', signedAt:'2026-11-06T10:00:00.000Z' } },
    'hbpx-payments': { 'payment-a': { id:'payment-a', projectId:'project-a', amount:10000 } },
    'hbpx-deliveries': {}
  };
}
function body(response) { return JSON.parse(response.body || '{}'); }

test('balance payment cannot be registered before client approval of the latest preview', async () => {
  const data = fixture();
  const service = loadSales(data);
  const response = await service.handler({ httpMethod:'POST', body:JSON.stringify({type:'payment',projectId:'project-a',amount:90000,method:'cash',receivedConfirmed:true}) });
  assert.equal(response.statusCode,409);
  assert.match(body(response).error,/اعتماد المحتوى/);
  assert.equal(data['hbpx-payments']['payment-a'].amount,10000);
});

test('deposit payments can be split but cannot exceed the 10 percent limit before approval', async () => {
  const data = fixture();
  const service = loadSales(data);
  const deposit = await service.handler({ httpMethod:'POST', body:JSON.stringify({type:'payment',projectId:'project-a',amount:5000,method:'cash',receivedConfirmed:true}) });
  assert.equal(deposit.statusCode,201);
  const excess = await service.handler({ httpMethod:'POST', body:JSON.stringify({type:'payment',projectId:'project-a',amount:1,method:'cash',receivedConfirmed:true}) });
  assert.equal(excess.statusCode,201); // still below the 10 percent cap
  const beyond = await service.handler({ httpMethod:'POST', body:JSON.stringify({type:'payment',projectId:'project-a',amount:1,method:'cash',receivedConfirmed:true}) });
  assert.equal(beyond.statusCode,409);
});

test('balance payment is accepted after client approval and overpayment is rejected', async () => {
  const data = fixture();
  data['hbpx-deliveries']['delivery-preview'] = { id:'delivery-preview',projectId:'project-a',stage:'preview',createdAt:'2026-11-06T12:00:00.000Z',clientApproval:{decision:'approved'} };
  const service = loadSales(data);
  const payment = await service.handler({ httpMethod:'POST', body:JSON.stringify({type:'payment',projectId:'project-a',amount:90000,method:'bank_transfer',receivedConfirmed:true}) });
  assert.equal(payment.statusCode,201);
  const over = await service.handler({ httpMethod:'POST', body:JSON.stringify({type:'payment',projectId:'project-a',amount:1,method:'cash',receivedConfirmed:true}) });
  assert.equal(over.statusCode,409);
  assert.match(body(over).error,/يتجاوز قيمة العقد/);
});

test('project cannot be completed before full payment and an actual final handoff', async () => {
  const data=fixture();
  const service=loadSales(data);
  const response=await service.handler({httpMethod:'PATCH',body:JSON.stringify({collection:'projects',id:'project-a',status:'completed'})});
  assert.equal(response.statusCode,409);
  assert.match(body(response).error,/اكتمال سداد 100%/);
  data['hbpx-payments']['payment-a'].amount=100000;
  const paidService=loadSales(data);
  const noHandoff=await paidService.handler({httpMethod:'PATCH',body:JSON.stringify({collection:'projects',id:'project-a',status:'completed'})});
  assert.equal(noHandoff.statusCode,409);
  assert.match(body(noHandoff).error,/تسليم الملفات النهائية/);
  data['hbpx-deliveries']['delivery-final']={id:'delivery-final',projectId:'project-a',stage:'final',status:'delivered',fullQuality:true,rightsTransferred:true};
  const completedService=loadSales(data);
  const result=await completedService.handler({httpMethod:'PATCH',body:JSON.stringify({collection:'projects',id:'project-a',status:'completed'})});
  assert.equal(result.statusCode,200);
});
