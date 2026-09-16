// Live data: /api/panel poll + refresh, tile bindings, formatters, toast, account tap.
/* ---------- edit-list drag-to-reorder (handle only) ---------- */
(function(){
  var drag=null,ph=null,startY=0,scale=1,baseTop=0;
  function pt(e){return e.touches?e.touches[0]:e;}
  function down(e){
    var h=e.target.closest('.ehandle');if(!h)return;
    var row=h.closest('.erow');scale=fit();
    drag=row;startY=pt(e).clientY;
    var r=row.getBoundingClientRect();baseTop=r.top;
    ph=document.createElement('div');ph.className='erow ghost';ph.style.height=row.offsetHeight+'px';ph.style.margin=getComputedStyle(row).marginTop+' 0 0';
    row.parentNode.insertBefore(ph,row.nextSibling);
    row.style.width=row.offsetWidth+'px';row.style.position='relative';row.classList.add('dragging');
    e.preventDefault();
  }
  function move(e){
    if(!drag)return;var off=(pt(e).clientY-startY)/scale;drag.style.transform='translateY('+off+'px)';
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
  homeScroll.querySelectorAll('[data-tile="files"]').forEach(function(t){t.addEventListener('click',showFiles);});
  homeScroll.querySelectorAll('.tile').forEach(function(t){
    var lab=t.querySelector('.t');
    if(lab&&lab.textContent==='Settings')t.addEventListener('click',openSettings);
  });
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
  order=saved;
  var hidden=dash.hidden||[];
  all.forEach(function(id){visible[id]=hidden.indexOf(id)<0?1:0;});
  renderHome();
}
var idleArmed=false;
function refresh(d){
  if(!d)return;
  LAST=d;
  if(!idleArmed){idleArmed=true;armIdle();} // start the idle timer once data exists
  if(!layoutApplied&&d.dashboard){layoutApplied=true;applyLayout(d.dashboard);} // restore saved widget layout
  setAccount(d.session);
  if(d.host&&d.host.name)setText('#home .hostname',d.host.name);
  if(d.status&&d.status.text)setText('#statusText',d.status.text);
  var sys=d.system||{};
  setText('.f-cpu',sys.cpu_c);setText('.f-gpu',sys.gpu_c);setText('.f-mem',sys.mem_pct);setText('.f-drives',sys.drives_c);
  var fl=document.querySelector('.fanlist');
  if(fl&&Array.isArray(sys.fans)&&sys.fans.length){
    fl.innerHTML=sys.fans.map(function(f){return '<div style="flex:1;background:oklch(1 0 0 / .05);border-radius:18px;padding:14px 18px"><div style="font-size:30px" class="muted2">'+shortFan(f.name)+'</div><div style="font-size:36px;font-weight:500">'+(f.rpm!=null?f.rpm:'—')+'</div></div>';}).join('');
  }
  var bf=document.querySelector('#home .bat-fill');
  if(bf&&d.battery&&d.battery.capacity!=null)bf.style.width=Math.max(6,Math.min(100,d.battery.capacity))+'%';
  // storage (real volumes)
  var st=d.storage||[],vc=document.getElementById('volCount'),vols=document.querySelector('.vols');
  if(vc)vc.textContent=st.length+' volume'+(st.length!==1?'s':'');
  if(vols)vols.innerHTML=st.map(function(v,i){
    var pct=v.total_bytes?Math.round(v.used_bytes/v.total_bytes*100):0;
    return '<div style="margin-top:'+(i?24:0)+'px"><div class="row-sb"><span style="font-size:34px;font-weight:500">'+v.name+'</span><span style="font-size:32px" class="muted">'+fmtB(v.used_bytes)+' / '+fmtB(v.total_bytes)+'</span></div><div class="bar"><i style="width:'+pct+'%"></i></div></div>';
  }).join('');
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
          nb.innerHTML=netHist.map(function(v){var h=Math.max(3,Math.round(v/mx*100));return '<div style="flex:1;background:oklch(0.74 0.12 62 / .5);border-radius:5px;height:'+h+'%"></div>';}).join('');}
      }}
    prevNet={rx:d.net.rx_bytes,tx:d.net.tx_bytes,t:now};}
}
function poll(){fetch('api/panel',{cache:'no-store'}).then(function(r){return r.json();}).then(refresh).catch(function(){});}
document.getElementById('acct').addEventListener('click',function(){
  var signedOut=document.getElementById('acct').classList.contains('signin');
  if(signedOut){showLogin();}
  else{showConfirm('Sign out?','You will be signed out of fnOS on this panel and need to sign in again for account features.','Sign out',false,function(){
    fetch('api/fnos/logout',{method:'POST'}).then(function(){fnosUser=null;setAccount();toast('Signed out');}).catch(function(){fnosUser=null;setAccount();});
  });}
});

