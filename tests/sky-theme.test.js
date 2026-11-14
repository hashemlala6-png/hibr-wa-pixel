'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const pages = [
  'index.html',
  'services.html',
  'portfolio.html',
  'process.html',
  'contact.html',
  'onboarding.html',
  'order.html',
  'login.html',
  'account.html',
  'admin.html',
  'admin-agreements.html',
  'company-os.html',
  'ceo-brain.html',
  'ceo-tasks.html',
  'owner-companion.html',
  'monitoring.html',
  'review-center.html',
  'instagram.html',
  'instagram-content.html',
  'instagram-inbox.html',
  'instagram-insights.html',
  'policy.html'
];

test('all customer, owner and specialist pages load the same unified theme after their page styles', () => {
  for (const page of pages) {
    const html = fs.readFileSync(path.join(root, page), 'utf8');
    const themeAt = html.indexOf('hibr-sky-theme.css');
    assert.notEqual(themeAt, -1, page + ' must load the unified sky theme');
    assert.ok(html.toLowerCase().indexOf('</head>') > themeAt, page + ' must load the theme inside head');
    const priorStyles = [...html.matchAll(/<link\b[^>]*rel=["']stylesheet["'][^>]*>/gi)]
      .filter(match => match.index < themeAt);
    assert.ok(priorStyles.length > 0 || page === 'company-os.html',
      page + ' should preserve page-specific styles before the shared theme');
  }
});

test('shared theme defines the requested sky blue, white and black palette', () => {
  const css = fs.readFileSync(path.join(root, 'hibr-sky-theme.css'), 'utf8');
  for (const token of [
    '--hp-sky:#27b5df',
    '--hp-sky-soft:#eaf8fd',
    '--hp-white:#fff',
    '--hp-black:#111820'
  ]) {
    assert.ok(css.includes(token), 'Missing palette token: ' + token);
  }
});

test('shared theme overrides old accents in public, client, owner and showcase interfaces', () => {
  const css = fs.readFileSync(path.join(root, 'hibr-sky-theme.css'), 'utf8');
  for (const selector of [
    '.hp-wa,.wa',
    '.brand-art-card',
    '.brand-pillar',
    '.cw-welcome',
    '.cw-result-note',
    '.concept-lab',
    '.concept-art-sticker',
    '#app .command-banner',
    '.lockbox:before'
  ]) {
    assert.ok(css.includes(selector), 'Missing legacy-accent override: ' + selector);
  }
});
