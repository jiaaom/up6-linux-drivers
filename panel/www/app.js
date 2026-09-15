/* appliance: no context menu, no long-press callout, no image/text drag */
addEventListener('contextmenu',function(e){e.preventDefault();},{passive:false});
addEventListener('dragstart',function(e){e.preventDefault();},{passive:false});
var device=document.getElementById('device');
function fit(){var vw=innerWidth,vh=innerHeight,s=Math.min(vw/1080,vh/2160);
  device.style.transform='translateX(-50%) scale('+s+')';device.style.top=Math.max(0,(vh-2160*s)/2)+'px';return s;}
addEventListener('resize',fit);addEventListener('orientationchange',fit);fit();

function tick(){var d=new Date(),t=String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');
  document.querySelectorAll('#clock,.clock2,.clock3').forEach(function(e){e.textContent=t;});}
tick();setInterval(tick,10000);
var LAST=null; // most recent /api/panel payload
// In the Electron shell, identity comes from the main process (which holds the
// fnOS session), not from t6-paneld. In a plain browser FNOS is null and we
// fall back to the /api/panel session field.
var FNOS=(typeof window!=='undefined'&&window.fnos)?window.fnos:null, fnosUser=null;
function setAccount(session){
  var s=FNOS?fnosUser:(session||null);
  var acct=document.getElementById('acct'),at=document.getElementById('acctText'),dot=acct&&acct.querySelector('.acctdot');
  if(!acct)return;
  if(s&&s.username){acct.classList.remove('signin');at.textContent='Signed in as '+s.username;if(dot)dot.hidden=false;}
  else{acct.classList.add('signin');at.textContent='Sign in';if(dot)dot.hidden=true;}
}
function refreshFnos(){ if(FNOS&&FNOS.session){FNOS.session().then(function(u){fnosUser=u;setAccount();}).catch(function(){}); } }
window.refreshFnos=refreshFnos;

/* ---------- model ---------- */
var META={
  storage:{title:'Storage',desc:'Collapse after 2 volumes'},
  system:{title:'System',desc:'CPU · GPU · memory · 3 fans'},
  conn:{title:'Connectivity',desc:'6 tiles · choose which'},
  task:{title:'Task center',desc:'Always visible'},
  net:{title:'Network traffic',desc:'Live throughput graph'},
  events:{title:'Recent events',desc:'Log of notable activity'},
};
var order=['storage','system','conn','task','net','events'];
var visible={storage:1,system:1,conn:1,task:1,net:1,events:0};

