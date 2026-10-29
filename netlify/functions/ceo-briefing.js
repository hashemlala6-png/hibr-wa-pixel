const {getStore,connectLambda}=require('@netlify/blobs');
const {env}=require('./env');
const {requireAdmin,json}=require('./auth-utils');
const crypto=require('crypto');

const defs={
 leads:['hbpx-leads','lead-'],projects:['hbpx-projects','project-'],quotes:['hbpx-quotes','quote-'],
 payments:['hbpx-payments','payment-'],expenses:['hbpx-expenses','expense-'],tasks:['hbpx-tasks','task-'],
 orders:['hbpx-orders','order-'],subscriptions:['hbpx-subscriptions','subscription-'],activities:['hbpx-client-activity','activity-']
};
const clean=(v,n=4000)=>String(v??'').trim().slice(0,n);
const num=v=>{const x=Number(String(v??'').replace(/[^0-9.-]/g,''));return Number.isFinite(x)?x:0};
async function readAll(name,prefix){
 const s=getStore({name,consistency:'eventual'}),out=[];let cursor;
 do{const r=await s.list({prefix,limit:100,cursor});for(const b of r.blobs||[]){try{const x=await s.get(b.key,{type:'json'});if(x)out.push(x)}catch{}}cursor=r.cursor}while(cursor);
 return out;
}
async function snapshot(){
 const pairs=await Promise.all(Object.entries(defs).map(async([k,[s,p]])=>[k,await readAll(s,p)]));
 const d=Object.fromEntries(pairs);
 const now=Date.now(),openTasks=d.tasks.filter(x=>x.status!=='done'),newLeads=d.leads.filter(x=>x.status==='new');
 const openQuotes=d.quotes.filter(x=>['draft','sent'].includes(x.status));
 const overdue=openTasks.filter(x=>x.dueDate&&new Date(String(x.dueDate).slice(0,10)+'T23:59:59').getTime()<now);
 const paid=d.payments.reduce((s,x)=>s+num(x.amount),0);
 const expenses=d.expenses.reduce((s,x)=>s+num(x.amount),0);
 const booked=d.projects.reduce((s,x)=>s+num(x.amount),0);
 const data={
   generatedAt:new Date().toISOString(),
   projects:d.projects.map(x=>({id:x.id,name:x.name||x.title||x.clientName||x.id,status:x.status||''})),
   counts:{leads:d.leads.length,newLeads:newLeads.length,orders:d.orders.length,openOrders:d.orders.filter(x=>!['completed','cancelled'].includes(x.status)).length,projects:d.projects.length,activeProjects:d.projects.filter(x=>['planned','active','review','in_progress'].includes(x.status)).length,quotes:d.quotes.length,openQuotes:openQuotes.length,tasks:d.tasks.length,openTasks:openTasks.length,overdueTasks:overdue.length,subscriptions:d.subscriptions.length},
   recordedTotals:{paymentsReceived:paid,expensesRecorded:expenses,projectAmountsBooked:booked,arithmeticDifference:paid-expenses},
   evidence:{
    newLeads:newLeads.slice(0,12).map(x=>({name:x.name||'غير مسمى',status:x.status,source:x.source||null,createdAt:x.createdAt,updatedAt:x.updatedAt})),
    openQuotes:openQuotes.slice(0,10).map(x=>({id:x.id,status:x.status,amount:num(x.amount),createdAt:x.createdAt,updatedAt:x.updatedAt,clientId:x.clientId||x.leadId||null})),
    overdueTasks:overdue.slice(0,12).map(x=>({title:x.title,dueDate:x.dueDate,status:x.status,projectId:x.projectId})),
    recentOrders:d.orders.slice().sort((a,b)=>new Date(b.createdAt||0)-new Date(a.createdAt||0)).slice(0,10).map(x=>({service:x.service,status:x.status,createdAt:x.createdAt,budget:x.budget||null})),
    recentActivities:d.activities.slice().sort((a,b)=>new Date(b.createdAt||0)-new Date(a.createdAt||0)).slice(0,12).map(x=>({label:x.label||x.type||'نشاط',createdAt:x.createdAt,type:x.type||null}))
   },
   dataLimitations:['هذه لقطة من سجلات النظام الحالية فقط؛ قد تكون بعض السجلات ناقصة أو قديمة.','المبالغ مجموع ما هو مسجل في مخازن المدفوعات والمصاريف، ولا تثبت وحدها الربح المحاسبي أو اكتمال التحصيل.','لا توجد بيانات كافية هنا لإثبات أسباب الأداء أو التنبؤ بالإيرادات.']
 };
 return data;
}
exports.handler=async event=>{
 connectLambda(event);
 if(event.httpMethod==='OPTIONS')return json(204,{});
 const denied=requireAdmin(event);if(denied)return denied;
 if(event.httpMethod==='GET'){
  try{const s=getStore({name:'hbpx-ceo-briefings',consistency:'eventual'});const r=await s.list({prefix:'briefing-',limit:1});const b=(r.blobs||[])[0];const latest=b?await s.get(b.key,{type:'json'}):null;return json(200,{latest:latest||null,available:!!env('ANTHROPIC_API_KEY')})}catch{return json(200,{latest:null,available:!!env('ANTHROPIC_API_KEY')})}
 }
 if(event.httpMethod!=='POST')return json(405,{error:'Method not allowed'});
 const key=env('ANTHROPIC_API_KEY');if(!key)return json(503,{error:'مفتاح الذكاء الاصطناعي ANTHROPIC_API_KEY غير مضبوط في Netlify. لم يتم إنشاء تقرير.'});
 try{
  const source=await snapshot();
  const prompt='أنت المدير التنفيذي التحليلي لوكالة حبر وبكسل. حلّل لقطة بيانات الشركة التالية فقط. أخرج JSON صالحاً فقط بالشكل: {"executiveSummary":"...","priorities":[{"title":"...","why":"...","evidence":"...","nextStep":"...","priority":"عالية|متوسطة|منخفضة","confidence":"مرتفعة|متوسطة|منخفضة"}],"risks":[{"title":"...","evidence":"...","mitigation":"..."}],"opportunities":[{"title":"...","evidence":"...","test":"..."}],"missingData":["..."],"ownerDecision":["..."]}. اكتب بالعربية الواضحة. فرّق بين الحقيقة والاستنتاج. لا تخترع بيانات أو أسباباً أو مبالغ. إذا لا يوجد دليل كافٍ فقل ذلك. اجعل الأولويات عملية ومحدودة (بحد أقصى 4)، لا تقترح إرسال أو نشر أو شراء أو أي فعل خارجي دون موافقة المالكة. لا تدّعِ أن شيئاً نُفذ. الأرقام المالية المسجلة لا تعني الربح المحاسبي.\nلقطة البيانات: '+JSON.stringify(source);
  const response=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'content-type':'application/json','x-api-key':key,'anthropic-version':'2023-06-01'},body:JSON.stringify({model:env('ANTHROPIC_MODEL')||'claude-3-5-sonnet-20241022',max_tokens:1800,temperature:0.2,system:'أنت نظام تحليل تنفيذي مسؤول. أخرج JSON فقط دون Markdown.',messages:[{role:'user',content:prompt}]})});
  const body=await response.json().catch(()=>({}));
  if(!response.ok) return json(502,{error:'تعذر توليد التقرير من مزود الذكاء الاصطناعي: '+clean(body.error?.message||response.statusText,250)});
  const raw=(body.content||[]).filter(x=>x.type==='text').map(x=>x.text).join('\n').trim();
  let report;try{const match=raw.match(/\{[\s\S]*\}/);report=JSON.parse(match?match[0]:raw)}catch{return json(502,{error:'وصل رد غير قابل للقراءة من الذكاء الاصطناعي. لم يُحفظ التقرير.'})}
  const now=new Date().toISOString(),id='briefing-'+Date.now()+'-'+crypto.randomBytes(4).toString('hex');
  const record={id,createdAt:now,model:env('ANTHROPIC_MODEL')||'claude-3-5-sonnet-20241022',source,report,policy:{externalActionsExecuted:false,ownerApprovalRequired:true}};
  await getStore({name:'hbpx-ceo-briefings',consistency:'eventual'}).setJSON(id,record);
  return json(200,{briefing:record});
 }catch(err){console.error('ceo-briefing',err);return json(500,{error:'تعذر إعداد التقرير التنفيذي. '+clean(err.message,180)})}
};