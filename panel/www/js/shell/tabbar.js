// The floating tab bar: 总览 · 文件 · 连接 · 设置. The current tab carries
// aria-current="page", which alone draws its label (缃 on indigo cloth by day,
// indigo on paper at night). Icons are Regular here, as Ridgeline asks.
//
// A page may put a bar in the dock with it: above the tab bar (the files
// clipboard bar) or in its place (the selection action bar). It sets the bar
// in show() and clears it in hide().

import { html, on } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { langChanged, t } from '../core/i18n.js';
import { TABS, currentTab, go, routeChanged } from './router.js';

let dock = null;
let above = null; // node shown over the tab bar
let instead = null; // node shown in place of the tab bar

/** Show `node` just above the tab bar (null clears it). */
export function setDockAbove(node) {
  above?.remove();
  above = node;
  if (node) dock.prepend(node);
}

/** Show `node` in place of the tab bar (null brings the tab bar back). */
export function setDockInstead(node) {
  instead?.remove();
  instead = node;
  const nav = dock.querySelector('nav');
  if (nav) nav.hidden = !!node;
  if (node) dock.append(node);
}

function render() {
  const cur = currentTab();
  dock.querySelector('nav')?.remove();
  dock.insertAdjacentHTML('beforeend', String(html`<nav class="rl-tabbar rl-tabbar--float" aria-label="${t('nav.main')}">
    ${TABS.map((tab) => html`<a class="rl-tabbar__item" href="#" data-tab="${tab.id}"${tab.id === cur ? html` aria-current="page"` : ''}>${icon(tab.icon, 'regular')}${t(tab.title)}</a>`)}
  </nav>`));
  if (above) dock.prepend(above);
  if (instead) { dock.querySelector('nav').hidden = true; dock.append(instead); }
}

function mark() {
  const cur = currentTab();
  for (const a of dock.querySelectorAll('[data-tab]')) {
    if (a.dataset.tab === cur) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
}

export function mountTabbar(dockEl) {
  dock = dockEl;
  render();
  on(dock, 'click', '[data-tab]', (e, a) => { e.preventDefault(); go(a.dataset.tab); });
  routeChanged.on(mark);
  langChanged.on(render);
}
