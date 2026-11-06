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


test('owner dashboard boot is idempotent when session check and manual login finish together', async () => {
  const calls = [];
  const lock = { classList: { add: name => calls.push(['lock', name]) } };
  const app = { classList: { remove: name => calls.push(['app', name]) } };
  const clock = { textContent: '' };
  const context = {
    ownerBootPromise: null,
    $: selector => selector === '#lock' ? lock : selector === '#app' ? app : selector === '#clock' ? clock : null,
    loadAll: async () => { calls.push('loadAll'); await Promise.resolve(); },
    heartbeat: () => calls.push('heartbeat'),
    loadPresence: () => calls.push('presence'),
    loadUniverse: () => calls.push('universe'),
    setInterval: (fn, ms) => { calls.push(['interval', ms]); return calls.length; },
    dt: () => 'now'
  };
  const show = vm.runInNewContext(functionSource('show') + '\nshow', context);
  await Promise.all([show(), show()]);
  assert.equal(calls.filter(item => item === 'loadAll').length, 1);
  assert.equal(calls.filter(item => Array.isArray(item) && item[0] === 'interval').length, 4);
  assert.equal(calls.filter(item => item === 'heartbeat').length, 1);
});

test('owner logout verifies the session is gone before reloading the dashboard', async () => {
  const calls = [];
  const button = { disabled: false, textContent: 'خروج' };
  const status = { textContent: '', style: {} };
  const context = {
    $: selector => selector === '#logout' ? button : selector === '#loadStatus' ? status : null,
    fetch: async url => {
      calls.push(url);
      return { ok: true, json: async () => url.includes('action=logout') ? { authenticated: false } : { authenticated: false } };
    },
    location: { reload: () => calls.push('reload') }
  };
  const logoutOwner = vm.runInNewContext(functionSource('logoutOwner') + '\nlogoutOwner', context);
  await logoutOwner();
  assert.deepEqual(calls, [
    '/.netlify/functions/auth?action=logout',
    '/.netlify/functions/auth?action=me',
    'reload'
  ]);
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, 'خروج');
});

test('owner logout keeps the owner informed and does not reload when server still reports an active session', async () => {
  const calls = [];
  const button = { disabled: false, textContent: 'خروج' };
  const status = { textContent: '', style: {} };
  const context = {
    $: selector => selector === '#logout' ? button : selector === '#loadStatus' ? status : null,
    fetch: async url => {
      calls.push(url);
      return { ok: true, json: async () => url.includes('action=logout') ? { authenticated: false } : { authenticated: true } };
    },
    location: { reload: () => calls.push('reload') }
  };
  const logoutOwner = vm.runInNewContext(functionSource('logoutOwner') + '\nlogoutOwner', context);
  await logoutOwner();
  assert.equal(calls.includes('reload'), false);
  assert.match(status.textContent, /لم يتم تأكيد إغلاق الجلسة/);
  assert.equal(status.style.color, '#a94b4b');
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, 'خروج');
});


test('AI Studio serializes generation and draft actions and always unlocks controls', async () => {
  const selectors = ['#aiGenerate','#resultGenerate','#reviseText','#saveInstagramDraft','#sendAIReview','#aiClient','#aiMode','#aiTopic','#aiTone','#aiTextType','#aiCarouselSlideCount','#resultObjective','#resultOffer','#revInstruction','#revMode'];
  const controls = Object.fromEntries(selectors.map(key => [key, { disabled: false }]));
  const reviewStatus = { textContent: '' }, busyStatus = { textContent: '' }, output = { textContent: 'previous result' };
  const context = {
    AI_STUDIO_BUSY: false,
    $: selector => selector === '#aiReviewStatus' ? reviewStatus : selector === '#aiBusy' ? busyStatus : selector === '#aiOutput' ? output : controls[selector],
    setAIBusy: message => { busyStatus.textContent = message || ''; output.textContent = ''; }
  };
  const helpers = vm.runInNewContext(functionSource('beginAIStudioAction') + '\n' + functionSource('endAIStudioAction') + '\n({beginAIStudioAction,endAIStudioAction})', context);
  assert.equal(helpers.beginAIStudioAction('جاري التوليد…', true), true);
  assert.equal(context.AI_STUDIO_BUSY, true);
  assert.equal(output.textContent, '');
  assert.equal(selectors.every(selector => controls[selector].disabled), true);
  assert.equal(helpers.beginAIStudioAction('عملية ثانية', false), false);
  assert.match(reviewStatus.textContent, /هناك عملية أخرى قيد التنفيذ/);
  helpers.endAIStudioAction();
  assert.equal(context.AI_STUDIO_BUSY, false);
  assert.equal(selectors.every(selector => controls[selector].disabled === false), true);
});

