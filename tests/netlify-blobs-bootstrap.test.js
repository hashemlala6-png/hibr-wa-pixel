'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const functionsDir = path.join(__dirname, '..', 'netlify', 'functions');

test('every Lambda function using Netlify Blobs initializes its event context', () => {
  const files = fs.readdirSync(functionsDir).filter(file => file.endsWith('.js'));
  const missing = [];

  // These functions access Netlify Blobs through ai-context.js rather than importing getStore directly.
  const indirectBlobConsumers = new Set(['generate.js', 'generate-carousel-images.js']);

  for (const file of files) {
    const source = fs.readFileSync(path.join(functionsDir, file), 'utf8');
    const usesBlobsDirectly = /\bgetStore\s*\(/.test(source);
    if ((!usesBlobsDirectly && !indirectBlobConsumers.has(file)) || !/exports\.handler\s*=/.test(source)) continue;

    const handler = source.match(/exports\.handler\s*=\s*async\s*(?:\(([^)]*)\)|([A-Za-z_$][\w$]*))\s*=>\s*\{([\s\S]{0,500})/);
    const parameters = handler?.[1] || handler?.[2] || '';
    const bodyStart = handler?.[3] || '';
    const contextArg = bodyStart.match(/\bconnectLambda\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/)?.[1];
    const declaredParameters = parameters.split(',').map(parameter => parameter.trim().split(/[=\s]/)[0]).filter(Boolean);
    if (!contextArg || !declaredParameters.includes(contextArg)) missing.push(file);
  }

  assert.deepEqual(
    missing,
    [],
    'Each Lambda handler that accesses Netlify Blobs must call connectLambda(event) before store access.'
  );
});
