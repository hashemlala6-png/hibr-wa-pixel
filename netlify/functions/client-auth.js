const { env } = require('./env');
const crypto=require('crypto');
const {getStore}=require('@netlify/blobs');
const {json,requireAdmin}=require('./auth-utils');
const {createClientSession,getClientSession,sessionCookie,clearCookie}=require('./client-auth-utils');
const accounts=()=>getStore({name:'hbpx-client-accounts',consistency:'strong'});
const leads=()=>getStore({name:'hbpx-leads',consistency:'strong'});
const rate=()=>getStore({name:'hbpx-client-auth-rate',consistency:'strong'});
const memoryRate = new Map();
function memoryLimited(e,kind){ const k=kind+'-'+crypto.createHash('sha256').update(ip(e)).digest('hex').slice(0,32), now=Date.now(), win=10*60*1000, max=12; const cur=memoryRate.get(k); if(!cur||now-cur.startedAt>win){memoryRate.set(k,{startedAt:now,count:1});return true;} if(Number(cur.count||0)>=max)return false; cur.count=Number(cur.count||0)+1; return true; }
const clean=(v,n=240)=>String(v??'').trim().slice(0,n);
const emailNorm=v=>clean(v,240).toLowerCase();
const keyForEmail=e=>'email-'+crypto.createHash('sha256').update(emailNorm(e)).digest('hex').slice(0,48);
const ip=e=>String(e.headers?.['x-nf-client-connection-ip']||e.headers?.['x-forwarded-for']||'unknown').split(',')[0].trim().slice(0,120);
async function limited(e,kind){
  const k=kind+'-'+crypto.createHash('sha256').update(ip(e)).digest('hex').slice(0,32), now=Date.now(), win=10*60*1000, max=12;
  try{
    const cur=await rate().get(k,{type:'json'}).catch(()=>null);
    if(!cur||now-cur.startedAt>win){await rate().setJSON(k,{startedAt:now,count:1});return true;}
    if(Number(cur.count||0)>=max)return false;
    await rate().setJSON(k,{...cur,count:Number(cur.count||0)+1});
  }catch(err){
    console.error('client auth rate-limit unavailable; using instance fallback', err?.message||err);
    return memoryLimited(e,kind);
  }
  return true;
}

