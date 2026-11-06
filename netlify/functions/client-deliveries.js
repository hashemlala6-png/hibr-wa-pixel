'use strict';

const { getStore, connectLambda } = require('@netlify/blobs');
const { json } = require('./auth-utils');
const { getClientSession } = require('./client-auth-utils');
const { ownsProject } = require('./client-ownership');
const { logActivity } = require('./client-activity');

const stores = {
  accounts: () => getStore({ name: 'hbpx-client-accounts', consistency: 'strong' }),
  projects: () => getStore({ name: 'hbpx-projects', consistency: 'strong' }),
  leads: () => getStore({ name: 'hbpx-leads', consistency: 'strong' }),
  deliveries: () => getStore({ name: 'hbpx-deliveries', consistency: 'strong' })
};
const clean = (value, max = 1000) => String(value == null ? '' : value).trim().slice(0, max);

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
    const account = await stores.accounts().get(session.sub, { type: 'json' }).catch(() => null);
    if (!account) return json(401, { error: 'الحساب غير موجود. سجّل الدخول من جديد.' });
    const delivery = await stores.deliveries().get(deliveryId, { type: 'json' }).catch(() => null);
    if (!delivery || delivery.stage !== 'preview') return json(404, { error: 'المعاينة غير موجودة ضمن حسابك.' });
    const project = await stores.projects().get(delivery.projectId, { type: 'json' }).catch(() => null);
    if (!project) return json(404, { error: 'المشروع المرتبط بالمعاينة غير موجود.' });
    const lead = project.leadId ? await stores.leads().get(project.leadId, { type: 'json' }).catch(() => null) : null;
    if (!ownsProject(project, account, lead)) return json(404, { error: 'المعاينة غير موجودة ضمن حسابك.' });

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
