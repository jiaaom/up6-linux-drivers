// Indicator lights sub-page: the Control Center LED page on the panel.
/* Same settings, same t6-ledd commands (through t6-paneld's /api/leds/*).
   Everything is applied at once; the page re-reads the daemon's status after
   each change and every few seconds while open, so what it shows is what the
   LEDs do (night mode, faults and the Wi-Fi/Bluetooth state included). */
var LED_TRAY=[['off','Off','chip-off'],['red','Red','chip-red'],['green','Green','chip-green'],['blue','Blue','chip-blue'],
  ['yellow','R + G','chip-cycle chip-rg'],['cyan','G + B','chip-cycle chip-gb'],['magenta','R + B','chip-cycle chip-rb'],['white','Rainbow','chip-rainbow']];
var LED_TRAY_DESC={off:'Off',red:'Breathing red',green:'Breathing green',blue:'Breathing blue',
  yellow:'Red and green taking turns',cyan:'Green and blue taking turns',magenta:'Red and blue taking turns',white:'Rainbow'};
var LED_MODES=[['auto','All states'],['quiet','Alerts only'],['off','Off']];
var LED_SWATCH={off:'transparent',white:'#f8fafc',red:'#ef4444',green:'#22c55e',blue:'#3b82f6',yellow:'#eab308',cyan:'#06b6d4',magenta:'#d946ef',orange:'#f97316'};
var ledTimer=null, ledBusyUntil=0;

function ledDev(s,id){return (s.devices||[]).filter(function(d){return d.id===id;})[0];}
// t6-ledd reports animations as "blink red" / "heartbeat blue".
function ledDot(effective){
  var m=/^(blink|heartbeat) (\w+)$/.exec(effective||''), c=m?m[2]:effective;
  return '<i class="led-dot'+(m?' fx':'')+(c==='off'?' off':'')+'" style="background:'+(LED_SWATCH[c]||'transparent')+'"></i>';
}
function ledToggle(id,on){return '<div class="etoggle'+(on?' on':'')+'" id="'+id+'"><div class="knob"></div></div>';}
function ledHHMM(m){m=((m%1440)+1440)%1440;return ('0'+Math.floor(m/60)).slice(-2)+':'+('0'+m%60).slice(-2);}
function ledMins(s){var p=/^(\d\d):(\d\d)$/.exec(s||'');return p?(+p[1])*60+(+p[2]):null;}

function openLeds(){
  openPage('Indicator Lights','<div id="ledRoot"><div class="wifi-empty">Loading…</div></div>',function(){
    ledsLoad(true);
    clearInterval(ledTimer);
    ledTimer=setInterval(function(){
      if(!document.body.classList.contains('subpage-open')||!document.getElementById('ledRoot')){clearInterval(ledTimer);ledTimer=null;return;}
      if(Date.now()>ledBusyUntil)ledsLoad(false);
    },3000);
  });
}

function ledsLoad(first){
  fetch('api/leds',{cache:'no-store'}).then(function(r){if(!r.ok)throw new Error();return r.json();})
    .then(function(s){ledsRender(s,first);})
    .catch(function(){var r=document.getElementById('ledRoot');if(r&&first)r.innerHTML='<div class="wifi-empty">The indicator light service is not running.</div>';});
}

