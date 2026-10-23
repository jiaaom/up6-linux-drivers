// 设置 — the fourth tab. Every row either works where it is (slider,
// segments, switch) or opens a page one level down; power actions ask first.
// Changes apply at once: there is no 保存.

import { api } from '../../core/api.js';
import { html, on, painter } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { getLang, setLang, t } from '../../core/i18n.js';
import { panel, refreshPanel } from '../../core/panel.js';
import { getMode, nightInfo, setTheme } from '../../core/theme.js';
import { confirm, toast } from '../../shell/layers.js';
import { lazy, push } from '../../shell/router.js';
import { backdrop, hostbar, titledPanel } from '../../ui/page.js';
import {
  actionRow, foot, linkRow, list, pressSegment, section, segRow, sliderRow, switchRow, trackSlider,
} from '../../ui/settings.js';
import { MODULES, hiddenModules } from '../overview/modules.js';
import { idleValue } from './idle.js';
import * as data from '../../data/stores.js';

const FAN_PROFILES = ['silent', 'balance', 'performance', 'custom'];

const PAGES = {
  idle: lazy(() => import('./idle.js')),
  night: lazy(() => import('./night.js')),
  modules: lazy(() => import('./modules.js')),
  leds: lazy(() => import('./leds.js')),
  sound: lazy(() => import('./sound.js')),
  account: lazy(() => import('./account.js')),
  update: lazy(() => import('./update.js')),
  about: lazy(() => import('./about.js')),
};

/**
 * 设置's status line: is the system up to date? A fnOS update first (opens
 * 系统更新), then signed out of fnOS (opens 账号), else the fnOS version.
 */
function status(fw) {
  if (fw?.update_available) return { level: 'info', iconName: 'arrow-circle-up', text: t('settings.status.update', { v: fw.available }), attrs: html` data-page="update"` };
  if (data.account.data && !data.account.data.signedIn) return { level: 'warn', iconName: 'user', text: t('settings.status.signedOut'), attrs: html` data-page="account"` };
  return fw?.current ? { text: t('settings.status.latest', { v: fw.current }) } : null;
}

/** Show a change in the cached /api/panel at once, so a poll in flight doesn't paint the old value back. */
function patch(section, key, value) {
  const d = panel.data;
  if (d) d[section] = { ...d[section], [key]: value };
}

/** Debounce a PUT while a slider moves. */
function debounced(fn, ms = 150) {
  let timer = 0;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), ms); };
}

function ledsValue(l) {
  const night = l?.night;
  if (night?.manual) return t('settings.ledsNightOn');
  if (night?.schedule) return t('settings.ledsNightFrom', { time: night.schedule.split('-')[0] });
  return '';
}

function soundValue(a) {
  if (data.soundProblem(a)) return t('settings.soundOff');
  const out = data.defaultOutput(a);
  return out ? `${out.name} · ${Math.round((out.volume ?? 0) * 100)}` : '';
}

/** 夜间时段 under 主题 while it follows the night: the window, and a hold from 夜案. */
function nightRow(n) {
  const hold = n?.hold;
  return linkRow({
    label: t('settings.night'),
    sub: true,
    subText: hold ? t(hold.theme === 'dark' ? 'settings.nightHoldDark' : 'settings.nightHoldLight', { time: hold.until }) : '',
    value: n ? `${n.from}–${n.to}` : '',
    attrs: html` data-page="night"`,
  });
}

function accountRow(acc) {
  if (acc?.signedIn) {
    const role = acc.admin ? t('account.admin') : t('account.user');
    return linkRow({
      lead: html`<span class="rl-set__avatar" aria-hidden="true">${(acc.username || '?')[0].toUpperCase()}</span>`,
      label: t('settings.account'),
      subText: `${acc.username} · ${role}`,
      value: t('settings.signedIn'),
      attrs: html` data-page="account"`,
    });
  }
  return linkRow({ iconName: 'user', label: t('settings.account'), subText: t('settings.accountWhy'), value: t('settings.signedOut'), attrs: html` data-page="account"` });
}

