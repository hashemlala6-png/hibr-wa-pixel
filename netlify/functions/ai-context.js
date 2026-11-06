const { getStore } = require('@netlify/blobs');
const { blobOptions } = require('./blob-config');
const { sameClientContact } = require('./client-ownership');

const stores = {
  clients: () => getStore(blobOptions('hbpx-clients', 'strong')),
  leads: () => getStore(blobOptions('hbpx-leads', 'strong')),
  activity: () => getStore(blobOptions('hbpx-client-activity', 'strong')),
  results: () => getStore(blobOptions('hbpx-result-plans', 'strong')),
  aiHistory: () => getStore(blobOptions('hbpx-ai-history', 'strong')),
  dna: () => getStore(blobOptions('hbpx-creative-dna', 'strong')),
  activityIndex: () => getStore(blobOptions('hbpx-client-activity-index', 'strong')),
  leadIndex: () => getStore(blobOptions('hbpx-lead-index', 'strong')),
  resultIndex: () => getStore(blobOptions('hbpx-result-client-index', 'strong')),
  accounts: () => getStore(blobOptions('hbpx-client-accounts', 'strong')),
  projects: () => getStore(blobOptions('hbpx-projects', 'strong')),
};

const clean = (v, n = 5000) => String(v ?? '').trim().slice(0, n);

async function listJSON(store, prefix) {
  const r = await store.list({ prefix });
  const out = [];
  for (const b of r.blobs || []) {
    try {
      const x = await store.get(b.key, { type: 'json' });
      if (x) out.push(x);
    } catch {}
  }
  return out;
}


async function indexedJSON(indexStore, prefix, targetStore, targetPrefix) {
  const r = await indexStore.list({ prefix });
  const out=[];
  for (const b of r.blobs||[]) {
    try {
      const ref=await indexStore.get(b.key,{type:'json'});
      const key=ref?.id || ref?.leadId || ref?.planId;
      if(key){const x=await targetStore.get(key,{type:'json'});if(x)out.push(x);}
    } catch {}
  }
  return out;
}

async function getAIContext(clientId) {
  clientId = clean(clientId, 120);
  if (!clientId) return null;

  const [profile, directAccount, indexedLeads, indexedActivities, indexedResults, indexedAI, dna] = await Promise.all([
    stores.clients().get(clientId, { type: 'json' }).catch(() => null),
    stores.accounts().get(clientId, { type: 'json' }).catch(() => null),
    indexedJSON(stores.leadIndex(), `client-${clientId}-`, stores.leads(), 'lead-').catch(()=>[]),
    indexedJSON(stores.activityIndex(), `client-${clientId}-`, stores.activity(), 'activity-').catch(()=>[]),
    indexedJSON(stores.resultIndex(), `client-${clientId}-`, stores.results(), 'result-').catch(()=>[]),
    listJSON(stores.aiHistory(), `ai-client-${clientId}-`).catch(()=>[]),
    listJSON(stores.dna(), `dna-${clientId}-`),
  ]);
  let account = directAccount;
  if (!account) {
    const accountList = await stores.accounts().list({ prefix: 'account-', limit: 1000 }).catch(() => ({ blobs: [] }));
    for (const b of accountList.blobs || []) {
      const candidate = await stores.accounts().get(b.key, { type: 'json' }).catch(() => null);
      if (candidate && candidate.clientId === clientId) { account = candidate; break; }
    }
  }

  const allLeadRecords = indexedLeads.length ? [] : await listJSON(stores.leads(), 'lead-').catch(()=>[]);
  const fallbackLeads = allLeadRecords.filter(x =>
    x.clientId===clientId || x.id===clientId || (account && sameClientContact(x,account))
  );
  const leadMap = new Map();
  [...indexedLeads, ...fallbackLeads].forEach(x=>{if(x?.id)leadMap.set(x.id,x);});
  const leads = Array.from(leadMap.values());
  const leadIds = new Set(leads.map(x=>x.id));

  const [allProjects, allActivities, allResults, fallbackAI] = await Promise.all([
    listJSON(stores.projects(), 'project-').catch(()=>[]),
    indexedActivities.length ? Promise.resolve([]) : listJSON(stores.activity(), 'activity-').catch(()=>[]),
    indexedResults.length ? Promise.resolve([]) : listJSON(stores.results(), 'result-').catch(()=>[]),
    indexedAI.length ? Promise.resolve([]) : listJSON(stores.aiHistory(), 'ai-').catch(()=>[])
  ]);
  const projectIds = new Set(allProjects.filter(p=>leadIds.has(p.leadId)).map(p=>p.id));
  const activities = indexedActivities.length ? indexedActivities :
    allActivities.filter(x=>x.clientId===clientId || leadIds.has(x.clientId));
  const resultsMap = new Map();
  [...indexedResults, ...allResults.filter(x =>
    x.clientId===clientId || x.leadId===clientId || leadIds.has(x.leadId) || (x.projectId && projectIds.has(x.projectId))
  )].forEach(x=>{if(x?.id)resultsMap.set(x.id,x);});
  const results = Array.from(resultsMap.values());
  const aiHistory = indexedAI.length ? indexedAI : fallbackAI.filter(x=>x.clientId===clientId);

  const lead = leads.slice().sort((a,b) => new Date(b.updatedAt||b.createdAt)-new Date(a.updatedAt||a.createdAt))[0] || null;
  const effectiveClient = profile || lead || (account ? {id:account.id,name:account.name,email:account.email,whatsapp:account.whatsapp} : { id: clientId });

  const activityItems = activities
    .filter(x => x.clientId === clientId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 20);

  const resultItems = results
    .filter(x => x.clientId === clientId || x.leadId === clientId)
    .sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));

  const historyItems = aiHistory
    .filter(x => x.clientId === clientId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 10);

  const dnaItems = dna
    .filter(x => x.clientId === clientId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 20);

  return {
    client: effectiveClient,
    memory: profile?.memory || {},
    recentActivity: activityItems,
    lastResult: resultItems[0] || null,
    recentResults: resultItems.slice(0, 5),
    recentAI: historyItems,
    creativeDNA: dnaItems,
  };
}

