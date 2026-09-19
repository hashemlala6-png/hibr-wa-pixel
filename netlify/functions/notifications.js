const { env } = require('./env');
const {getStore}=require('@netlify/blobs');
const {requireAdmin,json}=require('./auth-utils');
const store=()=>getStore({name:'hbpx-owner-notifications',consistency:'strong'});
const stateStore=()=>getStore({name:'hbpx-owner-notification-state',consistency:'strong'});
const keyOf=x=>String(x||'').slice(0,160);
async function list(limit=60){
  const out=[]; let cursor;
  do{
    const r=await store().list({prefix:'notification-',cursor,limit:100});
    for(const x of r.blobs||[]){const item=await store().get(x.key,{type:'json'}).catch(()=>null);if(item)out.push(item);}
    cursor=r.cursor;
  }while(cursor && out.length<300);
  out.sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt)));
  return out.slice(0,limit);
}
exports.handler=async e=>{
  if(e.httpMethod==='OPTIONS')return json(204,{});
  const a=requireAdmin(e);if(a)return a;
  try{
    if(e.httpMethod==='GET'){
      const items=await list(Math.min(100,Math.max(1,Number(e.queryStringParameters?.limit)||60)));
      const state=await stateStore().get('owner',{type:'json'}).catch(()=>null);
      const readAt=state?.readAt||null;
      const unread=items.filter(x=>!x.read && (!readAt || new Date(x.createdAt)>new Date(readAt))).length;
      return json(200,{items,unread,readAt});
    }
    if(e.httpMethod==='POST'){
      let b={};try{b=JSON.parse(e.body||'{}')}catch{}
      const now=new Date().toISOString();
      if(b.action==='read'){
        await stateStore().setJSON('owner',{readAt:now});
        return json(200,{ok:true,readAt:now});
      }
      if(b.action==='clear'){
        const items=await list(200);
        await Promise.all(items.map(x=>store().delete(`notification-${x.id}`).catch(()=>{})));
        await stateStore().setJSON('owner',{readAt:now});
        return json(200,{ok:true});
      }
      return json(400,{error:'إجراء غير معروف.'});
    }
    return json(405,{error:'Method not allowed'});
  }catch(err){return json(500,{error:'تعذر تحميل إشعارات المالك.',details:env('NODE_ENV')==='development'?err.message:undefined});}
};
