const { getStore } = require('@netlify/blobs');
const { requireAdmin, json } = require('./auth-utils');
const store = () => getStore({ name: 'hbpx-settings', consistency: 'strong' });
const DEFAULTS = {
  single: '19,000', basic: '142,000', comprehensive: '252,000', extended: '372,000'
};
exports.handler = async (event) => {
  if (event.httpMethod === 'GET') {
    const saved = await store().get('pricing', { type: 'json' });
    return json(200, { pricing: { ...DEFAULTS, ...(saved || {}) } });
  }
  const auth = requireAdmin(event);
  if (auth) return auth;
  if (event.httpMethod === 'PUT') {
    let b; try { b = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'بيانات غير صالحة' }); }
    const pricing = {};
    for (const k of Object.keys(DEFAULTS)) pricing[k] = String(b[k] ?? DEFAULTS[k]).replace(/[^0-9,]/g, '').slice(0, 20) || DEFAULTS[k];
    await store().setJSON('pricing', pricing);
    return json(200, { pricing });
  }
  return json(405, { error: 'Method not allowed' });
};
