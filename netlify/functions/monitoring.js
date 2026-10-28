const crypto=require('crypto');
const {getStore}=require('@netlify/blobs');
const {requireAdmin,json}=require('./auth-utils');
const defs={
 projects:['hbpx-projects','project-'],payments:['hbpx-payments','payment-'],expenses:['hbpx-expenses','expense-'],
 leads:['hbpx-leads','lead-'],tasks:['hbpx-tasks','task-'],subscriptions:['hbpx-subscriptions','subscription-'],
 metrics:['hbpx-platform-analytics','metric-'],funnel:['hbpx-funnel','event-'],
 snapshots:['hbpx-monitor-snapshots','snapshot-'],decisions:['hbpx-monitor-decisions','decision-']
};
const st=n=>getStore({name:defs[n][0],consistency:'strong'});
const clean=(v,n=500)=>String(v??'').trim().slice(0,n);
const num=v=>{const x=Number(String(v??'').replace(/[^0-9.-]/g,''));return Number.isFinite(x)?x:0};
async function all(n){const store=st(n),out=[];let cursor;do{const r=await store.list({prefix:defs[n][1],limit:100,cursor});for(const b of r.blobs||[]){const x=await store.get(b.key,{type:'json'}).catch(()=>null);if(x)out.push(x)}cursor=r.cursor}while(cursor);return out.sort((a,b)=>new Date(b.createdAt||b.date||0)-new Date(a.createdAt||a.date||0))}
function dateOf(x){return new Date(x.paidAt||x.createdAt||x.date||x.updatedAt||0)}
function sum(arr,fn){return arr.reduce((s,x)=>s+Math.max(0,num(fn(x))),0)}
exports.handler=async e=>{
 if(e.httpMethod==='OPTIONS')return json(204,{});
 const auth=requireAdmin(e);if(auth)return auth;
 try{
  if(e.httpMethod==='GET'){
   const names=['projects','payments','expenses','leads','tasks','subscriptions','metrics','funnel','snapshots','decisions'];
   const vals=await Promise.all(names.map(all));const d=Object.fromEntries(names.map((n,i)=>[n,vals[i]]));
   const now=Date.now(),days=30,cut=now-days*86400000;
   const recentPayments=d.payments.filter(x=>dateOf(x).getTime()>=cut);
   const recentExpenses=d.expenses.filter(x=>dateOf(x).getTime()>=cut);
   const paid=d.payments.filter(x=>!['pending','unpaid','failed','cancelled','canceled'].includes(String(x.status||'paid').toLowerCase()));
   const revenue=sum(paid,x=>x.amount||x.paidAmount||x.value);
   const spend=sum(d.expenses,x=>x.amount||x.value);
   const revenue30=sum(recentPayments,x=>x.amount||x.paidAmount||x.value);
   const spend30=sum(recentExpenses,x=>x.amount||x.value);
   const activeProjects=d.projects.filter(x=>['active','planned','review'].includes(String(x.status||'').toLowerCase()));
   const openTasks=d.tasks.filter(x=>x.status!=='done');
   const lateTasks=openTasks.filter(x=>x.dueDate&&new Date(x.dueDate).getTime()<now);
   const pendingSubs=d.subscriptions.filter(x=>['pending','pending_payment','overdue'].includes(String(x.status||'').toLowerCase()));
   const latest=d.snapshots[0]||null;
   const alerts=[];
   if(lateTasks.length)alerts.push({level:'warning',title:'مهام متأخرة',detail:'يوجد '+lateTasks.length+' مهمة مفتوحة تجاوزت موعدها.',source:'بيانات المهام'});
   if(pendingSubs.length)alerts.push({level:'warning',title:'اشتراكات تحتاج متابعة',detail:'يوجد '+pendingSubs.length+' اشتراكًا بحالة معلقة أو متأخرة.',source:'بيانات الاشتراكات'});
   if(!d.payments.length)alerts.push({level:'info',title:'بيانات الإيرادات غير مكتملة',detail:'لا توجد سجلات مدفوعات مسجلة في مصدر البيانات الحالي.',source:'hbpx-payments'});
   if(!d.expenses.length)alerts.push({level:'info',title:'بيانات الصرف غير مكتملة',detail:'لا توجد مصروفات مسجلة؛ لا يمكن حساب ربح صافي موثوق.',source:'hbpx-expenses'});
   if(!d.metrics.length)alerts.push({level:'info',title:'تحليلات الموقع غير متاحة في هذا التقرير',detail:'لم تظهر سجلات في مصدر تحليلات المنصة؛ لا يُعد ذلك إثباتًا أن الزيارات صفر.',source:'hbpx-platform-analytics'});
   const latestByKey={};for(const x of d.snapshots){const k=x.category+'|'+x.metric;if(!latestByKey[k])latestByKey[k]=x}
   const manualMetrics=Object.values(latestByKey).sort((a,b)=>String(a.category).localeCompare(String(b.category)));
   return json(200,{generatedAt:new Date().toISOString(),coverage:{payments:d.payments.length,expenses:d.expenses.length,projects:d.projects.length,leads:d.leads.length,tasks:d.tasks.length,subscriptions:d.subscriptions.length,platformMetrics:d.metrics.length,funnelEvents:d.funnel.length},kpis:{revenueAll:revenue,expensesAll:spend,netRecorded:revenue-spend,revenue30,expenses30,net30:revenue30-spend30,projects:d.projects.length,activeProjects:activeProjects.length,leads:d.leads.length,openTasks:openTasks.length,lateTasks:lateTasks.length,pendingSubscriptions:pendingSubs.length},alerts,manualMetrics,snapshots:d.snapshots.slice(0,60),decisions:d.decisions.slice(0,80),sourceNotes:['الإيرادات والصرف محسوبة من السجلات الموجودة فقط؛ الربح هنا فرق السجلات المسجلة وليس بيانًا محاسبيًا مدققًا.','بيانات إنستغرام لا تتوفر إلا بعد إدخالها أو ربط مصدر رسمي.','لا تُنفّذ موافقة التوصية إجراءً خارجيًا تلقائيًا؛ إنها تسجل قرار المالكة فقط.']});
  }
  let b={};try{b=JSON.parse(e.body||'{}')}catch{return json(400,{error:'بيانات غير صالحة.'})}
  const now=new Date().toISOString();
  if(e.httpMethod==='POST'&&b.type==='metric'){
   const category=clean(b.category,50),metric=clean(b.metric,100),value=num(b.value),period=clean(b.period,40),source=clean(b.source,100),notes=clean(b.notes,1000);
   if(!['finance','instagram','website','quality','inventory','operations','growth'].includes(category)||!metric||!String(b.value??'').trim()||!period)return json(400,{error:'الفئة والمؤشر والقيمة والفترة مطلوبة.'});
   const id='snapshot-'+Date.now()+'-'+crypto.randomBytes(4).toString('hex');
   const item={id,type:'manual_metric',category,metric,value,period,source:source||'إدخال يدوي',notes,createdAt:now,createdBy:'owner'};
   await st('snapshots').setJSON(id,item);return json(201,{item});
  }
  if(e.httpMethod==='POST'&&b.type==='decision'){
   const title=clean(b.title,180),detail=clean(b.detail,1500),action=clean(b.action,1000);
   if(!title||!detail)return json(400,{error:'عنوان التوصية وتفاصيلها مطلوبة.'});
   const id='decision-'+Date.now()+'-'+crypto.randomBytes(4).toString('hex');
   const item={id,title,detail,proposedAction:action,status:'pending_approval',createdAt:now,updatedAt:now};
   await st('decisions').setJSON(id,item);return json(201,{item});
  }
  if(e.httpMethod==='PATCH'&&b.type==='decision'){
   const id=clean(b.id,140),status=clean(b.status,40);
   if(!id||!['approved','rejected','pending_approval'].includes(status))return json(400,{error:'بيانات القرار غير صحيحة.'});
   const item=await st('decisions').get(id,{type:'json'}).catch(()=>null);if(!item)return json(404,{error:'التوصية غير موجودة.'});
   item.status=status;item.updatedAt=now;item.ownerDecisionAt=now;item.ownerNote=clean(b.ownerNote,500);
   await st('decisions').setJSON(id,item);return json(200,{item,notice:status==='approved'?'تم تسجيل موافقة المالكة فقط؛ لم يُنفذ إجراء خارجي.':'تم تحديث قرار التوصية.'});
  }
  return json(405,{error:'Method not allowed'});
 }catch(err){console.error('monitoring error',err);return json(500,{error:'تعذر تحميل مركز المراقبة أو حفظ البيانات.'})}
};