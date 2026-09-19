const { getStore } = require('@netlify/blobs');
const { requireAdmin, json } = require('./auth-utils');
const crypto = require('crypto');
const analyticsStore = () => getStore({name:'hbpx-platform-analytics', consistency:'strong'});
const store = () => getStore({name:'hbpx-funnel', consistency:'strong'});
const clean=(v,n=300)=>String(v??'').trim().slice(0,n);
function hashId(v){return crypto.createHash('sha256').update(String(v||'')).digest('hex').slice(0,24)}
exports.handler=async event=>{
  if(event.httpMethod==='OPTIONS') return json(204,{});
  if(event.httpMethod==='POST'){
    let b={}; try{b=JSON.parse(event.body||'{}')}catch{return json(400,{error:'بيانات غير صالحة.'})}
    const anon=clean(b.anonId,120), name=clean(b.name,80), path=clean(b.path||'/',300), action=clean(b.action,80);
    const allowed=['page_view','hero_cta','portfolio_view','services_view','onboarding_start','quote_request','whatsapp_click','contact_submit'];
    if(!anon||!allowed.includes(action)) return json(400,{error:'حدث غير صالح.'});
    const now=new Date().toISOString(); const id=`event-${Date.now()}-${crypto.randomBytes(5).toString('hex')}`;
    await store().setJSON(id,{id,anonId:hashId(anon),action,path,referrer:clean(b.referrer,300),device:clean(b.device,30),at:now});
    return json(202,{ok:true});
  }
  const auth=requireAdmin(event); if(auth)return auth;
  if(event.httpMethod==='GET'){
    const r=await store().list({prefix:'event-'}); const events=[];
    for(const x of r.blobs||[]){try{const e=await store().get(x.key,{type:'json'});if(e)events.push(e)}catch{}}
    const since=Date.now()-30*24*60*60*1000; const recent=events.filter(x=>new Date(x.at).getTime()>=since);
    const count=a=>recent.filter(x=>x.action===a).length;
    const unique=new Set(recent.map(x=>x.anonId));
    const funnel={visitors:unique.size,heroCta:count('hero_cta'),portfolio:count('portfolio_view'),onboarding:count('onboarding_start'),quote:count('quote_request'),whatsapp:count('whatsapp_click'),contact:count('contact_submit')};
    const pageMap={}; recent.filter(x=>x.action==='page_view').forEach(x=>pageMap[x.path]=(pageMap[x.path]||0)+1);
    const topPages=Object.entries(pageMap).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([path,views])=>({path,views}));
    let clientLogins=0, clientRegisters=0; const loggedInClients=new Set();
    try{
      const ar=await analyticsStore().list({prefix:'metric-'});
      for(const x of ar.blobs||[]){
        try{const a=await analyticsStore().get(x.key,{type:'json'}); if(!a||new Date(a.at).getTime()<since)continue; if(a.type==='client-login'){clientLogins++;if(a.details?.clientId)loggedInClients.add(String(a.details.clientId));} else if(a.type==='client-register')clientRegisters++;}catch{}
      }
    }catch{}
    return json(200,{rangeDays:30,total:recent.length,uniqueVisitors:unique.size,funnel,topPages,accountMetrics:{clientLogins,uniqueClientsLoggedIn:loggedInClients.size,clientRegisters,pageViews:count('page_view')}});
  }
  return json(405,{error:'Method not allowed'});
};