var CONTENT={
  storage:`<div class="card">
      <div class="row-sb"><div style="font-size:32px" class="muted">Storage</div><div style="font-size:30px" class="muted2" id="volCount">—</div></div>
      <div class="vols" style="margin-top:26px"></div></div>`,
  system:`<div class="card">
      <div style="display:flex;justify-content:space-between">
        <div><div style="font-size:32px" class="muted">CPU</div><div class="tname"><span class="f-cpu">44</span>°</div></div>
        <div><div style="font-size:32px" class="muted">GPU</div><div class="tname"><span class="f-gpu">41</span>°</div></div>
        <div><div style="font-size:32px" class="muted">Memory</div><div class="tname"><span class="f-mem">61</span>%</div></div>
        <div><div style="font-size:32px" class="muted">Drives</div><div class="tname"><span class="f-drives">38</span>°</div></div></div>
      <div style="display:flex;align-items:center;gap:26px;margin-top:26px;padding-top:24px;border-top:1px solid oklch(1 0 0 / .09)">
        <div style="font-size:32px;flex:none" class="muted">Fans</div>
        <div class="fanlist" style="display:flex;gap:16px;flex:1">
          <div style="flex:1;background:oklch(1 0 0 / .05);border-radius:18px;padding:14px 18px"><div style="font-size:30px" class="muted2">CPU</div><div style="font-size:36px;font-weight:500">1180</div></div>
          <div style="flex:1;background:oklch(1 0 0 / .05);border-radius:18px;padding:14px 18px"><div style="font-size:30px" class="muted2">SSD 1-2</div><div style="font-size:36px;font-weight:500">1240</div></div>
          <div style="flex:1;background:oklch(1 0 0 / .05);border-radius:18px;padding:14px 18px"><div style="font-size:30px" class="muted2">SSD 3-6</div><div style="font-size:36px;font-weight:500">980</div></div>
        </div></div></div>`,
  conn:`<div class="grid">
      <div class="tile on" data-tile="eth"><div style="width:44px;height:30px;border:4px solid var(--amber);border-radius:8px"></div><div><div class="t">Ethernet</div><div class="s muted eth-sub">—</div></div></div>
      <div class="tile on" data-tile="wifi"><div style="display:flex;align-items:flex-end;gap:6px;height:34px"><div style="width:8px;height:12px;border-radius:4px;background:var(--amber)"></div><div style="width:8px;height:20px;border-radius:4px;background:var(--amber)"></div><div style="width:8px;height:27px;border-radius:4px;background:var(--amber)"></div><div style="width:8px;height:34px;border-radius:4px;background:var(--amber);opacity:.35"></div></div><div><div class="t">Wi-Fi</div><div class="s muted wifi-sub">—</div></div></div>
      <div class="tile off"><div style="width:34px;height:34px;border-radius:17px;border:4px solid oklch(1 0 0 / .28)"></div><div><div class="t">Hotspot</div><div class="s muted2">Off</div></div></div>
      <div class="tile off"><div style="width:34px;height:34px;border-radius:9px;transform:rotate(45deg);border:4px solid oklch(1 0 0 / .28)"></div><div><div class="t">TB4</div><div class="s muted2">No link</div></div></div>
      <div class="tile on"><div style="display:flex;gap:6px"><div style="width:16px;height:34px;border-radius:5px;background:var(--amber)"></div><div style="width:16px;height:34px;border-radius:5px;background:var(--amber);opacity:.55"></div></div><div><div class="t">Sharing</div><div class="s muted">SMB · NFS</div></div></div>
      <div class="tile off"><div style="width:34px;height:34px;border-radius:17px;border:4px solid oklch(1 0 0 / .28)"></div><div><div class="t">Settings</div><div class="s muted2">Screen · SSH</div></div></div></div>`,
  task:`<div class="taskrow">
      <div style="width:50px;height:50px;border-radius:25px;border:5px solid oklch(0.74 0.12 62 / .28);border-top-color:var(--amber2);animation:spin 1.4s linear infinite"></div>
      <div style="flex:1"><div style="font-size:33px;font-weight:500">Task center</div><div style="font-size:31px" class="muted">2 running</div></div>
      <div style="min-width:52px;height:52px;padding:0 16px;border-radius:26px;background:var(--amber2);color:oklch(0.2 0.04 62);display:flex;align-items:center;justify-content:center;font-size:30px;font-weight:600">2</div></div>`,
  net:`<div class="card"><div class="row-sb"><div style="font-size:32px" class="muted">Network traffic</div><div style="font-size:30px" class="muted2">last 60 s</div></div>
      <div class="netbars" style="display:flex;align-items:flex-end;gap:7px;height:150px;margin-top:24px"></div>
      <div class="row-sb" style="margin-top:20px"><span style="font-size:31px" class="muted net-dn">↓ —</span><span style="font-size:31px" class="muted net-up">↑ —</span></div></div>`,
  events:`<div class="card"><div style="font-size:32px" class="muted">Recent events</div>
      <div style="margin-top:22px;font-size:31px;display:flex;gap:18px"><span class="muted2">21:40</span><span>Backup to USB_4TB completed</span></div>
      <div style="margin-top:16px;font-size:31px;display:flex;gap:18px"><span class="muted2">18:02</span><span>Volume 4 above 90% full</span></div>
      <div style="margin-top:16px;font-size:31px;display:flex;gap:18px"><span class="muted2">09:15</span><span>SMB share “media” accessed</span></div></div>`,
};

var homeScroll=document.getElementById('homeScroll');
function renderHome(){
  homeScroll.innerHTML='';
  order.forEach(function(id){
    if(!visible[id])return;
    var el=document.createElement('div');el.className='widget';el.dataset.id=id;el.innerHTML=CONTENT[id];
    homeScroll.appendChild(el);
  });
  var fw=document.createElement('div');fw.className='widget';
  fw.innerHTML=`<div class="fwbanner"><div style="width:14px;height:14px;border-radius:7px;background:var(--amber)"></div>
      <div style="flex:1"><div style="font-size:33px;font-weight:500">Firmware 0.9.19 available</div><div style="font-size:31px" class="muted">Tap to review</div></div>
      <div style="font-size:36px;opacity:.45">›</div></div>`;
  homeScroll.appendChild(fw);
  bindTiles();
}

var editScroll=document.getElementById('editScroll');
function renderEdit(){
  editScroll.innerHTML='';
  order.forEach(function(id){
    var m=META[id];var row=document.createElement('div');
    row.className='erow'+(visible[id]?'':' hidden');row.dataset.id=id;
    row.innerHTML='<div class="ehandle"><i></i><i></i><i></i></div>'+
      '<div class="einfo"><div class="etitle">'+m.title+'</div><div class="edesc">'+(visible[id]?m.desc:'Hidden')+'</div></div>'+
      '<div class="etoggle'+(visible[id]?' on':'')+'"><div class="knob"></div></div>';
    editScroll.appendChild(row);
  });
  var add=document.createElement('div');add.className='addrow';add.textContent='+ Add a widget';
  editScroll.appendChild(add);
  bindToggles();
}
function bindToggles(){
  editScroll.querySelectorAll('.erow').forEach(function(row){
    row.querySelector('.etoggle').addEventListener('click',function(){
      var id=row.dataset.id;visible[id]=visible[id]?0:1;
      row.classList.toggle('hidden',!visible[id]);
      row.querySelector('.etoggle').classList.toggle('on',!!visible[id]);
      row.querySelector('.edesc').textContent=visible[id]?META[id].desc:'Hidden';
    });
  });
}

