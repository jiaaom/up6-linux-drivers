// Home screen: widget model + CONTENT, renderHome, firmware banner, edit-list.
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
  storage:`<div class="card" data-tile="storage">
      <div class="row-sb"><div style="font-size:32px" class="muted">Storage</div><div style="display:flex;align-items:center;gap:16px"><span style="font-size:30px" class="muted2" id="volCount">—</span><span style="font-size:34px;opacity:.4">›</span></div></div>
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
      <div class="tile off" data-tile="hotspot"><div style="width:34px;height:34px;border-radius:17px;border:4px solid oklch(1 0 0 / .28)"></div><div><div class="t">Hotspot</div><div class="s muted2 hotspot-sub">Off</div></div></div>
      <div class="tile off" data-tile="tb4"><div style="width:34px;height:34px;border-radius:9px;transform:rotate(45deg);border:4px solid oklch(1 0 0 / .28)"></div><div><div class="t">TB4</div><div class="s muted2 tb-sub">No link</div></div></div>
      <div class="tile on" data-tile="sharing"><div style="display:flex;gap:6px"><div style="width:16px;height:34px;border-radius:5px;background:var(--amber)"></div><div style="width:16px;height:34px;border-radius:5px;background:var(--amber);opacity:.55"></div></div><div><div class="t">Sharing</div><div class="s muted sharing-sub">SMB · NFS</div></div></div>
      <div class="tile on" data-tile="files"><div style="width:42px;height:32px;border:4px solid var(--amber);border-radius:8px;position:relative"><div style="position:absolute;top:-10px;left:-2px;width:20px;height:10px;border:4px solid var(--amber);border-bottom:none;border-top-left-radius:6px;border-top-right-radius:6px"></div></div><div><div class="t">Files</div><div class="s muted2 files-sub">Browse</div></div></div>
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
  var fw=document.createElement('div');fw.className='widget';fw.id='fwWidget';fw.style.display='none';
  fw.innerHTML=`<div class="fwbanner"><div class="fwdot"></div>
      <div style="flex:1"><div id="fwTitle" style="font-size:33px;font-weight:500"></div><div id="fwSub" style="font-size:31px" class="muted"></div></div>
      <div style="font-size:36px;opacity:.45">›</div></div>`;
  fw.addEventListener('click',showFirmware);
  homeScroll.appendChild(fw);
  bindTiles();
  checkFirmware();
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
  if(fwState.update_available)html+='<div class="tb-hint">Install this update from the NAS web UI under Update &amp; Restore.</div>';
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
  renderHome();
});

