// 连接 — the third tab. The connection map answers "how is this NAS
// connected, and does anything need me?"; the list below carries the details.
// Four spokes in fixed places: 有线 top left, Wi-Fi / 热点 top right, 蓝牙
// bottom left, 雷电 bottom right. The hub opens the address sheet.

import { html, on, painter } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { t } from '../../core/i18n.js';
import { panel } from '../../core/panel.js';
import { poller } from '../../core/resource.js';
import * as net from '../../data/network.js';
import { bluetooth, hotspot, sharing, thunderbolt } from '../../data/stores.js';
import { panelSheet } from '../../shell/layers.js';
import { lazy, push } from '../../shell/router.js';
import { qr } from '../../ui/qr.js';
import { backdrop, hostbar, titledPanel } from '../../ui/page.js';
import { list, section } from '../../ui/settings.js';

const PAGES = {
  wired: lazy(() => import('./wired.js')),
  wifi: lazy(() => import('./wifi.js')),
  hotspot: lazy(() => import('./hotspot.js')),
  bluetooth: lazy(() => import('./bluetooth.js')),
  thunderbolt: lazy(() => import('./thunderbolt.js')),
  sharing: lazy(() => import('./sharing.js')),
};

const HUB = [170, 127];
const SPOKES = {
  wired: [52, 40],
  wireless: [288, 40],
  bluetooth: [52, 214],
  thunderbolt: [288, 214],
};

function node(key, page, s, iconName, label) {
  const [x, y] = SPOKES[key];
  return html`<a class="rl-netmap__node is-${s.state}" href="#" data-page="${page}" style="left:${x}px;top:${y}px"><span class="rl-netmap__dot">${icon(iconName, 'light')}</span><b>${label}</b><small>${s.short}</small></a>`;
}

/** 图例: one sample of each kind of line the map shows, in a fixed order. */
function legend(spokes) {
  const shown = ['on', 'wait', 'off'].filter((k) => spokes.some((s) => s?.state === k));
  return html`<p class="rl-netmap__legend"><b>${t('net.legend')}</b>${shown.map((k) => html`<span class="rl-netmap__key is-${k}"><i></i>${t(`net.key.${k}`)}</span>`)}</p>`;
}

function netmap(d) {
  const n = d.network;
  const spokes = {
    wired: net.wired(n),
    wireless: net.wireless(n, hotspot.data?.clients),
    bluetooth: net.bluetooth(bluetooth.data),
    thunderbolt: net.thunderbolt(thunderbolt.data),
  };
  const wires = Object.entries(spokes).filter(([, s]) => s).map(([k, s]) => {
    const [x, y] = SPOKES[k];
    return html`<line x1="${HUB[0]}" y1="${HUB[1]}" x2="${x}" y2="${y}" class="rl-netmap__wire is-${s.state}"/>`;
  });
  const addr = net.mainAddress(n);
  const host = d.host?.name ?? '';
  const w = spokes.wireless;
  return html`<div class="rl-netmap">
    <svg class="rl-netmap__wires" viewBox="0 0 340 268" width="340" height="268" aria-hidden="true">${wires}</svg>
    <button class="rl-netmap__hub" style="left:${HUB[0]}px;top:${HUB[1]}px" aria-label="${t('net.address')}" data-address><b>${host}</b><small>${addr?.ip ?? t('net.noAddress')}</small><small>${host ? `${host}.local` : ''}</small></button>
    ${spokes.wired ? node('wired', 'wired', spokes.wired, spokes.wired.state === 'on' ? 'plugs-connected' : 'plugs', t('net.wired')) : ''}
    ${w ? node('wireless', w.hotspot ? 'hotspot' : 'wifi', w, w.hotspot ? 'broadcast' : w.state === 'on' ? 'wifi-high' : 'wifi-slash', w.hotspot ? t('net.hotspot') : 'Wi-Fi') : ''}
    ${spokes.bluetooth ? node('bluetooth', 'bluetooth', spokes.bluetooth, 'bluetooth', t('net.bluetooth')) : ''}
    ${spokes.thunderbolt ? node('thunderbolt', 'thunderbolt', spokes.thunderbolt, 'lightning', t('net.thunderbolt')) : ''}
    ${legend(Object.values(spokes))}
  </div>`;
}

function row(page, iconName, label, s) {
  if (!s) return null;
  const tail = s.tag
    ? html`<span class="rl-tag rl-tag--warn"><span class="rl-tag__dot"></span>${s.tag}</span>`
    : s.value ? html`<span class="rl-set__value">${s.value}</span>` : '';
  return html`<a class="rl-set__row${s.state === 'on' ? ' is-on' : ''}" href="#" data-page="${page}">${icon(iconName, 'light', 'rl-set__icon')}<span class="rl-set__label">${label}${s.sub ? html`<span class="rl-set__sub">${s.sub}</span>` : ''}</span>${tail}${icon('caret-right', 'regular', 'rl-set__go')}</a>`;
}

