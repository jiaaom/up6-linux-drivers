// Form fields (Ridgeline components/Input): the ledger-line input with a
// label, a password field with its show / hide button, and the error line.

import { html, on } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { t } from '../core/i18n.js';

export function textField({ id, label, value = '', type = 'text', autocomplete = 'off', style = 'margin-top:12px' }) {
  return html`<div class="rl-field" style="${style}"><label class="rl-field__label" for="${id}">${label}</label>
    <input class="rl-input" id="${id}" type="${type}" value="${value}" autocomplete="${autocomplete}" autocapitalize="off" spellcheck="false"></div>`;
}

export function passwordField({ id, label, value = '', style = 'margin-top:12px' }) {
  return html`<div class="rl-field" style="${style}"><label class="rl-field__label" for="${id}">${label}</label>
    <div class="rl-control"><input class="rl-input" id="${id}" type="password" value="${value}" autocomplete="off">
      <button class="rl-control__action" type="button" data-reveal aria-pressed="false" aria-label="${t('account.showPassword')}">${icon('eye')}</button></div></div>`;
}

/** The error line a dialog or form fills in (hidden while empty). */
export const errorLine = () => html`<p class="rl-field__error" data-error hidden>${icon('warning-circle')}<span></span></p>`;

/** Make every show-password button inside `root` work, without taking focus out of the field. */
export function wireReveal(root) {
  on(root, 'pointerdown', '[data-reveal]', (e) => e.preventDefault());
  on(root, 'click', '[data-reveal]', (e, b) => {
    const show = b.getAttribute('aria-pressed') !== 'true';
    b.setAttribute('aria-pressed', String(show));
    b.setAttribute('aria-label', t(show ? 'account.hidePassword' : 'account.showPassword'));
    b.innerHTML = String(icon(show ? 'eye-slash' : 'eye'));
    const input = b.parentElement.querySelector('input');
    input.type = show ? 'text' : 'password';
  });
}
