const {getStore,connectLambda}=require('@netlify/blobs');
const { blobOptions } = require('./blob-config');
const {json}=require('./auth-utils');
const {getClientSession}=require('./client-auth-utils');
const {ownsProject}=require('./client-ownership');
const s={
  leads:()=>getStore(blobOptions('hbpx-leads', 'eventual')),
  projects:()=>getStore(blobOptions('hbpx-projects', 'eventual')),
  payments:()=>getStore(blobOptions('hbpx-payments', 'eventual')),
  tasks:()=>getStore(blobOptions('hbpx-tasks', 'eventual')),
  resultPlans:()=>getStore(blobOptions('hbpx-result-plans', 'eventual')),
  invoices:()=>getStore(blobOptions('hbpx-invoices', 'eventual')),
  contracts:()=>getStore(blobOptions('hbpx-contracts', 'eventual')),
  deliveries:()=>getStore(blobOptions('hbpx-deliveries', 'eventual'))
};
async function listByProject(storeName,prefix,projectId,map){
  const st=s[storeName](),out=[];let cursor;
  do{
    const page=await st.list({prefix,limit:100,cursor});
    for(const b of page.blobs||[]){const x=await st.get(b.key,{type:'json'}).catch(()=>null);if(x?.projectId===projectId)out.push(map(x));}
    cursor=page.cursor;
  }while(cursor);
  return out;
}
exports.handler=async e=>{
  connectLambda(e);
  if(e.httpMethod==='OPTIONS')return json(204,{});
  if(e.httpMethod!=='GET')return json(405,{error:'Method not allowed'});
  try{
    const session=getClientSession(e);
    if(!session)return json(401,{error:'يجب تسجيل الدخول أولاً.',code:'LOGIN_REQUIRED'});
    const account=await getStore(blobOptions('hbpx-client-accounts', 'eventual')).get(session.sub,{type:'json'}).catch(()=>null);
    if(!account)return json(401,{error:'انتهت جلسة الحساب. سجّل الدخول من جديد.',code:'LOGIN_REQUIRED'});
    const projectsStore=s.projects(),projects=[];
    let projectCursor;
    do{
     const projectPage=await projectsStore.list({prefix:'project-',limit:100,cursor:projectCursor});
     for(const b of projectPage.blobs||[]){
      const p=await projectsStore.get(b.key,{type:'json'}).catch(()=>null);
      if(!p)continue;
      const lead= p.leadId ? await s.leads().get(p.leadId,{type:'json'}).catch(()=>null) : null;
      const belongs=ownsProject(p,account,lead);
      if(!belongs)continue;
      const payments=await listByProject('payments','payment-',p.id,x=>({amount:x.amount,method:x.method,createdAt:x.createdAt}));
      const tasks=await listByProject('tasks','task-',p.id,x=>({title:x.title,status:x.status,dueDate:x.dueDate}));
      const invoices=await listByProject('invoices','invoice-',p.id,x=>({number:x.number,total:x.total,dueDate:x.dueDate,status:x.status,createdAt:x.createdAt}));
      const contracts=await listByProject('contracts','contract-',p.id,x=>({id:x.id,number:x.number,amount:x.amount,status:x.status,startDate:x.startDate,dueDate:x.dueDate,signedAt:x.signedAt||null,paymentPolicy:x.paymentPolicy||null}));
      const deliveries=await listByProject('deliveries','delivery-',p.id,x=>({id:x.id,title:x.title,url:x.url,note:x.note,status:x.status,stage:x.stage||'legacy',watermarked:x.watermarked===true,lowResolution:x.lowResolution===true,fullQuality:x.fullQuality===true,rightsTransferred:x.rightsTransferred===true,clientApproval:x.clientApproval||null,createdAt:x.createdAt}));
      const rr=await listByProject('resultPlans','result-',p.id,x=>({promise:x.promise||x.plan?.promise||'',deliverables:x.plan?.deliverables||[],handoffMessage:x.plan?.handoff_message||x.plan?.handoffMessage||'',status:x.status}));
      const approvedResults=rr.filter(x=>['approved','delivered'].includes(x.status));
      const paid=payments.reduce((a,x)=>a+Number(x.amount||0),0);
      const signedContract=contracts.filter(x=>x.status==='signed'&&x.signedAt).sort((a,b)=>new Date(b.signedAt)-new Date(a.signedAt))[0]||null;
      const amount=Number(signedContract?.amount||p.amount||0);
      const depositRequired=amount>0?Math.ceil(amount*0.10):0;
      const remaining=Math.max(amount-paid,0);
      const latestPreview=deliveries.filter(x=>x.stage==='preview').sort((a,b)=>new Date(b.createdAt||0)-new Date(a.createdAt||0))[0]||null;
      const contentApproved=latestPreview?.clientApproval?.decision==='approved';
      projects.push({id:p.id,name:p.name,status:p.status,startDate:p.startDate,dueDate:p.dueDate,amount,paid,remaining,depositRequired,depositMet:Boolean(signedContract&&depositRequired>0&&paid>=depositRequired),contractSigned:Boolean(signedContract),fullyPaid:Boolean(signedContract&&amount>0&&paid>=amount),contentApproved,finalDeliveryEligible:Boolean(signedContract&&amount>0&&paid>=amount&&contentApproved),payments,tasks,invoices,contracts,deliveries,clientResult:approvedResults[0]||null});
     }
     projectCursor=projectPage.cursor;
    }while(projectCursor);
    projects.sort((a,b)=>new Date(b.startDate||0)-new Date(a.startDate||0));
    return json(200,{client:{id:account.id,clientId:account.id,name:account.name,email:account.email,whatsapp:account.whatsapp},projects});
  }catch(err){console.error('client portal error',err);return json(500,{error:'تعذر تحميل مساحة العميل.'});}
};
