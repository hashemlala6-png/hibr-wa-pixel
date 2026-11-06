'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const functionsDir = path.join(__dirname, '..', 'netlify', 'functions');

test('every Lambda function using Netlify Blobs initializes its event context', () => {
  const files = fs.readdirSync(functionsDir).filter(file => file.endsWith('.js'));
  const missing = [];

  for (const file of files) {
    const source = fs.readFileSync(path.join(functionsDir, file), 'utf8');
    if (!/\bgetStore\s*\(/.test(source) || !/exports\.handler\s*=/.test(source)) continue;

    const handler = source.match(/exports\.handler\s*=\s*async\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{([\s\S]{0,500})/);
    if (!/\bconnectLambda\s*\(/.test(handler?.[1] || '')) missing.push(file);
  }

  assert.deepEqual(
    missing,
    [],
    'Each Lambda handler that accesses Netlify Blobs must call connectLambda(event) before store access.'
  );
});