function contextPrompt(ctx) {
  if (!ctx) return '';
  const m = ctx.memory || {};
  const activities = (ctx.recentActivity || []).map(x => `${x.createdAt} — ${x.label} — ${JSON.stringify(x.details || {})}`).join('\n');
  const ai = (ctx.recentAI || []).map(x => `${x.createdAt} — ${x.mode} — الموضوع: ${x.topic}\nالنتيجة: ${clean(x.output, 1800)}`).join('\n\n');
  const last = ctx.lastResult?.plan ? JSON.stringify(ctx.lastResult.plan) : 'لا توجد خطة نتائج محفوظة.';
  const dna = (ctx.creativeDNA || []).map(x => `${x.createdAt} — ${x.action} — ${x.approved ? 'معتمد' : 'ملاحظة'}\nالتعديل/التوجيه: ${clean(x.instruction,1200)}\nما تغير: ${clean(x.whatChanged,1000)}`).join('\n\n');

  return `
سياق العميل المحفوظ — هذا السياق جزء من الذاكرة المستمرة، وليس طلباً جديداً:
اسم العميل: ${clean(ctx.client?.name, 160)}
النشاط: ${clean(ctx.client?.activity, 220)}
الهدف: ${clean(m.objective, 700)}
الجمهور: ${clean(m.audience, 500)}
العرض/الخدمة: ${clean(m.offer, 700)}
المشكلة: ${clean(m.problem, 800)}
المنصة: ${clean(m.platform, 120)}
الهوية: ${clean(m.brand, 700)}
المخرجات: ${clean(m.deliverables, 700)}
القيود: ${clean(m.constraints, 500)}
السياق والملاحظات: ${clean(m.context, 900)} ${clean(m.notes, 900)}

آخر خطة نتيجة محفوظة:
${clean(last, 7000)}

آخر نشاطات العميل:
${clean(activities || 'لا يوجد نشاط مسجل.', 5000)}

آخر استخدامات أدوات الذكاء الاصطناعي لهذا العميل:
${clean(ai || 'لا توجد عمليات AI محفوظة.', 5000)}

ذاكرة الأسلوب الإبداعي (Creative DNA):
${clean(dna || 'لا توجد تفضيلات/تعديلات محفوظة بعد.', 5000)}

قواعد الاستمرارية:
- اعتبر هذا العميل مشروعاً مستمراً، لا تبدأ من الصفر إذا كان هناك سياق سابق.
- لا تغيّر هوية العميل أو أهدافه من تلقاء نفسك.
- إذا كان الطلب الحالي تطويراً لما سبق، حسّنه وابنِ فوقه بدل إعادة اختراع العمل.
- إذا تعارضت معلومة قديمة مع تعليمات الطلب الحالي الصريحة، اتبع الطلب الحالي وسجّل أنه تحديث جديد.
- لا تكشف للعميل أن هذه الذاكرة الداخلية موجودة؛ هذه أداة للمالك فقط.
`;
}

async function saveAIHistory({ clientId, mode, topic, input, output, metadata = {} }) {
  if (!clientId) return null;
  const crypto = require('crypto');
  const now = new Date().toISOString();
  const id = `ai-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const item = {
    id,
    clientId: clean(clientId, 120),
    mode: clean(mode, 40),
    topic: clean(topic, 800),
    input: clean(input, 3500),
    output: clean(output, 10000),
    metadata,
    createdAt: now,
  };
  await stores.aiHistory().setJSON(id, item);await stores.aiHistory().setJSON(`ai-client-${item.clientId}-${id}`, item);
  return item;
}

module.exports = { getAIContext, contextPrompt, saveAIHistory };
