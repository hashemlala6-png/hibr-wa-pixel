'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { adminPassword, createSession, verifySession } = require('../netlify/functions/session-core');

const keys = ['ADMIN_PASSWORD', 'ADMIN_PREVIEW_PASSWORD', 'ADMIN_SESSION_SECRET'];
const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));

test.after(() => {
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

test('Deploy Preview password takes priority without replacing the Production password', () => {
  process.env.ADMIN_PASSWORD = 'production-test-only';
  process.env.ADMIN_PREVIEW_PASSWORD = 'preview-test-only';
  assert.equal(adminPassword(), 'preview-test-only');
  assert.equal(process.env.ADMIN_PASSWORD, 'production-test-only');
});

test('admin session signs and verifies with the preview password fallback', () => {
  delete process.env.ADMIN_SESSION_SECRET;
  process.env.ADMIN_PASSWORD = 'production-test-only';
  process.env.ADMIN_PREVIEW_PASSWORD = 'preview-test-only';

  const token = createSession('admin', 'admin', 60);
  const event = { headers: { cookie: `hbpx_admin=${encodeURIComponent(token)}` } };
  assert.equal(verifySession(event, 'admin', 'hbpx_admin').role, 'admin');
});

test('Production keeps using ADMIN_PASSWORD when no preview password is present', () => {
  delete process.env.ADMIN_PREVIEW_PASSWORD;
  process.env.ADMIN_PASSWORD = 'production-test-only';
  assert.equal(adminPassword(), 'production-test-only');
});
