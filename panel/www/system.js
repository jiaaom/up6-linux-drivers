// System subpage — the read-only resource monitor behind the home CPU · GPU ·
// Memory · Drives card. Design: "Front Panel System.dc.html" (turn 7: 7a top,
// 7b scrolled + throttling, 7c bottom, 7d cold-open / non-ZFS).
// 100% local (GET /api/sysmon — /proc + sysfs via t6-hw-rs::sysmon), so it
// works with no fnOS sign-in. Polls every 2 s while open; rates/busy% are
// deltas between polls, so the first paint shows "—" until the second sample.
var SYS_TIMER=null, SYS_LAST=null, SYS_SYSDISK=null;

function sysPct(v,dec){return v==null?'—':(dec===0?Math.round(v):(Math.round(v*10)/10))+'%';}
function sysRate(bps){if(bps==null)return '—';if(bps>=1e9)return (bps/1e9).toFixed(1)+' GB/s';if(bps>=1e6)return (bps/1e6).toFixed(1)+' MB/s';if(bps>=1e3)return (bps/1e3).toFixed(0)+' KB/s';return Math.round(bps)+' B/s';}
function sysGB(b){return b==null?'—':(b/1073741824).toFixed(1)+' GB';}
function sysGB1(b){return b==null?'—':(b/1073741824).toFixed(1);}
function sysTB(b){return b>=1e12?(b/1e12).toFixed(1)+' TB':(b/1e9).toFixed(1)+' GB';}
function sysUp(s){if(s==null)return '—';var d=Math.floor(s/86400),h=Math.floor(s%86400/3600),m=Math.floor(s%3600/60);return d?d+'d '+h+'h':h?h+'h '+m+'m':m+'m';}
function sysCpuName(m){return String(m||'').replace(/\(R\)|\(TM\)|\(tm\)|\bCPU\b|\bProcessor\b/g,'').replace(/\s+/g,' ').trim()||'—';}
function sysGpuName(n){return String(n||'').replace(/^Intel Corporation /,'').replace(/\s*\(rev.*\)$/,'').trim();}
var SYS_THROTTLE={pl1:'power limit (pl1)',pl2:'power limit (pl2)',pl4:'power limit (pl4)',prochot:'PROCHOT',thermal:'thermal',ratl:'ratl',vr_tdc:'VR current',vr_thermalert:'VR thermal'};

function sysSec(label,right){return '<div class="sys-sec">'+label+(right?'<span class="sys-secr">'+right+'</span>':'')+'</div>';}
function sysKV(k,v,mono){return '<div class="sys-kv"><div class="sys-k">'+k+'</div><div class="sys-v'+(mono?' mono':'')+'">'+v+'</div></div>';}
function sysHair(){return '<div class="sys-hair"></div>';}
var SYS_SPIN='<span class="sys-spin"></span>';

function showSystem(){
  SYS_LAST=null;
  var host=(LAST&&LAST.host&&LAST.host.name)||'';
  openPage('System','<div id="sysRoot"></div>',function(){
    sysSetSub(false);
    // which disk holds "/" (design tags it "· system")
    fetch('api/storage',{cache:'no-store'}).then(function(r){return r.json();}).then(function(d){
      var sd=(d.disks||[]).filter(function(k){return (k.parts||[]).some(function(p){return p.mount==='/';});})[0];
      SYS_SYSDISK=sd?sd.name:null; if(SYS_LAST)sysRender(SYS_LAST);
    }).catch(function(){});
    sysPoll();
    if(SYS_TIMER)clearInterval(SYS_TIMER);
    SYS_TIMER=setInterval(function(){
      if(!document.body.classList.contains('subpage-open')||!document.getElementById('sysRoot')){clearInterval(SYS_TIMER);SYS_TIMER=null;return;}
      sysPoll();
    },2000);
  },{sub:'',back:true});
}
// Header subtitle: "MeteorLake · live, updates every 2s", or the cold-open
// spinner "Sampling…" until rates exist (design 7d).
function sysSetSub(live){
  var host=(LAST&&LAST.host&&LAST.host.name)||'';
  setSubSub(live?(host?esc(host)+' · ':'')+'live, updates every 2s':SYS_SPIN+'Sampling…');
}
function sysPoll(){
  fetch('api/sysmon',{cache:'no-store'}).then(function(r){return r.json();}).then(function(d){
    if(!document.body.classList.contains('subpage-open')||!document.getElementById('sysRoot'))return;
    SYS_LAST=d; sysRender(d);
    sysSetSub(!!(d.cpu&&d.cpu.busy));
  }).catch(function(){ if(!SYS_LAST){var r=document.getElementById('sysRoot');if(r)r.innerHTML='<div class="wifi-empty">Could not read system stats.</div>';} });
}

