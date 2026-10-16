// Small DOM helpers. Pages build their markup as HTML strings with `html`,
// which escapes every interpolated value unless it was wrapped in `raw`.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
}

class Raw {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}

/** Mark trusted markup so `html` inserts it unescaped. */
export const raw = (s) => new Raw(String(s ?? ''));

function part(v) {
  if (v == null || v === false) return '';
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(part).join('');
  return esc(v);
}

/** Tagged template: html`<p>${text}</p>` → Raw markup with values escaped. */
export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += part(values[i]) + strings[i + 1];
  return new Raw(out);
}

/** Parse markup into a single element. */
export function el(markup) {
  const t = document.createElement('template');
  t.innerHTML = String(markup).trim();
  return t.content.firstElementChild;
}

/** A field the on-screen keyboard types into. */
export const isText = (node) =>
  node?.tagName === 'TEXTAREA' ||
  (node?.tagName === 'INPUT' && /^(text|password|search|email|number|tel|url)$/.test(node.type));

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Delegated listener: fn(event, matchedElement). Returns an unsubscribe. */
export function on(root, type, selector, fn, opts) {
  const handler = (e) => {
    const t = e.target.closest?.(selector);
    if (t && root.contains(t)) fn(e, t);
  };
  root.addEventListener(type, handler, opts);
  return () => root.removeEventListener(type, handler, opts);
}

/** Keep a pointer's moves on `node` while it drags (a no-op if the pointer is already gone). */
export function capture(node, pointerId) {
  try { node.setPointerCapture(pointerId); } catch { /* released already */ }
}

/** Resolve once `node` finishes its animation (or after `ms`, whichever is first). */
export function afterAnimation(node, ms = 400) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    node.addEventListener('animationend', (e) => { if (e.target === node) finish(); });
    setTimeout(finish, ms);
  });
}

/**
 * Paint a page's markup when it changed, but never under a finger (a slider
 * mid-drag) or while a field inside has focus: that paint waits until the
 * finger lifts or the field is left. Polls can then repaint freely.
 */
export function painter(el) {
  let last = '';
  let pending = null;
  let down = false;
  const typing = () => el.contains(document.activeElement) && isText(document.activeElement);
  const busy = () => down || typing();
  const flush = () => {
    if (pending == null || busy()) return;
    const s = pending;
    pending = null;
    paint(s);
  };
  el.addEventListener('pointerdown', () => { down = true; });
  for (const type of ['pointerup', 'pointercancel']) el.addEventListener(type, () => { down = false; setTimeout(flush, 0); });
  el.addEventListener('focusout', () => setTimeout(flush, 0));
  function paint(markup) {
    const s = String(markup);
    if (s === last) return;
    if (busy()) { pending = s; return; }
    last = s;
    el.innerHTML = s;
  }
  return paint;
}
