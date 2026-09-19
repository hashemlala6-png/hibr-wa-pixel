const crypto=require('crypto');
const {getStore}=require('@netlify/blobs');
const store=()=>getStore({name:'hbpx-platform-analytics',consistency:'strong'});
const clean=(v,n=80)=>String(v??'').trim().slice(0,n);
async function record(type,details={}){
  const now=new Date().toISOString();
  const id=`metric-${Date.now()}-${crypto.randomBytes(5).toString('hex')}`;
  await store().setJSON(id,{id,type:clean(type),details,at:now});
}
module.exports={record};
