'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function loadBilling(data) {
  const financePath = require.resolve('../netlify/functions/project-financials');
  delete require.cache[financePath];
  const resolved = require.resolve('../netlify/functions/billing');
  delete require.cache[resolved];
  const originalLoad = Module._load;
  const writes = [];
  const activity = [];
  const stores = data;
  const blobs = {
    connectLambda() {},
    getStore({ name }) {
      stores[name] ||= {};
      return {
        async list({ prefix = '' } = {}) {
          return { blobs: Object.keys(stores[name]).filter(key => key.startsWith(prefix)).map(key => ({ key })) };
        },
        async get(key) { return stores[name][key] ?? null; },
        async setJSON(key, value) { stores[name][key] = JSON.parse(JSON.stringify(value)); writes.push({ name, key, value }); },
        async delete(key) { delete stores[name][key]; }
      };
    }
  };
  Module._load = function(request, parent, isMain) {
    if (request === '@netlify/blobs') return blobs;
    if (request === './auth-utils' && parent && parent.filename === resolved) {
      return { requireAdmin() { return null; }, json(statusCode, payload) { return { statusCode, body: JSON.stringify(payload) }; } };
    }
    if (request === './env' && parent && parent.filename === resolved) return { env() { return ''; } };
    if (request === './client-activity' && parent && parent.filename === resolved) {
      return { async logActivity(id, type, label, details) { activity.push({ id, type, label, details }); } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return { handler: require(resolved).handler, writes, activity, stores };
  } finally {
    Module._load = originalLoad;
    delete require.cache[resolved];
    delete require.cache[financePath];
  }
}

const base = () => ({
  'hbpx-projects': { 'project-a': { id: 'project-a', leadId: 'lead-a', amount: 100000, status: 'active' } },
  'hbpx-leads': { 'lead-a': { id: 'lead-a' } },
  'hbpx-contracts': { 'contract-a': { id: 'contract-a', projectId: 'project-a', amount: 100000, status: 'signed', signedAt: '2026-11-06T10:00:00.000Z' } },
  'hbpx-payments': { 'payment-a': { id: 'payment-a', projectId: 'project-a', amount: 10000 } },
  'hbpx-quality-gates': {},
  'hbpx-visual-qa': {},
  'hbpx-deliveries': {}
});
const event = (payload, method = 'POST') => ({ httpMethod: method, headers: {}, body: JSON.stringify(payload) });
const body = response => JSON.parse(response.body || '{}');
const deliveryPayload = (stage, extra = {}) => ({
  type: 'delivery', projectId: 'project-a', title: 'ملفات المشروع',
  url: 'https://files.example.com/project.zip', stage, ...extra
});

test('preview delivery requires a signed contract and recorded 10 percent deposit', async () => {
  const data = base();
  data['hbpx-contracts']['contract-a'].status = 'pending_signature';
  const service = loadBilling(data);
  const response = await service.handler(event(deliveryPayload('preview', { watermarkConfirmed: true, lowResolutionConfirmed: true })));
  assert.equal(response.statusCode, 409);
  assert.match(body(response).error, /يوقّع العميل العقد/);
  assert.equal(service.writes.length, 0);
});

test('preview delivery requires owner confirmation of watermark and reduced quality', async () => {
  const service = loadBilling(base());
  const response = await service.handler(event(deliveryPayload('preview', { watermarkConfirmed: true })));
  assert.equal(response.statusCode, 400);
  assert.match(body(response).error, /علامة مائية/);
  assert.equal(service.writes.length, 0);
});

test('valid preview is stored as protected and does not transfer rights', async () => {
  const service = loadBilling(base());
  const response = await service.handler(event(deliveryPayload('preview', { watermarkConfirmed: true, lowResolutionConfirmed: true })));
  const item = body(response).item;
  assert.equal(response.statusCode, 201);
  assert.equal(item.stage, 'preview');
  assert.equal(item.watermarked, true);
  assert.equal(item.lowResolution, true);
  assert.equal(item.fullQuality, false);
  assert.equal(item.rightsTransferred, false);
});

test('final delivery is blocked until full payment', async () => {
  const data = base();
  data['hbpx-deliveries']['delivery-preview'] = {
    id: 'delivery-preview', projectId: 'project-a', stage: 'preview', status: 'ready',
    clientApproval: { decision: 'approved', at: '2026-11-06T12:00:00.000Z' }
  };
  const service = loadBilling(data);
  const response = await service.handler(event(deliveryPayload('final', { finalQualityConfirmed: true, rightsTransferConfirmed: true })));
  assert.equal(response.statusCode, 409);
  assert.match(body(response).error, /سداد كامل المبلغ/);
  assert.equal(service.writes.length, 0);
});

test('final delivery is blocked until client approves the latest preview', async () => {
  const data = base();
  data['hbpx-payments']['payment-a'].amount = 100000;
  data['hbpx-deliveries']['delivery-preview'] = {
    id: 'delivery-preview', projectId: 'project-a', stage: 'preview', status: 'ready',
    clientApproval: { decision: 'needs_changes', at: '2026-11-06T12:00:00.000Z' }
  };
  const service = loadBilling(data);
  const response = await service.handler(event(deliveryPayload('final', { finalQualityConfirmed: true, rightsTransferConfirmed: true })));
  assert.equal(response.statusCode, 409);
  assert.match(body(response).error, /اعتماد العميل/);
  assert.equal(service.writes.length, 0);
});

test('final delivery requires a passing final quality gate and owner confirmations', async () => {
  const data = base();
  data['hbpx-payments']['payment-a'].amount = 100000;
  data['hbpx-deliveries']['delivery-preview'] = {
    id: 'delivery-preview', projectId: 'project-a', stage: 'preview', status: 'ready',
    clientApproval: { decision: 'approved', at: '2026-11-06T12:00:00.000Z' }
  };
  const service = loadBilling(data);
  const response = await service.handler(event(deliveryPayload('final', { finalQualityConfirmed: true, rightsTransferConfirmed: true })));
  assert.equal(response.statusCode, 409);
  assert.match(body(response).error, /بوابة الجودة النهائية/);
  assert.equal(service.writes.length, 0);
});

test('final delivery is stored as full quality and rights transferred after all gates pass', async () => {
  const data = base();
  data['hbpx-payments']['payment-a'].amount = 100000;
  data['hbpx-deliveries']['delivery-preview'] = {
    id: 'delivery-preview', projectId: 'project-a', stage: 'preview', status: 'ready',
    clientApproval: { decision: 'approved', at: '2026-11-06T12:00:00.000Z' }
  };
  data['hbpx-quality-gates']['gate-final'] = {
    id: 'gate-final', projectId: 'project-a', kind: 'final', status: 'approved',
    approvedAt: '2026-11-06T12:30:00.000Z',
    result: { passed: true, criticalCount: 0 }
  };
  data['hbpx-visual-qa']['vqa-final'] = { id: 'vqa-final', projectId: 'project-a', createdAt: '2026-11-06T12:00:00.000Z' };
  const service = loadBilling(data);
  const response = await service.handler(event(deliveryPayload('final', { finalQualityConfirmed: true, rightsTransferConfirmed: true })));
  const item = body(response).item;
  assert.equal(response.statusCode, 201);
  assert.equal(item.stage, 'final');
  assert.equal(item.watermarked, false);
  assert.equal(item.fullQuality, true);
  assert.equal(item.rightsTransferred, true);
  assert.equal(item.clientApprovedPreviewId, 'delivery-preview');
  assert.equal(item.qualityGateId, 'gate-final');
});

test('a protected preview can never be marked delivered as the final handoff', async () => {
  const data = base();
  data['hbpx-deliveries']['delivery-preview'] = {
    id: 'delivery-preview', projectId: 'project-a', stage: 'preview',
    watermarked: true, fullQuality: false, rightsTransferred: false, status: 'ready'
  };
  const service = loadBilling(data);
  const response = await service.handler({ ...event({ type: 'delivery', id: 'delivery-preview', status: 'delivered' }, 'PATCH') });
  assert.equal(response.statusCode, 409);
  assert.equal(data['hbpx-deliveries']['delivery-preview'].status, 'ready');
  assert.equal(service.writes.length, 0);
});
