const { env } = require('./env');

const crypto=require('crypto');
const {getStore}=require('@netlify/blobs');
const {requireAdmin,json}=require('./auth-utils');
const {logActivity}=require('./client-activity');
const stores={
 baselines:()=>getStore({name:'hbpx-growth-baselines',consistency:'strong'}),
 snapshots:()=>getStore({name:'hbpx-growth-snapshots',consistency:'strong'}),
 reports:()=>getStore({name:'hbpx-growth-reports',consistency:'strong'}),
 leads:()=>getStore({name:'hbpx-leads',consistency:'strong'}),
 projects:()=>getStore({name:'hbpx-projects',consistency:'strong'}),
 payments:()=>getStore({name:'hbpx-payments',consistency:'strong'}),
 expenses:()=>getStore({name:'hbpx-expenses',consistency:'strong'}),
 quotes:()=>getStore({name:'hbpx-quotes',consistency:'strong'}),
 subscriptions:()=>getStore({name:'hbpx-subscriptions',consistency:'strong'})
};
const clean=(v,n=3000)=>String(v??'').trim().slice(0,n);
const num=v=>{const n=Number(String(v??'').replace(/[^0-9.-]/g,''));return Number.isFinite(n)?n:0};
async function all(name,prefix){const st=stores[name](),r=await st.list({prefix}),o=[];for(const b of r.blobs||[]){try{const x=await st.get(b.key,{type:'json'});if(x)o.push(x)}catch{}}return o.sort((a,b)=>new Date(b.updatedAt||b.createdAt)-new Date(a.updatedAt||a.createdAt))}
async function byClient(name,prefix,clientId,field='clientId'){return (await all(name,prefix)).filter(x=>x[field]===clientId)}
async function allActivity(){const st=getStore({name:'hbpx-client-activity',consistency:'strong'});const r=await st.list({prefix:'activity-'});const o=[];for(const b of r.blobs||[]){try{const x=await st.get(b.key,{type:'json'});if(x)o.push(x)}catch{}}return o.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt))}

