// 总览 — the first tab: a 版面 of readings in one frame. It opens with 本机,
// the device drawn with its five readings (device.js); then storage (the one
// hero figure), processor and memory, temperatures and fans, network,
// containers, transfers, battery and notices. Modules
// turned off in 设置 › 总览模块 leave the board; of a side-by-side pair, the
// one left takes the whole row. The health banner shows whenever something
// is wrong. Sparklines cover the time range in the panel's running head.

import { html, on, painter } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { clock, percent, rateParts, size, sizeIn, when } from '../../core/format.js';
import { t } from '../../core/i18n.js';
import { panel, refreshPanel } from '../../core/panel.js';
import { poller } from '../../core/resource.js';
import { load, save } from '../../core/storage.js';
import * as net from '../../data/network.js';
import { BOARD_RANGES, RANGE_SECONDS, account, containers, history, notices, pools, sysmon } from '../../data/stores.js';
import { sheet } from '../../shell/layers.js';
import { goTo, lazy, push } from '../../shell/router.js';
import { cap, cell, cellset, compactMeter, figure, foot, kv, sec, split, statuslist, track } from '../../ui/board.js';
import { spark } from '../../ui/charts.js';
import { backdrop, hostbar, titledPanel } from '../../ui/page.js';
import { busyRing } from '../../ui/states.js';
import { diskHeat, layoutLabel, storageSummary } from '../../data/pools.js';
import { healthIssues, healthLine } from '../../data/health.js';
import { deviceCell } from './device.js';
import { hiddenModules } from './modules.js';

const RANGES = BOARD_RANGES;

const PAGES = {
  storage: lazy(() => import('./storage.js')),
  system: lazy(() => import('./system.js')),
  notices: lazy(() => import('./notices.js')),
  modules: lazy(() => import('../settings/modules.js')),
  account: lazy(() => import('../settings/account.js')),
};

function points(res) {
  return (res?.data?.points ?? []).map((p) => [p[0], p[1]]);
}

