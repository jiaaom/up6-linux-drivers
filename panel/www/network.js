// Ethernet/Wi-Fi/Hotspot, Thunderbolt, Sharing, hardware info, and app init (loads last).
function setRows(rows){
  return rows.filter(function(r){return r;}).map(function(r,i){
    return (i?'<div class="hairrow"></div>':'')+'<div class="setrow"><div class="lbl">'+esc(r[0])+'</div><div class="setval">'+esc(r[1]||'—')+'</div></div>';
  }).join('');
}
function showEthDetail(){
  var e=(LAST&&LAST.network&&LAST.network.ethernet)||{};
  var rows=[['Status',e.connected?'Connected':'Disconnected'],['Link speed',fmtSpeed(e.speed_mbps)],['IP address',e.ip],['Router',e.gateway],['DNS',(e.dns||[]).join(', ')]];
  var html='<div class="setgroup"><div class="setlabel">Connection</div><div class="card">'+setRows(rows)+'</div></div>'+
    '<div class="setgroup"><div class="card"><div class="setrow tap" id="ethEditRow"><div class="lbl">Configure IPv4…</div><div class="chev">›</div></div></div></div>';
  openPage('Ethernet',html,function(){document.getElementById('ethEditRow').addEventListener('click',ethEdit);});
}
/* Ethernet IPv4 editor (drives NetworkManager on the wired/OVS connection) */
function ethSetMode(m){
  document.querySelectorAll('#ethMode .seg-opt').forEach(function(o){o.classList.toggle('on',o.dataset.m===m);});
  document.getElementById('ethMode').dataset.m=m;
  document.getElementById('ethManual').hidden=(m!=='manual');
}
// Generalized IPv4 editor (shared by Ethernet and Thunderbolt-net). The caller
// supplies where to read/write and any extra body fields (e.g. the TB conn).
var ipv4Ctx=null;
function ipv4Open(ctx){
  ipv4Ctx=ctx;
  document.getElementById('ipv4Title').textContent=ctx.title;
  fetch(ctx.getUrl,{cache:'no-store'}).then(function(r){return r.json();}).then(function(c){
    ethSetMode(c.method==='manual'?'manual':'auto');
    var a=(c.address||'').split('/');
    document.getElementById('ethAddr').value=a[0]||'';
    document.getElementById('ethPrefix').value=a[1]||'24';
    document.getElementById('ethGw').value=c.gateway||'';
    document.getElementById('ethDns').value=(c.dns||[]).join(', ');
    document.getElementById('ethErr').hidden=true;
    document.getElementById('ethedit').classList.add('on');
  }).catch(function(){toast('Could not read '+ctx.title);});
}
function ethEdit(){ ipv4Open({title:'Ethernet IPv4',getUrl:'api/network/ethernet',postUrl:'api/network/ethernet',extra:{}}); }
function tbNetEdit(conn){ ipv4Open({title:'Thunderbolt IPv4',getUrl:'api/thunderbolt/net?conn='+encodeURIComponent(conn),postUrl:'api/thunderbolt/net',extra:{conn:conn}}); }
function hideEthEdit(){document.getElementById('ethedit').classList.remove('on');}

