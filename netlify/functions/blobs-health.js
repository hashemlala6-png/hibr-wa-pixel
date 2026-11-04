'use strict';
const crypto = require('crypto');
const { getStore, connectLambda } = require('@netlify/blobs');
const { requireAdmin, json } = require('./auth-utils');

const STORE_NAMES = [
  'hbpx-leads',
  'hbpx-projects',
  'hbpx-payments',
  'hbpx-client-accounts',
  'hbpx-deliveries',
  'hbpx-private-deliveries'
];

exports.handler = async event => {
  connectLambda(event);
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed' });
  const denied = requireAdmin(event);
  if (denied) return denied;

  const stores = {};
  for (const name of STORE_NAMES) {
    try {
      const result = await getStore({ name, consistency: 'strong' }).list({ limit: 1 });
      stores[name] = { ok: true, readable: true, listed: Array.isArray(result.blobs) };
    } catch (error) {
      stores[name] = { ok: false, readable: false, error: String(error?.message || 'تعذر الوصول إلى المخزن').slice(0, 240) };
    }
  }

  let writeTest = { ok: false };
  const probe = getStore({ name: 'hbpx-health-checks', consistency: 'strong' });
  const key = 'probe-' + Date.now() + '-' + crypto.randomBytes(5).toString('hex');
  try {
    await probe.set(key, 'ok');
    const value = await probe.get(key, { type: 'text' });
    if (value !== 'ok') throw new Error('لم تتطابق قراءة اختبار الكتابة');
    await probe.delete(key);
    writeTest = { ok: true, write: true, read: true, delete: true };
  } catch (error) {
    await probe.delete(key).catch(() => {});
    writeTest = { ok: false, error: String(error?.message || 'فشل اختبار التخزين').slice(0, 240) };
  }

  const failedStores = Object.entries(stores).filter(([, value]) => !value.ok).map(([name]) => name);
  return json(writeTest.ok && failedStores.length === 0 ? 200 : 503, {
    ok: writeTest.ok && failedStores.length === 0,
    blobsWriteReadDelete: writeTest,
    stores,
    environment: {
      netlifySiteIdPresent: Boolean(process.env.NETLIFY_SITE_ID || process.env.SITE_ID),
      netlifyAuthTokenPresent: Boolean(process.env.NETLIFY_AUTH_TOKEN)
    },
    checkedAt: new Date().toISOString()
  });
};
