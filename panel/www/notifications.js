// Notification center: home card + full-list sub-page, backed by the fnOS
// notify.* API (GET /api/fnos/notifications, POST .../read-all). Real system
// alerts (UPS, license, storage, etc.) with an unread badge. Requires sign-in.
var NOTIF={items:[],unread:0,total:0,ts:0,loading:false};

function notifRelTime(sec){
  if(!sec)return '';
  var diff=Date.now()/1000-sec;
  if(diff<60)return 'just now';
  if(diff<3600)return Math.floor(diff/60)+'m ago';
  if(diff<86400)return Math.floor(diff/3600)+'h ago';
  if(diff<7*86400)return Math.floor(diff/86400)+'d ago';
  return new Date(sec*1000).toLocaleDateString(undefined,{month:'short',day:'numeric'});
}
// level 0 = info, 1 = warning, >=2 = critical (fnOS uses 0/1 today; guard higher).
function notifDot(level){
  var c=level>=2?'oklch(0.63 0.21 25)':(level>=1?'var(--amber)':'oklch(0.7 0.05 252 / .5)');
  return '<span class="ndot" style="background:'+c+'"></span>';
}

function refreshNotifications(force){
  if(!fnosUser){NOTIF={items:[],unread:0,total:0,ts:0,loading:false};renderNotifCard();return;}
  if(NOTIF.loading)return;
  if(!force&&NOTIF.ts&&Date.now()-NOTIF.ts<30000)return; // throttle background polls to 30s
  NOTIF.loading=true;
  fetch('api/fnos/notifications?limit=30',{cache:'no-store'}).then(function(r){return r.json();}).then(function(d){
    NOTIF.loading=false;
    // The notification poll doubles as the authenticated liveness check: if the
    // fnOS session expired server-side, this call comes back as an auth error —
    // flip the account chip to signed-out immediately instead of waiting.
    if(d&&d.error&&/sign in|session expired|not signed/i.test(d.error)){fnosUser=null;setAccount();NOTIF={items:[],unread:0,total:0,ts:0,loading:false};renderNotifCard();return;}
    if(d&&!d.error){NOTIF.items=d.items||[];NOTIF.unread=d.unread||0;NOTIF.total=d.total||NOTIF.items.length;NOTIF.ts=Date.now();}
    renderNotifCard();renderNotifList();if(window.renderStatusBanner)renderStatusBanner();
  }).catch(function(){NOTIF.loading=false;});
}

function renderNotifCard(){
  var card=document.querySelector('[data-tile="notif"]');if(!card)return;
  var badge=card.querySelector('.notif-badge');
  if(badge){
    if(NOTIF.unread>0){badge.style.display='';badge.textContent=NOTIF.unread>99?'99+':NOTIF.unread;}
    else badge.style.display='none';
  }
  var prev=card.querySelector('.notif-preview');if(!prev)return;
  if(!fnosUser){prev.innerHTML='<div class="notif-empty muted2" style="font-size:15px">Sign in to see notifications</div>';return;}
  if(!NOTIF.items.length){prev.innerHTML='<div class="notif-empty muted2" style="font-size:15px">'+(NOTIF.ts?'No notifications':'Loading…')+'</div>';return;}
  prev.innerHTML=NOTIF.items.slice(0,2).map(function(n){
    return '<div class="npreview'+(n.read?'':' unread')+'">'+notifDot(n.level)+
      '<div class="ninfo"><div class="nrow1"><span class="ntitle">'+esc(n.title)+'</span><span class="ntime">'+notifRelTime(n.datetime)+'</span></div>'+
      '<div class="ncontent">'+esc(n.content)+'</div></div></div>';
  }).join('');
}

// Only touches the DOM when the Notifications sub-page is actually mounted
// (its #notifList exists), so it's safe to call from the background poll.
function renderNotifList(){
  var el=document.getElementById('notifList');if(!el)return;
  if(!NOTIF.items.length){el.innerHTML='<div class="wifi-empty">No notifications</div>';return;}
  var head=NOTIF.unread>0?'<div class="notif-actions"><div class="notif-markread">Mark all read ('+NOTIF.unread+')</div></div>':'';
  el.innerHTML=head+'<div class="notiflist">'+NOTIF.items.map(function(n){
    return '<div class="notifrow'+(n.read?'':' unread')+'">'+notifDot(n.level)+
      '<div class="ninfo"><div class="nrow1"><span class="ntitle">'+esc(n.title)+'</span><span class="ntime">'+notifRelTime(n.datetime)+'</span></div>'+
      '<div class="ncontent full">'+esc(n.content)+'</div></div></div>';
  }).join('')+'</div>';
  var mr=el.querySelector('.notif-markread');if(mr)mr.addEventListener('click',markAllNotifRead);
}

function markAllNotifRead(){
  fetch('api/fnos/notifications/read-all',{method:'POST'}).then(function(r){return r.json();}).then(function(d){
    if(d&&d.error){toast('Could not mark read');return;}
    NOTIF.items=NOTIF.items.map(function(n){return Object.assign({},n,{read:1});});NOTIF.unread=0;
    renderNotifCard();renderNotifList();toast('All marked read');
  }).catch(function(){toast('Could not mark read');});
}

function showNotifications(){
  if(!fnosUser){toast('Sign in to see notifications');showLogin();return;}
  openPage('Notifications','<div id="notifList"><div class="wifi-empty">Loading…</div></div>',function(){
    renderNotifList();        // paint from cache immediately
    refreshNotifications(true); // then refresh
  });
}