/* nav */
document.getElementById('editbtn').addEventListener('click',function(){renderEdit();document.body.classList.add('editing');});
document.getElementById('donebtn').addEventListener('click',function(){
  document.body.classList.remove('editing');
  var hidden=order.filter(function(id){return !visible[id];});
  fetch('api/settings/dashboard',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({order:order,hidden:hidden})}).catch(function(){});
  if(LAST)LAST.dashboard={order:order.slice(),hidden:hidden.slice()};
  renderHome();
});

/* ---------- settings screen + brightness slider ---------- */
var settingsScroll=document.getElementById('settingsScroll');
function openSettings(){
  document.body.classList.add('settings-open');
  // Open at the true current value, not a possibly-stale poll snapshot.
  fetch('api/panel',{cache:'no-store'}).then(function(r){return r.json();})
    .then(function(d){LAST=d;buildSettings();}).catch(buildSettings);
}
function closeSettings(){document.body.classList.remove('settings-open');}
document.getElementById('settingsDone').addEventListener('click',closeSettings);
var TIMEOUTS=[[0,'Never'],[60,'1 min'],[300,'5 min'],[900,'15 min']];
var LANGS=[['en','English'],['ja','日本語'],['zh','简体中文']];
function buildSettings(){
  var bri=(LAST&&LAST.display&&LAST.display.brightness!=null)?LAST.display.brightness:50;
  var to=(LAST&&LAST.screen&&LAST.screen.timeout_s!=null)?LAST.screen.timeout_s:0;
  var lang=(LAST&&LAST.language)||'en';
  var ledsOn=!(LAST&&LAST.leds&&LAST.leds.night); // indicator lights active when night mode is off
  var host=(LAST&&LAST.host&&LAST.host.name)||'—';
  var seg=TIMEOUTS.map(function(t){return '<div class="segopt'+(t[0]===to?' on':'')+'" data-s="'+t[0]+'">'+t[1]+'</div>';}).join('');
  var langSeg=LANGS.map(function(l){return '<div class="segopt'+(l[0]===lang?' on':'')+'" data-lang="'+l[0]+'">'+l[1]+'</div>';}).join('');
  settingsScroll.innerHTML=
    '<div class="setgroup"><div class="setlabel">Screen</div><div class="card">'+
      '<div class="setrow"><div class="lbl">Brightness</div><div class="setval" id="briVal">'+bri+'%</div></div>'+
      '<div class="slider" id="briSlider"><div class="fill"></div><span class="ico">☀</span><span class="ico r">☀</span></div>'+
      '<div class="hairrow"></div>'+
      '<div class="setrow"><div class="lbl">Screen Timeout</div></div>'+
      '<div class="seg" id="timeoutSeg">'+seg+'</div>'+
    '</div></div>'+
    '<div class="setgroup"><div class="setlabel">Hardware</div><div class="card">'+
      '<div class="setrow"><div class="lbl">Device indicator lights</div><div class="etoggle'+(ledsOn?' on':'')+'" id="ledToggle"><div class="knob"></div></div></div>'+
      '<div class="hairrow"></div>'+
      '<div class="setrow tap" id="hwInfoRow"><div class="lbl">Hardware Information</div><div class="chev">›</div></div>'+
    '</div></div>'+
    '<div class="setgroup"><div class="setlabel">General</div><div class="card">'+
      '<div class="setrow"><div class="lbl">Language</div></div>'+
      '<div class="seg" id="langSeg">'+langSeg+'</div>'+
    '</div></div>'+
    '<div class="setgroup"><div class="setlabel">About</div><div class="card">'+
      '<div class="setrow"><div class="lbl">Panel app</div><div class="setval">0.1.0</div></div>'+
      '<div class="hairrow"></div>'+
      '<div class="setrow"><div class="lbl">Device</div><div class="setval">'+host+'</div></div>'+
    '</div></div>'+
    '<div class="setgroup"><div class="setlabel">System</div><div class="card">'+
      '<div class="setrow tap" id="restartRow"><div class="lbl">Restart</div><div class="chev">›</div></div>'+
      '<div class="hairrow"></div>'+
      '<div class="setrow tap" id="shutdownRow"><div class="lbl danger">Shut Down</div><div class="chev">›</div></div>'+
    '</div></div>';
  initSlider(bri);
  // Device indicator lights -> t6-ledd night mode (off = lights stay dark)
  document.getElementById('ledToggle').addEventListener('click',function(){
    var nowOn=!this.classList.contains('on');this.classList.toggle('on',nowOn);
    var night=!nowOn;if(LAST&&LAST.leds)LAST.leds.night=night;
    fetch('api/leds/night',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({on:night})}).catch(function(){});
  });
  document.getElementById('hwInfoRow').addEventListener('click',showHwInfo);
  // Language -> persisted (UI strings still English for now; real i18n later)
  document.querySelectorAll('#langSeg .segopt').forEach(function(o){
    o.addEventListener('click',function(){
      document.querySelectorAll('#langSeg .segopt').forEach(function(x){x.classList.remove('on');});
      o.classList.add('on');var c=o.dataset.lang;if(LAST)LAST.language=c;
      fetch('api/settings/language',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:c})}).catch(function(){});
    });
  });
  // Screen timeout selector -> persisted device-side
  document.querySelectorAll('#timeoutSeg .segopt').forEach(function(o){
    o.addEventListener('click',function(){
      document.querySelectorAll('#timeoutSeg .segopt').forEach(function(x){x.classList.remove('on');});
      o.classList.add('on');
      var s=parseInt(o.dataset.s,10);
      if(LAST&&LAST.screen)LAST.screen.timeout_s=s; else if(LAST)LAST.screen={timeout_s:s};
      fetch('api/settings/screen-timeout',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({seconds:s})}).catch(function(){});
      armIdle();
    });
  });
  // System actions (no-login; confirm first)
  document.getElementById('restartRow').addEventListener('click',function(){
    showConfirm('Restart device?','The NAS will reboot.','Restart',false,function(){fetch('api/power/restart',{method:'POST'}).catch(function(){});toast('Restarting…');});
  });
  document.getElementById('shutdownRow').addEventListener('click',function(){
    showConfirm('Shut down device?','The NAS will power off.','Shut Down',true,function(){fetch('api/power/shutdown',{method:'POST'}).catch(function(){});toast('Shutting down…');});
  });
}

