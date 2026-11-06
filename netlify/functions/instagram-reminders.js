const { getStore, connectLambda } = require('@netlify/blobs');
const { env } = require('./env');
const { blobOptions } = require('./blob-config');

const CONTENT_STORE = 'hbpx-instagram-content';
const NOTIFICATION_STORE = 'hbpx-owner-notifications';

function store(name) {
  return getStore(blobOptions(name, 'eventual'));
}

async function listDue(now) {
  const content = store(CONTENT_STORE);
  const due = [];
  let cursor;
  do {
    const page = await content.list({ prefix: 'post-', limit: 100, cursor });
    for (const blob of page.blobs || []) {
      const item = await content.get(blob.key, { type: 'json' }).catch(() => null);
      if (!item || item.status !== 'approved' || item.publishStatus === 'published' || item.reminderSentAt || !item.plannedAt) continue;
      const planned = new Date(item.plannedAt).getTime();
      if (Number.isFinite(planned) && planned <= now) due.push({ key: blob.key, item });
    }
    cursor = page.cursor;
  } while (cursor && due.length < 500);
  return due.slice(0, 100);
}

exports.handler = async event => {
  connectLambda(event);
  const now = Date.now();
  const content = store(CONTENT_STORE);
  const notifications = store(NOTIFICATION_STORE);
  let notified = 0, skipped = 0;
  try {
    const due = await listDue(now);
    for (const { key, item } of due) {
      const notificationKey = 'notification-instagram-' + item.id;
      const stamp = new Date(now).toISOString();
      const format = ({
        IMAGE: 'منشور صورة',
        CAROUSEL: 'كاروسيل',
        REEL: 'Reel',
        STORY: 'Story'
      })[item.format] || 'محتوى Instagram';
      const notification = {
        id: notificationKey,
        clientId: item.clientId || '',
        type: 'instagram-reminder',
        label: 'موعد محتوى Instagram: ' + String(item.title || format).slice(0, 160),
        details: {
          postId: item.id,
          format,
          plannedAt: item.plannedAt,
          action: 'افتحي استوديو المحتوى وراجعي المنشور قبل النشر اليدوي.',
          published: false,
          externalAction: false
        },
        createdAt: stamp,
        read: false
      };
      try {
        // Deterministic key makes retries idempotent if the following content
        // update fails after the notification has already been written.
        await notifications.setJSON(notificationKey, notification);
        item.reminderSentAt = stamp;
        item.reminderNotificationKey = notificationKey;
        item.updatedAt = item.updatedAt || stamp;
        await content.setJSON(key, item);
        notified++;
      } catch (error) {
        skipped++;
        console.error('Instagram reminder failed for ' + item.id, error?.message || error);
      }
    }
    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        checkedAt: new Date(now).toISOString(),
        due: due.length,
        notified,
        skipped,
        mode: 'owner-reminder-only',
        publishingEnabled: false
      })
    };
  } catch (error) {
    console.error('Instagram scheduled reminders failed', error?.message || error);
    return {
      statusCode: 500,
      body: JSON.stringify({ ok: false, error: 'تعذر فحص مواعيد محتوى Instagram.' })
    };
  }
};