export default function settingsPage(ctx) {
  const paint = painter(ctx.el);
  const putBrightness = debounced((value) => api.put('display/brightness', { value }).catch(() => {}), 120);

  function render() {
    const d = panel.data ?? {};
    const shown = MODULES.length - hiddenModules(d).length;
    const fw = data.firmware.data;
    const ab = data.about.data;
    const brightness = d.display?.brightness ?? 50;
    const body = html`<div class="rl-set">
      ${section('settings.secScreen')}
      ${list([
        sliderRow({ iconName: 'sun', label: t('settings.brightness'), value: brightness, valueText: `${brightness}%`, attrs: html` data-act="brightness"` }),
        linkRow({ iconName: 'timer', label: t('settings.idle'), value: idleValue(d), attrs: html` data-page="idle"` }),
      ])}
      ${section('settings.secLook')}
      ${list([
        segRow({
          iconName: 'circle-half', label: t('settings.theme'), current: getMode(), attrs: html` data-act="theme"`,
          options: ['light', 'dark', 'night'].map((m) => ({ value: m, label: t(`settings.theme${m[0].toUpperCase()}${m.slice(1)}`) })),
        }),
        getMode() === 'night' && nightRow(nightInfo()),
        segRow({
          iconName: 'translate', label: t('settings.language'), current: getLang(), attrs: html` data-act="lang"`,
          options: [{ value: 'zh', label: '中文' }, { value: 'en', label: 'English' }],
        }),
        switchRow({ iconName: 'sun', label: t('settings.backdrop'), subText: t('settings.backdropSub'), checked: d.backdrop?.motion !== false, attrs: html` data-act="backdrop"` }),
        d.backdrop?.motion !== false && switchRow({ sub: true, label: t('settings.backdropBattery'), subText: t('settings.backdropBatterySub'), checked: d.backdrop?.battery_pause !== false, attrs: html` data-act="backdropBattery"` }),
        linkRow({ iconName: 'squares-four', label: t('settings.modules'), value: t('settings.modulesShown', { n: shown }), attrs: html` data-page="modules"` }),
      ])}
      ${section('settings.secHardware')}
      ${list([
        d.leds?.available !== false && linkRow({ iconName: 'lightbulb', label: t('settings.leds'), value: ledsValue(data.leds.data), attrs: html` data-page="leds"` }),
        linkRow({ iconName: 'speaker-high', label: t('settings.sound'), value: soundValue(data.audio.data), attrs: html` data-page="sound"` }),
        segRow({
          iconName: 'fan', label: t('settings.fan'), current: data.fan.data?.profile, attrs: html` data-act="fan"`,
          options: FAN_PROFILES.map((p) => ({ value: p, label: t(`settings.fan.${p}`) })),
        }),
      ])}
      ${section('settings.secAccess')}
      ${list([
        accountRow(data.account.data),
        switchRow({ iconName: 'terminal-window', label: 'SSH', subText: t('settings.sshSub'), checked: d.ssh?.enabled, attrs: html` data-act="ssh"` }),
      ])}
      ${section('settings.secSystem')}
      ${list([
        linkRow({ iconName: 'arrow-circle-up', label: t('settings.update'), value: fw ? t(fw.update_available ? 'settings.updateNew' : 'settings.updateCurrent') : '', attrs: html` data-page="update"` }),
        linkRow({ iconName: 'info', label: t('settings.about'), value: ab ? [ab.model, t('about.panelVersion', { v: ab.panel })].filter(Boolean).join(' · ') : '', attrs: html` data-page="about"` }),
      ])}
      ${section('settings.secPower')}
      ${list([
        actionRow({ iconName: 'arrows-clockwise', label: t('settings.restartPanel'), attrs: html` data-act="restartPanel"` }),
        actionRow({ iconName: 'arrow-counter-clockwise', label: t('settings.restartNas'), danger: true, attrs: html` data-act="restart"` }),
        actionRow({ iconName: 'power', label: t('settings.shutdown'), danger: true, attrs: html` data-act="shutdown"` }),
      ])}
      ${foot(t('settings.powerFoot'), 'margin:14px 0 18px')}
    </div>`;
    paint(html`${backdrop()}${hostbar(d.host?.name, status(fw))}${titledPanel({ slip: 'page.settings', body })}`);
  }

  async function power(kind) {
    const ask = {
      restartPanel: { title: t('power.restartPanel'), body: t('power.restartPanelBody'), action: t('power.restartPanelAction'), kind: 'primary', path: 'panel/restart' },
      restart: { title: t('power.restart'), body: t('power.restartBody'), action: t('power.restartAction'), kind: 'danger', path: 'power/restart' },
      shutdown: { title: t('power.shutdown'), body: t('power.shutdownBody'), action: t('power.shutdownAction'), kind: 'danger', path: 'power/shutdown' },
    }[kind];
    if (!(await confirm(ask))) return;
    try {
      await api.post(ask.path);
      toast(t(`power.${kind}Done`));
    } catch (e) {
      toast(t('common.failed', { why: e.message }));
    }
  }

  async function setSwitch(input, path, body, done) {
    try {
      await api.put(path, body);
      if (done) toast(done);
      refreshPanel();
    } catch (e) {
      input.checked = !input.checked;
      toast(t('common.failed', { why: e.message }));
      refreshPanel();
    }
  }

  // segments
  on(ctx.el, 'click', '[data-act] .rl-seg__btn', async (e, btn) => {
    const act = btn.parentElement.dataset.act;
    const v = btn.dataset.value;
    if (btn.getAttribute('aria-pressed') === 'true') return;
    pressSegment(btn);
    try {
      if (act === 'theme') await setTheme(v);
      else if (act === 'lang') await setLang(v);
      else if (act === 'fan') { await api.put('fan', { profile: v }); data.fan.refresh(); }
      refreshPanel();
    } catch (err) {
      toast(t('common.failed', { why: err.message }));
      render();
    }
  });
  // switches
  on(ctx.el, 'change', 'input[data-act]', (e, input) => {
    const act = input.dataset.act;
    if (act === 'backdrop' || act === 'backdropBattery') {
      const key = act === 'backdrop' ? 'motion' : 'battery_pause';
      patch('backdrop', key, input.checked);
      setSwitch(input, 'settings/backdrop', { [key]: input.checked });
      render(); // 用电池时暂停 shows only while 动态背景 is on
    } else if (act === 'ssh') {
      sshSwitch(input);
    }
  });

  // SSH opens a remote shell into the NAS: ask before either change.
  async function sshSwitch(input) {
    const on = input.checked;
    input.checked = !on; // stays as it was until confirmed
    const ok = await confirm(on
      ? { title: t('ssh.onTitle'), body: t('ssh.onBody'), action: t('ssh.onAction'), kind: 'primary' }
      : { title: t('ssh.offTitle'), body: t('ssh.offBody'), action: t('ssh.offAction'), kind: 'danger' });
    if (!ok) return;
    input.checked = on;
    patch('ssh', 'enabled', on);
    setSwitch(input, 'settings/ssh', { on }, t(on ? 'settings.sshOn' : 'settings.sshOff'));
  }
  // brightness
  on(ctx.el, 'input', 'input[data-act="brightness"]', (e, input) => {
    trackSlider(input);
    patch('display', 'brightness', +input.value);
    putBrightness(Math.max(1, +input.value));
  });
  // rows that open a page, and power actions
  on(ctx.el, 'click', '[data-page]', (e, a) => { e.preventDefault(); push(PAGES[a.dataset.page]); });
  on(ctx.el, 'click', 'button[data-act]', (e, b) => power(b.dataset.act));

  for (const res of [data.fan, data.audio, data.leds, data.account, data.firmware, data.about]) ctx.own(res.changed.on(render));
  ctx.own(panel.changed.on(render));

  return {
    title: 'page.settings',
    render,
    show() {
      for (const res of [data.fan, data.audio, data.leds, data.account, data.firmware, data.about]) res.refresh();
    },
  };
}
