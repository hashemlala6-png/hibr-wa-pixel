const { env } = require('./env');
const crypto=require('crypto');
const {getStore}=require('@netlify/blobs');
const {requireAdmin,json}=require('./auth-utils');
const {getAIContext,contextPrompt,saveAIHistory}=require('./ai-context');
const {logActivity}=require('./client-activity');

const projects=()=>getStore({name:'hbpx-projects',consistency:'strong'});
const gates=()=>getStore({name:'hbpx-quality-gates',consistency:'strong'});
const vqa=()=>getStore({name:'hbpx-visual-qa',consistency:'strong'});
const clean=(v,n=4000)=>String(v??'').trim().slice(0,n);
const list=async(st,prefix)=>{const r=await st().list({prefix}),o=[];for(const b of r.blobs||[]){try{const x=await st().get(b.key,{type:'json'});if(x)o.push(x)}catch{}}return o};
const extractJSON=t=>{const s=String(t||'').replace(/```json|```/g,'').trim();try{return JSON.parse(s)}catch{}const a=s.indexOf('{'),b=s.lastIndexOf('}');if(a>=0&&b>a)return JSON.parse(s.slice(a,b+1));throw Error('تعذر قراءة فحص الجودة.')};
const norm=s=>String(s||'').toLowerCase().replace(/[أإآ]/g,'ا').replace(/ة/g,'ه').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const tokenMatch=(a,b)=>{const x=norm(a),y=norm(b);if(!x||!y)return false;return x===y||x.includes(y)||y.includes(x)||y.split(' ').filter(Boolean).every(t=>x.includes(t));};
async function vqaForProject(projectId){const r=await vqa().list({prefix:'vqa-'}),out=[];for(const b of r.blobs||[]){try{const x=await vqa().get(b.key,{type:'json'});if(x?.projectId===projectId)out.push(x)}catch{}}return out.sort((a,b)=>new Date(a.createdAt)-new Date(b.createdAt));}
async function latestApprovedFinal(projectId){const r=await gates().list({prefix:'gate-'}),out=[];for(const b of r.blobs||[]){try{const x=await gates().get(b.key,{type:'json'});if(x?.projectId===projectId&&x.status==='approved'&&x.kind==='final')out.push(x)}catch{}}return out.sort((a,b)=>new Date(b.approvedAt||b.updatedAt)-new Date(a.approvedAt||a.updatedAt))[0]||null;}