function ledsRender(s,first){
  var root=document.getElementById('ledRoot');if(!root)return;
  if(first||!root.dataset.built){root.innerHTML=ledsHtml();root.dataset.built='1';ledsWire(root);}
  var night=s.night||{};
  // Bays
  document.getElementById('ledBays').classList.toggle('on',!!s.bays_enabled);
  document.getElementById('ledBayFault').classList.toggle('on',!!s.bay_fault_blink);
  var present=s.bays_present||[];
  document.getElementById('ledBayNote').textContent=present.length?'Drives in bay '+present.join(', '):'No drives';
  // Status LEDs
  var pw=ledDev(s,'power');
  document.getElementById('ledPower').classList.toggle('on',!!pw&&pw.mode==='auto');
  document.getElementById('ledPowerDot').innerHTML=pw?ledDot(pw.effective):'';
  ['wifi','bt'].forEach(function(id){
    var d=ledDev(s,id);if(!d)return;
    var mode=d.mode==='manual'?'off':d.mode;
    root.querySelectorAll('.led-mode[data-id="'+id+'"] .segopt').forEach(function(o){o.classList.toggle('on',o.dataset.v===mode);});
    document.getElementById('ledDot-'+id).innerHTML=ledDot(d.effective);
  });
  document.getElementById('ledHotspot').classList.toggle('on',s.wifi_hotspot!==false);
  // Tray light
  var rgb=ledDev(s,'rgb'), color=rgb&&rgb.mode==='manual'&&rgb.color?rgb.color:'off', speed=s.tray_speed||'normal';
  var tray=document.getElementById('ledTray');
  tray.dataset.speed=speed;
  tray.querySelectorAll('.led-chip').forEach(function(c){c.classList.toggle('on',c.dataset.v===color);});
  root.querySelectorAll('#ledSpeed .segopt').forEach(function(o){o.classList.toggle('on',o.dataset.v===speed);o.classList.toggle('dim',color==='off');});
  document.getElementById('ledTrayNow').textContent=LED_TRAY_DESC[color]+(night.active&&color!=='off'?' · off for night mode':'');
  // Night mode
  document.getElementById('ledNight').classList.toggle('on',!!night.manual);
  var sched=night.schedule||'';
  document.getElementById('ledSched').classList.toggle('on',!!sched);
  var win=document.getElementById('ledWindow');
  win.hidden=!sched;
  if(sched&&Date.now()>ledBusyUntil){
    var p=sched.split('-');
    document.getElementById('ledFrom').textContent=p[0];
    document.getElementById('ledTo').textContent=p[1];
  }
  document.getElementById('ledNightNow').textContent=night.active?(night.reason==='schedule'?'On now (daily window)':'On now'):'Off now';
}

function ledsHtml(){
  var chips=LED_TRAY.map(function(t){
    return '<div class="led-chip" data-v="'+t[0]+'"><i class="chip '+t[2]+'"></i><span>'+t[1]+'</span></div>';
  }).join('');
  var modeSeg=function(id){return '<div class="seg led-mode" data-id="'+id+'">'+LED_MODES.map(function(m){return '<div class="segopt" data-v="'+m[0]+'">'+m[1]+'</div>';}).join('')+'</div>';};
  return ''+
    '<div class="setgroup"><div class="setlabel">Bay LEDs</div><div class="card">'+
      '<div class="setrow"><div class="lbl">Show drives</div>'+ledToggle('ledBays')+'</div>'+
      '<div class="led-sub" id="ledBayNote"></div>'+
      '<div class="hairrow"></div>'+
      '<div class="setrow"><div class="lbl">Blink red on drive fault</div>'+ledToggle('ledBayFault')+'</div>'+
    '</div></div>'+
    '<div class="setgroup"><div class="setlabel">Status LEDs</div><div class="card">'+
      '<div class="setrow"><div class="lbl"><span id="ledPowerDot"></span>Power status</div>'+ledToggle('ledPower')+'</div>'+
      '<div class="led-sub">Off while the screen is on, white while it is off</div>'+
      '<div class="hairrow"></div>'+
      '<div class="setrow"><div class="lbl"><span id="ledDot-wifi"></span>Wi-Fi</div></div>'+modeSeg('wifi')+
      '<div class="setrow led-gap"><div class="lbl">Show hotspot</div>'+ledToggle('ledHotspot')+'</div>'+
      '<div class="hairrow"></div>'+
      '<div class="setrow"><div class="lbl"><span id="ledDot-bt"></span>Bluetooth</div></div>'+modeSeg('bt')+
    '</div><div class="led-foot">Alerts only keeps the LED dark while things work. Red is an alarm: it shows in every mode, night mode included.</div></div>'+
    '<div class="setgroup"><div class="setlabel">Tray light</div><div class="card" id="ledTray" data-speed="normal">'+
      '<div class="setrow"><div class="lbl">Effect</div><div class="setval" id="ledTrayNow"></div></div>'+
      '<div class="led-chips">'+chips+'</div>'+
      '<div class="hairrow"></div>'+
      '<div class="setrow"><div class="lbl">Speed</div></div>'+
      '<div class="seg" id="ledSpeed"><div class="segopt" data-v="slow">Slow</div><div class="segopt" data-v="normal">Normal</div><div class="segopt" data-v="fast">Fast</div></div>'+
    '</div><div class="led-foot">One colour breathes, two take turns, all three make a rainbow.</div></div>'+
    '<div class="setgroup"><div class="setlabel">Night mode</div><div class="card">'+
      '<div class="setrow"><div class="lbl">Night mode</div>'+ledToggle('ledNight')+'</div>'+
      '<div class="led-sub" id="ledNightNow"></div>'+
      '<div class="hairrow"></div>'+
      '<div class="setrow"><div class="lbl">Every day</div>'+ledToggle('ledSched')+'</div>'+
      '<div id="ledWindow" hidden>'+
        '<div class="setrow led-gap"><div class="lbl">From</div><div class="led-step" data-k="from"><div class="led-stepbtn" data-d="-30">−</div><div class="led-time" id="ledFrom">23:00</div><div class="led-stepbtn" data-d="30">+</div></div></div>'+
        '<div class="setrow led-gap"><div class="lbl">To</div><div class="led-step" data-k="to"><div class="led-stepbtn" data-d="-30">−</div><div class="led-time" id="ledTo">07:00</div><div class="led-stepbtn" data-d="30">+</div></div></div>'+
      '</div>'+
    '</div><div class="led-foot">Switches the lights off. Alarms stay on.</div></div>';
}

