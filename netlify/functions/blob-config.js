'use strict';

const crypto = require('node:crypto');
const { env } = require('./env');

const DEFAULT_NETLIFY_SITE_ID = '76bd352d-826a-49dc-8f0f-5f576610b1ae';
const ALLOWED_CONTEXTS = new Set([
  'production',
  'deploy-preview',
  'branch-deploy',
  'dev',
  'local'
]);

function normalizeScope(scope) {
  const context = String(scope?.context || '').trim().toLowerCase();
  const branch = String(scope?.branch || '').trim() || 'unknown';

  if (!ALLOWED_CONTEXTS.has(context)) {
    throw new Error('Unsupported Netlify deploy context for Blobs isolation.');
  }

  return { context, branch };
}

function deploymentScope() {
  // This file is generated at build time from Netlify's CONTEXT and BRANCH
  // variables. Those build-only variables are not assumed to exist at
  // Functions runtime.
  let generated;
  try {
    generated = require('./.netlify-deploy-context.json');
  } catch (error) {
    if (error?.code !== 'MODULE_NOT_FOUND') throw error;
  }

  if (generated) return normalizeScope(generated);

  // Explicit overrides are useful for local development and isolated tests.
  // On a deployed Netlify Function, fail closed if the build metadata is absent.
  const overrideContext = env('HBPX_BLOBS_CONTEXT');
  if (!overrideContext && (env('SITE_ID') || env('URL'))) {
    throw new Error(
      'Netlify deploy context metadata is missing. Refusing to access shared Blobs stores.'
    );
  }

  return normalizeScope({
    context: overrideContext || 'local',
    branch: env('HBPX_BLOBS_BRANCH') || 'local'
  });
}

function truncateUtf8(value, maxBytes) {
  let result = '';
  for (const character of String(value)) {
    if (Buffer.byteLength(result + character, 'utf8') > maxBytes) break;
    result += character;
  }
  return result;
}

function scopedStoreName(name, scope = deploymentScope()) {
  const base = String(name || '').trim();
  if (!base || /[/:]/.test(base)) {
    throw new Error('Invalid Netlify Blobs store name.');
  }

  const { context, branch } = normalizeScope(scope);
  if (context === 'production') {
    if (Buffer.byteLength(base, 'utf8') > 64) {
      throw new Error('Netlify Blobs store names cannot exceed 64 bytes.');
    }
    // Keep every existing production store name unchanged so customer data
    // remains in its current location; no migration or data rewrite occurs.
    return base;
  }

  const label = context === 'deploy-preview'
    ? 'preview'
    : context === 'branch-deploy'
      ? 'branch'
      : 'dev';
  const digest = crypto
    .createHash('sha256')
    .update(context + '\0' + branch)
    .digest('hex')
    .slice(0, 10);
  const suffix = '--' + label + '-' + digest;
  const safeBase = truncateUtf8(base, 64 - Buffer.byteLength(suffix, 'utf8'));

  if (!safeBase) throw new Error('Unable to create a valid isolated Blobs store name.');
  return safeBase + suffix;
}

function blobOptions(name, consistency = 'strong') {
  const options = {
    name: scopedStoreName(name),
    consistency
  };
  const siteID = env('NETLIFY_SITE_ID') || env('SITE_ID') || DEFAULT_NETLIFY_SITE_ID;
  const token = env('NETLIFY_AUTH_TOKEN');

  // Never pass a site ID without its matching server-side token. In normal
  // Netlify Functions deployments connectLambda supplies the request context.
  if (token) {
    options.siteID = siteID;
    options.token = token;
  }

  return options;
}

module.exports = {
  blobOptions,
  deploymentScope,
  scopedStoreName,
  DEFAULT_NETLIFY_SITE_ID
};
