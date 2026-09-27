// Bluetooth sub-page (Settings → Bluetooth): pair and connect audio and input
// devices — headphones, speakers, keyboards, remotes, game pads.
/* Through t6-paneld's /api/bluetooth (BlueZ). Other apps (fnOS's Bluetooth
   app) can manage Bluetooth at the same time: the paired list and the on/off
   switch are the system's, shared by both. Scanning is a lease the page
   renews while it is open (stopped when you leave, or after a minute: press
   Scan again); pairing an audio device also makes it the audio output.
   Keyboards (and devices with a screen) pair with a code: the backend's agent
   puts the question in `prompt`, shown here in #btCode and answered with
   POST api/bluetooth/prompt. */
var btTimer=null, btScanUntil=0, btBusy={}, btShowUnnamed=false, btDevs=[], btPromptId=0;
var BT_SCAN_MS=60000;
var BT_ICON={
  audio:'<path d="M6 17v-3a8 8 0 0 1 16 0v3"/><rect x="4" y="16" width="5" height="8" rx="2"/><rect x="19" y="16" width="5" height="8" rx="2"/>',
  keyboard:'<rect x="3" y="8" width="22" height="13" rx="2"/><path d="M7 12h1M11 12h1M15 12h1M19 12h1M8 17h12"/>',
  mouse:'<rect x="8" y="4" width="12" height="20" rx="6"/><path d="M14 4v6"/>',
  gamepad:'<path d="M8 10h12a5 5 0 0 1 4.8 6.4l-1 3.2a2.5 2.5 0 0 1-4.3.8L17 18h-6l-2.5 2.4a2.5 2.5 0 0 1-4.3-.8l-1-3.2A5 5 0 0 1 8 10z"/><path d="M8 13v4M6 15h4"/>',
  remote:'<rect x="9" y="3" width="10" height="22" rx="3"/><circle cx="14" cy="10" r="2"/><path d="M12 16h4M12 19h4"/>'
};
var BT_KIND={audio:'Audio',keyboard:'Keyboard',mouse:'Mouse',gamepad:'Game controller',remote:'Remote'};

function btIcon(kind){
  return '<svg class="bt-ico" width="26" height="26" viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'+(BT_ICON[kind]||BT_ICON.keyboard)+'</svg>';
}

function openBluetooth(){
  btScanUntil=Date.now()+BT_SCAN_MS;
  openPage('Bluetooth','<div id="btRoot"><div class="wifi-empty">Loading…</div></div>',function(){
    btLoad(true);
    btScan();
    clearInterval(btTimer);
    btTimer=setInterval(function(){
      if(!document.body.classList.contains('subpage-open')||!document.getElementById('btRoot')){
        clearInterval(btTimer);btTimer=null;btStopScan();return;
      }
      btScan();
      btLoad(false);
    },2500);
  });
}