exports.handler=async e=>{
 if(e.httpMethod==='OPTIONS')return json(204,{});
 const auth=requireAdmin(e);if(auth)return auth;
 try{
  if(e.httpMethod==='GET'){
   const id=clean(e.queryStringParameters?.projectId,120);
   const all=await list(gates,'gate-');
   return json(200,{gates:id?all.filter(x=>x.projectId===id):all});
  }
  if(e.httpMethod!=='POST')return json(405,{error:'Method not allowed'});
  let b={};try{b=JSON.parse(e.body||'{}')}catch{return json(400,{error:'بيانات غير صالحة.'})}
  const action=clean(b.action,30)||'assess';
  if(action==='approve'){
    const g=await gates().get(clean(b.gateId,160),{type:'json'});if(!g)return json(404,{error:'فحص الجودة غير موجود.'});
    if(g.kind!=='final')return json(409,{error:'هذه بوابة مراجعة أولية فقط. شغّل الفحص النهائي الشامل قبل فتح التسليم.',gate:g});
    if(g.result?.criticalCount>0||g.result?.passed===false)return json(409,{error:'لا يمكن اعتماد التسليم قبل معالجة المشاكل الحرجة.',gate:g});
    g.status='approved';g.approvedAt=new Date().toISOString();await gates().setJSON(g.id,g);
    await logActivity(g.clientId,'quality','تم اعتماد بوابة جودة المشروع',{projectId:g.projectId,gateId:g.id,score:g.result.score});
    return json(200,{gate:g});
  }
  if(action==='final_assess'){
    const projectId=clean(b.projectId,120);if(!projectId)return json(400,{error:'اختر المشروع.'});
    const project=await projects().get(projectId,{type:'json'});if(!project)return json(404,{error:'المشروع غير موجود.'});
    const ctx=await getAIContext(project.leadId||project.clientId||'');
    const inspections=await vqaForProject(projectId);
    const outputs=Array.isArray(b.outputs)?b.outputs.map(x=>clean(x,240)).filter(Boolean):[];
    const checks=Array.isArray(b.checklist)?b.checklist.map(x=>({label:clean(x.label,300),done:!!x.done})).filter(x=>x.label):[];
    const missingOutputs=outputs.filter(o=>!inspections.some(i=>tokenMatch(i.name,o)));
    const failedInspections=inspections.filter(i=>i.result?.passed===false||Number(i.result?.criticalCount)>0);
    const staleInspections=inspections.filter(i=>!i.result);
    const unchecked=checks.filter(x=>!x.done);
    const evidence=inspections.map(i=>({id:i.id,name:i.name,createdAt:i.createdAt,score:i.result?.score||0,passed:i.result?.passed===true,criticalCount:i.result?.criticalCount||0,must_fix:i.result?.must_fix||[]}));
    const key=env('ANTHROPIC_API_KEY');if(!key)return json(500,{error:'ANTHROPIC_API_KEY غير مضبوط بإعدادات السيرفر.'});
    const system=`أنت مدير نجاح عميل ومدير جودة نهائي. لا تسمح بالتسليم إلا إذا كانت كل المخرجات المطلوبة لها أدلة فحص فعلية، ولا توجد نتيجة بصرية فاشلة أو مشكلة حرجة، وقائمة التحقق مكتملة. كن صارماً ولا تخترع أدلة. أعد JSON فقط: {"passed":true|false,"score":0-100,"criticalCount":0,"summary":"...","must_fix":["..."],"wow_opportunities":["..."],"handoff_message":"..."}`;
    const user=`المشروع: ${project.name}
بيانات العميل: ${JSON.stringify(ctx?.client||{})}
ذاكرة العميل: ${JSON.stringify(ctx?.memory||{})}
خطة النتيجة: ${JSON.stringify(ctx?.lastResult?.plan||null)}
المخرجات المطلوبة: ${JSON.stringify(outputs)}
فحوص الصور الفعلية: ${JSON.stringify(evidence)}
مخرجات بلا فحص: ${JSON.stringify(missingOutputs)}
فحوص فاشلة: ${JSON.stringify(failedInspections.map(x=>x.name))}
فحوص بلا نتيجة: ${JSON.stringify(staleInspections.map(x=>x.name))}
قائمة التحقق غير المكتملة: ${JSON.stringify(unchecked)}`;
    const r=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':key,'anthropic-version':'2023-06-01'},body:JSON.stringify({model:'claude-sonnet-4-6',max_tokens:1600,system,messages:[{role:'user',content:user}]})});
    if(!r.ok)return json(r.status,{error:`خطأ من Anthropic: ${r.status}`});
    const d=await r.json(),text=(d.content||[]).map(x=>x.text||'').join('\n'),result=extractJSON(text);
    result.criticalCount=Number(result.criticalCount)||0;result.score=Math.max(0,Math.min(100,Number(result.score)||0));
    if(missingOutputs.length||failedInspections.length||staleInspections.length||unchecked.length){result.criticalCount+=missingOutputs.length+failedInspections.length+staleInspections.length+unchecked.length;result.passed=false;result.must_fix=[...(result.must_fix||[]),...missingOutputs.map(x=>`المخرج «${x}» لم يمر بفحص بصري فعلي.`),...failedInspections.map(x=>`فحص «${x.name}» غير ناجح ويحتاج إصلاحاً.`),...unchecked.map(x=>`قائمة التحقق غير مكتملة: ${x.label}`)];}
    const now=new Date().toISOString(),id='gate-'+Date.now()+'-'+crypto.randomBytes(4).toString('hex');
    const gate={id,projectId,clientId:project.leadId||project.clientId||'',kind:'final',createdAt:now,updatedAt:now,status:'pending',inputs:{outputs,checklist:checks,inspectionIds:inspections.map(x=>x.id)},evidence:{inspections:evidence,missingOutputs,failedInspections:failedInspections.map(x=>x.name)},result};
    await gates().setJSON(id,gate);
    if(gate.clientId){await saveAIHistory({clientId:gate.clientId,mode:'final-quality-gate',topic:project.name,input:user,output:JSON.stringify(result),metadata:{gateId:id,score:result.score}});await logActivity(gate.clientId,'quality','تم تشغيل الفحص النهائي الشامل قبل التسليم',{projectId,gateId:id,score:result.score,passed:result.passed});}
    return json(200,{gate});
  }
  if(action!=='assess')return json(400,{error:'الإجراء غير معروف.'});
  const projectId=clean(b.projectId,120);if(!projectId)return json(400,{error:'اختر المشروع.'});
  const project=await projects().get(projectId,{type:'json'});if(!project)return json(404,{error:'المشروع غير موجود.'});
  const ctx=await getAIContext(project.leadId||project.clientId||'');
  const client=ctx?.client||{};const memory=ctx?.memory||{};
  const checklist=Array.isArray(b.checklist)?b.checklist.map(x=>({label:clean(x.label,300),done:!!x.done})).filter(x=>x.label):[];
  const deliverables=clean(b.deliverables,6000),notes=clean(b.notes,4000);
  const apiKey=env('ANTHROPIC_API_KEY');if(!apiKey)return json(500,{error:'ANTHROPIC_API_KEY غير مضبوط بإعدادات السيرفر.'});
  const system=`أنت مدير جودة وتسليم (Client Success Director) في استوديو إبداعي ممتاز.
مهمتك منع تسليم عمل متوسط. افحص المشروع مقابل طلب العميل وذاكرته وخطة النتيجة.
لا تفترض أن الشيء مكتمل لمجرد أن المالك قال ذلك. إذا كانت المعلومات ناقصة، اعتبرها مخاطرة واذكر ما يلزم للتحقق.
لا تختلق نتائج تجارية أو أرقام أداء.
المطلوب: تقييم عملي صارم، ثم تحديد ما يجب إصلاحه قبل التسليم وما يمكن تحسينه لرفع الانبهار.
أعد JSON فقط:
{"passed":true|false,"score":0-100,"criticalCount":0,"summary":"...","checks":[{"name":"...","status":"pass|warn|fail","evidence":"...","action":"..."}],"must_fix":["..."],"wow_opportunities":["..."],"handoff_message":"...","next_actions":["..."]}`;
  const user=`المشروع: ${project.name}
قيمة المشروع: ${project.amount}
حالة المشروع: ${project.status}
بيانات العميل: ${JSON.stringify({name:client.name,activity:client.activity})}
ذاكرة العميل: ${JSON.stringify(memory)}
خطة النتيجة الأخيرة: ${JSON.stringify(ctx?.lastResult?.plan||null)}
المخرجات المسجلة من المالك: ${deliverables||'لم تُسجل'}
ملاحظات المالك: ${notes||'لا توجد'}
قائمة التحقق اليدوية: ${JSON.stringify(checklist)}`;
  const r=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01'},body:JSON.stringify({model:'claude-sonnet-4-6',max_tokens:1800,system,messages:[{role:'user',content:user}]})});
  if(!r.ok)return json(r.status,{error:`خطأ من Anthropic: ${r.status}`});
  const d=await r.json(),text=(d.content||[]).map(x=>x.text||'').join('\n'),result=extractJSON(text);
  result.criticalCount=Number(result.criticalCount)||0;
  result.score=Math.max(0,Math.min(100,Number(result.score)||0));
  if(result.criticalCount>0)result.passed=false;
  const now=new Date().toISOString(),id='gate-'+Date.now()+'-'+crypto.randomBytes(4).toString('hex');
  const gate={id,projectId,clientId:project.leadId||project.clientId||'',kind:'review',createdAt:now,updatedAt:now,status:'pending',inputs:{deliverables,notes,checklist},result};
  await gates().setJSON(id,gate);
  if(gate.clientId){await saveAIHistory({clientId:gate.clientId,mode:'quality-gate',topic:project.name,input:user,output:JSON.stringify(result),metadata:{gateId:id,score:result.score}});await logActivity(gate.clientId,'quality','تم تشغيل فحص جودة قبل التسليم',{projectId,gateId:id,score:result.score,passed:result.passed});}
  return json(200,{gate});
 }catch(err){return json(500,{error:err.message||'تعذر تشغيل فحص الجودة.'})}
};