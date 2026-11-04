const {getStore,connectLambda}=require('@netlify/blobs');
const {json}=require('./auth-utils');
const {getClientSession}=require('./client-auth-utils');
const {countReceivedPayments,canDownloadDelivery,signedContractBlockReason}=require('./contract-policy');
const {projectBelongsToAccount}=require('./client-project-access');
const s={
  leads:()=>getStore({name:'hbpx-leads',consistency:'eventual'}),
  projects:()=>getStore({name:'hbpx-projects',consistency:'eventual'}),
  payments:()=>getStore({name:'hbpx-payments',consistency:'eventual'}),
  tasks:()=>getStore({name:'hbpx-tasks',consistency:'eventual'}),
  resultPlans:()=>getStore({name:'hbpx-result-plans',consistency:'eventual'}),
  invoices:()=>getStore({name:'hbpx-invoices',consistency:'eventual'}),
  contracts:()=>getStore({name:'hbpx-contracts',consistency:'eventual'}),
  deliveries:()=>getStore({name:'hbpx-deliveries',consistency:'strong'})
};
async function listByProject(storeName,prefix,projectId,map){
  const st=s[storeName](),r=await st.list({prefix}),out=[];
  for(const b of r.blobs||[]){const x=await st.get(b.key,{type:'json'}).catch(()=>null);if(x?.projectId===projectId)out.push(map(x));}
  return out;
}
exports.handler=async e=>{
  connectLambda(e);
  if(e.httpMethod==='OPTIONS')return json(204,{});
  if(e.httpMethod!=='GET')return json(405,{error:'Method not allowed'});
  try{
    const session=getClientSession(e);
    if(!session)return json(401,{error:'يجب تسجيل الدخول أولاً.',code:'LOGIN_REQUIRED'});
    const account=await getStore({name:'hbpx-client-accounts',consistency:'eventual'}).get(session.sub,{type:'json'}).catch(()=>null);
    if(!account)return json(401,{error:'انتهت جلسة الحساب. سجّل الدخول من جديد.',code:'LOGIN_REQUIRED'});
    const projectsStore=s.projects();
    const pr=await projectsStore.list({prefix:'project-'}),projects=[];
    for(const b of pr.blobs||[]){
      const p=await projectsStore.get(b.key,{type:'json'}).catch(()=>null);
      if(!p)continue;
      const lead= p.leadId ? await s.leads().get(p.leadId,{type:'json'}).catch(()=>null) : null;
      if(!projectBelongsToAccount(p,account,lead))continue;
      const payments=await listByProject('payments','payment-',p.id,x=>({projectId:x.projectId,amount:x.amount,method:x.method,status:x.status||'received',createdAt:x.createdAt}));
      const tasks=await listByProject('tasks','task-',p.id,x=>({title:x.title,status:x.status,dueDate:x.dueDate}));
      const invoices=await listByProject('invoices','invoice-',p.id,x=>({number:x.number,total:x.total,dueDate:x.dueDate,status:x.status,createdAt:x.createdAt}));
      const contracts=await listByProject('contracts','contract-',p.id,x=>({number:x.number,amount:x.amount,status:x.status,signedAt:x.signedAt,depositAmount:x.depositAmount,balanceAmount:x.balanceAmount,startDate:x.startDate,dueDate:x.dueDate}));
      const paid=countReceivedPayments(payments,p.id);
      const projectAmount=Number(p.amount||0);
      const fullyPaid=projectAmount>0&&paid>=projectAmount;
      const validSignedContract=!signedContractBlockReason(p.id,contracts,projectAmount);
      const deliveries=await listByProject('deliveries','delivery-',p.id,x=>{
        const hasPrivateFile=Boolean(x.fileKey);
        const accessLevel=String(x.accessLevel||(x.url?'final':'')).toLowerCase();
        const canDownloadPrivate=hasPrivateFile&&canDownloadDelivery(accessLevel,fullyPaid)&&(accessLevel!=='final'||validSignedContract);
        let externalUrl='';
        if(!hasPrivateFile&&x.url&&accessLevel==='final'&&fullyPaid&&validSignedContract){
          try{
            const parsed=new URL(String(x.url));
            if(parsed.protocol==='https:')externalUrl=parsed.href;
          }catch{}
        }
        const downloadUrl=canDownloadPrivate?'/.netlify/functions/deliveries?deliveryId='+encodeURIComponent(x.id):externalUrl;
        return {id:x.id,title:x.title,url:'',downloadUrl,note:x.note,status:x.status,accessLevel:accessLevel||'pending',createdAt:x.createdAt};
      });
      const rr=await listByProject('resultPlans','result-',p.id,x=>({promise:x.promise||x.plan?.promise||'',deliverables:x.plan?.deliverables||[],handoffMessage:x.plan?.handoff_message||x.plan?.handoffMessage||'',status:x.status}));
      const approvedResults=rr.filter(x=>['approved','delivered'].includes(x.status));
      projects.push({id:p.id,name:p.name,status:p.status,startDate:p.startDate,dueDate:p.dueDate,amount:p.amount,paid,remaining:Math.max(projectAmount-paid,0),fullyPaid,payments,tasks,invoices,contracts,deliveries,clientResult:approvedResults[0]||null});
    }
    projects.sort((a,b)=>new Date(b.startDate||0)-new Date(a.startDate||0));
    return json(200,{client:{id:account.id,clientId:account.clientId||account.id,name:account.name,email:account.email,whatsapp:account.whatsapp},projects});
  }catch(err){console.error('client portal error',err);return json(500,{error:'تعذر تحميل مساحة العميل.'});}
};
