// The control center (rl-cc): pulled down from the status bar on any page,
// or opened with the remote's Menu key. Quick switches, brightness, volume
// and its output, and 立即熄屏. A tap on a switch flips it; a long press opens
// its page. Toggles show "on" in their own pigment (色线淡染), the one place
// selection is not 反墨, because several can be on at once.
//
// While a finger pulls it, the plate follows (.is-dragging, --rl-cc-pull 0–1);
// released past a third it opens, otherwise it goes back up.

import { api } from '../core/api.js';
import { capture, el, html, on, painter } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { getLang, langChanged, t } from '../core/i18n.js';
import { panel, refreshPanel } from '../core/panel.js';
import { poller } from '../core/resource.js';
import { getTheme, setTheme } from '../core/theme.js';
import { audio, bluetooth, chooseOutput, defaultOutput, leds, soundProblem } from '../data/stores.js';
import { outputRows } from '../ui/outputs.js';
import { closeLayer, confirm, openLayer, panelSheet, toast, topLayer } from './layers.js';
import { menuPressed } from './remote.js';
import { goTo, lazy } from './router.js';

const OPEN_AT = 1 / 3;
const LONG_PRESS_MS = 500;
const SETTLE_MS = 240;

const PAGES = {
  leds: lazy(() => import('../pages/settings/leds.js')),
  wifi: lazy(() => import('../pages/network/wifi.js')),
  bluetooth: lazy(() => import('../pages/network/bluetooth.js')),
  hotspot: lazy(() => import('../pages/network/hotspot.js')),
};

let screen = null;
let band = null;
let layer = null; // { entry, node, panel, paint, stop }
const audioLive = poller(audio);
const live = [audioLive, poller(bluetooth), poller(leds)];

const clamp = (v) => Math.max(0, Math.min(1, v));
const ease = (x) => 1 - (1 - x) ** 3;

function setPull(v) {
  layer.node.style.setProperty('--rl-cc-pull', String(v));
}

/** Move the plate to `to` (0 closed, 1 open) from where the finger left it. */
function settle(to) {
  const from = parseFloat(layer.node.style.getPropertyValue('--rl-cc-pull')) || 0;
  const start = performance.now();
  const own = layer;
  return new Promise((resolve) => {
    const step = (now) => {
      if (layer !== own) return resolve();
      const x = Math.min(1, (now - start) / SETTLE_MS);
      setPull(from + (to - from) * ease(x));
      if (x < 1) requestAnimationFrame(step);
      else resolve();
    };
    requestAnimationFrame(step);
  });
}

// ---------- what it shows ----------

function dateHead() {
  const d = new Date();
  const locale = getLang() === 'zh' ? 'zh-CN' : 'en-GB';
  const day = new Intl.DateTimeFormat(locale, { month: 'long', day: 'numeric' }).format(d);
  const weekday = new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(d);
  return html`<h2 class="rl-cc__date">${day}<small>${weekday}</small></h2>`;
}

function batteryHead(b) {
  if (!b?.present) return '';
  const state = { Charging: 'cc.charging', Full: 'cc.full', Discharging: 'cc.onBattery' }[b.status] ?? (b.ac ? 'cc.onPower' : 'cc.onBattery');
  return html`<span class="rl-cc__batt">${icon('battery-high')}<b>${b.capacity}</b>%<small>${t(state)}</small></span>`;
}

function toggle({ id, pigment, iconName, label, state, pressed, disabled = false }) {
  return html`<button class="rl-cc__toggle" data-toggle="${id}" data-pigment="${pigment}" aria-pressed="${!!pressed}"${disabled ? html` disabled` : ''}>${icon(iconName, 'light')}<b>${label}</b><small>${state}</small></button>`;
}

