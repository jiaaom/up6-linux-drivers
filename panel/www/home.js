// Home screen: widget model + CONTENT, renderHome, firmware banner, edit-list.
/* ---------- model ---------- */
var META={
  storage:{title:'Storage',desc:'Collapse after 2 volumes'},
  system:{title:'System',desc:'CPU · GPU · memory · 3 fans'},
  conn:{title:'Connectivity',desc:'6 tiles · choose which'},
  filemgr:{title:'File Manager',desc:'Personal · Team · Trash · Favorites'},
  notif:{title:'Notifications',desc:'System alerts & activity'},
  net:{title:'Network traffic',desc:'Live throughput graph'},
};
var order=['storage','system','conn','filemgr','notif','net'];
var visible={storage:1,system:1,conn:1,filemgr:1,notif:1,net:1};

var CONTENT={
  storage:`<div class="card" data-tile="storage">
      <div class="row-sb"><div style="font-size:16px" class="muted">Storage</div><div style="display:flex;align-items:center;gap:8px"><span style="font-size:15px" class="muted2" id="volCount">—</span><span style="font-size:17px;opacity:.4">›</span></div></div>
      <div class="vols" style="margin-top:13px"></div></div>`,
  system:`<div class="card tap" data-tile="system">
      <div style="display:flex;justify-content:space-between">
        <div><div style="font-size:16px" class="muted">CPU</div><div class="tname"><span class="f-cpu">44</span>°</div></div>
        <div><div style="font-size:16px" class="muted">GPU</div><div class="tname"><span class="f-gpu">41</span>°</div></div>
        <div><div style="font-size:16px" class="muted">Memory</div><div class="tname"><span class="f-mem">61</span>%</div></div>
        <div><div style="font-size:16px" class="muted">Drives</div><div class="tname"><span class="f-drives">38</span>°</div></div></div>
      <div style="display:flex;align-items:center;gap:13px;margin-top:13px;padding-top:12px;border-top:0.5px solid var(--hair)">
        <div style="font-size:16px;flex:none" class="muted">Fans</div>
        <div class="fanlist" style="display:flex;gap:8px;flex:1">
          <div style="flex:1;background:var(--fill-1);border-radius:9px;padding:7px 9px"><div style="font-size:15px" class="muted2">CPU</div><div style="font-size:18px;font-weight:500">1180</div></div>
          <div style="flex:1;background:var(--fill-1);border-radius:9px;padding:7px 9px"><div style="font-size:15px" class="muted2">SSD 1-2</div><div style="font-size:18px;font-weight:500">1240</div></div>
          <div style="flex:1;background:var(--fill-1);border-radius:9px;padding:7px 9px"><div style="font-size:15px" class="muted2">SSD 3-6</div><div style="font-size:18px;font-weight:500">980</div></div>
        </div></div></div>`,
  /* Each tile owns an identity hue (data-aux); .tico picks it up through
     currentColor when the tile is on, and greys out when it is off. Hues run
     blue -> teal -> violet -> rose -> apricot; Settings never lights up so it
     stays hueless. */
  conn:`<div class="grid">
      <div class="tile on" data-tile="eth" data-aux="blue"><div class="tico" style="width:22px;height:15px;border:2px solid currentColor;border-radius:4px"></div><div><div class="t">Ethernet</div><div class="s muted eth-sub">—</div></div></div>
      <div class="tile on" data-tile="wifi" data-aux="teal"><div class="tico" style="display:flex;align-items:flex-end;gap:3px;height:17px"><div style="width:4px;height:6px;border-radius:2px;background:currentColor"></div><div style="width:4px;height:10px;border-radius:2px;background:currentColor"></div><div style="width:4px;height:13.5px;border-radius:2px;background:currentColor"></div><div style="width:4px;height:17px;border-radius:2px;background:currentColor;opacity:.35"></div></div><div><div class="t">Wi-Fi</div><div class="s muted wifi-sub">—</div></div></div>
      <div class="tile off" data-tile="hotspot" data-aux="rose"><div class="tico" style="width:17px;height:17px;border-radius:8.5px;border:2px solid currentColor"></div><div><div class="t">Hotspot</div><div class="s muted2 hotspot-sub">Off</div></div></div>
      <div class="tile off" data-tile="tb4" data-aux="apricot"><div class="tico" style="width:17px;height:17px;border-radius:4.5px;transform:rotate(45deg);border:2px solid currentColor"></div><div><div class="t">TB4</div><div class="s muted2 tb-sub">No link</div></div></div>
      <div class="tile on" data-tile="sharing" data-aux="violet"><div class="tico" style="display:flex;gap:3px"><div style="width:8px;height:17px;border-radius:2.5px;background:currentColor"></div><div style="width:8px;height:17px;border-radius:2.5px;background:currentColor;opacity:.55"></div></div><div><div class="t">Sharing</div><div class="s muted sharing-sub">SMB · NFS</div></div></div>
      <div class="tile off"><div class="tico" style="width:17px;height:17px;border-radius:8.5px;border:2px solid currentColor"></div><div><div class="t">Settings</div><div class="s muted2">Screen · SSH</div></div></div></div>`,
  filemgr:`<div class="card fm-homecard">
      <div class="fm-hc-head" data-tile="filemgr-all">
        <div class="fm-hc-title"><svg width="19" height="19" viewBox="0 0 48 48" fill="none" stroke="var(--accent-text)" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 16v20a3 3 0 0 0 3 3h30a3 3 0 0 0 3-3V19a3 3 0 0 0-3-3H24l-4-5H9a3 3 0 0 0-3 3z"/></svg><span>Files</span></div>
        <div class="fm-hc-all">All shortcuts ›</div>
      </div>
      <div class="fm-hc-grid">
        <div class="fm-hc-tile" data-tile="filemgr-personal" data-aux="apricot"><svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M6 16v20a3 3 0 0 0 3 3h30a3 3 0 0 0 3-3V19a3 3 0 0 0-3-3H24l-4-5H9a3 3 0 0 0-3 3z"/><circle cx="24" cy="25" r="4"/><path d="M17 35a7 7 0 0 1 14 0"/></svg><div class="fm-hc-l">Personal</div></div>
        <div class="fm-hc-tile" data-tile="filemgr-team" data-aux="blue"><svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M6 16v20a3 3 0 0 0 3 3h30a3 3 0 0 0 3-3V19a3 3 0 0 0-3-3H24l-4-5H9a3 3 0 0 0-3 3z"/><circle cx="19" cy="25" r="3.5"/><circle cx="30" cy="25" r="3.5"/><path d="M13 35a6 6 0 0 1 12 0M25 35a6 6 0 0 1 11-1"/></svg><div class="fm-hc-l">Team</div></div>
        <div class="fm-hc-tile" data-tile="filemgr-trash" data-aux="rose"><svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M9 15h30"/><path d="M19 15v-4h10v4"/><path d="M13 15l2.5 24a3 3 0 0 0 3 2.7h11a3 3 0 0 0 3-2.7L35 15"/><path d="M21 23v11M27 23v11"/></svg><div class="fm-hc-l">Trash</div></div>
        <div class="fm-hc-tile" data-tile="filemgr-fav" data-aux="teal"><svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M24 7l5.3 10.8 11.9 1.7-8.6 8.4 2 11.9L24 34.2l-10.6 5.6 2-11.9-8.6-8.4 11.9-1.7L24 7z"/></svg><div class="fm-hc-l">Favorites</div></div>
      </div></div>`,
  notif:`<div class="card" data-tile="notif">
      <div class="row-sb">
        <div style="display:flex;align-items:center;gap:9px">
          <svg width="17" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--accent-text)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
          <div style="font-size:16px" class="muted">Notifications</div>
        </div>
        <div style="display:flex;align-items:center;gap:9px"><span class="notif-badge" style="display:none"></span><span style="font-size:17px;opacity:.4">›</span></div>
      </div>
      <div class="notif-preview" style="margin-top:13px"><div class="notif-empty muted2" style="font-size:15px">Loading…</div></div></div>`,
  net:`<div class="card"><div class="row-sb"><div style="font-size:16px" class="muted">Network traffic</div><div style="font-size:15px" class="muted2">last 60 s</div></div>
      <div class="netbars" style="display:flex;align-items:flex-end;gap:3.5px;height:75px;margin-top:12px"></div>
      <div class="row-sb" style="margin-top:10px"><span style="font-size:15.5px" class="muted net-dn">↓ —</span><span style="font-size:15.5px" class="muted net-up">↑ —</span></div></div>`,
};

