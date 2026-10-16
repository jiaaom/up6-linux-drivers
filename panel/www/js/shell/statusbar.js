// The one status bar (28px) for the whole app: time on the left; connection
// (wired, Wi-Fi, or the hotspot with its device count) and a battery icon by
// level (charging on AC) on the right. The battery percentage is in the control
// center. A running copy adds a task chip after the time (files tab).

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

function connection(net) {
  const hs = net?.hotspot;
  if (hs?.active) return html`<span aria-label="${t('status.hotspot', { n: hs.devices ?? 0 })}">${icon('broadcast')}${hs.devices ?? 0}</span>`;
  const eth = net?.ethernet;
  if (eth?.connected) {
    const speed = linkSpeed(eth.speed_mbps);
    return html`<span aria-label="${t('status.wired', { speed })}">${icon('plugs-connected')}${speed}</span>`;
  }
  const wifi = net?.wifi;
  if (wifi?.connected) {
    return html`<span>${signalIcon(wifi.signal ?? 0, t('status.wifi', { n: wifi.signal ?? 0 }))}</span>`;
  }
  return html`<span aria-label="${t('status.none')}">${icon('cloud-slash')}</span>`;
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
  bar.querySelector('.rl-statusbar__end').innerHTML = String(html`${connection(d?.network)}${battery(d?.battery)}`);
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