/* ---------- Thunderbolt page (status + device authorization + TB networking) ---------- */
var TB_SEC={user:'User authorization',secure:'Secure (key)',dponly:'DisplayPort only',none:'None (open)',usb4:'USB4',nopcie:'No PCIe tunnels'};
function showTbDetail(){
  fetch('api/thunderbolt',{cache:'no-store'}).then(function(r){return r.json();}).then(renderTb).catch(function(){toast('Could not read Thunderbolt');});
}
function renderTb(tb){
  document.getElementById('detailTitle').textContent='Thunderbolt';
  var html=drow('Controller',tb.controller)+drow('Security',TB_SEC[tb.security]||tb.security);
  if(!tb.supported){html+='<div class="wifi-empty">No Thunderbolt controller</div>';}
  else if(!(tb.devices||[]).length){html+='<div class="wifi-empty">No devices connected</div>';}
  else{
    html+=(tb.devices||[]).map(function(dv){
      var status=dv.pending?'Pending authorization':(dv.stored?'Authorized · Remembered':'Authorized');
      var sub=[dv.vendor,(dv.generation?'TB'+dv.generation:'')].filter(Boolean).join(' · ');
      var btns='';
      if(dv.pending)btns='<div class="login-btn tb-act" data-a="authorize" data-u="'+esc(dv.uuid)+'">Authorize</div><div class="login-cancel tb-act" data-a="enroll" data-u="'+esc(dv.uuid)+'">Authorize &amp; Remember</div>';
      else if(!dv.stored)btns='<div class="login-cancel tb-act" data-a="enroll" data-u="'+esc(dv.uuid)+'">Remember this device</div>';
      else btns='<div class="login-cancel danger tb-act" data-a="forget" data-u="'+esc(dv.uuid)+'">Forget this device</div>';
      return '<div class="tb-dev"><div class="wifi-ap-name big">'+esc(dv.name)+'</div>'+
        (sub?'<div class="wifi-ap-sub">'+esc(sub)+'</div>':'')+
        '<div class="wifi-ap-sub'+(dv.pending?' tb-pending':'')+'">'+status+'</div>'+btns+'</div>';
    }).join('');
  }
  if((tb.net||[]).length){
    html+='<div class="tb-head">Thunderbolt networking</div>';
    html+=(tb.net||[]).map(function(nif){
      return '<div class="tb-net"><div class="wifi-ap-name">'+esc(nif.iface)+'</div>'+
        '<div class="wifi-ap-sub">'+(nif.connected?'Connected':'Down')+' · '+esc((nif.ipv4&&nif.ipv4.address)||'no address')+'</div>'+
        (nif.conn?'<div class="login-cancel tb-netcfg" data-c="'+esc(nif.conn)+'">Configure IPv4…</div>':'')+'</div>';
    }).join('');
  }else if(tb.supported){
    html+='<div class="tb-hint">Connect another computer over Thunderbolt for a high-speed peer link (SMB over TB).</div>';
  }
  document.getElementById('detailBody').innerHTML=html;
  document.getElementById('scrim').classList.add('show');
  document.getElementById('detail').classList.add('show');
  document.querySelectorAll('.tb-act').forEach(function(b){b.addEventListener('click',function(){tbDeviceAction(b.dataset.a,b.dataset.u);});});
  document.querySelectorAll('.tb-netcfg').forEach(function(b){b.addEventListener('click',function(){tbNetEdit(b.dataset.c);});});
}
function tbDeviceAction(action,uuid){
  toast(action==='forget'?'Forgetting…':'Authorizing…');
  fetch('api/thunderbolt/device',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:action,uuid:uuid})})
    .then(function(r){return r.ok?r.json():r.text().then(function(t){throw new Error((t||'').trim()||('HTTP '+r.status));});})
    .then(function(){toast('Done');setTimeout(function(){poll();showTbDetail();},1000);})
    .catch(function(e){toast(e.message||'Failed');});
}

