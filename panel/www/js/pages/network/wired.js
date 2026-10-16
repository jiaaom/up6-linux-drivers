// 连接 › 有线: each port with its own 获取方式 and address. 自动 (DHCP) shows
// the address as facts; 手动 turns the same rows into inputs, saved as soon as
// they make a whole address — on an unplugged port too, for when a cable goes in.
// Ports are named by interface and kind, never by where they sit on the box.

import { api } from '../../core/api.js';
import { html, on, painter } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { t } from '../../core/i18n.js';
import { panel, refreshPanel } from '../../core/panel.js';
import { resource } from '../../core/resource.js';
import { speedLong } from '../../data/network.js';
import { toast } from '../../shell/layers.js';
import { addressRows, maskOf, readAddress } from '../../ui/address.js';
import { subpage } from '../../ui/page.js';
import { foot, list, note, pressSegment, section, segRow } from '../../ui/settings.js';

function portBlock(port, i, cfg, editing) {
  const manual = (editing ?? cfg?.method) === 'manual';
  const [cfgIp, cfgPrefix] = (cfg?.address ?? '').split('/');
  const shown = manual
    ? { ip: cfgIp || port.ip, mask: maskOf(cfgPrefix ? +cfgPrefix : port.prefix), gateway: cfg?.gateway ?? port.gateway, dns: (cfg?.dns?.length ? cfg.dns : port.dns ?? []).join(' · ') }
    : { ip: port.ip, mask: maskOf(port.prefix), gateway: port.gateway, dns: (port.dns ?? []).join(' · ') };
  const kind = port.usb ? t('wired.usb', { model: port.model ?? '' }).trim() : t('wired.builtIn');
  const head = html`<div class="rl-set__block rl-port"><div class="rl-set__head">
      <span class="rl-set__plate">${icon(port.connected ? 'plugs-connected' : 'plugs', 'light')}</span>
      <span class="rl-set__label">${port.iface}<span class="rl-set__sub">${port.connected ? kind : `${kind} · ${t('wired.noCable')}`}</span></span>
      ${port.connected ? html`<span class="rl-tag rl-tag--tint"><span class="rl-tag__dot"></span>${t('net.connected')}</span>` : html`<span class="rl-set__value">${t('net.notConnected')}</span>`}
    </div>
    <ul class="rl-kv rl-kv--set"><li><span>${icon('gauge')}${t('wired.speed')}</span><b>${speedLong(port.speed_mbps) || '—'}</b></li><li><span>${icon('fingerprint')}MAC</span><b>${(port.mac ?? '—').toUpperCase()}</b></li></ul>
  </div>`;
  return html`${section(`wired.port${i + 1}`)}
    <div data-port="${port.iface}">${list([
      head,
      segRow({ label: t('wired.method'), current: manual ? 'manual' : 'auto', options: [{ value: 'auto', label: t('wired.auto') }, { value: 'manual', label: t('wired.manual') }], attrs: html` data-method` }),
      html`<div class="rl-port__addr">${addressRows(shown, manual)}</div>`,
    ])}</div>`;
}

export default function wiredPage(ctx) {
  const paint = painter(ctx.el);
  const configs = new Map(); // iface → resource of its saved address settings
  const editing = new Map(); // iface → 'manual' while the inputs are not saved yet
  const configOf = (iface) => {
    if (!configs.has(iface)) {
      const r = resource(`eth.${iface}`, () => api.get(`network/ethernet?iface=${encodeURIComponent(iface)}`));
      r.changed.on(render);
      configs.set(iface, r);
    }
    return configs.get(iface);
  };

  function render() {
    const ports = panel.data?.network?.ethernet_ports ?? [];
    const body = html`<div class="rl-set">
      ${note(t('wired.note'))}
      ${ports.map((p, i) => portBlock(p, i, configOf(p.iface).data, editing.get(p.iface)))}
      ${foot(t('wired.foot'), 'margin-bottom:18px')}
    </div>`;
    paint(subpage(ctx, { slip: 'page.wired', body, hostName: panel.data?.host?.name }));
  }

  async function save(iface, body) {
    try {
      await api.post('network/ethernet', { iface, ...body });
      editing.delete(iface);
      toast(t(body.method === 'auto' ? 'wired.savedAuto' : 'wired.saved'));
    } catch (e) {
      toast(t('common.failed', { why: e.message }));
    }
    configOf(iface).refresh();
    refreshPanel();
  }

  on(ctx.el, 'click', '[data-method] .rl-seg__btn', (e, b) => {
    const iface = b.closest('[data-port]').dataset.port;
    if (b.getAttribute('aria-pressed') === 'true') return;
    pressSegment(b);
    if (b.dataset.value === 'auto') save(iface, { method: 'auto' });
    else { editing.set(iface, 'manual'); render(); }
  });
  // a whole, valid address is saved when a field is left (or on return)
  const commit = (input) => {
    const port = input.closest('[data-port]');
    const r = readAddress(port);
    if (r.error) { if (port.querySelector('[data-field="ip"]').value.trim()) toast(r.error); return; }
    save(port.dataset.port, r.body);
  };
  on(ctx.el, 'change', '[data-field]', (e, input) => commit(input));
  on(ctx.el, 'keydown', '[data-field]', (e, input) => { if (e.key === 'Enter') input.blur(); });

  ctx.own(panel.changed.on(render));
  return {
    title: 'page.wired',
    render,
    show() { for (const p of panel.data?.network?.ethernet_ports ?? []) configOf(p.iface).refresh(); },
  };
}