function toggles() {
  const net = panel.data?.network ?? {};
  const wifi = net.wifi;
  const hotspot = net.hotspot ?? {};
  const bt = bluetooth.data;
  const night = leds.data?.night;
  const btConnected = (bt?.devices ?? []).filter((d) => d.connected).length;
  const off = t('cc.off');
  return [
    toggle({
      id: 'wifi', pigment: 'azurite', iconName: 'wifi-high', label: 'Wi-Fi', disabled: !wifi,
      pressed: wifi?.enabled && !hotspot.active,
      state: !wifi ? t('cc.noHardware') : hotspot.active ? off : wifi.connected ? wifi.ssid : wifi.enabled ? t('cc.notConnected') : off,
    }),
    toggle({
      id: 'bluetooth', pigment: 'indigo', iconName: 'bluetooth', label: t('cc.bluetooth'), disabled: bt && !bt.adapter,
      pressed: bt?.powered,
      state: bt && !bt.adapter ? t('cc.noHardware') : bt?.powered ? (btConnected ? t('cc.btConnected', { n: btConnected }) : t('cc.on')) : off,
    }),
    toggle({
      id: 'hotspot', pigment: 'malachite', iconName: 'broadcast', label: t('cc.hotspot'), disabled: !wifi,
      pressed: hotspot.active, state: hotspot.active ? hotspot.ssid : off,
    }),
    panel.data?.leds?.available !== false && toggle({
      id: 'night', pigment: 'gamboge', iconName: 'lightbulb', label: t('cc.ledsNight'),
      pressed: night?.active,
      state: night?.schedule ? night.schedule.replace('-', '–') : night?.active ? t('cc.on') : off,
    }),
    toggle({ id: 'dark', pigment: 'carmine', iconName: 'moon-stars', label: t('cc.dark'), pressed: getTheme() === 'dark', state: getTheme() === 'dark' ? t('cc.on') : off }),
  ].filter(Boolean);
}

function sliders() {
  const brightness = panel.data?.display?.brightness ?? 50;
  const a = audio.data;
  const out = soundProblem(a) ? null : defaultOutput(a);
  const volume = Math.round((out?.volume ?? 0) * 100);
  const slider = (id, iconName, label, v, disabled) => html`<div class="rl-cc__slider"><span class="rl-cc__slabel">${icon(iconName)}${label}</span><input class="rl-slider" type="range" min="0" max="100" value="${v}" style="--v:${v}" aria-label="${label}" data-slider="${id}"${disabled ? html` disabled` : ''}><span class="rl-cc__val">${disabled ? '—' : v}</span></div>`;
  return html`<div class="rl-cc__sliders">
    ${slider('brightness', 'sun', t('cc.brightness'), brightness, false)}
    ${slider('volume', 'speaker-high', t('cc.volume'), volume, !out)}
    ${(a?.outputs ?? []).length ? html`<button class="rl-sortbtn rl-cc__out" data-outputs>${t('cc.output', { name: out?.name ?? '—' })}${icon('caret-down')}</button>` : ''}
  </div>`;
}

function content() {
  return html`<div class="rl-cc__head">${dateHead()}${batteryHead(panel.data?.battery)}</div>
    <div class="rl-cc__grid">${toggles()}</div>
    ${sliders()}
    <button class="rl-btn rl-btn--primary rl-btn--block rl-cc__sleep" data-sleep>${icon('moon')}${t('cc.sleep')}</button>
    <p class="rl-cc__hint">${t('cc.hint')}</p>
    <div class="rl-cc__grabzone" data-grab><div class="rl-cc__grab" aria-hidden="true"></div></div>`;
}

const repaint = () => { if (layer) layer.paint(content()); };

// ---------- what the switches do ----------

async function run(promise) {
  try {
    await promise;
  } catch (e) {
    toast(t('common.failed', { why: e.message }));
  }
  refreshPanel();
}

