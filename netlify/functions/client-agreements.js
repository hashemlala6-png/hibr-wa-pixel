const {getStore,connectLambda}=require('@netlify/blobs');
const {json}=require('./auth-utils');
const {getClientSession}=require('./client-auth-utils');
const stores={
 accounts:()=>getStore({name:'hbpx-client-accounts',consistency:'eventual'}),
 projects:()=>getStore({name:'hbpx-projects',consistency:'eventual'}),
 leads:()=>getStore({name:'hbpx-leads',consistency:'eventual'}),
 contracts:()=>getStore({name:'hbpx-contracts',consistency:'eventual'}),
 subscriptions:()=>getStore({name:'hbpx-subscriptions',consistency:'eventual'})
};
const clean=(v,n=240)=>String(v??'').trim().slice(0,n);
async function list(store,prefix){const st=stores[store](),r=await st.list({prefix}),out=[];for(const b of r.blobs||[]){const x=await st.get(b.key,{type:'json'}).catch(()=>null);if(x)out.push(x)}return out}
async function ownedProjects(account){
 const all=await list('projects','project-'),out=[];
 for(const p of all){
  const ids=[account.id,account.clientId].filter(Boolean);
  const lead=p.leadId?await stores.leads().get(p.leadId,{type:'json'}).catch(()=>null):null;
  if(ids.includes(p.clientId)||ids.includes(p.accountId)||String(p.email||'').toLowerCase()===String(account.email||'').toLowerCase()||(lead&&ids.includes(lead.clientId)))out.push(p);
 }
 return out;
}
exports.handler=async e=>{
 connectLambda(e);
 if(e.httpMethod==='OPTIONS')return json(204,{});
 const session=getClientSession(e);if(!session)return json(401,{error:'سجّل الدخول أولاً.',code:'LOGIN_REQUIRED'});
 try{
  const account=await stores.accounts().get(session.sub,{type:'json'}).catch(()=>null);if(!account)return json(401,{error:'الحساب غير موجود. سجّل الدخول من جديد.'});
  const projects=await ownedProjects(account),ids=new Set(projects.map(p=>p.id));
  if(e.httpMethod==='GET'){
   const [contracts,subscriptions]=await Promise.all([list('contracts','contract-'),list('subscriptions','subscription-')]);
   return json(200,{
    profile:{name:account.name,email:account.email,whatsapp:account.whatsapp,createdAt:account.createdAt,lastLoginAt:account.lastLoginAt||null},
    services:projects.map(p=>({projectId:p.id,name:p.name,service:p.service||p.serviceType||p.category||p.name,status:p.status,amount:p.amount||0})),
    contracts:contracts.filter(c=>ids.has(c.projectId)).map(c=>({id:c.id,projectId:c.projectId,number:c.number||'',title:c.title||c.name||'عقد خدمة',service:c.service||c.serviceType||'',terms:c.terms||c.content||c.body||'',amount:c.amount||0,status:c.status||'pending',startDate:c.startDate||'',dueDate:c.dueDate||'',signedAt:c.signedAt||null,signedName:c.signedName||'',signedHash:c.signedHash||''})),
    subscriptions:subscriptions.filter(s=>ids.has(s.projectId)).map(s=>({id:s.id,projectId:s.projectId,name:s.name||s.planName||s.plan||'اشتراك خدمة',service:s.service||'',status:s.status||'pending',amount:s.amount||s.price||0,currency:s.currency||'IQD',period:s.period||s.billingCycle||'',startDate:s.startDate||'',nextBillingDate:s.nextBillingDate||s.renewalDate||'',description:s.description||''}))
   });
  }
  if(e.httpMethod==='POST'){
   let b={};try{b=JSON.parse(e.body||'{}')}catch{return json(400,{error:'البيانات غير صالحة.'})}
   const id=clean(b.contractId,180),name=clean(b.signedName,160);
   if(!id||name.length<4||b.acceptTerms!==true)return json(400,{error:'اكتب الاسم الكامل ووافق على بنود العقد قبل التوقيع.'});
   const contract=await stores.contracts().get(id,{type:'json'}).catch(()=>null);
   if(!contract||!ids.has(contract.projectId))return json(404,{error:'العقد غير موجود ضمن مشاريع حسابك.'});
   if(contract.status==='signed'||contract.signedAt)return json(409,{error:'هذا العقد موقّع مسبقاً.'});
   if(!['pending','pending_signature','sent','awaiting_signature','review'].includes(String(contract.status||'pending')))return json(409,{error:'هذا العقد غير متاح للتوقيع حالياً. تواصل مع الإدارة.'});
   const terms=String(contract.terms||contract.content||contract.body||'').trim();
   if(terms.length<30)return json(409,{error:'العقد لم يتضمن بنود الاتفاق كاملة بعد. يرجى انتظار تحديث الإدارة.'});
   const crypto=require('crypto'),now=new Date().toISOString();
   const agreementText=JSON.stringify({contractId:id,projectId:contract.projectId,accountId:account.id,email:account.email,signedName:name,terms,amount:contract.amount||0,startDate:contract.startDate||'',dueDate:contract.dueDate||'',signedAt:now,ip:String(e.headers?.['x-nf-client-connection-ip']||'').slice(0,100),userAgent:String(e.headers?.['user-agent']||'').slice(0,300)});
   contract.status='signed';contract.signedAt=now;contract.signedName=name;contract.signerAccountId=account.id;contract.signerEmail=account.email;contract.signedHash=crypto.createHash('sha256').update(agreementText).digest('hex');contract.acceptance={accepted:true,acceptedAt:now,version:1,termsHash:crypto.createHash('sha256').update(terms).digest('hex')};contract.updatedAt=now;
   await stores.contracts().setJSON(id,contract);
   return json(200,{ok:true,signedAt:now,contractId:id});
  }
  return json(405,{error:'Method not allowed'});
 }catch(err){console.error('client agreements error',err);return json(500,{error:'تعذر تحميل الاتفاقات أو حفظ التوقيع.'})}
};
