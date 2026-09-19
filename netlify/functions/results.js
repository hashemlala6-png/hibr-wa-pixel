const { env } = require('./env');
const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');
const { requireAdmin, json } = require('./auth-utils');
const { logActivity } = require('./client-activity');
const { getAIContext, contextPrompt, saveAIHistory } = require('./ai-context');

const store = () => getStore({ name: 'hbpx-result-plans', consistency: 'strong' });
const clientStore = () => getStore({ name: 'hbpx-clients', consistency: 'strong' });
const clientPlanIndex = () => getStore({ name: 'hbpx-result-client-index', consistency: 'strong' });
const clean = (v, n = 900) => String(v ?? '').trim().slice(0, n);

function extractJSON(text) {
  const cleaned = String(text || '').replace(/```json|```/g, '').trim();
  try { return JSON.parse(cleaned); } catch {}
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(cleaned.slice(start, end + 1)); } catch {}
  }
  throw new Error('تعذر قراءة خطة النتيجة من النموذج.');
}

async function listPlans() {
  const r = await store().list({ prefix: 'result-' });
  const out = [];
  for (const b of r.blobs || []) {
    try { const x = await store().get(b.key, { type: 'json' }); if (x) out.push(x); } catch {}
  }
  return out.sort((a,b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));
}

