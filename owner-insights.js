const {getStore}=require('@netlify/blobs');
const {requireAdmin,json}=require('./auth-utils');
const stores={
 leads:()=>getStore({name:'hbpx-leads',consistency:'strong'}),
 projects:()=>getStore({name:'hbpx-projects',consistency:'strong'}),
 payments:()=>getStore({name:'hbpx-payments',consistency:'strong'})
};
async function all(store,prefix){const r=await store().list({prefix});const out=[];for(const x of r.blobs||[]){try{const v=await store().get(x.key,{type:'json'});if(v)out.push(v)}catch{}}return out}
const num=v=>Number(v||0)||0;
const pct=(a,b)=>b?Math.round(((a-b)/b)*100):a?100:0;
function range(days,offset=0){const end=Date.now()-offset*86400000;return {from:end-days*86400000,to:end};}
exports.handler=async e=>{
 if(e.httpMethod==='OPTIONS')return json(204,{}); const auth=requireAdmin(e);if(auth)return auth;
 if(e.httpMethod!=='GET')return json(405,{error:'Method not allowed'});
 try{
  const [leads,projects,payments]=await Promise.all([all(stores.leads,'lead-'),all(stores.projects,'project-'),all(stores.payments,'payment-')]);
  const cur=range(30,0),prev=range(30,30), inR=(x,r)=>{const t=new Date(x).getTime();return t>=r.from&&t<r.to};
  const cL=leads.filter(x=>inR(x.createdAt,cur)),pL=leads.filter(x=>inR(x.createdAt,prev));
  const cP=payments.filter(x=>inR(x.createdAt,cur)),pP=payments.filter(x=>inR(x.createdAt,prev));
  const cProj=projects.filter(x=>inR(x.createdAt,cur)),pProj=projects.filter(x=>inR(x.createdAt,prev));
  const revenue=a=>a.reduce((s,x)=>s+num(x.amount),0);
  const curRevenue=revenue(cP),prevRevenue=revenue(pP),curBooked=revenue(cProj),prevBooked=revenue(pProj);
  const won=x=>['won','active','completed'].includes(x.status), lost=x=>x.status==='lost';
  const cWon=cL.filter(won).length,pWon=pL.filter(won).length,cLost=cL.filter(lost).length,pLost=pL.filter(lost).length;
  const winRate=cL.length?Math.round(cWon/cL.length*100):0,prevWinRate=pL.length?Math.round(pWon/pL.length*100):0;
  const avgCur=cProj.length?Math.round(curBooked/cProj.length):0,avgPrev=pProj.length?Math.round(prevBooked/pProj.length):0;
  const reasons=[];
  if(cL.length<pL.length)reasons.push({type:'down',title:'عدد الفرص أقل',detail:`دخل ${cL.length} عميل محتمل مقابل ${pL.length} بالفترة السابقة.`});
  if(winRate<prevWinRate)reasons.push({type:'down',title:'نسبة التحويل انخفضت',detail:`${winRate}% حالياً مقابل ${prevWinRate}% سابقاً.`});
  if(avgCur<avgPrev)reasons.push({type:'down',title:'متوسط قيمة المشروع انخفض',detail:`${avgCur.toLocaleString('ar-IQ')} د.ع مقابل ${avgPrev.toLocaleString('ar-IQ')} د.ع.`});
  if(curBooked>curRevenue&&curBooked>0)reasons.push({type:'warn',title:'جزء من المبيعات لم يتحول إلى تحصيل',detail:`المشاريع الجديدة ${curBooked.toLocaleString('ar-IQ')} د.ع، والتحصيل النقدي ${curRevenue.toLocaleString('ar-IQ')} د.ع.`});
  if(cLost>pLost)reasons.push({type:'down',title:'العملاء غير المكتملين أكثر',detail:`${cLost} حالات lost مقابل ${pLost} سابقاً.`});
  if(curRevenue>prevRevenue) {
    if(cL.length>pL.length)reasons.push({type:'up',title:'فرص أكثر',detail:`عدد العملاء المحتملين ارتفع من ${pL.length} إلى ${cL.length}.`});
    if(winRate>prevWinRate)reasons.push({type:'up',title:'تحويل أفضل',detail:`نسبة التحويل ارتفعت من ${prevWinRate}% إلى ${winRate}%.`});
    if(avgCur>avgPrev)reasons.push({type:'up',title:'قيمة المشاريع أعلى',detail:`متوسط المشروع ارتفع إلى ${avgCur.toLocaleString('ar-IQ')} د.ع.`});
  }
  if(!reasons.length)reasons.push({type:'info',title:'لا يوجد سبب حاسم بعد',detail:'نحتاج بيانات أكثر أو تسجيل سبب خسارة العميل حتى يصبح التشخيص أدق.'});
  const sources={}; cL.forEach(x=>{const k=x.source||'غير محدد';sources[k]=(sources[k]||0)+1});
  const lossReasons={}; cL.filter(lost).forEach(x=>{const k=x.lossReason||'سبب غير مسجل';lossReasons[k]=(lossReasons[k]||0)+1});
  return json(200,{period:{days:30},sales:{current:curRevenue,previous:prevRevenue,changePct:pct(curRevenue,prevRevenue)},booked:{current:curBooked,previous:prevBooked,changePct:pct(curBooked,prevBooked)},leads:{current:cL.length,previous:pL.length,changePct:pct(cL.length,pL.length)},winRate:{current:winRate,previous:prevWinRate,changePoints:winRate-prevWinRate},lost:{current:cLost,previous:pLost},averageProject:{current:avgCur,previous:avgPrev,changePct:pct(avgCur,avgPrev)},reasons,sources:Object.entries(sources).sort((a,b)=>b[1]-a[1]).map(([name,count])=>({name,count})),lossReasons:Object.entries(lossReasons).sort((a,b)=>b[1]-a[1]).map(([name,count])=>({name,count}))});
 }catch(err){return json(500,{error:'تعذر بناء تحليل المبيعات.'})}
};
