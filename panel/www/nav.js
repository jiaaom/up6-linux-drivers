// Keyboard / remote navigation for the panel UI.
/* The stock BLE remote reaches us as an ordinary keyboard (t6-control turns
   its codes into uinput keys; see docs/panel-keyboard-navigation.md):
   arrows, Enter (OK), BrowserBack, BrowserHome, ContextMenu (Menu), and the
   volume keys. The Electron main process intercepts the non-arrow ones (so
   BrowserBack can't navigate the kiosk) and forwards them as navKey events;
   arrows, Enter and Escape arrive as normal keydowns.

   Every control in this UI is a <div> with a click handler, so this file is
   loaded first and notes which elements get a click listener: those, plus a
   few delegated children (segmented options, chips, steppers), inputs and
   sliders, are what the arrows move between. Focus is virtual (a class, not
   DOM focus) so moving over the on-screen keyboard never blurs the field it
   types into. Only the topmost layer (dialog, sheet, sub-page, screen) is
   navigable. The focus ring shows from the first key press and hides on
   the next touch. */
(function(){
  // ---- which elements are actionable ----
  var addEL=EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener=function(type,fn,opts){
    if(type==='click'&&this instanceof Element)this.__navTap=true;
    return addEL.call(this,type,fn,opts);
  };
  // children of delegated click handlers (leds.js) and other controls
  var ALWAYS='.segopt,.seg-opt,.led-chip,.led-stepbtn,.slider,input,textarea,select,[data-nav]';
  // stacking order, topmost first (see z-index in style.css). A dark screen
  // is not a layer here: t6-paneld's screensaver window takes the keys then.
  var LAYERS=['#osk','#btCode','#fmPrompt','#hotspot','#ethedit','#wifipass','#login','#confirm',
    '#detail','#fmSheet','#fmPrev','#files','#subpage','#settings','#edit','#home'];

  // curAuto: cur was picked by defaultFocus and not moved by the user yet,
  // so a better default (content that rendered late) may replace it
  var cur=null, curAuto=false, memory={}, lastLayer=null;
  // Files: the row each open folder was entered from, so Back lands on it
  // again (folders replace each other inside the same #files layer)
  var remembered={files:[]};

  function shown(el){
    if(!el||el.hidden)return false;
    var cs=getComputedStyle(el);
    if(cs.display==='none'||cs.visibility==='hidden'||parseFloat(cs.opacity)<0.05)return false;
    var r=el.getBoundingClientRect();
    return r.width>0&&r.height>0&&r.right>1&&r.left<innerWidth-1&&r.bottom>1&&r.top<innerHeight-1;
  }
  function topLayer(){
    for(var i=0;i<LAYERS.length;i++){var el=document.querySelector(LAYERS[i]);if(shown(el))return el;}
    return document.body;
  }
  function visible(el){
    if(el.closest('[hidden]'))return false;
    var r=el.getBoundingClientRect();
    if(r.width<2||r.height<2)return false;
    var cs=getComputedStyle(el);
    return cs.visibility!=='hidden'&&cs.display!=='none'&&el.dataset.nav!=='no';
  }
  function actionable(el){return el.__navTap||typeof el.onclick==='function'||el.matches(ALWAYS);}
  function candidates(layer){
    var all=[], els=layer.querySelectorAll('*');
    for(var i=0;i<els.length;i++){
      var el=els[i];
      if(!actionable(el)||!visible(el))continue;
      // a nested layer that isn't the top one (Preview/sheet inside #files)
      var inner=el.parentElement&&el.parentElement.closest(LAYERS.join(','));
      if(inner&&inner!==layer&&layer.contains(inner))continue;
      all.push(el);
    }
    // a container with its own listener that holds other controls
    // (event delegation) is not a target itself; its children are
    all=all.filter(function(el){return !all.some(function(o){return o!==el&&el.contains(o);});});
    // A settings row whose only control is a switch at its right edge: the
    // row is the target (the arrows would skip a lone switch far from the
    // left-aligned controls above and below), Enter flips the switch.
    return all.map(function(el){
      if(!el.matches('.etoggle'))return el;
      var row=el.closest('.setrow');
      if(!row||all.some(function(o){return o!==el&&row.contains(o);}))return el;
      row.__navProxy=el;
      return row;
    });
  }

  // ---- focus ----
  function remember(layer,el){memory[layer.id||'body']={el:el,key:keyOf(el)};}
  function setFocus(el,scroll){
    if(cur)cur.classList.remove('nav-focus');
    cur=el;
    if(!el)return;
    el.classList.add('nav-focus');
    if(scroll!==false)reveal(el);
  }
  // Bring el into view by scrolling only its own vertical list. Not
  // scrollIntoView: that also scrolls every scrollable ancestor, including
  // the overflow:hidden stage that holds the sliding screens, and shoves the
  // whole UI sideways while a screen is still sliding in.
  var MARGIN_TOP=24, MARGIN_BOTTOM=96; // clears the Files toolbar at the bottom
  function reveal(el){
    for(var p=el.parentElement;p&&p!==document.body;p=p.parentElement){
      var oy=getComputedStyle(p).overflowY;
      if((oy==='auto'||oy==='scroll')&&p.scrollHeight>p.clientHeight+1){
        var pr=p.getBoundingClientRect(), r=el.getBoundingClientRect();
        if(r.top<pr.top+MARGIN_TOP)p.scrollTop-=pr.top+MARGIN_TOP-r.top;
        else if(r.bottom>pr.bottom-MARGIN_BOTTOM)p.scrollTop+=Math.min(r.bottom-(pr.bottom-MARGIN_BOTTOM),r.top-(pr.top+MARGIN_TOP));
        return;
      }
    }
  }
  function inKbdMode(){return document.body.classList.contains('kbd-nav');}
  function enterKbdMode(){document.body.classList.add('kbd-nav');}
  // touch/mouse hides the ring (like :focus-visible); focus is kept
  addEL.call(document,'pointerdown',function(e){
    if(e.isTrusted)document.body.classList.remove('kbd-nav');
  },true);

  // Default focus in a layer: what was focused there last, else the first
  // control inside its scrolling content (skips the header's Back button),
  // else the first control.
  // An element's identity across re-renders (lists are rebuilt as HTML).
  function keyOf(el){return el.dataset.path||(el.dataset.k?'k:'+el.dataset.k:'')||el.id||(el.className+'|'+(el.textContent||'').trim().slice(0,40));}
  function defaultFocus(layer,list){
    var id=layer.id||'body', m=memory[id];
    if(m){
      if(m.el.isConnected&&list.indexOf(m.el)>=0)return m.el;
      var same=list.filter(function(el){return keyOf(el)===m.key;})[0];
      if(same)return same;
    }
    var inScroll=list.filter(function(el){return el.closest('.scroll,.fm-sheet-body,.login-card,.cdlg,#detailBody,.osk-row');});
    var pool=inScroll.length?inScroll:list;
    return pool.slice().sort(function(a,b){
      var ra=a.getBoundingClientRect(), rb=b.getBoundingClientRect();
      return (ra.top-rb.top)||(ra.left-rb.left);
    })[0]||null;
  }
  // Make sure the focus is on a control of the top layer; returns it.
  function sync(){
    var layer=topLayer(), list=candidates(layer);
    if(lastLayer&&lastLayer!==layer&&cur&&lastLayer.contains(cur))remember(lastLayer,cur);
    lastLayer=layer;
    if(!cur||!cur.isConnected||list.indexOf(cur)<0||curAuto){
      var d=defaultFocus(layer,list);
      if(d!==cur)setFocus(d,true);
      curAuto=true;
    }
    return {layer:layer,list:list};
  }

  // Nearest control in a direction: must lie beyond the current edge; score
  // favours overlap on the cross axis, then distance along the axis.
  function move(dir){
    var s=sync();
    if(!cur){return;}
    var a=cur.getBoundingClientRect(), best=null, bestScore=Infinity;
    s.list.forEach(function(el){
      if(el===cur)return;
      var b=el.getBoundingClientRect(), gap, cross;
      if(dir==='down'){if(b.top<a.bottom-4&&b.top<=a.top)return;gap=Math.max(0,b.top-a.bottom);cross=span(a.left,a.right,b.left,b.right);if((b.top+b.bottom)/2<=(a.top+a.bottom)/2)return;}
      else if(dir==='up'){if(b.bottom>a.top+4&&b.bottom>=a.bottom)return;gap=Math.max(0,a.top-b.bottom);cross=span(a.left,a.right,b.left,b.right);if((b.top+b.bottom)/2>=(a.top+a.bottom)/2)return;}
      else if(dir==='right'){if(b.left<a.right-4&&b.left<=a.left)return;gap=Math.max(0,b.left-a.right);cross=span(a.top,a.bottom,b.top,b.bottom);if((b.left+b.right)/2<=(a.left+a.right)/2)return;}
      else{if(b.right>a.left+4&&b.right>=a.right)return;gap=Math.max(0,a.left-b.right);cross=span(a.top,a.bottom,b.top,b.bottom);if((b.left+b.right)/2>=(a.left+a.right)/2)return;}
      var score=gap+cross*3;
      if(score<bestScore){bestScore=score;best=el;}
    });
    if(best){setFocus(best);curAuto=false;}
    else if(dir==='up'||dir==='down')scrollLayer(s.layer,dir);
  }
  // Nothing further that way (a read-only page, or the rest of a long page
  // has no controls): scroll the layer's list by most of a screen instead.
  function scrollLayer(layer,dir){
    var sc=null, els=layer.querySelectorAll('*');
    for(var i=0;i<els.length&&!sc;i++){
      var oy=getComputedStyle(els[i]).overflowY;
      if((oy==='auto'||oy==='scroll')&&els[i].scrollHeight>els[i].clientHeight+1)sc=els[i];
    }
    if(sc)sc.scrollBy({top:(dir==='down'?1:-1)*sc.clientHeight*0.6,behavior:'smooth'});
  }
  // distance between two 1-D intervals (0 when they overlap)
  function span(a1,a2,b1,b2){return b2<a1?a1-b2:b1>a2?b1-a2:0;}

  // After an action that may open or close a layer: sync once it has
  // rendered, and again once a sliding screen has finished moving (while it
  // slides out it still counts as the top layer, so an early sync alone
  // leaves the ring on the screen that is leaving).
  function settle(){setTimeout(sync,80);setTimeout(sync,450);}
  addEL.call(document,'transitionend',function(e){
    if(e.propertyName==='transform'&&inKbdMode()&&e.target.matches&&e.target.matches(LAYERS.join(',')))sync();
  },true);

  // ---- actions ----
  function activate(){
    var s=sync();if(!cur)return;
    remember(s.layer,cur);
    if(s.layer.id==='osk')curAuto=true; // keys are rebuilt on shift/123: find the same key again
    if(s.layer.id==='files'&&cur.matches('.fm-row,.fm-gcell')&&cur.dataset.dir==='1')
      remembered.files.push({el:cur,key:keyOf(cur)});
    if(cur.matches('input,textarea,select')){cur.focus();return;}
    if(cur.matches('.slider'))return;
    (cur.__navProxy||cur).click();
    settle(); // the click may open or close a layer
  }
  // Sliders take Left/Right as ±5 % (their handlers read clientX)
  function stepSlider(el,dir){
    var r=el.getBoundingClientRect(), fill=el.querySelector('.fill');
    var pct=fill?fill.getBoundingClientRect().width/r.width*100:50;
    pct=Math.max(0,Math.min(100,pct+(dir==='right'?5:-5)));
    var x=r.left+r.width*pct/100, y=r.top+r.height/2;
    el.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientX:x,clientY:y}));
    window.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,clientX:x,clientY:y}));
  }
  // Menu = long press (fmBindLongPress and friends time a held mouse button)
  function longPress(){
    sync();if(!cur)return;
    var r=cur.getBoundingClientRect(), o={bubbles:true,clientX:r.left+r.width/2,clientY:r.top+r.height/2};
    var el=cur;
    el.dispatchEvent(new MouseEvent('mousedown',o));
    setTimeout(function(){el.dispatchEvent(new MouseEvent('mouseup',o));settle();},560);
  }
  // Back: close the top layer the way its own UI does
  function clickIn(layer,sel){var b=layer.querySelector(sel);if(b&&visible(b)){b.click();return true;}return false;}
  function back(){
    var layer=topLayer(), id=layer.id;
    // going back within the same layer (a parent folder): the row to return
    // to is the one we opened from, remembered on the way in
    if(id==='files'){
      if(remembered.files.length){memory.files=remembered.files.pop();setFocus(null);curAuto=true;}
    }
    if(id==='osk'){var a=document.activeElement;if(a&&a.blur)a.blur();}
    else if(id==='detail'&&typeof closeDetail==='function')closeDetail();
    else if(id==='fmSheet'&&typeof fmCloseSheet==='function')fmCloseSheet();
    else if(id==='fmPrev'&&typeof fmClosePreview==='function')fmClosePreview();
    else if(id==='files'&&typeof fmBack==='function')fmBack();
    else if(id==='subpage'&&typeof closePage==='function')closePage();
    else if(id==='settings'&&typeof closeSettings==='function')closeSettings();
    else if(id==='edit')clickIn(layer,'#donebtn');
    else clickIn(layer,'.cbtn.cancel,.login-cancel,.cancel,[data-nav-back]');
    settle();
  }
  // Home: close everything down to the home screen, top to bottom, with the
  // same calls the UI's own buttons make (not a loop over back(): closing
  // layers stay "shown" while their CSS transition runs)
  var DIALOGS=['#btCode','#fmPrompt','#hotspot','#ethedit','#wifipass','#login','#confirm'];
  function home(){
    remembered.files=[];
    var a=document.activeElement;if(a&&a.blur)a.blur();
    DIALOGS.forEach(function(sel){var l=document.querySelector(sel);if(shown(l))clickIn(l,'.cbtn.cancel,.login-cancel,.cancel,[data-nav-back]');});
    if(typeof closeDetail==='function')closeDetail();
    if(typeof fmCloseSheet==='function')fmCloseSheet();
    var cl=document.body.classList;
    if(cl.contains('files-open')&&typeof fmClose==='function')fmClose();
    if(cl.contains('subpage-open')){if(typeof pageBack!=='undefined')pageBack=null;cl.remove('subpage-open');}
    if(cl.contains('settings-open')&&typeof closeSettings==='function')closeSettings();
    if(cl.contains('editing'))clickIn(document,'#donebtn');
    settle();
  }

  // Volume keys: the default audio output (Settings → Audio), ±5 %
  function volume(delta){
    fetch('api/audio',{cache:'no-store'}).then(function(r){return r.json();}).then(function(a){
      var o=(a.outputs||[]).filter(function(x){return x.default;})[0];
      if(!o){toast('No speaker connected');return;}
      if(delta===0){
        return fetch('api/audio/mute',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:o.id})})
          .then(function(r){return r.json();}).then(function(m){toast(m.muted?'Sound off':'Sound on');});
      }
      var v=Math.max(0,Math.min(1,Math.round(((o.volume||0)+delta)*20)/20));
      return fetch('api/audio/volume',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:o.id,volume:v})})
        .then(function(){toast('Volume '+Math.round(v*100)+'%');});
    }).catch(function(){});
  }

  // ---- key dispatch ----
  function handle(key){
    if(key==='AudioVolumeUp'){volume(0.05);return true;}
    if(key==='AudioVolumeDown'){volume(-0.05);return true;}
    if(key==='AudioVolumeMute'){volume(0);return true;}
    var first=!inKbdMode();
    enterKbdMode();
    if(first&&/^Arrow/.test(key)){sync();if(cur)setFocus(cur);return true;} // first press just shows where focus is
    switch(key){
      case 'ArrowUp':move('up');return true;
      case 'ArrowDown':move('down');return true;
      case 'ArrowLeft':case 'ArrowRight':
        sync();
        if(cur&&cur.matches('.slider')){stepSlider(cur,key==='ArrowLeft'?'left':'right');return true;}
        move(key==='ArrowLeft'?'left':'right');return true;
      case 'Enter':activate();return true;
      case 'Escape':case 'BrowserBack':back();return true;
      case 'BrowserHome':home();return true;
      case 'ContextMenu':longPress();return true;
    }
    return false;
  }
  addEL.call(document,'keydown',function(e){
    // Real keys only: the on-screen keyboard's return key dispatches a
    // synthetic Enter to its field, which belongs to the field's own handler
    // (taken here, it clicked whatever key the ring was on instead).
    if(!e.isTrusted)return;
    var t=e.target, typing=t&&t.matches&&t.matches('input,textarea');
    // In a text field, arrows/Enter belong to the field unless the
    // on-screen keyboard is up (then they drive it, like the remote would).
    if(typing&&!shown(document.getElementById('osk'))&&e.key!=='Escape')return;
    if(handle(e.key)){e.preventDefault();e.stopPropagation();}
  },true);
  // keys the main process intercepts (BrowserBack, BrowserHome, ContextMenu,
  // volume) — also delivered while focus is in the Preview view
  if(window.navBridge&&window.navBridge.onKey)window.navBridge.onKey(function(key){handle(key);});

  // for other scripts/tests
  window.navFocus=function(){return cur;};
  window.navSync=sync;
})();