async function flip(id) {
  const net = panel.data?.network ?? {};
  switch (id) {
    case 'wifi': {
      const on = !(net.wifi?.enabled && !net.hotspot?.active);
      if (on && net.hotspot?.active) {
        if (!(await confirm({ title: t('cc.wifiOverHotspot'), body: t('cc.wifiOverHotspotBody'), action: t('cc.wifiOverHotspotAction') }))) return;
        await run(api.post('network/hotspot', { enabled: false }));
      }
      await run(api.put('network/wifi/radio', { on }));
      return;
    }
    case 'bluetooth':
      await run(api.put('bluetooth/power', { on: !bluetooth.data?.powered }));
      bluetooth.refresh();
      return;
    case 'hotspot': {
      if (net.hotspot?.active) { await run(api.post('network/hotspot', { enabled: false })); return; }
      if (net.wifi?.connected && !(await confirm({ title: t('cc.hotspotOverWifi'), body: t('cc.hotspotOverWifiBody', { ssid: net.wifi.ssid }), action: t('cc.hotspotOverWifiAction') }))) return;
      try {
        await api.post('network/hotspot', { enabled: true });
      } catch (e) {
        // never set up: its page in 连接 asks for a name and a password
        if (!net.hotspot?.ssid) { toast(t('cc.hotspotSetUp')); close(); goTo('network', PAGES.hotspot); return; }
        toast(t('common.failed', { why: e.message }));
      }
      refreshPanel();
      return;
    }
    case 'night':
      await run(api.put('leds/night', { on: !leds.data?.night?.active }));
      leds.refresh();
      return;
    case 'dark':
      await run(setTheme(getTheme() === 'dark' ? 'light' : 'dark'));
      repaint();
      return;
    default:
  }
}

/** Long press: the switch's own page. */
function openPageOf(id) {
  close();
  if (id === 'night') goTo('settings', PAGES.leds);
  else if (id === 'dark') goTo('settings');
  else goTo('network', PAGES[id]);
}

function pickOutput() {
  panelSheet({
    title: t('cc.outputTitle'),
    mount(body, done) {
      const draw = () => { body.innerHTML = String(outputRows(audio.data ?? {})); };
      draw();
      const off = audio.changed.on(draw);
      on(body, 'click', '[data-output]', async (e, b) => {
        await run(chooseOutput(b.dataset.output));
        await audio.refresh();
        done();
      });
      return off;
    },
  });
}

let volTimer = 0;
let briTimer = 0;

function wire(node) {
  // tap flips; a long press opens the page instead
  let press = null;
  on(node, 'pointerdown', '[data-toggle]', (e, b) => {
    press = { b, fired: false, timer: setTimeout(() => { press.fired = true; openPageOf(b.dataset.toggle); }, LONG_PRESS_MS) };
  });
  const cancel = () => { if (press) clearTimeout(press.timer); };
  node.addEventListener('pointerup', cancel);
  node.addEventListener('pointercancel', cancel);
  node.addEventListener('pointermove', (e) => { if (press && (Math.abs(e.movementX) > 4 || Math.abs(e.movementY) > 4)) cancel(); });
  on(node, 'click', '[data-toggle]', (e, b) => {
    if (press?.fired) { press = null; return; }
    press = null;
    flip(b.dataset.toggle);
  });
  on(node, 'input', '[data-slider]', (e, input) => {
    input.style.setProperty('--v', input.value);
    input.nextElementSibling.textContent = input.value;
    const v = +input.value;
    if (input.dataset.slider === 'brightness') {
      if (panel.data?.display) panel.data.display.brightness = v;
      clearTimeout(briTimer);
      briTimer = setTimeout(() => api.put('display/brightness', { value: Math.max(1, v) }).catch(() => {}), 120);
    } else {
      const out = defaultOutput(audio.data);
      if (!out) return;
      out.volume = v / 100;
      audioLive.hold(2000);
      clearTimeout(volTimer);
      volTimer = setTimeout(() => api.put('audio/volume', { id: out.id, volume: v / 100 }).catch(() => {}), 150);
    }
  });
  on(node, 'click', '[data-outputs]', pickOutput);
  on(node, 'click', '[data-sleep]', () => { close(); api.put('display/power', { on: false }).catch(() => {}); });
  on(node, 'click', '[data-close]', close);
  // Dragging up takes the plate with it, from the grab bar, the dimmed page
  // below the plate or the plate's own empty space (not its controls); a tap
  // on the grab bar or the dimmed page closes it.
  node.addEventListener('pointerdown', (e) => {
    const onScrim = e.target.matches('.rl-scrim');
    const onGrab = e.target.closest('[data-grab]');
    if (!onScrim && !onGrab && (!e.target.closest('.rl-cc__panel') || e.target.closest(CONTROLS))) return;
    dragUp(e, e.target, { tapCloses: onScrim || !!onGrab });
  });
}

