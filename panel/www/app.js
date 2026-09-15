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

/* ---------- wifi sheet ---------- */
var scrim=document.getElementById('scrim'),sheet=document.getElementById('sheet');
function openSheet(){scrim.classList.add('show');sheet.style.transition='';sheet.classList.add('show');}
function closeSheet(){scrim.classList.remove('show');sheet.style.transition='transform .3s cubic-bezier(.22,1,.36,1)';sheet.style.transform='';sheet.classList.remove('show');}
scrim.addEventListener('click',closeSheet);
document.getElementById('sheetCancel').addEventListener('click',closeSheet);
function bindTiles(){
  homeScroll.querySelectorAll('[data-tile="eth"]').forEach(function(t){t.addEventListener('click',showEthDetail);});
  homeScroll.querySelectorAll('[data-tile="wifi"]').forEach(function(t){t.addEventListener('click',showWifiDetail);});
  homeScroll.querySelectorAll('.tile').forEach(function(t){
    var lab=t.querySelector('.t');
    if(lab&&lab.textContent==='Settings')t.addEventListener('click',openSettings);
  });
}
(function(){
  var startY=0,dragging=false,cur=0;
  function down(e){var y=(e.touches?e.touches[0].clientY:e.clientY);
    if(y>sheet.getBoundingClientRect().top+140)return;dragging=true;startY=y;cur=0;sheet.style.transition='none';}
  function move(e){if(!dragging)return;var y=(e.touches?e.touches[0].clientY:e.clientY);
    cur=Math.max(0,y-startY);sheet.style.transform='translateY('+cur+'px)';e.preventDefault();}
  function up(){if(!dragging)return;dragging=false;
    if(cur>160){closeSheet();}else{sheet.style.transition='transform .3s cubic-bezier(.22,1,.36,1)';sheet.style.transform='translateY(0)';}}
  sheet.addEventListener('touchstart',down,{passive:true});
  sheet.addEventListener('touchmove',move,{passive:false});
  sheet.addEventListener('touchend',up);
  sheet.addEventListener('mousedown',down);addEventListener('mousemove',move);addEventListener('mouseup',up);
})();
var rows=['qwertyuiop','asdfghjkl','zxcvbnm'],kbd=document.getElementById('kbd'),pwlen=0,pwEl=document.getElementById('pw');
function drawPw(){if(pwlen===0){pwEl.className='ph';pwEl.textContent='Password';}else{pwEl.className='';pwEl.textContent='•'.repeat(pwlen);}}
rows.forEach(function(r,i){var rd=document.createElement('div');rd.className='krow';
  if(i===2){var sh=document.createElement('div');sh.className='key';sh.textContent='⇧';rd.appendChild(sh);}
  r.split('').forEach(function(ch){var k=document.createElement('div');k.className='key';k.textContent=ch;k.addEventListener('click',function(){pwlen++;drawPw();});rd.appendChild(k);});
  if(i===2){var bk=document.createElement('div');bk.className='key';bk.textContent='⌫';bk.addEventListener('click',function(){if(pwlen>0)pwlen--;drawPw();});rd.appendChild(bk);}
  kbd.appendChild(rd);});
var last=document.createElement('div');last.className='krow';
[['123',1],['space',3],['↵',1]].forEach(function(p){var k=document.createElement('div');k.className='key wide';k.textContent=p[0];k.style.flex=p[1];last.appendChild(k);});
kbd.appendChild(last);
document.getElementById('joinbtn').addEventListener('click',function(){closeSheet();toast('Joining “Dormitory”…');pwlen=0;drawPw();});
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
  var acct=document.getElementById('acct'),at=document.getElementById('acctText'),dot=acct&&acct.querySelector('.acctdot');
  if(acct){ if(d.session&&d.session.username){acct.classList.remove('signin');at.textContent='Signed in as '+d.session.username;if(dot)dot.hidden=false;}
            else{acct.classList.add('signin');at.textContent='Sign in';if(dot)dot.hidden=true;} }
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
    var es=et.querySelector('.eth-sub');if(es)es.textContent=e.connected?fmtSpeed(e.speed_mbps):'Disconnected';}
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
  if(document.getElementById('acct').classList.contains('signin'))toast('Sign in — fnOS login coming next');
});

/* ---------- Ethernet / Wi-Fi info detail sheet (read-only; config in Web UI) ---------- */
function showDetail(title,rows){
  document.getElementById('detailTitle').textContent=title;
  document.getElementById('detailBody').innerHTML=rows.map(function(r){
    return '<div class="drow"><div class="k">'+r[0]+'</div><div class="v">'+(r[1]||'—')+'</div></div>';}).join('');
  document.getElementById('scrim').classList.add('show');
  document.getElementById('detail').classList.add('show');
}
function closeDetail(){document.getElementById('detail').classList.remove('show');document.getElementById('scrim').classList.remove('show');}
function showEthDetail(){var e=(LAST&&LAST.network&&LAST.network.ethernet)||{};
  showDetail('Ethernet',[['Status',e.connected?'Connected':'Disconnected'],['Link speed',fmtSpeed(e.speed_mbps)],['IP address',e.ip],['Router',e.gateway],['DNS',(e.dns||[]).join(', ')]]);}
function showWifiDetail(){var w=(LAST&&LAST.network&&LAST.network.wifi)||{};
  showDetail('Wi-Fi',[['Network',w.ssid],['Status',(w.connected&&w.ssid)?'Connected':'Off'],['Signal',fmtSig(w.signal)],['Security',w.security],['IP address',w.ip]]);}
function showHwInfo(){
  fetch('api/hwinfo',{cache:'no-store'}).then(function(r){return r.json();}).then(function(h){
    var rows=[['Model',h.model],['CPU',(h.cpu||'—')+(h.cpu_threads?' · '+h.cpu_threads+' threads':'')],['Graphics',h.gpu],
      ['Memory',h.ram_bytes?fmtB(h.ram_bytes):'—'],['Serial',h.serial],['Firmware',h.bios]];
    (h.drives||[]).forEach(function(d,i){rows.push(['Drive '+(i+1),d.model+' · '+fmtB(d.size_bytes)]);});
    showDetail('Device',rows);
  }).catch(function(){toast('Could not read hardware info');});
}
// Open the fnOS Web UI (port 80 on the same host) — the config fallback.
function openWebUI(){location.href='http://'+location.hostname+'/';}
var webuiBtn=document.getElementById('webuiBtn');if(webuiBtn)webuiBtn.addEventListener('click',openWebUI);
document.getElementById('detailClose').addEventListener('click',closeDetail);
document.getElementById('scrim').addEventListener('click',closeDetail);
document.getElementById('detailWeb').addEventListener('click',function(){closeDetail();openWebUI();});

confirmEl=document.getElementById('confirm');
renderHome();
poll();setInterval(poll,2000);
