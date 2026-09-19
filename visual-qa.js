const { env } = require('./env');
const crypto=require('crypto');
const {getStore}=require('@netlify/blobs');
const {requireAdmin,json}=require('./auth-utils');
const {getAIContext,contextPrompt,saveAIHistory}=require('./ai-context');
const {logActivity}=require('./client-activity');
const store=()=>getStore({name:'hbpx-visual-qa',consistency:'strong'});
const clean=(v,n=5000)=>String(v??'').trim().slice(0,n);
const extract=t=>{const s=String(t||'').replace(/```json|```/g,'').trim();try{return JSON.parse(s)}catch{}const a=s.indexOf('{'),b=s.lastIndexOf('}');if(a>=0&&b>a)return JSON.parse(s.slice(a,b+1));throw Error('تعذر قراءة نتيجة الفحص البصري.');};
const dataUrlOk=x=>/^data:image\/(png|jpeg|jpg|webp);base64,/i.test(String(x||''));
exports.handler=async e=>{
 if(e.httpMethod==='OPTIONS')return json(204,{});
 const auth=requireAdmin(e);if(auth)return auth;
 if(e.httpMethod!=='POST')return json(405,{error:'Method not allowed'});
 let b={};try{b=JSON.parse(e.body||'{}')}catch{return json(400,{error:'بيانات غير صالحة.'})}
 const projectId=clean(b.projectId,120),name=clean(b.name,240),spec=clean(b.spec,5000),img=String(b.imageBase64||'');
 if(!projectId||!name||!dataUrlOk(img))return json(400,{error:'المشروع واسم المخرج والصورة مطلوبة.'});
 const bytes=Buffer.from(img.split(',')[1],'base64');if(bytes.length>4*1024*1024)return json(413,{error:'الصورة أكبر من 4MB.'});
 const ctx=await getAIContext(b.clientId||'');
 // The project context is intentionally pulled from the project through the AI context where possible.
 const expectedW=Number(b.expectedWidth)||null,expectedH=Number(b.expectedHeight)||null;
 const prompt=`أنت مدير جودة بصري صارم في استوديو إبداعي ممتاز. افحص الصورة المرفوعة نفسها، وليس وصفها فقط. استخدم الرؤية لاستخراج النص الظاهر، ترتيب العناصر، الشعار/الهوية، الألوان العامة، التكوين، الأخطاء الظاهرة، وهل تتوافق مع المواصفات. لا تدّعي تطابقاً دقيقاً إذا لم تستطع رؤيته بثقة. لا تختلق نتائج تجارية.
أعد JSON فقط:
{"passed":true|false,"score":0-100,"criticalCount":0,"summary":"...","checks":[{"name":"...","status":"pass|warn|fail","evidence":"...","action":"..."}],"must_fix":["..."],"wow_opportunities":["..."]}
قواعد:
- الصورة الفعلية هي المصدر الأساسي للحكم البصري.
- افحص النص الظاهر مقابل النص المطلوب إن وُجد، واذكر أي اختلاف حرفي تراه.
- افحص الهوية، الشعار، التكوين، المقاس كنسبة/معلومات ملف، الوضوح، القص، التباين، والعناصر الزائدة.
- إذا طلبت المواصفات الحفاظ على شيء، اعتبر تغييره مشكلة حرجة عند وضوحها.
- لا تعتبر العمل ممتازاً لمجرد أنه جميل؛ طابقه مع المطلوب.
سياق العميل:
${contextPrompt(ctx)}
المخرج: ${name}
المواصفات: ${spec||'لا توجد مواصفات إضافية'}
المقاس المطلوب: ${expectedW&&expectedH?`${expectedW}×${expectedH}`:'غير محدد'}
ملاحظات الملف: ${clean(b.fileName,200)} · ${clean(b.fileType,80)} · ${Number(b.fileSize)||0} bytes`;
 const key=env('OPENAI_API_KEY');if(!key)return json(500,{error:'OPENAI_API_KEY غير مضبوط بإعدادات السيرفر.'});
 const r=await fetch('https://api.openai.com/v1/responses',{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},body:JSON.stringify({model:'gpt-4.1-mini',input:[{role:'user',content:[{type:'input_text',text:prompt},{type:'input_image',image_url:img}]}],max_output_tokens:1800})});
 if(!r.ok)return json(r.status,{error:`خطأ من OpenAI Vision: ${r.status} — ${clean(await r.text(),800)}`});
 const d=await r.json(),raw=(d.output||[]).flatMap(x=>x.content||[]).map(x=>x.text||'').join(''),result=extract(raw);
 result.score=Math.max(0,Math.min(100,Number(result.score)||0));result.criticalCount=Number(result.criticalCount)||0;if(result.criticalCount>0)result.passed=false;
 const actualW=Number(b.actualWidth)||null,actualH=Number(b.actualHeight)||null;
 const dimensionCheck=expectedW&&expectedH&&actualW&&actualH?{pass:expectedW===actualW&&expectedH===actualH,expected:{width:expectedW,height:expectedH},actual:{width:actualW,height:actualH}}:null;
 if(dimensionCheck&&!dimensionCheck.pass){result.criticalCount++;result.passed=false;result.must_fix=[...(result.must_fix||[]),`المقاس الفعلي ${actualW}×${actualH} لا يطابق المطلوب ${expectedW}×${expectedH}.`]}
 const id='vqa-'+Date.now()+'-'+crypto.randomBytes(4).toString('hex'),now=new Date().toISOString();
 const inspection={id,projectId,clientId:ctx?.client?.id||b.clientId||'',createdAt:now,name,file:{name:clean(b.fileName,200),mime:clean(b.fileType,80),size:Number(b.fileSize)||bytes.length,width:actualW,height:actualH},deterministic:{dimensionCheck},result};
 await store().setJSON(id,inspection);
 if(inspection.clientId){await saveAIHistory({clientId:inspection.clientId,mode:'visual-qa',topic:name,input:spec,output:JSON.stringify(result),metadata:{inspectionId:id,projectId,score:result.score}});await logActivity(inspection.clientId,'quality','فحص بصري فعلي لمخرج',{projectId,inspectionId:id,score:result.score,passed:result.passed});}
 return json(200,{inspection});
};
