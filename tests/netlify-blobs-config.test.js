'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { blobOptions, DEFAULT_NETLIFY_SITE_ID } = require('../netlify/functions/blob-config');

function withEnv(values, run) {
  const names = ['NETLIFY_SITE_ID', 'SITE_ID', 'NETLIFY_AUTH_TOKEN'];
  const before = Object.fromEntries(names.map(name => [name, process.env[name]]));
  try {
    for (const name of names) {
      if (Object.prototype.hasOwnProperty.call(values, name)) process.env[name] = values[name];
      else delete process.env[name];
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
