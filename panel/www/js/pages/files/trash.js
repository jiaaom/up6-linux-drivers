// 文件 › 回收站: what was deleted, when each will be cleared, 恢复 on every row,
// and 清空回收站 at the end (always asked first; it cannot be undone).

import { api } from '../../core/api.js';
import { html, on, painter } from '../../core/dom.js';
import { day } from '../../core/format.js';
import { t } from '../../core/i18n.js';
import { panel } from '../../core/panel.js';
import { resource } from '../../core/resource.js';
import { userForgotten } from '../../data/session.js';
import { account } from '../../data/stores.js';
import { confirm, toast } from '../../shell/layers.js';
import { ficon } from '../../ui/files.js';
import { subpage } from '../../ui/page.js';
import { empty, loadFailed, skeletonRows } from '../../ui/states.js';
import { failed } from './actions.js';

export const trashList = resource('trash', async () => {
  const d = await api.get('fnos/trash');
  return (d.files ?? []).map((f) => ({ name: f.name, dir: !!f.dir, size: f.size ?? 0, mtime: f.mtim, removed: f.rmTime, v: f.v, uid: f.uid }));
}, { persist: false });
userForgotten.on(() => trashList.reset());

const internalPath = (x) => `vol${x.v ?? 1}/${x.uid ?? account.data?.uid}/.@#local/trash/${x.name}`;

export default function trashPage(ctx) {
  const paint = painter(ctx.el);

  function render() {
    const list = trashList.data;
    let body;
    if (!list) body = trashList.status === 'failed' ? loadFailed() : skeletonRows(4);
    else if (!list.length) body = html`<div style="padding:28px 0">${empty({ iconName: 'trash', title: t('trash.empty'), body: t('trash.emptyBody') })}</div>`;
    else {
      const rows = [...list].sort((a, b) => a.removed - b.removed).map((x, i) => html`<li><div class="rl-set__row rl-set__row--file"><span class="rl-toc__lead">${ficon(x)}</span>
        <span class="rl-set__label">${x.name}<span class="rl-set__sub">${t('trash.deleted', { when: day(x.removed) })}</span></span>
        <button class="rl-btn rl-btn--secondary rl-btn--sm" data-restore="${i}">${t('trash.restore')}</button></div></li>`);
      body = html`<p class="rl-set__note" style="padding-top:14px">${t('trash.note')}</p><ul class="rl-set__list">${rows}</ul>
        <button class="rl-btn rl-btn--danger rl-btn--block" style="margin:16px 0 18px" data-clear>${t('trash.clear')}</button>`;
    }
    const head = list?.length ? html`<div class="rl-toolbar"><span class="rl-board__updated" style="margin-left:0">${t('files.count', { n: list.length })}</span></div>` : '';
    paint(subpage(ctx, { slip: 'page.trash', head, body: html`<div class="rl-set">${body}</div>`, hostName: panel.data?.host?.name }));
  }

  on(ctx.el, 'click', '[data-restore]', async (e, b) => {
    const x = [...trashList.data].sort((a, c) => a.removed - c.removed)[+b.dataset.restore];
    try {
      await api.post('fnos/trash/restore', { paths: [internalPath(x)] });
      toast(t('trash.restored', { name: x.name }));
    } catch (err) { failed(err); }
    trashList.refresh();
  });
  on(ctx.el, 'click', '[data-clear]', async () => {
    const ok = await confirm({ title: t('trash.clearTitle'), body: t('trash.clearBody', { n: trashList.data.length }), action: t('trash.clearAction'), actionIcon: 'trash', kind: 'danger' });
    if (!ok) return;
    try {
      await api.post('fnos/trash/clear');
      toast(t('trash.cleared'));
    } catch (err) { failed(err); }
    trashList.refresh();
  });
  on(ctx.el, 'click', '[data-retry]', () => trashList.refresh());

  ctx.own(trashList.changed.on(render));
  return { title: 'page.trash', render, show: () => trashList.refresh() };
}
