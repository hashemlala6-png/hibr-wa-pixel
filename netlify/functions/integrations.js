const { env } = require('./env');
const crypto = require('crypto');
const { getStore } = require('@netlify/blobs');
const { requireAdmin, json } = require('./auth-utils');
const { logActivity } = require('./client-activity');

const blobOptions = (name) => { const options={name,consistency:'strong'}; const siteID=env('NETLIFY_SITE_ID')||env('SITE_ID')||'76bd352d-826a-49dc-8f0f-5f576610b1ae'; const token=env('NETLIFY_AUTH_TOKEN'); if(siteID&&token){options.siteID=siteID;options.token=token;} return options; };\nconst store = () => getStore(blobOptions('hbpx-integrations'));
const MAX = 12000;
const clean=(v,n=MAX)=>String(v??'').trim().slice(0,n);
const secretKey=()=>crypto.createHash('sha256').update(env('ADMIN_SESSION_SECRET')||'').digest();
function encrypt(text){
  if(!env('ADMIN_SESSION_SECRET')) throw new Error('ADMIN_SESSION_SECRET غير مضبوط');
  const iv=crypto.randomBytes(12), key=secretKey(), c=crypto.createCipheriv('aes-256-gcm',key,iv);
  const enc=Buffer.concat([c.update(String(text),'utf8'),c.final()]);
  return {iv:iv.toString('base64url'),data:enc.toString('base64url'),tag:c.getAuthTag().toString('base64url')};
}
function decrypt(box){
  const key=secretKey(), d=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(box.iv,'base64url'));
  d.setAuthTag(Buffer.from(box.tag,'base64url'));
  return Buffer.concat([d.update(Buffer.from(box.data,'base64url')),d.final()]).toString('utf8');
}
async function get(id){return await store().get('client-'+id,{type:'json'});}
async function put(id,x){return store().setJSON('client-'+id,x);}
function daysAgo(n){const d=new Date();d.setUTCDate(d.getUTCDate()-n);return d.toISOString().slice(0,10)}
function isoDate(v){return /^\d{4}-\d{2}-\d{2}$/.test(String(v||''))?v:''}
function sumRows(rows,metric){
  return (rows||[]).reduce((s,r)=>{
    const v = r?.metricValues?.[metric]?.value ?? r?.value ?? 0;
    const n = Number(v);
    return s + (Number.isFinite(n) ? n : 0);
  },0);
}

async function metaFetch(config, since, until){
  const token=decrypt(config.secret); const version=config.version||env('META_GRAPH_VERSION')||'v23.0';
  const id=config.igUserId; if(!id) throw new Error('Instagram Business Account ID غير مضبوط.');
  const base=`https://graph.facebook.com/${version}`;
  const url=new URL(`${base}/${encodeURIComponent(id)}/insights`);
  url.searchParams.set('metric','reach,impressions,profile_views'); url.searchParams.set('period','day'); url.searchParams.set('since',since); url.searchParams.set('until',until); url.searchParams.set('access_token',token);
  const r=await fetch(url); const d=await r.json(); if(!r.ok) throw new Error(d.error?.message||'Meta API رفض الطلب.');
  const account=await fetch(`${base}/${encodeURIComponent(id)}?fields=followers_count&access_token=${encodeURIComponent(token)}`).then(x=>x.json());
  if(account.error) throw new Error(account.error.message||'تعذر قراءة متابعي Instagram.');
  const metrics={reach:sumRows((d.data||[]).find(x=>x.name==='reach')?.values,'value'),impressions:sumRows((d.data||[]).find(x=>x.name==='impressions')?.values,'value'),visits:sumRows((d.data||[]).find(x=>x.name==='profile_views')?.values,'value'),followers:Number(account.followers_count||0)};
  return {provider:'meta',range:{since,until},metrics,rawMeta:{metricNames:(d.data||[]).map(x=>x.name)}};
}

