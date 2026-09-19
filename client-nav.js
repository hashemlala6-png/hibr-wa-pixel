(function(){
  const meUrl='/.netlify/functions/client-auth?action=me';
  async function me(){try{const r=await fetch(meUrl,{credentials:'same-origin',cache:'no-store'});return await r.json()}catch{return {authenticated:false}}}
  function addStyles(){if(document.getElementById('client-nav-style'))return;const s=document.createElement('style');s.id='client-nav-style';s.textContent=`
    .client-account-link{display:inline-flex;align-items:center;gap:7px;border:1px solid rgba(105,183,226,.30);background:#fff;color:#4d6374;padding:9px 15px;border-radius:999px;font-weight:700;font-size:.88rem;transition:.2s;white-space:nowrap}.client-account-link:hover{background:#eef8fd;border-color:#7cc8f4;transform:translateY(-1px)}
    .auth-required-note{background:#f4fbff;border:1px solid rgba(105,183,226,.24);color:#506575;border-radius:16px;padding:14px 16px;margin:0 0 18px;font-size:.9rem}
  `;document.head.appendChild(s)}
  function navLink(auth){
    const nav=document.querySelector('.nav-inner') || document.querySelector('.nav-actions'); if(!nav)return;
    let a=nav.querySelector('.client-account-link'); if(!a){a=document.createElement('a');a.className='client-account-link';const cta=nav.querySelector('.nav-cta') || nav.querySelector('.solid-btn'); if(cta) nav.insertBefore(a,cta); else nav.appendChild(a)}
    if(auth){a.href='account.html';a.textContent='حسابي';}else{a.href='login.html?next=order';a.textContent='دخول العميل';}
  }
  async function init(){addStyles();const data=await me();navLink(!!data.authenticated);window.hibrClient=data;if(window.onClientAuth)window.onClientAuth(data)}
  window.hibrRequireClient=async function(next){const data=await me();if(!data.authenticated){location.href='login.html?next='+encodeURIComponent(next||location.pathname);return false}return data};
  init();
})();
