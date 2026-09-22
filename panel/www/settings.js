// Settings screen + generic sub-page (openPage/closePage), confirm dialog, sleep/brightness.
/* ---------- settings screen + brightness slider ---------- */
var settingsScroll=document.getElementById('settingsScroll');
function openSettings(){
  document.body.classList.add('settings-open');
  // Open at the true current value, not a possibly-stale poll snapshot.
  fetch('api/panel',{cache:'no-store'}).then(function(r){return r.json();})
    .then(function(d){LAST=d;buildSettings();}).catch(buildSettings);
}
function closeSettings(){document.body.classList.remove('settings-open');}
document.getElementById('settingsBack').addEventListener('click',closeSettings);

/* Generic full-screen sub-page in the Settings visual style (Ethernet, Wi-Fi,
   Volumes, Files…). Content-heavy sections live here instead of the bottom
   sheet. `onMount` runs after the HTML is in the DOM to wire handlers. */
var subpageScroll=document.getElementById('subpageScroll');
function setSubTitle(t){document.getElementById('subTitle').textContent=t;document.getElementById('subCrumb').textContent=t;}
// A page opened "on top of" the current one (e.g. file preview, launched from
// the file browser) can set pageBack to a function that redraws what was there
// instead of the normal full close. (The file browser now manages its own
// navigation in files.js and no longer uses pageBack.)
var pageBack=null;
// opts: {sub:<subtitle html>, back:true} — optional subtitle line under the
// title and a round back button (design: System page). Both reset per page.
function setSubSub(html){var e=document.getElementById('subSub');if(!e)return;if(html){e.innerHTML=html;e.hidden=false;}else{e.innerHTML='';e.hidden=true;}}
function openPage(title,html,onMount,opts){
  pageBack=null;
  opts=opts||{};
  setSubTitle(title);
  setSubSub(opts.sub||'');
  var back=opts.back!==false; // default: round Back button; pass {back:false} to get the Done pill instead
  var b=document.getElementById('subBack');if(b)b.hidden=!back;
  var dn=document.getElementById('subDone');if(dn)dn.hidden=back;
  subpageScroll.innerHTML=html||'';
  subpageScroll.scrollTop=0;
  document.body.classList.add('subpage-open');
  if(onMount)onMount();
}
function closePage(){
  if(pageBack){var back=pageBack;pageBack=null;back();return;}
  document.body.classList.remove('subpage-open');
}
document.getElementById('subDone').addEventListener('click',closePage);
document.getElementById('subBack').addEventListener('click',closePage);
var TIMEOUTS=[[0,'Never'],[60,'1 min'],[300,'5 min'],[900,'15 min']];
var LANGS=[['en','English'],['ja','日本語'],['zh','简体中文']];
var FAN_PRESETS=[['silent','Silent'],['balance','Balanced'],['performance','Performance'],['custom','Custom']];
function buildSettings(){
  var bri=(LAST&&LAST.display&&LAST.display.brightness!=null)?LAST.display.brightness:50;
  var to=(LAST&&LAST.screen&&LAST.screen.timeout_s!=null)?LAST.screen.timeout_s:0;
  var lang=(LAST&&LAST.language)||'en';
  var ledsOn=!(LAST&&LAST.leds&&LAST.leds.night); // indicator lights active when night mode is off
  var sshOn=!!(LAST&&LAST.ssh&&LAST.ssh.enabled);
  var host=(LAST&&LAST.host&&LAST.host.name)||'—';
  var seg=TIMEOUTS.map(function(t){return '<div class="segopt'+(t[0]===to?' on':'')+'" data-s="'+t[0]+'">'+t[1]+'</div>';}).join('');
  // var langSeg=LANGS.map(function(l){return '<div class="segopt'+(l[0]===lang?' on':'')+'" data-lang="'+l[0]+'">'+l[1]+'</div>';}).join(''); // language selection: placeholder, disabled until i18n
  settingsScroll.innerHTML=
    '<div class="setgroup"><div class="setlabel">Screen</div><div class="card">'+
      '<div class="setrow"><div class="lbl">Brightness</div><div class="setval" id="briVal">'+bri+'%</div></div>'+
      '<div class="slider" id="briSlider"><div class="fill"></div><span class="ico">☀</span><span class="ico r">☀</span></div>'+
      '<div class="hairrow"></div>'+
      '<div class="setrow"><div class="lbl">Screen Timeout</div></div>'+
      '<div class="seg" id="timeoutSeg">'+seg+'</div>'+
    '</div></div>'+
    '<div class="setgroup"><div class="setlabel">Appearance</div><div class="card">'+
      '<div class="setrow"><div class="lbl">Theme</div></div>'+
      '<div class="seg" id="themeSeg">'+THEMES.map(function(t){return '<div class="segopt'+(t===theme?' on':'')+'" data-th="'+t+'">'+(t==='dark'?'Dark':'Light')+'</div>';}).join('')+'</div>'+
    '</div></div>'+
    '<div class="setgroup"><div class="setlabel">Hardware</div><div class="card">'+
      '<div class="setrow"><div class="lbl">Device indicator lights</div><div class="etoggle'+(ledsOn?' on':'')+'" id="ledToggle"><div class="knob"></div></div></div>'+
      '<div class="hairrow"></div>'+
      '<div class="setrow tap" id="hwInfoRow"><div class="lbl">Hardware Information</div><div class="chev">›</div></div>'+
    '</div></div>'+
    '<div class="setgroup"><div class="setlabel">Cooling</div><div class="card">'+
      '<div class="setrow"><div class="lbl">Fan profile</div></div>'+
      '<div class="seg" id="fanSeg">'+FAN_PRESETS.map(function(f){return '<div class="segopt" data-fan="'+f[0]+'">'+f[1]+'</div>';}).join('')+'</div>'+
    '</div></div>'+
    /* Language selection is a placeholder — the UI is English-only until real
       i18n lands. Hidden for now (re-enable this group + its wiring below).
    '<div class="setgroup"><div class="setlabel">General</div><div class="card">'+
      '<div class="setrow"><div class="lbl">Language</div></div>'+
      '<div class="seg" id="langSeg">'+langSeg+'</div>'+
    '</div></div>'+
    */
    '<div class="setgroup"><div class="setlabel">Remote access</div><div class="card">'+
      '<div class="setrow"><div class="lbl">SSH (Secure Shell)</div><div class="etoggle'+(sshOn?' on':'')+'" id="sshToggle"><div class="knob"></div></div></div>'+
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
  // Theme: applies instantly, then persists device-side (see theme.js).
  document.querySelectorAll('#themeSeg .segopt').forEach(function(o){
    o.addEventListener('click',function(){
      document.querySelectorAll('#themeSeg .segopt').forEach(function(x){x.classList.remove('on');});
      o.classList.add('on');
      setTheme(o.dataset.th);
    });
  });
  // Device indicator lights -> t6-ledd night mode (off = lights stay dark)
  document.getElementById('ledToggle').addEventListener('click',function(){
    var nowOn=!this.classList.contains('on');this.classList.toggle('on',nowOn);
    var night=!nowOn;if(LAST&&LAST.leds)LAST.leds.night=night;
    fetch('api/leds/night',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({on:night})}).catch(function(){});
  });
  document.getElementById('hwInfoRow').addEventListener('click',showHwInfo);
  // SSH on/off (systemctl via t6-paneld). Security-relevant → confirm first.
  var sshT=document.getElementById('sshToggle');
  if(sshT)sshT.addEventListener('click',function(){
    var nowOn=!sshT.classList.contains('on');
    showConfirm(nowOn?'Enable SSH?':'Disable SSH?',
      nowOn?'Allow remote shell access to this NAS.':'Turn off remote shell access. Existing sessions stay connected until they close.',
      nowOn?'Enable':'Disable', !nowOn, function(){
        sshT.classList.toggle('on',nowOn);
        if(LAST&&LAST.ssh)LAST.ssh.enabled=nowOn; else if(LAST)LAST.ssh={enabled:nowOn};
        fetch('api/settings/ssh',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({on:nowOn})})
          .then(function(r){if(!r.ok)return r.text().then(function(t){throw new Error(t||'');});})
          .then(function(){toast('SSH '+(nowOn?'enabled':'disabled'));})
          .catch(function(){sshT.classList.toggle('on',!nowOn);toast('SSH change failed');});
      });
  });
  // Fan profile -> t6-fand (highlight the active one, switch on tap)
  fetch('api/fan',{cache:'no-store'}).then(function(r){return r.json();}).then(function(f){
    document.querySelectorAll('#fanSeg .segopt').forEach(function(o){o.classList.toggle('on',o.dataset.fan===f.profile);});
  }).catch(function(){});
  document.querySelectorAll('#fanSeg .segopt').forEach(function(o){
    o.addEventListener('click',function(){
      document.querySelectorAll('#fanSeg .segopt').forEach(function(x){x.classList.remove('on');});
      o.classList.add('on');
      fetch('api/fan',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({profile:o.dataset.fan})})
        .then(function(r){if(!r.ok)return r.text().then(function(t){throw new Error((t||'').trim());});})
        .then(function(){toast('Fan profile: '+o.textContent);})
        .catch(function(e){toast(e.message||'Fan change failed');});
    });
  });
  /* Language selection disabled (placeholder until i18n). Re-enable with the group above.
  document.querySelectorAll('#langSeg .segopt').forEach(function(o){
    o.addEventListener('click',function(){
      document.querySelectorAll('#langSeg .segopt').forEach(function(x){x.classList.remove('on');});
      o.classList.add('on');var c=o.dataset.lang;if(LAST)LAST.language=c;
      fetch('api/settings/language',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:c})}).catch(function(){});
    });
  });
  */
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

