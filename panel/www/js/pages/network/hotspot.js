// 连接 › 热点: the NAS as a Wi-Fi access point. While it is on, a join code
// (a QR code with the network name and password) lets a phone connect without
// typing. It shares the card with Wi-Fi, so turning it on drops Wi-Fi.

import { api } from '../../core/api.js';
import { html, on, painter } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { t } from '../../core/i18n.js';
import { panel, refreshPanel } from '../../core/panel.js';
import { poller } from '../../core/resource.js';
import { hotspot } from '../../data/stores.js';
import { confirm, toast } from '../../shell/layers.js';
import { errorLine, passwordField, textField, wireReveal } from '../../ui/fields.js';
import { subpage } from '../../ui/page.js';
import { qr, wifiJoinText } from '../../ui/qr.js';
import { foot, linkRow, list, pressSegment, section, segRow, switchRow } from '../../ui/settings.js';

const bandLabel = (b) => (b === 'a' ? '5 GHz' : '2.4 GHz');

/** Name and password; resolves with { ssid, password } or null. */
async function settingsDialog(h, titleId) {
  let result = null;
  const ok = await confirm({
    title: t(titleId),
    body: t('hotspot.dialogBody'),
    action: t('hotspot.save'),
    top: true,
    content: html`${textField({ id: 't6-hs-ssid', label: t('hotspot.name'), value: h?.ssid ?? '' })}${passwordField({ id: 't6-hs-pass', label: t('account.password'), value: h?.password ?? '' })}${errorLine()}`,
    onOpen(node) { wireReveal(node); node.querySelector('#t6-hs-ssid').focus(); },
    check(node) {
      const ssid = node.querySelector('#t6-hs-ssid').value.trim();
      const password = node.querySelector('#t6-hs-pass').value;
      if (!ssid || [...ssid].length > 32) return t('hotspot.badName');
      if (password.length < 8) return t('wifi.shortPassword');
      result = { ssid, password };
      return '';
    },
  });
  return ok ? result : null;
}

function body(h) {
  const configured = !!h.ssid;
  const clients = h.clients ?? [];
  const secret = h.password ? '•'.repeat(Math.min(h.password.length, 12)) : '';
  return html`<div class="rl-set">
    <ul class="rl-set__list" style="margin-top:6px"><li>${switchRow({ label: t('net.hotspot'), subText: t('hotspot.switchSub'), checked: h.active, attrs: html` data-switch` })}</li></ul>
    ${h.active && h.password ? html`<div class="rl-hotspot">
      <div class="rl-hotspot__qr">${qr(wifiJoinText(h.ssid, h.password), 148, t('hotspot.qrLabel', { ssid: h.ssid }))}</div>
      <div class="rl-hotspot__text"><b>${h.ssid}</b><span>${t('hotspot.scan')}</span><small>${bandLabel(h.band)} · WPA2</small></div>
    </div>` : ''}
    ${section('hotspot.secSettings')}
    ${list([
      linkRow({ label: t('hotspot.name'), value: configured ? h.ssid : t('hotspot.notSet'), attrs: html` data-edit` }),
      configured && html`<div class="rl-set__row"><span class="rl-set__label">${t('account.password')}</span><span class="rl-set__value rl-set__secret" data-secret>${secret}</span>
        <button class="rl-btn rl-btn--secondary rl-btn--icon rl-btn--sm" data-show aria-pressed="false" aria-label="${t('account.showPassword')}">${icon('eye')}</button></div>`,
      segRow({ label: t('hotspot.band'), current: h.band === 'a' ? 'a' : 'bg', options: [{ value: 'bg', label: '2.4 GHz' }, { value: 'a', label: '5 GHz' }], attrs: html` data-band` }),
    ])}
    ${foot(t('hotspot.bandFoot'))}
    ${h.active ? html`${section('hotspot.secDevices', clients.length ? html`<span class="rl-set__count">${t('net.count', { n: clients.length })}</span>` : '')}
      ${clients.length
        ? list(clients.map((c) => html`<div class="rl-set__row">${icon('device-mobile', 'light', 'rl-set__icon')}<span class="rl-set__label">${c.name ?? c.ip}<span class="rl-set__sub">${c.ip}</span></span></div>`))
        : html`<p class="rl-set__note" style="padding:10px 0 4px">${t('hotspot.noDevices')}</p>`}
      ${h.address ? foot(t('hotspot.shareFoot', { ip: h.address.split('/')[0] }), 'margin-bottom:18px') : html`<div style="height:18px"></div>`}` : html`<div style="height:18px"></div>`}
  </div>`;
}

export default function hotspotPage(ctx) {
  const paint = painter(ctx.el);
  const live = poller(hotspot, 4000);

  function render() {
    const d = panel.data ?? {};
    const h = hotspot.data ?? d.network?.hotspot ?? {};
    paint(subpage(ctx, { slip: 'page.hotspot', body: body(h), hostName: d.host?.name }));
  }

  async function post(req, done) {
    live.hold(30000);
    try {
      await api.post('network/hotspot', req);
      if (done) toast(done);
    } catch (e) {
      toast(t('common.failed', { why: e.message }));
    }
    live.hold(0);
    refreshPanel();
    hotspot.refresh();
  }

  async function turnOn(input) {
    input.checked = false;
    const h = hotspot.data ?? {};
    const wifi = panel.data?.network?.wifi;
    let settings = null;
    if (!h.ssid) {
      settings = await settingsDialog(h, 'hotspot.setUp');
      if (!settings) return;
    }
    if (wifi?.connected && !(await confirm({ title: t('cc.hotspotOverWifi'), body: t('cc.hotspotOverWifiBody', { ssid: wifi.ssid }), action: t('cc.hotspotOverWifiAction') }))) return;
    input.checked = true;
    toast(t('hotspot.starting'));
    await post(settings ? { enabled: true, ...settings, band: 'bg' } : { enabled: true }, t('hotspot.started'));
  }

  on(ctx.el, 'change', 'input[data-switch]', (e, input) => {
    if (input.checked) turnOn(input);
    else post({ enabled: false }, t('hotspot.stopped'));
  });
  on(ctx.el, 'click', '[data-edit]', async (e) => {
    e.preventDefault();
    const h = hotspot.data ?? {};
    const s = await settingsDialog(h, 'hotspot.edit');
    if (s) post({ enabled: true, ...s, band: h.band ?? 'bg', start: !!h.active }, t('hotspot.saved'));
  });
  on(ctx.el, 'click', '[data-band] .rl-seg__btn', (e, b) => {
    const h = hotspot.data ?? {};
    if (b.getAttribute('aria-pressed') === 'true') return;
    if (!h.ssid) { toast(t('hotspot.setUpFirst')); return; }
    pressSegment(b);
    post({ enabled: true, ssid: h.ssid, password: h.password, band: b.dataset.value, start: !!h.active }, t('hotspot.saved'));
  });
  on(ctx.el, 'click', '[data-show]', (e, b) => {
    const show = b.getAttribute('aria-pressed') !== 'true';
    b.setAttribute('aria-pressed', String(show));
    b.setAttribute('aria-label', t(show ? 'account.hidePassword' : 'account.showPassword'));
    b.innerHTML = String(icon(show ? 'eye-slash' : 'eye'));
    const pw = hotspot.data?.password ?? '';
    ctx.el.querySelector('[data-secret]').textContent = show ? pw : '•'.repeat(Math.min(pw.length, 12));
  });

  ctx.own(hotspot.changed.on(render));
  ctx.own(panel.changed.on(render));
  return { title: 'page.hotspot', render, show: live.start, hide: live.stop };
}