test('AI Studio lock preserves the current result during upload and owner review', () => {
  const controls = Object.fromEntries(['#aiGenerate','#resultGenerate','#reviseText','#saveInstagramDraft','#sendAIReview'].map(key => [key,{disabled:false}]));
  const output = {textContent:'approved draft'}, busy = {textContent:''};
  const context = {
    AI_STUDIO_BUSY:false,
    $: selector => selector==='#aiOutput'?output:selector==='#aiBusy'?busy:controls[selector],
    setAIBusy: () => { output.textContent=''; }
  };
  const begin = vm.runInNewContext(functionSource('beginAIStudioAction')+'\nbeginAIStudioAction',context);
  assert.equal(begin('جارٍ الحفظ…',false),true);
  assert.equal(output.textContent,'approved draft');
});


test('AI revision sends the captured current output before acquiring the busy lock', async () => {
  const calls = [];
  const fields = {
    '#aiBusy': { textContent: '' },
    '#aiOutput': { textContent: 'النص الأصلي الذي يجب تعديله' },
    '#revInstruction': { value: 'عدّل العنوان فقط' },
    '#revMode': { value: 'writing' },
    '#aiTopic': { value: 'حملة تعريفية' },
    '#aiClient': { value: 'client-a', options: [{value:'client-a'}] }
  };
  const context = {
    AI_STUDIO_BUSY: false,
    AI_OUTPUT_CLIENT_ID: 'client-a',
    $: selector => fields[selector] || {disabled:false},
    selectedAIClient: () => 'client-a',
    assertAIOutputClient: id => id,
    beginAIStudioAction: (message, clearOutput) => {
      assert.equal(clearOutput, false, 'revision must not clear its source output');
      context.AI_STUDIO_BUSY = true;
      fields['#aiBusy'].textContent = message;
      return true;
    },
    endAIStudioAction: () => { context.AI_STUDIO_BUSY = false; },
    api: async (url, options) => {
      calls.push({url,body:JSON.parse(options.body)});
      return {text:'النص المعدل مع الحفاظ على بقية المحتوى'};
    }
  };
  const revise = vm.runInNewContext(functionSource('reviseCurrent')+'\nreviseCurrent',context);
  await revise();
  assert.equal(calls.length,1);
  assert.equal(calls[0].url,'/.netlify/functions/revise-ai');
  assert.equal(calls[0].body.currentOutput,'النص الأصلي الذي يجب تعديله');
  assert.equal(calls[0].body.clientId,'client-a');
  assert.equal(fields['#aiOutput'].textContent,'النص المعدل مع الحفاظ على بقية المحتوى');
  assert.equal(context.AI_OUTPUT_CLIENT_ID,'client-a');
  assert.equal(context.AI_STUDIO_BUSY,false);
});

test('AI revision refuses to apply a result to a different selected client', async () => {
  const calls=[];
  const fields={
    '#aiBusy':{textContent:''},
    '#aiOutput':{textContent:'نتيجة العميل الأول'},
    '#revInstruction':{value:'غيّر العنوان'},
    '#revMode':{value:'writing'},
    '#aiTopic':{value:'موضوع'},
  };
  const context={
    AI_STUDIO_BUSY:false,
    AI_OUTPUT_CLIENT_ID:'client-a',
    $:selector=>fields[selector]||{disabled:false},
    selectedAIClient:()=> 'client-b',
    assertAIOutputClient:id=>{if(id!=='client-a')throw Error('هذه النتيجة مرتبطة بعميل آخر.');return id;},
    api:async()=>{calls.push('api');}
  };
  const revise=vm.runInNewContext(functionSource('reviseCurrent')+'\nreviseCurrent',context);
  await revise();
  assert.deepEqual(calls,[]);
  assert.equal(fields['#aiOutput'].textContent,'نتيجة العميل الأول');
  assert.match(fields['#aiBusy'].textContent,/مرتبطة بعميل آخر/);
  assert.equal(context.AI_STUDIO_BUSY,false);
});

test('saving and reviewing AI output must use the client that generated that output', () => {
  const context={
    AI_OUTPUT_CLIENT_ID:'client-a',
    assertAIOutputClient: id => {
      if(String(id)!==context.AI_OUTPUT_CLIENT_ID)throw Error('النتيجة الحالية مرتبطة بعميل آخر.');
      return context.AI_OUTPUT_CLIENT_ID;
    }
  };
  const assertOwner=vm.runInNewContext(functionSource('assertAIOutputClient')+'\nassertAIOutputClient',context);
  assert.equal(assertOwner('client-a'),'client-a');
  assert.throws(()=>assertOwner('client-b'),/مرتبطة بعميل آخر/);
});


