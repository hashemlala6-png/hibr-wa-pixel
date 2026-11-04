const crypto = require('crypto');
const { getStore, connectLambda } = require('@netlify/blobs');
const { requireAdmin, json } = require('./auth-utils');

const STORE = 'hbpx-instagram-content';
const PREFIX = 'post-';
const FORMATS = ['IMAGE', 'CAROUSEL', 'REEL', 'STORY'];
const STATUSES = ['draft', 'needs_changes', 'pending_approval', 'approved', 'rejected'];

function store() {
  return getStore({ name: STORE, consistency: 'eventual' });
}
function clean(value, max = 2000) {
  return String(value == null ? '' : value).trim().slice(0, max);
}
function normalizeFormat(value) {
  const x = clean(value, 20).toUpperCase();
  return FORMATS.includes(x) ? x : 'IMAGE';
}
function normalizeMedia(value) {
  const input = Array.isArray(value) ? value : String(value == null ? '' : value).split(/\r?\n/);
  const urls = [];
  for (const raw of input) {
    const text = clean(raw, 2048);
    if (!text) continue;
    let u;
    try { u = new URL(text); } catch { throw new Error('أحد روابط الوسائط غير صالح. استخدمي روابط HTTPS كاملة.'); }
    if (u.protocol !== 'https:' || !u.hostname || u.username || u.password) {
      throw new Error('روابط الوسائط يجب أن تكون HTTPS ومن دون بيانات دخول داخل الرابط.');
    }
    if (!urls.includes(u.toString())) urls.push(u.toString());
  }
  if (urls.length > 10) throw new Error('الحد الأقصى للوسائط في المسودة الواحدة هو 10 روابط.');
  return urls;
}
function normalizePlannedAt(value) {
  const v = clean(value, 60);
  if (!v) return null;
  const date = new Date(v);
  if (!Number.isFinite(date.getTime())) throw new Error('موعد النشر المقترح غير صالح.');
  return date.toISOString();
}
function normalizePayload(body) {
  const title = clean(body.title, 180);
  const caption = clean(body.caption, 2200);
  if (!caption) throw new Error('نص المنشور مطلوب.');
  const format = normalizeFormat(body.format);
  const mediaUrls = normalizeMedia(body.mediaUrls);
  if (format === 'IMAGE' && mediaUrls.length > 1) throw new Error('المنشور المفرد يقبل رابط صورة واحداً فقط.');
  if (format === 'CAROUSEL' && mediaUrls.length < 2) throw new Error('الكاروسيل يحتاج رابطين للوسائط على الأقل.');
  if (['REEL', 'STORY'].includes(format) && mediaUrls.length > 1) throw new Error('هذا النوع يقبل رابط وسيط واحداً في المسودة الحالية.');
  return {
    title: title || caption.split(/\r?\n/)[0].slice(0, 100) || 'مسودة Instagram',
    caption,
    format,
    mediaUrls,
    altText: clean(body.altText, 1000),
    plannedAt: normalizePlannedAt(body.plannedAt),
    clientId: clean(body.clientId, 120),
    source: clean(body.source, 40) || 'owner'
  };
}
async function readAll() {
  const s = store();
  const out = [];
  let cursor;
  do {
    const page = await s.list({ prefix: PREFIX, limit: 100, cursor });
    for (const item of page.blobs || []) {
      const value = await s.get(item.key, { type: 'json' }).catch(() => null);
      if (value) out.push(value);
    }
    cursor = page.cursor;
  } while (cursor);
  return out.sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));
}

