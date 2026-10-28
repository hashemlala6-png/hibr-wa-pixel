const { env } = require('./env');
const { getStore } = require('@netlify/blobs');

// Netlify Scheduled Function: runs once per day and asks the authenticated
// integrations endpoint to sync every client that has a connected source.
exports.config = { schedule: '@daily' };
exports.handler = async () => {
  const secret = env('INTERNAL_SYNC_SECRET');
  if (!secret) return { statusCode: 500, body: JSON.stringify({error:'INTERNAL_SYNC_SECRET غير مضبوط'}) };
  const siteID = env('NETLIFY_SITE_ID') || env('SITE_ID') || '76bd352d-826a-49dc-8f0f-5f576610b1ae';
  const token = env('NETLIFY_AUTH_TOKEN');
  if (!token) return { statusCode: 500, body: JSON.stringify({error:'NETLIFY_AUTH_TOKEN غير مضبوط في إعدادات Netlify'}) };
  const store = getStore({name:'hbpx-integrations', siteID, token, consistency:'strong'});
  const listed = await store.list({prefix:'client-'});
  const base = env('URL') || env('DEPLOY_PRIME_URL');
  if (!base) return {statusCode:500,body:JSON.stringify({error:'عنوان الموقع غير متاح للـscheduled function'})};
  const results=[];
  for(const blob of listed.blobs||[]){
    try{
      const x=await store.get(blob.key,{type:'json'}); if(!x?.clientId || (!x.meta&&!x.ga4)) continue;
      const r=await fetch(`${base}/.netlify/functions/integrations`,{method:'POST',headers:{'Content-Type':'application/json','x-hbpx-internal-sync':secret},body:JSON.stringify({action:'sync',clientId:x.clientId})});
      results.push({clientId:x.clientId,status:r.status});
    }catch(e){results.push({clientId:blob.key.replace(/^client-/,''),error:e.message})}
  }
  return {statusCode:200,body:JSON.stringify({ok:true,results})};
};
