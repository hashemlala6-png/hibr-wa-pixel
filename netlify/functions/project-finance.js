'use strict';

const { getStore, connectLambda } = require('@netlify/blobs');
const { requireAdmin, json } = require('./auth-utils');
const { getProjectFinancials } = require('./project-financials');

const clean = (value, max = 160) => String(value == null ? '' : value).trim().slice(0, max);

async function readAll(store, prefix) {
  const rows = [];
  let cursor;
  do {
    const page = await store.list({ prefix, limit: 100, cursor });
    for (const blob of page.blobs || []) {
      const item = await store.get(blob.key, { type: 'json' }).catch(() => null);
      if (item) rows.push(item);
    }
    cursor = page.cursor;
  } while (cursor);
  return rows;
}

function chooseNextStep(financial, latestPreview, finalDelivered) {
  if (!financial.contractSigned) return 'contract';
  if (!financial.depositMet) return 'deposit';
  if (!latestPreview) return 'preview';
  const decision = latestPreview.clientApproval?.decision;
  if (decision === 'needs_changes') return 'revision';
  if (decision !== 'approved') return 'client_approval';
  if (!financial.fullyPaid) return 'balance';
  if (!finalDelivered) return 'final';
  if (!finalDelivered.confirmedHandoff) return 'handoff';
  return 'completed';
}

exports.handler = async event => {
  connectLambda(event);
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  const denied = requireAdmin(event);
  if (denied) return denied;
  if (event.httpMethod !== 'GET') return json(405, { error: 'Method not allowed' });

  const projectId = clean(event.queryStringParameters?.projectId, 120);
  if (!projectId) return json(400, { error: 'اختاري المشروع أولاً.' });

  try {
    const [project, deliveries] = await Promise.all([
      getStore({ name: 'hbpx-projects', consistency: 'strong' }).get(projectId, { type: 'json' }),
      readAll(getStore({ name: 'hbpx-deliveries', consistency: 'strong' }), 'delivery-')
    ]);
    if (!project) return json(404, { error: 'المشروع غير موجود.' });

    const [financial] = await Promise.all([getProjectFinancials(projectId, project.amount)]);
    const projectDeliveries = deliveries.filter(item => item.projectId === projectId);
    const previews = projectDeliveries
      .filter(item => item.stage === 'preview')
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    const latestPreview = previews[0] || null;
    const latestFinal = projectDeliveries
      .filter(item => item.stage === 'final' && item.status === 'delivered'
        && item.fullQuality === true && item.watermarked === false && item.rightsTransferred === true)
      .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0))[0] || null;
    const confirmedHandoff = latestFinal ? {
      id: latestFinal.id,
      title: latestFinal.title || '',
      deliveredAt: latestFinal.updatedAt || latestFinal.createdAt
    } : null;
    return json(200, {
      project: {
        id: project.id,
        name: project.name || project.title || 'مشروع',
        status: project.status || 'planned'
      },
      financial,
      latestPreview: latestPreview ? {
        id: latestPreview.id,
        title: latestPreview.title || '',
        createdAt: latestPreview.createdAt || null,
        clientApproval: latestPreview.clientApproval || null
      } : null,
      latestPreviewApproval: latestPreview?.clientApproval?.decision || 'pending',
      latestFinal: confirmedHandoff,
      nextStep: chooseNextStep(financial, latestPreview, confirmedHandoff ? { ...confirmedHandoff, confirmedHandoff: true } : null),
      counts: {
        previews: previews.length,
        finalDeliveries: projectDeliveries.filter(item => item.stage === 'final').length,
        recordedPayments: financial.paymentCount
      },
      disclaimer: 'الملخص يعتمد على سجلات الوكالة. لا يتصل بمصرف أو مزود دفع، ولا ينفذ إجراءً خارجياً.'
    });
  } catch (error) {
    console.error('project finance summary failed', error);
    return json(500, { error: 'تعذر إعداد الملخص المالي للمشروع.' });
  }
};
