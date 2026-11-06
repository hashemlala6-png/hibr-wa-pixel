const crypto=require('crypto');
const { getStore, connectLambda } = require('@netlify/blobs');
const {requireAdmin,json}=require('./auth-utils');
const clean=(v,n=5000)=>String(v??'').trim().slice(0,n);
const projectsStore=()=>getStore({name:'hbpx-projects',consistency:'strong'});
const contractsStore=()=>getStore({name:'hbpx-contracts',consistency:'strong'});
const subscriptionsStore=()=>getStore({name:'hbpx-subscriptions',consistency:'strong'});
exports.handler=async e=>{
  connectLambda(e);
 if(e.httpMethod==='OPTIONS')return json(204,{});
 const auth=requireAdmin(e);if(auth)return auth;
 if(e.httpMethod!=='POST')return json(405,{error:'Method not allowed'});
 let b={};try{b=JSON.parse(e.body||'{}')}catch{return json(400,{error:'بيانات غير صالحة.'})}
 const projectId=clean(b.projectId,180),type=clean(b.type,30),now=new Date().toISOString();
 if(!projectId)return json(400,{error:'اختاري المشروع أولاً.'});
 const project=await projectsStore().get(projectId,{type:'json'}).catch(()=>null);
 if(!project)return json(404,{error:'المشروع غير موجود.'});
 if(type==='contract'){
  const title=clean(b.title,180),terms=clean(b.terms,12000),amount=Number(b.amount||0);
  const hasDepositPolicy=/(?:10\s*[%٪]|عشرة\s*بالمئة|10\s*بالمئة)/i.test(terms);
  const hasBalancePolicy=/(?:90\s*[%٪]|تسعين\s*بالمئة|90\s*بالمئة)/i.test(terms);
  if(!title||terms.length<30||!Number.isFinite(amount)||amount<=0)return json(400,{error:'العنوان وبنود العقد الكاملة والقيمة الأكبر من صفر مطلوبة.'});
  if(!hasDepositPolicy||!hasBalancePolicy)return json(400,{error:'أضيفي سياسة الدفع الأساسية إلى بنود العقد: 10% عربون و90% بعد الموافقة وقبل التسليم النهائي.'});
  const id='contract-'+Date.now()+'-'+crypto.randomBytes(4).toString('hex');
  const depositAmount=Math.ceil(amount*0.10);
  const paymentPolicy={version:1,depositPercent:10,balancePercent:90,depositAmount,finalBalanceAmount:Math.max(amount-depositAmount,0),startExecutionRequiresSignedContract:true,startExecutionRequiresDeposit:true,previewDeliveryRequiresWatermark:true,finalDeliveryRequiresFullPayment:true,rightsTransferRequiresFullPayment:true};
  const x={id,projectId,title,number:clean(b.number,80)||id.slice(-12).toUpperCase(),service:clean(b.service,180)||project.service||project.name||'',terms,amount,paymentPolicy,startDate:clean(b.startDate,30),dueDate:clean(b.dueDate,30),status:'pending_signature',createdAt:now,updatedAt:now,createdBy:'owner'};
  await contractsStore().setJSON(id,x);return json(201,{item:x});
 }
 if(type==='subscription'){
  const name=clean(b.name,180),amount=Number(b.amount||0),period=clean(b.period,80);
  if(!name||!Number.isFinite(amount)||amount<0||!period)return json(400,{error:'اسم الاشتراك والسعر ودورة الاشتراك مطلوبة.'});
  const id='subscription-'+Date.now()+'-'+crypto.randomBytes(4).toString('hex');
  const x={id,projectId,name,service:clean(b.service,180)||project.service||project.name||'',amount,currency:'IQD',period,status:'pending',startDate:clean(b.startDate,30),nextBillingDate:clean(b.nextBillingDate,30),description:clean(b.description,1000),createdAt:now,updatedAt:now};
  await subscriptionsStore().setJSON(id,x);return json(201,{item:x});
 }
 return json(400,{error:'نوع السجل غير معروف.'});
};
