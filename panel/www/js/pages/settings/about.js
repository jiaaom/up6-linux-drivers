// 设置 › 关于: this machine, the software on it, and the licences of the
// icons and fonts the panel ships.

import { html, on } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { uptime } from '../../core/format.js';
import { t } from '../../core/i18n.js';
import { push } from '../../shell/router.js';
import { resourceSubpage } from '../../ui/page.js';
import { facts, foot, linkRow, list, section } from '../../ui/settings.js';
import { about } from '../../data/stores.js';
import licencePage, { LICENCES } from './licence.js';

const gb = (bytes) => (bytes ? `${Math.round(bytes / 2 ** 30)} GB` : null);

function body(a) {
  const cpu = [a.cpu?.replace(/^Intel\(R\) Core\(TM\) /, 'Core ').replace(/\(R\)|\(TM\)/g, ''), gb(a.ram_bytes)].filter(Boolean).join(' · ');
  return html`
    <div class="rl-update" style="padding-bottom:2px"><span class="rl-set__plate rl-set__plate--lg">${icon('hard-drives', 'light')}</span>
      <div><p class="rl-update__ver">${a.hostname ?? '—'}</p><p class="rl-update__meta">${[a.model, t('about.panelVersion', { v: a.panel })].filter(Boolean).join(' · ')}</p></div></div>
    ${section('about.secDevice')}
    ${facts([
      { iconName: 'hard-drives', label: t('about.model'), value: a.model },
      { iconName: 'barcode', label: t('about.serial'), value: a.serial },
      { iconName: 'identification-badge', label: t('about.hostname'), value: a.hostname },
      { iconName: 'cpu', label: t('about.cpu'), value: cpu || null },
      { iconName: 'clock-countdown', label: t('about.uptime'), value: uptime(a.uptime_s) },
    ])}
    ${section('about.secSoftware')}
    ${facts([
      { iconName: 'package', label: 'fnOS', value: a.fnos },
      { iconName: 'app-window', label: t('about.panel'), value: a.panel },
      { iconName: 'gear-six', label: t('about.backend'), value: a.backend && `t6-paneld ${a.backend}` },
      { iconName: 'cube', label: t('about.kernel'), value: a.kernel },
    ])}
    ${section('about.secLicences')}
    ${list(LICENCES.map((l) => linkRow({ label: l.name, subText: l.licence, attrs: html` data-licence="${l.id}"` })))}
    ${foot(t('about.licencesFoot'), 'margin-bottom:18px')}`;
}

export default function aboutPage(ctx) {
  const page = resourceSubpage(ctx, { slip: 'page.about', res: about, body });
  on(ctx.el, 'click', '[data-licence]', (e, a) => {
    e.preventDefault();
    push(licencePage, { id: a.dataset.licence });
  });
  return { title: 'page.about', render: page.render, show: () => about.refresh() };
}
