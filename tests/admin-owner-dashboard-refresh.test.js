'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
const script = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
  .map(match => match[1]).join('\n');

function functionSource(name) {
  const matcher = /(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g;
  const match = [...script.matchAll(matcher)].find(entry => entry[1] === name);
  assert.ok(match, 'Missing function: ' + name);

  const open = match.index + match[0].lastIndexOf('{');
  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  const templateQuote = String.fromCharCode(96);

  for (let i = open; i < script.length; i += 1) {
    const char = script[i];
    const next = script[i + 1];

    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        i += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = '';
      }
      continue;
    }
    if (char === '/' && next === '/') {
      lineComment = true;
      i += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      i += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === templateQuote) {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return script.slice(match.index, i + 1);
    }
  }
  throw new Error('Unclosed function: ' + name);
}

test('owner refresh includes the lead inbox and asks optional loaders to propagate failures', () => {
  const source = functionSource('loadAll');
  assert.match(source, /\['طلبات العملاء',\(\)=>loadIncomingLeads\(\{propagate:true\}\)\]/);
  for (const name of ['loadGrowth', 'loadPresence', 'loadNotifications', 'loadPricing', 'loadOps', 'loadSystemHealth']) {
    assert.match(source, new RegExp('\\(\\)=>' + name + '\\(\\{propagate:true\\}\\)'));
  }
  assert.match(source, /اكتمل التحديث جزئياً/);
  assert.match(source, /تعذر تحديثها/);
});

test('owner refresh renders cross-dependent views after every section settles', async () => {
  const source = functionSource('loadAll');
  const calls = [];
  const status = { textContent: '', style: {} };
  const context = {
    UNIVERSE_ERROR: '',
    $: selector => selector === '#loadStatus' ? status : null,
    console: { error: (...args) => calls.push(['error', ...args]) },
    loadUniverse: async () => calls.push('loadUniverse'),
    loadClients: async () => calls.push('loadClients'),
    loadIncomingLeads: async options => {
      calls.push(['loadIncomingLeads', options.propagate]);
      throw new Error('lead endpoint unavailable');
    },
    loadOrders: async () => calls.push('loadOrders'),
    loadSales: async () => calls.push('loadSales'),
    loadGrowth: async options => calls.push(['loadGrowth', options.propagate]),
    loadPresence: async options => calls.push(['loadPresence', options.propagate]),
    loadNotifications: async options => calls.push(['loadNotifications', options.propagate]),
    loadPricing: async options => calls.push(['loadPricing', options.propagate]),
    loadOps: async options => calls.push(['loadOps', options.propagate]),
    loadSystemHealth: async options => calls.push(['loadSystemHealth', options.propagate]),
    renderOverview: () => calls.push('renderOverview'),
    renderCustomers: () => calls.push('renderCustomers'),
    renderSales: () => calls.push('renderSales'),
    renderProjects: () => calls.push('renderProjects'),
    renderGrowth: () => calls.push('renderGrowth'),
    renderIntelligence: () => calls.push('renderIntelligence'),
    renderActivity: () => calls.push('renderActivity'),
    Promise
  };
  const loadAll = vm.runInNewContext(source + '\nloadAll', context);
  await loadAll();

  assert.ok(calls.some(item => Array.isArray(item) && item[0] === 'loadIncomingLeads' && item[1] === true));
  assert.match(status.textContent, /اكتمل التحديث جزئياً/);
  assert.match(status.textContent, /طلبات العملاء/);
  assert.equal(status.style.color, '#a94b4b');
  assert.deepEqual(calls.filter(item => typeof item === 'string').slice(-7), [
    'renderOverview', 'renderCustomers', 'renderSales', 'renderProjects',
    'renderGrowth', 'renderIntelligence', 'renderActivity'
  ]);
});

test('dashboard loaders expose swallowed failures when strict refresh mode is requested', () => {
  for (const name of ['loadGrowth', 'loadPresence', 'loadNotifications', 'loadPricing', 'loadOps']) {
    const source = functionSource(name);
    assert.match(source, /\{propagate=false\}=\{\}/, name + ' should support strict refresh mode');
    assert.match(source, /if\(propagate\)throw e;/, name + ' should rethrow in strict mode');
  }

  assert.match(functionSource('loadIncomingLeads'), /\{propagate=false\}=\{\}/);
  assert.match(functionSource('loadIncomingLeads'), /if\(propagate\)throw e;/);
  assert.match(functionSource('loadSystemHealth'), /\{propagate=false\}=\{\}/);
  assert.match(functionSource('loadSystemHealth'), /if\(propagate\)throw e;/);
});


