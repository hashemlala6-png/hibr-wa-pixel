const crypto=require('crypto');
const {getStore}=require('@netlify/blobs');
const store=()=>getStore({name:'hbpx-client-activity',consistency:'strong'});
const indexStore=()=>getStore({name:'hbpx-client-activity-index',consistency:'strong'});
const notificationStore=()=>getStore({name:'hbpx-owner-notifications',consistency:'strong'});
const clean=(v,n=1200)=>String(v??'').trim().slice(0,n);

// Activity/notifications are secondary telemetry. They must never make a
// customer-facing operation (lead/order/login) fail after its primary data
// has already been persisted.
async function logActivity(clientId,type,label,details={}){
  if(!clientId)return {ok:false,reason:'missing-client'};
  const now=new Date().toISOString();
  const id=`activity-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const cid=clean(clientId,120);
  const payload={id,clientId:cid,type:clean(type,40),label:clean(label,160),details,createdAt:now};
  let saved=false;
  try{await store().setJSON(id,payload);saved=true;}catch(err){console.error('activity primary write failed',err?.message||err)}
  try{await indexStore().setJSON(`client-${cid}-${id}`,{id,clientId:cid,createdAt:now});}catch(err){console.error('activity index write failed',err?.message||err)}
  try{await notificationStore().setJSON(`notification-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,{id,clientId:cid,type:payload.type,label:clean(label,220),details,createdAt:now,read:false});}catch(err){console.error('owner notification write failed',err?.message||err)}
  return {ok:saved,id};
}
module.exports={logActivity};
