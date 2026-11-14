'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');

function loadService({ tasks = {}, initialExecutions = {}, generated = null, generationError = null, authorized = true } = {}) {
  const resolved = require.resolve('../netlify/functions/ai-team');
  delete require.cache[resolved];
  const originalLoad = Module._load;
  const stores = {
    'hbpx-tasks': new Map(Object.entries(tasks)),
    'hbpx-ai-team-executions': new Map(Object.entries(initialExecutions)),
    'hbpx-ai-team-locks': new Map()
  };
  const calls = { connect: 0, generations: [], writes: [] };

  function makeStore(name) {
    const rows = stores[name];
    return {
      async get(key) { return rows.has(key) ? JSON.parse(JSON.stringify(rows.get(key))) : null; },
      async list({ prefix = '' } = {}) {
        return { blobs: [...rows.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key })) };
      },
      async setJSON(key, value, options = {}) {
        if (options.onlyIfNew && rows.has(key)) return { modified: false };
        rows.set(key, JSON.parse(JSON.stringify(value)));
        calls.writes.push({ store: name, key });
        return { modified: true };
      },
      async delete(key) { rows.delete(key); }
    };
  }

  Module._load = function(request, parent, isMain) {
    if (request === '@netlify/blobs' && parent && parent.filename === resolved) {
      return { connectLambda() { calls.connect++; }, getStore(options) { return makeStore(options.name); } };
    }
    if (request === './auth-utils' && parent && parent.filename === resolved) {
      return {
        requireAdmin() { return authorized ? null : { statusCode: 401, body: '{}' }; },
        json(statusCode, value) { return { statusCode, body: JSON.stringify(value) }; }
      };
    }
    if (request === './ai-provider' && parent && parent.filename === resolved) {
      return {
        async requestText(options) {
          calls.generations.push(options);
          if (generationError) throw new Error(generationError);
          return generated || {
            text: JSON.stringify({
              summary: 'خطة واضحة',
              deliverable: 'مخرج تجريبي للمراجعة',
              steps: ['الخطوة الأولى'],
              assumptions: [],
              ownerApproval: ['اعتماد المحتوى قبل النشر'],
              qualityChecks: ['مراجعة النص العربي'],
              blocked: false
            }),
            provider: 'openai',
            model: 'test-model',
            fallbackUsed: false
          };
        }
      };
    }
    if (request === './blob-config' && parent && parent.filename === resolved) {
      return { blobOptions(name, consistency) { return { name, consistency }; } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const handler = require(resolved).handler;
    return { handler, stores, calls };
  } finally {
    Module._load = originalLoad;
    delete require.cache[resolved];
  }
}

function event(method, body = {}) {
  return { httpMethod: method, headers: {}, body: JSON.stringify(body) };
}
function payload(response) { return JSON.parse(response.body || '{}'); }

test('AI team requires an owner session and still connects the Netlify request context', async () => {
  const service = loadService({ authorized: false });
  const response = await service.handler(event('GET'));
  assert.equal(response.statusCode, 401);
  assert.equal(service.calls.connect, 1);
  assert.equal(service.calls.generations.length, 0);
});

test('AI team returns recent saved executions without invoking an AI provider', async () => {
  const service = loadService({
    initialExecutions: {
      'execution-old': { id: 'execution-old', createdAt: '2026-11-13T10:00:00.000Z' }
    }
  });
  const response = await service.handler(event('GET'));
  assert.equal(response.statusCode, 200);
  assert.equal(payload(response).executions.length, 1);
  assert.equal(service.calls.generations.length, 0);
});

test('AI team executes a role task, saves a review draft and never performs an external action', async () => {
  const task = {
    id: 'task-a',
    projectId: 'internal-hibr',
    title: 'إعداد خطة محتوى أسبوعية',
    assignee: 'مخطط المحتوى',
    status: 'todo'
  };
  const service = loadService({ tasks: { 'task-a': task } });
  const response = await service.handler(event('POST', { taskId: 'task-a', instructions: 'ركزي على المتاجر العراقية.' }));
  const result = payload(response);

  assert.equal(response.statusCode, 200);
  assert.equal(result.task.status, 'review');
  assert.ok(result.task.latestExecutionId);
  assert.equal(result.execution.role, 'مخطط المحتوى');
  assert.equal(result.execution.provider, 'openai');
  assert.equal(result.execution.policy.externalActionsExecuted, false);
  assert.equal(result.execution.result.summary, 'خطة واضحة');
  assert.match(service.calls.generations[0].userPrompt, /المتاجر العراقية/);
  assert.equal(service.stores['hbpx-ai-team-locks'].size, 0);
  assert.equal(service.stores['hbpx-ai-team-executions'].size, 1);
});

test('AI team refuses a task that belongs to a customer project', async () => {
  const service = loadService({
    tasks: { 'task-customer': { id: 'task-customer', projectId: 'project-customer', assignee: 'كاتب المحتوى', title: 'مهمة عميل' } }
  });
  const response = await service.handler(event('POST', { taskId: 'task-customer' }));
  assert.equal(response.statusCode, 404);
  assert.equal(service.calls.generations.length, 0);
});

test('AI team refuses unknown roles before spending provider tokens', async () => {
  const service = loadService({
    tasks: { 'task-a': { id: 'task-a', projectId: 'internal-hibr', assignee: 'وكيل غير معروف', title: 'مهمة' } }
  });
  const response = await service.handler(event('POST', { taskId: 'task-a' }));
  assert.equal(response.statusCode, 400);
  assert.equal(service.calls.generations.length, 0);
});

test('AI team blocks duplicate concurrent execution for the same task', async () => {
  const service = loadService({
    tasks: { 'task-a': { id: 'task-a', projectId: 'internal-hibr', assignee: 'كاتب المحتوى', title: 'مهمة' } }
  });
  service.stores['hbpx-ai-team-locks'].set('task-task-a', {
    taskId: 'task-a',
    createdAt: new Date().toISOString()
  });
  const response = await service.handler(event('POST', { taskId: 'task-a' }));
  assert.equal(response.statusCode, 409);
  assert.equal(service.calls.generations.length, 0);
});

test('AI team restores the task state and releases its lock when the provider fails', async () => {
  const task = { id: 'task-a', projectId: 'internal-hibr', assignee: 'كاتب المحتوى', title: 'مهمة', status: 'todo' };
  const service = loadService({ tasks: { 'task-a': task }, generationError: 'لا يوجد مزود نصوص متاح.' });
  const response = await service.handler(event('POST', { taskId: 'task-a' }));
  assert.equal(response.statusCode, 502);
  assert.equal(service.stores['hbpx-tasks'].get('task-a').status, 'todo');
  assert.equal(service.stores['hbpx-ai-team-locks'].size, 0);
  assert.equal(service.stores['hbpx-ai-team-executions'].size, 0);
});

test('AI team rejects malformed model output without recording a successful execution', async () => {
  const service = loadService({
    tasks: { 'task-a': { id: 'task-a', projectId: 'internal-hibr', assignee: 'كاتب المحتوى', title: 'مهمة', status: 'todo' } },
    generated: { text: 'هذا ليس JSON', provider: 'openai', model: 'test-model' }
  });
  const response = await service.handler(event('POST', { taskId: 'task-a' }));
  assert.equal(response.statusCode, 502);
  assert.equal(service.stores['hbpx-ai-team-executions'].size, 0);
  assert.equal(service.stores['hbpx-ai-team-locks'].size, 0);
});


test('owner console exposes all nine internal AI roles and a complete team task view', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
  const sectionStart = html.indexOf('<section id="ai-team"');
  const sectionEnd = html.indexOf('<section id="growth"', sectionStart);
  assert.ok(sectionStart >= 0, 'AI team view must exist');
  assert.ok(sectionEnd > sectionStart, 'AI team view must end before the growth view');
  const section = html.slice(sectionStart, sectionEnd);
  assert.match(section, /<\/section>\s*$/);
  for (const role of [
    'مدير العمليات',
    'استراتيجي التسويق',
    'مخطط المحتوى',
    'كاتب المحتوى',
    'المصمم',
    'مسؤول الجودة',
    'مسؤول العملاء',
    'مسؤول النشر',
    'محلل الأداء'
  ]) {
    assert.ok(section.includes(role), 'Missing AI team role: ' + role);
  }
  for (const id of ['teamTaskTitle', 'teamTaskAssignee', 'teamTaskDue', 'teamTaskAdd', 'teamTaskRefresh', 'teamTaskList']) {
    assert.ok(section.includes('id="' + id + '"'), 'Missing AI team control: ' + id);
  }
});

test('owner console wires team tasks to the operations endpoint and internal AI execution endpoint', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
  assert.match(html, /data-tab="ai-team"/);
  assert.match(html, /api\('\/\.netlify\/functions\/ai-team'/);
  assert.match(html, /api\('\/\.netlify\/functions\/operations'/);
  assert.match(html, /مخرج للمراجعة/);
  assert.match(html, /لم يُنفذ أي إجراء خارجي/);
});
