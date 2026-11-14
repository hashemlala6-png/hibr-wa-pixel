'use strict';

const fs = require('node:fs');
const path = require('node:path');

const allowedContexts = new Set([
  'production',
  'deploy-preview',
  'branch-deploy',
  'dev'
]);

const context = String(process.env.CONTEXT || '').trim().toLowerCase();
const branch = String(process.env.BRANCH || '').trim();

if (!allowedContexts.has(context)) {
  throw new Error(
    'Unsupported or missing Netlify CONTEXT. Refusing to build without an explicit deploy context.'
  );
}

if ((context === 'deploy-preview' || context === 'branch-deploy') && !branch) {
  throw new Error(
    'Netlify BRANCH is required for preview/branch storage isolation.'
  );
}

const deployment = {
  context,
  branch: branch || (context === 'production' ? 'main' : 'dev')
};

const outputDir = process.env.HBPX_DEPLOY_CONTEXT_OUTPUT_DIR
  ? path.resolve(process.env.HBPX_DEPLOY_CONTEXT_OUTPUT_DIR)
  : path.resolve(__dirname, '..', 'netlify', 'functions');

fs.mkdirSync(outputDir, { recursive: true });

const outputPath = path.join(outputDir, '.netlify-deploy-context.json');
fs.writeFileSync(outputPath, JSON.stringify(deployment, null, 2) + '\n', {
  encoding: 'utf8',
  mode: 0o600
});

console.log('Prepared Netlify deploy context for isolated Blobs stores:', context);
