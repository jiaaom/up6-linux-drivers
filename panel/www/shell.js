// Panel shell: viewport fit, clock, and the fnOS account chip (setAccount/refreshFnos).
/* appliance: no context menu, no long-press callout, no image/text drag */
addEventListener('contextmenu',function(e){e.preventDefault();},{passive:false});
addEventListener('dragstart',function(e){e.preventDefault();},{passive:false});
// #device now fills the viewport normally via CSS (position:absolute;inset:0)
// instead of a fixed-size canvas transform-scaled by JS — see style.css and
// refs/linux-wayland-dpi.md for why. The real screen density is handled by the
// Wayland compositor (weston scale=2 on the touch panel's output), not here.

function tick(){var d=new Date(),t=String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');
  document.querySelectorAll('#clock,.clock2,.clock3').forEach(function(e){e.textContent=t;});}
tick();setInterval(tick,10000);
var LAST=null; // most recent /api/panel payload
// The signed-in fnOS user (from t6-paneld's native /api/fnos session), or null.
var fnosUser=null;
function setAccount(session){
  var s=fnosUser||(session||null);
  var acct=document.getElementById('acct'),at=document.getElementById('acctText'),dot=acct&&acct.querySelector('.acctdot');
  if(!acct)return;
  if(s&&s.username){acct.classList.remove('signin');at.textContent='Signed in as '+s.username;if(dot)dot.hidden=false;}
  else{acct.classList.add('signin');at.textContent='Sign in';if(dot)dot.hidden=true;}
}
// Native fnOS session (t6-paneld /api/fnos). Works in both the kiosk and a plain
// browser — it's just a fetch to the local daemon, no Electron bridge needed.
function refreshFnos(){
  fetch('api/fnos/status',{cache:'no-store'}).then(function(r){return r.json();}).then(function(s){
    fnosUser=(s&&s.signedIn)?{username:s.username,uid:s.uid,admin:s.admin}:null;
    setAccount();
  }).catch(function(){});
}
window.refreshFnos=refreshFnos;

