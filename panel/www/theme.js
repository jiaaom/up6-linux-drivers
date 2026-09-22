// Theme (dark | light). Loaded first, before style.css paints anything, so the
// panel never flashes the wrong background on a cold start.
//
// The chosen theme lives in two places on purpose:
//   * /var/lib/t6-paneld/settings.json (via PUT /api/settings/theme) is the
//     source of truth — it survives a reinstall of the Electron profile and is
//     what /api/panel reports back.
//   * localStorage['t6.theme'] is a local echo, read *synchronously* here so
//     the first paint is already correct. /api/panel arrives ~a frame later
//     and reconciles (applyTheme is idempotent).
// Dark is the default whenever neither is available.
var THEMES = ['dark', 'light'];
var theme = 'dark';

function applyTheme(t) {
  if (THEMES.indexOf(t) < 0) t = 'dark';
  theme = t;
  document.documentElement.dataset.theme = t;
  // Electron paints this behind the renderer (window backgroundColor) and
  // behind the native Preview view, so it has to follow too, or a scroll
  // overshoot / preview load flashes the other theme's colour.
  var meta = document.querySelector('meta[name="theme-color"]');
  var bg = t === 'light' ? '#e2ecf7' : '#0d1420';
  if (meta) meta.setAttribute('content', bg);
  if (window.themeBridge && window.themeBridge.set) window.themeBridge.set(t, bg);
}

// Persist + apply. Called from the Settings segmented control.
function setTheme(t) {
  applyTheme(t);
  try { localStorage.setItem('t6.theme', theme); } catch (e) {}
  fetch('api/settings/theme', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ theme: theme }),
  }).catch(function () {});
}

(function () {
  var t = null;
  try { t = localStorage.getItem('t6.theme'); } catch (e) {}
  applyTheme(t || 'dark');
})();