/* ---------- Sharing (SMB/NFS) — read-only status; share list gated on sign-in ---------- */
function showSharing(){
  fetch('api/sharing',{cache:'no-store'}).then(function(r){return r.json();}).then(function(s){
    document.getElementById('detailTitle').textContent='Sharing';
    var html=drow('SMB (Windows)',s.smb?'Enabled':'Disabled')+
      drow('NFS (Unix / Linux)',s.nfs?'Enabled':'Disabled')+
      drow('Active connections',String(s.connections||0));
    html+='<div class="tb-head">Shared folders</div>';
    if(!fnosUser){
      html+='<div class="tb-hint">Sign in to view shared folders.</div>';
    }else if(!(s.shares||[]).length){
      html+='<div class="wifi-empty">No shared folders</div>';
    }else{
      html+=(s.shares||[]).map(function(sh){
        return '<div class="share-row"><div class="wifi-ap-main"><div class="wifi-ap-name">'+esc(sh.name)+'</div><div class="wifi-ap-sub">'+esc(sh.path)+'</div></div><div class="share-proto">'+esc((sh.protocol||'').toUpperCase())+'</div></div>';
      }).join('');
    }
    html+='<div class="tb-hint">Shares are managed from the NAS web UI.</div>';
    document.getElementById('detailBody').innerHTML=html;
    document.getElementById('scrim').classList.add('show');
    document.getElementById('detail').classList.add('show');
  }).catch(function(){toast('Could not read sharing status');});
}
(function(){
  var ov=document.getElementById('ethedit'); if(!ov)return;
  document.querySelectorAll('#ethMode .seg-opt').forEach(function(o){o.addEventListener('click',function(){ethSetMode(o.dataset.m);});});
  document.getElementById('ethCancel').addEventListener('click',function(){hideEthEdit();});
  document.getElementById('ethApply').addEventListener('click',function(){
    if(!ipv4Ctx)return;
    var m=document.getElementById('ethMode').dataset.m||'auto';
    var err=document.getElementById('ethErr');
    var dns=document.getElementById('ethDns').value.split(',').map(function(s){return s.trim();}).filter(Boolean);
    var body={method:m,dns:dns};
    for(var k in ipv4Ctx.extra)body[k]=ipv4Ctx.extra[k];
    if(m==='manual'){
      var ip=document.getElementById('ethAddr').value.trim();
      var pfx=(document.getElementById('ethPrefix').value.trim()||'24');
      if(!ip){err.textContent='Enter an IP address.';err.hidden=false;return;}
      if(!/^\d{1,2}$/.test(pfx)||+pfx>32){err.textContent='Subnet prefix must be 0–32.';err.hidden=false;return;}
      body.address=ip+'/'+pfx;
      body.gateway=document.getElementById('ethGw').value.trim();
    }
    err.hidden=true; toast('Applying…');
    fetch(ipv4Ctx.postUrl,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
      .then(function(r){return r.ok?r.json():r.text().then(function(t){throw new Error((t||'').trim()||('HTTP '+r.status));});})
      .then(function(){toast('Updated');hideEthEdit();
        setTimeout(function(){fetch('api/panel',{cache:'no-store'}).then(function(r){return r.json();}).then(function(d){LAST=d;refresh(d);
          if(document.body.classList.contains('subpage-open'))showEthDetail(); else closeDetail();}).catch(function(){});},1400);})
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
function showWifiDetail(){ openPage('Wi-Fi','',wifiRender); }
function wifiRender(){
  hideWifiPass();
  var w=(LAST&&LAST.network&&LAST.network.wifi)||{},on=!!w.enabled;
  subpageScroll.innerHTML=
    '<div class="setgroup"><div class="card"><div class="setrow"><div class="lbl">Wi-Fi</div><div class="etoggle'+(on?' on':'')+'" id="wifiToggle"><div class="knob"></div></div></div></div></div>'+
    '<div class="setgroup"><div class="setlabel">Networks</div><div id="wifiList" class="wifi-list">'+(on?'<div class="wifi-empty">Scanning…</div>':'<div class="wifi-empty">Wi-Fi is off</div>')+'</div></div>';
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
  subpageScroll.innerHTML='<div class="wifi-manage"><div class="wifi-ap-name big">'+esc(ap.ssid)+'</div>'+
    '<div class="setgroup"><div class="card">'+det.replace(/drow/g,'setrow').replace(/class="k"/g,'class="lbl"').replace(/class="v"/g,'class="setval"')+'</div></div>'+
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
/* Hotspot (AP mode via t6-paneld → NetworkManager) */
function hsSetBand(m){document.querySelectorAll('#hsBand .seg-opt').forEach(function(o){o.classList.toggle('on',o.dataset.m===m);});document.getElementById('hsBand').dataset.m=m;}
function showHotspot(){
  fetch('api/network/hotspot',{cache:'no-store'}).then(function(r){return r.json();}).then(function(h){
    var active=!!h.active, ov=document.getElementById('hotspot');
    document.getElementById('hsStatus').textContent=active?('On · '+(h.ssid||'')):'Off';
    document.getElementById('hsSsid').value=h.ssid||'';
    document.getElementById('hsPass').value='';
    hsSetBand(h.band==='a'?'a':'bg');
    document.getElementById('hsToggle').textContent=active?'Stop Hotspot':'Start Hotspot';
    document.getElementById('hsSsid').disabled=active;
    document.getElementById('hsPass').disabled=active;
    document.getElementById('hsErr').hidden=true;
    ov.dataset.active=active?'1':'';
    ov.classList.add('on');
    if(!active)setTimeout(function(){document.getElementById('hsSsid').focus();},60);
  }).catch(function(){toast('Could not read hotspot status');});
}
function hideHotspot(){document.getElementById('hotspot').classList.remove('on');}
(function(){
  var ov=document.getElementById('hotspot'); if(!ov)return;
  document.querySelectorAll('#hsBand .seg-opt').forEach(function(o){o.addEventListener('click',function(){if(!document.getElementById('hsSsid').disabled)hsSetBand(o.dataset.m);});});
  document.getElementById('hsCancel').addEventListener('click',hideHotspot);
  document.getElementById('hsToggle').addEventListener('click',function(){
    var active=ov.dataset.active==='1', err=document.getElementById('hsErr'), body;
    if(active){ body={enabled:false}; toast('Stopping hotspot…'); }
    else{
      var ssid=document.getElementById('hsSsid').value.trim(), pass=document.getElementById('hsPass').value, band=document.getElementById('hsBand').dataset.m||'bg';
      if(!ssid){err.textContent='Enter a network name.';err.hidden=false;return;}
      if(pass.length<8){err.textContent='Password must be at least 8 characters.';err.hidden=false;return;}
      body={enabled:true,ssid:ssid,password:pass,band:band}; err.hidden=true; toast('Starting hotspot…');
    }
    fetch('api/network/hotspot',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
      .then(wifiChk).then(function(){toast(active?'Hotspot stopped':'Hotspot started');hideHotspot();setTimeout(poll,1500);})
      .catch(function(e){err.textContent=e.message||'Failed';err.hidden=false;});
  });
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
