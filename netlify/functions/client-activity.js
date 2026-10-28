const crypto=require('crypto');
const {getStore}=require('@netlify/blobs');
const blobOptions=name=>{const options={name,consistency:'strong'};const siteID=process.env.NETLIFY_SITE_ID||process.env.SITE_ID||'76bd352d-826a-49dc-8f0f-5f576610b1ae';const token=process.env.NETLIFY_AUTH_TOKEN;if(siteID&&token){options.siteID=siteID;options.token=token;}return options;};
const store=()=>getStore(blobOptions('hbpx-client-activity'));
const indexStore=()=>getStore(blobOptions('hbpx-client-activity-index'));
const notificationStore=()=>getStore(blobOptions('hbpx-owner-notifications'));
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