test('lead status save is not reported as failed when the follow-up list refresh fails', async () => {
  const calls = [];
  const status = { textContent: '', style: {} };
  const context = {
    api: async (url, options) => {
      calls.push({ url, method: options.method, body: JSON.parse(options.body) });
      return { saved: true };
    },
    loadIncomingLeads: async options => {
      calls.push({ refresh: options.propagate });
      throw new Error('list unavailable');
    },
    $: selector => selector === '#leadsStatus' ? status : null,
    alert: message => calls.push({ alert: message })
  };
  const leadStatus = vm.runInNewContext(functionSource('leadStatus') + '\nleadStatus', context);
  await leadStatus('lead-1', 'contacted');

  assert.equal(calls[0].method, 'PATCH');
  assert.deepEqual(calls[0].body, { id: 'lead-1', status: 'contacted' });
  assert.deepEqual(calls[1], { refresh: true });
  assert.equal(calls.some(item => item.alert), false);
  assert.match(status.textContent, /تم حفظ حالة الطلب، لكن تعذر تحديث قائمة الطلبات/);
  assert.equal(status.style.color, '#a94b4b');
});

test('task status save is not retried as a failed mutation when task refresh fails', async () => {
  const calls = [];
  const status = { textContent: '', style: {} };
  const context = {
    api: async (url, options) => {
      calls.push({ url, method: options.method, body: JSON.parse(options.body) });
      return { saved: true };
    },
    loadOps: async options => {
      calls.push({ refresh: options.propagate });
      throw new Error('task list unavailable');
    },
    renderProjects: () => calls.push('renderProjects'),
    $: selector => selector === '#loadStatus' ? status : null,
    OPS_ERROR: '',
    alert: message => calls.push({ alert: message })
  };
  const taskStatus = vm.runInNewContext(functionSource('taskStatus') + '\ntaskStatus', context);
  await taskStatus('task-1', 'review');

  assert.equal(calls[0].method, 'PATCH');
  assert.deepEqual(calls[0].body, { type: 'task', id: 'task-1', status: 'review' });
  assert.deepEqual(calls[1], { refresh: true });
  assert.equal(calls.includes('renderProjects'), true);
  assert.equal(calls.some(item => item.alert), false);
  assert.match(status.textContent, /تم حفظ حالة المهمة، لكن تعذر تحديث عرض المهام/);
  assert.equal(status.style.color, '#a94b4b');
});


