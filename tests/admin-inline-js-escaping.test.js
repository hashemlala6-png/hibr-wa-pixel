'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[char]);
}

function jsArg(value) {
  return escapeHtml(JSON.stringify(String(value ?? '')));
}

function decodeHtmlAttribute(value) {
  return value.replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

test('admin inline handlers pass dynamic IDs as HTML-escaped JSON string literals', () => {
  assert.match(source, /const jsArg=v=>esc\(JSON\.stringify\(String\(v\?\?''\)\)\);/);
  assert.match(source, /openClient\(\$\{jsArg\(x\.id\)\}\)/);
  assert.match(source, /leadStatus\('\+jsArg\(x\.id\)\+'/);
  assert.match(source, /orderStatus\(\$\{jsArg\(o\.id\)\},this\.value\)/);
  assert.match(source, /projectStatus\('\+jsArg\(p\.id\)\+'/);
  assert.match(source, /taskStatus\('\+jsArg\(t\.id\)\+'/);
  assert.match(source, /selectAIClient\(\$\{jsArg\(x\.clientId\|\|x\.id\)\}\)/);\n  assert.doesNotMatch(source, /document\.getElementById\('aiClient'\)\.value=/);
  assert.doesNotMatch(source, /openClient\('\$\{esc\(x\.id\)\}'\)/);
  assert.doesNotMatch(source, /orderStatus\('\$\{esc\(o\.id\)\}'/);
});

test('hostile dynamic IDs remain a single inert JavaScript argument after HTML attribute decoding', () => {
  const payloads = [
    "x'); attacker(); ('y",
    "\"><img src=x onerror=attacker()>",
    "backslash\\quote\"and\\nline",
    "</button><script>attacker()</script>"
  ];
  for (const payload of payloads) {
    const attributeSource = decodeHtmlAttribute('openClient(' + jsArg(payload) + ')');
    let received;
    let attacked = false;
    vm.runInNewContext('(' + attributeSource + ')', {
      openClient(value) { received = value; },
      attacker() { attacked = true; }
    });
    assert.equal(received, payload);
    assert.equal(attacked, false);
  }
});
