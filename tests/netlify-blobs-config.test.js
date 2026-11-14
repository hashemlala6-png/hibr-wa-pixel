'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  blobOptions,
  deploymentScope,
  scopedStoreName,
  DEFAULT_NETLIFY_SITE_ID
} = require('../netlify/functions/blob-config');

function withEnv(values, run) {
  const names = [
    'NETLIFY_SITE_ID',
    'SITE_ID',
    'URL',
    'NETLIFY_AUTH_TOKEN',
    'HBPX_BLOBS_CONTEXT',
    'HBPX_BLOBS_BRANCH'
  ];
  const before = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const defaults = {
    HBPX_BLOBS_CONTEXT: 'production',
    HBPX_BLOBS_BRANCH: 'main'
  };

  try {
    for (const name of names) {
      if (Object.prototype.hasOwnProperty.call(values, name)) {
        if (values[name] == null) delete process.env[name];
        else process.env[name] = values[name];
      } else if (Object.prototype.hasOwnProperty.call(defaults, name)) {
        process.env[name] = defaults[name];
      } else {
        delete process.env[name];
      }
    }
    run();
  } finally {
    for (const name of names) {
      if (before[name] === undefined) delete process.env[name];
      else process.env[name] = before[name];
    }
  }
}

test('Blobs uses the known project site ID when only the server token is configured', () => {
  withEnv({ NETLIFY_AUTH_TOKEN: 'test-server-token' }, () => {
    assert.deepEqual(blobOptions('hbpx-leads'), {
      name: 'hbpx-leads',
      consistency: 'strong',
      siteID: DEFAULT_NETLIFY_SITE_ID,
      token: 'test-server-token'
    });
  });
});

test('Blobs respects explicit Netlify site ID and SITE_ID fallback', () => {
  withEnv({ NETLIFY_SITE_ID: 'explicit-site', NETLIFY_AUTH_TOKEN: 'test-token' }, () => {
    assert.equal(blobOptions('hbpx-leads').siteID, 'explicit-site');
  });
  withEnv({ SITE_ID: 'fallback-site', NETLIFY_AUTH_TOKEN: 'test-token' }, () => {
    assert.equal(blobOptions('hbpx-leads').siteID, 'fallback-site');
  });
});

test('Blobs does not pass explicit credentials when no server token exists', () => {
  withEnv({}, () => {
    const options = blobOptions('hbpx-leads', 'eventual');
    assert.deepEqual(options, { name: 'hbpx-leads', consistency: 'eventual' });
  });
});

test('production Blobs store names stay unchanged to preserve existing customer data', () => {
  assert.equal(
    scopedStoreName('hbpx-leads', { context: 'production', branch: 'main' }),
    'hbpx-leads'
  );
});

test('Deploy Preview stores are stable per branch and isolated between branches', () => {
  const first = scopedStoreName('hbpx-client-accounts', {
    context: 'deploy-preview',
    branch: 'fix/client-account-identity-consistency'
  });
  const repeated = scopedStoreName('hbpx-client-accounts', {
    context: 'deploy-preview',
    branch: 'fix/client-account-identity-consistency'
  });
  const otherBranch = scopedStoreName('hbpx-client-accounts', {
    context: 'deploy-preview',
    branch: 'feature/customer-journey-experience'
  });
  const branchDeploy = scopedStoreName('hbpx-client-accounts', {
    context: 'branch-deploy',
    branch: 'fix/client-account-identity-consistency'
  });

  assert.equal(first, repeated);
  assert.notEqual(first, otherBranch);
  assert.notEqual(first, branchDeploy);
  assert.match(first, /^hbpx-client-accounts--preview-[a-f0-9]{10}$/);
});

test('preview blobOptions apply the isolated namespace', () => {
  withEnv({
    HBPX_BLOBS_CONTEXT: 'deploy-preview',
    HBPX_BLOBS_BRANCH: 'fix/isolation-check'
  }, () => {
    assert.match(blobOptions('hbpx-leads').name, /^hbpx-leads--preview-[a-f0-9]{10}$/);
    assert.equal(deploymentScope().context, 'deploy-preview');
  });
});

test('non-production store names never exceed the Netlify 64-byte limit', () => {
  const longName = 'a'.repeat(64);
  const result = scopedStoreName(longName, {
    context: 'deploy-preview',
    branch: 'feature/a-very-long-branch-name'
  });
  assert.ok(Buffer.byteLength(result, 'utf8') <= 64);
  assert.match(result, /--preview-[a-f0-9]{10}$/);
});

test('deployed Functions fail closed when deploy context metadata is missing', () => {
  withEnv({ SITE_ID: 'netlify-site-id', HBPX_BLOBS_CONTEXT: null }, () => {
    assert.throws(
      () => deploymentScope(),
      /Netlify deploy context metadata is missing/
    );
  });
});

test('every direct Netlify Blobs consumer uses the shared credential configuration', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const functionsDir = path.join(__dirname, '..', 'netlify', 'functions');
  const files = fs.readdirSync(functionsDir).filter(file => file.endsWith('.js'));
  const missing = [];

  for (const file of files) {
    const source = fs.readFileSync(path.join(functionsDir, file), 'utf8');
    const importsBlobs = /require\(['"]@netlify\/blobs['"]\)/.test(source);
    const createsStore = /\b(?:getStore|getBlobStore)\s*\(/.test(source);
    const usesSharedConfig = /require\(['"]\.\/blob-config['"]\)/.test(source);
    if (importsBlobs && createsStore && !usesSharedConfig) missing.push(file);
  }

  assert.deepEqual(
    missing,
    [],
    'All direct Netlify Blobs consumers must use the shared blob-config helper.'
  );
});
