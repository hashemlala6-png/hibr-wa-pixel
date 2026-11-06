// Shared Netlify Blobs credentials for functions that need an explicit
// site/token fallback. connectLambda(event) must still run at handler entry
// so Netlify's request context remains the primary source of credentials.
const { env } = require('./env');

const DEFAULT_NETLIFY_SITE_ID = '76bd352d-826a-49dc-8f0f-5f576610b1ae';

function blobOptions(name, consistency = 'strong') {
  const options = { name, consistency };
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

module.exports = { blobOptions, DEFAULT_NETLIFY_SITE_ID };