function sharingRow(d) {
  const sh = d.sharing;
  if (!sh) return null;
  const protocols = [sh.smb && 'SMB', sh.nfs && 'NFS'].filter(Boolean);
  const users = sharing.data?.connections ?? 0;
  const on = protocols.length > 0;
  return row('sharing', 'share-network', t('net.sharing'), {
    state: on ? 'on' : 'off',
    sub: on ? [protocols.join(' · '), users ? t('net.sharingUsers', { n: users }) : ''].filter(Boolean).join(' · ') : t('net.sharingOff'),
    value: on ? t('net.on') : t('net.off'),
  });
}

function pending(d) {
  return [net.thunderbolt(thunderbolt.data), net.bluetooth(bluetooth.data)].filter((s) => s?.state === 'wait').length;
}

/**
 * 连接's status line: is it reachable? No link at all first (err); no way
 * out but a local link in use, the hotspot or 雷电 (warn, opens 有线); then
 * devices waiting for an answer (雷电 / 蓝牙, opens the first); else 一切正常.
 */
function status(d, waiting) {
  const n = d.network ?? {};
  if (d.network && net.wired(n)?.state !== 'on' && !n.wifi?.connected) {
    const local = n.hotspot?.active ? 'hotspot' : net.thunderbolt(thunderbolt.data)?.state === 'on' ? 'thunderbolt' : '';
    if (!local) return { level: 'err', text: t('net.status.offline') };
    return { level: 'warn', text: t(`net.status.noUplink.${local}`), attrs: html` data-page="wired"` };
  }
  if (waiting) {
    const first = net.thunderbolt(thunderbolt.data)?.state === 'wait' ? 'thunderbolt' : 'bluetooth';
    return { level: 'warn', text: t('net.pending', { n: waiting }), attrs: html` data-page="${first}"` };
  }
  return { text: t('net.allGood') };
}

/** The address sheet: every way to reach the NAS, and a QR code for a phone. */
function openAddress() {
  panelSheet({
    title: t('net.address'),
    closeLabel: t('common.close'),
    mount(body) {
      const d = panel.data ?? {};
      const host = d.host?.name ?? '';
      const addr = net.mainAddress(d.network);
      const tbIp = (thunderbolt.data?.net ?? []).find((l) => l.connected && l.ip)?.ip;
      const url = `http://${addr?.ip ?? `${host}.local`}:5666`;
      body.innerHTML = String(html`<p class="rl-sheet__sub rl-sheet__lead">${t('net.addressSub')}</p>
        <p class="rl-address__ip">${addr?.ip ?? '—'}</p><p class="rl-address__host">${host}.local</p>
        <ul class="rl-kv" style="margin-top:10px">
          <li><span>${t('net.addressSmb')}</span><b>smb://${host}.local</b></li>
          ${tbIp ? html`<li><span>${t('net.addressTb')}</span><b>${tbIp.split('/')[0]}</b></li>` : ''}
          ${addr?.gateway ? html`<li><span>${t('net.addressGateway')}</span><b class="is-muted">${addr.gateway}</b></li>` : ''}
        </ul>
        <div class="rl-address__qr">${qr(url, 168, url)}<p>${t('net.addressQr')}</p></div>`);
    },
  });
}

export default function networkPage(ctx) {
  const paint = painter(ctx.el);
  const live = [poller(bluetooth, 5000), poller(thunderbolt, 5000), poller(sharing, 15000)];
  const hotspotLive = poller(hotspot, 5000);
  let shown = false;
  // the hotspot's device count only matters while it is on and the page is up
  const followHotspot = () => {
    if (shown && panel.data?.network?.hotspot?.active) hotspotLive.start(); else hotspotLive.stop();
  };

  function render() {
    const d = panel.data ?? {};
    const n = d.network;
    const waiting = pending(d);
    const body = html`${netmap(d)}<div class="rl-set rl-set--toc" style="padding-bottom:18px">
      ${section('net.secInterfaces')}
      ${list([
        row('wired', 'plugs-connected', t('net.wired'), net.wired(n)),
        row('wifi', 'wifi-high', 'Wi-Fi', net.wifiRow(n)),
        row('hotspot', 'broadcast', t('net.hotspot'), net.hotspotRow(n, hotspot.data?.clients)),
        row('thunderbolt', 'lightning', t('net.thunderbolt'), net.thunderbolt(thunderbolt.data)),
        row('bluetooth', 'bluetooth', t('net.bluetooth'), net.bluetooth(bluetooth.data)),
        sharingRow(d),
      ])}
    </div>`;
    paint(html`${backdrop()}${hostbar(d.host?.name, status(d, waiting))}${titledPanel({ slip: 'page.network', body })}`);
  }

  on(ctx.el, 'click', '[data-page]', (e, a) => { e.preventDefault(); push(PAGES[a.dataset.page]); });
  on(ctx.el, 'click', '[data-address]', openAddress);
  for (const res of [bluetooth, thunderbolt, sharing, hotspot]) ctx.own(res.changed.on(render));
  ctx.own(panel.changed.on(() => { followHotspot(); render(); }));

  return {
    title: 'page.network',
    render,
    show() { shown = true; live.forEach((p) => p.start()); followHotspot(); },
    hide() { shown = false; live.forEach((p) => p.stop()); followHotspot(); },
  };
}
