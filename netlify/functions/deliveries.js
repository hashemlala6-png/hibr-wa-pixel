const {getStore,connectLambda}=require('@netlify/blobs');
const {requireAdmin,json}=require('./auth-utils');
const {getClientSession}=require('./client-auth-utils');
const {countReceivedPayments,canDownloadDelivery}=require('./contract-policy');
const MAX_BYTES=4*1024*1024;
const blobOptions=(name)=>{const options={name,consistency:'strong'};const siteID=process.env.NETLIFY_SITE_ID||process.env.SITE_ID||'76bd352d-826a-49dc-8f0f-5f576610b1ae';const token=process.env.NETLIFY_AUTH_TOKEN;if(siteID&&token){options.siteID=siteID;options.token=token;}return options;};
const stores={
  projects:()=>getStore(blobOptions('hbpx-projects')),
  payments:()=>getStore(blobOptions('hbpx-payments')),
  leads:()=>getStore(blobOptions('hbpx-leads')),
  accounts:()=>getStore(blobOptions('hbpx-client-accounts')),
  deliveries:()=>getStore(blobOptions('hbpx-deliveries')),
  files:()=>getStore(blobOptions('hbpx-private-deliveries'))
};
const clean=(v,n=200)=>String(v??'').trim().slice(0,n);
async function list(store,prefix){const st=store(),r=await st.list({prefix}),out=[];for(const b of r.blobs||[]){const x=await st.get(b.key,{type:'json'}).catch(()=>null);if(x)out.push(x)}return out}
async function getProject(projectId){return stores.projects().get(projectId,{type:'json'}).catch(()=>null)}
async function isFullyPaid(project){
  const payments=await list(stores.payments,'payment-');
  const paid=countReceivedPayments(payments,project.id);
  const total=Number(project.amount)||0;
  return total>0&&paid>=total;
}
async function ownedByClient(project,account){
  const ids=[account.id,account.clientId].filter(Boolean);
  if(ids.includes(project.clientId)||ids.includes(project.accountId))return true;
  if(account.email&&String(account.email).toLowerCase()===String(project.email||project.clientEmail||'').toLowerCase())return true;
  if(project.leadId){const lead=await stores.leads().get(project.leadId,{type:'json'}).catch(()=>null);if(lead&&(ids.includes(lead.clientId)||(account.email&&String(lead.email||'').toLowerCase()===String(account.email).toLowerCase())))return true;}
  return false;
}
exports.handler=async event=>{
  connectLambda(event);
  if(event.httpMethod==='OPTIONS')return {statusCode:204,headers:{},body:''};
  try{
    if(event.httpMethod==='POST'){
      const denied=requireAdmin(event);if(denied)return denied;
      let b;try{b=JSON.parse(event.body||'{}')}catch{return json(400,{error:'بيانات الرفع غير صالحة.'})}
      const projectId=clean(b.projectId,140),title=clean(b.title,160),filename=clean(b.filename,180).replaceAll('/','_').replaceAll(String.fromCharCode(92),'_');
      const accessLevel=['preview','final'].includes(b.accessLevel)?b.accessLevel:'';
      const contentType=clean(b.contentType,100).toLowerCase();
      if(!projectId||!title||!filename||!accessLevel||!['application/pdf','image/png','image/jpeg','image/webp'].includes(contentType))return json(400,{error:'اختاري مشروعاً واسماً ونوع ملف صحيحاً (PDF أو صورة).'});
      const project=await getProject(projectId);if(!project)return json(404,{error:'المشروع غير موجود.'});
      const raw=String(b.dataBase64||'').replace(/^data:[^,]+,/, '');
      if(!/^[A-Za-z0-9+/]*={0,2}$/.test(raw)||raw.length>Math.ceil(MAX_BYTES*4/3)+8)return json(413,{error:'الملف أكبر من الحد المسموح (4 ميغابايت) أو بياناته غير صالحة.'});
      const bytes=Buffer.from(raw,'base64');if(!bytes.length||bytes.length>MAX_BYTES)return json(413,{error:'حجم الملف غير مقبول. الحد الأقصى 4 ميغابايت.'});
      const signatures={
        'application/pdf':bytes=>bytes.subarray(0,5).toString()==='%PDF-',
        'image/png':bytes=>bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])),
        'image/jpeg':bytes=>bytes.length>3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255,
        'image/webp':bytes=>bytes.length>12&&bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP'
      };
      if(!signatures[contentType](bytes))return json(400,{error:'محتوى الملف لا يطابق نوعه المعلن.'});
      const id='delivery-'+Date.now()+'-'+require('crypto').randomBytes(4).toString('hex');
      const fileKey='private-'+id;
      await stores.files().set(fileKey,bytes,{metadata:{contentType,filename}});
      const item={id,projectId,title,filename,contentType,size:bytes.length,accessLevel,note:clean(b.note,500),status:accessLevel==='preview'?'preview':'ready',fileKey,createdAt:new Date().toISOString(),createdBy:'owner'};
      try{await stores.deliveries().setJSON(id,item)}catch(err){await stores.files().delete(fileKey).catch(()=>{});throw err;}
      return json(201,{ok:true,item:{id,title,filename,accessLevel,size:bytes.length}});
    }
    if(event.httpMethod==='GET'){
      const session=getClientSession(event);if(!session)return json(401,{error:'يجب تسجيل الدخول أولاً.'});
      const account=await stores.accounts().get(session.sub,{type:'json'}).catch(()=>null);if(!account)return json(401,{error:'انتهت جلسة الحساب.'});
      const id=clean(event.queryStringParameters?.deliveryId,180);if(!id)return json(400,{error:'معرّف التسليم مطلوب.'});
      const item=await stores.deliveries().get(id,{type:'json'}).catch(()=>null);if(!item)return json(404,{error:'التسليم غير موجود.'});
      const project=await getProject(item.projectId);if(!project||!await ownedByClient(project,account))return json(404,{error:'التسليم غير موجود ضمن حسابك.'});
      const fullyPaid=await isFullyPaid(project);
      if(!canDownloadDelivery(item.accessLevel,fullyPaid))return json(item.accessLevel==='final'?403:403,{error:item.accessLevel==='final'?'تتاح الملفات النهائية بعد تسديد كامل قيمة المشروع.':'هذا الملف غير متاح للتنزيل.'});
      const data=await stores.files().get(item.fileKey,{type:'arrayBuffer'});if(!data)return json(404,{error:'تعذر العثور على الملف.'});
      const bytes=Buffer.from(data);
      return {statusCode:200,isBase64Encoded:true,headers:{'Content-Type':item.contentType||'application/octet-stream','Content-Length':String(bytes.length),'Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(item.filename||'delivery'),'Cache-Control':'private, no-store, max-age=0','X-Content-Type-Options':'nosniff'},body:bytes.toString('base64')};
    }
    return json(405,{error:'Method not allowed'});
  }catch(err){console.error('private delivery error',err?.message||err);return json(500,{error:'تعذر معالجة التسليم حالياً.'});}
};
