const { env } = require('./env');
const { getStore } = require('@netlify/blobs');
const { requireAdmin, json } = require('./auth-utils');
const { logActivity } = require('./client-activity');
const stores = {
  quotes: () => getStore({ name: 'hbpx-quotes', consistency: 'strong' }),
  projects: () => getStore({ name: 'hbpx-projects', consistency: 'strong' }),
  payments: () => getStore({ name: 'hbpx-payments', consistency: 'strong' }),
  leads: () => getStore({ name: 'hbpx-leads', consistency: 'strong' })
};
const allowed = {
  quotes: ['draft','sent','accepted','rejected','expired'],
  projects: ['planned','active','review','completed','paused']
};
const clean=(v,n=500)=>String(v??'').trim().slice(0,n);
const amount=v=>{const n=Number(String(v??'').replace(/[^0-9]/g,''));return Number.isFinite(n)&&n>0?n:0};
async function all(name){const st=stores[name]();const result=await st.list({prefix:name==='quotes'?'quote-':name==='projects'?'project-':'payment-'});const out=[];for(const item of result.blobs||[]){try{const x=await st.get(item.key,{type:'json'});if(x)out.push(x)}catch{}}out.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));return out}
exports.handler=async event=>{
 if(event.httpMethod==='OPTIONS')return json(204,{});
 const auth=requireAdmin(event);if(auth)return auth;
 try{
  if(event.httpMethod==='GET')return json(200,{quotes:await all('quotes'),projects:await all('projects'),payments:await all('payments')});
  let b={};try{b=JSON.parse(event.body||'{}')}catch{return json(400,{error:'بيانات غير صالحة'})}
  if(event.httpMethod==='POST'){
   const now=new Date().toISOString();
   if(b.type==='quote'){
    if(!b.leadId||!amount(b.amount))return json(400,{error:'العميل والقيمة مطلوبان.'});
    const id=`quote-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;const x={id,leadId:clean(b.leadId,120),package:clean(b.package,60),packageName:clean(b.packageName,120),amount:amount(b.amount),duration:clean(b.duration,120),notes:clean(b.notes,2000),status:'draft',createdAt:now,updatedAt:now};await stores.quotes().setJSON(id,x);await logActivity(x.leadId,'quote','تم إنشاء عرض سعر',{id:x.id,amount:x.amount,package:x.packageName});return json(201,{item:x});
   }
   if(b.type==='project'){
    if(!b.leadId||!clean(b.name,160)||!amount(b.amount))return json(400,{error:'العميل واسم المشروع والقيمة مطلوبة.'});
    if(!allowed.projects.includes(b.status))b.status='planned';const lead=await stores.leads().get(clean(b.leadId,120),{type:'json'}).catch(()=>null);if(!lead)return json(404,{error:'العميل المرتبط بالمشروع غير موجود.'});const id=`project-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;const x={id,leadId:clean(b.leadId,120),clientId:lead.clientId||null,accountId:lead.clientId||null,clientEmail:lead.email||null,name:clean(b.name,160),amount:amount(b.amount),startDate:clean(b.startDate,30),dueDate:clean(b.dueDate,30),status:b.status,createdAt:now,updatedAt:now};await stores.projects().setJSON(id,x);await logActivity(x.leadId,'project','تم إنشاء مشروع',{id:x.id,name:x.name,amount:x.amount});return json(201,{item:x});
   }
   if(b.type==='payment'){
    if(!b.projectId||!amount(b.amount))return json(400,{error:'المشروع والمبلغ مطلوبان.'});const project=await stores.projects().get(clean(b.projectId,120),{type:'json'});if(!project)return json(404,{error:'المشروع غير موجود.'});const id=`payment-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;const x={id,projectId:clean(b.projectId,120),amount:amount(b.amount),method:clean(b.method,60),note:clean(b.note,500),createdAt:now};await stores.payments().setJSON(id,x);await logActivity(project.leadId,'payment','تم تسجيل دفعة',{projectId:x.projectId,amount:x.amount,method:x.method});return json(201,{item:x});
   }
   return json(400,{error:'نوع العملية غير معروف.'});
  }
  if(event.httpMethod==='PATCH'){
   const collection=clean(b.collection,20),id=clean(b.id,120),status=clean(b.status,30);if(!stores[collection]||!allowed[collection]?.includes(status))return json(400,{error:'الحالة غير صحيحة.'});const x=await stores[collection]().get(id,{type:'json'});if(!x)return json(404,{error:'العنصر غير موجود.'});const previousStatus=x.status;x.status=status;x.updatedAt=new Date().toISOString();await stores[collection]().setJSON(id,x);let clientId=x.leadId||null;if(!clientId&&x.projectId){const p=await stores.projects().get(x.projectId,{type:'json'});clientId=p?.leadId||null;}if(clientId)await logActivity(clientId,collection,'تحديث الحالة',{id,from:previousStatus,to:status});return json(200,{item:x});
  }
  return json(405,{error:'Method not allowed'});
 }catch(e){return json(500,{error:'حدث خطأ في الخادم.',details:env('NODE_ENV')==='development'?e.message:undefined})}
};
