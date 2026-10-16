// Floating layers over the page: bottom sheets, dialogs and the toast.
// (The control center is a layer too; it registers itself through openLayer.)
//
// Layers stack; Back and the remote act on the top one. Each layer animates
// itself on mount (Ridgeline Motion); closing adds .is-leaving and removes it
// once the animation ends.

import { afterAnimation, el, html, on } from '../core/dom.js';
import { emitter } from '../core/events.js';
import { icon } from '../core/icons.js';
import { t } from '../core/i18n.js';

let host = null;
let toastRegion = null;
const stack = []; // { el, dismiss() }

export const layersChanged = emitter();

/** The top layer's element, or null. */
export function topLayer() {
  return stack[stack.length - 1]?.el ?? null;
}

/** Put `node` on top. `dismiss` is what Back (or a scrim tap) does. */
export function openLayer(node, dismiss) {
  host.appendChild(node);
  const entry = { el: node, dismiss };
  stack.push(entry);
  layersChanged.emit();
  return entry;
}

/** Take a layer down with its leaving animation. */
export async function closeLayer(entry, { animate = true } = {}) {
  const i = stack.indexOf(entry);
  if (i < 0) return;
  stack.splice(i, 1);
  layersChanged.emit();
  if (animate) {
    entry.el.classList.add('is-leaving');
    await afterAnimation(entry.el.lastElementChild ?? entry.el, 300);
  }
  entry.el.remove();
}

/** Back on a layer: dismiss the top one. Returns false when there is none. */
export function dismissTop() {
  const top = stack[stack.length - 1];
  if (!top) return false;
  top.dismiss();
  return true;
}

export function dismissAll() {
  while (stack.length) {
    const n = stack.length;
    dismissTop();
    if (stack.length === n) closeLayer(stack[n - 1], { animate: false });
  }
}

/** Close on a downward swipe of `target` (sheets, the keyboard). */
export function swipeDown(target, onSwipe, distance = 60) {
  let y0 = null;
  target.addEventListener('pointerdown', (e) => { y0 = e.clientY; });
  target.addEventListener('pointerup', (e) => {
    if (y0 != null && e.clientY - y0 > distance) onSwipe();
    y0 = null;
  });
  target.addEventListener('pointercancel', () => { y0 = null; });
}

/**
 * Bottom sheet of actions. Resolves to the chosen action's id, or null.
 *   actions: [{ id, icon, label, danger?, disabled?, hint? }]
 *   head: markup in place of the title head (an item's icon and name)
 */
export function sheet({ title, sub, actions, head }) {
  return new Promise((resolve) => {
    const node = el(html`<div class="rl-overlay rl-overlay--bottom">
      <div class="rl-scrim" data-dismiss></div>
      <div class="rl-sheet" role="dialog" aria-modal="true" aria-label="${title}">
        ${head ?? html`<div class="rl-sheet__head"><h2 class="rl-sheet__title">${title}</h2>${sub ? html`<p class="rl-sheet__sub">${sub}</p>` : ''}</div>`}
        <ul class="rl-sheet__actions">${actions.map((a) => html`<li><button class="rl-sheet__action${a.danger ? ' rl-sheet__action--danger' : ''}" data-id="${a.id}"${a.disabled ? html` disabled` : ''}>${icon(a.icon, 'light')}${a.label}${a.hint ? html`<span class="rl-sheet__hint">${a.hint}</span>` : ''}</button></li>`)}</ul>
      </div>
      <button class="rl-btn rl-btn--secondary rl-btn--block rl-sheet__cancel" data-dismiss>${t('common.cancel')}</button>
    </div>`);
    const done = (id) => { closeLayer(entry); resolve(id); };
    const entry = openLayer(node, () => done(null));
    on(node, 'click', '[data-dismiss]', () => done(null));
    on(node, 'click', '[data-id]', (e, b) => done(b.dataset.id));
    swipeDown(node.querySelector('.rl-sheet'), () => done(null));
  });
}

