// 连接 › 雷电 › a link: its address, automatic or set by hand, as on 有线.

import { api } from '../../core/api.js';
import { html, on, painter } from '../../core/dom.js';
import { t } from '../../core/i18n.js';
import { panel } from '../../core/panel.js';
import { resource } from '../../core/resource.js';
import { thunderbolt } from '../../data/stores.js';
import { toast } from '../../shell/layers.js';
import { addressRows, maskOf, readAddress } from '../../ui/address.js';
import { subpage } from '../../ui/page.js';
import { foot, list, pressSegment, section, segRow } from '../../ui/settings.js';

export default function tbLinkPage(ctx) {
  const { conn, iface } = ctx.params;
  const paint = painter(ctx.el);
  const cfg = resource(`tbnet.${conn}`, () => api.get(`thunderbolt/net?conn=${encodeURIComponent(conn)}`));
  let editing = null;

  function render() {
    const c = cfg.data;
    const link = (thunderbolt.data?.net ?? []).find((l) => l.iface === iface);
    const manual = (editing ?? c?.method) === 'manual';
    const [ip, prefix] = (c?.address ?? link?.ip ?? '').split('/');
    const shown = { ip, mask: maskOf(prefix ? +prefix : null), gateway: c?.gateway, dns: (c?.dns ?? []).join(' · ') };
    const body = html`<div class="rl-set">
      ${section('tb.secAddress')}
      <div data-port="${iface}">${list([
        segRow({ label: t('wired.method'), current: manual ? 'manual' : 'auto', options: [{ value: 'auto', label: t('wired.auto') }, { value: 'manual', label: t('wired.manual') }], attrs: html` data-method` }),
        html`<div class="rl-port__addr">${addressRows(shown, manual)}</div>`,
      ])}</div>
      ${link?.peer ? foot(t('tb.peer', { ip: link.peer.ip, host: link.peer.host ?? '' })) : ''}
      ${foot(t('tb.linkFoot'), 'margin-bottom:18px')}
    </div>`;
    paint(subpage(ctx, { slipMarkup: html`<span>${iface}</span><span class="rl-slip__sub">${t('page.thunderbolt')}</span>`, body, hostName: panel.data?.host?.name }));
  }

  async function save(body) {
    try {
      await api.post('thunderbolt/net', { conn, ...body });
      editing = null;
      toast(t(body.method === 'auto' ? 'wired.savedAuto' : 'wired.saved'));
    } catch (e) {
      toast(t('common.failed', { why: e.message }));
    }
    cfg.refresh();
    thunderbolt.refresh();
  }

  on(ctx.el, 'click', '[data-method] .rl-seg__btn', (e, b) => {
    if (b.getAttribute('aria-pressed') === 'true') return;
    pressSegment(b);
    if (b.dataset.value === 'auto') save({ method: 'auto' });
    else { editing = 'manual'; render(); }
  });
  on(ctx.el, 'change', '[data-field]', () => {
    const r = readAddress(ctx.el);
    if (r.error) { if (ctx.el.querySelector('[data-field="ip"]').value.trim()) toast(r.error); return; }
    save(r.body);
  });
  on(ctx.el, 'keydown', '[data-field]', (e, input) => { if (e.key === 'Enter') input.blur(); });

  ctx.own(cfg.changed.on(render));
  return { title: 'page.tbLink', render, show: () => cfg.refresh() };
}
