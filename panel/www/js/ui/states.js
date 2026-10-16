// Empty, error and loading markup (Ridgeline components/States).

import { html } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { t } from '../core/i18n.js';

/** Empty or error state; `action` is one button (Raw markup) or nothing. */
export function empty({ iconName, title, body, action, error = false }) {
  return html`<div class="rl-empty ${error ? 'rl-empty--error' : ''}">
    ${icon(iconName, 'light')}
    <h2 class="rl-empty__title">${title}</h2>
    ${body ? html`<p class="rl-empty__body">${body}</p>` : ''}
    ${action ? html`<div class="rl-empty__actions">${action}</div>` : ''}
  </div>`;
}

/** The error state for a page whose first load failed; the button carries data-retry. */
export function loadFailed() {
  return empty({
    iconName: 'wifi-slash',
    title: t('common.loadFailed'),
    body: t('common.loadFailedBody'),
    action: html`<button class="rl-btn rl-btn--secondary" data-retry>${t('common.retry')}</button>`,
    error: true,
  });
}

/** The square busy ring (rl-ring). */
export function busyRing(label, size = 'sm') {
  return html`<svg class="rl-ring rl-ring--busy rl-ring--${size}" viewBox="0 0 24 24" role="img" aria-label="${label}"><path class="rl-ring__track" d="M12 3H21V21H3V3Z" pathLength="100"/><path class="rl-ring__bar" d="M12 3H21V21H3V3H12" pathLength="100"/></svg>`;
}

/** One skeleton block: kind = icon | title | text; width as a CSS length. */
export const skeleton = (kind, width) =>
  html`<div class="rl-skeleton rl-skeleton--${kind}"${width ? html` style="width:${width}"` : ''}></div>`;

/** Placeholder rows for a settings-style page that is still loading. */
export const skeletonRows = (n) => html`<div class="rl-skeleton-rows">${skeleton('title', '30%')}${Array.from({ length: n }, () => skeleton('text', '80%'))}</div>`;
