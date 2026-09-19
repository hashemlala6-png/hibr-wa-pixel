(function(){
const WA='https://wa.me/9647721971156';
function nav(){const n=document.querySelector('.navlinks'),b=document.querySelector('.menu');if(b&&n){b.onclick=()=>n.classList.toggle('open');n.querySelectorAll('a').forEach(a=>a.onclick=()=>n.classList.remove('open'))}}
async function auth(){try{const r=await fetch('/.netlify/functions/client-auth?action=me',{credentials:'same-origin',cache:'no-store'});return await r.json()}catch{return {authenticated:false}}}
async function clientLink(){const a=document.querySelector('[data-client-link]');if(!a)return;const d=await auth();a.href=d.authenticated?'account.html':'login.html?next=account';a.textContent=d.authenticated?'حسابي':'دخول العميل'}
function motion(){const els=document.querySelectorAll('.reveal');const io=new IntersectionObserver(es=>es.forEach(e=>{if(e.isIntersecting){e.target.classList.add('in');io.unobserve(e.target)}}),{threshold:.08});els.forEach(e=>io.observe(e))}
function getAnonId(){const key='hwp_anon';try{let id=localStorage.getItem(key);if(!id){id=(crypto.randomUUID?.()||Date.now()+'-'+Math.random());localStorage.setItem(key,id)}return id}catch{return 'session-'+Date.now()+'-'+Math.random().toString(36).slice(2)} }
function trackFunnel(action){const anonId=getAnonId();return fetch('/.netlify/functions/funnel',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({anonId,action,path:location.pathname,referrer:document.referrer,device:innerWidth<700?'mobile':innerWidth<1000?'tablet':'desktop'})}).catch(()=>{})}
function presence(){const beat=()=>{try{fetch('/.netlify/functions/presence?action=heartbeat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:'visitor',page:location.pathname})}).catch(()=>{})}catch{}};beat();setInterval(beat,60000)}
function funnel(){trackFunnel('page_view');presence();document.querySelectorAll('[data-funnel]').forEach(x=>x.addEventListener('click',()=>trackFunnel(x.dataset.funnel),{passive:true}))}
function wireWA(){document.querySelectorAll('[data-wa]').forEach(x=>x.addEventListener('click',()=>{trackFunnel('whatsapp_click');window.location.href=WA}))}
function init(){nav();clientLink();motion();funnel();wireWA();}
window.hwp={auth,WA,trackFunnel};init();
})();
