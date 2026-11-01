const crypto=require('crypto');
const {getStore,connectLambda}=require('@netlify/blobs');
const {json,requireAdmin}=require('./auth-utils');
const {getClientSession}=require('./client-auth-utils');

const projects=()=>getStore({name:'hbpx-projects',consistency:'strong'});
const accounts=()=>getStore({name:'hbpx-client-accounts',consistency:'strong'});
const messages=()=>getStore({name:'hbpx-project-messages',consistency:'strong'});
const approvals=()=>getStore({name:'hbpx-project-approvals',consistency:'strong'});
const clean=(v,n=1200)=>String(v??'').trim().slice(0,n);
const id=()=>Date.now()+'-'+crypto.randomBytes(5).toString('hex');

async function getActor(event){
  const clientSession=getClientSession(event);
  if(clientSession){
    const account=await accounts().get(clientSession.sub,{type:'json'}).catch(()=>null);
    if(account)return {role:'client',account};
  }
  if(requireAdmin(event)===null)return {role:'owner'};
  return null;
}
async function ownedProject(projectId,actor){
  const p=await projects().get(projectId,{type:'json'}).catch(()=>null);
  if(!p)return null;
  if(actor.role==='owner')return p;
  const a=actor.account,ids=[a.id,a.clientId].filter(Boolean);
  const lead=p.leadId?await getStore({name:'hbpx-leads',consistency:'strong'}).get(p.leadId,{type:'json'}).catch(()=>null):null;
  return ids.includes(p.clientId)||ids.includes(p.accountId)||p.email===a.email||(lead&&ids.includes(lead.clientId))?p:null;
}
async function list(store,prefix){
  const s=store(),r=await s.list({prefix,limit:100}),out=[];
  for(const b of r.blobs||[]){const x=await s.get(b.key,{type:'json'}).catch(()=>null);if(x)out.push(x)}
  return out;
}
exports.handler=async e=>{
  connectLambda(e);
  if(e.httpMethod==='OPTIONS')return json(204,{});
  const actor=await getActor(e);
  if(!actor)return json(401,{error:'سجّل الدخول أولاً.'});
  try{
    if(e.httpMethod==='GET'){
      const projectId=clean(e.queryStringParameters?.projectId,140);
      if(actor.role==='client'&&!projectId)return json(400,{error:'معرّف المشروع مطلوب.'});
      const p=projectId?await ownedProject(projectId,actor):null;
      if(projectId&&!p)return json(404,{error:'المشروع غير موجود ضمن حسابك.'});
      const allProjects=actor.role==='owner'?(projectId?[p]:await list(projects,'project-')):[p];
      const ids=allProjects.filter(Boolean).map(x=>x.id);
      const [ms,as]=await Promise.all([list(messages,'message-'),list(approvals,'approval-')]);
      return json(200,{messages:ms.filter(x=>ids.includes(x.projectId)&& (actor.role==='owner'||x.visibleToClient!==false)).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)),approvals:as.filter(x=>ids.includes(x.projectId)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))});
    }
    let b={};try{b=JSON.parse(e.body||'{}')}catch{return json(400,{error:'بيانات غير صالحة.'})}
    const projectId=clean(b.projectId,140),p=projectId?await ownedProject(projectId,actor):null;
    if(!p)return json(404,{error:'المشروع غير موجود أو لا تملك صلاحية الوصول إليه.'});
    if(e.httpMethod==='POST'){
      if(b.type==='message'){
        const body=clean(b.body,2000);if(body.length<2)return json(400,{error:'اكتب رسالة قبل الإرسال.'});
        const item={id:'message-'+id(),projectId,body,authorRole:actor.role,authorName:actor.role==='owner'?'فريق حبر وبكسل':clean(actor.account.name,120),visibleToClient:true,createdAt:new Date().toISOString()};
        await messages().setJSON(item.id,item);return json(201,{item});
      }
      if(actor.role==='owner'&&b.type==='approval'){
        const title=clean(b.title,180),description=clean(b.description,1600),kind=clean(b.kind,40);
        if(!title||!['content','design','plan','delivery','other'].includes(kind))return json(400,{error:'عنوان الموافقة ونوعها مطلوبان.'});
        const item={id:'approval-'+id(),projectId,title,description,kind,status:'pending',createdAt:new Date().toISOString(),decidedAt:null,decisionNote:''};
        await approvals().setJSON(item.id,item);return json(201,{item});
      }
      return json(400,{error:'نوع العملية غير معروف.'});
    }
    if(e.httpMethod==='PATCH'){
      if(actor.role!=='client')return json(403,{error:'هذا الإجراء مخصص لصاحب الحساب.'});
      const approvalId=clean(b.approvalId,160),decision=clean(b.decision,30),note=clean(b.note,700);
      if(!approvalId||!['approved','changes_requested'].includes(decision))return json(400,{error:'قرار الموافقة غير صالح.'});
      const item=await approvals().get(approvalId,{type:'json'}).catch(()=>null);
      if(!item||item.projectId!==projectId)return json(404,{error:'طلب الموافقة غير موجود.'});
      if(item.status!=='pending')return json(409,{error:'تم حسم هذا الطلب مسبقاً.'});
      item.status=decision;item.decisionNote=note;item.decidedAt=new Date().toISOString();await approvals().setJSON(item.id,item);
      return json(200,{item,externalAction:false});
    }
    return json(405,{error:'Method not allowed'});
  }catch(err){console.error('project communication error',err);return json(500,{error:'تعذر حفظ التحديث. حاول مرة أخرى.'})}
};
