const crypto=require('crypto');
const {getStore}=require('@netlify/blobs');
const {requireAdmin,json}=require('./auth-utils');

const defs={
 accounts:['hbpx-client-accounts','email-'], leads:['hbpx-leads','lead-'], orders:['hbpx-orders','order-'], quotes:['hbpx-quotes','quote-'], projects:['hbpx-projects','project-'], payments:['hbpx-payments','payment-'], tasks:['hbpx-tasks','task-'], expenses:['hbpx-expenses','expense-'], resultPlans:['hbpx-result-plans','result-'], activities:['hbpx-client-activity','activity-'], funnel:['hbpx-funnel','event-'], metrics:['hbpx-platform-analytics','metric-'], presence:['hbpx-presence',''], invoices:['hbpx-invoices','invoice-'], contracts:['hbpx-contracts','contract-'], subscriptions:['hbpx-subscriptions','subscription-'], deliveries:['hbpx-deliveries','delivery-'], qualityGates:['hbpx-quality-gates',''], integrations:['hbpx-integrations',''], growthSnapshots:['hbpx-growth-snapshots',''], growthBaselines:['hbpx-growth-baselines',''], growthReports:['hbpx-growth-reports',''], executionPlans:['hbpx-execution-plans',''], creativeDna:['hbpx-creative-dna',''], autopilot:['hbpx-autopilot','']
};
const clean=(v,n=300)=>String(v??'').trim().slice(0,n);
const num=v=>Number(v||0)||0;
function store(name){const options={name,consistency:'strong'};const siteID=process.env.NETLIFY_SITE_ID||process.env.SITE_ID||'76bd352d-826a-49dc-8f0f-5f576610b1ae';const token=process.env.NETLIFY_AUTH_TOKEN;if(siteID&&token){options.siteID=siteID;options.token=token;}return getStore(options);}
async function all(name,prefix){
  const st=store(name),out=[]; let cursor;
  do{
    const r=await st.list({prefix,limit:100,cursor});
    for(const item of r.blobs||[]){const v=await st.get(item.key,{type:'json'}).catch(()=>null);if(v)out.push(v)}
    cursor=r.cursor;
  }while(cursor);
  return out;
}
function pct(a,b){return b?Math.round(((a-b)/b)*100):a?100:0}
function hash(v){return crypto.createHash('sha256').update(String(v||'')).digest('hex').slice(0,24)}
exports.handler=async event=>{
  if(event.httpMethod==='OPTIONS')return json(204,{});
  const auth=requireAdmin(event);if(auth)return auth;
  if(event.httpMethod!=='GET')return json(405,{error:'Method not allowed'});
  try{
    const coreNames=['accounts','leads','orders','quotes','projects','payments','tasks','expenses','resultPlans','activities','funnel','metrics','presence'];
    const names=Object.keys(defs);
    const loaded=await Promise.all(coreNames.map(k=>all(...defs[k])));
    const data=Object.fromEntries(coreNames.map((k,i)=>[k,loaded[i]]));
    const inventory={};
    await Promise.all(Object.entries(defs).filter(([k])=>!coreNames.includes(k)).map(async ([k,[name,prefix]])=>{try{const r=await store(name).list({prefix,limit:1});inventory[k]=Number(r.totalItems??(r.blobs||[]).length)||0}catch{inventory[k]=0}}));
    const now=Date.now(),d30=now-30*86400000,d7=now-7*86400000;
    const accounts=data.accounts||[],leads=data.leads||[],orders=data.orders||[],quotes=data.quotes||[],projects=data.projects||[],payments=data.payments||[],tasks=data.tasks||[],expenses=data.expenses||[],plans=data.resultPlans||[],activities=data.activities||[],events=data.funnel||[],metrics=data.metrics||[];
    const recentEvents=events.filter(x=>new Date(x.at||0).getTime()>=d30);
    const uniqueVisitors=new Set(recentEvents.map(x=>x.anonId).filter(Boolean));
    const allUniqueVisitors=new Set(events.map(x=>x.anonId).filter(Boolean));
    const pageViews=events.filter(x=>x.action==='page_view');
    const recentPageViews=recentEvents.filter(x=>x.action==='page_view');
    const recentRegs=accounts.filter(x=>new Date(x.createdAt||0).getTime()>=d30);
    const recentLogins=accounts.filter(x=>new Date(x.lastLoginAt||0).getTime()>=d30);
    const loginMetrics=metrics.filter(x=>x.type==='client-login');
    const activeCutoff=now-5*60*1000;
    const active=(data.presence||[]).filter(x=>new Date(x.updatedAt||x.createdAt||0).getTime()>=activeCutoff);
    const activeVisitors=active.filter(x=>x.kind==='visitor'),activeClients=active.filter(x=>x.kind==='client'),activeOwners=active.filter(x=>x.kind==='owner');
    const revenue=payments.reduce((s,x)=>s+num(x.amount),0);
    const booked=projects.reduce((s,x)=>s+num(x.amount),0);
    const paidByProject=new Map();payments.forEach(x=>paidByProject.set(x.projectId,(paidByProject.get(x.projectId)||0)+num(x.amount)));
    const receivable=projects.reduce((s,x)=>s+Math.max(0,num(x.amount)-(paidByProject.get(x.id)||0)),0);
    const openOrders=orders.filter(x=>!['completed','cancelled'].includes(x.status)).length;
    const openQuotes=quotes.filter(x=>['draft','sent'].includes(x.status)).length;
    const activeProjects=projects.filter(x=>['planned','active','review'].includes(x.status)).length;
    const openTasks=tasks.filter(x=>x.status!=='done').length;
    const won=leads.filter(x=>['won','active','completed'].includes(x.status)).length;
    const newLeads=leads.filter(x=>x.status==='new').length;
    const source={};leads.forEach(x=>{const k=x.source||'غير محدد';source[k]=(source[k]||0)+1});
    const pageMap={};pageViews.forEach(x=>pageMap[x.path]=(pageMap[x.path]||0)+1);
    const recentActivities=activities.slice().sort((a,b)=>new Date(b.createdAt||0)-new Date(a.createdAt||0)).slice(0,25);
    const recentRegistrationRows=accounts.slice().sort((a,b)=>new Date(b.createdAt||0)-new Date(a.createdAt||0)).slice(0,15).map(a=>({id:a.id,name:a.name,email:a.email,whatsapp:a.whatsapp,createdAt:a.createdAt,lastLoginAt:a.lastLoginAt||null}));
    const recentOrders=orders.slice().sort((a,b)=>new Date(b.createdAt||0)-new Date(a.createdAt||0)).slice(0,12).map(o=>({id:o.id,name:o.name,email:o.email,service:o.service,status:o.status,budget:o.budget,createdAt:o.createdAt,clientId:o.clientId}));
    const activityFeed=[
      ...recentRegs.map(x=>({kind:'registration',at:x.createdAt,title:`تسجيل حساب: ${x.name||x.email}`,meta:x.email||'',ref:x.id})),
      ...recentOrders.map(x=>({kind:'order',at:x.createdAt,title:`طلب جديد: ${x.service||'مشروع'}`,meta:x.name||x.email||'',ref:x.id})),
      ...recentActivities.map(x=>({kind:x.type||'activity',at:x.createdAt,title:x.label||'نشاط',meta:x.clientId&&x.clientId!=='owner'?x.clientId:'',ref:x.id}))
    ].sort((a,b)=>new Date(b.at||0)-new Date(a.at||0)).slice(0,35);
    const geo={};active.forEach(x=>{const g=x.geo||{},k=[g.city,g.country].filter(Boolean).join('، ')||'غير متاح';geo[k]=(geo[k]||0)+1});
    return json(200,{generatedAt:new Date().toISOString(),counts:{
      visitors30:uniqueVisitors.size,visitorsAllTime:allUniqueVisitors.size,pageViews30:recentPageViews.length,pageViewsAllTime:pageViews.length,
      registered:accounts.length,registered30:recentRegs.length,loggedIn30:recentLogins.length,loginEventsAllTime:loginMetrics.length,
      activeNow:active.length,activeVisitors:activeVisitors.length,activeClients:activeClients.length,activeOwners:activeOwners.length,
      leads:leads.length,newLeads,wonLeads:won,orders:orders.length,openOrders,quotes:quotes.length,openQuotes,projects:projects.length,activeProjects,
      revenue,booked,receivable,tasksOpen:openTasks,expenses:expenses.length,resultPlans:plans.length
    },recentRegistrations:recentRegistrationRows,recentOrders,activityFeed,topPages:Object.entries(pageMap).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([path,views])=>({path,views})),sources:Object.entries(source).sort((a,b)=>b[1]-a[1]).slice(0,10).map(([name,count])=>({name,count})),live:{sessions:active.slice().sort((a,b)=>new Date(b.updatedAt)-new Date(a.updatedAt)).slice(0,50).map(x=>({kind:x.kind,page:x.page,geo:x.geo||{},device:x.device,updatedAt:x.updatedAt})),locations:Object.entries(geo).sort((a,b)=>b[1]-a[1]).slice(0,12).map(([name,count])=>({name,count}))},health:{accounts:accounts.length>=0,events:events.length>=0},inventory});
  }catch(err){console.error('owner-universe',err);return json(500,{error:'تعذر بناء رؤية المالك الشاملة.'});}
};
