const { getStore } = require('@netlify/blobs');
const { requireAdmin, json } = require('./auth-utils');
const crypto = require('crypto');
const { logActivity } = require('./client-activity');

const store = () => getStore({ name: 'hbpx-leads', consistency: 'strong' });
const rateStore = () => getStore({ name: 'hbpx-lead-rate', consistency: 'strong' });
const clientIndex = () => getStore({ name: 'hbpx-lead-index', consistency: 'strong' });
const accountsStore = () => getStore({ name: 'hbpx-client-accounts', consistency: 'strong' });
function normalizeEmail(v){return String(v||'').trim().toLowerCase();}
function normalizePhone(v){return String(v||'').replace(/\\D/g,'').replace(/^0/,'964');}
async function findExistingAccountClientId(email,phone){
  const targetEmail=normalizeEmail(email), targetPhone=normalizePhone(phone);
  if(!targetEmail&&!targetPhone)return null;
  const r=await accountsStore().list({prefix:'account-'}).catch(()=>({blobs:[]}));
  let best=null;
  for(const b of r.blobs||[]){
    const a=await accountsStore().get(b.key,{type:'json'}).catch(()=>null);
    if(!a)continue;
    const emailMatch=targetEmail&&normalizeEmail(a.email)===targetEmail;
    const phoneMatch=targetPhone&&normalizePhone(a.whatsapp)===targetPhone;
    if(emailMatch||phoneMatch){best=a;break;}
  }
  return best?.clientId||best?.id||null;
}
const requestIp = (event) => String(event.headers?.['x-nf-client-connection-ip'] || event.headers?.['x-forwarded-for'] || 'unknown').split(',')[0].trim().slice(0,120);
async function rateLimit(ip){
  const key='ip-'+crypto.createHash('sha256').update(ip).digest('hex').slice(0,32);
  const now=Date.now(), windowMs=10*60*1000, max=5;
  const cur=await rateStore().get(key,{type:'json'}).catch(()=>null);
  if(!cur || now-cur.startedAt>windowMs){await rateStore().setJSON(key,{startedAt:now,count:1});return {ok:true};}
  if(Number(cur.count||0)>=max)return {ok:false,retryAfter:Math.ceil((windowMs-(now-cur.startedAt))/1000)};
  await rateStore().setJSON(key,{...cur,count:Number(cur.count||0)+1});return {ok:true};
}
const allowedStatuses = ['new', 'contacted', 'proposal', 'won', 'active', 'completed', 'lost'];

function clean(v, max = 2000) { return String(v ?? '').trim().slice(0, max); }

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: {}, body: '' };

  if (event.httpMethod === 'POST') {
    let limit={ok:true};
    try { limit=await rateLimit(requestIp(event)); } catch (err) {
      // Rate limiting is telemetry/protection; a transient rate-store failure
      // must never make a valid lead submission look like a server failure.
      console.error('lead rate-limit store unavailable', err?.message || err);
    }
    if(!limit.ok)return json(429,{error:'طلبات كثيرة. حاول لاحقاً.',retryAfter:limit.retryAfter});
    let b;
    try { b = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'بيانات غير صالحة' }); }
    const name = clean(b.name, 120), whatsapp = clean(b.whatsapp, 40), email = clean(b.email, 254), service = clean(b.service, 120), budget = clean(b.budget, 120), details = clean(b.details, 3000);
    if (String(b.website || '').trim()) return json(400, { error: 'تعذر معالجة الطلب.' });
    if (!name || !whatsapp) return json(400, { error: 'الاسم ورقم واتساب مطلوبان.' });
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(400, { error: 'البريد الإلكتروني غير صحيح.' });
    const id = `lead-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const normalizedPhone = whatsapp.replace(/\D/g,'').replace(/^0/,'964');
    const existingAccountClientId = await findExistingAccountClientId(email, whatsapp).catch(err=>{console.error('account identity lookup failed',err?.message||err);return null;});
    const clientId = existingAccountClientId || ('client-' + crypto.createHash('sha256').update(normalizedPhone).digest('hex').slice(0,24));
    const lead = {
      id, clientId, name, whatsapp,
      email, service, budget, details,
      activity: clean(b.activity || service, 180), message: clean(b.message || details, 3000),
      source: clean(b.source || 'contact-form', 80),
      package: clean(b.package, 120),
      status: 'new', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    };
    // Persist the lead first. Secondary indexing/telemetry must not turn a
    // successful lead submission into a false 500 response.
    let saved=false, lastErr=null;
    for(let attempt=1; attempt<=2 && !saved; attempt++){
      try { await store().setJSON(id, lead); saved=true; }
      catch(err){ lastErr=err; if(attempt<2) await new Promise(r=>setTimeout(r,150)); }
    }
    if(!saved){
      console.error('lead primary write failed', lastErr?.message || lastErr);
      return json(503,{error:'الخدمة غير متاحة مؤقتاً. حاول بعد لحظات.',code:'LEAD_STORAGE_UNAVAILABLE'});
    }
    try { await clientIndex().setJSON(`client-${clientId}-${id}`,{leadId:id,clientId,createdAt:lead.createdAt}); }
    catch (err) { console.error('lead index write failed', err?.message || err); }
    try { await logActivity(clientId,'lead','تم إنشاء العميل المحتمل',{source:lead.source,package:lead.package,activity:lead.activity}); }
    catch (err) { console.error('lead activity write failed', err?.message || err); }
    return json(201, { ok: true, leadId: id });
  }

  const auth = requireAdmin(event);
  if (auth) return auth;

  if (event.httpMethod === 'GET') {
    const result = await store().list({ prefix: 'lead-' });
    const leads = [];
    for (const item of result.blobs || []) {
      try { const lead = await store().get(item.key, { type: 'json' }); if (lead) leads.push(lead); } catch {}
    }
    leads.sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
    return json(200, { leads });
  }

  if (event.httpMethod === 'DELETE') {
    let b;
    try { b = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'بيانات غير صالحة' }); }
    const id = clean(b.id, 200);
    if (!id) return json(400, { error: 'معرّف العميل مطلوب.' });
    const current = await store().get(id, { type: 'json' });
    if (!current) return json(404, { error: 'العميل غير موجود.' });
    await store().delete(id);
    try { await clientIndex().delete(`client-${current.clientId || id}-${id}`); } catch {}
    return json(200, { ok: true, deletedId: id });
  }

  if (event.httpMethod === 'PATCH') {
    let b;
    try { b = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'بيانات غير صالحة' }); }
    if (!b.id || !allowedStatuses.includes(b.status)) return json(400, { error: 'العميل أو الحالة غير صحيحة.' });
    const current = await store().get(b.id, { type: 'json' });
    if (!current) return json(404, { error: 'العميل غير موجود.' });
    const previousStatus = current.status;
    current.status = b.status;
    if (b.status === 'lost') current.lossReason = clean(b.lossReason, 160);
    else if (b.lossReason !== undefined) current.lossReason = clean(b.lossReason, 160);
    current.updatedAt = new Date().toISOString();
    await store().setJSON(b.id, current);
    await logActivity(current.clientId||b.id,'status','تغيير حالة العميل',{from:previousStatus,to:current.status});
    return json(200, { lead: current });
  }

  return json(405, { error: 'Method not allowed' });
};
