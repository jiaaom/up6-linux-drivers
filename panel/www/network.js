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
  document.getElementById('ethDns').hidden=(m==='link-local');
}
// Generalized IPv4 editor (shared by Ethernet and Thunderbolt-net). The caller
// supplies where to read/write and any extra body fields (e.g. the TB conn).
var ipv4Ctx=null;
function ipv4Open(ctx){
  ipv4Ctx=ctx;
  document.getElementById('ipv4Title').textContent=ctx.title;
  fetch(ctx.getUrl,{cache:'no-store'}).then(function(r){return r.json();}).then(function(c){
    // Link-local is only offered where it makes sense (a host-to-host TB link).
    document.getElementById('ethLL').hidden=!ctx.linkLocal;
    ethSetMode(c.method==='manual'?'manual':(c.method==='link-local'&&ctx.linkLocal)?'link-local':'auto');
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
function tbNetEdit(conn){ ipv4Open({title:'Thunderbolt IPv4',getUrl:'api/thunderbolt/net?conn='+encodeURIComponent(conn),postUrl:'api/thunderbolt/net',extra:{conn:conn},linkLocal:true}); }
function hideEthEdit(){document.getElementById('ethedit').classList.remove('on');}

/* ---------- Thunderbolt page (full sub-page; design "Front Panel Thunderbolt" 8a–8e) ----------
   Peripherals need approval under the `user` security policy, so a Pending
   card is pinned to the top with both Authorize buttons in it. Computers
   (host-to-host) never need approval: they show as Linked and the network
   section below carries what matters for them — live throughput, addresses,
   MTU. The 2 s panel poll keeps the rate line and the page itself fresh. */
var TB_SEC={user:'user authorization',secure:'secure (key)',dponly:'DisplayPort only',none:'open',usb4:'USB4',nopcie:'no PCIe tunnels'};
var TB_ICON={
  dev:'<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><rect x="7" y="7" width="34" height="34" rx="4"/><circle cx="24" cy="24" r="8"/><circle cx="24" cy="24" r="1.8" fill="currentColor" stroke="none"/></svg>',
  host:'<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="11" width="30" height="21" rx="3"/><path d="M4 38h40"/></svg>',
  bolt:'<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><path d="M30 6L16 26h7l-4 16 14-20h-7l4-16z"/></svg>',
  info:'<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><circle cx="24" cy="24" r="17"/><path d="M24 22v11"/><circle cx="24" cy="16" r="1.6" fill="currentColor" stroke="none"/></svg>',
  chev:'<svg class="wchev" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 12l12 12-12 12"/></svg>'
};
var tbShape='';
function tbOnPage(){return document.body.classList.contains('subpage-open')&&document.getElementById('subTitle').textContent==='Thunderbolt';}
function showTbDetail(){
  openPage('Thunderbolt','<div class="wifi-empty">Loading…</div>',null,{back:false});
  tbReload();
}
function tbReload(){
  fetch('api/thunderbolt',{cache:'no-store'}).then(function(r){return r.json();}).then(function(tb){if(tbOnPage())renderTb(tb);})
    .catch(function(){if(tbOnPage())subpageScroll.innerHTML='<div class="wifi-empty">Could not read Thunderbolt.</div>';});
}
// What would change the page layout (as opposed to just the rate line).
function tbShapeKey(tb){
  return JSON.stringify([(tb.devices||[]).map(function(d){return [d.uuid,d.pending,d.stored,d.link];}),
    (tb.net||[]).map(function(n){return [n.iface,n.connected,n.ip,n.mtu,n.ipv4&&n.ipv4.method];})]);
}
function tbDevSub(dv){
  var kind=dv.host?'computer':(dv.generation?'TB'+dv.generation+' device':'device');
  var parts=[dv.vendor,kind];
  if(LAST&&LAST.thunderbolt&&LAST.thunderbolt.ports>1&&dv.port)parts.push('port '+dv.port);
  var s=parts.filter(Boolean).map(esc).join(' · ');
  if(dv.link)s+=' · '+(dv.link_slow?'<span class="tb-warn">'+esc(dv.link)+' — check cable</span>':esc(dv.link));
  return s;
}
function tbDevRow(dv){
  var pill=dv.host?'<div class="tb-pill linked"><i></i>Linked</div>':'<div class="tb-pill">'+(dv.stored?'Remembered':'Authorized')+'</div>';
  var act='';
  if(!dv.host)act='<div class="tb-rowact"><div class="tb-btn'+(dv.stored?' danger':'')+' tb-act" data-a="'+(dv.stored?'forget':'enroll')+'" data-u="'+esc(dv.uuid)+'" data-n="'+esc(dv.name)+'">'+(dv.stored?'Forget this device':'Remember this device')+'</div></div>';
  return '<div class="tb-row"><div class="tb-ico'+(dv.host?' host':'')+'">'+(dv.host?TB_ICON.host:TB_ICON.dev)+'</div>'+
    '<div class="tb-main"><div class="tb-name">'+esc(dv.name)+'</div><div class="tb-sub">'+tbDevSub(dv)+'</div></div>'+pill+'</div>'+act;
}
function tbPendingCard(dv){
  return '<div class="tb-pending-card">'+
    '<div class="tb-row" style="padding:0"><div class="tb-ico pend">'+TB_ICON.dev+'</div>'+
      '<div class="tb-main"><div class="tb-name big">'+esc(dv.name)+'</div><div class="tb-sub">'+tbDevSub(dv)+'</div>'+
      '<div class="tb-pillrow"><div class="tb-pill solid">Pending</div></div></div></div>'+
    '<div class="tb-explain">Blocked until you approve it. Remembering enrolls it in the trust list so it just works next time.</div>'+
    '<div class="tb-btns"><div class="tb-btn tb-act" data-a="authorize" data-u="'+esc(dv.uuid)+'" data-n="'+esc(dv.name)+'">Authorize once</div>'+
      '<div class="tb-btn solid tb-act" data-a="enroll" data-u="'+esc(dv.uuid)+'" data-n="'+esc(dv.name)+'">Authorize &amp; Remember</div></div></div>';
}
function tbNetCard(nif){
  var method=nif.ipv4&&nif.ipv4.method;
  var mlabel=method==='manual'?'Manual':method==='link-local'?'Link-local':'Automatic';
  var peer=nif.peer?('<div class="tb-v">'+esc(nif.peer.host?nif.peer.host.replace(/\.local$/,''):nif.peer.ip)+'</div>'+(nif.peer.host?'<div class="tb-v mono dim">'+esc(nif.peer.ip)+'</div>':'')):'<div class="tb-v dim">not seen yet</div>';
  return '<div class="card tb-card">'+
    '<div class="tb-hero"><div class="tb-rate" data-tbrate="'+esc(nif.iface)+'">'+tbRateHtml(null,null)+'</div><div class="tb-live">live · updates every 2 s</div></div>'+
    '<div class="tb-kv"><div class="tb-k">Interface</div><div class="tb-v mono"><i class="tb-dot'+(nif.connected?' on':'')+'"></i>'+esc(nif.iface)+'</div></div>'+
    '<div class="tb-kv"><div class="tb-k">This NAS</div><div class="tb-v mono">'+esc(nif.ip||'no address')+(nif.ip&&method==='link-local'?' <span class="tb-tag">link-local</span>':'')+'</div></div>'+
    '<div class="tb-kv" style="align-items:baseline"><div class="tb-k">Peer</div><div style="text-align:right">'+peer+'</div></div>'+
    (nif.mtu?'<div class="tb-kv"><div class="tb-k">MTU</div><div class="tb-v mono">'+nif.mtu+(nif.mtu>=9000?' <span class="tb-tag">jumbo</span>':'')+'</div></div>':'')+
    (nif.conn?'<div class="tb-kv tap tb-netcfg" data-c="'+esc(nif.conn)+'"><div class="tb-k">Configure IPv4</div><div class="tb-v">'+mlabel+'</div>'+TB_ICON.chev+'</div>':'')+
    '</div>';
}
function tbRateHtml(rx,tx){
  function one(cls,a,v){var p=v==null?['—','']:fmtRateParts(v);return '<div class="tb-r '+cls+'"><span class="arr">'+a+'</span><span class="num">'+p[0]+'</span><span class="unit">'+p[1]+'</span></div>';}
  return one('dn','↓',rx)+one('up','↑',tx);
}
function fmtRateParts(bytesPerSec){var b=Math.max(0,bytesPerSec*8);if(b>=1e9)return [(b/1e9).toFixed(b>=1e10?0:1),'Gb/s'];if(b>=1e6)return [(b/1e6).toFixed(0),'Mb/s'];if(b>=1e3)return [(b/1e3).toFixed(0),'kb/s'];return ['0','b/s'];}
function renderTb(tb){
  tbShape=tbShapeKey(tb);
  var devs=tb.devices||[],net=tb.net||[];
  var pend=devs.filter(function(d){return d.pending;}),rest=devs.filter(function(d){return !d.pending;});
  var hosts=devs.some(function(d){return d.host;});
  var subhead=[tb.controller,(tb.ports>1?tb.ports+' ports':null),TB_SEC[tb.security]||tb.security].filter(Boolean).join(' · ');
  setSubSub(esc(subhead));
  var html='';
  if(!tb.supported){html='<div class="wifi-empty">No Thunderbolt controller</div>';}
  else{
    if(pend.length){html+='<div class="tb-sec amber">Waiting for you</div>'+pend.map(tbPendingCard).join('');}
    if(rest.length){html+='<div class="tb-sec">'+(pend.length?'Also connected':'Connected')+'</div><div class="card tb-card">'+rest.map(tbDevRow).join('<div class="tb-hr"></div>')+'</div>';}
    if(!devs.length){
      html+='<div class="tb-empty"><div class="tb-emptyico">'+TB_ICON.bolt+'</div><div class="tb-emptyt">Nothing connected</div>'+
        '<div class="tb-emptys">The '+esc(tb.controller==='Thunderbolt 4'?'TB4':'Thunderbolt')+' port is live and waiting. Plug in a drive, dock or another computer.</div></div>';
      html+='<div class="tb-sec">Controller</div><div class="card tb-card">'+
        '<div class="tb-kv"><div class="tb-k">Generation</div><div class="tb-v">'+esc(tb.controller||'—')+'</div></div>'+
        '<div class="tb-kv"><div class="tb-k">Port'+(tb.ports>1?'s':'')+'</div><div class="tb-v">'+(tb.ports||1)+' · idle</div></div>'+
        '<div class="tb-kv" style="flex-wrap:wrap"><div class="tb-k">Security</div><div class="tb-v">'+esc((TB_SEC[tb.security]||tb.security||'—').replace(/^./,function(c){return c.toUpperCase();}))+'</div>'+
          (tb.security==='user'?'<div class="tb-note">New devices stay blocked until approved here. Change it over SSH.</div>':'')+'</div>'+
        '<div class="tb-kv"><div class="tb-k">Remembered devices</div><div class="tb-v">'+(tb.remembered||0)+'</div></div></div>';
    }
    if(net.length){
      html+='<div class="tb-sec">'+(net.length>1?'Thunderbolt networks <span class="dim">'+net.length+' links · not bonded</span>':'Thunderbolt network')+'</div>'+net.map(tbNetCard).join('');
    }
    if(!hosts)html+='<div class="tb-hint">'+TB_ICON.info+'<div>Connect another computer over Thunderbolt for a high-speed direct link — SMB runs over it automatically.</div></div>';
    else if(net.length>1)html+='<div class="tb-hint">'+TB_ICON.info+'<div>Each port is its own link on its own subnet. One transfer uses one link — connecting twice doesn’t double a single copy.</div></div>';
  }
  subpageScroll.innerHTML=html;
  tbPrev={}; // rate line restarts from the next two samples
  subpageScroll.querySelectorAll('.tb-act').forEach(function(b){b.addEventListener('click',function(){tbDeviceAction(b.dataset.a,b.dataset.u,b.dataset.n);});});
  subpageScroll.querySelectorAll('.tb-netcfg').forEach(function(b){b.addEventListener('click',function(){tbNetEdit(b.dataset.c);});});
}
// Called from the 2 s panel poll (live.js). Updates the rate line in place;
// re-renders when something structural changed (plug/unplug, authorization).
var tbPrev={};
function tbLive(tb){
  if(!tb||!tbOnPage())return;
  var now=Date.now();
  (tb.net||[]).forEach(function(n){
    var p=tbPrev[n.iface],el=subpageScroll.querySelector('[data-tbrate="'+n.iface+'"]');
    if(p&&el){var dt=(now-p.t)/1000;if(dt>0)el.innerHTML=tbRateHtml((n.rx_bytes-p.rx)/dt,(n.tx_bytes-p.tx)/dt);}
    tbPrev[n.iface]={t:now,rx:n.rx_bytes,tx:n.tx_bytes};
  });
  if(tbShape&&tbShapeKey(tb)!==tbShape){tbShape='';tbReload();}
}
function tbDeviceAction(action,uuid,name){
  var go=function(){
    toast(action==='forget'?'Forgetting…':'Authorizing…');
    fetch('api/thunderbolt/device',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:action,uuid:uuid})})
      .then(function(r){return r.ok?r.json():r.text().then(function(t){throw new Error((t||'').trim()||('HTTP '+r.status));});})
      .then(function(){toast(action==='forget'?'Forgotten':'Authorized');setTimeout(function(){poll();tbReload();},1000);})
      .catch(function(e){showConfirm((action==='forget'?'Couldn’t forget ':'Couldn’t authorize ')+name,e.message||'Failed',"OK",false,function(){});});
  };
  if(action==='forget')showConfirm('Forget '+name+'?','It stays connected right now. The next time it’s plugged in you’ll have to approve it again.','Forget',true,go);
  else go();
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
      .then(function(){toast('Updated');hideEthEdit();if(window.tbOnPage&&tbOnPage())setTimeout(tbReload,1500);
        setTimeout(function(){fetch('api/panel',{cache:'no-store'}).then(function(r){return r.json();}).then(function(d){LAST=d;refresh(d);
          if(document.body.classList.contains('subpage-open'))showEthDetail(); else closeDetail();}).catch(function(){});},1400);})
      .catch(function(e){err.textContent=e.message||'Failed';err.hidden=false;});
  });
})();

