'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  adminPassword,
  isDeployPreview,
  createSession,
  verifySession
} = require('../netlify/functions/session-core');

const keys = ['ADMIN_PASSWORD', 'ADMIN_PREVIEW_PASSWORD', 'ADMIN_SESSION_SECRET'];
const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));

test.after(() => {
  for (const key of keys) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

const previewEvent = {
  headers: { host: 'deploy-preview-4--fabulous-bublanina-8d5626.netlify.app' }
};
const productionEvent = {
  headers: { host: 'fabulous-bublanina-8d5626.netlify.app' }
};

test('recognizes the exact Netlify Deploy Preview host', () => {
  assert.equal(isDeployPreview(previewEvent), true);
  assert.equal(isDeployPreview(productionEvent), false);
  assert.equal(isDeployPreview({ rawUrl: 'https://deploy-preview-4--fabulous-bublanina-8d5626.netlify.app/admin.html' }), true);
});

test('Deploy Preview and Production use the existing ADMIN_PASSWORD', () => {
  process.env.ADMIN_PASSWORD = 'owner-test-only';
  process.env.ADMIN_PREVIEW_PASSWORD = 'obsolete-preview-test-only';
  assert.equal(adminPassword(previewEvent), 'owner-test-only');
  assert.equal(adminPassword(productionEvent), 'owner-test-only');
});

test('preview sessions stay isolated while Production signatures remain unchanged', () => {
  process.env.ADMIN_PASSWORD = 'owner-test-only';
  process.env.ADMIN_SESSION_SECRET = 'shared-session-test-secret';
  const previewToken = createSession('admin', 'admin', 60, previewEvent);
  const productionToken = createSession('admin', 'admin', 60, productionEvent);

  const previewWithCookie = { ...previewEvent, headers: { ...previewEvent.headers, cookie: 'hbpx_admin=' + encodeURIComponent(previewToken) } };
  const productionWithCookie = { ...productionEvent, headers: { ...productionEvent.headers, cookie: 'hbpx_admin=' + encodeURIComponent(productionToken) } };
  assert.equal(verifySession(previewWithCookie, 'admin', 'hbpx_admin').role, 'admin');
  assert.equal(verifySession(productionWithCookie, 'admin', 'hbpx_admin').role, 'admin');

  const previewCookieOnProduction = { ...productionEvent, headers: { ...productionEvent.headers, cookie: 'hbpx_admin=' + encodeURIComponent(previewToken) } };
  const productionCookieOnPreview = { ...previewEvent, headers: { ...previewEvent.headers, cookie: 'hbpx_admin=' + encodeURIComponent(productionToken) } };
  assert.equal(verifySession(previewCookieOnProduction, 'admin', 'hbpx_admin'), null);
  assert.equal(verifySession(productionCookieOnPreview, 'admin', 'hbpx_admin'), null);
});
