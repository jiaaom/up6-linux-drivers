// The panel's own keyboard (rl-osk): the iOS English layout, always the top
// layer. It rises when a text field takes focus and closes on a tap outside
// the fields, a downward swipe on it, or Back. Return sends Enter to the
// field; the page decides what Enter does. The tab bar hides while it is up.

import { el, html, isText } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { langChanged, t } from '../core/i18n.js';
import { swipeDown } from './layers.js';

const LAYOUTS = {
  abc: [
    ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
    ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
    ['@shift', 'z', 'x', 'c', 'v', 'b', 'n', 'm', '@del'],
    ['@num', '@space', '@return'],
  ],
  num: [
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
    ['-', '/', ':', ';', '(', ')', '$', '&', '@', '"'],
    ['@sym', '.', ',', '?', '!', "'", '@del'],
    ['@abc', '@space', '@return'],
  ],
  sym: [
    ['[', ']', '{', '}', '#', '%', '^', '*', '+', '='],
    ['_', '\\', '|', '~', '<', '>', '€', '£', '¥', '·'],
    ['@num', '.', ',', '?', '!', "'", '@del'],
    ['@abc', '@space', '@return'],
  ],
};
const DOUBLE_TAP_MS = 400;

let screen = null;
let osk = null;
let target = null;
let layout = 'abc';
let shift = 'off'; // off | once | lock
let shiftAt = 0;

/** The keyboard element while it is up, else null. */
export function keyboardEl() {
  return osk;
}

function key(k) {
  const fn = (label, body, extra = '') =>
    html`<button class="rl-osk__key rl-osk__key--fn" data-k="${k}" tabindex="-1"${label ? html` aria-label="${label}"` : ''}${extra}>${body}</button>`;
  switch (k) {
    case '@shift': return fn(t('osk.shift'), icon('arrow-fat-up'), html` aria-pressed="${shift !== 'off'}"${shift === 'lock' ? html` data-lock` : ''}`);
    case '@del': return fn(t('osk.delete'), icon('backspace'));
    case '@num': return fn('', '123');
    case '@sym': return fn('', '#+=');
    case '@abc': return fn('', 'ABC');
    case '@space': return html`<button class="rl-osk__key rl-osk__key--space" data-k="@space" tabindex="-1">${t('osk.space')}</button>`;
    case '@return': return html`<button class="rl-osk__key rl-osk__key--done" data-k="@return" tabindex="-1" aria-label="${t('osk.return')}">${icon('arrow-elbow-down-left')}</button>`;
    default: {
      const c = layout === 'abc' && shift !== 'off' ? k.toUpperCase() : k;
      return html`<button class="rl-osk__key" data-k="${k}" tabindex="-1">${c}</button>`;
    }
  }
}

function render() {
  osk.innerHTML = String(html`${LAYOUTS[layout].map((row, i) => html`<div class="rl-osk__row${layout === 'abc' && i === 1 ? ' rl-osk__row--inset' : ''}"${i === 0 ? html` style="margin-top:0"` : ''}>${row.map(key)}</div>`)}`);
}

// Number and e-mail fields have no caret API; type at the end there.
function caret(n) {
  try { target.setSelectionRange(n, n); } catch { /* no selection on this input type */ }
}

function edit(insert) {
  if (!target) return;
  const v = target.value;
  let s = target.selectionStart ?? v.length;
  let e = target.selectionEnd ?? v.length;
  if (insert == null) { // delete
    if (s === e && s > 0) s--;
    target.value = v.slice(0, s) + v.slice(e);
    caret(s);
  } else {
    target.value = v.slice(0, s) + insert + v.slice(e);
    const n = s + insert.length;
    caret(n);
  }
  target.dispatchEvent(new Event('input', { bubbles: true }));
}

function press(k) {
  switch (k) {
    case '@shift': {
      const now = Date.now();
      if (shift === 'once' && now - shiftAt < DOUBLE_TAP_MS) shift = 'lock';
      else shift = shift === 'off' ? 'once' : 'off';
      shiftAt = now;
      render();
      return;
    }
    case '@del': edit(null); return;
    case '@num': layout = 'num'; render(); return;
    case '@sym': layout = 'sym'; render(); return;
    case '@abc': layout = 'abc'; render(); return;
    case '@space': edit(' '); return;
    case '@return':
      target?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return;
    default:
      edit(layout === 'abc' && shift !== 'off' ? k.toUpperCase() : k);
      if (shift === 'once') { shift = 'off'; render(); }
  }
}

/** Scroll the page so the focused field sits above the keyboard. */
function reveal() {
  if (!target || !osk) return;
  const scroller = target.closest('.rl-scroller');
  if (!scroller) return;
  const gap = 16;
  const top = osk.getBoundingClientRect().top;
  const r = target.getBoundingClientRect();
  if (r.bottom > top - gap) scroller.scrollBy({ top: r.bottom - top + gap, behavior: 'smooth' });
}

function show() {
  if (osk) { requestAnimationFrame(reveal); return; }
  layout = 'abc';
  shift = 'off';
  osk = el(html`<div class="rl-osk" role="group" aria-label="${t('osk.label')}"></div>`);
  render();
  osk.addEventListener('pointerdown', (e) => e.preventDefault()); // keep the field focused
  osk.addEventListener('mousedown', (e) => e.preventDefault());
  osk.addEventListener('click', (e) => {
    const b = e.target.closest('[data-k]');
    if (b) press(b.dataset.k);
  });
  swipeDown(osk, hideKeyboard);
  screen.appendChild(osk);
  screen.classList.add('is-osk-open');
  screen.style.setProperty('--rl-osk-h', `${osk.offsetHeight}px`);
  requestAnimationFrame(reveal);
}

function close() {
  if (!osk) return;
  osk.remove();
  osk = null;
  screen.classList.remove('is-osk-open');
}

/** Close the keyboard by taking focus out of the field. */
export function hideKeyboard() {
  if (isText(document.activeElement)) document.activeElement.blur();
  close();
}

export function mountKeyboard(screenEl) {
  screen = screenEl;
  document.addEventListener('focusin', (e) => {
    if (isText(e.target)) { target = e.target; show(); }
  });
  document.addEventListener('focusout', () => {
    setTimeout(() => { if (!isText(document.activeElement)) { target = null; close(); } }, 60);
  });
  // a tap outside the fields and the keyboard closes it
  document.addEventListener('pointerdown', (e) => {
    if (osk && !osk.contains(e.target) && !isText(e.target) && !isText(e.target.closest('label')?.control)) hideKeyboard();
  }, true);
  langChanged.on(() => { if (osk) { osk.setAttribute('aria-label', t('osk.label')); render(); } });
}