/* ---------- Wi-Fi config sheet (drives NetworkManager via t6-paneld) ---------- */
var wifiAps=[];
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function wifiChk(r){if(!r.ok)return r.text().then(function(t){throw new Error((t||'').trim()||('HTTP '+r.status));});return r.json().catch(function(){return {};});}
/* Wi-Fi signal glyph — the design's three-arc icon; arcs above the current
   strength dim to .25. `sig` is 0..100, `stroke` an optional CSS color. */
function wifiArcs(sig,stroke){
  sig=+sig||0; stroke=stroke||'currentColor';
  var o=[sig>=70?1:.25, sig>=40?1:.25, sig>0?1:.25];
  return '<svg class="warc" viewBox="0 0 48 48" fill="none" stroke="'+stroke+'" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round">'+
    '<path d="M6 19a25 25 0 0 1 36 0" opacity="'+o[0]+'"/>'+
    '<path d="M12.5 26.5a16 16 0 0 1 23 0" opacity="'+o[1]+'"/>'+
    '<path d="M18.5 33.5a7.5 7.5 0 0 1 11 0" opacity="'+o[2]+'"/>'+
    '<circle cx="24" cy="39.5" r="1.8" fill="'+stroke+'" stroke="none"/></svg>';
}
var WIFI_LOCK='<svg class="wlock" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><rect x="10" y="21" width="28" height="20" rx="4"/><path d="M17 21v-6a7 7 0 0 1 14 0v6"/></svg>';
var WIFI_CHEV='<svg class="wchev" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 12l12 12-12 12"/></svg>';
function wifiBand(w){return w.band||null;}
function wifiHeroSub(w){
  if(!w.enabled)return 'Off';
  if(!w.connected||!w.ssid)return 'On · not connected';
  var bits=['Connected'];if(w.band)bits.push(w.band);if(w.dbm!=null)bits.push(w.dbm+' dBm');else if(w.signal!=null)bits.push(w.signal+'%');
  return bits.join(' · ');
}
function showWifiDetail(){ openPage('Wi-Fi','',wifiRender); }
function wifiRender(){
  hideWifiPass();
  var w=(LAST&&LAST.network&&LAST.network.wifi)||{},on=!!w.enabled;
  var connected=on&&w.connected&&w.ssid;
  // The subpage header already shows the big "Wi-Fi" title + Done, so the hero
  // here is the master-switch row: live radio status on the left, toggle right.
  var hero='<div class="wifi-hero">'+
      '<div class="wifi-hero-main"><div class="wifi-hero-label">Wi-Fi</div>'+
      '<div class="wifi-hero-sub">'+esc(wifiHeroSub(w))+'</div></div>'+
      '<div class="wtoggle'+(on?' on':'')+'" id="wifiToggle"><div class="knob"></div></div></div>';
  var connCard=connected?
    '<div class="wifi-conn" id="wifiConnCard">'+
      '<div class="wifi-conn-row">'+wifiArcs(w.signal,'var(--accent-text)')+
        '<div class="wifi-conn-info"><div class="wifi-conn-name">'+esc(w.ssid)+'</div>'+
        '<div class="wifi-conn-ip">'+esc(w.ip||'—')+(w.prefix!=null?' · DHCP':'')+'</div></div>'+WIFI_CHEV+'</div>'+
      '<div class="wifi-chips">'+
        '<div class="wchip"><div class="wchip-k">Security</div><div class="wchip-v">'+esc((w.security||'Open').split(' ')[0])+'</div></div>'+
        '<div class="wchip"><div class="wchip-k">Router</div><div class="wchip-v">'+esc(w.gateway||'—')+'</div></div>'+
        '<div class="wchip"><div class="wchip-k">Channel</div><div class="wchip-v">'+(w.channel!=null?w.channel:'—')+'</div></div>'+
      '</div></div>':'';
  var body='<div class="wifi-page">'+hero+'<div class="wifi-hair"></div>'+
    (on?connCard+'<div id="wifiKnownWrap"></div><div id="wifiOtherWrap"></div>'+
        '<div class="wifi-note">Known networks are joined automatically. Wi-Fi is disabled while the hotspot is on.</div>'
       :'<div class="wifi-note" style="margin-top:24px">Wi-Fi is off. Turn it on to see available networks.</div>')+
    '</div>';
  subpageScroll.innerHTML=body;
  document.getElementById('wifiToggle').addEventListener('click',function(){
    fetch('api/network/wifi/radio',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({on:!on})})
      .then(wifiChk).then(function(){setTimeout(function(){poll();wifiRender();},900);})
      .catch(function(e){toast(e.message||'Wi-Fi toggle failed');});
  });
  var cc=document.getElementById('wifiConnCard');if(cc)cc.addEventListener('click',function(){wifiDetail(w.ssid);});
  if(on)wifiScan();
}
function wifiNetRow(ap,i){
  return '<div class="wifi-ap" data-i="'+i+'">'+wifiArcs(ap.signal)+
    '<div class="wifi-ap-name">'+esc(ap.ssid)+'</div>'+
    (ap.security?WIFI_LOCK:'')+WIFI_CHEV+'</div>';
}
function wifiSection(label,rowsHtml,spinner,extra){
  return '<div class="wifi-seclabel">'+esc(label)+(spinner?'<span class="wifi-spin"></span>':'')+'</div>'+
    '<div class="wifi-card">'+rowsHtml+(extra||'')+'</div>';
}
function wifiScan(){
  var kw=document.getElementById('wifiKnownWrap'),ow=document.getElementById('wifiOtherWrap');
  if(ow)ow.innerHTML=wifiSection('Other networks','<div class="wifi-empty">Scanning…</div>',true);
  fetch('api/network/wifi/scan?rescan=true',{cache:'no-store'}).then(wifiChk).then(function(aps){
    wifiAps=(aps||[]).slice();
    var kw=document.getElementById('wifiKnownWrap'),ow=document.getElementById('wifiOtherWrap');
    if(!ow)return;
    // Known = saved profiles (excluding the one we're already showing as connected); Other = the rest.
    var known=[],other=[];
    wifiAps.forEach(function(ap,i){ap._i=i;if(ap.in_use)return;(ap.saved?known:other).push(ap);});
    if(kw)kw.innerHTML=known.length?wifiSection('Known networks',known.map(function(ap){return wifiNetRow(ap,ap._i);}).join('')):'';
    var otherRows=other.length?other.map(function(ap){return wifiNetRow(ap,ap._i);}).join(''):'';
    var otherRow='<div class="wifi-ap wifi-other" id="wifiOther"><div class="wifi-ap-spacer"></div><div class="wifi-ap-name accent">Other…</div>'+WIFI_CHEV.replace('wchev','wchev accent')+'</div>';
    if(ow)ow.innerHTML=wifiSection('Other networks',otherRows,false,otherRow);
    subpageScroll.querySelectorAll('.wifi-ap[data-i]').forEach(function(el){el.addEventListener('click',function(){wifiTap(wifiAps[+el.dataset.i]);});});
    var oth=document.getElementById('wifiOther');if(oth)oth.addEventListener('click',wifiHidden);
  }).catch(function(e){var ow=document.getElementById('wifiOtherWrap');if(ow)ow.innerHTML=wifiSection('Other networks','<div class="wifi-empty">'+esc(e.message||'Scan failed')+'</div>',false);});
}
function wifiTap(ap){if(!ap)return;if(ap.in_use){wifiDetail(ap.ssid);return;}if(ap.saved||!ap.security){wifiDoConnect(ap.ssid,null);return;}wifiPass(ap);}
function maskFromPrefix(p){if(p==null||p<0||p>32)return null;var m=[0,0,0,0];for(var i=0;i<p;i++)m[Math.floor(i/8)]|=128>>(i%8);return m.join('.');}
function drow(k,v){return v?'<div class="drow"><div class="k">'+esc(k)+'</div><div class="v">'+esc(v)+'</div></div>':'';}
function wifiIrow(k,v,mono){return '<div class="wifi-drow"><div class="wifi-drow-k">'+esc(k)+'</div><div class="wifi-drow-v'+(mono?' mono':'')+'">'+esc(v)+'</div></div>';}
// 6c — network detail for the connected network: auto-join, IPv4, signal, forget.
function wifiDetail(ssid){
  var w=(LAST&&LAST.network&&LAST.network.wifi)||{};
  var isConn=w.ssid===ssid;
  var ipv4=isConn?(
    wifiIrow('Configure','Automatic')+
    wifiIrow('IP address',w.ip||'—',true)+
    wifiIrow('Subnet mask',maskFromPrefix(w.prefix)||'—',true)+
    wifiIrow('Router',w.gateway||'—',true)+
    wifiIrow('DNS',(w.dns||[]).join(', ')||'—',true)
  ):wifiIrow('Status','Saved network');
  var chips=isConn?('<div class="wifi-seclabel">Signal</div><div class="wifi-sigchips">'+
    '<div class="wsig"><div class="wsig-k">Strength</div><div class="wsig-v">'+(w.dbm!=null?w.dbm+' dBm':(w.signal!=null?w.signal+'%':'—'))+'</div></div>'+
    '<div class="wsig"><div class="wsig-k">Band</div><div class="wsig-v">'+esc(w.band||'—')+'</div></div>'+
    '<div class="wsig"><div class="wsig-k">Link</div><div class="wsig-v">'+esc(w.rate||'—')+'</div></div></div>'):'';
  var body='<div class="wifi-page">'+
    '<div class="wifi-card"><div class="wifi-drow"><div class="wifi-drow-k">Auto-join</div><div class="etoggle" id="wifiAuto"><div class="knob"></div></div></div></div>'+
    '<div class="wifi-seclabel">IPv4</div><div class="wifi-card">'+ipv4+'</div>'+chips+
    '<div class="wifi-forget" id="wifiForget">Forget this network</div></div>';
  openPage(ssid,body,function(){
    pageBack=function(){ showWifiDetail(); }; // "Done" returns to the Wi-Fi list, not Home
    var t=document.getElementById('wifiAuto');
    fetch('api/network/wifi/profile?ssid='+encodeURIComponent(ssid),{cache:'no-store'}).then(wifiChk).then(function(p){
      if(!t)return;
      if(p&&p.autoconnect)t.classList.add('on');
      t.addEventListener('click',function(){
        var on=!t.classList.contains('on');
        fetch('api/network/wifi/profile',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({ssid:ssid,autoconnect:on})})
          .then(wifiChk).then(function(){t.classList.toggle('on',on);}).catch(function(e){toast(e.message||'Failed');});
      });
    }).catch(function(){if(t){t.style.opacity='.4';t.title='No saved profile';}});
    document.getElementById('wifiForget').addEventListener('click',function(){
      showConfirm('Forget “'+ssid+'”?','This removes the saved network. You’ll need the password to reconnect.','Forget',true,function(){
        wifiNetAct('forget',{ssid:ssid},'Network forgotten');
      });
    });
  });
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
/* Password / hidden-network entry reuses the app's shared centered overlay +
   the global on-screen keyboard (#osk, account.js), which auto-shows when any
   text field is focused — same pattern as sign-in, Ethernet and Hotspot.
   `hidden` mode reveals an extra SSID field for joining an unlisted network. */
