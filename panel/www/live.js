// Live data: /api/panel poll + refresh, tile bindings, formatters, toast, account tap.
/* ---------- edit-list drag-to-reorder (handle only) ---------- */
(function(){
  var drag=null,ph=null,startY=0,baseTop=0;
  function pt(e){return e.touches?e.touches[0]:e;}
  function down(e){
    var h=e.target.closest('.ehandle');if(!h)return;
    var row=h.closest('.erow');
    // No more #device transform-scale to compensate for (see shell.js) — pointer
    // coordinates and the dragged row's own coordinate space are 1:1 now.
    drag=row;startY=pt(e).clientY;
    var r=row.getBoundingClientRect();baseTop=r.top;
    ph=document.createElement('div');ph.className='erow ghost';ph.style.height=row.offsetHeight+'px';ph.style.margin=getComputedStyle(row).marginTop+' 0 0';
    row.parentNode.insertBefore(ph,row.nextSibling);
    row.style.width=row.offsetWidth+'px';row.style.position='relative';row.classList.add('dragging');
    e.preventDefault();
  }
  function move(e){
    if(!drag)return;var off=pt(e).clientY-startY;drag.style.transform='translateY('+off+'px)';
    var mid=pt(e).clientY;
    var sibs=[].slice.call(editScroll.querySelectorAll('.erow:not(.dragging)'));
    for(var i=0;i<sibs.length;i++){var s=sibs[i],r=s.getBoundingClientRect();
      if(mid<r.top+r.height/2){editScroll.insertBefore(ph,s);return;}}
    var addRow=editScroll.querySelector('.addrow');editScroll.insertBefore(ph,addRow);
  }
  function up(){
    if(!drag)return;editScroll.insertBefore(drag,ph);ph.remove();
    drag.classList.remove('dragging');drag.style.transform='';drag.style.width='';drag.style.position='';
    order=[].slice.call(editScroll.querySelectorAll('.erow')).map(function(w){return w.dataset.id;});
    drag=null;ph=null;
  }
  editScroll.addEventListener('touchstart',down,{passive:false});
  editScroll.addEventListener('touchmove',move,{passive:false});
  editScroll.addEventListener('touchend',up);
  editScroll.addEventListener('mousedown',down);
  addEventListener('mousemove',move);addEventListener('mouseup',up);
})();

function bindTiles(){
  homeScroll.querySelectorAll('[data-tile="eth"]').forEach(function(t){t.addEventListener('click',showEthDetail);});
  homeScroll.querySelectorAll('[data-tile="wifi"]').forEach(function(t){t.addEventListener('click',showWifiDetail);});
  homeScroll.querySelectorAll('[data-tile="hotspot"]').forEach(function(t){t.addEventListener('click',showHotspot);});
  homeScroll.querySelectorAll('[data-tile="tb4"]').forEach(function(t){t.addEventListener('click',showTbDetail);});
  homeScroll.querySelectorAll('[data-tile="sharing"]').forEach(function(t){t.addEventListener('click',showSharing);});
  homeScroll.querySelectorAll('[data-tile="storage"]').forEach(function(t){t.addEventListener('click',showVolumes);});
  homeScroll.querySelectorAll('[data-tile="system"]').forEach(function(t){t.addEventListener('click',showSystem);});
  homeScroll.querySelectorAll('[data-tile="filemgr-all"]').forEach(function(t){t.addEventListener('click',showFilesLanding);});
  homeScroll.querySelectorAll('[data-tile="filemgr-personal"]').forEach(function(t){t.addEventListener('click',function(){showFiles('personal');});});
  homeScroll.querySelectorAll('[data-tile="filemgr-team"]').forEach(function(t){t.addEventListener('click',function(){showFiles('team');});});
  homeScroll.querySelectorAll('[data-tile="filemgr-trash"]').forEach(function(t){t.addEventListener('click',function(){showFiles('trash');});});
  homeScroll.querySelectorAll('[data-tile="filemgr-fav"]').forEach(function(t){t.addEventListener('click',function(){showFiles('fav');});});
  homeScroll.querySelectorAll('[data-tile="notif"]').forEach(function(t){t.addEventListener('click',showNotifications);});
  homeScroll.querySelectorAll('.tile').forEach(function(t){
    var lab=t.querySelector('.t');
    if(lab&&lab.textContent==='Settings')t.addEventListener('click',openSettings);
  });
  renderNotifCard();        // paint the notif card from cache after any re-render
  refreshNotifications();   // fetch (self-throttled)
}
function toast(msg){var t=document.getElementById('toast');t.textContent=msg;t.classList.add('show');clearTimeout(t._h);t._h=setTimeout(function(){t.classList.remove('show');},1900);}

