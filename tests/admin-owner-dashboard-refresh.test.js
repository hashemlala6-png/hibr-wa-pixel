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
  const matcher = new RegExp('(?:async\\\\s+)?function\\\\s+' + name + '\\\\s*\\\\([^)]*\\\\)\\\\s*\\\\{');
  const match = matcher.exec(script);
  assert.ok(match, 'Missing function: ' + name);

  const open = script.indexOf('{', match.index);
  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

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
      } else if (char === '\\\\') {
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
    if (char === '"' || char === "'" || char === '\`') {
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
    const source = functionSource(name);
    assert.match(source, /\{propagate=false\}=\{\}/, name + ' should support strict refresh mode');
    assert.match(source, /if\(propagate\)throw e;/, name + ' should rethrow in strict mode');
  }

  assert.match(functionSource('loadIncomingLeads'), /\{propagate=false\}=\{\}/);
  assert.match(functionSource('loadIncomingLeads'), /if\(propagate\)throw e;/);
  assert.match(functionSource('loadSystemHealth'), /\{propagate=false\}=\{\}/);
  assert.match(functionSource('loadSystemHealth'), /if\(propagate\)throw e;/);
});
