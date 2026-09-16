// Storage/Volumes detail page and the read-only fnOS file browser.
/* ---------- Ethernet / Wi-Fi info detail sheet (read-only; config in Web UI) ---------- */
function showDetail(title,rows){
  document.getElementById('detailTitle').textContent=title;
  document.getElementById('detailBody').innerHTML=rows.map(function(r){
    return '<div class="drow"><div class="k">'+r[0]+'</div><div class="v">'+(r[1]||'—')+'</div></div>';}).join('');
  document.getElementById('scrim').classList.add('show');
  document.getElementById('detail').classList.add('show');
}
function closeDetail(){hideWifiPass();hideEthEdit();document.getElementById('detail').classList.remove('show');document.getElementById('scrim').classList.remove('show');}
/* ---------- Files browser (read-only, native via fnOS file.ls) ---------- */
var filesPath=null; // null = root (volume picker)
function fmtDate(s){if(!s)return '';var d=new Date(s*1000);return d.toLocaleDateString(undefined,{year:'numeric',month:'short',day:'numeric'});}
function filesJoin(p,n){return p.replace(/\/+$/,'')+'/'+n;}
function filesBase(p){var s=String(p||'').replace(/\/+$/,'').split('/');return s[s.length-1]||'';}
function isVolRoot(p){return /^\/vol\d+$/.test(String(p||''));}
function filesParent(p){if(isVolRoot(p))return null;var s=p.replace(/\/+$/,'').split('/');s.pop();var up=s.join('/');return up||null;}
function showFiles(){
  if(!fnosUser){toast('Sign in to browse files');showLogin();return;}
  filesPath=null; openPage('Files','',filesRender);
}
function fileIcon(dir){return dir
  ? '<span class="fico dir"></span>'
  : '<span class="fico"></span>';}
function fileRow(name,path,dir,meta){
  var sub=dir?'':(meta&&meta.size!=null?fmtB(meta.size):(meta&&meta.mtim?fmtDate(meta.mtim):''));
  return '<div class="filerow" data-path="'+esc(path)+'" data-dir="'+(dir?1:0)+'">'+fileIcon(dir)+
    '<div class="finfo"><div class="fname">'+esc(name)+'</div>'+(sub?'<div class="fmeta">'+esc(sub)+'</div>':'')+'</div>'+
    (dir?'<span class="chev">›</span>':'')+'</div>';
}
function bindFileRows(){
  subpageScroll.querySelectorAll('.filerow').forEach(function(el){
    el.addEventListener('click',function(){
      if(el.dataset.dir==='1'){filesPath=el.dataset.path;filesRender();}
      // files are read-only for now (no preview yet)
    });
  });
  var up=subpageScroll.querySelector('.fc-up');
  if(up)up.addEventListener('click',function(){filesPath=isVolRoot(filesPath)?null:filesParent(filesPath);filesRender();});
}
function filesRender(){
  if(filesPath===null){
    var vols=(LAST&&LAST.storage)||[];
    document.getElementById('subTitle').textContent='Files';
    subpageScroll.innerHTML='<div class="setgroup"><div class="setlabel">Volumes</div><div class="filelist">'+
      (vols.length?vols.map(function(v){return fileRow(v.name,v.mount,true,null);}).join(''):'<div class="wifi-empty">No volumes</div>')+
      '</div></div>';
    bindFileRows(); return;
  }
  subpageScroll.innerHTML='<div class="wifi-empty">Loading…</div>';
  var reqPath=filesPath;
  fetch('api/fnos/files?path='+encodeURIComponent(reqPath),{cache:'no-store'}).then(function(r){return r.json();}).then(function(d){
    if(filesPath!==reqPath)return; // user navigated away
    if(d.error){subpageScroll.innerHTML='<div class="filecrumb"><span class="fc-up">‹ Back</span></div><div class="wifi-empty">'+esc(d.error)+'</div>';bindFileRows();return;}
    var files=(d.files||(d.data&&d.data.files)||[]).slice();
    files.sort(function(a,b){return (b.dir?1:0)-(a.dir?1:0)|| String(a.name).localeCompare(String(b.name));});
    document.getElementById('subTitle').textContent=filesBase(filesPath)||'Files';
    var upLabel=isVolRoot(filesPath)?'Volumes':(filesBase(filesParent(filesPath))||'Volumes');
    var crumb='<div class="filecrumb"><span class="fc-up">‹ '+esc(upLabel)+'</span><span class="fc-path">'+esc(filesPath)+'</span></div>';
    var list=files.length?files.map(function(f){return fileRow(f.name,filesJoin(filesPath,f.name),!!f.dir,f);}).join(''):'<div class="wifi-empty">Empty folder</div>';
    subpageScroll.innerHTML=crumb+'<div class="filelist">'+list+'</div>';
    bindFileRows();
  }).catch(function(){if(filesPath===reqPath){subpageScroll.innerHTML='<div class="wifi-empty">Could not list folder.</div>';}});
}

/* ---------- Volumes / disks detail page (local lsblk + statvfs, read-only) ---------- */
function showVolumes(){
  openPage('Storage','<div class="wifi-empty">Loading…</div>',function(){
    fetch('api/storage',{cache:'no-store'}).then(function(r){return r.json();}).then(renderVolumes)
      .catch(function(){subpageScroll.innerHTML='<div class="wifi-empty">Could not read storage.</div>';});
  });
}
function renderVolumes(d){
  var vols=d.volumes||[],disks=d.disks||[],html='';
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
    html+='<div class="card" style="margin-bottom:22px">'+
      '<div class="setrow"><div class="lbl">'+esc(dk.model)+'<div class="edesc">/dev/'+esc(dk.name)+(dk.serial?(' · SN '+esc(dk.serial)):'')+'</div></div><div class="setval">'+fmtB(dk.size_bytes)+'</div></div>'+
      '<div class="dtags">'+tags.map(function(t){return '<span class="dtag">'+esc(t)+'</span>';}).join('')+'</div>'+
      ((dk.parts&&dk.parts.length)?dk.parts.map(function(p){
        return '<div class="hairrow"></div><div class="setrow"><div class="lbl" style="font-size:31px">'+esc(p.name)+(p.label?(' · '+esc(p.label)):'')+
          '<div class="edesc">'+(p.fstype?esc(p.fstype):'—')+(p.mount?(' · '+esc(p.mount)):' · not mounted')+'</div></div>'+
          '<div class="setval" style="font-size:31px">'+fmtB(p.size_bytes)+'</div></div>';
      }).join(''):'')+'</div>';
  });}
  html+='</div><div class="tb-hint">Read-only overview from the panel. Manage volumes from the NAS web UI.</div>';
  subpageScroll.innerHTML=html;
}