/* ---------- live data from t6-paneld (/api/panel) ---------- */
function setText(sel,v){var e=document.querySelector(sel);if(e&&v!=null)e.textContent=v;}
function shortFan(n){return n.replace(/ fan$/,'').replace('SSD bay ','SSD ');}
var prevNet=null, layoutApplied=false, netHist=[];
function fmtB(b){b=+b||0;if(b>=1e12)return (b/1e12).toFixed(1)+' TB';if(b>=1e11)return (b/1e9).toFixed(0)+' GB';if(b>=1e9)return (b/1e9).toFixed(1)+' GB';if(b>=1e6)return (b/1e6).toFixed(0)+' MB';if(b>=1e3)return (b/1e3).toFixed(0)+' KB';return b+' B';}
function fmtRate(bps){var mb=bps*8/1e6;if(mb<1)return (bps*8/1e3).toFixed(0)+' Kb/s';return mb.toFixed(mb<10?1:0)+' Mb/s';}
function fmtSpeed(m){return m==null?'—':(m>=1000?(m/1000)+' Gb/s':m+' Mb/s');}
function fmtSig(s){return s==null?'—':s+'%';}
function applyLayout(dash){
  if(!dash||!dash.order||!dash.order.length)return;
  var all=Object.keys(META);
  var saved=dash.order.filter(function(id){return all.indexOf(id)>=0;});
  all.forEach(function(id){if(saved.indexOf(id)<0)saved.push(id);}); // append any new widgets
  var hidden=dash.hidden||[],vis={};
  all.forEach(function(id){vis[id]=hidden.indexOf(id)<0?1:0;});
  // Same layout as already on screen (e.g. server confirms the cached one at
  // the first poll): don't rebuild the widgets, that would blank them briefly.
  if(JSON.stringify(saved)===JSON.stringify(order)&&JSON.stringify(vis)===JSON.stringify(visible))return false;
  order=saved;visible=vis;
  renderHome();
  return true;
}

