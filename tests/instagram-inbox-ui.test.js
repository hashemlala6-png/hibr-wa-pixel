'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const page = path.join(__dirname, '..', 'instagram-inbox.html');

test('Instagram inbox exposes webhook setup and keeps hidden setup panels actually hidden', () => {
  const html = fs.readFileSync(page, 'utf8');
  assert.match(html, /\.hidden\s*\{\s*display\s*:\s*none\s*!important\s*\}/);
  assert.match(html, /id="callbackSetup"[^>]*class="[^"]*hidden/);
  assert.match(html, /id="subscriptionStatus"/);
  assert.match(html, /id="subscribeWebhooks"[^>]*disabled/);
  assert.match(html, /\?action=webhook_subscription/);
});

test('Instagram account webhook activation requires verified callback and an explicit owner confirmation', () => {
  const html = fs.readFileSync(page, 'utf8');
  const start = html.indexOf("$('subscribeWebhooks').addEventListener('click'");
  const end = html.indexOf("\n });", start);
  assert.notEqual(start, -1, 'webhook activation handler must exist');
  assert.notEqual(end, -1, 'webhook activation handler must have a clear boundary');

  const action = html.slice(start, end);
  assert.match(html, /if\(!verification\?\.verifiedForCurrentConfig\)/);
  assert.match(action, /if\(!confirm\(/);
  assert.match(action, /api\('POST',\{action:'subscribe_webhooks'\}\)/);
  assert.match(action, /لن يرسل أي رسالة أو تعليق/);
});


test('inbox sends a saved reply only through a distinct owner-confirmed action', () => {
  const html = fs.readFileSync(page, 'utf8');
  assert.match(html, /data-send=/);
  assert.match(html, /action:'send_reply',id,confirmed:true/);
  assert.match(html, /if\(!confirm\(warning\)\)return/);
  assert.match(html, /رد علني على التعليق/);
  assert.match(html, /إرسال رسالة خاصة/);
});
