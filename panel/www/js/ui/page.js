// Markup for the parts every page shares: the sky at the top (天头), the page
// bar on the desk, and the one titled panel (文武线 frame with a title slip).

import { html, on } from '../core/dom.js';
import { panel } from '../core/panel.js';
import { bindResource } from '../core/resource.js';
import { icon } from '../core/icons.js';
import { slipText, t } from '../core/i18n.js';
import { loadFailed, skeletonRows } from './states.js';

export const backdrop = () => html`<div class="rl-backdrop rl-backdrop--sky" aria-hidden="true"></div>`;

/**
 * The 44px desk row above the panel.
 *   back:   title id of the parent page → a back link (pages below a tab)
 *   title:  plain desk title, when there is no back link (Raw markup allowed)
 *   meta:   short count or status
 *   action: one icon button (Raw markup)
 */
export function pagebar({ back, title, meta, action } = {}) {
  return html`<div class="rl-pagebar">
    ${back ? html`<a class="rl-backlink" href="#" data-back>${icon('caret-left')}${t(back)}</a>` : ''}
    ${!back && title ? html`<span class="rl-pagebar__title">${title}</span>` : ''}
    ${meta ? html`<p class="rl-pagebar__meta">${meta}</p>` : ''}
    ${action ?? ''}
  </div>`;
}

/**
 * The page bar of a tab's first page: the NAS's name with a live dot, and
 * the tab's status line (statusLine) where other pages have their meta.
 */
export function hostbar(name, status, action) {
  return html`<div class="rl-pagebar">
    <span class="rl-pagebar__title"><span class="rl-live" role="img" aria-label="${t('status.online')}"></span>${name ?? ''}</span>
    ${status ? statusLine(status) : ''}${action ?? ''}
  </div>`;
}

/**
 * A tab's status line: the short answer to "is this part all right?" (总览:
 * the NAS; 文件: the storage; 连接: the links; 设置: the system). `ok` is
 * plain meta text. `info`, `warn` and `err` are a link to where it is (attrs
 * carries its data-*), in ridge, ochre or rust, with a mark before the text.
 */
export function statusLine({ text, level = 'ok', attrs = '', iconName = 'warning-circle' }) {
  if (level === 'ok') return html`<p class="rl-pagebar__meta">${text}</p>`;
  if (!attrs) return html`<p class="rl-pagebar__meta rl-pagebar__status rl-pagebar__status--${level}">${icon(iconName)}<span>${text}</span></p>`;
  return html`<a class="rl-pagebar__status rl-pagebar__status--${level}" href="#"${attrs}>${icon(iconName)}<span>${text}</span></a>`;
}

/**
 * The titled panel: slip from a page.* id (or `slipMarkup` for a title that
 * is not a string id, such as a licence's name; or `slipHead`, the whole slip
 * element, for 文件's slip tabs), extra head content, the body.
 */
export function titledPanel({ slip, slipMarkup, slipHead, head = '', body = '', cls = '' }) {
  return html`<section class="rl-panel rl-panel--titled ${cls}">
    <div class="rl-panel__head">${slipHead ?? html`<h1 class="rl-slip rl-panel__slip">${slipMarkup ?? slipText(slip)}</h1>`}${head}</div>
    ${body}
  </section>`;
}

/** A whole page one level down: sky, back link with the NAS's name, titled panel. */
export function subpage(ctx, { slip, slipMarkup, head, body, hostName }) {
  return html`${backdrop()}${pagebar({ back: ctx.parent, meta: hostName })}${titledPanel({ slip, slipMarkup, head, body })}`;
}

/**
 * A page one level down whose panel shows one resource: cached data at once,
 * a skeleton when there is none yet, the error state with 重试 when the first
 * load failed. `body(data, res)` returns the markup inside the panel.
 * Returns the page's render() and a repaint() for changes made on the page.
 */
export function resourceSubpage(ctx, { slip, res, body, skeleton = () => skeletonRows(4) }) {
  let binding = null;
  on(ctx.el, 'click', '[data-retry]', () => res.refresh());
  ctx.own(() => binding?.stop());
  return {
    render() {
      ctx.el.innerHTML = String(subpage(ctx, { slip, hostName: panel.data?.host?.name, body: html`<div class="rl-set" data-body></div>` }));
      binding?.stop();
      binding = bindResource(ctx.el.querySelector('[data-body]'), res, { render: body, skeleton, error: loadFailed });
    },
    repaint: () => binding?.repaint(),
  };
}
