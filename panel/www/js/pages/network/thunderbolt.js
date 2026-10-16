// 连接 › 雷电: devices on the Thunderbolt ports (a new one waits for 授权一次 or
// 授权并记住) and the Thunderbolt network links, each in its own subnet.

import { api } from '../../core/api.js';
import { html, on, painter } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { t } from '../../core/i18n.js';
import { panel } from '../../core/panel.js';
import { poller } from '../../core/resource.js';
import { thunderbolt } from '../../data/stores.js';
import { confirm, sheet, toast } from '../../shell/layers.js';
import { push } from '../../shell/router.js';
import { subpage } from '../../ui/page.js';
import { foot, linkRow, list, note, section } from '../../ui/settings.js';
import tbLinkPage from './tb-link.js';

const deviceIcon = (d) => (/mac|book|laptop|pc/i.test(d.name) ? 'laptop' : 'desktop-tower');
const linkText = (d) => d.link ?? '';

function pendingBlock(d) {
  return html`<div class="rl-set__block">
    <div class="rl-set__head">${icon(deviceIcon(d), 'light', 'rl-set__icon')}<span class="rl-set__label">${d.name}<span class="rl-set__sub">${[t('tb.justIn'), linkText(d)].filter(Boolean).join(' · ')}</span></span><span class="rl-tag rl-tag--warn"><span class="rl-tag__dot"></span>${t('net.tbTag')}</span></div>
    <div class="rl-set__actions"><button class="rl-btn rl-btn--secondary" data-authorize="${d.uuid}">${t('tb.once')}</button><button class="rl-btn rl-btn--primary" data-enroll="${d.uuid}">${t('tb.remember')}</button></div>
  </div>`;
}

function deviceRow(d) {
  return linkRow({
    iconName: deviceIcon(d),
    label: d.name,
    subText: [t(d.stored ? 'tb.remembered' : 'tb.thisTime'), linkText(d)].filter(Boolean).join(' · '),
    value: t('net.connected'),
    attrs: html` data-device="${d.uuid}"`,
  });
}

function body(tb) {
  const devices = (tb.devices ?? []).filter((d) => !d.host);
  const links = tb.net ?? [];
  return html`<div class="rl-set">
    ${note(t('tb.note'))}
    ${section('tb.secDevices')}
    ${devices.length
      ? list(devices.map((d) => (d.pending ? pendingBlock(d) : deviceRow(d))))
      : html`<div class="rl-empty rl-empty--inline">${icon('lightning', 'light')}<p class="rl-empty__body">${t('tb.none')}</p></div>`}
    ${foot(t('tb.devicesFoot'))}
    ${links.length ? html`${section('tb.secNet')}
      ${list(links.map((l, i) => linkRow({
        label: t('tb.link', { n: i + 1 }),
        subText: [l.iface, l.ip].filter(Boolean).join(' · '),
        value: t(l.connected ? 'net.connected' : 'net.notConnected'),
        attrs: html` data-link="${l.conn ?? ''}" data-iface="${l.iface}"`,
      })))}
      ${foot(t('tb.netFoot'), 'margin-bottom:18px')}` : html`<div style="height:18px"></div>`}
  </div>`;
}

export default function thunderboltPage(ctx) {
  const paint = painter(ctx.el);
  const live = poller(thunderbolt, 2000);

  function render() {
    const tb = thunderbolt.data;
    paint(subpage(ctx, { slip: 'page.thunderbolt', body: tb ? body(tb) : '', hostName: panel.data?.host?.name }));
  }

  async function act(action, uuid) {
    try {
      await api.post('thunderbolt/device', { action, uuid });
    } catch (e) {
      toast(t('common.failed', { why: e.message }));
    }
    thunderbolt.refresh();
  }

  on(ctx.el, 'click', '[data-authorize]', (e, b) => act('authorize', b.dataset.authorize));
  on(ctx.el, 'click', '[data-enroll]', (e, b) => act('enroll', b.dataset.enroll));
  on(ctx.el, 'click', '[data-device]', async (e, a) => {
    e.preventDefault();
    const d = (thunderbolt.data?.devices ?? []).find((x) => x.uuid === a.dataset.device);
    if (!d?.stored) return;
    const id = await sheet({ title: d.name, sub: [d.vendor, linkText(d)].filter(Boolean).join(' · '), actions: [{ id: 'forget', icon: 'trash', label: t('tb.forget'), danger: true }] });
    if (id === 'forget' && await confirm({ title: t('tb.forgetTitle', { name: d.name }), body: t('tb.forgetBody'), action: t('tb.forget'), kind: 'danger' })) act('forget', d.uuid);
  });
  on(ctx.el, 'click', '[data-link]', (e, a) => {
    e.preventDefault();
    if (a.dataset.link) push(tbLinkPage, { conn: a.dataset.link, iface: a.dataset.iface });
  });

  ctx.own(thunderbolt.changed.on(render));
  return { title: 'page.thunderbolt', render, show: live.start, hide: live.stop };
}
