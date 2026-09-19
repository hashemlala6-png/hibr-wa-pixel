const { env } = require('./env');
const { requireAdmin, json } = require('./auth-utils');
const { getAIContext, contextPrompt, saveAIHistory } = require('./ai-context');
const crypto = require('crypto');
const { logActivity } = require('./client-activity');
const { getStore } = require('@netlify/blobs');
const dnaStore = () => getStore({ name: 'hbpx-creative-dna', consistency: 'strong' });
async function saveDNA(clientId, item) {
  const id = `dna-${clientId}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  await dnaStore().setJSON(id, { id, clientId, createdAt: new Date().toISOString(), ...item });
  return id;
}

const clean=(v,n=12000)=>String(v??'').trim().slice(0,n);

async function reviseText({apiKey,mode,clientContext,instruction,currentOutput,topic}){
 const system=`أنت محرر ومخرج إبداعي محترف. المطلوب تنفيذ تعديل حقيقي على النتيجة الحالية، وليس اقتراح تعديل.

${contextPrompt(clientContext)}

النتيجة الحالية:
${clean(currentOutput,12000)}

تعليمات التعديل من المالك:
${clean(instruction,3000)}

قواعد التنفيذ الصارمة:
- نفّذ كل ما طلبه المالك حرفياً قدر الإمكان.
- لا تغيّر أي شيء لم يطلب تغييره.
- حافظ على هوية العميل، النبرة، الهدف، والمعلومات الصحيحة.
- إذا قال المالك "فقط" أو "لا تغيّر غير" فالتعديل محصور بهذا الجزء.
- لا تشرح ما فعلته؛ أعد النسخة المعدلة النهائية فقط.
- إذا كان التعديل غير منطقي أو يتعارض مع قيود العميل، نفّذ الجزء الممكن ولا تخترع معلومات.
- لا تعيد كتابة النتيجة من الصفر إذا كان المطلوب تعديلاً جزئياً.
نوع الأداة: ${mode}
الموضوع: ${clean(topic,1000)}`;
 const r=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01'},body:JSON.stringify({model:'claude-sonnet-4-6',max_tokens:1600,system,messages:[{role:'user',content:`طبّق التعديل الآن. أريد الناتج النهائي المعدّل فقط.`}]})});
 if(!r.ok)throw Error(`خطأ من Claude: ${r.status}`);const d=await r.json();return (d.content||[]).map(x=>x.text||'').join('\n').trim();
}

async function parseEditInstruction({apiKey, instruction, clientContext, kind='image'}) {
 const system=`أنت مدير تنفيذ ومراقبة جودة. حوّل تعليمات المالك إلى خطة تغييرات دقيقة وقابلة للتنفيذ.
أعد JSON فقط بهذا الشكل:
{"changes":["..."],"preserve":["..."],"scope":"...","priority":"..."}
قواعد:
- استخرج كل تغيير صريح، ولا تضف تغييرات إبداعية من عندك.
- أي عبارة مثل فقط/لا تغير/حافظ على تُسجل ضمن preserve.
- إذا ذكر المالك نسبة أو اتجاه أو موضع أو لون أو حجم، احتفظ بها كما هي.
- scope يحدد الجزء المستهدف فقط.
- priority = "strict" إذا طلب المالك عدم تغيير أي شيء آخر.
نوع التعديل: ${kind}
السياق الإبداعي للعميل:
${contextPrompt(clientContext)}
تعليمات المالك:
${clean(instruction,3000)}`;
 const r=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01'},body:JSON.stringify({model:'claude-sonnet-4-6',max_tokens:700,system,messages:[{role:'user',content:'حوّل التعليمات إلى خطة تنفيذ JSON فقط.'}]})});
 if(!r.ok) throw Error(`خطأ تحليل تعليمات التعديل: ${r.status}`);
 const d=await r.json();
 const raw=(d.content||[]).map(x=>x.text||'').join('').replace(/```json|```/g,'').trim();
 try{return JSON.parse(raw)}catch{return {changes:[clean(instruction,3000)],preserve:['كل ما لم يُطلب تغييره'],scope:'حسب التعليمات',priority:'strict'}}
}

async function reviseImage({apiKey,imageBase64,instruction,clientContext}){
 if(!imageBase64||!/^data:image\/(png|jpeg|jpg|webp);base64,/i.test(imageBase64))throw Error('صورة المصدر غير صالحة.');
 const mime=(imageBase64.match(/^data:(image\/[^;]+);/)||[])[1]||'image/png';
 const bytes=Buffer.from(imageBase64.split(',')[1],'base64');
 if(bytes.length>7*1024*1024)throw Error('حجم الصورة كبير جداً للتعديل. استخدم صورة أصغر من 7MB.');
 const plan=await parseEditInstruction({apiKey, instruction, clientContext, kind:'image'});
 const form=new FormData();
 form.append('model','gpt-image-1');
 form.append('image',new Blob([bytes],{type:mime}),'source.'+(mime.includes('jpeg')||mime.includes('jpg')?'jpg':'png'));
 const changes=(plan.changes||[]).map((x,i)=>`${i+1}. ${x}`).join('\n');
 const preserve=(plan.preserve||[]).map((x,i)=>`${i+1}. ${x}`).join('\n');
 const prompt=`EDIT THE PROVIDED IMAGE. This is a precision edit, NOT a redesign.
EXECUTE ONLY THESE CHANGES:
${changes || instruction}

MUST PRESERVE:
${preserve || 'Every visual detail not explicitly requested.'}

SCOPE: ${plan.scope||'only the explicitly requested area'}
PRIORITY: ${plan.priority||'strict'}

Hard constraints:
- Do not reinterpret the brief or add creative changes.
- Do not change composition, subject identity, camera angle, crop, lighting, colors, typography, background, logos, or layout unless explicitly listed above.
- If a requested change is local, keep all other regions pixel-consistent in intent.
- Do not add, remove, replace, or restyle anything outside the requested scope.
- Follow exact percentages, directions, positions and colors stated by the owner.
- If the request says “only”, treat it as an absolute constraint.`;
 form.append('prompt', prompt);
 const r=await fetch('https://api.openai.com/v1/images/edits',{method:'POST',headers:{Authorization:`Bearer ${apiKey}`},body:form});
 if(!r.ok)throw Error(`خطأ من OpenAI Image Edit: ${r.status} — ${clean(await r.text(),1000)}`);
 const d=await r.json();const b64=d.data?.[0]?.b64_json;if(!b64)throw Error('لم تصل صورة معدلة من OpenAI.');
 return {image:`data:image/png;base64,${b64}`,plan};
}

async function verifyImageEdit({apiKey, originalBase64, editedBase64, plan}) {
 // Optional quality gate. Uses a vision-capable model when available; failure is non-fatal.
 try {
   const prompt=`تحقق من نتيجة تعديل صورة وفق الخطة التالية. أعد JSON فقط: {"passed":true|false,"confidence":0-100,"issues":["..."]}
التغييرات المطلوبة: ${JSON.stringify(plan.changes||[])}
العناصر التي يجب الحفاظ عليها: ${JSON.stringify(plan.preserve||[])}
إذا لم تستطع التحقق بثقة، passed=false واذكر السبب.`;
   const r=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${apiKey}`},body:JSON.stringify({model:'gpt-4.1-mini',input:[{role:'user',content:[{type:'input_text',text:prompt},{type:'input_image',image_url:originalBase64},{type:'input_image',image_url:editedBase64}]}],max_output_tokens:300})});
   if(!r.ok)return {verified:false,passed:null,issues:['تعذر تشغيل بوابة التحقق البصري.']};
   const d=await r.json();const raw=(d.output||[]).flatMap(x=>x.content||[]).map(x=>x.text||'').join('').replace(/```json|```/g,'').trim();
   const parsed=JSON.parse(raw);return {verified:true,...parsed};
 } catch(e){ return {verified:false,passed:null,issues:[e.message]}; }
}

