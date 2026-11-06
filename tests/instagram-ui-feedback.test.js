'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const page = path.join(__dirname, '..', 'instagram.html');

test('Instagram connection page preserves action feedback when refreshing status', () => {
  const html = fs.readFileSync(page, 'utf8');
  const start = html.indexOf('async function load(){');
  const end = html.indexOf("\n}\n$('connect').onclick", start);

  assert.notEqual(start, -1, 'connection status loader must exist');
  assert.notEqual(end, -1, 'connection status loader must have a clear boundary');

  const loader = html.slice(start, end);
  assert.doesNotMatch(
    loader,
    /\$\('actionStatus'\)\.textContent\s*=\s*['"]['"]\s*;/,
    'status refresh must not erase the connect/verify/refresh/disconnect result'
  );
  assert.match(html, /params\.get\('connected'\)/, 'OAuth success feedback must remain wired');
  assert.match(html, /params\.get\('instagram_error'\)/, 'OAuth error feedback must remain wired');
});
