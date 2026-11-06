'use strict';

const { getStore, connectLambda } = require('@netlify/blobs');
const { blobOptions } = require('./blob-config');
const { json } = require('./auth-utils');
const { getClientSession } = require('./client-auth-utils');
const { ownsProject } = require('./client-ownership');
const { logActivity } = require('./client-activity');

const stores = {
  accounts: () => getStore(blobOptions('hbpx-client-accounts', 'strong')),
  projects: () => getStore(blobOptions('hbpx-projects', 'strong')),
  leads: () => getStore(blobOptions('hbpx-leads', 'strong')),
  deliveries: () => getStore(blobOptions('hbpx-deliveries', 'strong'))
};
const clean = (value, max = 1000) => String(value == null ? '' : value).trim().slice(0, max);

async function readAllDeliveries() {
  const store = stores.deliveries();
  const records = [];
  const seen = new Set();
  let cursor;
  do {
    const page = await store.list({ prefix: 'delivery-', limit: 100, cursor });
    for (const blob of page.blobs || []) {
      const record = await store.get(blob.key, { type: 'json' });
      if (record) records.push(record);
    }
    const next = page.cursor || null;
    if (next && (next === cursor || seen.has(next))) {
      throw new Error('Repeated Netlify Blobs cursor while reading deliveries');
    }
    if (next) seen.add(next);
    cursor = next;
  } while (cursor);
  return records;
}

function latestFirst(a, b) {
  const aTime = new Date(a.createdAt || 0).getTime() || 0;
  const bTime = new Date(b.createdAt || 0).getTime() || 0;
  return bTime - aTime || String(b.id || '').localeCompare(String(a.id || ''));
}

exports.handler = async event => {
  connectLambda(event);
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  const session = getClientSession(event);
  if (!session) return json(401, { error: 'سجّل الدخول أولاً.', code: 'LOGIN_REQUIRED' });

  let body = {};
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'بيانات القرار غير صالحة.' }); }

  const deliveryId = clean(body.deliveryId, 180);
  const decision = clean(body.decision, 30);
  const note = clean(body.note, 1000);
  if (!deliveryId || !deliveryId.startsWith('delivery-') || !['approved', 'needs_changes'].includes(decision)) {
    return json(400, { error: 'معرّف المعاينة أو القرار غير صالح.' });
  }
  if (decision === 'needs_changes' && note.length < 5) {
    return json(400, { error: 'اكتبي ملاحظة قصيرة توضّح التعديل المطلوب.' });
  }

  try {
    const account = await stores.accounts().get(session.sub, { type: 'json' });
    if (!account) return json(401, { error: 'الحساب غير موجود. سجّل الدخول من جديد.' });
    const delivery = await stores.deliveries().get(deliveryId, { type: 'json' });
    if (!delivery || delivery.stage !== 'preview') return json(404, { error: 'المعاينة غير موجودة ضمن حسابك.' });
    const project = await stores.projects().get(delivery.projectId, { type: 'json' });
    if (!project) return json(404, { error: 'المشروع المرتبط بالمعاينة غير موجود.' });
    const lead = project.leadId ? await stores.leads().get(project.leadId, { type: 'json' }) : null;
    if (!ownsProject(project, account, lead)) return json(404, { error: 'المعاينة غير موجودة ضمن حسابك.' });

    const previews = (await readAllDeliveries())
      .filter(item => item?.projectId === project.id && item.stage === 'preview')
      .sort(latestFirst);
    const latestPreview = previews[0] || null;
    if (!latestPreview || latestPreview.id !== deliveryId) {
      return json(409, {
        error: 'هذه معاينة سابقة. افتحي أحدث معاينة ظاهرة في مساحة العميل لاتخاذ القرار عليها.',
        latestPreviewId: latestPreview?.id || null
      });
    }

    if (delivery.clientApproval?.decision === 'approved') {
      return json(409, { error: 'تم اعتماد هذه المعاينة مسبقاً. لا يمكن تغيير قرارها؛ انتظري النسخة النهائية أو نسخة معاينة جديدة.' });
    }

    const now = new Date().toISOString();
    const approval = {
      decision,
      note,
      at: now,
      accountId: account.id,
      accountName: clean(account.name, 160)
    };
    const history = Array.isArray(delivery.clientApprovalHistory) ? delivery.clientApprovalHistory : [];
    delivery.clientApprovalHistory = [...history, approval].slice(-20);
    delivery.clientApproval = approval;
    delivery.updatedAt = now;
    await stores.deliveries().setJSON(deliveryId, delivery);

    await logActivity(account.id, 'delivery-approval',
      decision === 'approved' ? 'اعتماد العميل لمعاينة المحتوى' : 'طلب العميل تعديلات على المعاينة',
      { projectId: project.id, deliveryId, decision, note, ownerActionRequired: true });

    return json(200, {
      ok: true,
      deliveryId,
      decision,
      decidedAt: now,
      finalDeliveryRequiresFullPayment: decision === 'approved',
      message: decision === 'approved'
        ? 'تم اعتماد المعاينة. تبقى الملفات النهائية ونقل الحقوق حتى سداد كامل المبلغ واعتماد الجودة.'
        : 'تم إرسال طلب التعديل إلى فريق الوكالة.'
    });
  } catch (error) {
    console.error('client delivery approval error', error);
    return json(500, { error: 'تعذر حفظ قرار المعاينة.' });
  }
};
