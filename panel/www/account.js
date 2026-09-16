// Sign-in screen (native /api/fnos) and the global on-screen keyboard.
/* ---------- login screen (native /api/fnos) ---------- */
var loginEl=document.getElementById('login');
function showLogin(){
  document.getElementById('loginErr').hidden=true;
  document.getElementById('loginUser').value='';document.getElementById('loginPass').value='';
  loginEl.classList.add('on');
  setTimeout(function(){document.getElementById('loginUser').focus();},120);
}
function hideLogin(){loginEl.classList.remove('on');}
function submitLogin(){
  var u=document.getElementById('loginUser').value.trim(),p=document.getElementById('loginPass').value;
  var err=document.getElementById('loginErr'),btn=document.getElementById('loginSubmit');
  if(!u||!p){err.textContent='Enter your username and password.';err.hidden=false;return;}
  err.hidden=true;btn.classList.add('busy');btn.textContent='Signing in…';
  fetch('api/fnos/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user:u,password:p})})
    .then(function(r){return r.json().then(function(j){return {ok:r.ok,j:j};});})
    .then(function(res){
      btn.classList.remove('busy');btn.textContent='Sign in';
      if(res.ok&&res.j&&res.j.signedIn){hideLogin();fnosUser={username:res.j.username,uid:res.j.uid,admin:res.j.admin};setAccount();toast('Signed in');}
      else{err.textContent=(res.j&&res.j.error)||'Sign in failed.';err.hidden=false;}
    }).catch(function(){btn.classList.remove('busy');btn.textContent='Sign in';err.textContent='Sign in failed.';err.hidden=false;});
}
document.getElementById('loginCancel').addEventListener('click',hideLogin);
document.getElementById('loginSubmit').addEventListener('click',submitLogin);
document.getElementById('loginPass').addEventListener('keydown',function(e){if(e.key==='Enter')submitLogin();});
document.getElementById('loginUser').addEventListener('keydown',function(e){if(e.key==='Enter')document.getElementById('loginPass').focus();});

/* ---------- global on-screen keyboard (auto-shows on any input focus) ---------- */
(function(){
  var LAYERS={
    abc:[['q','w','e','r','t','y','u','i','o','p'],
         ['a','s','d','f','g','h','j','k','l'],
         ['shift','z','x','c','v','b','n','m','back'],
         ['num','space','return','hide']],
    num:[['1','2','3','4','5','6','7','8','9','0'],
         ['-','/',':',';','(',')','$','&','@'],
         ['.',',','?','!',"'",'back'],
         ['abc','space','return','hide']]
  };
  var LABEL={shift:'⇧',back:'⌫',num:'123',abc:'ABC',space:'space',return:'return',hide:'⌄'};
  var osk=document.getElementById('osk'),target=null,layer='abc',shift=false;
  function isText(el){return el&&el.tagName==='INPUT'&&/^(text|password|search|email|number|tel|url|)$/.test(el.type);}
  function render(){
    osk.innerHTML='';
    LAYERS[layer].forEach(function(row){
      var r=document.createElement('div');r.className='osk-row';
      row.forEach(function(k){
        var key=document.createElement('div');key.dataset.k=k;
        if(LABEL.hasOwnProperty(k)){
          key.className='osk-key act'+(k==='space'?' space':(' wide'));
          if(k==='shift'&&shift)key.classList.add('shift','on');
          key.textContent=LABEL[k];
        }else{key.className='osk-key';key.textContent=(shift&&layer==='abc')?k.toUpperCase():k;}
        key.addEventListener('pointerdown',function(e){e.preventDefault();}); // keep the field focused
        key.addEventListener('click',function(){press(k);});
        r.appendChild(key);
      });
      osk.appendChild(r);
    });
  }
  function insert(c){if(!target)return;var s=target.selectionStart,e=target.selectionEnd;
    if(s==null){target.value+=c;}else{target.value=target.value.slice(0,s)+c+target.value.slice(e);var n=s+c.length;target.selectionStart=target.selectionEnd=n;}
    target.dispatchEvent(new Event('input',{bubbles:true}));}
  function del(){if(!target)return;var s=target.selectionStart,e=target.selectionEnd;
    if(s==null){target.value=target.value.slice(0,-1);}
    else if(s!==e){target.value=target.value.slice(0,s)+target.value.slice(e);target.selectionStart=target.selectionEnd=s;}
    else if(s>0){target.value=target.value.slice(0,s-1)+target.value.slice(e);target.selectionStart=target.selectionEnd=s-1;}
    target.dispatchEvent(new Event('input',{bubbles:true}));}
  function press(k){
    switch(k){
      case 'shift':shift=!shift;render();return;
      case 'back':del();return;
      case 'num':layer='num';shift=false;render();return;
      case 'abc':layer='abc';render();return;
      case 'space':insert(' ');return;
      case 'hide':hide();if(target)target.blur();return;
      case 'return':if(target)target.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));return;
      default:insert((shift&&layer==='abc')?k.toUpperCase():k);if(shift){shift=false;render();}
    }
  }
  function show(){if(!osk.classList.contains('on')){layer='abc';shift=false;render();osk.classList.add('on');}}
  function hide(){osk.classList.remove('on');}
  document.addEventListener('focusin',function(e){if(isText(e.target)){target=e.target;show();}});
  document.addEventListener('focusout',function(){setTimeout(function(){if(!isText(document.activeElement))hide();},60);});
})();