var confirmEl;
function showConfirm(title,msg,okText,danger,cb){
  confirmEl.querySelector('.ctitle').textContent=title;
  confirmEl.querySelector('.cmsg').textContent=msg;
  var ok=confirmEl.querySelector('.ok');ok.textContent=okText;ok.classList.toggle('danger',!!danger);
  confirmEl.classList.add('on');
  function close(){confirmEl.classList.remove('on');}
  ok.onclick=function(){close();cb();};
  confirmEl.querySelector('.cancel').onclick=close;
}

/* ---------- screen off (sleep) + wake ----------
   The home sleep button — and the idle timeout — turn the real backlight off
   (PUT /api/display/power) and show a black overlay. Double-tap wakes it
   (single taps do nothing, so a stray touch won't wake the panel). On the real
   panel the FT8722 still reports touches with the backlight off, so the
   double-tap lands even though the screen is dark. No passcode. */
var idleTimer=null, sleepEl=document.getElementById('sleep'), asleep=false, lastTap=0;
function currentTimeout(){return (LAST&&LAST.screen&&LAST.screen.timeout_s)||0;}
function setPower(on){fetch('api/display/power',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({on:on})}).catch(function(){});}
function goSleep(){if(asleep)return;asleep=true;clearTimeout(idleTimer);sleepEl.classList.add('on');setPower(false);}
function wake(){if(!asleep)return;asleep=false;sleepEl.classList.remove('on');setPower(true);armIdle();}
function armIdle(){clearTimeout(idleTimer);var s=currentTimeout();if(s>0&&!asleep)idleTimer=setTimeout(goSleep,s*1000);}
function onActivity(){if(!asleep)armIdle();} // activity resets the idle timer only while awake
document.getElementById('sleepBtn').addEventListener('click',goSleep);
// double-tap the dark overlay to wake
sleepEl.addEventListener('pointerdown',function(e){var t=Date.now();if(t-lastTap<400)wake();lastTap=t;e.preventDefault();});
['pointerdown','keydown'].forEach(function(ev){document.getElementById('stage').addEventListener(ev,onActivity,{passive:true});});
var putTimer=null;
function putBrightness(v){
  clearTimeout(putTimer);
  putTimer=setTimeout(function(){
    fetch('api/display/brightness',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({value:v})}).catch(function(){});
  },120);
}
function initSlider(initial){
  var s=document.getElementById('briSlider'),fill=s.querySelector('.fill'),val=document.getElementById('briVal');
  function apply(v){v=Math.max(10,Math.min(100,Math.round(v)));fill.style.width=v+'%';val.textContent=v+'%';return v;}
  apply(initial);
  var dragging=false;
  function toVal(clientX){var r=s.getBoundingClientRect();return ((clientX-r.left)/r.width)*100;}
  function set(clientX){var v=apply(toVal(clientX));putBrightness(v);
    if(LAST&&LAST.display)LAST.display.brightness=v;} // optimistic: reopen shows what you set
  function down(e){dragging=true;set((e.touches?e.touches[0]:e).clientX);e.preventDefault();}
  function move(e){if(!dragging)return;set((e.touches?e.touches[0]:e).clientX);e.preventDefault();}
  function up(){dragging=false;}
  s.addEventListener('touchstart',down,{passive:false});
  s.addEventListener('touchmove',move,{passive:false});
  s.addEventListener('touchend',up);
  s.addEventListener('mousedown',down);addEventListener('mousemove',move);addEventListener('mouseup',up);
}

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
function fmtB(b){if(b>=1e12)return (b/1e12).toFixed(1)+' TB';if(b>=1e11)return (b/1e9).toFixed(0)+' GB';if(b>=1e9)return (b/1e9).toFixed(1)+' GB';return (b/1e6).toFixed(0)+' MB';}
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
  if(FNOS){
    // Electron: our own login screen / logout via the held fnOS session.
    if(signedOut){showLogin();}
    else{showConfirm('Sign out?','You will need to sign in again for files and settings.','Sign out',false,function(){
      FNOS.logout().then(function(){fnosUser=null;setAccount();});
    });}
  }else{
    // Plain-browser dev fallback.
    var host=location.protocol+'//'+location.hostname;
    if(signedOut){location.href=host+'/signin?redirect_uri='+encodeURIComponent(host+'/app/t6panel/');}
    else{var port=(LAST&&LAST.session&&LAST.session.shell_port)||9600;
      showConfirm('Sign out?','Return to the status screen.','Sign out',false,function(){location.href=location.protocol+'//'+location.hostname+':'+port+'/';});}
  }
});

