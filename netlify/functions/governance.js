const crypto=require('crypto');
const {getStore,connectLambda}=require('@netlify/blobs');
const {requireAdmin,json}=require('./auth-utils');
const store=()=>getStore({name:'hbpx-governance',consistency:'strong'});
const clean=(v,n=1000)=>String(v??'').trim().slice(0,n);
async function all(){const s=store(),r=await s.list({prefix:'proposal-'}),out=[];for(const b of r.blobs||[]){try{const x=await s.get(b.key,{type:'json'});if(x)out.push(x)}catch{}}return out.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt))}
exports.handler=async e=>{
 connectLambda(e);if(e.httpMethod==='OPTIONS')return json(204,{});const denied=requireAdmin(e);if(denied)return denied;try{
 if(e.httpMethod==='GET')return json(200,{items:await all(),policy:{externalActionsRequireOwnerApproval:true,approvalExecutesAction:false}});
 let b={};try{b=JSON.parse(e.body||'{}')}catch{return json(400,{error:'بيانات غير صالحة.'})}
 if(e.httpMethod==='POST'){if(b.type!=='proposal')return json(400,{error:'نوع الطلب غير معروف.'});const title=clean(b.title,180),details=clean(b.details,2000),channel=clean(b.channel,100),cost=Number(b.estimatedCost||0);if(!title||!details)return json(400,{error:'العنوان والتفاصيل مطلوبان.'});if(!Number.isFinite(cost)||cost<0)return json(400,{error:'التكلفة التقديرية غير صالحة.'});const now=new Date().toISOString(),id='proposal-'+Date.now()+'-'+crypto.randomBytes(4).toString('hex');const item={id,type:'proposal',title,details,channel,estimatedCost:cost,currency:clean(b.currency,12)||'IQD',risk:clean(b.risk,30)||'متوسط',status:'pending',createdAt:now,updatedAt:now,externalAction:false,notes:'هذا سجل موافقة فقط؛ لا ينفذ أي إجراء خارجي.'};await store().setJSON(id,item);return json(201,{item})}
 if(e.httpMethod==='PATCH'){const id=clean(b.id,160),decision=clean(b.decision,20),note=clean(b.note,1000);if(!id||!['approved','rejected','needs_changes'].includes(decision))return json(400,{error:'القرار غير صالح.'});const s=store(),item=await s.get(id,{type:'json'});if(!item)return json(404,{error:'المقترح غير موجود.'});if(item.status!=='pending')return json(409,{error:'تم اتخاذ قرار بشأن هذا المقترح سابقاً.'});item.status=decision;item.updatedAt=new Date().toISOString();item.ownerNote=note;item.decidedAt=item.updatedAt;await s.setJSON(id,item);return json(200,{item,executed:false,message:'تم تسجيل القرار فقط. لا ينفذ هذا النظام إجراءً خارجياً.'})}
 return json(405,{error:'Method not allowed'});
 }catch(err){return json(500,{error:'حدث خطأ في سجل الموافقات.'})}};
