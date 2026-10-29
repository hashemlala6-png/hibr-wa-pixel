const { getStore, connectLambda } = require('@netlify/blobs');
const { requireAdmin, json } = require('./auth-utils');
const crypto = require('crypto');
const { logActivity } = require('./client-activity');

// Explicit credentials are supported for deployments where Netlify does not inject Blobs context.
// Prefer the platform-injected context; fall back to server-side environment variables only.
const blobOptions = (name) => {
  const options = { name, consistency: 'strong' };
  const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
  const token = process.env.NETLIFY_AUTH_TOKEN;
  if (siteID && token) { options.siteID = siteID; options.token = token; }
  return options;
};
const store = () => getStore(blobOptions('hbpx-leads'));
const rateStore = () => getStore(blobOptions('hbpx-lead-rate'));
const clientIndex = () => getStore(blobOptions('hbpx-lead-index'));
const accountsStore = () => getStore(blobOptions('hbpx-client-accounts'));
function normalizeEmail(v){return String(v||'').trim().toLowerCase();}
function normalizePhone(v){return String(v||'').replace(/\D/g,'').replace(/^0/,'964');}
async function findExistingAccountClientId(email,phone){
  const targetEmail=normalizeEmail(email), targetPhone=normalizePhone(phone);
  if(!targetEmail&&!targetPhone)return null;
  const r=await accountsStore().list({prefix:'email-'}).catch(()=>({blobs:[]}));
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

const htmlEscape = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function notifyOwner(lead) {
  const summary = [
    'طلب جديد — حبر وبكسل',
    'الاسم: ' + lead.name,
    'واتساب: ' + lead.whatsapp,
    'البريد: ' + (lead.email || 'غير مذكور'),
    'الخدمة: ' + (lead.service || 'غير محددة'),
    'الميزانية: ' + (lead.budget || 'غير محددة'),
    'التفاصيل: ' + (lead.details || '—'),
    'المصدر: ' + lead.source,
    'رقم الطلب: ' + lead.id
  ].join('\n');
  const results = { email: 'not_configured', whatsapp: 'not_configured' };
  const emailKey = process.env.RESEND_API_KEY;
  const to = process.env.LEADS_NOTIFY_EMAIL;
  const from = process.env.LEADS_FROM_EMAIL;
  if (emailKey && to && from) {
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + emailKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from, to: [to], subject: 'طلب جديد من ' + lead.name + ' — حبر وبكسل',
          text: summary,
          html: '<h2>طلب جديد — حبر وبكسل</h2><pre style="font-family:Arial,sans-serif;white-space:pre-wrap;line-height:1.8">' + htmlEscape(summary) + '</pre>'
        })
      });
      results.email = r.ok ? 'sent' : 'failed';
      if (!r.ok) console.error('lead email notification failed', r.status, (await r.text()).slice(0,300));
    } catch (err) { results.email = 'failed'; console.error('lead email notification failed', err?.message || err); }
  }
  const waToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const template = process.env.WHATSAPP_TEMPLATE_NAME;
  const ownerPhone = (process.env.WHATSAPP_OWNER_NUMBER || '9647721971156').replace(/\D/g, '');
  if (waToken && phoneId && template) {
    try {
      const locale = process.env.WHATSAPP_TEMPLATE_LANGUAGE || 'ar';
      const r = await fetch('https://graph.facebook.com/v22.0/' + encodeURIComponent(phoneId) + '/messages', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + waToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp', recipient_type: 'individual', to: ownerPhone, type: 'template',
          template: { name: template, language: { code: locale }, components: [{ type: 'body', parameters: [
            { type: 'text', text: String(lead.name || 'عميل').slice(0, 200) },
            { type: 'text', text: String(lead.whatsapp || '—').slice(0, 100) },
            { type: 'text', text: String(lead.service || 'غير محددة').slice(0, 200) },
            { type: 'text', text: String(lead.budget || 'غير محددة').slice(0, 100) }
          ] }] }
        })
      });
      results.whatsapp = r.ok ? 'sent' : 'failed';
      if (!r.ok) console.error('lead WhatsApp notification failed', r.status, (await r.text()).slice(0,300));
    } catch (err) { results.whatsapp = 'failed'; console.error('lead WhatsApp notification failed', err?.message || err); }
  }
  return results;
}

async function notifyClientApproval(lead) {
  const result = { email: 'not_configured', whatsapp: 'not_configured' };
  const msg = 'مرحباً ' + (lead.name || 'بك') + '، تمت الموافقة على طلبك لدى حبر وبكسل. الخدمة: ' + (lead.service || 'الخدمة المطلوبة') + '. سنتواصل معك لتأكيد الخطوات التالية.';
  if (process.env.RESEND_API_KEY && (process.env.CLIENT_APPROVAL_FROM_EMAIL || process.env.LEADS_FROM_EMAIL) && lead.email) {
    try {
      const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: process.env.CLIENT_APPROVAL_FROM_EMAIL || process.env.LEADS_FROM_EMAIL, to: [lead.email], subject: 'تمت الموافقة على طلبك — حبر وبكسل', text: msg }) });
      result.email = r.ok ? 'sent' : 'failed'; if (!r.ok) console.error('client approval email failed', r.status, (await r.text()).slice(0,300));
    } catch (e) { result.email = 'failed'; console.error('client approval email failed', e.message || e); }
  } else if (!lead.email) result.email = 'no_customer_email';
  const token = process.env.WHATSAPP_ACCESS_TOKEN, phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID, template = process.env.WHATSAPP_CLIENT_APPROVAL_TEMPLATE_NAME;
  const phone = normalizePhone(lead.whatsapp);
  if (token && phoneId && template && phone) {
    try {
      const r = await fetch('https://graph.facebook.com/v22.0/' + encodeURIComponent(phoneId) + '/messages', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: phone, type: 'template', template: { name: template, language: { code: process.env.WHATSAPP_CLIENT_APPROVAL_TEMPLATE_LANGUAGE || 'ar' }, components: [{ type: 'body', parameters: [{ type: 'text', text: String(lead.name || 'عميل').slice(0,200) }, { type: 'text', text: String(lead.service || 'الخدمة المطلوبة').slice(0,200) }] }] } }) });
      result.whatsapp = r.ok ? 'sent' : 'failed'; if (!r.ok) console.error('client approval WhatsApp failed', r.status, (await r.text()).slice(0,300));
    } catch (e) { result.whatsapp = 'failed'; console.error('client approval WhatsApp failed', e.message || e); }
  }
  return result;
}

const allowedStatuses = ['new', 'contacted', 'proposal', 'approved', 'won', 'active', 'completed', 'lost'];

function clean(v, max = 2000) { return String(v ?? '').trim().slice(0, max); }

exports.handler = async (event) => {
  // This function uses the Lambda compatibility handler shape; initialize
  // Netlify Blobs from the Lambda event before any store is accessed.
  connectLambda(event);
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
    // Notifications are best-effort: email or WhatsApp outages must not undo a saved lead.
    const notifications = await notifyOwner(lead);
    return json(201, { ok: true, leadId: id, notifications });
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
    let customerNotifications = null;
    if (current.status === 'approved' && previousStatus !== 'approved') customerNotifications = await notifyClientApproval(current);
    return json(200, { lead: current, customerNotifications });
  }

  return json(405, { error: 'Method not allowed' });
};