// PUT, then re-read the daemon; a failure shows why and restores the truth.
function ledPut(path,body){
  ledBusyUntil=Date.now()+1500;
  return fetch('api/leds/'+path,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
    .then(function(r){if(!r.ok)return r.text().then(function(t){throw new Error((t||'').trim());});})
    .catch(function(e){toast(e.message||'Change failed');})
    .then(function(){ledBusyUntil=0;ledsLoad(false);});
}

function ledsWire(root){
  function flip(id,fn){var el=document.getElementById(id);el.addEventListener('click',function(){var on=!el.classList.contains('on');el.classList.toggle('on',on);fn(on);});}
  flip('ledBays',function(on){ledPut('bays',{on:on});});
  flip('ledBayFault',function(on){ledPut('bay-fault-blink',{on:on});});
  flip('ledPower',function(on){ledPut('power',{value:on?'auto':'off'});});
  flip('ledHotspot',function(on){ledPut('wifi-hotspot',{on:on});});
  flip('ledNight',function(on){ledPut('night',{on:on});});
  flip('ledSched',function(on){
    document.getElementById('ledWindow').hidden=!on;
    ledPut('night',{schedule:on?document.getElementById('ledFrom').textContent+'-'+document.getElementById('ledTo').textContent:null});
  });
  root.querySelectorAll('.led-mode').forEach(function(seg){
    seg.addEventListener('click',function(e){
      var o=e.target.closest('.segopt');if(!o||o.classList.contains('on'))return;
      seg.querySelectorAll('.segopt').forEach(function(x){x.classList.toggle('on',x===o);});
      ledPut(seg.dataset.id,{value:o.dataset.v});
    });
  });
  root.querySelector('.led-chips').addEventListener('click',function(e){
    var c=e.target.closest('.led-chip');if(!c||c.classList.contains('on'))return;
    root.querySelectorAll('.led-chip').forEach(function(x){x.classList.toggle('on',x===c);});
    ledPut('rgb',{value:c.dataset.v});
  });
  document.getElementById('ledSpeed').addEventListener('click',function(e){
    var o=e.target.closest('.segopt');if(!o||o.classList.contains('on'))return;
    this.querySelectorAll('.segopt').forEach(function(x){x.classList.toggle('on',x===o);});
    document.getElementById('ledTray').dataset.speed=o.dataset.v;
    ledPut('tray-speed',{speed:o.dataset.v});
  });
  // Night window: 30-minute steps; sent once the taps settle.
  var stepTimer=null;
  root.querySelectorAll('.led-step').forEach(function(st){
    st.addEventListener('click',function(e){
      var b=e.target.closest('.led-stepbtn');if(!b)return;
      var t=st.querySelector('.led-time');
      t.textContent=ledHHMM(ledMins(t.textContent)+(+b.dataset.d));
      ledBusyUntil=Date.now()+5000;
      clearTimeout(stepTimer);
      stepTimer=setTimeout(function(){
        var from=document.getElementById('ledFrom').textContent, to=document.getElementById('ledTo').textContent;
        if(from===to){toast('Start and end must differ');ledBusyUntil=0;return;}
        ledPut('night',{schedule:from+'-'+to});
      },700);
    });
  });
}
