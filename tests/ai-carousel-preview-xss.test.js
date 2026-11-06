'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('AI carousel preview escapes provider text, errors, slide IDs and image data before HTML insertion', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
  assert.match(html, /<div class="meta" style="margin-top:8px">\$\{esc\(s\.overlay_text_arabic\|\|''\)\}<\/div>/);
  assert.match(html, /\$\{esc\(s\.error\|\|'تعذر توليد الصورة'\)\}/);
  assert.match(html, /\$\{esc\(s\.slide\)\}/);
  assert.match(html, /<img src="\$\{esc\(s\.image_base64\)\}"/);
  assert.equal(html.includes('${s.overlay_text_arabic||\'\'}'), false);
  assert.equal(html.includes('${s.error||\'تعذر توليد الصورة\'}'), false);
});