// what a drag on the plate must leave alone
const CONTROLS = 'button, a, input, label, select, [role="switch"], [role="slider"], [data-toggle], .rl-slider, .rl-seg';

function dragUp(e, target, { tapCloses }) {
  const y0 = e.clientY;
  const h = layer.panel.offsetHeight;
  let moved = false;
  capture(target, e.pointerId);
  const move = (ev) => {
    const dy = ev.clientY - y0;
    if (!moved && Math.abs(dy) > 6) moved = true;
    if (!moved) return;
    layer.node.classList.add('is-dragging');
    setPull(clamp(1 + Math.min(0, dy) / h));
  };
  const up = async (ev) => {
    target.removeEventListener('pointermove', move);
    target.removeEventListener('pointerup', up);
    target.removeEventListener('pointercancel', up);
    if (!layer) return;
    if (!moved) { if (tapCloses && ev.type === 'pointerup') close(); return; }
    if (clamp(1 + (ev.clientY - y0) / h) < 1 - OPEN_AT) { await settle(0); close({ animate: false }); }
    else settle(1);
  };
  target.addEventListener('pointermove', move);
  target.addEventListener('pointerup', up);
  target.addEventListener('pointercancel', up);
}

// ---------- open and close ----------

function create(dragging) {
  const node = el(html`<div class="rl-cc${dragging ? ' is-dragging' : ''}">
    <div class="rl-scrim"></div>
    <div class="rl-cc__clip"><div class="rl-sheet rl-cc__panel" role="dialog" aria-modal="true" aria-label="${t('cc.label')}"></div></div>
  </div>`);
  const plate = node.querySelector('.rl-cc__panel');
  const paint = painter(plate);
  wire(node);
  const entry = openLayer(node, () => close());
  const offs = [panel.changed.on(repaint), audio.changed.on(repaint), bluetooth.changed.on(repaint), leds.changed.on(repaint), langChanged.on(repaint)];
  layer = { entry, node, panel: plate, paint, stop: () => offs.forEach((f) => f()) };
  paint(content());
  screen.classList.add('is-cc-open');
  live.forEach((p) => p.start());
  return layer;
}

/** Open it (the Menu key, or a pull that went far enough). */
export function openControlCenter() {
  if (layer || topLayer()) return;
  create(false);
}

/** Close it; `animate: false` when a drag already took the plate up. */
export function close({ animate = true } = {}) {
  if (!layer) return;
  const { entry, stop } = layer;
  layer = null;
  stop();
  live.forEach((p) => p.stop());
  screen.classList.remove('is-cc-open');
  closeLayer(entry, { animate });
}

/** A drag that starts in the status-bar band pulls the plate down with the finger. */
function pullFromBand(e) {
  if (layer || topLayer()) return;
  const y0 = e.clientY;
  let started = false;
  let h = 0;
  capture(band, e.pointerId);
  const move = (ev) => {
    const dy = ev.clientY - y0;
    if (!started) {
      if (dy < 6) return;
      started = true;
      create(true);
      setPull(0);
      h = layer.panel.offsetHeight;
    }
    setPull(clamp(dy / h));
  };
  const up = async (ev) => {
    band.removeEventListener('pointermove', move);
    band.removeEventListener('pointerup', up);
    band.removeEventListener('pointercancel', up);
    if (!started || !layer) return;
    if (clamp((ev.clientY - y0) / h) > OPEN_AT) settle(1);
    else { await settle(0); close({ animate: false }); }
  };
  band.addEventListener('pointermove', move);
  band.addEventListener('pointerup', up);
  band.addEventListener('pointercancel', up);
}

export function mountControlCenter(screenEl) {
  screen = screenEl;
  band = el(html`<div class="rl-cc-band" aria-hidden="true"></div>`);
  screen.appendChild(band);
  band.addEventListener('pointerdown', pullFromBand);
  menuPressed.on(() => (layer ? close() : openControlCenter()));
}
