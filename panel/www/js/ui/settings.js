// Markup for settings rows (Ridgeline components/Settings). A row opens a
// page (link), carries a switch, holds a block control (segments or a
// slider), or runs an action. Pages wire behaviour through the data-*
// attributes passed in `attrs` (Raw markup, e.g. html` data-act="ssh"`).

import { html } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { getLang, t } from '../core/i18n.js';
import en from '../strings/en.js';

const lead = (name) => (name ? icon(name, 'light', 'rl-set__icon') : '');
const sub = (text) => (text ? html`<span class="rl-set__sub">${text}</span>` : '');

/** Group heading: the Chinese word with the English one beside it; English alone in English. */
export function section(id, extra = '') {
  const small = getLang() === 'zh' && en[id] ? html`<small>${en[id]}</small>` : '';
  return html`<h2 class="rl-set__sec">${t(id)}${small}${extra}</h2>`;
}

export const list = (rows) => html`<ul class="rl-set__list">${rows.filter(Boolean).map((r) => html`<li>${r}</li>`)}</ul>`;

/** `sub`: a child row, only there because of the row above (no icon, indented). */
export function linkRow({ iconName, lead: leading, label, subText, value, sub: child = false, attrs = '' }) {
  return html`<a class="rl-set__row${child ? ' rl-set__row--sub' : ''}" href="#"${attrs}>${leading ?? lead(iconName)}<span class="rl-set__label">${label}${sub(subText)}</span>${value != null && value !== '' ? html`<span class="rl-set__value">${value}</span>` : ''}${icon('caret-right', 'regular', 'rl-set__go')}</a>`;
}

export function switchRow({ iconName, label, subText, checked, disabled = false, sub: child = false, attrs = '' }) {
  return html`<label class="rl-set__row${child ? ' rl-set__row--sub' : ''}">${lead(iconName)}<span class="rl-set__label">${label}${sub(subText)}</span><input class="rl-switch__input" type="checkbox" role="switch"${checked ? html` checked` : ''}${disabled ? html` disabled` : ''}${attrs}></label>`;
}

export function actionRow({ iconName, label, danger = false, attrs = '' }) {
  return html`<button class="rl-set__row${danger ? ' rl-set__row--danger' : ''}"${attrs}>${lead(iconName)}<span class="rl-set__label">${label}</span></button>`;
}

/** Segments under a label: options [{ value, label }], `current` is pressed; `sub` as linkRow. */
export function segRow({ iconName, label, current, options, sub: child = false, attrs = '' }) {
  return html`<div class="rl-set__block${child ? ' rl-set__block--sub' : ''}"><div class="rl-set__head">${lead(iconName)}<span class="rl-set__label">${label}</span></div>
    <div class="rl-seg rl-glass" role="group" aria-label="${label}"${attrs}>${options.map((o) => html`<button class="rl-seg__btn" data-value="${o.value}" aria-pressed="${String(o.value) === String(current)}">${o.label}</button>`)}</div></div>`;
}

/** A slider under a label; value 0–100, shown as `valueText` beside the label. */
export function sliderRow({ iconName, label, value, valueText, attrs = '' }) {
  return html`<div class="rl-set__block"><div class="rl-set__head">${lead(iconName)}<span class="rl-set__label">${label}</span><span class="rl-set__value" data-slider-value>${valueText}</span></div>
    <input class="rl-slider" type="range" min="0" max="100" value="${value}" style="--v:${value}" aria-label="${label}"${attrs}></div>`;
}

/** Fact rows: [{ iconName, label, value }]. */
export const facts = (rows) =>
  html`<ul class="rl-kv rl-kv--set">${rows.filter(Boolean).map((r) => html`<li><span>${icon(r.iconName)}${r.label}</span><b>${r.value ?? '—'}</b></li>`)}</ul>`;

export const foot = (text, style = '') => html`<p class="rl-set__foot"${style ? html` style="${style}"` : ''}>${text}</p>`;
export const note = (text) => html`<p class="rl-set__note">${text}</p>`;

/** Keep a slider's fill (--v) and its value text in step while it moves. */
export function trackSlider(input, format = (v) => `${v}%`) {
  input.style.setProperty('--v', input.value);
  const out = input.closest('.rl-set__block')?.querySelector('[data-slider-value]');
  if (out) out.textContent = format(+input.value);
}

/** Press one segment of a group (optimistically, before the backend answers). */
export function pressSegment(btn) {
  for (const b of btn.parentElement.children) b.setAttribute('aria-pressed', String(b === btn));
}
