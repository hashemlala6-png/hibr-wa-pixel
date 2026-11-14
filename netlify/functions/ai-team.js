'use strict';

const crypto = require('node:crypto');
const { getStore, connectLambda } = require('@netlify/blobs');
const { requireAdmin, json } = require('./auth-utils');
const { requestText } = require('./ai-provider');
const { blobOptions } = require('./blob-config');

const tasksStore = () => getStore(blobOptions('hbpx-tasks', 'strong'));
const executionsStore = () => getStore(blobOptions('hbpx-ai-team-executions', 'strong'));
const locksStore = () => getStore(blobOptions('hbpx-ai-team-locks', 'strong'));

const clean = (value, limit = 3000) => String(value ?? '').trim().slice(0, limit);

const roleGuides = {
  'مدير العمليات': 'رتّب الأولويات، قسّم العمل إلى خطوات، وحدد الاعتماديات والمخاطر ومؤشرات الإنجاز.',
  'استراتيجي التسويق': 'حلّل السوق العراقي والجمهور المفترض بحذر، واقترح تموضعاً ورسائل وتجربة تسويقية قابلة للقياس.',
  'مخطط المحتوى': 'أنشئ خطة محتوى عملية تتضمن أفكاراً وأهدافاً وصيغاً وجدولاً مقترحاً وقنوات مناسبة.',
  'كاتب المحتوى': 'اكتب نصوصاً عربية سليمة وطبيعية مناسبة للسوق العراقي، مع نسخ جاهزة للمراجعة ودعوة واضحة للفعل.',
  'المصمم': 'أنشئ موجز تصميم احترافي قابل للتنفيذ: التكوين، الألوان، الخط، النص الدقيق، العناصر، المقاس، وملاحظات سلامة العربية. لا تدّعِ أنك أنشأت صورة.',
  'مسؤول الجودة': 'أنشئ قائمة فحص دقيقة مرتبطة بالمهمة، وحدد معايير القبول والأخطاء التي تمنع الاعتماد.',
  'مسؤول العملاء': 'حضّر مسودة تواصل مهذبة وشخصية وخطوة متابعة واحدة. لا ترسل أي رسالة.',
  'مسؤول النشر': 'جهّز حزمة نشر تشمل الكابشن والهاشتاغات والوصف والنص البديل وقائمة التحقق. لا تنشر.',
  'محلل الأداء': 'حدد المقاييس المطلوبة، وطريقة قراءتها، والفرضيات القابلة للاختبار. لا تختلق أرقاماً أو نتائج.'
};

