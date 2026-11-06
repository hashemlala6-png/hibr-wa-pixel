'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

test('Instagram setup guide accurately describes owner-confirmed inbox replies', () => {
  const guide = fs.readFileSync(path.join(__dirname, '..', 'INSTAGRAM_SETUP_AR.md'), 'utf8');
  assert.match(guide, /إرسال الرد يدوياً بعد تأكيد المالكة/);
  assert.match(guide, /نافذة المراسلة القياسية البالغة 24 ساعة/);
  assert.match(guide, /لا توجد ردود تلقائية/);
  assert.match(guide, /INSTAGRAM_WEBHOOK_VERIFY_TOKEN/);
  assert.doesNotMatch(guide, /لا يرسل هذا المسار رسائل أو ردود تعليقات/);
  assert.doesNotMatch(guide, /\\n\\n##/);
});