exports.handler = async event => {
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  connectLambda(event);
  const denied = requireAdmin(event);
  if (denied) return denied;
  try {
    const s = store();
    if (event.httpMethod === 'GET') {
      const items = await readAll();
      return json(200, {
        items,
        policy: {
          approvalRequired: true,
          approvedMeansOwnerAuthorizedOnly: true,
          publishingEnabled: false,
          schedulingIsReminderOnly: true,
          externalActionsExecuted: false
        }
      });
    }
    let body = {};
    try { body = JSON.parse(event.body || '{}'); }
    catch { return json(400, { error: 'بيانات الطلب غير صالحة.' }); }

    if (event.httpMethod === 'POST') {
      const payload = normalizePayload(body);
      const now = new Date().toISOString();
      const id = PREFIX + Date.now() + '-' + crypto.randomBytes(5).toString('hex');
      const item = {
        id,
        ...payload,
        status: 'draft',
        createdAt: now,
        updatedAt: now,
        submittedAt: null,
        approvedAt: null,
        decisionNote: '',
        publishedAt: null,
        externalAction: false
      };
      await s.setJSON(id, item);
      return json(201, { item, message: 'تم حفظ المسودة داخل النظام فقط.' });
    }

    if (event.httpMethod === 'PATCH') {
      const id = clean(body.id, 180);
      const action = clean(body.action, 40);
      if (!id || !id.startsWith(PREFIX)) return json(400, { error: 'معرّف المسودة غير صالح.' });
      const item = await s.get(id, { type: 'json' });
      if (!item) return json(404, { error: 'المسودة غير موجودة.' });
      const now = new Date().toISOString();

      if (action === 'update') {
        if (!['draft', 'needs_changes', 'rejected'].includes(item.status)) {
          return json(409, { error: 'لا يمكن تعديل هذه المسودة بعد اعتمادها أو أثناء انتظار المراجعة.' });
        }
        const payload = normalizePayload(body);
        Object.assign(item, payload, { status: 'draft', decisionNote: '', updatedAt: now });
        await s.setJSON(id, item);
        return json(200, { item, message: 'تم تحديث المسودة وإعادتها إلى حالة المسودة.' });
      }

      if (action === 'submit') {
        if (!['draft', 'needs_changes', 'rejected'].includes(item.status)) return json(409, { error: 'هذه المسودة ليست جاهزة لإرسالها للمراجعة.' });
        item.status = 'pending_approval';
        item.submittedAt = now;
        item.updatedAt = now;
        item.decisionNote = '';
        await s.setJSON(id, item);
        return json(200, { item, message: 'أُرسلت المسودة إلى قائمة مراجعة المالكة. لم يتم نشرها.' });
      }

      if (action === 'approve') {
        if (item.status !== 'pending_approval') return json(409, { error: 'لا يمكن اعتماد المسودة قبل إرسالها للمراجعة.' });
        item.status = 'approved';
        item.approvedAt = now;
        item.updatedAt = now;
        item.decisionNote = clean(body.note, 1000);
        item.approvedBy = 'owner';
        await s.setJSON(id, item);
        return json(200, {
          item,
          published: false,
          message: 'سُجل اعتماد المالكة فقط. لم يُنشر المحتوى ولم يُرسل أي شيء إلى Instagram.'
        });
      }

      if (action === 'request_changes') {
        if (item.status !== 'pending_approval') return json(409, { error: 'هذه المسودة ليست بانتظار المراجعة.' });
        item.status = 'needs_changes';
        item.updatedAt = now;
        item.decisionNote = clean(body.note, 1000);
        await s.setJSON(id, item);
        return json(200, { item, message: 'سُجلت ملاحظات التعديل. لم يتم أي نشر.' });
      }

      if (action === 'delete') {
        if (!['draft', 'needs_changes', 'rejected'].includes(item.status)) return json(409, { error: 'لا يمكن حذف مسودة بانتظار المراجعة أو معتمدة.' });
        await s.delete(id);
        return json(200, { ok: true, deleted: id });
      }
      return json(400, { error: 'الإجراء غير معروف.' });
    }
    return json(405, { error: 'Method not allowed' });
  } catch (error) {
    return json(400, { error: clean(error.message || 'تعذر حفظ محتوى Instagram.', 400) });
  }
};
