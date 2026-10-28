const crypto=require('crypto');
const {getStore}=require('@netlify/blobs');
const {requireAdmin,json}=require('./auth-utils');
const store=()=>getStore({name:'hbpx-review-gates',consistency:'strong'});
const clean=(v,n=3000)=>String(v??'').trim().slice(0,n);
async function all(){const s=store(),out=[];let cursor;do{const r=await s.list({prefix:'gate-',limit:100,cursor});for(const b of r.blobs||[]){try{const x=await s.get(b.key,{type:'json'});if(x)out.push(x)}catch{}}cursor=r.cursor}while(cursor);return out.sort((a,b)=>new Date(b.updatedAt)-new Date(a.updatedAt))}
exports.handler=async e=>{if(e.httpMethod==='OPTIONS')return json(204,{});const denied=requireAdmin(e);if(denied)return denied;try{
if(e.httpMethod==='GET')return json(200,{items:await all(),policy:{approvalIsReviewOnly:true,externalActionsExecuted:false}});
let b={};try{b=JSON.parse(e.body||'{}')}catch{return json(400,{error:'بيانات غير صالحة.'})}
if(e.httpMethod==='POST'){const phase=clean(b.phase,80),title=clean(b.title,180),deliverable=clean(b.deliverable,3000),criteria=clean(b.criteria,2000);if(!phase||!title||!deliverable)return json(400,{error:'المرحلة والعنوان والمخرجات المطلوبة حقول إلزامية.'});const now=new Date().toISOString(),id='gate-'+Date.now()+'-'+crypto.randomBytes(4).toString('hex');const item={id,phase,title,deliverable,criteria,status:'pending_review',createdAt:now,updatedAt:now,decision:null,decisionNote:'',externalAction:false};await store().setJSON(id,item);return json(201,{item})}
if(e.httpMethod==='PATCH'){const id=clean(b.id,180),decision=clean(b.decision,30),note=clean(b.note,2000);if(!id||!['approved','needs_changes','rejected'].includes(decision))return json(400,{error:'قرار المراجعة غير صالح.'});const s=store(),item=await s.get(id,{type:'json'});if(!item)return json(404,{error:'عنصر المراجعة غير موجود.'});if(item.status!=='pending_review')return json(409,{error:'هذه المرحلة حُسمت بالفعل. أنشئي نسخة مراجعة جديدة إذا تغير العمل.'});item.status=decision;item.decision=decision;item.decisionNote=note;item.decidedAt=new Date().toISOString();item.updatedAt=item.decidedAt;await s.setJSON(id,item);return json(200,{item,executed:false,message:'تم تسجيل قرار المراجعة فقط؛ لم ينفذ أي إجراء خارجي.'})}
return json(405,{error:'Method not allowed'});
}catch(err){return json(500,{error:'تعذر الوصول إلى سجل مراجعة المراحل.'})}};
