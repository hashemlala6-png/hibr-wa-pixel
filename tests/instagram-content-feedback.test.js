'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const page = path.join(__dirname, '..', 'instagram-content.html');

test('Instagram publishing result remains visible after refreshing the content list', () => {
  const html = fs.readFileSync(page, 'utf8');
  const start = html.indexOf('if(b.dataset.publish){');
  const end = html.indexOf("if(b.dataset.submit)", start);

  assert.notEqual(start, -1, 'publish action must exist');
  assert.notEqual(end, -1, 'publish action must end before review actions');

  const action = html.slice(start, end);
  const refresh = action.indexOf('await load();');
  const feedback = action.indexOf("$('listStatus').textContent=publishFeedback");

  assert.match(action, /let publishFeedback=''/);
  assert.match(action, /catch\(err\)\{publishFeedback=err\.message;\}/);
  assert.ok(refresh >= 0 && feedback > refresh, 'final provider feedback must be rendered after the list refresh');
});