function sysRender(d){
  var c=d.cpu||{},m=d.mem||{},g=d.gpu,n=d.npu,fans=d.fans||[],disks=d.disks||[],p=d.procs||{};
  var busy=c.busy||null, cold=!busy;
  var host=(LAST&&LAST.host&&LAST.host.name)||'—';
  var html='';

  /* ---- Overview ---- */
  html+=sysSec('Overview')+'<div class="sys-card list">'+
    sysKV('Hostname',esc(host),true)+sysHair()+
    sysKV('Uptime',sysUp(d.uptime_s))+sysHair()+
    '<div class="sys-kv"><div class="sys-k" style="flex:none">Processor</div><div class="sys-v" style="flex:1;text-align:right;font-weight:400">'+esc(sysCpuName(c.model))+'</div></div>'+sysHair()+
    sysKV('Threads',c.threads||'—')+sysHair()+
    sysKV('Clock',(c.freq_mhz?(c.freq_mhz/1000).toFixed(2)+' GHz':'—')+(c.max_freq_mhz?' <span class="dim">· '+(c.max_freq_mhz/1000).toFixed(1)+' max</span>':''))+
    '</div>';

  /* ---- CPU ---- */
  var u=busy?busy.user:0, s=busy?busy.system:0, io=busy?busy.iowait:0;
  html+=sysSec('CPU')+'<div class="sys-card">'+
    '<div class="sys-head"><div class="sys-k">Usage</div><div class="sys-big'+(cold?' cold':'')+'">'+(cold?'—':(Math.round(busy.total*10)/10)+'<small>%</small>')+'</div></div>'+
    '<div class="sys-bar'+(cold?' empty':'')+'"><i class="c-user" style="width:'+u+'%"></i><i class="c-sys" style="width:'+s+'%"></i><i class="c-io" style="width:'+io+'%"></i></div>'+
    '<div class="sys-sub'+(cold?' cold':'')+'">user '+sysPct(busy&&busy.user)+' · system '+sysPct(busy&&busy.system)+' · <span class="c-io-t">I/O wait '+sysPct(busy&&busy.iowait)+'</span></div>'+
    sysHair()+
    '<div class="sys-chips"><div class="sys-chip wide"><div class="sys-chipk">Load average</div><div class="sys-chipv mono">'+((c.load||[]).map(function(x){return x.toFixed(2);}).join(' · ')||'—')+'</div></div>'+
    '<div class="sys-chip"><div class="sys-chipk">Temperature</div><div class="sys-chipv">'+(c.temp_c!=null?Math.round(c.temp_c)+'°':'—')+'</div></div></div>'+
    '</div>';

  /* ---- Memory (stacked; ZFS segment only when ZFS is loaded) ---- */
  var hasZfs=m.zfs_arc!=null, T=m.total||1, apps=m.apps||0, arc=hasZfs?m.zfs_arc:0, cache=m.cached||0, free=Math.max(0,T-apps-arc-cache);
  var legend=[['m-apps','Apps',apps]]; if(hasZfs)legend.push(['m-arc','ZFS cache',arc]); legend.push(['m-cache','File cache',cache],['m-free','Free',free]);
  html+=sysSec('Memory')+'<div class="sys-card">'+
    '<div class="sys-head"><div class="sys-k">In use</div><div class="sys-mid">'+sysGB1(m.used)+' <span class="dim">/ '+sysGB(m.total)+'</span></div></div>'+
    '<div class="sys-stack"><i class="m-apps" style="width:'+(apps/T*100)+'%"></i>'+(hasZfs?'<i class="m-arc" style="width:'+(arc/T*100)+'%"></i>':'')+'<i class="m-cache" style="width:'+(cache/T*100)+'%"></i><i class="m-free"></i></div>'+
    '<div class="sys-legend">'+legend.map(function(l){return '<div class="sys-leg"><b class="'+l[0]+'"></b><span class="sys-legk">'+l[1]+'</span><span class="sys-legv">'+sysGB(l[2])+'</span></div>';}).join('')+'</div>'+
    '<div class="sys-note">'+sysGB(m.available)+' available to apps'+(hasZfs?' — caches give way on demand':'')+' · '+(m.swap_total?'swap '+sysGB1(m.swap_used)+' / '+sysGB(m.swap_total):'no swap')+'</div>'+
    '</div>';

  /* ---- Graphics & AI ---- */
  if(g||n){
    html+=sysSec('Graphics &amp; AI')+'<div class="sys-card">';
    if(g){
      var gb=g.busy;
      html+='<div class="sys-head"><div class="sys-name ell">'+esc(sysGpuName(g.name)||'GPU')+'</div><div class="sys-big'+(gb==null?' cold':'')+'">'+(gb==null?'—':(Math.round(gb*10)/10)+'<small>%</small>')+'</div></div>'+
        '<div class="sys-bar'+(gb==null?' empty':'')+'"><i class="c-user" style="width:'+(gb||0)+'%"></i></div>'+
        '<div class="sys-sub">'+(g.freq_mhz!=null?g.freq_mhz+' / '+(g.max_freq_mhz||'—')+' MHz':'')+(g.temp_c!=null?' · '+Math.round(g.temp_c)+'°':'')+(g.engines&&g.engines.video>0.5?' · video '+sysPct(g.engines.video):'')+'</div>';
      if(g.throttle&&g.throttle.length){
        html+='<div class="sys-throttle"><svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round"><path d="M24 10v18"/><circle cx="24" cy="37" r="1.8" fill="currentColor" stroke="none"/></svg><div>Throttling — '+esc(g.throttle.map(function(t){return SYS_THROTTLE[t]||t;}).join(', '))+'</div></div>';
      }
    }
    if(g&&n)html+=sysHair();
    if(n){
      var idle=n.power_state==='D3hot'&&!n.busy;
      html+='<div class="sys-kv"><div style="flex:1;min-width:0"><div class="sys-name">'+esc(n.name||'NPU')+'</div><div class="sys-sub" style="margin-top:2px">NPU · '+(n.freq_mhz!=null?n.freq_mhz+' / '+n.max_freq_mhz+' MHz':'')+(n.power_state?' · '+esc(n.power_state):'')+'</div></div>'+
        '<div class="sys-pill">'+(idle?'Idle':sysPct(n.busy))+'</div></div>';
    }
    html+='</div>';
  }

  /* ---- Fans ---- */
  html+=sysSec('Fans')+'<div class="sys-card list">'+
    (fans.length?fans.map(function(f,i){return (i?sysHair():'')+'<div class="sys-kv"><div style="flex:1"><div class="sys-name">'+esc(f.name)+'</div><div class="sys-sub" style="margin-top:2px">'+(f.pwm_percent!=null?f.pwm_percent+'% duty':'')+(f.temp_c!=null?' · zone '+Math.round(f.temp_c)+'°':'')+'</div></div>'+
      '<div class="sys-rpm">'+(f.rpm!=null?f.rpm:'—')+' <small>rpm</small></div></div>';}).join(''):'<div class="sys-kv"><div class="sys-k">No fan data</div></div>')+
    '</div><div class="sys-foot">Fan curve lives in Settings → Cooling.</div>';

  /* ---- Disks ---- */
  html+=sysSec('Disks')+'<div class="sys-card list">'+
    (disks.length?disks.map(function(k,i){var io=k.io||{};var isSys=SYS_SYSDISK&&k.name===SYS_SYSDISK;return (i?sysHair():'')+
      '<div class="sys-disk"><div class="sys-head"><div class="sys-name mono">'+esc(k.name)+'</div><div class="sys-sub">'+sysTB(k.size_bytes)+' · '+(k.temp_c!=null?Math.round(k.temp_c)+'°':'—')+'</div></div>'+
      '<div class="sys-sub">'+esc(k.model)+(isSys?' · system':'')+'</div>'+
      '<div class="sys-diskio"><div class="sys-bar thin"><i class="c-user" style="width:'+(io.busy||0)+'%"></i></div><div class="sys-io mono">'+sysPct(io.busy)+' · ↓ '+sysRate(io.read_bps)+' · ↑ '+sysRate(io.write_bps)+'</div></div></div>';}).join(''):'<div class="sys-kv"><div class="sys-k">No disks</div></div>')+
    '</div>';

  /* ---- Top processes ---- */
  var tc=(p.top_cpu||[]).slice(0,5),tm=(p.top_mem||[]).slice(0,5);
  function prow(x,val,last){return '<div class="sys-proc'+(last?' last':'')+'"><div class="sys-pname">'+esc(x.name)+'</div><div class="sys-pid mono">'+x.pid+'</div><div class="sys-pval mono">'+val+'</div></div>';}
  html+=sysSec('Top processes',(p.count||0)+' running')+'<div class="sys-card list">'+
    '<div class="sys-band">By CPU</div>'+tc.map(function(x,i){return prow(x,sysPct(x.cpu),i===tc.length-1);}).join('')+
    '<div class="sys-hair full"></div><div class="sys-band">By memory</div>'+tm.map(function(x,i){return prow(x,fmtB(x.rss),i===tm.length-1);}).join('')+
    '</div><div class="sys-foot">Read from this device only — no sign-in required. Read-only: processes can’t be stopped here.</div>';

  var root=document.getElementById('sysRoot'); if(root)root.innerHTML=html;
}
