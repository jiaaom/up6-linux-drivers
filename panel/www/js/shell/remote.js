// Remote-control (and keyboard) navigation.
//
// The NAS's Bluetooth remote types like a keyboard (t6-control turns its codes
// into uinput keys; see docs/panel-keyboard-navigation.md): arrows, Enter (OK),
// BrowserBack, BrowserHome, ContextMenu (Menu) and the volume keys. Electron
// takes the non-arrow keys before the page can and forwards them through
// navBridge; arrows, Enter and Escape arrive as ordinary keydowns.
//
// Focus is virtual — `.is-focus` on an item and `.is-remote` on <body> — so
// moving over the on-screen keyboard never takes focus out of its field. The
// ring shows from the first key press and hides on the next touch. Only the
// top layer is navigable: the keyboard, else a dialog / sheet / control
// center, else the page with its tab bar.

import { api } from '../core/api.js';
import { isText } from '../core/dom.js';
import { emitter } from '../core/events.js';
import { t } from '../core/i18n.js';
import { keyboardEl, hideKeyboard } from './keyboard.js';
import { dismissAll, dismissTop, layersChanged, toast, topLayer } from './layers.js';
import { offlineEl } from './offline.js';
import { back, nextTab, routeChanged, topEntry } from './router.js';

const ITEMS = 'a[href], button:not([disabled]), input:not([type=hidden]):not([disabled]), select, textarea, [role="switch"], [role="button"], [data-nav]';
const MARGIN_TOP = 40;
const MARGIN_BOTTOM = 110; // clears the floating tab bar

/** Menu on the remote: the control center opens on it. */
export const menuPressed = emitter();

let dock = null;
let cur = null; // the focused item (a row may stand in for the switch it holds)
const memory = new WeakMap(); // layer root → key of the item focused there last

const remoteOn = () => document.body.classList.contains('is-remote');

function roots() {
  if (offlineEl()) return []; // nothing to press; it retries by itself
  const osk = keyboardEl();
  if (osk) return [osk];
  const layer = topLayer();
  if (layer) return [layer];
  const page = topEntry();
  return page ? [page.el, dock] : [];
}

function visible(node) {
  if (node.closest('[hidden]') || node.dataset.nav === 'no') return false;
  const r = node.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  const cs = getComputedStyle(node);
  return cs.visibility !== 'hidden' && cs.display !== 'none';
}

/** A control inside a row label (a switch, a check) is reached through its row. */
function standIn(node) {
  if (node.matches('input') && !isText(node)) {
    const row = node.closest('label');
    if (row) return row;
  }
  return node;
}

function candidates(list) {
  const out = [];
  for (const root of list) {
    for (const node of root.querySelectorAll(ITEMS)) {
      if (!visible(node)) continue;
      const item = standIn(node);
      if (!out.includes(item)) out.push(item);
    }
  }
  // a container holding other items is not a target itself
  return out.filter((a) => !out.some((b) => b !== a && a.contains(b)));
}

function keyOf(node) {
  return node.dataset.k || node.dataset.id || node.dataset.tab || node.id || `${node.className}|${node.textContent.trim().slice(0, 40)}`;
}

function reveal(node) {
  for (let p = node.parentElement; p && p !== document.body; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight + 1) {
      const pr = p.getBoundingClientRect();
      const r = node.getBoundingClientRect();
      if (r.top < pr.top + MARGIN_TOP) p.scrollTop -= pr.top + MARGIN_TOP - r.top;
      else if (r.bottom > pr.bottom - MARGIN_BOTTOM) p.scrollTop += Math.min(r.bottom - (pr.bottom - MARGIN_BOTTOM), r.top - (pr.top + MARGIN_TOP));
      return;
    }
  }
}

function setFocus(node, scroll = true) {
  cur?.classList.remove('is-focus');
  cur = node;
  if (!node) return;
  node.classList.add('is-focus');
  memory.set(roots()[0], keyOf(node));
  if (scroll) reveal(node);
}

/** The item a layer starts on: the one focused there last, else its first item (not the back link). */
function defaultItem(list) {
  const key = memory.get(roots()[0]);
  const same = key && list.find((n) => keyOf(n) === key);
  if (same) return same;
  const content = list.filter((n) => !n.matches('[data-back]') && !(dock && dock.contains(n)));
  const pool = content.length ? content : list;
  return pool.slice().sort((a, b) => {
    const ra = a.getBoundingClientRect();
    const rb = b.getBoundingClientRect();
    return ra.top - rb.top || ra.left - rb.left;
  })[0] ?? null;
}

/** Make sure the ring is on an item of the top layer; returns the item list. */
function sync() {
  const list = candidates(roots());
  if (!cur || !cur.isConnected || !list.includes(cur)) setFocus(defaultItem(list));
  return list;
}

const span = (a1, a2, b1, b2) => (b2 < a1 ? a1 - b2 : b1 > a2 ? b1 - a2 : 0);

