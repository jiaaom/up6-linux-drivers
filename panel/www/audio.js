// Audio sub-page: choose the output and its volume.
/* The panel's sound server is PipeWire (t6-audio units); t6-paneld's /api/audio
   lists its outputs and sets the default one, which the video player and the
   kiosk both play into. Outputs appear as they are plugged in or paired
   (a TV only while connected), so the page re-reads every few seconds while
   open. Installing or repairing the sound server is an admin action on the
   fnOS desktop page, never here: the panel needs no sign-in. */
var audioTimer=null, audioBusyUntil=0;
var AUDIO_KIND={usb:'USB',hdmi:'HDMI',bluetooth:'Bluetooth',other:''};
// Speaker glyphs for the volume slider (no emoji font on the panel).
var AUDIO_SPK='<path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/>';
var AUDIO_ICON_LOW='<svg width="18" height="18" viewBox="0 0 24 24">'+AUDIO_SPK+'</svg>';
var AUDIO_ICON_HIGH='<svg width="18" height="18" viewBox="0 0 24 24">'+AUDIO_SPK+'<path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

function openAudio(){
  openPage('Audio','<div id="audRoot"><div class="wifi-empty">Loading…</div></div>',function(){
    audioLoad();
    clearInterval(audioTimer);
    audioTimer=setInterval(function(){
      if(!document.body.classList.contains('subpage-open')||!document.getElementById('audRoot')){clearInterval(audioTimer);audioTimer=null;return;}
      if(Date.now()>audioBusyUntil)audioLoad();
    },3000);
  });
}

function audioLoad(){
  fetch('api/audio',{cache:'no-store'}).then(function(r){if(!r.ok)throw new Error();return r.json();})
    .then(audioRender)
    .catch(function(){audioMessage('Audio settings are not available right now.');});
}

function audioMessage(text){
  var root=document.getElementById('audRoot');if(!root)return;
  root.dataset.built='';
  root.innerHTML='<div class="wifi-empty">'+esc(text)+'</div>';
}

function audioRender(s){
  var root=document.getElementById('audRoot');if(!root)return;
  if(s.pulseaudio){audioMessage('Audio is off: PulseAudio, installed by another app, conflicts with the panel’s sound server. Uninstall that app to use audio here.');return;}
  if(!s.running){audioMessage('The sound server is not running. Open T6 Front Panel on the fnOS desktop (as an administrator) to repair it.');return;}
  var outs=s.outputs||[], def=outs.filter(function(o){return o.default;})[0];
  var key=outs.map(function(o){return o.id+':'+o.default;}).join(',');
  if(root.dataset.built!==key){root.innerHTML=audioHtml(outs);root.dataset.built=key;audioWire(root,def);}
  var val=document.getElementById('audVolVal');
  if(def&&val&&Date.now()>audioBusyUntil)audioSetSlider(def.volume==null?0:def.volume);
}

function audioHtml(outs){
  if(!outs.length){
    return '<div class="setgroup"><div class="setlabel">Output</div><div class="card">'+
      '<div class="wifi-empty">Choose audio output device.</div>'+
      '</div></div>';
  }
  var rows=outs.map(function(o,i){
    var kind=AUDIO_KIND[o.kind]||'';
    return (i?'<div class="hairrow"></div>':'')+
      '<div class="setrow tap aud-out" data-id="'+o.id+'"><div class="lbl">'+esc(o.name)+
      (kind?' <span class="aud-kind">'+kind+'</span>':'')+'</div>'+
      '<div class="setval">'+(o.default?'<span class="aud-check">✓</span>':'')+'</div></div>';
  }).join('');
  return '<div class="setgroup"><div class="setlabel">Output</div><div class="card">'+rows+'</div>'+
      '<div class="led-foot">Videos play on the selected output. A TV appears here while it is connected over HDMI.</div></div>'+
    '<div class="setgroup"><div class="setlabel">Volume</div><div class="card">'+
      '<div class="setrow"><div class="lbl">Output volume</div><div class="setval" id="audVolVal"></div></div>'+
      '<div class="slider" id="audVol"><div class="fill"></div><span class="ico">'+AUDIO_ICON_LOW+'</span><span class="ico r">'+AUDIO_ICON_HIGH+'</span></div>'+
    '</div><div class="led-foot">Each output remembers its own volume. The player has its own volume on top.</div></div>';
}

function audioSetSlider(v){
  var s=document.getElementById('audVol');if(!s)return;
  var p=Math.max(0,Math.min(100,Math.round(v*100)));
  s.querySelector('.fill').style.width=p+'%';
  document.getElementById('audVolVal').textContent=p+'%';
  return p;
}

function audioPut(path,body){
  audioBusyUntil=Date.now()+1500;
  return fetch('api/audio/'+path,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
    .then(function(r){if(!r.ok)return r.text().then(function(t){throw new Error((t||'').trim());});})
    .catch(function(e){toast(e.message||'Change failed');});
}

function audioWire(root,def){
  root.querySelectorAll('.aud-out').forEach(function(row){
    row.addEventListener('click',function(){
      audioPut('default',{id:+row.dataset.id}).then(function(){audioBusyUntil=0;audioLoad();});
    });
  });
  var s=document.getElementById('audVol');if(!s||!def)return;
  var timer=null, dragging=false;
  function set(clientX){
    var r=s.getBoundingClientRect(), p=audioSetSlider((clientX-r.left)/r.width);
    audioBusyUntil=Date.now()+1500;
    clearTimeout(timer);
    timer=setTimeout(function(){audioPut('volume',{id:def.id,volume:p/100});},150);
  }
  function down(e){dragging=true;set((e.touches?e.touches[0]:e).clientX);e.preventDefault();}
  function move(e){if(!dragging)return;set((e.touches?e.touches[0]:e).clientX);e.preventDefault();}
  function up(){dragging=false;}
  s.addEventListener('touchstart',down,{passive:false});
  s.addEventListener('touchmove',move,{passive:false});
  s.addEventListener('touchend',up);
  s.addEventListener('mousedown',down);addEventListener('mousemove',move);addEventListener('mouseup',up);
}