function parseJsonObject(raw) {
  const source = String(raw || '').replace(/```(?:json)?/gi, '').trim();
  try {
    const parsed = JSON.parse(source);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {}
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const parsed = JSON.parse(source.slice(start, end + 1));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  }
  throw new Error('لم يرجع الموظف الافتراضي مخرجاً منظماً صالحاً للمراجعة.');
}

function normalizeResult(value) {
  const summary = clean(value.summary, 1200);
  const deliverable = clean(value.deliverable, 12000);
  if (!summary || !deliverable) {
    throw new Error('نتيجة الموظف ناقصة؛ يجب أن تتضمن ملخصاً ومخرجاً عملياً.');
  }
  const list = (items) => (Array.isArray(items) ? items : [])
    .slice(0, 12)
    .map(item => clean(item, 600))
    .filter(Boolean);

  return {
    summary,
    deliverable,
    steps: list(value.steps),
    assumptions: list(value.assumptions),
    ownerApproval: list(value.ownerApproval),
    qualityChecks: list(value.qualityChecks),
    blocked: value.blocked === true
  };
}

async function listExecutions() {
  const store = executionsStore();
  const page = await store.list({ prefix: 'execution-' });
  const items = [];
  for (const blob of page.blobs || []) {
    try {
      const item = await store.get(blob.key, { type: 'json' });
      if (item) items.push(item);
    } catch {}
  }
  return items
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 50);
}

async function acquireTaskLock(taskId) {
  const store = locksStore();
  const key = 'task-' + taskId;
  const now = Date.now();
  const lockValue = { taskId, createdAt: new Date(now).toISOString() };
  let result = await store.setJSON(key, lockValue, { onlyIfNew: true });

  if (result?.modified) return { store, key };

  const current = await store.get(key, { type: 'json' }).catch(() => null);
  const created = Date.parse(current?.createdAt || '');
  const stale = !Number.isFinite(created) || now - created > 15 * 60 * 1000;
  if (!stale) return null;

  await store.delete(key);
  result = await store.setJSON(key, lockValue, { onlyIfNew: true });
  return result?.modified ? { store, key } : null;
}

exports.handler = async event => {
  connectLambda(event);
  if (event.httpMethod === 'OPTIONS') return json(204, {});

  const denied = requireAdmin(event);
  if (denied) return denied;

  if (event.httpMethod === 'GET') {
    try {
      return json(200, { executions: await listExecutions() });
    } catch (error) {
      console.error('ai-team list failed:', error?.message || error);
      return json(503, { error: 'تعذر تحميل نتائج الفريق حالياً.' });
    }
  }

  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return json(400, { error: 'بيانات غير صالحة.' });
  }

  const taskId = clean(body.taskId, 160);
  if (!taskId) return json(400, { error: 'معرّف المهمة مطلوب.' });

  let task;
  try {
    task = await tasksStore().get(taskId, { type: 'json' });
  } catch (error) {
    console.error('ai-team task read failed:', error?.message || error);
    return json(503, { error: 'تعذر قراءة المهمة من التخزين حالياً.' });
  }

  if (!task || task.projectId !== 'internal-hibr') {
    return json(404, { error: 'مهمة الفريق غير موجودة.' });
  }
  if (task.status === 'done') {
    return json(409, { error: 'المهمة مكتملة بالفعل. أنشئي مهمة جديدة إذا أردتِ عملاً إضافياً.' });
  }

  const role = clean(task.assignee, 100);
  const guide = roleGuides[role];
  if (!guide) return json(400, { error: 'الدور المحدد غير معروف.' });

  let lock;
  try {
    lock = await acquireTaskLock(taskId);
  } catch (error) {
    console.error('ai-team lock failed:', error?.message || error);
    return json(503, { error: 'تعذر حجز المهمة للتنفيذ الآمن. حاولي مرة أخرى.' });
  }
  if (!lock) return json(409, { error: 'هذه المهمة قيد التنفيذ بالفعل. حدّثي القائمة قبل إعادة المحاولة.' });

  const previousStatus = task.status;
  const previousLatestExecutionId = task.latestExecutionId;
  const now = new Date().toISOString();
  try {
    task.status = 'doing';
    task.updatedAt = now;
    await tasksStore().setJSON(task.id, task);

    const prompt = [
      'أنت موظف ذكاء اصطناعي ضمن وكالة حبر وبكسل العراقية. نفّذ المهمة المحددة ضمن حدود دورك.',
      'الدور: ' + role,
      'تعليمات الدور: ' + guide,
      'المهمة: ' + clean(task.title, 500),
      'موعدها: ' + (clean(task.dueDate, 40) || 'غير محدد'),
      'تعليمات إضافية من المالكة: ' + (clean(body.instructions, 2500) || 'لا توجد'),
      'أنتج عملاً عملياً قابلاً للمراجعة، وليس وصفاً عاماً. إذا نقصت معلومات مهمة، اذكر الافتراضات والأسئلة بدلاً من اختلاقها.',
      'أخرج JSON صالحاً فقط بالشكل التالي:',
      '{"summary":"ملخص قصير","deliverable":"المخرج الكامل الجاهز للمراجعة","steps":["خطوة"],"assumptions":["افتراض"],"ownerApproval":["ما يحتاج موافقة المالكة"],"qualityChecks":["فحص"],"blocked":false}',
      'ممنوع تنفيذ أي فعل خارجي: لا إرسال رسائل، لا نشر، لا شراء، لا تواصل مع عميل، ولا تغيير بيانات عميل. لا تدّعِ تنفيذ شيء خارج هذا الرد.',
      'اكتب بالعربية الواضحة وصحح الإملاء، ولا تضع زخارف أو رموزاً غير لازمة.'
    ].join('\n');

    const generated = await requestText({
      systemPrompt: 'أنت تنفذ مهمة داخلية فقط وتلتزم بصلاحيات الدور. أخرج JSON صالحاً فقط. لا تنفذ أي فعل خارجي.',
      userPrompt: prompt,
      maxTokens: 2800,
      timeoutMs: 45000
    });

    const result = normalizeResult(parseJsonObject(generated.text));
    const createdAt = new Date().toISOString();
    const id = 'execution-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
    const record = {
      id,
      taskId,
      role,
      taskTitle: clean(task.title, 500),
      createdAt,
      model: generated.model || '',
      provider: generated.provider || '',
      fallbackUsed: generated.fallbackUsed === true,
      result,
      policy: {
        externalActionsExecuted: false,
        ownerApprovalRequired: true
      }
    };

    await executionsStore().setJSON(id, record);
    task.status = 'review';
    task.updatedAt = createdAt;
    task.latestExecutionId = id;
    await tasksStore().setJSON(task.id, task);

    return json(200, { execution: record, task, policy: record.policy });
  } catch (error) {
    console.error('ai-team execution failed:', error?.message || error);
    try {
      task.status = previousStatus || 'todo';
      task.updatedAt = new Date().toISOString();
      if (previousLatestExecutionId) task.latestExecutionId = previousLatestExecutionId;
      else delete task.latestExecutionId;
      await tasksStore().setJSON(task.id, task);
    } catch (restoreError) {
      console.error('ai-team task restore failed:', restoreError?.message || restoreError);
    }
    return json(502, { error: clean(error?.message || 'تعذر إكمال المهمة بواسطة الموظف الافتراضي.', 500) });
  } finally {
    try { await lock.store.delete(lock.key); } catch (error) {
      console.error('ai-team lock release failed:', error?.message || error);
    }
  }
};
