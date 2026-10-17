// The one status bar (28px) for the whole app: time on the left; the
// connections in use (Bluetooth, Wi-Fi or the hotspot, wired) and a battery
// icon by level (charging on AC) on the right. The battery percentage is in
// the control center. A running copy adds a task chip after the time (files tab).

import { html, raw } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { langChanged, t } from '../core/i18n.js';
import { panel } from '../core/panel.js';

let bar = null;

const pad = (n) => String(n).padStart(2, '0');

function clock() {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 2500 → "2.5G", 1000 → "1G", 100 → "100M". */
export function linkSpeed(mbps) {
  if (!mbps) return '';
  return mbps >= 1000 ? `${+(mbps / 1000).toFixed(1)}G` : `${mbps}M`;
}

/** Wi-Fi strength as Ridgeline's three arcs and a dot (rl-signal). */
export function signalIcon(percent, label) {
  const level = percent > 66 ? 3 : percent > 33 ? 2 : 1;
  const arc = (n, d) => raw(`<path${n > level ? ' class="is-dim"' : ''} d="${d}"/>`);
  return html`<svg class="rl-signal" viewBox="0 0 48 48" role="img" aria-label="${label}">${arc(3, 'M6 19a25 25 0 0 1 36 0')}${arc(2, 'M12.5 26.5a16 16 0 0 1 23 0')}${arc(1, 'M18.5 33.5a7.5 7.5 0 0 1 11 0')}<circle cx="24" cy="39.5" r="2.2"/></svg>`;
}

/**
 * Every connection in use, side by side (Ridgeline Navigation › Status bar ›
 * Connections): 蓝牙 · Wi-Fi or 热点 · 有线, least to most important. Off, or
 * on but not connected, shows nothing. With no network at all: wifi-slash
 * when Wi-Fi is off (the reason), else cloud-slash.
 */
function connections(d) {
  const net = d?.network;
  const bt = d?.bluetooth;
  const hs = net?.hotspot;
  const wifi = net?.wifi;
  const eth = net?.ethernet;
  const out = [];
  if (bt?.powered && bt.connected > 0) out.push(html`<span aria-label="${t('status.bluetooth')}">${icon('bluetooth-connected')}</span>`);
  if (hs?.active) {
    const n = hs.devices ?? 0;
    out.push(html`<span aria-label="${t('status.hotspot', { n })}">${icon('broadcast')}${n > 0 ? n : ''}</span>`);
  } else if (wifi?.connected) {
    out.push(html`<span>${signalIcon(wifi.signal ?? 0, t('status.wifi', { n: wifi.signal ?? 0 }))}</span>`);
  }
  if (eth?.connected) {
    const speed = linkSpeed(eth.speed_mbps);
    out.push(html`<span aria-label="${t('status.wired', { speed })}">${icon('plugs-connected')}${speed}</span>`);
  }
  if (!hs?.active && !wifi?.connected && !eth?.connected) {
    out.push(wifi && wifi.enabled === false
      ? html`<span aria-label="${t('status.wifiOff')}">${icon('wifi-slash')}</span>`
      : html`<span aria-label="${t('status.none')}">${icon('cloud-slash')}</span>`);
  }
  return out;
}

function battery(b) {
  if (!b?.present) return '';
  const c = b.capacity ?? 0;
  const name = b.ac ? 'battery-charging'
    : c >= 90 ? 'battery-full' : c >= 60 ? 'battery-high' : c >= 30 ? 'battery-medium' : c >= 10 ? 'battery-low' : 'battery-empty';
  return html`<span aria-label="${t('status.battery', { n: c })}">${icon(name)}</span>`;
}

function renderEnd() {
  const d = panel.data;
  bar.querySelector('.rl-statusbar__end').innerHTML = String(html`${connections(d)}${battery(d?.battery)}`);
}

function tick() {
  bar.querySelector('[data-clock]').textContent = clock();
  setTimeout(tick, 60000 - (Date.now() % 60000) + 50);
}

export function mountStatusbar(el) {
  bar = el;
  bar.innerHTML = String(html`<span class="rl-statusbar__start"><span data-clock></span><span data-task></span></span><span class="rl-statusbar__end"></span>`);
  tick();
  renderEnd();
  panel.changed.on(renderEnd);
  langChanged.on(renderEnd);
}

/** The status bar with only the time, for the offline page. */
export function clockOnly() {
  return html`<div class="rl-statusbar" role="status"><span>${clock()}</span></div>`;
}
