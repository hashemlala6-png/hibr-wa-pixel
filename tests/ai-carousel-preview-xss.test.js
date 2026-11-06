'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('AI carousel preview escapes provider text, errors, slide IDs and image data before HTML insertion', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'admin.html'), 'utf8');
  const renderStart = html.indexOf("$('#aiSlides').innerHTML=slides.map");
  const renderEnd = html.indexOf('const generatedCount=', renderStart);
  assert.ok(renderStart >= 0 && renderEnd > renderStart, 'AI carousel renderer block must exist');
  const renderer = html.slice(renderStart, renderEnd);
  assert.match(renderer, /<div class="meta" style="margin-top:8px">\$\{esc\(s\.overlay_text_arabic\|\|''\)\}<\/div>/);
  assert.match(renderer, /\$\{esc\(s\.error\|\|'تعذر توليد الصورة'\)\}/);
  assert.match(renderer, /\$\{esc\(s\.slide\)\}/);
  assert.match(renderer, /<img src="\$\{esc\(s\.image_base64\)\}"/);
  assert.equal(renderer.includes('${s.overlay_text_arabic||\'\'}'), false);
  assert.equal(renderer.includes('${s.error||\'تعذر توليد الصورة\'}'), false);
});