var homeScroll=document.getElementById('homeScroll');
function renderHome(){
  homeScroll.innerHTML='';
  order.forEach(function(id){
    if(!visible[id])return;
    var el=document.createElement('div');el.className='widget';el.dataset.id=id;el.innerHTML=CONTENT[id];
    homeScroll.appendChild(el);
  });
  var fw=document.createElement('div');fw.className='widget';fw.id='fwWidget';fw.style.display='none';
  fw.innerHTML=`<div class="fwbanner"><div class="fwdot"></div>
      <div style="flex:1"><div id="fwTitle" style="font-size:16.5px;font-weight:500"></div><div id="fwSub" style="font-size:15.5px" class="muted"></div></div>
      <div style="font-size:18px;opacity:.45">›</div></div>`;
  fw.addEventListener('click',showFirmware);
  homeScroll.appendChild(fw);
  bindTiles();
  checkFirmware();
  if(window.paintHomeCached)paintHomeCached(); // storage card from live/cached data, not an empty shell until the next poll
}

// Firmware update check (show-only, no install). The backend serves the public
// FygoOS update manifest from a throttled disk cache, so the card renders
// instantly and rarely touches the network. The card always shows: an amber
// "update available" call-to-action, or the installed version when up to date /
// unreachable. Tapping shows the cached release notes (never re-fetched here).
var fwState=null;
function applyFw(){
  var w=document.getElementById('fwWidget');if(!w||!fwState)return;
  var b=w.querySelector('.fwbanner');
  var t=document.getElementById('fwTitle'),s=document.getElementById('fwSub');
  if(fwState.update_available){
    b.classList.add('fw-update');
    t.textContent='FygoOS '+(fwState.available||'')+' available';
    s.textContent='Tap to review';
  }else{
    b.classList.remove('fw-update');
    t.textContent='Firmware '+(fwState.current||'—');
    s.textContent=fwState.available?'Up to date · Tap for release notes':'Tap for details';
  }
  w.style.display='';
}
function checkFirmware(force){
  // The backend already caches/throttles, so we just cache the response per
  // session (keyed on having a current version) and render from it.
  if(fwState&&!force){applyFw();return;}
  fetch('api/firmware',{cache:'no-store'}).then(function(r){return r.json();})
    .then(function(d){if(d&&d.current){fwState=d;applyFw();}}).catch(function(){});
}
function showFirmware(){
  if(!fwState||!fwState.current)return;
  document.getElementById('detailTitle').textContent='Firmware';
  var html='';
  if(fwState.update_available)html+=drow('Available',fwState.available);
  html+=drow('Installed',fwState.current);
  if(fwState.notes){
    html+='<div class="tb-head">'+(fwState.update_available?'What’s new':'Release notes')+'</div><div class="fwnotes">';
    fwState.notes.split(/\n/).forEach(function(line){
      line=line.trim();if(!line)return;
      var m=line.match(/^\[(.+)\]$/);
      html+=m?'<div class="fwnote-sec">'+esc(m[1])+'</div>':'<div class="fwnote-line">'+esc(line)+'</div>';
    });
    html+='</div>';
  }else{
    html+='<div class="tb-hint">Release notes aren’t available yet — they’ll appear after the next successful update check.</div>';
  }
  document.getElementById('detailBody').innerHTML=html;
  document.getElementById('scrim').classList.add('show');
  document.getElementById('detail').classList.add('show');
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
  if(window.homeCacheSave)homeCacheSave({dashboard:{order:order.slice(),hidden:hidden.slice()}});
  renderHome();
});