// Renew the scan lease while the page is open and within the scan minute.
function btScan(){
  if(Date.now()>=btScanUntil)return;
  fetch('api/bluetooth/scan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({secs:10})}).catch(function(){});
}
function btStopScan(){
  btScanUntil=0;
  fetch('api/bluetooth/scan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({secs:0})}).catch(function(){});
}

function btLoad(first){
  fetch('api/bluetooth',{cache:'no-store'}).then(function(r){if(!r.ok)throw new Error();return r.json();})
    .then(btRender)
    .catch(function(){var r=document.getElementById('btRoot');if(r&&first)r.innerHTML='<div class="wifi-empty">Bluetooth is not available right now.</div>';});
}

function btRender(s){
  btPrompt(s.prompt||null);
  var root=document.getElementById('btRoot');if(!root)return;
  if(!s.adapter){root.innerHTML='<div class="wifi-empty">No Bluetooth adapter found.</div>';return;}
  var devs=btDevs=s.devices||[];
  var mine=devs.filter(function(d){return d.paired;});
  var near=devs.filter(function(d){return !d.paired&&d.supported&&(btShowUnnamed||!d.unnamed);});
  var hidden=devs.filter(function(d){return !d.paired&&!(d.supported&&(btShowUnnamed||!d.unnamed));}).length;
  var unnamed=devs.some(function(d){return !d.paired&&d.supported&&d.unnamed;});
  var scanning=s.powered&&Date.now()<btScanUntil;

  var h='<div class="setgroup"><div class="card">'+
      '<div class="setrow"><div class="lbl">Bluetooth</div><div class="etoggle'+(s.powered?' on':'')+'" id="btPower"><div class="knob"></div></div></div>'+
    '</div></div>';
  if(s.powered){
    h+='<div class="setgroup"><div class="setlabel">My devices</div><div class="card">'+
      (mine.length?mine.map(function(d,i){return (i?'<div class="hairrow"></div>':'')+btRow(d,true);}).join(''):
        '<div class="wifi-empty">No paired devices yet.</div>')+
      '</div></div>';
    h+='<div class="setgroup"><div class="setlabel bt-near">Nearby devices'+
        (scanning?'<span class="bt-scan">Scanning…</span>':'<span class="bt-rescan" id="btRescan">Scan again</span>')+'</div><div class="card">'+
      (near.length?near.map(function(d,i){return (i?'<div class="hairrow"></div>':'')+btRow(d,false);}).join(''):
        '<div class="wifi-empty">'+(scanning?'Looking for devices…':'No devices found.')+'</div>')+
      (hidden?'<div class="hairrow"></div><div class="setrow bt-hidden'+(unnamed&&!btShowUnnamed?' tap" id="btUnnamed':'')+'"><div class="lbl">'+hidden+' other device'+(hidden>1?'s':'')+' nearby not shown</div>'+
        (unnamed&&!btShowUnnamed?'<div class="setval">Show unnamed <span class="chev">›</span></div>':'')+'</div>':'')+
      '</div><div class="led-foot">Put headphones, a speaker, a keyboard or the remote in pairing mode and tap it here. Phones, computers and other devices are not shown.</div></div>';
  }
  root.innerHTML=h;
  btWire(root,devs);
}

function btRow(d,mine){
  var busy=btBusy[d.address], st;
  if(busy)st=busy;
  else if(mine)st=d.connected?('Connected'+(d.battery!=null?' · '+d.battery+'%':'')):'Not connected';
  else st=BT_KIND[d.kind]||'';
  return '<div class="setrow tap bt-dev" data-addr="'+esc(d.address)+'">'+btIcon(d.kind)+
    '<div class="lbl"><div class="bt-name">'+esc(d.name)+'</div><div class="bt-sub'+(d.connected&&!busy?' on':'')+'">'+esc(st)+'</div></div>'+
    (mine?'<span class="chev">›</span>':'<div class="setval bt-pair">'+(busy?'':'Pair')+'</div>')+'</div>';
}

function btPost(addr,action,method){
  return fetch('api/bluetooth/device/'+encodeURIComponent(addr)+(action?'/'+action:''),{method:method||'POST'})
    .then(function(r){if(!r.ok)return r.text().then(function(t){throw new Error((t||'').trim()||'Failed');});});
}

// Run a device action with a status line on its row; re-read afterwards.
function btDo(addr,label,action,method,done){
  btBusy[addr]=label;btLoad(false);
  // While pairing, look for a code to show more often than the page poll.
  var fast=action==='pair'?setInterval(function(){btLoad(false);},700):null;
  return btPost(addr,action,method)
    .then(function(){if(done)toast(done);})
    .catch(function(e){toast(e.message);})
    .then(function(){clearInterval(fast);delete btBusy[addr];btPrompt(null);btLoad(false);});
}

// The pairing-code dialog: `type` (type the code on the keyboard, closes by
// itself when pairing ends), `confirm` (same code on the device?), `enter`
// (type the code the device shows).
var btCodeEl=document.getElementById('btCode');
function btPrompt(p){
  if(!p){if(btPromptId){btPromptId=0;btCodeEl.classList.remove('on');var i=btCodeEl.querySelector('.bt-codein');i.blur();}return;}
  var d=btDevs.filter(function(x){return x.address.toUpperCase()===p.address.toUpperCase();})[0];
  var name=d?d.name:p.address;
  var codeEl=btCodeEl.querySelector('.bt-code'), input=btCodeEl.querySelector('.bt-codein');
  var ok=btCodeEl.querySelector('.ok');
  if(p.code){
    var n=p.entered==null?0:Math.min(p.entered,p.code.length);
    codeEl.innerHTML=p.code.split('').map(function(c,i){return '<span'+(i<n?' class="typed"':'')+'>'+esc(c)+'</span>';}).join('');
  }
  if(p.id===btPromptId)return; // same question; only the typed count moved
  btPromptId=p.id;
  btCodeEl.querySelector('.ctitle').textContent='Pair '+name;
  btCodeEl.querySelector('.cmsg').textContent=
    p.kind==='type'?'Type this code on the keyboard, then press Enter.':
    p.kind==='confirm'?'Check that '+name+' shows the same code.':
    'Enter the code shown on '+name+'.';
  codeEl.style.display=p.code?'':'none';
  input.style.display=p.kind==='enter'?'':'none';input.value='';
  ok.style.display=p.kind==='type'?'none':'';
  btCodeEl.classList.add('on');
  if(p.kind==='enter')setTimeout(function(){input.focus();},50);
  function answer(accept){
    var body={id:p.id,accept:accept};
    if(accept&&p.kind==='enter'){
      if(!/^\d{1,6}$/.test(input.value)){toast('Enter the 6-digit code');return;}
      body.passkey=parseInt(input.value,10);
    }
    btCodeEl.classList.remove('on');input.blur();
    fetch('api/bluetooth/prompt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}).catch(function(){});
  }
  ok.onclick=function(){answer(true);};
  btCodeEl.querySelector('.cancel').onclick=function(){answer(false);};
}

function btWire(root,devs){
  var p=document.getElementById('btPower');
  if(p)p.addEventListener('click',function(){
    var on=!p.classList.contains('on');p.classList.toggle('on',on);
    fetch('api/bluetooth/power',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({on:on})})
      .then(function(r){if(!r.ok)throw new Error();if(on){btScanUntil=Date.now()+BT_SCAN_MS;btScan();}})
      .catch(function(){toast('Could not switch Bluetooth');})
      .then(function(){btLoad(false);});
  });
  var re=document.getElementById('btRescan');
  if(re)re.addEventListener('click',function(){btScanUntil=Date.now()+BT_SCAN_MS;btScan();btLoad(false);});
  var un=document.getElementById('btUnnamed');
  if(un&&!btShowUnnamed)un.addEventListener('click',function(){btShowUnnamed=true;btLoad(false);});
  root.querySelectorAll('.bt-dev').forEach(function(row){
    var addr=row.dataset.addr, d=devs.filter(function(x){return x.address===addr;})[0];
    row.addEventListener('click',function(){
      if(!d||btBusy[addr])return;
      if(!d.paired){btDo(addr,'Pairing…','pair',null,'Connected to '+d.name);return;}
      btActions(d);
    });
  });
}

// Actions for a paired device.
function btActions(d){
  var rows=[];
  rows.push(d.connected?['disconnect','Disconnect']:['connect','Connect']);
  if(d.connected&&d.kind==='audio')rows.push(['audio','Use for audio']);
  rows.push(['forget','Forget this device',true]);
  var body=rows.map(function(r){return '<div class="fm-mrow'+(r[2]?' danger':'')+'" data-a="'+r[0]+'"><span>'+r[1]+'</span></div>';}).join('');
  fmSheet(d.name,body,function(sheet){
    sheet.querySelectorAll('.fm-mrow').forEach(function(row){
      row.addEventListener('click',function(){
        var a=row.dataset.a;fmCloseSheet();
        if(a==='connect')btDo(d.address,'Connecting…','connect',null,'Connected to '+d.name);
        else if(a==='disconnect')btDo(d.address,'Disconnecting…','disconnect',null);
        else if(a==='audio')btDo(d.address,'Switching…','audio',null,'Audio now plays on '+d.name);
        else if(a==='forget')showConfirm('Forget '+d.name+'?','To use it again you will have to pair it again.','Forget',true,function(){
          btDo(d.address,'Forgetting…','','DELETE');
        });
      });
    });
  });
}