/** Nearest item that way: beyond the current edge, favouring overlap on the cross axis. */
function move(dir) {
  const list = sync();
  if (!cur) return;
  const a = cur.getBoundingClientRect();
  const acx = (a.left + a.right) / 2;
  const acy = (a.top + a.bottom) / 2;
  let best = null;
  let bestScore = Infinity;
  for (const node of list) {
    if (node === cur) continue;
    const b = node.getBoundingClientRect();
    const bcx = (b.left + b.right) / 2;
    const bcy = (b.top + b.bottom) / 2;
    let gap;
    let cross;
    if (dir === 'down') { if (bcy <= acy) continue; gap = Math.max(0, b.top - a.bottom); cross = span(a.left, a.right, b.left, b.right); }
    else if (dir === 'up') { if (bcy >= acy) continue; gap = Math.max(0, a.top - b.bottom); cross = span(a.left, a.right, b.left, b.right); }
    else if (dir === 'right') { if (bcx <= acx) continue; gap = Math.max(0, b.left - a.right); cross = span(a.top, a.bottom, b.top, b.bottom); }
    else { if (bcx >= acx) continue; gap = Math.max(0, a.left - b.right); cross = span(a.top, a.bottom, b.top, b.bottom); }
    const score = gap + cross * 3;
    if (score < bestScore) { bestScore = score; best = node; }
  }
  if (best) setFocus(best);
  else if (dir === 'up' || dir === 'down') scrollPage(dir);
}

/** Nothing more that way (a read-only stretch of page): scroll instead. */
function scrollPage(dir) {
  const sc = roots()[0]?.closest?.('.rl-scroller') ?? roots()[0];
  if (sc && sc.scrollHeight > sc.clientHeight + 1) sc.scrollBy({ top: (dir === 'down' ? 1 : -1) * sc.clientHeight * 0.6, behavior: 'smooth' });
}

const controlOf = (node) => (node.matches('label') ? node.control : null);

function stepSlider(input, dir) {
  const min = +input.min || 0;
  const max = input.max === '' ? 100 : +input.max;
  const step = (max - min) / 20;
  input.value = Math.min(max, Math.max(min, +input.value + (dir === 'right' ? step : -step)));
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

/** After an action that may open or close a layer, move the ring once it has rendered. */
function settle() {
  setTimeout(sync, 80);
  setTimeout(sync, 450);
}

function activate() {
  sync();
  if (!cur) return;
  const target = controlOf(cur) ?? cur;
  if (isText(target)) { target.focus(); settle(); return; }
  if (target.matches('input[type=range]')) return;
  target.click();
  settle();
}

function goBack() {
  if (keyboardEl()) hideKeyboard();
  else if (!dismissTop()) back();
  settle();
}

/** Home steps through the tabs (总览 → 文件 → 连接 → 设置 → 总览), each on the page it was left on; anything open on top closes first. */
function nextTabPressed() {
  hideKeyboard();
  dismissAll();
  nextTab();
  settle();
}

/** Volume keys: the default output, ±5 %, or mute. */
async function volume(delta) {
  try {
    const a = await api.get('audio');
    const out = (a.outputs || []).find((o) => o.default);
    if (!out) { toast(t('volume.none')); return; }
    if (delta === 0) {
      const m = await api.put('audio/mute', { id: out.id });
      toast(t(m.muted ? 'volume.muted' : 'volume.unmuted'));
      return;
    }
    const v = Math.max(0, Math.min(1, Math.round(((out.volume || 0) + delta) * 20) / 20));
    await api.put('audio/volume', { id: out.id, volume: v });
    toast(t('volume.level', { n: Math.round(v * 100) }));
  } catch { /* the sound server is down; Settings › 声音 says why */ }
}

function handle(key) {
  if (key === 'AudioVolumeUp') { volume(0.05); return true; }
  if (key === 'AudioVolumeDown') { volume(-0.05); return true; }
  if (key === 'AudioVolumeMute') { volume(0); return true; }
  const first = !remoteOn();
  document.body.classList.add('is-remote');
  if (first && key.startsWith('Arrow')) { sync(); return true; } // the first press only shows where focus is
  switch (key) {
    case 'ArrowUp': move('up'); return true;
    case 'ArrowDown': move('down'); return true;
    case 'ArrowLeft':
    case 'ArrowRight': {
      sync();
      const dir = key === 'ArrowLeft' ? 'left' : 'right';
      const range = cur && (cur.matches('input[type=range]') ? cur : null);
      if (range) stepSlider(range, dir);
      else move(dir);
      return true;
    }
    case 'Enter': activate(); return true;
    case 'Escape':
    case 'BrowserBack': goBack(); return true;
    case 'BrowserHome': nextTabPressed(); return true;
    case 'ContextMenu': menuPressed.emit(); settle(); return true;
    default: return false;
  }
}

export function mountRemote(dockEl) {
  dock = dockEl;
  document.addEventListener('keydown', (e) => {
    // Real keys only: the keyboard's return key sends a synthetic Enter to
    // its field, which belongs to the field's own handler.
    if (!e.isTrusted) return;
    // In a field without the on-screen keyboard, the keys belong to the field.
    if (isText(e.target) && !keyboardEl() && e.key !== 'Escape') return;
    if (handle(e.key)) { e.preventDefault(); e.stopPropagation(); }
  }, true);
  window.navBridge?.onKey(handle);
  document.addEventListener('pointerdown', (e) => { if (e.isTrusted) document.body.classList.remove('is-remote'); }, true);
  const resync = () => { if (remoteOn()) settle(); };
  layersChanged.on(resync);
  routeChanged.on(resync);
}
