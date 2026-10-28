const crypto=require('crypto');
const {getStore}=require('@netlify/blobs');
const {requireAdmin,json}=require('./auth-utils');
const {logActivity}=require('./client-activity');
const {getAIContext,saveAIHistory}=require('./ai-context');
const stores={
 projects:()=>getStore({name:'hbpx-projects',consistency:'strong'}),
 tasks:()=>getStore({name:'hbpx-tasks',consistency:'strong'}),
 plans:()=>getStore({name:'hbpx-execution-plans',consistency:'strong'}),
 gates:()=>getStore({name:'hbpx-review-gates',consistency:'strong'})
};
const clean=(v,n=3000)=>String(v??'').trim().slice(0,n);
const list=async(name,prefix)=>{const st=stores[name](),r=await st.list({prefix}),out=[];for(const b of r.blobs||[]){try{const x=await st.get(b.key,{type:'json'});if(x)out.push(x)}catch{}}return out.sort((a,b)=>new Date(b.updatedAt||b.createdAt)-new Date(a.updatedAt||a.createdAt));};
const uid=(p)=>p+'-'+Date.now()+'-'+crypto.randomBytes(4).toString('hex');
exports.handler=async e=>{
 if(e.httpMethod==='OPTIONS')return json(204,{});
 const auth=requireAdmin(e);if(auth)return auth;
 try{
  if(e.httpMethod==='GET'){
   const clientId=clean(e.queryStringParameters?.clientId,120);if(!clientId)return json(400,{error:'العميل مطلوب.'});
   const [projects,tasks,plans]=await Promise.all([list('projects','project-'),list('tasks','task-'),list('plans','execution-')]);
   const ps=projects.filter(p=>p.leadId===clientId||p.clientId===clientId);
   const pids=new Set(ps.map(p=>p.id));
   return json(200,{projects:ps,tasks:tasks.filter(t=>pids.has(t.projectId)),plans:plans.filter(p=>p.clientId===clientId)});
  }
  if(e.httpMethod!=='POST')return json(405,{error:'Method not allowed'});
  let b={};try{b=JSON.parse(e.body||'{}')}catch{return json(400,{error:'بيانات غير صالحة.'})}
  const action=clean(b.action,40),clientId=clean(b.clientId,120);if(!clientId)return json(400,{error:'العميل مطلوب.'});
  if(action==='create_plan'){
   const reviewGateId=clean(b.reviewGateId,180);if(!reviewGateId)return json(409,{error:'قبل إنشاء خطة التنفيذ، أنشئي مرحلة مراجعة واعتمديها من مركز المراجعة.'});
   const reviewGate=await stores.gates().get(reviewGateId,{type:'json'});if(!reviewGate||reviewGate.status!=='approved')return json(409,{error:'خطة التنفيذ تحتاج إلى مرحلة مراجعة موجودة ومعتمدة.'});
   const projectId=clean(b.projectId,120);if(!projectId)return json(400,{error:'اختر المشروع.'});
   const project=await stores.projects().get(projectId,{type:'json'});if(!project)return json(404,{error:'المشروع غير موجود.'});
   if(project.leadId!==clientId&&project.clientId!==clientId)return json(403,{error:'المشروع لا يتبع لهذا العميل.'});
   const title=clean(b.title,220)||'خطة نمو';
   const objective=clean(b.objective,800),decision=clean(b.decision,1200);
   const rawTasks=Array.isArray(b.tasks)?b.tasks.slice(0,20):[];
   if(!objective||!decision||!rawTasks.length)return json(400,{error:'الهدف والقرار ومهمة واحدة على الأقل مطلوبة.'});
   const now=new Date().toISOString(),planId=uid('execution');
   const plan={id:planId,clientId,projectId,title,objective,decision,source:clean(b.source,300)||'owner',reviewGateId,reviewGateTitle:reviewGate.title,status:'active',createdAt:now,updatedAt:now,expectedMetric:clean(b.expectedMetric,300),baselineValue:clean(b.baselineValue,120),targetValue:clean(b.targetValue,120)};
   await stores.plans().setJSON(planId,plan);
   const created=[];
   for(const t of rawTasks){
    const taskId=uid('task');
    const x={id:taskId,projectId,title:clean(t.title,220),assignee:clean(t.assignee,100),dueDate:clean(t.dueDate,30),status:['todo','doing','review','done'].includes(t.status)?t.status:'todo',priority:['high','normal','low'].includes(t.priority)?t.priority:'normal',executionPlanId:planId,expectedOutput:clean(t.expectedOutput,500),measurement:clean(t.measurement,500),createdAt:now,updatedAt:now};
    if(!x.title)continue;await stores.tasks().setJSON(taskId,x);created.push(x);
   }
   await saveAIHistory({clientId,mode:'growth-execution-plan',topic:title,input:JSON.stringify({objective,decision,tasks:created.map(x=>x.title)}),output:JSON.stringify(plan),metadata:{planId,projectId}});
   await logActivity(clientId,'execution','تم إنشاء خطة تنفيذ بعد اعتماد مرحلة المراجعة',{planId,projectId,title,taskCount:created.length,reviewGateId});
   return json(201,{plan,tasks:created});
  }
  if(action==='record_result'){
   const planId=clean(b.planId,160);if(!planId)return json(400,{error:'خطة التنفيذ مطلوبة.'});
   const plan=await stores.plans().get(planId,{type:'json'});if(!plan||plan.clientId!==clientId)return json(404,{error:'الخطة غير موجودة.'});
   plan.result={metric:clean(b.metric,300),before:clean(b.before,120),after:clean(b.after,120),source:clean(b.source,500),note:clean(b.note,1500),recordedAt:new Date().toISOString()};plan.status='measured';plan.updatedAt=new Date().toISOString();await stores.plans().setJSON(plan.id,plan);
   await logActivity(clientId,'execution','تم تسجيل نتيجة خطة تنفيذ',{planId,metric:plan.result.metric,before:plan.result.before,after:plan.result.after});
   await saveAIHistory({clientId,mode:'growth-execution-result',topic:plan.title,input:JSON.stringify(plan.result),output:'تم حفظ النتيجة الفعلية وربطها بالخطة.',metadata:{planId}});
   return json(200,{plan});
  }
  if(action==='complete_task'){
   const id=clean(b.taskId,160),status=clean(b.status,20);if(!id||!['todo','doing','review','done'].includes(status))return json(400,{error:'بيانات المهمة غير صحيحة.'});
   const task=await stores.tasks().get(id,{type:'json'});if(!task)return json(404,{error:'المهمة غير موجودة.'});
   const project=await stores.projects().get(task.projectId,{type:'json'});if(project?.leadId!==clientId&&project?.clientId!==clientId)return json(403,{error:'المهمة لا تتبع لهذا العميل.'});
   const prev=task.status;task.status=status;task.updatedAt=new Date().toISOString();await stores.tasks().setJSON(task.id,task);await logActivity(clientId,'task','تحديث تنفيذ النمو',{taskId:id,title:task.title,from:prev,to:status,executionPlanId:task.executionPlanId||null});return json(200,{item:task});
  }
  return json(400,{error:'الإجراء غير معروف.'});
 }catch(err){return json(500,{error:err.message||'تعذر تنفيذ العملية.'})}
};
