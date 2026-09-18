// Storage/Volumes detail page + the shared read-only bottom-sheet ("detail").
// The fnOS file browser, search and preview now live in files.js.
/* ---------- Ethernet / Wi-Fi info detail sheet (read-only; config in Web UI) ---------- */
function showDetail(title,rows){
  document.getElementById('detailTitle').textContent=title;
  document.getElementById('detailBody').innerHTML=rows.map(function(r){
    return '<div class="drow"><div class="k">'+r[0]+'</div><div class="v">'+(r[1]||'—')+'</div></div>';}).join('');
  document.getElementById('scrim').classList.add('show');
  document.getElementById('detail').classList.add('show');
}
function closeDetail(){hideWifiPass();hideEthEdit();document.getElementById('detail').classList.remove('show');document.getElementById('scrim').classList.remove('show');}

/* ---------- Volumes / disks detail page (local lsblk + statvfs, read-only) ---------- */
// The page paints the last snapshot (localStorage) immediately and refreshes
// from api/storage behind it — lsblk can take >1 s cold, which otherwise shows
// as a "Loading…" flash every time. The DOM is only rewritten if something
// actually changed.
var STORAGE_CACHE_KEY='t6.storage.cache';
function showVolumes(){
  var cached=null;try{cached=JSON.parse(localStorage.getItem(STORAGE_CACHE_KEY)||'null');}catch(e){}
  openPage('Storage',cached?'':'<div class="wifi-empty">Loading…</div>',function(){
    if(cached)renderVolumes(cached);
    var onPage=function(){return document.getElementById('subTitle').textContent==='Storage';};
    fetch('api/storage',{cache:'no-store'}).then(function(r){return r.json();}).then(function(d){
      var s=JSON.stringify(d);
      try{localStorage.setItem(STORAGE_CACHE_KEY,s);}catch(e){}
      if(onPage()&&s!==JSON.stringify(cached))renderVolumes(d);
    }).catch(function(){if(!cached&&onPage())subpageScroll.innerHTML='<div class="wifi-empty">Could not read storage.</div>';});
  });
}
function renderVolumes(d){
  var vols=d.volumes||[],html='';
  var disks=(d.disks||[]).filter(function(dk){return dk.size_bytes>0||(dk.parts&&dk.parts.length);}); // empty card-reader slots show as 0 B disks
  html+='<div class="setgroup"><div class="setlabel">Volumes</div><div class="card">'+
    (vols.length?vols.map(function(v,i){var pct=v.total_bytes?Math.round(v.used_bytes/v.total_bytes*100):0;
      return (i?'<div class="hairrow"></div>':'')+
        '<div class="setrow"><div class="lbl">'+esc(v.name)+'<div class="edesc">'+esc(v.mount)+'</div></div>'+
        '<div class="setval">'+fmtB(v.used_bytes)+' / '+fmtB(v.total_bytes)+'<div class="edesc" style="text-align:right">'+pct+'% used</div></div></div>';
    }).join(''):'<div class="setrow"><div class="lbl muted">No data volumes</div></div>')+'</div></div>';
  html+='<div class="setgroup"><div class="setlabel">Disks</div>';
  if(!disks.length){html+='<div class="card"><div class="setrow"><div class="lbl muted">No disks detected</div></div></div>';}
  else{disks.forEach(function(dk){
    var tags=[String(dk.bus||'').toUpperCase(),dk.ssd?'SSD':'HDD'];if(dk.removable)tags.push('Removable');
    html+='<div class="card" style="margin-bottom:11px">'+
      '<div class="setrow"><div class="lbl">'+esc(dk.model)+'<div class="edesc">/dev/'+esc(dk.name)+(dk.serial?(' · SN '+esc(dk.serial)):'')+'</div></div><div class="setval">'+fmtB(dk.size_bytes)+'</div></div>'+
      '<div class="dtags">'+tags.map(function(t){return '<span class="dtag">'+esc(t)+'</span>';}).join('')+'</div>'+
      ((dk.parts&&dk.parts.length)?dk.parts.map(function(p){
        // Pool/array members aren't mounted themselves; the backend resolves
        // where their data lives (p.mount) and through what (p.via).
        var member=p.fstype==='zfs_member'||p.fstype==='linux_raid_member'||p.fstype==='LVM2_member';
        var fs=p.fstype==='zfs_member'?'ZFS member':p.fstype==='linux_raid_member'?'RAID member':p.fstype==='LVM2_member'?'LVM member':(p.fstype?esc(p.fstype):'—');
        var where=p.mount?(' · '+esc(p.mount)+(p.via?' via '+esc(p.via):'')):(member?' · not in use':' · not mounted');
        return '<div class="hairrow"></div><div class="setrow"><div class="lbl" style="font-size:15.5px">'+esc(p.name)+(p.label&&p.fstype!=='zfs_member'?(' · '+esc(p.label)):'')+
          '<div class="edesc">'+fs+where+'</div></div>'+
          '<div class="setval" style="font-size:15.5px">'+fmtB(p.size_bytes)+'</div></div>';
      }).join(''):'')+'</div>';
  });}
  subpageScroll.innerHTML=html;
}