/* ---------- login screen (Electron) ---------- */
var loginEl=document.getElementById('login');
function showLogin(){
  document.getElementById('loginErr').hidden=true;
  document.getElementById('loginUser').value='';document.getElementById('loginPass').value='';
  loginEl.classList.add('on');
  setTimeout(function(){document.getElementById('loginUser').focus();},120);
}
function hideLogin(){loginEl.classList.remove('on');}
function submitLogin(){
  var u=document.getElementById('loginUser').value.trim(),p=document.getElementById('loginPass').value;
  var err=document.getElementById('loginErr'),btn=document.getElementById('loginSubmit');
  if(!u||!p){err.textContent='Enter your username and password.';err.hidden=false;return;}
  err.hidden=true;btn.classList.add('busy');btn.textContent='Signing in…';
  FNOS.login(u,p).then(function(res){
    btn.classList.remove('busy');btn.textContent='Sign in';
    if(res&&res.ok){hideLogin();fnosUser=res.user;setAccount();}
    else{err.textContent=(res&&res.error)||'Sign in failed.';err.hidden=false;}
  }).catch(function(){btn.classList.remove('busy');btn.textContent='Sign in';err.textContent='Sign in failed.';err.hidden=false;});
}
document.getElementById('loginCancel').addEventListener('click',hideLogin);
document.getElementById('loginSubmit').addEventListener('click',submitLogin);
document.getElementById('loginPass').addEventListener('keydown',function(e){if(e.key==='Enter')submitLogin();});
document.getElementById('loginUser').addEventListener('keydown',function(e){if(e.key==='Enter')document.getElementById('loginPass').focus();});

