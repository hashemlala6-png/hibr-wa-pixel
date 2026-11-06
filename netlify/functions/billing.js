const { env } = require('./env');
const crypto=require('crypto');
const { getStore, connectLambda } = require('@netlify/blobs');
const { blobOptions } = require('./blob-config');
const {requireAdmin,json}=require('./auth-utils');
const {logActivity}=require('./client-activity');
const {getProjectFinancials}=require('./project-financials');
const projectStore=()=>getStore(blobOptions('hbpx-projects', 'strong'));
const qualityStore=()=>getStore(blobOptions('hbpx-quality-gates', 'strong'));
const vqaStore=()=>getStore(blobOptions('hbpx-visual-qa', 'strong'));
async function approvedGate(projectId){
 const r=await qualityStore().list({prefix:'gate-'});
 let best=null;
 for(const b of r.blobs||[]){try{const x=await qualityStore().get(b.key,{type:'json'});if(x?.projectId===projectId&&x.status==='approved'&&x.kind==='final'&&(!best||new Date(x.approvedAt||x.updatedAt)>new Date(best.approvedAt||best.updatedAt)))best=x}catch{}}
 return best;
}
async function newestVQA(projectId){const r=await vqaStore().list({prefix:'vqa-'});let latest=null;for(const b of r.blobs||[]){try{const x=await vqaStore().get(b.key,{type:'json'});if(x?.projectId===projectId&&(!latest||new Date(x.createdAt)>new Date(latest.createdAt)))latest=x}catch{}}return latest;}
const stores={
 invoices:()=>getStore(blobOptions('hbpx-invoices', 'strong')),
 contracts:()=>getStore(blobOptions('hbpx-contracts', 'strong')),
 deliveries:()=>getStore(blobOptions('hbpx-deliveries', 'strong')),
 subscriptions:()=>getStore(blobOptions('hbpx-subscriptions', 'strong'))
};
const clean=(v,n=2000)=>String(v??'').trim().slice(0,n);
const amount=v=>{const n=Number(String(v??'').replace(/[^0-9.]/g,''));return Number.isFinite(n)&&n>=0?n:0};
async function all(name,prefix){const st=stores[name](),r=await st.list({prefix}),out=[];for(const b of r.blobs||[]){try{const x=await st.get(b.key,{type:'json'});if(x)out.push(x)}catch{}}return out.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));}
function renewalDate(start,cycle){const d=new Date(start+'T12:00:00');if(cycle==='yearly')d.setFullYear(d.getFullYear()+1);else if(cycle==='quarterly')d.setMonth(d.getMonth()+3);else d.setMonth(d.getMonth()+1);return d.toISOString().slice(0,10)}
function num(prefix){return `${prefix}-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`}
exports.handler=async e=>{
  connectLambda(e);
 if(e.httpMethod==='OPTIONS')return json(204,{});const a=requireAdmin(e);if(a)return a;
 try{
  if(e.httpMethod==='GET')return json(200,{invoices:await all('invoices','invoice-'),contracts:await all('contracts','contract-'),deliveries:await all('deliveries','delivery-'),subscriptions:await all('subscriptions','subscription-')});
  let b={};try{b=JSON.parse(e.body||'{}')}catch{return json(400,{error:'بيانات غير صالحة.'})}
  if(e.httpMethod==='POST'){
   const now=new Date().toISOString();
   if(b.type==='invoice'){
    if(!clean(b.projectId,120)||!clean(b.clientName,160))return json(400,{error:'المشروع واسم العميل مطلوبان.'});
    const subtotal=amount(b.subtotal),discount=amount(b.discount),tax=amount(b.tax),total=Math.max(subtotal-discount+tax,0);
    const id='invoice-'+Date.now()+'-'+crypto.randomBytes(3).toString('hex');const x={id,number:num('INV'),projectId:clean(b.projectId,120),clientName:clean(b.clientName,160),clientPhone:clean(b.clientPhone,50),description:clean(b.description,1000),subtotal,discount,tax,total,dueDate:clean(b.dueDate,30),status:'issued',createdAt:now,updatedAt:now};await stores.invoices().setJSON(id,x);const p=await projectStore().get(x.projectId,{type:'json'});if(p?.leadId)await logActivity(p.leadId,'invoice','تم إنشاء فاتورة',{number:x.number,total:x.total});return json(201,{item:x});
   }
   if(b.type==='contract'){
    if(!clean(b.projectId,120)||!clean(b.clientName,160))return json(400,{error:'المشروع واسم العميل مطلوبان.'});
    const id='contract-'+Date.now()+'-'+crypto.randomBytes(3).toString('hex');const x={id,number:num('CTR'),projectId:clean(b.projectId,120),clientName:clean(b.clientName,160),scope:clean(b.scope,4000),terms:clean(b.terms,5000),amount:amount(b.amount),startDate:clean(b.startDate,30),dueDate:clean(b.dueDate,30),status:'draft',createdAt:now,updatedAt:now};await stores.contracts().setJSON(id,x);const p=await projectStore().get(x.projectId,{type:'json'});if(p?.leadId)await logActivity(p.leadId,'contract','تم إنشاء عقد',{number:x.number,amount:x.amount});return json(201,{item:x});
   }
   if(b.type==='subscription'){
    if(!clean(b.projectId,120)||!clean(b.clientName,160)||!amount(b.amount)||!clean(b.planName,160))return json(400,{error:'المشروع والعميل والباقـة والقيمة مطلوبة.'});
    const start=clean(b.startDate,30)||new Date().toISOString().slice(0,10);const cycle=['monthly','quarterly','yearly'].includes(b.cycle)?b.cycle:'monthly';
    const next=renewalDate(start,cycle);const id='subscription-'+Date.now()+'-'+crypto.randomBytes(3).toString('hex');const x={id,projectId:clean(b.projectId,120),clientName:clean(b.clientName,160),planName:clean(b.planName,160),amount:amount(b.amount),cycle,startDate:start,nextRenewal:next,status:'active',autoRenew:!!b.autoRenew,note:clean(b.note,1000),createdAt:now,updatedAt:now};await stores.subscriptions().setJSON(id,x);const p=await projectStore().get(x.projectId,{type:'json'});if(p?.leadId)await logActivity(p.leadId,'subscription','تم إنشاء اشتراك',{planName:x.planName,amount:x.amount,cycle:x.cycle});return json(201,{item:x});
   }
   if(b.type==='delivery'){
    const projectId=clean(b.projectId,120),title=clean(b.title,180),rawUrl=clean(b.url,2000),stage=clean(b.stage,20)||'final';
    if(!projectId||!title||!rawUrl)return json(400,{error:'المشروع والعنوان ورابط التسليم مطلوبة.'});
    if(!['preview','final'].includes(stage))return json(400,{error:'مرحلة التسليم يجب أن تكون معاينة أو نهائية.'});
    let url;try{url=new URL(rawUrl)}catch{return json(400,{error:'رابط التسليم غير صالح.'})}
    if(url.protocol!=='https:'||!url.hostname||url.username||url.password)return json(400,{error:'رابط التسليم يجب أن يكون HTTPS آمناً.'});
    const project=await projectStore().get(projectId,{type:'json'}).catch(()=>null);
    if(!project)return json(404,{error:'المشروع غير موجود.'});
    const financial=await getProjectFinancials(projectId,project.amount);
    if(!financial.contractSigned)return json(409,{error:'التسليم مقفول حتى يوقّع العميل العقد.',financial});
    if(stage==='preview'){
     if(!financial.depositMet)return json(409,{error:'لا يمكن عرض المعاينة قبل استلام عربون 10% من قيمة العقد.',financial});
     if(b.watermarkConfirmed!==true||b.lowResolutionConfirmed!==true)return json(400,{error:'أكدي أن نسخة المراجعة تحمل علامة مائية أو دقة منخفضة، وأنها ليست ملفاً أصلياً كاملاً.'});
     if(b.finalQualityConfirmed===true||b.rightsTransferConfirmed===true)return json(400,{error:'لا يمكن اعتبار المعاينة نسخة نهائية أو نقل الحقوق في هذه المرحلة.'});
     const id='delivery-'+Date.now()+'-'+crypto.randomBytes(3).toString('hex');
     const x={id,projectId,title,url:url.toString(),note:clean(b.note,1000),stage:'preview',watermarked:true,lowResolution:true,fullQuality:false,rightsTransferred:false,ownerConfirmedPreviewAt:now,status:'ready',createdAt:now,updatedAt:now};
     await stores.deliveries().setJSON(id,x);
     if(project.leadId)await logActivity(project.leadId,'delivery','تم إتاحة معاينة محمية للعميل',{title:x.title,deliveryId:id,stage:'preview'});
     return json(201,{item:x,financial,message:'حُفظت المعاينة المحمية فقط. النسخة الأصلية والحقوق غير متاحة.'});
    }

    if(!financial.fullyPaid)return json(409,{error:'التسليم النهائي ونقل الحقوق مقفولان حتى سداد كامل المبلغ (100%).',financial});
    const deliveries=await all('deliveries','delivery-');
    const latestPreview=deliveries.filter(x=>x.projectId===projectId&&x.stage==='preview').sort((a,b)=>new Date(b.createdAt||0)-new Date(a.createdAt||0))[0];
    if(!latestPreview||latestPreview.clientApproval?.decision!=='approved')return json(409,{error:'يلزم اعتماد العميل لآخر معاينة قبل إتاحة الملفات النهائية.',previewId:latestPreview?.id||null});
    if(b.finalQualityConfirmed!==true||b.rightsTransferConfirmed!==true)return json(400,{error:'أكدي اجتياز النسخة النهائية لفحص الجودة، وأن الملفات أصلية كاملة الجودة ومن دون علامة مائية، قبل نقل الحقوق.'});
    const gate=await approvedGate(projectId);
    if(!gate)return json(409,{error:'التسليم النهائي مقفول حتى تعتمد بوابة الجودة النهائية للمشروع.'});
    const latest=await newestVQA(projectId);
    if(latest&&new Date(latest.createdAt)>new Date(gate.approvedAt||gate.updatedAt))return json(409,{error:'تم فحص مخرج بصري بعد اعتماد بوابة الجودة. أعيدي الفحص النهائي واعتمدي النسخة الأحدث قبل التسليم.'});
    if(gate.result?.passed!==true||Number(gate.result?.criticalCount)>0)return json(409,{error:'التسليم النهائي مقفول: بوابة الجودة غير ناجحة أو بها أخطاء حرجة.'});
    const id='delivery-'+Date.now()+'-'+crypto.randomBytes(3).toString('hex');
    const x={id,projectId,title,url:url.toString(),note:clean(b.note,1000),stage:'final',watermarked:false,lowResolution:false,fullQuality:true,rightsTransferred:true,rightsTransferredAt:now,finalQualityConfirmedAt:now,clientApprovedPreviewId:latestPreview.id,qualityGateId:gate.id,status:'ready',createdAt:now,updatedAt:now};
    await stores.deliveries().setJSON(id,x);
    if(project.leadId)await logActivity(project.leadId,'delivery','تم إتاحة الملفات النهائية ونقل الحقوق بعد اكتمال السداد',{title:x.title,deliveryId:id,stage:'final'});
    return json(201,{item:x,financial,message:'تم تسجيل التسليم النهائي ونقل الحقوق بعد اكتمال السداد وموافقة العميل والجودة.'});
   }
   return json(400,{error:'نوع العملية غير معروف.'});
  }
  if(e.httpMethod==='PATCH'){
   const type=clean(b.type,20), id=clean(b.id,120);
   if(type==='subscription'){
    const x=await stores.subscriptions().get(id,{type:'json'});if(!x)return json(404,{error:'الاشتراك غير موجود.'});
    if(b.action==='renew'){x.startDate=x.nextRenewal||new Date().toISOString().slice(0,10);x.nextRenewal=renewalDate(x.startDate,x.cycle);x.status='active';x.updatedAt=new Date().toISOString();await stores.subscriptions().setJSON(id,x);const p=await projectStore().get(x.projectId,{type:'json'});if(p?.leadId)await logActivity(p.leadId,'subscription','تحديث الاشتراك',{status:x.status,action:b.action||null});return json(200,{item:x});}
    if(['active','paused','cancelled','expired'].includes(b.status)){x.status=b.status;x.updatedAt=new Date().toISOString();await stores.subscriptions().setJSON(id,x);const p=await projectStore().get(x.projectId,{type:'json'});if(p?.leadId)await logActivity(p.leadId,'subscription','تحديث الاشتراك',{status:x.status,action:b.action||null});return json(200,{item:x});}
    return json(400,{error:'حالة الاشتراك غير صحيحة.'});
   } const map={invoice:['issued','paid','cancelled','overdue'],contract:['draft','sent','accepted','rejected','expired'],delivery:['ready','delivered','archived']};
   if(!map[type]||!map[type].includes(b.status))return json(400,{error:'الحالة غير صحيحة.'});const name=type==='invoice'?'invoices':type==='contract'?'contracts':'deliveries';const x=await stores[name]().get(id,{type:'json'});if(!x)return json(404,{error:'العنصر غير موجود.'});
   if(type==='delivery'&&b.status==='delivered'&&(x.stage!=='final'||x.fullQuality!==true||x.watermarked!==false||x.rightsTransferred!==true))return json(409,{error:'لا يمكن تسليم نسخة مراجعة كملفات نهائية. التسليم النهائي يتطلب نسخة كاملة الجودة، بلا علامة مائية، وبعد نقل الحقوق.'});
   x.status=b.status;x.updatedAt=new Date().toISOString();await stores[name]().setJSON(id,x);const p=await projectStore().get(x.projectId,{type:'json'});if(p?.leadId)await logActivity(p.leadId,type,'تحديث '+type,{status:x.status});return json(200,{item:x});
  }
  return json(405,{error:'Method not allowed'});
 }catch(err){return json(500,{error:'حدث خطأ في الخادم.',details:env('NODE_ENV')==='development'?err.message:undefined})}
};
