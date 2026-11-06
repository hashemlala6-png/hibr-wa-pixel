'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function loadReminder(initial) {
  const resolved = require.resolve('../netlify/functions/instagram-reminders');
  delete require.cache[resolved];
  const originalLoad = Module._load;
  const stores = initial;
  let connectedEvent = null;

  const blobs = {
    connectLambda(event) { connectedEvent = event; },
    getStore({ name }) {
      if (!stores[name]) stores[name] = {};
      const data = stores[name];
      return {
        async list({ prefix = '' } = {}) {
          return { blobs: Object.keys(data).filter(key => key.startsWith(prefix)).map(key => ({ key })) };
        },
        async get(key) { return clone(data[key] ?? null); },
        async setJSON(key, value) { data[key] = clone(value); }
      };
    }
  };

  Module._load = function(request, parent, isMain) {
    if (request === '@netlify/blobs') return blobs;
    if (request === './env' && parent && parent.filename === resolved) {
      return { env() { return undefined; } };
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  try {
    const handler = require(resolved).handler;
    return { handler, stores, getConnectedEvent: () => connectedEvent };
  } finally {
    Module._load = originalLoad;
    delete require.cache[resolved];
  }
}

test('scheduled Instagram reminders create internal owner alerts only for due approved content', async () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  const future = new Date(Date.now() + 60 * 60_000).toISOString();
  const initial = {
    'hbpx-instagram-content': {
      'post-approved-due': {
        id: 'post-approved-due',
        title: 'منشور معتمد',
        format: 'IMAGE',
        status: 'approved',
        plannedAt: past,
        clientId: 'agency'
      },
      'post-draft-due': {
        id: 'post-draft-due',
        title: 'مسودة',
        format: 'IMAGE',
        status: 'draft',
        plannedAt: past
      },
      'post-published-due': {
        id: 'post-published-due',
        title: 'منشور سبق نشره',
        format: 'REEL',
        status: 'approved',
        publishStatus: 'published',
        plannedAt: past
      },
      'post-reminded-due': {
        id: 'post-reminded-due',
        title: 'تنبيه سابق',
        format: 'CAROUSEL',
        status: 'approved',
        reminderSentAt: past,
        plannedAt: past
      },
      'post-approved-future': {
        id: 'post-approved-future',
        title: 'منشور مستقبلي',
        format: 'IMAGE',
        status: 'approved',
        plannedAt: future
      }
    },
    'hbpx-owner-notifications': {}
  };
  const service = loadReminder(initial);
  const event = { headers: { host: 'fabulous-bublanina-8d5626.netlify.app' }, httpMethod: 'GET' };
  const originalFetch = global.fetch;
  let externalCalls = 0;
  global.fetch = async () => { externalCalls++; throw new Error('Scheduled reminders must not publish or call external APIs'); };

  try {
    const response = await service.handler(event);
    const body = JSON.parse(response.body || '{}');
    assert.equal(response.statusCode, 200);
    assert.equal(body.ok, true);
    assert.equal(body.due, 1);
    assert.equal(body.notified, 1);
    assert.equal(body.skipped, 0);
    assert.equal(body.mode, 'owner-reminder-only');
    assert.equal(body.publishingEnabled, false);
    assert.equal(service.getConnectedEvent(), event);

    const notification = service.stores['hbpx-owner-notifications']['notification-instagram-post-approved-due'];
    assert.ok(notification);
    assert.equal(notification.type, 'instagram-reminder');
    assert.equal(notification.details.published, false);
    assert.equal(notification.details.externalAction, false);
    assert.equal(service.stores['hbpx-instagram-content']['post-approved-due'].reminderSentAt !== undefined, true);

    assert.equal(service.stores['hbpx-instagram-content']['post-draft-due'].reminderSentAt, undefined);
    assert.equal(service.stores['hbpx-instagram-content']['post-published-due'].reminderSentAt, undefined);
    assert.equal(externalCalls, 0);
  } finally {
    global.fetch = originalFetch;
  }
});
