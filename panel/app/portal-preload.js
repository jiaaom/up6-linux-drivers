// Preload of the captive-portal view (main.js). The page is someone else's
// and gets nothing from here; this only tells the panel when a text field in
// it takes focus or loses it, so the panel's own keyboard comes and goes.
// A tap on that keyboard takes focus to the panel's page for a moment
// (main.js gives it back): the page then has no focus, which is not a
// field losing it, so it isn't reported.
const { ipcRenderer } = require('electron');

const NOT_TEXT = /^(button|checkbox|color|file|hidden|image|radio|range|reset|submit)$/i;
const editable = (e) => !!e && (e.isContentEditable || e.tagName === 'TEXTAREA' || (e.tagName === 'INPUT' && !NOT_TEXT.test(e.type)));

let shown = false;
function report() {
  if (!document.hasFocus()) return;
  const now = editable(document.activeElement);
  if (now !== shown) {
    shown = now;
    ipcRenderer.send('portal:focus', now);
  }
}

window.addEventListener('focusin', () => setTimeout(report, 0), true);
window.addEventListener('focusout', () => setTimeout(report, 60), true);
// a tap on the field that already has focus (the keyboard was swiped away)
window.addEventListener('pointerup', (e) => {
  if (editable(e.target)) { shown = true; ipcRenderer.send('portal:focus', true); }
}, true);