/**
 * A dialog with exactly two ways out. Resolves true for the action, false for 取消.
 *   kind: 'danger' | 'primary';  top: place it above the keyboard (holds a field)
 *   content: extra markup between the body and the buttons (a code, a field)
 *   onOpen(node): wire the content once it is on screen
 *   check(node, button): before closing on the action; return an error
 *     message to keep the dialog open (shown in its [data-error] line), or a
 *     promise of one (the action button is busy meanwhile)
 */
export function confirm({ title, body, action, actionIcon, kind = 'primary', content = '', top = false, onOpen, check }) {
  return new Promise((resolve) => {
    const node = el(html`<div class="rl-overlay ${top ? 'rl-overlay--top' : 'rl-overlay--center'}">
      <div class="rl-scrim" data-cancel></div>
      <div class="rl-dialog" role="alertdialog" aria-modal="true" aria-label="${title}">
        <h2 class="rl-dialog__title">${title}</h2>
        ${body ? html`<p class="rl-dialog__body">${body}</p>` : ''}
        ${content}
        <div class="rl-dialog__actions">
          <button class="rl-btn rl-btn--secondary" data-cancel>${t('common.cancel')}</button>
          <button class="rl-btn rl-btn--${kind}" data-ok>${actionIcon ? icon(actionIcon) : ''}${action}</button>
        </div>
      </div>
    </div>`);
    const done = (ok) => { closeLayer(entry); resolve(ok); };
    const entry = openLayer(node, () => done(false));
    on(node, 'click', '[data-cancel]', () => done(false));
    on(node, 'click', '[data-ok]', async (e, btn) => {
      if (!check) { done(true); return; }
      btn.disabled = true;
      const error = await check(node, btn);
      btn.disabled = false;
      const line = node.querySelector('[data-error]');
      if (line) { line.hidden = !error; line.querySelector('span').textContent = error || ''; }
      if (!error) done(true);
    });
    onOpen?.(node);
  });
}

/**
 * A bottom sheet with its own content and one button below it (完成 or 取消).
 * `mount(sheetEl)` fills and wires the sheet; it may return a cleanup.
 * Resolves when the sheet closes.
 */
export function panelSheet({ title, closeLabel, mount, head }) {
  return new Promise((resolve) => {
    const node = el(html`<div class="rl-overlay rl-overlay--bottom">
      <div class="rl-scrim" data-dismiss></div>
      <div class="rl-sheet" role="dialog" aria-modal="true" aria-label="${title}">
        ${head ?? html`<div class="rl-sheet__head"><h2 class="rl-sheet__title">${title}</h2></div>`}
        <div data-body></div>
      </div>
      <button class="rl-btn rl-btn--secondary rl-btn--block rl-sheet__cancel" data-dismiss>${closeLabel ?? t('common.done')}</button>
    </div>`);
    let cleanup = null;
    const done = () => { cleanup?.(); closeLayer(entry); resolve(); };
    const entry = openLayer(node, done);
    on(node, 'click', '[data-dismiss]', done);
    swipeDown(node.querySelector('.rl-sheet'), done);
    cleanup = mount(node.querySelector('[data-body]'), done);
  });
}

let toastTimer = 0;

/** "Done" message above the tab bar: 4 s, or 6 s with an action (撤销). */
export function toast(message, { iconName, action, onAction } = {}) {
  clearTimeout(toastTimer);
  const old = toastRegion.querySelector('.rl-toast');
  if (old) old.remove();
  const node = el(html`<div class="rl-toast" role="status">
    ${iconName ? icon(iconName) : ''}<span class="rl-toast__msg">${message}</span>
    ${action ? html`<button class="rl-toast__action">${action}</button>` : ''}
  </div>`);
  toastRegion.appendChild(node);
  const leave = async () => {
    node.classList.add('is-leaving');
    await afterAnimation(node, 300);
    node.remove();
  };
  const ms = action ? 6000 : 4000;
  const arm = () => { clearTimeout(toastTimer); toastTimer = setTimeout(leave, ms); };
  node.addEventListener('pointerdown', () => clearTimeout(toastTimer)); // pause while touched
  node.addEventListener('pointerup', arm);
  node.querySelector('.rl-toast__action')?.addEventListener('click', () => { onAction?.(); leave(); });
  arm();
}

export function mountLayers(screenEl, regionEl) {
  host = screenEl;
  toastRegion = regionEl;
}
