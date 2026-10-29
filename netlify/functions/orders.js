const crypto=require('crypto');
const {getStore,connectLambda}=require('@netlify/blobs');
const {json,requireAdmin}=require('./auth-utils');
const {getClientSession}=require('./client-auth-utils');
const {logActivity}=require('./client-activity');
const blobOptions=(name)=>{const options={name,consistency:'eventual'};const siteID=process.env.NETLIFY_SITE_ID||process.env.SITE_ID||'76bd352d-826a-49dc-8f0f-5f576610b1ae';const token=process.env.NETLIFY_AUTH_TOKEN;if(siteID&&token){options.siteID=siteID;options.token=token;}return options;};
const accounts=()=>getStore(blobOptions('hbpx-client-accounts'));
const orders=()=>getStore(blobOptions('hbpx-orders'));
const leads=()=>getStore(blobOptions('hbpx-leads'));
const leadIndex=()=>getStore(blobOptions('hbpx-lead-index'));
const clean=(v,n=3000)=>String(v??'').trim().slice(0,n);
exports.handler=async e=>{
  connectLambda(e);
  if(e.httpMethod==='OPTIONS')return json(204,{});
  // Owner/admin operations: list and manage every client order.
  const adminAuth=requireAdmin(e);
  if(adminAuth===null && ['GET','PATCH','DELETE'].includes(e.httpMethod)){
    try{
      if(e.httpMethod==='GET'){
        const r=await orders().list({prefix:'order-'}); const out=[];
        for(const b of r.blobs||[]){const x=await orders().get(b.key,{type:'json'}).catch(()=>null);if(x)out.push(x)}
        out.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
        return json(200,{orders:out});
      }
      let b={};try{b=JSON.parse(e.body||'{}')}catch{return json(400,{error:'بيانات غير صالحة.'})}
      const id=clean(b.id,180); if(!id)return json(400,{error:'معرّف الطلب مطلوب.'});
      const x=await orders().get(id,{type:'json'}).catch(()=>null); if(!x)return json(404,{error:'الطلب غير موجود.'});
      if(e.httpMethod==='PATCH'){
        const allowed=['new','reviewing','quoted','approved','in_progress','completed','cancelled'];
        if(!allowed.includes(b.status))return json(400,{error:'حالة الطلب غير صحيحة.'});
        const previous=x.status; x.status=b.status; x.updatedAt=new Date().toISOString();
        await orders().setJSON(x.id,x);
        if(x.leadId){const lead=await leads().get(x.leadId,{type:'json'}).catch(()=>null);if(lead){const leadStatus={new:'new',reviewing:'contacted',quoted:'proposal',approved:'won',in_progress:'active',completed:'completed',cancelled:'lost'}[b.status]||lead.status;lead.status=leadStatus;lead.updatedAt=x.updatedAt;await leads().setJSON(lead.id,lead);}}
        await logActivity(x.clientId,'order','تم تحديث حالة الطلب من لوحة المالك',{orderId:x.id,from:previous,to:x.status});
        return json(200,{order:x});
      }
      await orders().delete(id);
      await logActivity(x.clientId,'order','تم حذف الطلب من لوحة المالك',{orderId:x.id});
      return json(200,{ok:true,id});
    }catch(err){return json(500,{error:'تعذر تنفيذ عملية الطلب.'});}
  }
  // Client operations require an authenticated client session.
  const session=getClientSession(e); if(!session)return json(401,{error:'يجب تسجيل الدخول أولاً.',code:'LOGIN_REQUIRED'});
  const account=await accounts().get(session.sub,{type:'json'}).catch(()=>null); if(!account)return json(401,{error:'انتهت جلسة الحساب. سجّل الدخول من جديد.',code:'LOGIN_REQUIRED'});
  if(e.httpMethod==='GET'){
    const r=await orders().list({prefix:`order-${account.id}-`}); const out=[];
    for(const b of r.blobs||[]){const x=await orders().get(b.key,{type:'json'}).catch(()=>null);if(x)out.push(x)}
    out.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt)); return json(200,{orders:out});
  }
  if(e.httpMethod!=='POST')return json(405,{error:'Method not allowed'});
  let b;try{b=JSON.parse(e.body||'{}')}catch{return json(400,{error:'بيانات غير صالحة.'})}
  const service=clean(b.service,160), details=clean(b.details,3000), budget=clean(b.budget,120), timeline=clean(b.timeline,120);
  if(!service||!details)return json(400,{error:'اختاري الخدمة واكتبي تفاصيل الطلب.'});
  const now=new Date().toISOString();
  const clientId=account.clientId||account.id;
  const orderId=`order-${account.id}-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
  // Reuse an existing open lead for this unified client identity when possible.
  // This prevents repeated authenticated orders from creating duplicate leads
  // while preserving a new lead when the previous opportunity is already closed.
  let leadId=null, lead=null;
  const indexed=await leadIndex().list({prefix:`client-${clientId}-`,limit:200}).catch(()=>({blobs:[]}));
  const candidates=[];
  for(const item of indexed.blobs||[]){
    const ref=await leadIndex().get(item.key,{type:'json'}).catch(()=>null);
    if(!ref?.leadId)continue;
    const existing=await leads().get(ref.leadId,{type:'json'}).catch(()=>null);
    if(existing && ['new','contacted','proposal'].includes(existing.status)) candidates.push(existing);
  }
  candidates.sort((a,b)=>new Date(b.updatedAt||b.createdAt||0)-new Date(a.updatedAt||a.createdAt||0));
  lead=candidates[0]||null;
  if(lead){
    leadId=lead.id;
    lead.name=account.name; lead.whatsapp=account.whatsapp; lead.activity=service;
    lead.message=details; lead.package=budget; lead.timeline=timeline;
    lead.source=lead.source||'authenticated-order'; lead.status='new'; lead.updatedAt=now;
    await leads().setJSON(leadId,lead);
  }else{
    leadId=`lead-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
    lead={id:leadId,clientId,name:account.name,whatsapp:account.whatsapp,activity:service,message:details,source:'authenticated-order',package:budget,status:'new',timeline,createdAt:now,updatedAt:now};
    await leads().setJSON(leadId,lead);
  }
  await leadIndex().setJSON(`client-${clientId}-${leadId}`,{leadId,clientId,createdAt:lead.createdAt||now,updatedAt:now});
  const order={id:orderId,clientId,accountId:account.id,name:account.name,email:account.email,whatsapp:account.whatsapp,service,budget,timeline,details,status:'new',createdAt:now,updatedAt:now,leadId};
  await orders().setJSON(orderId,order);
  await logActivity(clientId,'order','تم إنشاء طلب جديد من حساب العميل',{orderId,service,budget,timeline});
  return json(201,{ok:true,order});
};
