// 设置 › 系统更新: only says whether a newer fnOS is out, and what is in it.
// Installing happens in the fnOS web page: the NAS restarts, and the panel
// would lose its own backend mid-install.

import { html } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { t } from '../../core/i18n.js';
import { panel } from '../../core/panel.js';
import { resourceSubpage } from '../../ui/page.js';
import { foot, section } from '../../ui/settings.js';
import { firmware } from '../../data/stores.js';

/**
 * The release notes: "[Section]" lines become headings, every other line a
 * point. fnOS runs some sentences together ("processors.Fixed"); split those.
 */
function notes(text) {
  const items = (text || '').split('\n').flatMap((l) => l.split(/(?<=[a-z0-9)]\.)(?=[A-Z])/)).map((l) => l.trim()).filter(Boolean);
  return html`<ul class="rl-update__notes">${items.map((l) => {
    const head = /^\[(.+)\]$/.exec(l);
    return head ? html`<li class="rl-update__group">${head[1]}</li>` : html`<li>${l}</li>`;
  })}</ul>`;
}

/** Where the fnOS web page is, as people would type it. */
function webAddress() {
  const n = panel.data?.network;
  const ip = n?.ethernet?.connected ? n.ethernet.ip : n?.wifi?.connected ? n.wifi.ip : null;
  return `${ip ?? panel.data?.host?.name ?? ''}:5666`;
}

function body(fw) {
  const fresh = fw.update_available;
  const version = fresh ? fw.available : fw.current;
  return html`
    <div class="rl-update">
      <span class="rl-set__plate rl-set__plate--lg">${icon('arrow-circle-up', 'light')}</span>
      <div><p class="rl-update__ver">fnOS ${version ?? '—'}${fresh ? html`<span class="rl-tag rl-tag--info">${t('update.new')}</span>` : html`<span class="rl-tag">${t('update.latest')}</span>`}</p>
        <p class="rl-update__meta">${fresh ? t('update.current', { v: fw.current ?? '—' }) : t('update.upToDate')}</p></div>
    </div>
    ${fw.notes ? html`${section('update.secNotes')}${notes(fw.notes)}` : ''}
    ${fresh ? html`<div class="rl-notice" role="status" style="margin-top:16px">${icon('desktop')}<div class="rl-notice__body"><strong class="rl-notice__title">${t('update.where')}</strong>${t('update.whereBody', { address: webAddress() })}</div></div>` : ''}
    ${foot(t('update.foot'), 'margin:10px 0 18px')}`;
}

export default function updatePage(ctx) {
  const page = resourceSubpage(ctx, { slip: 'page.update', res: firmware, body });
  return { title: 'page.update', render: page.render, show: () => firmware.refresh() };
}
