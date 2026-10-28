
const crypto=require('crypto');
const {getStore}=require('@netlify/blobs');
const {requireAdmin,json}=require('./auth-utils');
const {logActivity}=require('./client-activity');

const blobOptions=(name)=>{const options={name,consistency:'strong'};const siteID=process.env.NETLIFY_SITE_ID||process.env.SITE_ID||'76bd352d-826a-49dc-8f0f-5f576610b1ae';const token=process.env.NETLIFY_AUTH_TOKEN;if(siteID&&token){options.siteID=siteID;options.token=token;}return options;};
const S={
 leads:()=>getStore(blobOptions('hbpx-leads')),
 projects:()=>getStore(blobOptions('hbpx-projects')),
 quotes:()=>getStore(blobOptions('hbpx-quotes')),
 subs:()=>getStore(blobOptions('hbpx-subscriptions')),
 tasks:()=>getStore(blobOptions('hbpx-tasks')),
 plans:()=>getStore(blobOptions('hbpx-execution-plans')),
 autopilot:()=>getStore(blobOptions('hbpx-autopilot')),
 gates:()=>getStore(blobOptions('hbpx-review-gates'))
};
const clean=(v,n=2000)=>String(v??'').trim().slice(0,n);
const num=v=>{const n=Number(String(v??'').replace(/[^0-9.-]/g,''));return Number.isFinite(n)?n:0};
async function all(store,prefix){
 const st=S[store](),r=await st.list({prefix}),out=[];
 for(const b of r.blobs||[]){try{const x=await st.get(b.key,{type:'json'});if(x)out.push(x)}catch{}}
 return out.sort((a,b)=>new Date(b.updatedAt||b.createdAt||0)-new Date(a.updatedAt||a.createdAt||0));
}
function daysUntil(date){
 if(!date)return null;
 const a=new Date(); const b=new Date(String(date).slice(0,10)+'T00:00:00');
 return Math.ceil((b-new Date(a.toISOString().slice(0,10)+'T00:00:00'))/86400000);
}
function makeActions({leads,projects,quotes,subs,tasks}){
 const now=Date.now(), actions=[];
 const activeProjects=projects.filter(p=>['active','review','in_progress'].includes(p.status));
 const openTasks=tasks.filter(t=>t.status!=='done');
 for(const l of leads){
   if(!l.id)continue;
   const age=Math.floor((now-new Date(l.updatedAt||l.createdAt||now))/86400000);
   if(['new','contacted','proposal'].includes(l.status) && age>=3){
     actions.push({type:'followup',clientId:l.clientId||l.id,title:`متابعة ${l.name||'العميل'}`,reason:`لا يوجد نشاط مسجل منذ ${age} يوم`,priority:age>=7?'high':'normal',impact:age>=7?8:6,urgency:Math.min(10,3+age),revenueRisk:age>=7?8:5,action:'جهّز رسالة متابعة شخصية مبنية على آخر تواصل.'});
   }
 }
 for(const q of quotes){
   if(['sent','draft'].includes(q.status)){
     const age=Math.floor((now-new Date(q.updatedAt||q.createdAt||now))/86400000);
     if(age>=2)actions.push({type:'quote',clientId:q.clientId||q.leadId||'',quoteId:q.id,title:'متابعة عرض سعر',reason:`العرض مفتوح منذ ${age} يوم`,priority:age>=7?'high':'normal',impact:8,urgency:age>=7?9:6,revenueRisk:9,amount:num(q.amount),action:'راجع العرض وأرسل متابعة واضحة مع خطوة تالية واحدة.'});
   }
 }
 for(const s of subs){
   if(s.status!=='active')continue;
   const d=daysUntil(s.nextRenewal);
   if(d!==null && d<=14)actions.push({type:'renewal',clientId:s.clientId||'',subscriptionId:s.id,title:'تجديد اشتراك قريب',reason:d<0?'الاشتراك متأخر':`التجديد خلال ${d} يوم`,priority:d<=3?'high':'normal',impact:9,urgency:d<=3?10:7,revenueRisk:10,amount:num(s.amount),action:'جهّز عرض التجديد وراجع نتائج الفترة السابقة قبل التواصل.'});
 }
 for(const p of activeProjects){
   const related=openTasks.filter(t=>t.projectId===p.id);
   if(related.length){
     const overdue=related.filter(t=>t.dueDate && daysUntil(t.dueDate)<0).length;
     if(overdue)actions.push({type:'project-risk',clientId:p.clientId||p.leadId||'',projectId:p.id,title:`خطر تأخير مشروع ${p.name||''}`,reason:`${overdue} مهمة متأخرة`,priority:'high',impact:8,urgency:9,revenueRisk:7,action:'رتّب المهام المتأخرة وحدد موعد تسليم واقعي.'});
   }
 }
 return actions.map(x=>({...x,score:x.impact*0.45+x.urgency*0.3+x.revenueRisk*0.25}))
   .sort((a,b)=>b.score-a.score).slice(0,30);
}
exports.handler=async e=>{
 if(e.httpMethod==='OPTIONS')return json(204,{});
 const a=requireAdmin(e);if(a)return a;
 try{
  const [leads,projects,quotes,subs,tasks]=await Promise.all([
    all('leads','lead-'),all('projects','project-'),all('quotes','quote-'),all('subs','subscription-'),all('tasks','task-')
  ]);
  if(e.httpMethod==='GET'){
    const actions=makeActions({leads,projects,quotes,subs,tasks});
    return json(200,{generatedAt:new Date().toISOString(),actions:actions.slice(0,10),counts:{
      leads:leads.length,projects:projects.length,openTasks:tasks.filter(x=>x.status!=='done').length,
      openQuotes:quotes.filter(x=>['sent','draft'].includes(x.status)).length,
      renewals:subs.filter(x=>x.status==='active'&&daysUntil(x.nextRenewal)!==null&&daysUntil(x.nextRenewal)<=14).length
    }});
  }
  if(e.httpMethod!=='POST')return json(405,{error:'Method not allowed'});
  let b={};try{b=JSON.parse(e.body||'{}')}catch{return json(400,{error:'بيانات غير صالحة.'})}
  const action=clean(b.action,40), itemId=clean(b.itemId,160);
  if(action==='approve'){
    const generated=makeActions({leads,projects,quotes,subs,tasks});
    const item=generated.find(x=>x.quoteId===itemId||x.subscriptionId===itemId||x.projectId===itemId||x.clientId===itemId);
    if(!item)return json(404,{error:'الإجراء لم يعد متاحاً أو تغيّر وضعه.'});
    const id='autopilot-'+Date.now()+'-'+crypto.randomBytes(4).toString('hex');
    const record={id,status:'approved',approvedAt:new Date().toISOString(),item};
    await S.autopilot().setJSON(id,record);
    await logActivity(item.clientId||'', 'autopilot','تم اعتماد إجراء من Owner Autopilot',{autopilotId:id,title:item.title,type:item.type});
    return json(200,{item,record});
  }
  if(action==='prepare_followup'){
    const clientId=clean(b.clientId,160);
    const lead=leads.find(x=>(x.clientId||x.id)===clientId);
    if(!lead)return json(404,{error:'العميل غير موجود.'});
    const text=`مرحباً ${lead.name||''}، حبيت أتابع معك بخصوص ${clean(lead.activity||'مشروعك',120)}. إذا مناسب، نكمل من آخر نقطة وصلنا لها ونحدد الخطوة القادمة.`;
    return json(200,{clientId,message:text,requiresOwnerApproval:true});
  }
  if(action==='create_execution'){
    const reviewGateId=clean(b.reviewGateId,180);
    if(!reviewGateId)return json(409,{error:'اعتمدي مرحلة المراجعة أولاً قبل إنشاء خطة أو مهمة.'});
    const reviewGate=await S.gates().get(reviewGateId,{type:'json'});
    if(!reviewGate||reviewGate.status!=='approved')return json(409,{error:'مرحلة المراجعة غير موجودة أو غير معتمدة.'});
    const clientId=clean(b.clientId,160),projectId=clean(b.projectId,160);
    if(!clientId||!projectId)return json(400,{error:'العميل والمشروع مطلوبان.'});
    const project=projects.find(p=>p.id===projectId && (p.clientId===clientId||p.leadId===clientId));
    if(!project)return json(404,{error:'المشروع غير موجود للعميل.'});
    const title=clean(b.title,180)||'إجراء نمو من Autopilot';
    const taskTitle=clean(b.taskTitle,240)||clean(b.actionText,1000);
    if(!taskTitle)return json(400,{error:'وصف التنفيذ مطلوب.'});
    const now=new Date().toISOString(),planId='execution-'+Date.now()+'-'+crypto.randomBytes(4).toString('hex');
    const plan={id:planId,clientId,projectId,title,objective:clean(b.objective,800),decision:clean(b.actionText,1200),source:'owner-autopilot',reviewGateId,reviewGateTitle:reviewGate.title,status:'active',createdAt:now,updatedAt:now};
    await S.plans().setJSON(planId,plan);
    const task={id:'task-'+Date.now()+'-'+crypto.randomBytes(4).toString('hex'),projectId,title:taskTitle,assignee:clean(b.assignee,100),dueDate:clean(b.dueDate,30),status:'todo',priority:'high',executionPlanId:planId,expectedOutput:clean(b.expectedOutput,600),measurement:clean(b.measurement,600),createdAt:now,updatedAt:now};
    await S.tasks().setJSON(task.id,task);
    await S.autopilot().setJSON('autopilot-'+Date.now()+'-'+crypto.randomBytes(4).toString('hex'),{status:'executed',executedAt:now,planId,taskId:task.id,clientId,projectId,reviewGateId});
    await logActivity(clientId,'autopilot','تم تحويل إجراء Autopilot إلى خطة ومهمة',{planId,taskId:task.id});
    return json(201,{plan,task});
  }
  return json(400,{error:'الإجراء غير معروف.'});
 }catch(err){return json(500,{error:err.message||'حدث خطأ في Autopilot.'})}
};