exports.handler = async event => {
  if (event.httpMethod === 'OPTIONS') return json(204, {});
  const auth = requireAdmin(event);
  if (auth) return auth;

  if (event.httpMethod === 'GET') {
    try { return json(200, { plans: await listPlans() }); }
    catch { return json(500, { error: 'تعذر تحميل خطط النتائج.' }); }
  }
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  let b = {};
  try { b = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'بيانات غير صالحة.' }); }
  const action = clean(b.action, 30) || 'generate';
  if (action !== 'generate') return json(400, { error: 'الإجراء غير معروف.' });

  const required = ['clientName','business','objective','audience','offer'];
  if (required.some(k => !clean(b[k]))) return json(400, { error: 'أكمل بيانات العميل والهدف والجمهور والعرض.' });
  const key = env('ANTHROPIC_API_KEY');
  const clientId = clean(b.clientId, 120);
  const clientContext = await getAIContext(clientId);
  const memory = clientContext?.memory || {};
  if (clientContext) {
    b.clientName = clean(b.clientName || clientContext.client?.name,160);
    b.business = clean(b.business || clientContext.client?.activity,220);
    b.audience = clean(b.audience || memory.audience,500);
    b.objective = clean(b.objective || memory.objective,700);
    b.offer = clean(b.offer || memory.offer,700);
    b.problem = clean(b.problem || memory.problem,900);
    b.platform = clean(b.platform || memory.platform,120);
    b.brand = clean(b.brand || memory.brand,500);
    b.deliverables = clean(b.deliverables || memory.deliverables,900);
    b.constraints = clean(b.constraints || memory.constraints,700);
    b.context = clean(b.context || memory.context,900);
  }
  if (!key) return json(500, { error: 'ANTHROPIC_API_KEY غير مضبوط بإعدادات السيرفر.' });

  const system = `أنت Creative Strategist + Senior Art Director + Conversion Copywriter + Client Success Lead لوكالة عربية ممتازة.
مهمتك ليست إنتاج "بوست جميل" فقط؛ مهمتك بناء خطة تسليم تجعل العميل يشعر أن العمل أعمق وأكثر فائدة مما توقع.

مبادئ إلزامية:
- لا تختلق أرقام نتائج أو شهادات عملاء أو نسب نمو.
- فرّق بين ما يمكن التحكم به (الجودة، الرسالة، الهوية، وضوح العرض، CTA، سرعة التسليم) وما يحتاج قياساً بعد النشر.
- كل فكرة يجب أن تخدم هدفاً تجارياً واضحاً.
- تجنب القوالب المستهلكة والكلام العام.
- اجعل المفهوم البصري واحداً وقابلاً للتذكر.
- اجعل النص عربياً طبيعياً، ويمكن استخدام اللهجة العراقية عند ملاءمتها.
- أضف قيمة صغيرة غير متوقعة للعميل، لكن قابلة للتنفيذ وليست هدية مكلفة.
- ضع معيار قبول واضح لكل تسليم.

أعد JSON فقط بهذا الشكل:
{
  "diagnosis":"...",
  "strategic_insight":"...",
  "promise":"...",
  "creative_concept":"...",
  "content_angles":["...","...","..."],
  "deliverables":[{"item":"...","purpose":"...","acceptance":"..."}],
  "quality_gate":["...","...","...","...","..."],
  "wow_extras":["...","...","..."],
  "success_metrics":["...","...","..."],
  "handoff_message":"...",
  "owner_next_actions":["...","...","..."]
}`;

  const priorPlan = b.priorPlan || clientContext?.lastResult?.plan || null;
  const prior = priorPlan ? `\n\nهذه ليست بداية جديدة. هذه آخر خطة محفوظة للعميل، طوّرها واستمر من حيث توقفت ولا تعيد صياغتها من الصفر:\n${clean(JSON.stringify(priorPlan),7000)}` : '';
  const memoryBlock = contextPrompt(clientContext);

  const user = `بيانات العميل:
الاسم: ${clean(b.clientName,160)}
النشاط: ${clean(b.business,220)}
الهدف التجاري: ${clean(b.objective,700)}
الجمهور: ${clean(b.audience,500)}
العرض/الخدمة: ${clean(b.offer,700)}
المشكلة الحالية: ${clean(b.problem,900)}
الهوية/الألوان: ${clean(b.brand,500)}
المنصة: ${clean(b.platform,120)}
المخرجات المطلوبة: ${clean(b.deliverables,900)}
القيود: ${clean(b.constraints,700)}
السياق الإضافي: ${clean(b.context,900)}${prior}${memoryBlock}`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST',
      headers:{'Content-Type':'application/json','x-api-key':key,'anthropic-version':'2023-06-01'},
      body:JSON.stringify({model:'claude-sonnet-4-6',max_tokens:1800,system,messages:[{role:'user',content:user}]})
    });
    if (!r.ok) return json(r.status,{error:`خطأ من Anthropic: ${r.status}`});
    const d=await r.json();
    const text=(d.content||[]).map(x=>x.text||'').join('\n');
    const plan=extractJSON(text);
    const now=new Date().toISOString();
    const item={id:'result-'+Date.now()+'-'+crypto.randomBytes(4).toString('hex'),clientId:clean(b.clientId,120),leadId:clean(b.leadId||b.clientId,120),clientName:clean(b.clientName,160),business:clean(b.business,220),objective:clean(b.objective,700),inputs:{audience:clean(b.audience,500),offer:clean(b.offer,700),problem:clean(b.problem,900),platform:clean(b.platform,120),brand:clean(b.brand,500),deliverables:clean(b.deliverables,900),constraints:clean(b.constraints,700),context:clean(b.context,900)},createdAt:now,updatedAt:now,status:'draft',score:Math.min(100,Math.max(0,Math.round(60+(Array.isArray(plan.wow_extras)?plan.wow_extras.length:0)*8))),plan};
    await store().setJSON(item.id,item); if(item.clientId) await clientPlanIndex().setJSON(`client-${item.clientId}-${item.id}`,{planId:item.id,clientId:item.clientId,updatedAt:now});
    if(item.clientId){const prev=await clientStore().get(item.clientId,{type:'json'})||{};const memory={objective:item.objective,audience:clean(b.audience,500),offer:clean(b.offer,700),problem:clean(b.problem,900),platform:clean(b.platform,120),brand:clean(b.brand,500),deliverables:clean(b.deliverables,900),constraints:clean(b.constraints,700),context:clean(b.context,900),notes:prev.memory?.notes||'',updatedAt:now};await clientStore().setJSON(item.clientId,{id:item.clientId,leadId:item.leadId,memory,createdAt:prev.createdAt||now,updatedAt:now});}
    await logActivity(item.clientId||item.leadId,'result','تم إنشاء خطة نتيجة',{resultId:item.id,score:item.score,continued:!!priorPlan});
    if (item.clientId) await saveAIHistory({ clientId:item.clientId, mode:'results', topic:b.objective, input:user, output:JSON.stringify(plan), metadata:{ resultId:item.id, continuedFromMemory:!!priorPlan } });
    return json(200,{item});
  } catch(e) { return json(500,{error:e.message || 'تعذر بناء خطة النتيجة.'}); }
};