/* ---------- global on-screen keyboard (auto-shows on any input focus) ---------- */
(function(){
  var LAYERS={
    abc:[['q','w','e','r','t','y','u','i','o','p'],
         ['a','s','d','f','g','h','j','k','l'],
         ['shift','z','x','c','v','b','n','m','back'],
         ['num','space','return','hide']],
    num:[['1','2','3','4','5','6','7','8','9','0'],
         ['-','/',':',';','(',')','$','&','@'],
         ['.',',','?','!',"'",'back'],
         ['abc','space','return','hide']]
  };
  var LABEL={shift:'⇧',back:'⌫',num:'123',abc:'ABC',space:'space',return:'return',hide:'⌄'};
  var osk=document.getElementById('osk'),target=null,layer='abc',shift=false;
  function isText(el){return el&&el.tagName==='INPUT'&&/^(text|password|search|email|number|tel|url|)$/.test(el.type);}
  function render(){
    osk.innerHTML='';
    LAYERS[layer].forEach(function(row){
      var r=document.createElement('div');r.className='osk-row';
      row.forEach(function(k){
        var key=document.createElement('div');key.dataset.k=k;
        if(LABEL.hasOwnProperty(k)){
          key.className='osk-key act'+(k==='space'?' space':(' wide'));
          if(k==='shift'&&shift)key.classList.add('shift','on');
          key.textContent=LABEL[k];
        }else{key.className='osk-key';key.textContent=(shift&&layer==='abc')?k.toUpperCase():k;}
        key.addEventListener('pointerdown',function(e){e.preventDefault();}); // keep the field focused
        key.addEventListener('click',function(){press(k);});
        r.appendChild(key);
      });
      osk.appendChild(r);
    });
  }
  function insert(c){if(!target)return;var s=target.selectionStart,e=target.selectionEnd;
    if(s==null){target.value+=c;}else{target.value=target.value.slice(0,s)+c+target.value.slice(e);var n=s+c.length;target.selectionStart=target.selectionEnd=n;}
    target.dispatchEvent(new Event('input',{bubbles:true}));}
  function del(){if(!target)return;var s=target.selectionStart,e=target.selectionEnd;
    if(s==null){target.value=target.value.slice(0,-1);}
    else if(s!==e){target.value=target.value.slice(0,s)+target.value.slice(e);target.selectionStart=target.selectionEnd=s;}
    else if(s>0){target.value=target.value.slice(0,s-1)+target.value.slice(e);target.selectionStart=target.selectionEnd=s-1;}
    target.dispatchEvent(new Event('input',{bubbles:true}));}
  function press(k){
    switch(k){
      case 'shift':shift=!shift;render();return;
      case 'back':del();return;
      case 'num':layer='num';shift=false;render();return;
      case 'abc':layer='abc';render();return;
      case 'space':insert(' ');return;
      case 'hide':hide();if(target)target.blur();return;
      case 'return':if(target)target.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return;
      default:insert((shift&&layer==='abc')?k.toUpperCase():k);if(shift){shift=false;render();}
    }
  }
  function show(){if(!osk.classList.contains('on')){layer='abc';shift=false;render();osk.classList.add('on');}}
  function hide(){osk.classList.remove('on');}
  document.addEventListener('focusin',function(e){if(isText(e.target)){target=e.target;show();}});
  document.addEventListener('focusout',function(){setTimeout(function(){if(!isText(document.activeElement))hide();},60);});
})();