exports.handler=async event=>{
 if(event.httpMethod==='OPTIONS')return json(204,{});const auth=requireAdmin(event);if(auth)return auth;if(event.httpMethod!=='POST')return json(405,{error:'Method not allowed'});
 let p={};try{p=JSON.parse(event.body||'{}')}catch{return json(400,{error:'بيانات غير صالحة.'})}
 const clientId=clean(p.clientId,120), instruction=clean(p.instruction,3000), mode=clean(p.mode,40)||'writing';
 if(!clientId||!instruction)return json(400,{error:'اختر العميل واكتب التعديل المطلوب.'});
 const ctx=await getAIContext(clientId);
 try{
   if(p.kind==='image'){
     if(!env('OPENAI_API_KEY'))return json(500,{error:'مفتاح OPENAI_API_KEY غير مضبوط.'});
     const image=await reviseImage({apiKey:env('OPENAI_API_KEY'),imageBase64:p.imageBase64,instruction,clientContext:ctx});
     const revisionId = `rev-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
     await saveAIHistory({clientId,mode:'image-revision',topic:p.topic||'تعديل صورة',input:instruction,output:'تم تعديل الصورة فعلياً.',metadata:{kind:'image',continuedFromMemory:true,revisionId}});
     await saveDNA(clientId,{action:'image-revision',instruction,whatChanged:'تعديل صورة فعلي بطلب المالك',reason:'تنفيذ تعديل فعلي',approved:false,metadata:{revisionId,kind:'image'}});
     await logActivity(clientId,'ai-edit','AI — تعديل صورة فعلي',{instruction:instruction.slice(0,500),revisionId});
     const verification=await verifyImageEdit({apiKey:env('OPENAI_API_KEY'),originalBase64:p.imageBase64,editedBase64:image.image,plan:image.plan});
     return json(200,{image:image.image,clientId,memoryApplied:!!ctx,revisionId,editPlan:image.plan,verification});
   }
   if(!env('ANTHROPIC_API_KEY'))return json(500,{error:'مفتاح ANTHROPIC_API_KEY غير مضبوط.'});
   if (!clean(p.currentOutput,1)) return json(400,{error:'لا توجد نتيجة أصلية قابلة للتعديل.'});
   const text=await reviseText({apiKey:env('ANTHROPIC_API_KEY'),mode,clientContext:ctx,instruction,currentOutput:p.currentOutput,topic:p.topic});
   await saveAIHistory({clientId,mode:`${mode}-revision`,topic:p.topic||'مراجعة',input:instruction,output:text,metadata:{kind:'text',continuedFromMemory:true,revision:true}});
   await saveDNA(clientId,{action:'text-revision',instruction,whatChanged:text.slice(0,1800),reason:'تنفيذ تعديل فعلي',approved:false,metadata:{kind:'text',mode}});
   await logActivity(clientId,'ai-edit',`AI — تعديل ${mode}`,{instruction:instruction.slice(0,500),revision:true});
   return json(200,{text,clientId,memoryApplied:!!ctx});
 }catch(err){return json(500,{error:err.message})}
};
