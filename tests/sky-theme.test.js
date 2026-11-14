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
    '.brand-work-art',
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


test('experience stylesheet defines a real hierarchy for the home, owner console and client workspace', () => {
  const css = fs.readFileSync(path.join(root, 'hibr-sky-theme.css'), 'utf8');
  for (const selector of [
    '.hp-home-hero:before',
    '.hp-home-art',
    '.hp-home-page-grid>a:hover',
    '#app .today.command-banner',
    '#app #tabs button.active',
    '#app .desk-brief',
    '#app .stat:hover',
    '.cw-welcome',
    '.cw-project-finance',
    '.cw-lane',
    '#lock .lockbox'
  ]) {
    assert.ok(css.includes(selector), 'Missing experience treatment: ' + selector);
  }
  assert.match(css, /@media\(max-width:700px\)/);
  assert.match(css, /prefers-reduced-motion:reduce/);
});

test('owner dashboard and client workspace have separate layout treatments, not just color overrides', () => {
  const css = fs.readFileSync(path.join(root, 'hibr-sky-theme.css'), 'utf8');
  assert.ok(css.includes('#app>.shell{'));
  assert.ok(css.includes('grid-template-columns:230px minmax(0,1fr)'));
  assert.ok(css.includes('.cw-stat-strip{'));
  assert.ok(css.includes('gap:11px!important'));
  assert.ok(css.includes('grid-template-columns:minmax(0,.9fr) minmax(0,1.1fr)'));
  assert.ok(css.includes('.hp-home-page-grid{'));
  assert.ok(css.includes('grid-template-columns:repeat(3,minmax(0,1fr))'));
});

test('homepage hero shows an actual workspace preview with navigation, projects and next-step panels', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  for (const selector of [
    'hp-workspace-preview',
    'hp-preview-rail',
    'hp-preview-kpis',
    'hp-preview-projects',
    'hp-preview-side'
  ]) {
    assert.ok(html.includes(selector), 'Missing workspace preview component: ' + selector);
  }
});
