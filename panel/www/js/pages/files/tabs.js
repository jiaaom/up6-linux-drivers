// 文件's tabs as title slips (Ridgeline Files › Tabs, TitleSlip › Slips as
// tabs; 一函多册). Up to three places open at once, each its own stack of
// pages in the router: the current slip in front, the others a layer behind
// showing two characters, a blank dashed slip with + that opens 文件's first
// page. The × on the current slip, or a long press on any slip, closes.
//
// Signed in or not: signed out there are no tabs (one slip, no +); a lapsed
// session keeps the tabs that are open but adds none; signing out closes them
// (data/session.js → router.resetTab). Tabs are never restored after a restart.

import { html, on } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { t } from '../../core/i18n.js';
import { account } from '../../data/stores.js';
import { confirm, sheet, toast } from '../../shell/layers.js';
import {
  MAX_SLIP_TABS, closeOtherSlipTabs, closeSlipTab, openSlipTab, slipTabs, slipTabsChanged, switchSlipTab,
} from '../../shell/router.js';

const LONG_PRESS_MS = 500;

const signedIn = () => !!account.data?.signedIn;

/** Whether another tab can open now (signed in, fewer than three). */
export const canOpenTab = () => signedIn() && slipTabs('files').length < MAX_SLIP_TABS;

/**
 * The head's slip: the current page's slip (`inner`, the slip's content)
 * alone, or the row of slip tabs. `locked` while picking items: the others
 * and + rest, and the current slip has no ×.
 */
export function slipHead(inner, { locked = false } = {}) {
  const tabs = slipTabs('files');
  // several tabs, or one with room to add another; a lapsed session keeps its tabs
  const row = tabs.length > 1 || (signedIn() && !locked);
  if (!row) return html`<h1 class="rl-slip rl-panel__slip">${inner}</h1>`;
  const several = tabs.length > 1;
  const cur = tabs.find((x) => x.current);
  return html`<div class="rl-sliptabs${locked ? ' is-locked' : ''}${several ? '' : ' is-single'}" role="tablist" aria-label="${t('tabs.label')}">
    <h1 class="rl-slip rl-panel__slip rl-sliptab is-current" role="tab" aria-selected="true" data-sliptab="${cur?.id}">${inner}${several && !locked
      ? html`<button class="rl-sliptab__close" data-sliptab-close aria-label="${t('tabs.close')}">${icon('x')}</button>` : ''}</h1>
    ${tabs.filter((x) => !x.current).map((x) => html`<button class="rl-sliptab" role="tab" aria-selected="false" aria-label="${x.label}" data-sliptab="${x.id}"><span>${x.label}</span></button>`)}
    ${canOpenTab() ? html`<button class="rl-sliptab rl-sliptab--add" data-sliptab-add aria-label="${t('tabs.new')}">${icon('plus')}</button>` : ''}
  </div>`;
}

/** The × on the current slip asks first: closing loses the tab's place. */
async function confirmClose(id) {
  const tab = slipTabs('files').find((x) => x.id === id);
  if (!tab) return;
  const ok = await confirm({ title: t('tabs.closeTitle', { name: tab.label }), body: t('tabs.closeBody'), action: t('tabs.closeAction'), actionIcon: 'x' });
  if (ok) closeSlipTab(id);
}

/** The long-press menu of a slip: close it, or close the others (the menu is the second step, so no dialog). */
async function tabMenu(id) {
  const tabs = slipTabs('files');
  const tab = tabs.find((x) => x.id === id);
  if (!tab || tabs.length < 2) return;
  const choice = await sheet({
    title: tab.label,
    sub: t('tabs.count', { n: tabs.length }),
    actions: [
      { id: 'close', icon: 'x', label: t('tabs.close') },
      { id: 'others', icon: 'x-square', label: t('tabs.closeOthers') },
    ],
  });
  if (choice === 'close') closeSlipTab(id);
  else if (choice === 'others') closeOtherSlipTabs(id);
}

/** Open `factory` (a folder page) in a new tab; at three tabs, say so and stay. */
export async function openInNewTab(factory, params) {
  if (!canOpenTab()) { toast(t('tabs.full')); return; }
  await openSlipTab(factory, params);
}

/**
 * Make the slips in `ctx.el` work, and re-render the page (`render`) when the
 * tabs change while it is on screen (`isShown`).
 */
export function wireSlipTabs(ctx, render, isShown) {
  let press = null;
  on(ctx.el, 'pointerdown', '[data-sliptab]', (e, n) => {
    if (n.closest('.is-locked') || e.target.closest('[data-sliptab-close]')) return;
    const id = n.dataset.sliptab;
    press = { x: e.clientX, y: e.clientY, fired: false, timer: setTimeout(() => { press.fired = true; tabMenu(id); }, LONG_PRESS_MS) };
  });
  const cancel = () => { if (press) clearTimeout(press.timer); };
  ctx.el.addEventListener('pointerup', cancel);
  ctx.el.addEventListener('pointercancel', cancel);
  ctx.el.addEventListener('pointermove', (e) => { if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 8) cancel(); });
  on(ctx.el, 'click', '[data-sliptab]', (e, n) => {
    if (e.target.closest('[data-sliptab-close]')) return;
    const fired = press?.fired;
    press = null;
    if (fired || n.classList.contains('is-current')) return; // the long press already opened its menu
    switchSlipTab(n.dataset.sliptab);
  });
  on(ctx.el, 'click', '[data-sliptab-close]', (e, b) => {
    e.preventDefault();
    confirmClose(b.closest('[data-sliptab]').dataset.sliptab);
  });
  on(ctx.el, 'click', '[data-sliptab-add]', () => { if (canOpenTab()) openSlipTab(); });
  ctx.own(slipTabsChanged.on((tabId) => { if (tabId === 'files' && isShown()) render(); }));
}