export default function overviewPage(ctx) {
  const paint = painter(ctx.el);
  let range = RANGES.includes(load('overview.range')) ? load('overview.range') : '1h';
  const live = [poller(sysmon, 2000), poller(pools, 30000), poller(containers, 30000)];
  const noticesLive = poller(notices, 30000);
  let histTimer = 0;
  let lastUpdate = Date.now() / 1000;
  let refreshing = false; // a refresh the person asked for (polls stay quiet)
  // throughput for 本机 › 网口, from the byte counters in the panel poll
  let rate = null;
  let counted = null;
  const count = () => {
    const c = panel.data?.net;
    if (!c) return;
    const now = performance.now();
    if (counted && now - counted.at > 500) {
      const dt = (now - counted.at) / 1000;
      rate = { rx: Math.max(0, (c.rx_bytes - counted.rx) / dt), tx: Math.max(0, (c.tx_bytes - counted.tx) / dt) };
    }
    if (!counted || now - counted.at > 500) counted = { at: now, rx: c.rx_bytes, tx: c.tx_bytes };
  };

  const hist = (name) => history(`system/${name}`, range);
  const refreshHistory = () => ['cpu', 'temp', 'rx'].forEach((n) => hist(n).refresh());

  function sparkOf(name, opts) {
    const now = Date.now() / 1000;
    return spark(points(hist(name)), { t0: now - RANGE_SECONDS[range], t1: now, ...opts });
  }

  // ---------- modules ----------

  /** The board's banner: every issue but the unread notices (their own module shows them). */
  function healthBanner(issues) {
    const list = issues.filter((x) => x.open !== 'notices');
    if (!list.length) return '';
    const danger = list[0].level === 'err';
    const rest = list.slice(1).map((x) => x.text).join(' · ');
    return html`<div class="rl-board__cell"><div class="rl-notice rl-notice--${danger ? 'danger' : 'warn'}" role="status">${icon('warning-circle')}<div class="rl-notice__body"><strong class="rl-notice__title">${list[0].text}</strong>${rest}</div></div></div>`;
  }

  function storageCell(d) {
    const s = storageSummary(pools.data, d.storage);
    if (!s.total) return '';
    const one = s.list.length === 1 ? s.list[0] : null;
    const tagText = one && one.layout
      ? [layoutLabel(one), t('board.disks', { n: one.disks.length }), t(one.health === 'ok' ? 'pool.healthy' : 'pool.degraded')].join(' · ')
      : t(s.ok ? 'board.volumesOk' : 'board.volumesWarn', { n: s.list.length });
    const tag = html`<span class="rl-tag ${s.ok ? 'rl-tag--tint' : 'rl-tag--warn'}"><span class="rl-tag__dot"></span>${tagText}</span>`;
    return cell(html`${sec('board.storage', { go: true })}
      ${figure(sizeIn(s.used, s.total), `/ ${size(s.total)}`, { hero: true, tag })}
      ${track(s.pct, { label: t('board.storageUsed'), mark: 90, style: 'margin-top:8px' })}
      ${foot(t('board.used', { pct: Math.round(s.pct) }), t('board.warnLine', { pct: 90 }))}`, { open: 'storage' });
  }

  function cpuCell(s) {
    const c = s?.cpu;
    if (!c) return '';
    const busy = c.busy?.total;
    return cell(html`${sec('board.cpu', { go: true })}${figure(busy == null ? '—' : Math.round(busy), '%')}
      ${sparkOf('cpu', { width: 150, height: 34, label: t('board.cpuSpark', { range: t(`range.${range}`) }), top: 100 })}
      ${cap(t('board.cpuCap', { threads: c.threads, ghz: (c.freq_mhz / 1000).toFixed(1) }))}`, { open: 'system' });
  }

  function memCell(s) {
    const m = s?.mem;
    if (!m) return '';
    const gpu = s.gpu?.busy;
    return cell(html`${sec('board.mem', { go: true })}${figure(sizeIn(m.used, m.total), `/ ${size(m.total, 0)}`)}
      ${compactMeter(m.used_pct, t('board.memUsed'), percent(m.used_pct))}
      <div style="height:8px"></div>
      ${gpu != null ? compactMeter(gpu, 'GPU', percent(gpu)) : ''}`, { open: 'system' });
  }

  function thermalsCell(s) {
    const c = s?.cpu;
    if (!c) return '';
    const fan = (s.fans ?? [])[0];
    const disks = (pools.data ?? []).flatMap((p) => p.disks).filter((x) => x.temp_c != null);
    return cell(html`${sec('board.thermals', { go: true })}
      <div class="rl-board__row"><div>${figure(c.temp_c == null ? '—' : Math.round(c.temp_c), t('board.cpuTempUnit'))}
        ${sparkOf('temp', { width: 200, height: 40, label: t('board.tempSpark', { range: t(`range.${range}`) }), base: null })}</div>
        ${fan ? html`<div class="rl-board__aside">${icon('fan', 'light')}<span class="rl-figure__num" style="font-size:22px;line-height:26px">${fan.rpm}</span><span class="rl-figure__unit">rpm</span></div>` : ''}</div>
      ${disks.length ? cellset(disks.map((x, i) => {
        const lv = diskHeat(x);
        return { value: `${Math.round(x.temp_c)}°`, label: lv ? `${t('board.disk', { n: i + 1 })} · ${t(`board.heat.${lv}`)}` : t('board.disk', { n: i + 1 }), level: lv };
      })) : ''}`, { open: 'thermals' });
  }

  function networkCell(d) {
    const rx = points(hist('rx'));
    const tx = points(history('system/tx', range));
    const last = (p) => (p.length ? p[p.length - 1][1] : 0);
    const [v, u] = rateParts(last(rx));
    const eth = net.wired(d.network);
    const link = eth?.state === 'on' ? `${net.speedShort((d.network.ethernet_ports ?? []).filter((p) => p.connected).reduce((m, p) => Math.max(m, p.speed_mbps ?? 0), 0))}bE` : d.network?.wifi?.connected ? 'Wi-Fi' : '';
    return cell(html`${sec('board.network', { go: true })}${figure(v, `${u} ↓`)}
      ${sparkOf('rx', { width: 150, height: 30, label: t('board.rxSpark', { range: t(`range.${range}`) }), area: false })}
      ${cap([link, `↑ ${rateParts(last(tx)).join(' ')}`].filter(Boolean).join(' · '))}`, { open: 'network' });
  }

  function containersCell() {
    const c = containers.data;
    if (!c?.available || !c.items.length) return '';
    const running = c.items.filter((x) => x.running).length;
    return cell(html`${sec('board.containers', { count: t('board.running', { n: running, total: c.items.length }) })}
      ${statuslist(c.items.slice(0, 8).map((x) => ({ name: x.name, sub: x.running ? '' : t('board.stopped'), off: !x.running })))}`);
  }

  function batteryCell(d) {
    const b = d.battery;
    if (!b?.present) return '';
    const state = { Charging: 'cc.charging', Full: 'cc.full', Discharging: 'cc.onBattery' }[b.status] ?? (b.ac ? 'cc.onPower' : 'cc.onBattery');
    return cell(html`${sec('board.battery')}${figure(b.capacity, '%')}${track(b.capacity, { label: t('board.battery') })}${cap(t(state))}`);
  }

  function noticesCell() {
    if (!account.data?.signedIn) {
      return cell(html`${sec('board.notices', { go: true })}${cap(t('board.noticesSignIn'))}`, { open: 'account' });
    }
    const n = notices.data;
    const items = (n?.items ?? []).slice(0, 3);
    return cell(html`${sec('board.notices', { go: true, count: n?.unread ? t('notices.unread', { n: n.unread }) : '' })}
      ${items.length ? kv(items.map((x) => ({ label: x.title, value: when(x.datetime), muted: !!x.read }))) : cap(t('notices.none'))}`, { open: 'notices' });
  }

  // ---------- the page ----------

  function render() {
    const d = panel.data ?? {};
    const s = sysmon.data;
    const hidden = new Set(hiddenModules(d));
    const shown = (id) => !hidden.has(id);
    const busy = refreshing;
    const head = html`<div class="rl-toolbar">
      <button class="rl-sortbtn" data-range>${t(`range.${range}`)}${icon('caret-down')}</button>
      <span class="rl-board__updated">${busy ? t('board.refreshing') : t('board.updated', { time: clock(lastUpdate) })}</span>
      ${busy ? busyRing(t('board.refreshing')) : html`<button class="rl-btn rl-btn--secondary rl-btn--icon rl-btn--sm" data-refresh aria-label="${t('board.refresh')}">${icon('arrows-clockwise')}</button>`}
    </div>`;
    const issues = healthIssues(d, pools.data, account.data?.signedIn ? notices.data : null);
    const body = html`<div class="rl-board">
      ${healthBanner(issues)}
      ${shown('device') ? deviceCell(s, pools.data, d, rate) : ''}
      ${shown('storage') ? storageCell(d) : ''}
      ${split(shown('system') && cpuCell(s), shown('system') && memCell(s))}
      ${shown('thermals') ? thermalsCell(s) : ''}
      ${shown('network') ? networkCell(d) : ''}
      ${shown('containers') ? containersCell() : ''}
      ${shown('battery') ? batteryCell(d) : ''}
      ${shown('notices') ? noticesCell() : ''}
    </div>`;
    // the status line answers "is it all right?"; a problem opens where it is
    const top = issues[0];
    const status = { text: healthLine(issues), level: top?.level ?? 'ok', attrs: top?.open ? html` data-open="${top.open}"` : '' };
    const gear = html`<button class="rl-btn rl-btn--secondary rl-btn--icon rl-glass" data-modules aria-label="${t('settings.modules')}">${icon('gear')}</button>`;
    paint(html`${backdrop()}${hostbar(d.host?.name, status, gear)}
      ${titledPanel({ slip: 'page.overview', head, body })}`);
  }

  on(ctx.el, 'click', '[data-open]', (e, a) => {
    e.preventDefault();
    const to = a.dataset.open;
    if (to === 'network') goTo('network');
    else if (to === 'thermals') push(PAGES.system, { section: 'fans' });
    else push(PAGES[to]);
  });
  on(ctx.el, 'click', '[data-modules]', () => push(PAGES.modules));
  on(ctx.el, 'click', '[data-refresh]', async () => {
    refreshing = true;
    render();
    refreshHistory();
    refreshPanel();
    await Promise.all([sysmon, pools, containers].map((r) => r.refresh()));
    refreshing = false;
    stamp();
  });
  on(ctx.el, 'click', '[data-range]', async () => {
    const id = await sheet({ title: t('range.title'), actions: RANGES.map((r) => ({ id: r, icon: r === range ? 'check-square' : 'clock', label: t(`range.${r}`) })) });
    if (!id || id === range) return;
    range = id;
    save('overview.range', range);
    refreshHistory();
    render();
  });

  const stamp = () => { lastUpdate = Date.now() / 1000; render(); };
  for (const r of [sysmon, pools, containers, notices, account]) ctx.own(r.changed.on((res) => (res.status === 'idle' ? stamp() : render())));
  ctx.own(panel.changed.on(() => { count(); render(); }));
  ctx.own(() => clearInterval(histTimer));
  // each range's history lives in its own store; follow the one on screen
  for (const r of RANGES) for (const n of ['cpu', 'temp', 'rx', 'tx']) ctx.own(history(`system/${n}`, r).changed.on(() => r === range && render()));

  return {
    title: 'page.overview',
    render,
    show() {
      live.forEach((p) => p.start());
      account.refresh();
      if (account.data?.signedIn) noticesLive.start();
      refreshHistory();
      history('system/tx', range).refresh();
      clearInterval(histTimer);
      histTimer = setInterval(() => { refreshHistory(); history('system/tx', range).refresh(); }, 30000);
    },
    hide() {
      live.forEach((p) => p.stop());
      noticesLive.stop();
      clearInterval(histTimer);
    },
  };
}