exports.handler=async e=>{
 if(e.httpMethod==='OPTIONS')return json(204,{});
 const a=requireAdmin(e);if(a)return a;
 try{
  if(e.httpMethod==='GET'){
   const clientId=clean(e.queryStringParameters?.clientId,120);
   const [baselines,snapshots,reports]=await Promise.all([all('baselines','baseline-'),all('snapshots','snapshot-'),all('reports','report-')]);
   return json(200,{baselines:clientId?baselines.filter(x=>x.clientId===clientId):baselines,snapshots:clientId?snapshots.filter(x=>x.clientId===clientId):snapshots,reports:clientId?reports.filter(x=>x.clientId===clientId):reports});
  }
  if(e.httpMethod!=='POST')return json(405,{error:'Method not allowed'});
  let b={};try{b=JSON.parse(e.body||'{}')}catch{return json(400,{error:'بيانات غير صالحة.'})}
  const action=clean(b.action,40);
  const clientId=clean(b.clientId,120); if(!clientId)return json(400,{error:'العميل مطلوب.'});
  const now=new Date().toISOString();
  if(action==='save_baseline'){
    const x={id:'baseline-'+Date.now()+'-'+crypto.randomBytes(4).toString('hex'),clientId,createdAt:now,updatedAt:now,metrics:{
      followers:num(b.followers),engagement:num(b.engagement),reach:num(b.reach),visits:num(b.visits),inquiries:num(b.inquiries),sales:num(b.sales)
    },notes:clean(b.notes,3000)};
    await stores.baselines().setJSON(x.id,x);await logActivity(clientId,'growth','تم تسجيل خط الأساس للنتائج',{baselineId:x.id,metrics:x.metrics});return json(201,{item:x});
  }
  if(action==='save_snapshot'){
    const x={id:'snapshot-'+Date.now()+'-'+crypto.randomBytes(4).toString('hex'),clientId,createdAt:now,updatedAt:now,date:clean(b.date,30)||now.slice(0,10),metrics:{
      followers:num(b.followers),engagement:num(b.engagement),reach:num(b.reach),visits:num(b.visits),inquiries:num(b.inquiries),sales:num(b.sales)
    },notes:clean(b.notes,3000)};
    await stores.snapshots().setJSON(x.id,x);await logActivity(clientId,'growth','تم تسجيل قياس نتائج جديد',{snapshotId:x.id,metrics:x.metrics});return json(201,{item:x});
  }
  if(action==='save_report'){
    const x={id:'report-'+Date.now()+'-'+crypto.randomBytes(4).toString('hex'),clientId,createdAt:now,updatedAt:now,period:clean(b.period,40),title:clean(b.title,180)||'تقرير نتائج',baseline:b.baseline||{},current:b.current||{},changes:Array.isArray(b.changes)?b.changes.slice(0,20):[],wins:Array.isArray(b.wins)?b.wins.slice(0,20):[],nextActions:Array.isArray(b.nextActions)?b.nextActions.slice(0,20):[],notes:clean(b.notes,4000)};
    await stores.reports().setJSON(x.id,x);await logActivity(clientId,'growth','تم حفظ تقرير نتائج',{reportId:x.id,period:x.period});return json(201,{item:x});
  }
  if(action==='overview'){
    const [leads,projects,payments,expenses,quotes,subs]=await Promise.all([all('leads','lead-'),all('projects','project-'),all('payments','payment-'),all('expenses','expense-'),all('quotes','quote-'),all('subscriptions','subscription-')]);
    const activeLeads=leads.filter(x=>['new','contacted','proposal'].includes(x.status));
    const followups=leads.filter(x=>['new','contacted','proposal'].includes(x.status)).slice(0,8);
    const now=new Date(), month=now.toISOString().slice(0,7);
    const revenue=payments.filter(x=>String(x.createdAt||'').slice(0,7)===month).reduce((s,x)=>s+num(x.amount),0);
    const cost=expenses.filter(x=>String(x.createdAt||'').slice(0,7)===month).reduce((s,x)=>s+num(x.amount),0);
    const due=subs.filter(x=>x.status==='active').filter(x=>{const d=(new Date(x.nextRenewal+'T00:00:00')-new Date(now.toISOString().slice(0,10)+'T00:00:00'))/86400000;return d<=7});
    const pipeline=quotes.filter(x=>['sent','draft'].includes(x.status)).reduce((s,x)=>s+num(x.amount),0);
    return json(200,{kpis:{revenue,cost,profit:revenue-cost,pipeline,activeLeads:activeLeads.length,activeProjects:projects.filter(x=>['active','review'].includes(x.status)).length,renewals:due.length},followups:followups.map(x=>({id:x.id,clientId:x.clientId,name:x.name,status:x.status,updatedAt:x.updatedAt||x.createdAt})),renewals:due.map(x=>({id:x.id,clientName:x.clientName,nextRenewal:x.nextRenewal,amount:x.amount})),generatedAt:now.toISOString()});
  }

  if(action==='intelligence'){
    const [baselines,snapshots,reports,leads,projects,payments,expenses,quotes,subs,activities]=await Promise.all([
      all('baselines','baseline-'),all('snapshots','snapshot-'),all('reports','report-'),
      all('leads','lead-'),all('projects','project-'),all('payments','payment-'),all('expenses','expense-'),
      all('quotes','quote-'),all('subscriptions','subscription-'), allActivity()
    ]);
    const b=baselines.filter(x=>x.clientId===clientId)[0]||null;
    const ss=snapshots.filter(x=>x.clientId===clientId);
    const c=ss[0]||null;
    const prev=ss[1]||null;
    const rpts=reports.filter(x=>x.clientId===clientId).slice(0,5);
    const clientLeads=leads.filter(x=>x.clientId===clientId||x.id===clientId);
    const clientProjects=projects.filter(x=>x.clientId===clientId);
    const clientPayments=payments.filter(x=>x.clientId===clientId);
    const clientExpenses=expenses.filter(x=>x.clientId===clientId);
    const clientQuotes=quotes.filter(x=>x.clientId===clientId);
    const clientSubs=subs.filter(x=>x.clientId===clientId);
    const clientActs=activities.filter(x=>x.clientId===clientId).slice(0,30);
    const metrics=['followers','engagement','reach','visits','inquiries','sales'];
    const changes=metrics.map(k=>{
      const before=num(b?.metrics?.[k]), after=num(c?.metrics?.[k]);
      return {metric:k,before,after,delta:after-before,pct:before?Math.round((after-before)/before*1000)/10:null,measured:!!(b&&c)};
    });
    const prevChanges=prev&&c?metrics.map(k=>({metric:k,before:num(prev.metrics?.[k]),after:num(c.metrics?.[k]),delta:num(c.metrics?.[k])-num(prev.metrics?.[k]),pct:num(prev.metrics?.[k])?Math.round((num(c.metrics?.[k])-num(prev.metrics?.[k]))/num(prev.metrics?.[k])*1000)/10:null})):[],
      now=new Date(), month=now.toISOString().slice(0,7);
    const revenue=clientPayments.filter(x=>String(x.createdAt||'').slice(0,7)===month).reduce((s,x)=>s+num(x.amount),0);
    const costs=clientExpenses.filter(x=>String(x.createdAt||'').slice(0,7)===month).reduce((s,x)=>s+num(x.amount),0);
    const openQuotes=clientQuotes.filter(x=>['draft','sent'].includes(x.status)).reduce((s,x)=>s+num(x.amount),0);
    const overdueSubs=clientSubs.filter(x=>x.status==='active'&&x.nextRenewal&&new Date(x.nextRenewal+'T23:59:59')<now);
    const wins=changes.filter(x=>x.measured&&x.delta>0).sort((a,b)=>b.delta-a.delta).slice(0,3);
    const risks=changes.filter(x=>x.measured&&x.delta<0).sort((a,b)=>a.delta-b.delta).slice(0,3);
    const actions=[];
    if(!b) actions.push({priority:'high',title:'ثبّت خط الأساس',reason:'لا يمكن إثبات التغير بدون قياس قبل التنفيذ.',type:'measurement'});
    if(b&&!c) actions.push({priority:'high',title:'سجّل قياساً حديثاً',reason:'هناك خط أساس محفوظ لكن لا يوجد قياس لاحق.',type:'measurement'});
    if(risks.length) actions.push({priority:'high',title:'راجع المؤشرات المتراجعة',reason:risks.map(x=>`${x.metric}: ${x.pct===null?'غير مقاس':x.pct+'%'}`).join('، '),type:'performance'});
    if(openQuotes>0) actions.push({priority:'high',title:'تابع عروض الأسعار المفتوحة',reason:`قيمة Pipeline للعميل ${openQuotes.toLocaleString('ar-IQ')} د.ع`,type:'sales'});
    if(overdueSubs.length) actions.push({priority:'high',title:'تابع الاشتراك المتأخر',reason:`${overdueSubs.length} اشتراك يحتاج متابعة.`,type:'retention'});
    if(!actions.length) actions.push({priority:'normal',title:'حضّر التجربة القادمة',reason:'لا توجد مشكلة حرجة في البيانات الحالية؛ استخرج أفضل ما نجح وابنِ عليه.',type:'growth'});
    let ai=null;
    if(env('ANTHROPIC_API_KEY')){
      const prompt=`أنت مدير نمو واستراتيجية إبداعية لوكالة. حلل بيانات عميل حقيقية فقط ولا تخترع أرقاماً.
العميل: ${JSON.stringify(clientId)}
التغيرات قبل/بعد: ${JSON.stringify(changes)}
التغير بين آخر قياسين: ${JSON.stringify(prevChanges)}
التقارير السابقة: ${JSON.stringify(rpts.slice(0,3))}
النشاطات الأخيرة: ${JSON.stringify(clientActs)}
المشاريع: ${JSON.stringify(clientProjects.slice(0,8))}
الإيرادات الشهرية: ${revenue}, المصروفات: ${costs}, العروض المفتوحة: ${openQuotes}
أعد JSON فقط:
{"executive_summary":"...","why":"...","top_wins":["..."],"risks":["..."],"next_30_days":["..."],"content_opportunities":["..."],"client_meeting_points":["..."],"wow_move":"..."}
قواعد: لا تدّعي سببية من correlation؛ إذا البيانات ناقصة قل ذلك؛ اجعل التوصيات قابلة للتنفيذ ومحددة.`;
      try{
        const rr=await fetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':env('ANTHROPIC_API_KEY'),'anthropic-version':'2023-06-01'},body:JSON.stringify({model:'claude-sonnet-4-6',max_tokens:1400,messages:[{role:'user',content:prompt}]})});
        if(rr.ok){const d=await rr.json();const t=(d.content||[]).map(x=>x.text||'').join('\n').replace(/```json|```/g,'').trim();try{ai=JSON.parse(t)}catch{}}
      }catch{}
    }
    return json(200,{generatedAt:now.toISOString(),clientId,baseline:b,current:c,previous:c?prev:null,changes,prevChanges,wins,risks,actions,financial:{revenue,costs,profit:revenue-costs,openQuotes,overdueSubscriptions:overdueSubs.length},ai,coverage:{baselines:!!b,snapshots:ss.length,reports:rpts.length,activities:clientActs.length}});
  }
  if(action==='report_data'){
    const baselines=await byClient('baselines','baseline-',clientId), snaps=await byClient('snapshots','snapshot-',clientId);
    const baseline=baselines[0]||null,current=snaps[0]||null;
    const changes=[]; if(baseline&&current){for(const k of ['followers','engagement','reach','visits','inquiries','sales']){const a=num(baseline.metrics?.[k]),c=num(current.metrics?.[k]);if(a||c){const delta=c-a,pct=a?Math.round(delta/a*1000)/10:null;changes.push({metric:k,before:a,after:c,delta,pct})}}}
    return json(200,{baseline,current,changes});
  }
  return json(400,{error:'الإجراء غير معروف.'});
 }catch(err){return json(500,{error:err.message||'حدث خطأ في محرك النتائج.'})}
};
