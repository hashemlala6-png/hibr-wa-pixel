'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const sourceFile = path.join(__dirname, '..', 'netlify', 'functions', 'instagram-oauth.js');

test('Instagram connect and disconnect activity is recorded under the agency identity', () => {
  const code = fs.readFileSync(sourceFile, 'utf8');
  assert.match(code, /const AGENCY_ACTIVITY_ID\s*=\s*['"]hibr-wa-pixel['"]/);
  assert.equal((code.match(/logActivity\(AGENCY_ACTIVITY_ID,\s*['"]integration['"]/g) || []).length, 2);
  assert.doesNotMatch(code, /logActivity\(\s*['"]['"]\s*,\s*['"]integration['"]/);
});
