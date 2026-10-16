// 连接 › 共享: the file-sharing services (SMB, NFS) and the shared folders.
// A service, not a link, so it lives in the list, not on the map. Read-only:
// shares are set up in the fnOS web page.

import { html } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { t } from '../../core/i18n.js';
import { poller } from '../../core/resource.js';
import { panel } from '../../core/panel.js';
import { sharing } from '../../data/stores.js';
import { resourceSubpage } from '../../ui/page.js';
import { facts, foot, list, section } from '../../ui/settings.js';

function body(s) {
  const host = panel.data?.host?.name ?? '';
  const shares = s.shares ?? [];
  return html`
    ${section('sharing.secServices')}
    ${facts([
      { iconName: 'share-network', label: 'SMB', value: s.smb ? `smb://${host}.local` : t('net.off') },
      { iconName: 'share-network', label: 'NFS', value: s.nfs ? t('net.on') : t('net.off') },
      { iconName: 'users', label: t('sharing.users'), value: String(s.connections ?? 0) },
    ])}
    ${section('sharing.secShares', shares.length ? html`<span class="rl-set__count">${shares.length}</span>` : '')}
    ${shares.length
      ? list(shares.map((x) => html`<div class="rl-set__row">${icon('folder', 'light', 'rl-set__icon')}<span class="rl-set__label">${x.name}<span class="rl-set__sub">${x.path}</span></span><span class="rl-tag">${x.protocol.toUpperCase()}</span></div>`))
      : html`<p class="rl-set__note" style="padding:10px 0 4px">${t('sharing.none')}</p>`}
    ${foot(t('sharing.foot'), 'margin-bottom:18px')}`;
}

export default function sharingPage(ctx) {
  const page = resourceSubpage(ctx, { slip: 'page.sharing', res: sharing, body });
  const live = poller(sharing, 10000);
  return { title: 'page.sharing', render: page.render, show: live.start, hide: live.stop };
}