/* ---------- Ethernet / Wi-Fi info detail sheet (read-only; config in Web UI) ---------- */
function showDetail(title,rows){
  document.getElementById('detailTitle').textContent=title;
  document.getElementById('detailBody').innerHTML=rows.map(function(r){
    return '<div class="drow"><div class="k">'+r[0]+'</div><div class="v">'+(r[1]||'—')+'</div></div>';}).join('');
  document.getElementById('scrim').classList.add('show');
  document.getElementById('detail').classList.add('show');
}
function closeDetail(){hideWifiPass();hideEthEdit();document.getElementById('detail').classList.remove('show');document.getElementById('scrim').classList.remove('show');}
function showEthDetail(){
  var e=(LAST&&LAST.network&&LAST.network.ethernet)||{};
  document.getElementById('detailTitle').textContent='Ethernet';
  var rows=[['Status',e.connected?'Connected':'Disconnected'],['Link speed',fmtSpeed(e.speed_mbps)],['IP address',e.ip],['Router',e.gateway],['DNS',(e.dns||[]).join(', ')]];
  document.getElementById('detailBody').innerHTML=
    rows.map(function(r){return '<div class="drow"><div class="k">'+r[0]+'</div><div class="v">'+esc(r[1]||'—')+'</div></div>';}).join('')+
    '<div class="login-btn" id="ethEditBtn" style="margin-top:24px">Configure IPv4…</div>';
  document.getElementById('scrim').classList.add('show');
  document.getElementById('detail').classList.add('show');
  document.getElementById('ethEditBtn').addEventListener('click',ethEdit);
}
/* Ethernet IPv4 editor (drives NetworkManager on the wired/OVS connection) */
function ethSetMode(m){
  document.querySelectorAll('#ethMode .seg-opt').forEach(function(o){o.classList.toggle('on',o.dataset.m===m);});
  document.getElementById('ethMode').dataset.m=m;
  document.getElementById('ethManual').hidden=(m!=='manual');
}
function ethEdit(){
  fetch('api/network/ethernet',{cache:'no-store'}).then(function(r){return r.json();}).then(function(c){
    ethSetMode(c.method==='manual'?'manual':'auto');
    var a=(c.address||'').split('/');
    document.getElementById('ethAddr').value=a[0]||'';
    document.getElementById('ethPrefix').value=a[1]||'24';
    document.getElementById('ethGw').value=c.gateway||'';
    document.getElementById('ethDns').value=(c.dns||[]).join(', ');
    document.getElementById('ethErr').hidden=true;
    document.getElementById('ethedit').classList.add('on');
  }).catch(function(){toast('Could not read Ethernet config');});
}
function hideEthEdit(){document.getElementById('ethedit').classList.remove('on');}
(function(){
  var ov=document.getElementById('ethedit'); if(!ov)return;
  document.querySelectorAll('#ethMode .seg-opt').forEach(function(o){o.addEventListener('click',function(){ethSetMode(o.dataset.m);});});
  document.getElementById('ethCancel').addEventListener('click',function(){hideEthEdit();});
  document.getElementById('ethApply').addEventListener('click',function(){
    var m=document.getElementById('ethMode').dataset.m||'auto';
    var err=document.getElementById('ethErr');
    var dns=document.getElementById('ethDns').value.split(',').map(function(s){return s.trim();}).filter(Boolean);
    var body={method:m,dns:dns};
    if(m==='manual'){
      var ip=document.getElementById('ethAddr').value.trim();
      var pfx=(document.getElementById('ethPrefix').value.trim()||'24');
      if(!ip){err.textContent='Enter an IP address.';err.hidden=false;return;}
      if(!/^\d{1,2}$/.test(pfx)||+pfx>32){err.textContent='Subnet prefix must be 0–32.';err.hidden=false;return;}
      body.address=ip+'/'+pfx;
      body.gateway=document.getElementById('ethGw').value.trim();
    }
    err.hidden=true; toast('Applying…');
    fetch('api/network/ethernet',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
      .then(function(r){return r.ok?r.json():r.text().then(function(t){throw new Error((t||'').trim()||('HTTP '+r.status));});})
      .then(function(){toast('Ethernet updated');hideEthEdit();closeDetail();setTimeout(function(){poll();},1500);})
      .catch(function(e){err.textContent=e.message||'Failed';err.hidden=false;});
  });
})();

/* ---------- Wi-Fi config sheet (drives NetworkManager via t6-paneld) ---------- */
var wifiAps=[], wifiPassSsid=null;
var WIFI_LOCK='<div class="wifi-lock"><svg width="30" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10.5" width="16" height="10.5" rx="2.5"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/></svg></div>';
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function wifiChk(r){if(!r.ok)return r.text().then(function(t){throw new Error((t||'').trim()||('HTTP '+r.status));});return r.json().catch(function(){return {};});}
function wifiBars(sig){var n=sig>=75?4:sig>=50?3:sig>=25?2:1,h=[12,19,26,33],o='';for(var i=0;i<4;i++)o+='<i style="height:'+h[i]+'px;opacity:'+(i<n?1:.3)+'"></i>';return '<div class="wbars">'+o+'</div>';}
function wifiSub(ap){if(ap.in_use)return 'Connected';var s=ap.security||'Open';return ap.saved?('Saved · '+s):s;}
function showWifiDetail(){
  document.getElementById('detailTitle').textContent='Wi-Fi';
  document.getElementById('scrim').classList.add('show');
  document.getElementById('detail').classList.add('show');
  wifiRender();
}
function wifiRender(){
  hideWifiPass();
  var w=(LAST&&LAST.network&&LAST.network.wifi)||{},on=!!w.enabled;
  document.getElementById('detailBody').innerHTML=
    '<div class="drow"><div class="k">Wi-Fi</div><div class="v"><div class="etoggle'+(on?' on':'')+'" id="wifiToggle"><div class="knob"></div></div></div></div>'+
    '<div id="wifiList" class="wifi-list">'+(on?'<div class="wifi-empty">Scanning…</div>':'<div class="wifi-empty">Wi-Fi is off</div>')+'</div>';
  document.getElementById('wifiToggle').addEventListener('click',function(){
    fetch('api/network/wifi/radio',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({on:!on})})
      .then(wifiChk).then(function(){setTimeout(function(){poll();wifiRender();},900);})
      .catch(function(e){toast(e.message||'Wi-Fi toggle failed');});
  });
  if(on)wifiScan();
}
function wifiScan(){
  fetch('api/network/wifi/scan?rescan=true',{cache:'no-store'}).then(wifiChk).then(function(aps){
    wifiAps=aps||[];var list=document.getElementById('wifiList');if(!list)return;
    if(!wifiAps.length){list.innerHTML='<div class="wifi-empty">No networks found</div>';return;}
    list.innerHTML=wifiAps.map(function(ap,i){
      return '<div class="wifi-ap" data-i="'+i+'">'+wifiBars(ap.signal)+
        '<div class="wifi-ap-main"><div class="wifi-ap-name">'+esc(ap.ssid)+(ap.in_use?' <span class="wifi-chk">✓</span>':'')+'</div>'+
        '<div class="wifi-ap-sub">'+esc(wifiSub(ap))+'</div></div>'+(ap.security?WIFI_LOCK:'')+'</div>';
    }).join('');
    list.querySelectorAll('.wifi-ap').forEach(function(el){el.addEventListener('click',function(){wifiTap(wifiAps[+el.dataset.i]);});});
  }).catch(function(e){var list=document.getElementById('wifiList');if(list)list.innerHTML='<div class="wifi-empty">'+esc(e.message||'Scan failed')+'</div>';});
}
function wifiTap(ap){if(!ap)return;if(ap.in_use){wifiManage(ap);return;}if(ap.saved||!ap.security){wifiDoConnect(ap.ssid,null);return;}wifiPass(ap);}
function maskFromPrefix(p){if(p==null||p<0||p>32)return null;var m=[0,0,0,0];for(var i=0;i<p;i++)m[Math.floor(i/8)]|=128>>(i%8);return m.join('.');}
function drow(k,v){return v?'<div class="drow"><div class="k">'+esc(k)+'</div><div class="v">'+esc(v)+'</div></div>':'';}
function wifiManage(ap){
  var w=(LAST&&LAST.network&&LAST.network.wifi)||{};
  var det=drow('Status','Connected')+
    drow('Signal',w.signal!=null?w.signal+'%':null)+
    drow('Security',w.security||ap.security)+
    drow('IPv4',w.ip)+
    drow('Subnet mask',maskFromPrefix(w.prefix))+
    drow('Router',w.gateway)+
    drow('DNS',(w.dns||[]).join(', '))+
    drow('IPv6',w.ipv6);
  document.getElementById('detailBody').innerHTML='<div class="wifi-manage"><div class="wifi-ap-name big">'+esc(ap.ssid)+'</div>'+
    det+
    '<div class="login-btn" id="wifiDisc" style="margin-top:24px">Disconnect</div>'+
    (ap.saved?'<div class="login-cancel danger" id="wifiForget">Forget this network</div>':'')+
    '<div class="login-cancel" id="wifiBack">Back</div></div>';
  document.getElementById('wifiDisc').addEventListener('click',function(){wifiNetAct('disconnect',null,'Disconnected');});
  var fg=document.getElementById('wifiForget');if(fg)fg.addEventListener('click',function(){wifiNetAct('forget',{ssid:ap.ssid},'Network forgotten');});
  document.getElementById('wifiBack').addEventListener('click',wifiRender);
}
function wifiNetAct(action,body,okMsg){
  fetch('api/network/wifi/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body||{})})
    .then(wifiChk).then(function(){toast(okMsg);setTimeout(function(){poll();wifiRender();},900);}).catch(function(e){toast(e.message||'Failed');});
}
function wifiDoConnect(ssid,pw,onErr){
  toast('Connecting…');
  fetch('api/network/wifi/connect',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ssid:ssid,password:pw||''})})
    .then(wifiChk).then(function(){toast('Connected to '+ssid);hideWifiPass();setTimeout(function(){poll();wifiRender();},1200);})
    .catch(function(e){var m=e.message||'Connection failed';if(onErr)onErr(m);else toast(m);});
}
// Password entry is a centered overlay (like sign-in) so the keyboard, which
// covers the bottom sheet, doesn't hide the field.
function wifiPass(ap){
  wifiPassSsid=ap.ssid;
  document.getElementById('wpSub').textContent=ap.ssid;
  var inp=document.getElementById('wpInput');inp.value='';document.getElementById('wpErr').hidden=true;
  document.getElementById('wifipass').classList.add('on');
  setTimeout(function(){inp.focus();},60);
}
function hideWifiPass(){var w=document.getElementById('wifipass');if(w)w.classList.remove('on');}
(function(){
  var submit=document.getElementById('wpSubmit'),cancel=document.getElementById('wpCancel'),inp=document.getElementById('wpInput');
  if(!submit)return;
  function go(){var pw=inp.value;if(!pw)return;wifiDoConnect(wifiPassSsid,pw,function(m){var e=document.getElementById('wpErr');e.textContent=m;e.hidden=false;});}
  submit.addEventListener('click',go);
  inp.addEventListener('keydown',function(e){if(e.key==='Enter')go();});
  cancel.addEventListener('click',function(){hideWifiPass();inp.blur();});
})();
function showHwInfo(){
  fetch('api/hwinfo',{cache:'no-store'}).then(function(r){return r.json();}).then(function(h){
    var rows=[['Model',h.model],['CPU',(h.cpu||'—')+(h.cpu_threads?' · '+h.cpu_threads+' threads':'')],['Graphics',h.gpu],
      ['Memory',h.ram_bytes?fmtB(h.ram_bytes):'—'],['Serial',h.serial],['Firmware',h.bios]];
    (h.drives||[]).forEach(function(d,i){rows.push(['Drive '+(i+1),d.model+' · '+fmtB(d.size_bytes)]);});
    showDetail('Device',rows);
  }).catch(function(){toast('Could not read hardware info');});
}
document.getElementById('detailClose').addEventListener('click',closeDetail);
document.getElementById('scrim').addEventListener('click',closeDetail);

confirmEl=document.getElementById('confirm');
renderHome();
poll();setInterval(poll,2000);
refreshFnos(); // pick up an existing Electron/fnOS session for the account chip
