const { env } = require('./env');
const { getStore } = require('@netlify/blobs');
const { requireAdmin, json } = require('./auth-utils');
const blobOptions = (name) => { const options={name,consistency:'strong'}; const siteID=process.env.NETLIFY_SITE_ID||process.env.SITE_ID||'76bd352d-826a-49dc-8f0f-5f576610b1ae'; const token=process.env.NETLIFY_AUTH_TOKEN; if(siteID&&token){options.siteID=siteID;options.token=token;} return options; };
const stores = {
  leads:()=>getStore(blobOptions('hbpx-leads')),
  clients:()=>getStore(blobOptions('hbpx-clients')),
  quotes:()=>getStore(blobOptions('hbpx-quotes')),
  projects:()=>getStore(blobOptions('hbpx-projects')),
  payments:()=>getStore(blobOptions('hbpx-payments')),
  tasks:()=>getStore(blobOptions('hbpx-tasks')),
  expenses:()=>getStore(blobOptions('hbpx-expenses')),
  invoices:()=>getStore(blobOptions('hbpx-invoices')),
  contracts:()=>getStore(blobOptions('hbpx-contracts')),
  subscriptions:()=>getStore(blobOptions('hbpx-subscriptions')),
  deliveries:()=>getStore(blobOptions('hbpx-deliveries')),
  resultPlans:()=>getStore(blobOptions('hbpx-result-plans')),
  activity:()=>getStore(blobOptions('hbpx-client-activity')),
  accounts:()=>getStore(blobOptions('hbpx-client-accounts'))
};
const clean=(v,n=2000)=>String(v??'').trim().slice(0,n);
async function all(name,prefix){const r=await stores[name]().list({prefix});const out=[];for(const b of r.blobs||[]){try{const x=await stores[name]().get(b.key,{type:'json'});if(x)out.push(x)}catch{}}return out}
async function build(){
 const [leads,quotes,projects,payments,tasks,expenses,invoices,contracts,subscriptions,deliveries,resultPlans,activities,accounts]=await Promise.all([
  all('leads','lead-'),all('quotes','quote-'),all('projects','project-'),all('payments','payment-'),all('tasks','task-'),all('expenses','expense-'),all('invoices','invoice-'),all('contracts','contract-'),all('subscriptions','subscription-'),all('deliveries','delivery-'),all('resultPlans','result-'),all('activity','activity-')
 ]);
 const saved=await all('clients','client-'); const savedMap=new Map(saved.map(x=>[x.id,x]));
 const groups=new Map();
 leads.forEach(l=>{const cid=l.clientId||l.id;if(!groups.has(cid))groups.set(cid,[]);groups.get(cid).push(l)});
 const accountMap=new Map();
 for(const a of accounts){
   accountMap.set(a.id,a);
   if(a.clientId) accountMap.set(a.clientId,a);
   const cid=a.clientId||a.id;
   if(!groups.has(cid)) groups.set(cid,[]);
 }
 return Array.from(groups.entries()).map(([id,group])=>{
   const account=accountMap.get(id)||null;
   if(!group.length && account){
     const now=account.updatedAt||account.createdAt;
     return {id,leadIds:[],name:account.name,whatsapp:account.whatsapp,activity:'',source:'account',status:'account',createdAt:account.createdAt,updatedAt:account.updatedAt,
       email:account.email,lastLoginAt:account.lastLoginAt||null,
       memory:{objective:'',audience:'',offer:'',problem:'',platform:'Instagram',brand:'',deliverables:'',constraints:'',context:'',notes:'',updatedAt:null},
       stats:{leads:0,quotes:0,projects:0,payments:0,openTasks:0,totalPaid:0},lastProject:null,lastResult:null,
       activityTimeline:[],projects:[],accountOnly:true};
   }
   group.sort((a,b)=>new Date(b.updatedAt||b.createdAt)-new Date(a.updatedAt||a.createdAt));
   const l=group[0], leadIds=new Set(group.map(x=>x.id)), profile=savedMap.get(id)||{}, accountRecord=accountMap.get(id)||null;
   const ps=projects.filter(x=>leadIds.has(x.leadId)), q=quotes.filter(x=>leadIds.has(x.leadId)), pids=new Set(ps.map(x=>x.id));
   const ev=(activities.filter(x=>x.clientId===id||leadIds.has(x.clientId)).map(x=>({id:x.id,type:x.type,label:x.label,at:x.createdAt,data:x.details||{}})));
   const add=(arr,type,label,getId)=>arr.forEach(x=>{if(getId(x))ev.push({id:x.id+'-derived',type,label,at:x.updatedAt||x.createdAt||new Date().toISOString(),data:x})});
   add(q,'quote','عرض سعر',x=>leadIds.has(x.leadId)); add(ps,'project','مشروع',x=>leadIds.has(x.leadId));
   add(payments,'payment','دفعة',x=>pids.has(x.projectId)); add(tasks,'task','مهمة',x=>pids.has(x.projectId)); add(expenses,'expense','مصروف',x=>pids.has(x.projectId));
   add(invoices,'invoice','فاتورة',x=>pids.has(x.projectId)); add(contracts,'contract','عقد',x=>pids.has(x.projectId)); add(subscriptions,'subscription','اشتراك',x=>pids.has(x.projectId)); add(deliveries,'delivery','تسليم',x=>pids.has(x.projectId));
   add(resultPlans,'result','خطة نتيجة',x=>leadIds.has(x.leadId)||x.clientId===id||(x.projectId&&pids.has(x.projectId)));
   group.forEach(g=>ev.push({id:g.id+'-lead',type:'lead',label:'تواصل جديد',at:g.createdAt,data:g})); ev.sort((a,b)=>new Date(b.at)-new Date(a.at));
   const lastResult=resultPlans.filter(x=>leadIds.has(x.leadId)||x.clientId===id||ps.some(p=>p.id===x.projectId)).sort((a,b)=>new Date(b.updatedAt||b.createdAt)-new Date(a.updatedAt||a.createdAt))[0]||null;
   const lastProject=ps.slice().sort((a,b)=>new Date(b.updatedAt||b.createdAt)-new Date(a.updatedAt||a.createdAt))[0]||null;
   const totalPaid=payments.filter(x=>pids.has(x.projectId)).reduce((a,x)=>a+Number(x.amount||0),0);
   return {id,leadIds:Array.from(leadIds),name:l.name||accountRecord?.name||'—',email:accountRecord?.email||l.email||'',whatsapp:l.whatsapp||accountRecord?.whatsapp||'',activity:l.activity||'',source:l.source||'',status:l.status||'new',createdAt:group[group.length-1].createdAt||accountRecord?.createdAt,updatedAt:l.updatedAt||accountRecord?.updatedAt,lastLoginAt:accountRecord?.lastLoginAt||null,
     memory:{objective:profile.memory?.objective||'',audience:profile.memory?.audience||'',offer:profile.memory?.offer||'',problem:profile.memory?.problem||'',platform:profile.memory?.platform||'Instagram',brand:profile.memory?.brand||'',deliverables:profile.memory?.deliverables||'',constraints:profile.memory?.constraints||'',context:profile.memory?.context||'',notes:profile.memory?.notes||'',updatedAt:profile.memory?.updatedAt||profile.updatedAt||null},
     stats:{leads:group.length,quotes:q.length,projects:ps.length,payments:payments.filter(x=>pids.has(x.projectId)).length,openTasks:tasks.filter(x=>pids.has(x.projectId)&&x.status!=='done').length,totalPaid},
     lastProject,lastResult,activityTimeline:ev.slice(0,120),projects:ps};
 });
}
exports.handler=async e=>{
 if(e.httpMethod==='OPTIONS')return json(204,{}); const auth=requireAdmin(e); if(auth)return auth;
 try{
  if(e.httpMethod==='GET'){const clients=await build(); const id=clean(e.queryStringParameters?.id,120); return json(200,{clients:id?clients.filter(x=>x.id===id):clients});}
  if(e.httpMethod==='PATCH'){
   let b={};try{b=JSON.parse(e.body||'{}')}catch{return json(400,{error:'بيانات غير صالحة.'})}
   if(!clean(b.id,120))return json(400,{error:'العميل مطلوب.'});
   const clients=await build(); const found=clients.find(c=>c.id===b.id); if(!found)return json(404,{error:'العميل غير موجود.'});
   const id=b.id, now=new Date().toISOString(), prev=await stores.clients().get(id,{type:'json'})||{};
   const memory={objective:clean(b.objective,1200),audience:clean(b.audience,900),offer:clean(b.offer,1200),problem:clean(b.problem,1200),platform:clean(b.platform,120),brand:clean(b.brand,1200),deliverables:clean(b.deliverables,1200),constraints:clean(b.constraints,900),context:clean(b.context,2000),notes:clean(b.notes,4000),updatedAt:now};
   const x={id,leadId:id,memory,createdAt:prev.createdAt||now,updatedAt:now}; await stores.clients().setJSON(id,x); return json(200,{client:x});
  }
  return json(405,{error:'Method not allowed'});
 }catch(err){return json(500,{error:'تعذر تحميل ملف العميل.',details:env('NODE_ENV')==='development'?err.message:undefined})}
};