function b64urlJson(x){return Buffer.from(JSON.stringify(x)).toString('base64url')}
async function googleAccessToken(sa){
  const now=Math.floor(Date.now()/1000);
  const head=b64urlJson({alg:'RS256',typ:'JWT'}), body=b64urlJson({iss:sa.client_email,scope:'https://www.googleapis.com/auth/analytics.readonly',aud:'https://oauth2.googleapis.com/token',iat:now-30,exp:now+3500});
  const input=`${head}.${body}`; const sign=crypto.createSign('RSA-SHA256'); sign.update(input); const sig=sign.sign(sa.private_key,'base64url');
  const jwt=`${input}.${sig}`;
  const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:jwt})});
  const d=await r.json(); if(!r.ok) throw new Error(d.error_description||'تعذر الحصول على Google access token.'); return d.access_token;
}
async function gaFetch(config,since,until){
  const sa=JSON.parse(decrypt(config.secret)); const token=await googleAccessToken(sa); const property=clean(config.propertyId,80).replace(/^properties\//,''); if(!property)throw new Error('GA4 Property ID غير مضبوط.');
  const r=await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${encodeURIComponent(property)}:runReport`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({dateRanges:[{startDate:since,endDate:until}],metrics:[{name:'activeUsers'},{name:'sessions'},{name:'screenPageViews'},{name:'engagementRate'},{name:'conversions'},{name:'totalRevenue'}]})});
  const d=await r.json(); if(!r.ok) throw new Error(d.error?.message||'GA4 API رفض الطلب.');
  const rows=d.rows||[]; const first=rows[0]?.metricValues||[]; const num=i=>Number(first[i]?.value||0); const metrics={visits:num(1),engagement:num(3),inquiries:num(4),sales:num(5),activeUsers:num(0),sessions:num(1),pageViews:num(2)};
  return {provider:'ga4',range:{since,until},metrics,rawGa4:{rows:rows.length}};
}

exports.handler=async event=>{
 const internal = event.headers?.['x-hbpx-internal-sync'] || event.headers?.['X-HBPX-Internal-Sync'];
 const internalBuf=Buffer.from(String(internal||'')); const secretBuf=Buffer.from(String(env('INTERNAL_SYNC_SECRET')||'')); const isInternal=!!(internal&&secretBuf.length&&internalBuf.length===secretBuf.length&&crypto.timingSafeEqual(internalBuf,secretBuf));
 if(!isInternal){ const auth=requireAdmin(event); if(auth)return auth; }
 try{
  const method=event.httpMethod; const qs=event.queryStringParameters||{}; const clientId=clean(qs.clientId,120);
  if(method==='GET'){
    if(!clientId)return json(400,{error:'العميل مطلوب.'});
    const x=await get(clientId)||{}; return json(200,{clientId,connections:{meta:x.meta?{connected:true,igUserId:x.meta.igUserId,version:x.meta.version||null,lastSync:x.meta.lastSync||null}:null,ga4:x.ga4?{connected:true,propertyId:x.ga4.propertyId,lastSync:x.ga4.lastSync||null}:null}});
  }
  if(method!=='POST')return json(405,{error:'Method not allowed'});
  let b={};try{b=JSON.parse(event.body||'{}')}catch{return json(400,{error:'بيانات غير صالحة.'})}
  const id=clean(b.clientId,120); if(!id)return json(400,{error:'العميل مطلوب.'}); const x=await get(id)||{clientId:id};
  if(b.action==='connect_meta'){
    const token=clean(b.accessToken,MAX); const igUserId=clean(b.igUserId,100); if(!token||!igUserId)return json(400,{error:'أدخل Access Token وInstagram Business Account ID.'});
    x.meta={igUserId,version:clean(b.version,30)||env('META_GRAPH_VERSION')||'v23.0',secret:encrypt(token),lastSync:null,connectedAt:new Date().toISOString()}; await put(id,x); await logActivity(id,'integration','تم ربط Meta / Instagram',{provider:'meta'}); return json(200,{ok:true,connection:{provider:'meta',connected:true,igUserId,version:x.meta.version}});
  }
  if(b.action==='connect_ga4'){
    const propertyId=clean(b.propertyId,80); let sa=b.serviceAccount; if(typeof sa==='string')try{sa=JSON.parse(sa)}catch{sa=null};
    if(!propertyId||!sa?.client_email||!sa?.private_key)return json(400,{error:'أدخل GA4 Property ID وJSON الخاص بـ Service Account.'});
    x.ga4={propertyId,secret:encrypt(JSON.stringify(sa)),lastSync:null,connectedAt:new Date().toISOString()}; await put(id,x); await logActivity(id,'integration','تم ربط Google Analytics 4',{provider:'ga4',propertyId}); return json(200,{ok:true,connection:{provider:'ga4',connected:true,propertyId}});
  }
  if(b.action==='disconnect'){
    if(b.provider==='meta')delete x.meta; if(b.provider==='ga4')delete x.ga4; await put(id,x); return json(200,{ok:true});
  }
  if(b.action==='sync'){
    const since=isoDate(b.since)||daysAgo(30), until=isoDate(b.until)||new Date().toISOString().slice(0,10); const out=[];
    if(x.meta){try{const r=await metaFetch(x.meta,since,until);out.push(r);x.meta.lastSync=new Date().toISOString()}catch(e){out.push({provider:'meta',error:e.message})}}
    if(x.ga4){try{const r=await gaFetch(x.ga4,since,until);out.push(r);x.ga4.lastSync=new Date().toISOString()}catch(e){out.push({provider:'ga4',error:e.message})}}
    if(!out.length)return json(400,{error:'لا توجد حسابات مربوطة لهذا العميل.'});
    // Convert fetched metrics to a verified snapshot. Do not overwrite baseline.
    const merged={followers:0,engagement:0,reach:0,visits:0,inquiries:0,sales:0}; const sources=[];
    for(const r of out){if(r.error)continue;Object.assign(merged,{followers:Math.max(merged.followers,r.metrics.followers||0),reach:merged.reach+(r.metrics.reach||0),visits:merged.visits+(r.metrics.visits||0),inquiries:merged.inquiries+(r.metrics.inquiries||0),sales:merged.sales+(r.metrics.sales||0),engagement:Math.max(merged.engagement,r.metrics.engagement||0)});sources.push(r.provider)}
    if(!sources.length){await put(id,x);return json(502,{error:'فشل الاتصال بالمصادر.',results:out})}
    const stamp=new Date().toISOString(); const snap={id:'integration-snapshot-'+Date.now()+'-'+crypto.randomBytes(4).toString('hex'),clientId:id,createdAt:stamp,updatedAt:stamp,date:until,metrics:merged,notes:`مزامنة آلية موثقة من: ${sources.join(' + ')} · الفترة ${since} → ${until}`,sources,verified:true};
    await getStore({name:'hbpx-growth-snapshots',consistency:'strong'}).setJSON(snap.id,snap); await put(id,x); await logActivity(id,'growth','تمت مزامنة نتائج حقيقية من الحسابات المرتبطة',{sources,period:{since,until},snapshotId:snap.id});
    return json(200,{ok:true,results:out,snapshot:snap});
  }
  return json(400,{error:'الإجراء غير معروف.'});
 }catch(e){return json(500,{error:e.message||'تعذر تشغيل التكامل.'})}
};