test('review gate records preserve the originating client identity for owner review', async () => {
  const Module = require('node:module');
  const resolved = require.resolve('../netlify/functions/review-gates');
  delete require.cache[resolved];
  const originalLoad = Module._load;
  const saved = {};
  const writes = [];
  const blobs = {
    connectLambda() {},
    getStore({name}) {
      return {
        async get(key) { return saved[key] ? JSON.parse(JSON.stringify(saved[key])) : null; },
        async setJSON(key,value) { saved[key]=JSON.parse(JSON.stringify(value));writes.push({key,value:saved[key]}); },
        async list({prefix=''}) { return {blobs:Object.keys(saved).filter(key=>key.startsWith(prefix)).map(key=>({key}))}; }
      };
    }
  };
  Module._load=function(request,parent,isMain){
    if(request==='@netlify/blobs')return blobs;
    if(request==='./blob-config'&&parent&&parent.filename===resolved)return {blobOptions:name=>({name})};
    if(request==='./auth-utils'&&parent&&parent.filename===resolved)return {
      requireAdmin:()=>null,
      json:(statusCode,payload)=>({statusCode,body:JSON.stringify(payload)})
    };
    return originalLoad.call(this,request,parent,isMain);
  };
  let handler;
  try { handler=require(resolved).handler; }
  finally { Module._load=originalLoad;delete require.cache[resolved]; }

  const created=await handler({
    httpMethod:'POST',
    body:JSON.stringify({
      phase:'إنتاج المحتوى',
      title:'خطة محتوى — عميل أ',
      deliverable:'خطة منشورات الأسبوع',
      criteria:'مراجعة الدقة واللغة',
      clientId:'email-client-a',
      clientName:'عميل أ'
    })
  });
  const payload=JSON.parse(created.body);
  assert.equal(created.statusCode,201);
  assert.equal(payload.item.clientId,'email-client-a');
  assert.equal(payload.item.clientName,'عميل أ');
  assert.equal(saved[payload.item.id].externalAction,false);

  const listed=await handler({httpMethod:'GET'});
  const item=JSON.parse(listed.body).items.find(x=>x.id===payload.item.id);
  assert.equal(item.clientId,'email-client-a');
  assert.equal(item.clientName,'عميل أ');
  assert.equal(writes.length,1);
});

test('review gate identity fields are optional and bounded', async () => {
  const Module = require('node:module');
  const resolved = require.resolve('../netlify/functions/review-gates');
  delete require.cache[resolved];
  const originalLoad = Module._load;
  const saved = {};
  const blobs = {
    connectLambda() {},
    getStore({name}) {
      return {
        async get(key) { return saved[key] || null; },
        async setJSON(key,value) { saved[key]=value; },
        async list({prefix=''}) { return {blobs:Object.keys(saved).filter(key=>key.startsWith(prefix)).map(key=>({key}))}; }
      };
    }
  };
  Module._load=function(request,parent,isMain){
    if(request==='@netlify/blobs')return blobs;
    if(request==='./blob-config'&&parent&&parent.filename===resolved)return {blobOptions:name=>({name})};
    if(request==='./auth-utils'&&parent&&parent.filename===resolved)return {
      requireAdmin:()=>null,
      json:(statusCode,payload)=>({statusCode,body:JSON.stringify(payload)})
    };
    return originalLoad.call(this,request,parent,isMain);
  };
  let handler;
  try { handler=require(resolved).handler; }
  finally { Module._load=originalLoad;delete require.cache[resolved]; }
  const response=await handler({
    httpMethod:'POST',
    body:JSON.stringify({phase:'مرحلة',title:'مخرج',deliverable:'محتوى'})
  });
  const item=JSON.parse(response.body).item;
  assert.equal(response.statusCode,201);
  assert.equal(item.clientId,null);
  assert.equal(item.clientName,null);
});


test('owner sales tab surfaces unallocated contract payments and their affected projects', () => {
  const source = functionSource('renderSales');
  assert.match(source, /financialSummary/);
  assert.match(source, /unallocatedPaid/);
  assert.match(source, /unallocatedProjects/);
  assert.match(source, /لا يتم نقلها آلياً/);
});

test('owner agreements screen explains and quantifies payments outside the current contract', () => {
  const agreements = fs.readFileSync(path.join(__dirname, '..', 'admin-agreements.html'), 'utf8');
  assert.match(agreements, /unallocatedPaid/);
  assert.match(agreements, /unallocatedPaymentCount/);
  assert.match(agreements, /لم تدخل في حساب العربون أو المتبقي/);
  assert.match(agreements, /contractId/);
});
