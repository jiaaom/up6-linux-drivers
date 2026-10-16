// Markup for 版面 boards (Ridgeline components/Dashboard): sections divided by
// rules inside the one panel, figures, meters, small readings and lists.

import { html } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { getLang, t } from '../core/i18n.js';
import en from '../strings/en.js';

/** A section's head: Chinese with the English word beside it (English alone in English). */
export function sec(id, { iconName, count, go = false } = {}) {
  const small = getLang() === 'zh' && en[id] ? html`<small>${en[id]}</small>` : '';
  return html`<h2 class="rl-board__sec${iconName ? ' rl-board__sec--icon' : ''}">${iconName ? html`<span class="rl-board__icon">${icon(iconName, 'light')}</span>` : ''}${t(id)}${small}${count ? html`<span class="rl-board__count">${count}</span>` : ''}${go ? icon('caret-right', 'regular', 'rl-board__go') : ''}</h2>`;
}

/** A cell; `href`-like `open` makes it a link (data-open="…"). */
export const cell = (body, { open, style } = {}) => (open
  ? html`<a class="rl-board__cell" href="#" data-open="${open}"${style ? html` style="${style}"` : ''}>${body}</a>`
  : html`<div class="rl-board__cell"${style ? html` style="${style}"` : ''}>${body}</div>`);

/** Two cells side by side (only when both are there; one alone takes the row). */
export const split = (a, b) => (a && b ? html`<div class="rl-board__split">${a}${b}</div>` : a || b || '');

export function figure(num, unit, { hero = false, sm = false, tag = '' } = {}) {
  return html`<p class="rl-figure${hero ? ' rl-figure--hero' : ''}${sm ? ' rl-figure--sm' : ''}"><span class="rl-figure__num">${num}</span>${unit ? html`<span class="rl-figure__unit">${unit}</span>` : ''}${tag}</p>`;
}

/** Meter level by value: vine under 70, ochre to 90, cinnabar above. */
export const level = (v) => (v >= 90 ? 'alert' : v >= 70 ? 'warn' : '');

/** The bare meter track, with an optional threshold post. */
export const track = (v, { label, mark, style = '' } = {}) =>
  html`<span class="rl-meter__track" role="meter" aria-label="${label}" aria-valuenow="${Math.round(v)}" aria-valuemin="0" aria-valuemax="100"${mark != null ? html` data-mark` : ''} style="--v:${Math.round(v)}${mark != null ? `;--mark:${mark}` : ''}${style ? `;${style}` : ''}"></span>`;

/** A compact meter with a label and readout. */
export function compactMeter(v, label, readout = '') {
  const lv = level(v);
  return html`<div class="rl-meter rl-meter--compact${lv ? ` rl-meter--${lv}` : ''}"><div class="rl-meter__head"><span class="rl-meter__label">${label}</span><span class="rl-meter__readout">${readout}</span></div>${track(v, { label })}</div>`;
}

export const foot = (l, r) => html`<div class="rl-meter__foot" style="margin-top:6px"><span>${l}</span><span>${r ?? ''}</span></div>`;

/** Small boxed readings: [{ value, label, iconName?, level? ('warn' | 'alert') }]. */
export const cellset = (items, cols) => html`<div class="rl-cellset"${cols ? html` style="--rl-cells:${cols}"` : ''}>${items.map((i) => html`<span class="rl-cellset__item${i.level ? ` rl-cellset__item--${i.level}` : ''}">${i.iconName ? icon(i.iconName) : ''}<b>${i.value}</b><small>${i.label}</small></span>`)}</div>`;

/** Names in two columns; a hollow mark for stopped ones. */
export const statuslist = (items) => html`<ul class="rl-statuslist">${items.map((i) => html`<li class="rl-statuslist__item${i.off ? ' is-off' : ''}"><b>${i.name}</b><small>${i.sub}</small></li>`)}</ul>`;

/** Label · value rows with dotted rules: [{ label, value, muted?, iconName? }]. */
export const kv = (rows) => html`<ul class="rl-kv">${rows.filter(Boolean).map((r) => html`<li><span>${r.iconName ? icon(r.iconName) : ''}${r.label}</span><b${r.muted ? html` class="is-muted"` : ''}>${r.value}</b></li>`)}</ul>`;

export const cap = (text) => html`<p class="rl-board__cap">${text}</p>`;
