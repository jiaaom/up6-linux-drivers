// Backend unreachable: nothing on any tab can be trusted, so one page covers
// the whole app (no tab bar, no control center) and retries by itself. When
// the backend answers again, the app is back on the page it was on.

import { el, html } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { t } from '../core/i18n.js';
import { backend } from '../core/panel.js';
import { busyRing } from '../ui/states.js';
import { hideKeyboard } from './keyboard.js';
import { clockOnly } from './statusbar.js';

let screen = null;
let page = null;

/** The offline page while it is up, else null. */
export function offlineEl() {
  return page;
}

function body() {
  return html`<div class="rl-backdrop rl-backdrop--sky" aria-hidden="true"></div>
    ${clockOnly()}
    <div class="rl-offline" role="alert">
      <span class="rl-offline__icon">${icon('plugs', 'light')}</span>
      <h1 class="rl-offline__title">${t('offline.title')}</h1>
      <p class="rl-offline__body">${t('offline.body')}</p>
      <p class="rl-offline__retry">${busyRing(t('offline.ring'))}${t('offline.retry', { n: backend.tries })}</p>
    </div>`;
}

function update() {
  if (!backend.online) {
    if (!page) {
      hideKeyboard();
      page = el(html`<div class="t6-offline rl-silk rl-backdrop-host"></div>`);
      screen.appendChild(page);
    }
    page.innerHTML = String(body());
  } else if (page) {
    page.remove();
    page = null;
  }
}

export function mountOffline(screenEl) {
  screen = screenEl;
  backend.changed.on(update);
}
