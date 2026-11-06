'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
const script = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
  .map(match => match[1]).join('\n');

function functionLine(name) {
  const line = script.split('\n').find(value =>
    value.startsWith('async function ' + name + '(') ||
    value.startsWith('function ' + name + '(')
  );
  assert.ok(line, 'Missing function: ' + name);
  return line;
}

test('owner refresh includes the lead inbox and asks optional loaders to propagate failures', () => {
  const source = functionLine('loadAll');
  assert.match(source, /\['طلبات العملاء',\(\)=>loadIncomingLeads\(\{propagate:true\}\)\]/);
  for (const name of ['loadGrowth', 'loadPresence', 'loadNotifications', 'loadPricing', 'loadOps', 'loadSystemHealth']) {
    assert.match(source, new RegExp('\\(\\)=>' + name + '\\(\\{propagate:true\\}\\)'));
  }
  assert.match(source, /اكتمل التحديث جزئياً/);
  assert.match(source, /تعذر تحديثها/);
});

test('owner refresh renders cross-dependent views after every section settles', async () => {
  const source = functionLine('loadAll');
  const calls = [];
  const status = { textContent: '', style: {} };
  const context = {
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
  assert.deepEqual(calls.slice(-7), [
    'renderOverview', 'renderCustomers', 'renderSales', 'renderProjects',
    'renderGrowth', 'renderIntelligence', 'renderActivity'
  ]);
});

test('dashboard loaders expose swallowed failures when strict refresh mode is requested', () => {
  for (const name of ['loadGrowth', 'loadPresence', 'loadNotifications', 'loadPricing', 'loadOps']) {
    const line = functionLine(name);
    assert.match(line, /\{propagate=false\}=\{\}/, name + ' should support strict refresh mode');
    assert.match(line, /if\(propagate\)throw e;/, name + ' should rethrow in strict mode');
  }

  assert.match(script, /async function loadIncomingLeads\(\{propagate=false\}=\{\}\)/);
  assert.match(script, /async function loadSystemHealth\(\{propagate=false\}=\{\}\)/);
});