test('owner tab navigation toggles every matching navigation and view element', () => {
  const navButtons = ['overview', 'customers', 'sales'].map(tab => ({
    dataset: { tab },
    active: false,
    classList: { toggle(name, enabled) { this.owner.active = enabled; }, owner: null }
  }));
  const views = ['overview', 'customers', 'sales'].map(id => ({
    id,
    active: false,
    classList: { toggle(name, enabled) { this.owner.active = enabled; }, owner: null }
  }));
  for (const item of [...navButtons, ...views]) item.classList.owner = item;

  const calls = [];
  const context = {
    $$: selector => selector === '.nav button' ? navButtons : selector === '.view' ? views : [],
    loadIncomingLeads: () => calls.push('leads'),
    renderCustomers: () => calls.push('customers'),
    renderSales: () => calls.push('sales'),
    renderProjects: () => calls.push('projects'),
    renderGrowth: () => calls.push('growth'),
    renderIntelligence: () => calls.push('intelligence'),
    fillAIClients: () => calls.push('ai'),
    loadSystemHealth: () => calls.push('health'),
    renderActivity: () => calls.push('activity')
  };
  const tab = vm.runInNewContext(functionSource('tab') + '\ntab', context);
  tab('customers');

  assert.deepEqual(navButtons.map(item => item.active), [false, true, false]);
  assert.deepEqual(views.map(item => item.active), [false, true, false]);
  assert.deepEqual(calls, ['customers']);
  assert.match(script, /\$\$\('\[data-go\]'\)\.forEach/);
  assert.match(script, /\$\('#tabs'\)\.addEventListener\('click'/);
});


test('client, order, and sales loaders preserve explicit request errors for strict refresh', () => {
  assert.match(functionSource('loadClients'), /\{propagate=false\}=\{\}/);
  assert.match(functionSource('loadClients'), /CLIENTS_ERROR=e\.message/);
  assert.match(functionSource('loadOrders'), /\{propagate=false\}=\{\}/);
  assert.match(functionSource('loadOrders'), /ORDERS_ERROR=e\.message/);
  assert.match(functionSource('loadSales'), /\{propagate=false\}=\{\}/);
  assert.match(functionSource('loadSales'), /SALES_ERROR=e\.message/);
  const fullRefresh = functionSource('loadAll');
  assert.match(fullRefresh, /loadClients\(\{propagate:true\}\)/);
  assert.match(fullRefresh, /loadOrders\(\{propagate:true\}\)/);
  assert.match(fullRefresh, /loadSales\(\{propagate:true\}\)/);
});

test('sales and project views distinguish failed data requests from empty datasets', () => {
  const sales = functionSource('renderSales');
  const projects = functionSource('renderProjects');
  assert.match(sales, /ORDERS_ERROR/);
  assert.match(sales, /SALES_ERROR/);
  assert.match(projects, /SALES_ERROR/);
  assert.match(projects, /OPS_ERROR/);
  assert.match(functionSource('openClient'), /تعذر تحميل ملفات العملاء/);
});


test('commercial order status save is kept distinct from dashboard refresh failure', async () => {
  const calls = [];
  const status = { textContent: '', style: {} };
  const context = {
    api: async (url, options) => {
      calls.push({ url, method: options.method, body: JSON.parse(options.body) });
      return { saved: true };
    },
    loadAll: async () => { calls.push('refresh'); throw new Error('dashboard refresh failed'); },
    $: selector => selector === '#loadStatus' ? status : null,
    alert: message => calls.push({ alert: message })
  };
  const orderStatus = vm.runInNewContext(functionSource('orderStatus') + '\norderStatus', context);
  await orderStatus('order-1', 'approved');

  assert.equal(calls[0].method, 'PATCH');
  assert.deepEqual(calls[0].body, { id: 'order-1', status: 'approved' });
  assert.equal(calls[1], 'refresh');
  assert.equal(calls.some(item => item.alert), false);
  assert.match(status.textContent, /تم حفظ حالة الطلب التجاري، لكن تعذر تحديث لوحة الإدارة/);
});

test('project status save is kept distinct from dashboard refresh failure', async () => {
  const calls = [];
  const status = { textContent: '', style: {} };
  const context = {
    api: async (url, options) => {
      calls.push({ url, method: options.method, body: JSON.parse(options.body) });
      return { saved: true };
    },
    loadAll: async () => { calls.push('refresh'); throw new Error('dashboard refresh failed'); },
    $: selector => selector === '#loadStatus' ? status : null,
    alert: message => calls.push({ alert: message })
  };
  const projectStatus = vm.runInNewContext(functionSource('projectStatus') + '\nprojectStatus', context);
  await projectStatus('project-1', 'active');

  assert.equal(calls[0].method, 'PATCH');
  assert.deepEqual(calls[0].body, { collection: 'projects', id: 'project-1', status: 'active' });
  assert.equal(calls[1], 'refresh');
  assert.equal(calls.some(item => item.alert), false);
  assert.match(status.textContent, /تم حفظ حالة المشروع، لكن تعذر تحديث لوحة الإدارة/);
});


test('owner notification retry reports provider result even if inbox refresh fails', async () => {
  const calls = [];
  const status = { textContent: '', style: {} };
  const context = {
    LEADS: [{ id: 'lead-1', status: 'contacted' }],
    api: async (url, options) => {
      calls.push({ method: options.method, body: JSON.parse(options.body) });
      return { ownerNotifications: { email: 'accepted', whatsapp: 'failed' } };
    },
    loadIncomingLeads: async options => {
      calls.push({ refresh: options.propagate });
      throw new Error('inbox unavailable');
    },
    notificationLabel: value => value,
    $: selector => selector === '#leadsStatus' ? status : null,
    alert: message => calls.push({ alert: message })
  };
  const retry = vm.runInNewContext(functionSource('retryOwnerNotifications') + '\nretryOwnerNotifications', context);
  await retry('lead-1');

  assert.deepEqual(calls[0].body, { id: 'lead-1', status: 'contacted', retryOwnerNotifications: true });
  assert.deepEqual(calls[1], { refresh: true });
  assert.equal(calls.some(item => item.alert), false);
  assert.match(status.textContent, /تم تنفيذ طلب إعادة الإرسال، لكن تعذر تحديث قائمة الطلبات/);
});

test('customer notification retry does not conflate accepted retry with failed inbox refresh', async () => {
  const calls = [];
  const status = { textContent: '', style: {} };
  const context = {
    api: async (url, options) => {
      calls.push({ method: options.method, body: JSON.parse(options.body) });
      return { customerNotifications: { email: 'accepted', whatsapp: 'not_configured' } };
    },
    loadIncomingLeads: async options => {
      calls.push({ refresh: options.propagate });
      throw new Error('inbox unavailable');
    },
    notificationLabel: value => value,
    $: selector => selector === '#leadsStatus' ? status : null,
    alert: message => calls.push({ alert: message })
  };
  const retry = vm.runInNewContext(functionSource('retryLeadNotifications') + '\nretryLeadNotifications', context);
  await retry('lead-2');

  assert.deepEqual(calls[0].body, { id: 'lead-2', status: 'approved', retryCustomerNotifications: true });
  assert.deepEqual(calls[1], { refresh: true });
  assert.equal(calls.some(item => item.alert), false);
  assert.match(status.textContent, /تم تنفيذ طلب إعادة الإرسال، لكن تعذر تحديث قائمة الطلبات/);
});


test('owner universe polling handles failures without leaking rejected promises or masking stale data', async () => {
  const status = { textContent: '', style: {} };
  const calls = [];
  const previous = { counts: { registered: 4 } };
  const context = {
    U: previous,
    UNIVERSE_ERROR: '',
    api: async () => { throw new Error('owner universe unavailable'); },
    $: selector => selector === '#loadStatus' ? status : null,
    renderOverview: () => calls.push('overview'),
    renderCustomers: () => calls.push('customers'),
    renderProjects: () => calls.push('projects'),
    renderIntelligence: () => calls.push('intelligence')
  };
  const loadUniverse = vm.runInNewContext(functionSource('loadUniverse') + '\nloadUniverse', context);

  await assert.doesNotReject(() => loadUniverse());
  assert.equal(context.U, previous, 'the last successful snapshot remains available');
  assert.equal(context.UNIVERSE_ERROR, 'owner universe unavailable');
  assert.match(status.textContent, /آخر نسخة ناجحة/);
  assert.equal(status.style.color, '#a94b4b');
  assert.deepEqual(calls, []);
});

test('strict owner universe refresh propagates errors to the all-sections refresh report', async () => {
  const status = { textContent: '', style: {} };
  const context = {
    U: { previous: true },
    UNIVERSE_ERROR: '',
    api: async () => { throw new Error('owner API down'); },
    $: selector => selector === '#loadStatus' ? status : null
  };
  const loadUniverse = vm.runInNewContext(functionSource('loadUniverse') + '\nloadUniverse', context);
  await assert.rejects(() => loadUniverse({ propagate: true }), /owner API down/);
  assert.match(status.textContent, /آخر نسخة ناجحة/);
  assert.ok(functionSource('loadAll').includes("['بيانات الإدارة',()=>loadUniverse({propagate:true})]"));
  assert.match(functionSource('loadAll'), /بيانات الرؤية تعرض آخر نسخة ناجحة/);
});

test('pricing save adopts the exact values confirmed by the server and prevents duplicate submission', async () => {
  const calls = [];
  const button = { disabled: false };
  const status = { textContent: '' };
  const fields = {
    '#p-single': { value: '19,000 IQD' },
    '#p-basic': { value: '142,000' },
    '#p-comprehensive': { value: '252,000' },
    '#p-extended': { value: '372,000' }
  };
  const context = {
    $: selector => selector === '#savePricing' ? button : selector === '#settingsMsg' ? status : fields[selector],
    api: async (url, options) => {
      calls.push({ url, body: JSON.parse(options.body), disabledDuringRequest: button.disabled });
      return { pricing: { single: '19000', basic: '142,000', comprehensive: '252,000', extended: '372,000' } };
    }
  };
  const savePricing = vm.runInNewContext(functionSource('savePricing') + '\nsavePricing', context);
  const result = await savePricing();
  assert.deepEqual(calls[0].body, { single: '19,000 IQD', basic: '142,000', comprehensive: '252,000', extended: '372,000' });
  assert.equal(calls[0].disabledDuringRequest, true);
  assert.equal(fields['#p-single'].value, '19000');
  assert.equal(status.textContent, 'تم حفظ الأسعار وتأكيد القيم من الخادم.');
  assert.equal(button.disabled, false);
  assert.equal(result.single, '19000');
});

test('pricing save keeps entered values and clearly reports an unconfirmed save on API failure', async () => {
  const button = { disabled: false };
  const status = { textContent: '' };
  const fields = Object.fromEntries(['single','basic','comprehensive','extended'].map(key => ['#p-'+key,{value:'100'}]));
  const context = {
    $: selector => selector === '#savePricing' ? button : selector === '#settingsMsg' ? status : fields[selector],
    api: async () => { throw new Error('storage unavailable'); }
  };
  const savePricing = vm.runInNewContext(functionSource('savePricing') + '\nsavePricing', context);
  const result = await savePricing();
  assert.equal(result, null);
  assert.equal(fields['#p-single'].value, '100');
  assert.match(status.textContent, /لم يتم تأكيد حفظ الأسعار: storage unavailable/);
  assert.equal(button.disabled, false);
});
