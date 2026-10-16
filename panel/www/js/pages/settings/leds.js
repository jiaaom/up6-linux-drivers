// 设置 › 指示灯: the same settings and t6-ledd commands as the Control Center
// LED page (through /api/leds/*). Everything applies at once; the page
// re-reads the daemon every few seconds, so it shows what the lights do.

import { api } from '../../core/api.js';
import { html, on } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { t } from '../../core/i18n.js';
import { poller } from '../../core/resource.js';
import { toast } from '../../shell/layers.js';
import { push } from '../../shell/router.js';
import { resourceSubpage } from '../../ui/page.js';
import { foot, linkRow, list, pressSegment, section, segRow, switchRow } from '../../ui/settings.js';
import { leds } from '../../data/stores.js';
import trayEffectPage, { TRAY_EFFECTS, trayEffect } from './tray-effect.js';

const MODES = ['auto', 'quiet', 'off'];
const SPEEDS = ['slow', 'normal', 'fast'];
const STEP_MIN = 30;

const device = (s, id) => (s.devices || []).find((d) => d.id === id);
const minutes = (hhmm) => { const m = /^(\d\d):(\d\d)$/.exec(hhmm || ''); return m ? +m[1] * 60 + +m[2] : 0; };
const hhmm = (m) => { m = ((m % 1440) + 1440) % 1440; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };

function stepper(which, time) {
  const btn = (delta, label, name) => html`<button class="rl-btn rl-btn--secondary rl-btn--icon rl-btn--sm rl-glass" data-step="${which}" data-delta="${delta}" aria-label="${label}">${icon(name)}</button>`;
  return html`<span class="rl-stepper">${btn(-STEP_MIN, t('leds.earlier'), 'minus')}<span class="rl-stepper__value" data-time="${which}">${time}</span>${btn(STEP_MIN, t('leds.later'), 'plus')}</span>`;
}

function body(s) {
  const night = s.night || {};
  const [from, to] = (night.schedule || '23:00-07:00').split('-');
  const mode = (id) => { const m = device(s, id)?.mode; return MODES.includes(m) ? m : 'off'; };
  const modeOptions = MODES.map((m) => ({ value: m, label: t(`leds.mode.${m}`) }));
  const effect = trayEffect(s);
  const effectLabel = TRAY_EFFECTS.find((e) => e.id === effect)?.label;
  return html`
    ${section('leds.secBays')}
    ${list([
      switchRow({ label: t('leds.bays'), checked: s.bays_enabled, attrs: html` data-put="bays"` }),
      switchRow({ label: t('leds.bayFault'), checked: s.bay_fault_blink, attrs: html` data-put="bay-fault-blink"` }),
    ])}
    ${section('leds.secStatus')}
    ${list([
      device(s, 'power') && switchRow({ label: t('leds.power'), subText: t('leds.powerSub'), checked: device(s, 'power').mode === 'auto', attrs: html` data-put="power"` }),
      device(s, 'wifi') && segRow({ label: 'Wi-Fi', current: mode('wifi'), options: modeOptions, attrs: html` data-mode="wifi"` }),
      switchRow({ label: t('leds.hotspot'), checked: s.wifi_hotspot !== false, attrs: html` data-put="wifi-hotspot"` }),
      device(s, 'bt') && segRow({ label: t('leds.bluetooth'), current: mode('bt'), options: modeOptions, attrs: html` data-mode="bt"` }),
    ])}
    ${foot(t('leds.statusFoot'))}
    ${device(s, 'rgb') ? html`${section('leds.secTray')}
      ${list([
        linkRow({ label: t('leds.effect'), value: effectLabel ? t(effectLabel) : '', attrs: html` data-effect` }),
        segRow({ label: t('leds.speed'), current: s.tray_speed || 'normal', options: SPEEDS.map((v) => ({ value: v, label: t(`leds.speed.${v}`) })), attrs: html` data-speed` }),
      ])}` : ''}
    ${section('leds.secNight')}
    ${list([
      switchRow({ label: t('leds.night'), subText: night.active ? t('leds.nightNow') : t('leds.nightSub'), checked: night.manual, attrs: html` data-night="manual"` }),
      switchRow({ label: t('leds.schedule'), checked: !!night.schedule, attrs: html` data-night="schedule"` }),
      night.schedule && html`<div class="rl-set__row"><span class="rl-set__label">${t('leds.from')}</span>${stepper('from', from)}</div>`,
      night.schedule && html`<div class="rl-set__row"><span class="rl-set__label">${t('leds.to')}</span>${stepper('to', to)}</div>`,
    ])}
    <div style="height:18px"></div>`;
}

export default function ledsPage(ctx) {
  const page = resourceSubpage(ctx, { slip: 'page.leds', res: leds, body });
  const live = poller(leds);

  async function put(path, value) {
    live.hold(5000);
    try {
      await api.put(`leds/${path}`, value);
    } catch (e) {
      toast(t('common.failed', { why: e.message }));
    }
    live.hold(0);
    leds.refresh();
  }

  on(ctx.el, 'change', 'input[data-put]', (e, input) => {
    const path = input.dataset.put;
    put(path, path === 'power' ? { value: input.checked ? 'auto' : 'off' } : { on: input.checked });
  });
  on(ctx.el, 'click', '[data-mode] .rl-seg__btn', (e, btn) => {
    pressSegment(btn);
    put(btn.parentElement.dataset.mode, { value: btn.dataset.value });
  });
  on(ctx.el, 'click', '[data-speed] .rl-seg__btn', (e, btn) => {
    pressSegment(btn);
    put('tray-speed', { speed: btn.dataset.value });
  });
  on(ctx.el, 'click', '[data-effect]', (e) => { e.preventDefault(); push(trayEffectPage); });
  on(ctx.el, 'change', 'input[data-night]', (e, input) => {
    if (input.dataset.night === 'manual') put('night', { on: input.checked });
    else put('night', { schedule: input.checked ? leds.data?.night?.schedule || '23:00-07:00' : null });
  });

  // The night window moves in 30-minute steps and is sent once the taps settle.
  let stepTimer = 0;
  on(ctx.el, 'click', '[data-step]', (e, btn) => {
    const out = ctx.el.querySelector(`[data-time="${btn.dataset.step}"]`);
    out.textContent = hhmm(minutes(out.textContent) + +btn.dataset.delta);
    live.hold(5000);
    clearTimeout(stepTimer);
    stepTimer = setTimeout(() => {
      const from = ctx.el.querySelector('[data-time="from"]').textContent;
      const to = ctx.el.querySelector('[data-time="to"]').textContent;
      if (from === to) { toast(t('leds.sameTimes')); live.hold(0); return; }
      put('night', { schedule: `${from}-${to}` });
    }, 700);
  });

  return { title: 'page.leds', render: page.render, show: live.start, hide: live.stop };
}
