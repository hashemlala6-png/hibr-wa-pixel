const crypto=require('crypto');
const {getStore,connectLambda}=require('@netlify/blobs');
const {env}=require('./env');
const {requireAdmin,json}=require('./auth-utils');

const tasksStore=()=>getStore({name:'hbpx-tasks',consistency:'eventual'});
const executionsStore=()=>getStore({name:'hbpx-ai-team-executions',consistency:'strong'});
const clean=(v,n=3000)=>String(v??'').trim().slice(0,n);
const roleGuides={
 'مدير العمليات':'رتّب الأولويات، قسّم العمل إلى خطوات، وحدد الاعتماديات والمخاطر ومؤشرات الإنجاز.',
 'استراتيجي التسويق':'حلّل السوق العراقي والجمهور المفترض بحذر، واقترح تموضعاً ورسائل وتجربة تسويقية قابلة للقياس.',
 'مخطط المحتوى':'أنشئ خطة محتوى عملية تتضمن أفكاراً وأهدافاً وصيغاً وجدولاً مقترحاً وقنوات مناسبة.',
 'كاتب المحتوى':'اكتب نصوصاً عربية سليمة وطبيعية مناسبة للسوق العراقي، مع نسخ جاهزة للمراجعة ودعوة واضحة للفعل.',
 'المصمم':'أنشئ موجز تصميم احترافي قابل للتنفيذ: التكوين، الألوان، الخط، النص الدقيق، العناصر، المقاس، وملاحظات سلامة العربية. لا تدّعِ أنك أنشأت صورة.',
 'مسؤول الجودة':'أنشئ قائمة فحص دقيقة مرتبطة بالمهمة، وحدد معايير القبول والأخطاء التي تمنع الاعتماد.',
 'مسؤول العملاء':'حضّر مسودة تواصل مهذبة وشخصية وخطوة متابعة واحدة. لا ترسل أي رسالة.',
 'مسؤول النشر':'جهّز حزمة نشر تشمل الكابشن والهاشتاغات والوصف والنص البديل وقائمة التحقق. لا تنشر.',
 'محلل الأداء':'حدد المقاييس المطلوبة، وطريقة قراءتها، والفرضيات القابلة للاختبار. لا تختلق أرقاماً أو نتائج.'
};
function parseJSON(raw){
 const s=String(raw||'').replace(/```json|```/g,'').trim();
 try{return JSON.parse(s)}catch{}
 const a=s.indexOf('{'),b=s.lastIndexOf('}');
 if(a>=0&&b>a)return JSON.parse(s.slice(a,b+1));
 throw new Error('تعذر قراءة نتيجة الموظف الافتراضي.');
}
async function allExecutions(){
 const st=executionsStore(),r=await st.list({prefix:'execution-',limit:100}),out=[];
 for(const b of r.blobs||[]){try{const x=await st.get(b.key,{type:'json'});if(x)out.push(x)}catch{}}
 return out.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)).slice(0,50);
}
exports.handler=async event=>{
 connectLambda(event);
 if(event.httpMethod==='OPTIONS')return json(204,{});
 const denied=requireAdmin(event);if(denied)return denied;
 if(event.httpMethod==='GET'){
  try{return json(200,{executions:await allExecutions()})}
  catch{return json(500,{error:'تعذر تحميل نتائج الفريق.'})}
 }
 if(event.httpMethod!=='POST')return json(405,{error:'Method not allowed'});
 let body={};try{body=JSON.parse(event.body||'{}')}catch{return json(400,{error:'بيانات غير صالحة.'})}
 const taskId=clean(body.taskId,160);
 if(!taskId)return json(400,{error:'معرّف المهمة مطلوب.'});
 const task=await tasksStore().get(taskId,{type:'json'});
 if(!task||task.projectId!=='internal-hibr')return json(404,{error:'مهمة الفريق غير موجودة.'});
 if(task.status==='done')return json(409,{error:'المهمة مكتملة بالفعل. أنشئي مهمة جديدة إذا أردتِ عملاً إضافياً.'});
 const role=clean(task.assignee,100),guide=roleGuides[role];
 if(!guide)return json(400,{error:'الدور المحدد غير معروف.'});
 const key=env('ANTHROPIC_API_KEY');
 if(!key)return json(503,{error:'مفتاح ANTHROPIC_API_KEY غير متاح في إعدادات Netlify؛ لم يتم تشغيل المهمة.'});
 const prompt=`أنت موظف ذكاء اصطناعي ضمن وكالة حبر وبكسل العراقية. نفّذ المهمة المحددة ضمن حدود دورك.
الدور: ${role}
تعليمات الدور: ${guide}
المهمة: ${clean(task.title,500)}
موعدها: ${clean(task.dueDate,40)||'غير محدد'}
تعليمات إضافية من المالكة: ${clean(body.instructions,2500)||'لا توجد'}
أنتج عملاً عملياً قابلاً للمراجعة، وليس وصفاً عاماً. إذا نقصت معلومات مهمة، اذكر الافتراضات والأسئلة بدلاً من اختلاقها.
أخرج JSON صالحاً فقط بهذا الشكل:
{"summary":"ملخص قصير","deliverable":"المخرج الكامل الجاهز للمراجعة","steps":["خطوة"],"assumptions":["افتراض"],"ownerApproval":["ما يحتاج موافقة المالكة"],"qualityChecks":["فحص"],"blocked":false}
ممنوع تنفيذ أي فعل خارجي: لا إرسال رسائل، لا نشر، لا شراء، لا تواصل مع عميل، ولا تغيير بيانات عميل. لا تدّعِ تنفيذ شيء خارج هذا الرد.
اكتب بالعربية الواضحة، وصحح الإملاء. عند كتابة نص عربي نهائي لا تضع زخارف أو رموزاً غير لازمة.`;
 try{
  const response=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'content-type':'application/json','x-api-key':key,'anthropic-version':'2023-06-01'},body:JSON.stringify({model:env('ANTHROPIC_MODEL')||'claude-sonnet-4-6',max_tokens:2600,temperature:0.3,system:'أنت تنفذ مهمة داخلية فقط وتلتزم بصلاحيات الدور. أخرج JSON فقط.',messages:[{role:'user',content:prompt}]})});
  const data=await response.json().catch(()=>({}));
  if(!response.ok)return json(502,{error:'تعذر تشغيل الموظف الافتراضي: '+clean(data.error?.message||response.statusText,260)});
  const raw=(data.content||[]).filter(x=>x.type==='text').map(x=>x.text).join('\n');
  const result=parseJSON(raw);
  const now=new Date().toISOString(),id='execution-'+Date.now()+'-'+crypto.randomBytes(4).toString('hex');
  const record={id,taskId,role,taskTitle:task.title,createdAt:now,model:env('ANTHROPIC_MODEL')||'claude-sonnet-4-6',result,policy:{externalActionsExecuted:false,ownerApprovalRequired:true}};
  await executionsStore().setJSON(id,record);
  task.status='review';task.updatedAt=now;task.latestExecutionId=id;await tasksStore().setJSON(task.id,task);
  return json(200,{execution:record,task});
 }catch(err){return json(500,{error:'تعذر إكمال المهمة: '+clean(err.message,220)})}
};