function wifiPass(ap){ wifiOpenPass(ap.ssid,false); }
function wifiHidden(){ wifiOpenPass('',true); }
function wifiOpenPass(ssid,hidden){
  var el=document.getElementById('wifipass');
  document.getElementById('wpTitle').textContent=hidden?'Other network':'Enter password';
  document.getElementById('wpSub').textContent=hidden?'Join a network that isn’t listed':ssid;
  var ssidInp=document.getElementById('wpSsid'),inp=document.getElementById('wpInput');
  ssidInp.hidden=!hidden;ssidInp.value=hidden?'':ssid;
  inp.value='';document.getElementById('wpErr').hidden=true;
  el.dataset.hidden=hidden?'1':'';el.classList.add('on');
  setTimeout(function(){(hidden?ssidInp:inp).focus();},60);
}
function hideWifiPass(){var w=document.getElementById('wifipass');if(w)w.classList.remove('on');}
(function(){
  var el=document.getElementById('wifipass');if(!el)return;
  var submit=document.getElementById('wpSubmit'),cancel=document.getElementById('wpCancel');
  var ssidInp=document.getElementById('wpSsid'),inp=document.getElementById('wpInput');
  function go(){
    var hidden=el.dataset.hidden==='1';
    var ssid=hidden?ssidInp.value.trim():document.getElementById('wpSub').textContent;
    if(hidden&&!ssid){var e=document.getElementById('wpErr');e.textContent='Enter a network name.';e.hidden=false;ssidInp.focus();return;}
    var pw=inp.value;
    wifiDoConnect(ssid,pw,function(m){var e=document.getElementById('wpErr');e.textContent=m;e.hidden=false;});
  }
  submit.addEventListener('click',go);
  inp.addEventListener('keydown',function(e){if(e.key==='Enter')go();});
  ssidInp.addEventListener('keydown',function(e){if(e.key==='Enter')inp.focus();});
  cancel.addEventListener('click',function(){hideWifiPass();inp.blur();ssidInp.blur();});
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
if(!restoreHomeFromCache())renderHome(); // cached layout + storage figures first; the poll refines
poll();setInterval(poll,2000);
refreshFnos(); // pick up an existing Electron/fnOS session for the account chip
