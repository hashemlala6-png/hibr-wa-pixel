'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const scriptPath = path.join(__dirname, '..', 'scripts', 'write-netlify-deploy-context.js');
const generatedFile = '.netlify-deploy-context.json';

test('build script writes deploy-preview context and branch without secrets', () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hbpx-context-'));

  try {
    const result = spawnSync(process.execPath, [scriptPath], {
      encoding: 'utf8',
      env: {
        ...process.env,
        CONTEXT: 'deploy-preview',
        BRANCH: 'fix/client-account-identity-consistency',
        HBPX_DEPLOY_CONTEXT_OUTPUT_DIR: outputDir
      }
    });

    assert.equal(result.status, 0, result.stderr);
    const saved = JSON.parse(
      fs.readFileSync(path.join(outputDir, generatedFile), 'utf8')
    );
    assert.deepEqual(saved, {
      context: 'deploy-preview',
      branch: 'fix/client-account-identity-consistency'
    });
    assert.equal(JSON.stringify(saved).includes('TOKEN'), false);
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('build script preserves production context for existing customer stores', () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hbpx-context-'));

  try {
    const result = spawnSync(process.execPath, [scriptPath], {
      encoding: 'utf8',
      env: {
        ...process.env,
        CONTEXT: 'production',
        BRANCH: 'main',
        HBPX_DEPLOY_CONTEXT_OUTPUT_DIR: outputDir
      }
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      JSON.parse(fs.readFileSync(path.join(outputDir, generatedFile), 'utf8')),
      { context: 'production', branch: 'main' }
    );
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});

test('build script fails closed when Netlify deploy context is missing or unsupported', () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hbpx-context-'));

  try {
    const result = spawnSync(process.execPath, [scriptPath], {
      encoding: 'utf8',
      env: {
        ...process.env,
        CONTEXT: 'unknown-preview',
        BRANCH: 'some-branch',
        HBPX_DEPLOY_CONTEXT_OUTPUT_DIR: outputDir
      }
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unsupported or missing Netlify CONTEXT/);
    assert.equal(fs.existsSync(path.join(outputDir, generatedFile)), false);
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});