// Home cache (localStorage, persisted in the kiosk profile): the last known
// storage figures and dashboard layout, so a cold start / re-render paints the
// real numbers immediately instead of an empty card that fills in ~1-2 s later
// when the first api/panel poll lands. Live data still wins as soon as it
// arrives; volume usage barely moves, so the DOM is rewritten only on change.
var HOME_CACHE_KEY='t6.home.cache';
function homeCacheLoad(){try{return JSON.parse(localStorage.getItem(HOME_CACHE_KEY)||'null')||{};}catch(e){return {};}}
function homeCacheSave(patch){try{var c=homeCacheLoad();Object.keys(patch).forEach(function(k){c[k]=patch[k];});localStorage.setItem(HOME_CACHE_KEY,JSON.stringify(c));}catch(e){}}
var storagePainted='';
function paintStorage(st,force){
  st=Array.isArray(st)?st:[];var key=JSON.stringify(st);
  if(!force&&key===storagePainted)return false;
  storagePainted=key;
  var vc=document.getElementById('volCount'),vols=document.querySelector('.vols');
  var e=function(s){return String(s==null?'':s).replace(/[&<>"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];});}; // esc() (network.js) isn't loaded yet at the cold-start paint
  if(vc)vc.textContent=st.length+' volume'+(st.length!==1?'s':'');
  if(vols)vols.innerHTML=st.map(function(v,i){
    var pct=v.total_bytes?Math.round(v.used_bytes/v.total_bytes*100):0;
    return '<div style="margin-top:'+(i?24:0)+'px"><div class="row-sb"><span style="font-size:17px;font-weight:500">'+e(v.name)+'</span><span style="font-size:16px" class="muted">'+fmtB(v.used_bytes)+' / '+fmtB(v.total_bytes)+'</span></div><div class="bar"><i style="width:'+pct+'%"></i></div></div>';
  }).join('');
  return true;
}
// Called by renderHome() after it rebuilds the widgets: repaint the storage
// card from the freshest data we have (live snapshot, else the cache).
function paintHomeCached(){
  var st=(LAST&&LAST.storage)||homeCacheLoad().storage;
  if(st)paintStorage(st,true);
}
var storageSaved='';
function cacheStorage(st){var k=JSON.stringify(st);if(k===storageSaved)return;storageSaved=k;homeCacheSave({storage:st});}
// Cold start (called from the startup sequence in network.js, once every script
// is loaded): restore the saved layout before the first poll so the widgets
// don't reshuffle once the server's copy arrives. Returns true if it rendered.
function restoreHomeFromCache(){return applyLayout(homeCacheLoad().dashboard);}
var idleArmed=false;
/* ---------- home health banner ("All systems normal") ----------
   Composed from three sources, most severe wins:
   1. HW_STATUS — t6-paneld's local hardware check every 2 s (temps, fans,
      battery, volume fill, memory) → {level, text, issues, uptime_s}.
   2. FNOS_ALERTS — fnOS's own active alert reasons (resmon.alert.getBeepReasons:
      disk failure, degraded storage, UPS…), polled every 30 s when signed in.
   3. Unread WARNING notifications (level ≥ 1) from the notification poll.
   When everything is fine, the line also carries uptime. Tapping the banner
   opens Notifications when there's something to look at. */
var HW_STATUS=null, FNOS_ALERTS=[], FNOS_ALERTS_TS=0;
function fmtUptime(s){if(!s&&s!==0)return '';var d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);
  return d>0?('up '+d+'d '+h+'h'):h>0?('up '+h+'h '+m+'m'):('up '+m+'m');}
function unreadWarnings(){return (window.NOTIF&&NOTIF.items||[]).filter(function(n){return n.level>=1&&!n.read;}).length;}
function renderStatusBanner(){
  var kick=document.querySelector('#home .kick'),txt=document.getElementById('statusText');
  if(!kick||!txt)return;
  var level='ok',text='All systems normal';
  var hw=HW_STATUS;
  if(FNOS_ALERTS.length){level='err';text=FNOS_ALERTS[0]+(FNOS_ALERTS.length>1?' +'+(FNOS_ALERTS.length-1):'');}
  else if(hw&&hw.level==='err'){level='err';text=hw.text;}
  else if(hw&&hw.level==='warn'){level='warn';text=hw.text;}
  else{var w=unreadWarnings();if(w){level='warn';text=w+(w===1?' alert':' alerts')+' — tap to view';}}
  txt.textContent=text;
  kick.classList.toggle('warn',level==='warn');kick.classList.toggle('err',level==='err');
  kick.classList.toggle('tap',level!=='ok');
}
function refreshHealth(force){
  if(!fnosUser){if(FNOS_ALERTS.length){FNOS_ALERTS=[];renderStatusBanner();}return;}
  if(!force&&Date.now()-FNOS_ALERTS_TS<30000)return;
  FNOS_ALERTS_TS=Date.now();
  fetch('api/fnos/health',{cache:'no-store'}).then(function(r){return r.json();}).then(function(d){
    if(d&&Array.isArray(d.alerts)){FNOS_ALERTS=d.alerts;renderStatusBanner();}
  }).catch(function(){});
}
document.querySelector('#home .kick').addEventListener('click',function(){
  if(!this.classList.contains('tap'))return;
  if(FNOS_ALERTS.length||unreadWarnings()){if(window.showNotifications)showNotifications();}
  else if(HW_STATUS&&HW_STATUS.level!=='ok')toast(HW_STATUS.text);
});
function refresh(d){
  if(!d)return;
  LAST=d;
  if(!idleArmed){idleArmed=true;armIdle();} // start the idle timer once data exists
  if(!layoutApplied&&d.dashboard){layoutApplied=true;applyLayout(d.dashboard);homeCacheSave({dashboard:d.dashboard});} // restore saved widget layout
  setAccount(d.session);
  if(d.host&&d.host.name){setText('#home .hostname',d.host.name);setText('#edit .hostname',d.host.name);}
  HW_STATUS=d.status||null; renderStatusBanner();
  var sys=d.system||{};
  setText('.f-cpu',sys.cpu_c);setText('.f-gpu',sys.gpu_c);setText('.f-mem',sys.mem_pct);setText('.f-drives',sys.drives_c);
  var fl=document.querySelector('.fanlist');
  if(fl&&Array.isArray(sys.fans)&&sys.fans.length){
    fl.innerHTML=sys.fans.map(function(f){return '<div style="flex:1;background:oklch(1 0 0 / .05);border-radius:9px;padding:7px 9px"><div style="font-size:15px" class="muted2">'+shortFan(f.name)+'</div><div style="font-size:18px;font-weight:500">'+(f.rpm!=null?f.rpm:'—')+'</div></div>';}).join('');
  }
  var bf=document.querySelector('#home .bat-fill');
  if(bf&&d.battery&&d.battery.capacity!=null)bf.style.width=Math.max(6,Math.min(100,d.battery.capacity))+'%';
  // storage (real volumes) — repainted + cached only when the figures change
  if(Array.isArray(d.storage)){paintStorage(d.storage);cacheStorage(d.storage);}
  // connectivity tiles (real link state)
  var nw=d.network||{};
  var et=document.querySelector('[data-tile="eth"]');
  if(et){var e=nw.ethernet||{};et.className='tile '+(e.connected?'on':'off');
    var es=et.querySelector('.eth-sub');if(es)es.textContent=e.connected?(e.ip||'Connected'):'Disconnected';}
  var wt=document.querySelector('[data-tile="wifi"]');
  if(wt){var w=nw.wifi||{},wc=w.connected&&w.ssid;wt.className='tile '+(wc?'on':'off');
    var ws=wt.querySelector('.wifi-sub');if(ws)ws.textContent=wc?w.ssid:'Off';}
  var ht=document.querySelector('[data-tile="hotspot"]');
  if(ht){var h=nw.hotspot||{};ht.className='tile '+(h.active?'on':'off');
    var hs=ht.querySelector('.hotspot-sub');if(hs)hs.textContent=h.active?(h.ssid||'On'):'Off';}
  var tt=document.querySelector('[data-tile="tb4"]');
  if(window.tbLive)tbLive(d.thunderbolt);
  if(tt){var tb=d.thunderbolt||{},devs=tb.devices||[],pend=devs.filter(function(x){return x.pending;}).length;
    var on=devs.length>0||(tb.net||[]).some(function(x){return x.connected;});
    tt.className='tile '+(on?'on':'off');
    var ts=tt.querySelector('.tb-sub');
    if(ts)ts.textContent=pend?(pend+' to authorize'):(devs.length?(devs[0].name||(devs.length+' device'+(devs.length>1?'s':''))):'No link');}
  var sh=document.querySelector('[data-tile="sharing"]');
  if(sh){var sg=d.sharing||{},protos=[sg.smb?'SMB':null,sg.nfs?'NFS':null].filter(Boolean);
    sh.className='tile '+(protos.length?'on':'off');
    var sgs=sh.querySelector('.sharing-sub');if(sgs)sgs.textContent=protos.length?protos.join(' · '):'Off';}
  // network throughput (rate from counter deltas between polls) + rolling chart
  if(d.net){var now=Date.now();
    if(prevNet){var dt=(now-prevNet.t)/1000;
      if(dt>0){
        var rxR=Math.max(0,(d.net.rx_bytes-prevNet.rx)/dt),txR=Math.max(0,(d.net.tx_bytes-prevNet.tx)/dt);
        setText('.net-dn','↓ '+fmtRate(rxR));setText('.net-up','↑ '+fmtRate(txR));
        netHist.push(rxR+txR);if(netHist.length>26)netHist.shift();
        var nb=document.querySelector('.netbars');
        if(nb){var mx=Math.max.apply(null,netHist.concat([1]));
          nb.innerHTML=netHist.map(function(v){var h=Math.max(3,Math.round(v/mx*100));return '<div style="flex:1;background:oklch(0.74 0.12 62 / .5);border-radius:2.5px;height:'+h+'%"></div>';}).join('');}
      }}
    prevNet={rx:d.net.rx_bytes,tx:d.net.tx_bytes,t:now};}
}
function poll(){fetch('api/panel',{cache:'no-store'}).then(function(r){return r.json();}).then(refresh).catch(function(){});
  refreshNotifications(); // self-throttled to 30s; no-op when signed out
  refreshHealth();        // fnOS alert reasons, 30s self-throttled
  if(window.refreshFnos)window.refreshFnos();} // keep the account chip in sync with the real session (status flips to signed-out once a call hits errno 4224)
document.getElementById('acct').addEventListener('click',function(){
  var signedOut=document.getElementById('acct').classList.contains('signin');
  if(signedOut){showLogin();}
  else{showConfirm('Sign out?','You will be signed out of fnOS on this panel and need to sign in again for account features.','Sign out',false,function(){
    fetch('api/fnos/logout',{method:'POST'}).then(function(){fnosUser=null;setAccount();refreshNotifications();toast('Signed out');}).catch(function(){fnosUser=null;setAccount();refreshNotifications();});
  });}
});