function hashPassword(password,salt){return crypto.scryptSync(password,salt,64).toString('hex');}
function makePassword(password){const salt=crypto.randomBytes(16).toString('hex');return {salt,hash:hashPassword(password,salt)};}
function checkPassword(password,a){const h=hashPassword(password,a.salt);return crypto.timingSafeEqual(Buffer.from(h,'hex'),Buffer.from(a.passwordHash,'hex'));}
async function safeActivity(...args){try{const {logActivity}=require('./client-activity'); await logActivity(...args);}catch{}}
async function safeMetric(...args){try{const {record}=require('./platform-analytics'); await record(...args);}catch{}}
function hasSessionSecret(){return Boolean(env('CLIENT_SESSION_SECRET'))}
function normalizePhone(v){let d=String(v||'').replace(/\D/g,''); if(d.startsWith('964')) return '0'+d.slice(3); if(d.startsWith('00964')) return '0'+d.slice(5); return d.startsWith('0')?d:'0'+d;}
async function hasApprovedLead(email,phone){
  try{
    const r=await leads().list({prefix:'lead-',limit:1000});
    for(const item of r.blobs||[]){
      const l=await leads().get(item.key,{type:'json'}).catch(()=>null);
      if(!l)continue;
      if(l.status==='approved' && emailNorm(l.email)===emailNorm(email) && normalizePhone(l.whatsapp)===normalizePhone(phone))return true;
    }
    return false;
  }catch(err){console.error('approved lead lookup unavailable',err?.message||err);throw err;}
}
async function findExistingClientId(email,phone){
  try{
    const r=await leads().list({prefix:'lead-',limit:1000});
    let best=null;
    for(const item of r.blobs||[]){
      const l=await leads().get(item.key,{type:'json'}).catch(()=>null); if(!l)continue;
      const sameEmail=email&&emailNorm(l.email)===email;
      const samePhone=phone&&normalizePhone(l.whatsapp)===phone;
      if(sameEmail||samePhone){
        if(!best||new Date(l.createdAt||0)>new Date(best.createdAt||0))best=l;
      }
    }
    return best?.clientId||null;
  }catch(err){console.warn('client identity lookup unavailable',err?.message||err);return null}
}
exports.handler=async e=>{
  try{

  if(e.httpMethod==='OPTIONS')return json(204,{});
  const action=e.queryStringParameters?.action||'me';
  if(e.httpMethod==='GET'&&action==='admin'){
    const auth=requireAdmin(e); if(auth)return auth;
    const r=await accounts().list({prefix:'email-'}); const items=[];
    for(const item of r.blobs||[]){try{const a=await accounts().get(item.key,{type:'json'});if(a)items.push({id:a.id,name:a.name,email:a.email,whatsapp:a.whatsapp,createdAt:a.createdAt,updatedAt:a.updatedAt,lastLoginAt:a.lastLoginAt||null});}catch{}}
    items.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));
    return json(200,{accounts:items});
  }
  if(e.httpMethod==='GET'&&action==='me'){
    const s=getClientSession(e); if(!s)return json(200,{authenticated:false});
    const a=await accounts().get(s.sub,{type:'json'}).catch(()=>null); if(!a)return json(200,{authenticated:false});
    return json(200,{authenticated:true,client:{id:a.id,clientId:a.clientId||a.id,name:a.name,email:a.email,whatsapp:a.whatsapp}});
  }
  if(e.httpMethod==='POST'&&action==='logout') return json(200,{authenticated:false},{'Set-Cookie':clearCookie()});
  if(e.httpMethod!=='POST')return json(405,{error:'Method not allowed'});
  if((action==='register'||action==='login')&&!hasSessionSecret()) return json(503,{error:'إعداد أمان جلسات العملاء ناقص في Netlify. أضف CLIENT_SESSION_SECRET.'});
  if(!(await limited(e,action)))return json(429,{error:'محاولات كثيرة. حاول بعد قليل.'});
  let b;try{b=JSON.parse(e.body||'{}')}catch{return json(400,{error:'بيانات غير صالحة.'})}
  const email=emailNorm(b.email), password=String(b.password||'');
  if(!email||!/^\S+@\S+\.\S+$/.test(email)||password.length<8)return json(400,{error:'أدخل بريدًا صحيحًا وكلمة مرور من 8 أحرف على الأقل.'});
  const id=keyForEmail(email);
  if(action==='register'){
    if(await accounts().get(id,{type:'json'}).catch(()=>null))return json(409,{error:'هذا البريد مسجل مسبقًا. سجّل الدخول.'});
    const name=clean(b.name,120), whatsapp=normalizePhone(b.whatsapp);
    if(!name||whatsapp.length<10)return json(400,{error:'الاسم ورقم واتساب مطلوبان.'});
    if(!await hasApprovedLead(email,whatsapp).catch(()=>null))return json(403,{error:'إنشاء الحساب متاح بعد موافقة حبر وبكسل على طلب مشروعك، وباستخدام نفس البريد ورقم واتساب.'});
    const pw=makePassword(password); const now=new Date().toISOString(); const clientId=await findExistingClientId(email,whatsapp)||id; const account={id,name,email,whatsapp,clientId,passwordHash:pw.hash,salt:pw.salt,createdAt:now,updatedAt:now,lastLoginAt:null};
    await accounts().setJSON(id,account);
    await safeActivity(clientId,'client-account','تم إنشاء حساب عميل جديد',{name,email,whatsapp});
    await safeMetric('client-register',{clientId:id});
    const token=createClientSession(id);
    return json(201,{authenticated:true,client:{id,clientId,name,email,whatsapp}},{'Set-Cookie':sessionCookie(token)});
  }
  if(action==='login'){
    const a=await accounts().get(id,{type:'json'}).catch(()=>null);
    if(!a||!a.passwordHash||!checkPassword(password,a))return json(401,{error:'البريد أو كلمة المرور غير صحيحة.'});
    if(!a.clientId){a.clientId=await findExistingClientId(a.email,normalizePhone(a.whatsapp))||a.id;}
    a.lastLoginAt=new Date().toISOString(); a.updatedAt=a.lastLoginAt; await accounts().setJSON(id,a);
    await safeActivity(a.clientId||a.id,'client-login','تم تسجيل دخول عميل',{email:a.email});
    await safeMetric('client-login',{clientId:a.id});
    const token=createClientSession(a.id);
    return json(200,{authenticated:true,client:{id:a.id,clientId:a.clientId||a.id,name:a.name,email:a.email,whatsapp:a.whatsapp}},{'Set-Cookie':sessionCookie(token)});
  }
  return json(400,{error:'إجراء غير معروف.'});
  }catch(err){
    console.error('client-auth error',err);
    return json(500,{error:'تعذر تنفيذ العملية على الخادم. جرّب مرة ثانية.'});
  }
};
