// 总览 › 系统: processor, memory, GPU and NPU, fans and the busiest programs.
// Read locally from /api/sysmon every 2 s (no fnOS sign-in needed); rates
// are differences between reads, so the first read may show "—".
// Opened from 温度与风扇 it scrolls to the fans.

import { html, on, painter } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { clock, percent, size, sizeIn } from '../../core/format.js';
import { has, t } from '../../core/i18n.js';
import { panel } from '../../core/panel.js';
import { poller } from '../../core/resource.js';
import { load, save } from '../../core/storage.js';
import { BOARD_RANGES, RANGE_SECONDS, fan, history, sysmon } from '../../data/stores.js';
import { sheet } from '../../shell/layers.js';
import { cap, cell, cellset, compactMeter, figure, kv, sec, split } from '../../ui/board.js';
import { spark } from '../../ui/charts.js';
import { subpage } from '../../ui/page.js';
import { loadFailed, skeleton } from '../../ui/states.js';

const RANGES = BOARD_RANGES;
const gb = (b) => `${(b / 1e9).toFixed(1)} GB`;

function cpuCell(c, pts, range) {
  const b = c.busy ?? {};
  const now = Date.now() / 1000;
  return cell(html`${sec('board.cpu', { iconName: 'cpu', count: c.model?.replace(/^Intel\(R\) Core\(TM\) /, '').replace(/\(R\)|\(TM\)/g, '') })}
    <div class="rl-board__row"><div>${figure(b.total == null ? '—' : Math.round(b.total), '%', { hero: true })}</div>
      <div class="rl-board__aside rl-sys-aside"><span>${icon('thermometer-simple')}<b>${c.temp_c == null ? '—' : `${Math.round(c.temp_c)}°`}</b></span><span>${icon('lightning')}<b>${(c.freq_mhz / 1000).toFixed(1)}</b> GHz</span></div></div>
    ${spark(pts, { width: 318, height: 54, label: t('board.cpuSpark', { range: t(`range.${range}`) }), t0: now - RANGE_SECONDS[range], t1: now, top: 100 })}
    ${kv([
      { iconName: 'user', label: t('sys.user'), value: percent(b.user) },
      { iconName: 'gear-six', label: t('sys.system'), value: percent(b.system) },
      { iconName: 'hard-drive', label: t('sys.iowait'), value: percent(b.iowait) },
    ])}
    <div class="rl-readings">${(c.load ?? []).map((v, i) => html`<div><b>${v.toFixed(2)}</b><small>${t(`sys.load${i}`)}</small></div>`)}</div>
    ${cap(t('sys.loadCap', { n: c.threads }))}`);
}

function memCell(m) {
  const other = Math.max(0, m.used - m.apps - (m.zfs_arc ?? 0));
  const cache = (m.cached ?? 0) + (m.zfs_arc ?? 0);
  const free = Math.max(0, m.total - m.apps - cache - other);
  const w = (v) => ((v / m.total) * 100).toFixed(2);
  const parts = [
    { tone: '1', label: t('sys.apps'), v: m.apps },
    { tone: '2', label: t('sys.cache'), v: Math.min(cache, m.total - m.apps) },
    { tone: '3', label: t('sys.other'), v: other },
  ];
  return cell(html`${sec('board.mem', { iconName: 'memory' })}${figure(sizeIn(m.used, m.total), t('sys.usedOf', { total: size(m.total, 0) }))}
    <div class="rl-stack" role="img" aria-label="${t('sys.memParts')}">${parts.map((p) => html`<span class="rl-stack__seg" data-tone="${p.tone}" style="--w:${w(p.v)}"></span>`)}</div>
    <ul class="rl-stack__legend">${parts.map((p) => html`<li><span class="rl-stack__key" data-tone="${p.tone}"></span>${p.label}<b>${gb(p.v)}</b></li>`)}<li><span class="rl-stack__key" data-tone="free"></span>${t('sys.free')}<b>${gb(free)}</b></li></ul>
    ${cap(t('sys.cacheCap'))}`);
}

/** What the GPU is doing, from its engines. */
function gpuUse(g) {
  const e = g.engines ?? {};
  if ((e.video ?? 0) > 1) return t('sys.gpuVideo');
  if ((e.compute ?? 0) > 1) return t('sys.gpuCompute');
  if ((e.render ?? 0) > 1) return t('sys.gpuRender');
  return t('sys.idle');
}

function gpuCell(g) {
  const v = g.busy ?? 0;
  return cell(html`${sec('sys.gpu', { iconName: 'graphics-card' })}${figure(g.busy == null ? '—' : Math.round(v), '%')}
    ${compactMeter(v, [t('sys.gpuShort'), g.temp_c != null ? `${Math.round(g.temp_c)}°` : ''].filter(Boolean).join(' · '))}${cap(gpuUse(g))}`);
}

function npuCell(n) {
  const v = n.busy ?? 0;
  return cell(html`${sec('sys.npu', { iconName: 'brain' })}${figure(n.busy == null ? '—' : Math.round(v), '%')}
    ${compactMeter(v, v > 1 ? t('sys.busy') : t('sys.idle'))}${cap(v > 1 ? t('sys.npuBusy') : t('sys.npuIdle'))}`);
}

function fansCell(fans, profile) {
  return html`<div id="t6-fans">${cell(html`${sec('sys.fans', { iconName: 'fan', count: profile ? t(`settings.fan.${profile}`) : '' })}
    ${cellset(fans.map((f) => ({ iconName: 'fan', value: f.rpm, label: [has(`sys.fan.${f.zone}`) ? t(`sys.fan.${f.zone}`) : f.name, f.pwm_percent != null ? `${f.pwm_percent}%` : ''].filter(Boolean).join(' · ') })), Math.min(3, fans.length))}`)}</div>`;
}

function procsCell(procs) {
  const top = (procs?.top_cpu ?? []).slice(0, 5);
  return cell(html`${sec('sys.procs', { iconName: 'list-numbers' })}
    <div class="rl-ledger" style="--rl-ledger-cols: 1fr auto auto"><div class="rl-ledger__head"><span></span><span>CPU</span><span>${t('sys.memShort')}</span></div>
      ${top.map((p) => html`<div class="rl-ledger__row"><span class="rl-ledger__title">${p.name}</span><span class="rl-ledger__num">${p.cpu.toFixed(1)}%</span><span class="rl-ledger__num rl-ledger__num--muted">${size(p.rss)}</span><span class="rl-ledger__sub">PID ${p.pid}</span></div>`)}
    </div>`, { style: 'padding-bottom:18px' });
}

export default function systemPage(ctx) {
  const paint = painter(ctx.el);
  const live = poller(sysmon, 2000);
  let range = RANGES.includes(load('overview.range')) ? load('overview.range') : '1h';
  let scrolled = false;
  let updated = Date.now() / 1000;
  const cpuHist = () => history('system/cpu', range);

  function render() {
    const s = sysmon.data;
    const head = html`<div class="rl-toolbar"><button class="rl-sortbtn" data-range>${t(`range.${range}`)}${icon('caret-down')}</button><span class="rl-board__updated">${t('sys.updated', { time: clock(updated) })}</span></div>`;
    let body;
    if (!s) {
      body = sysmon.status === 'failed' ? loadFailed() : html`<div class="rl-board">${cell(html`${sec('board.cpu', { iconName: 'cpu' })}${skeleton('title', '40%')}${skeleton('text', '100%')}`)}${cell(html`${sec('board.mem', { iconName: 'memory' })}${skeleton('text', '100%')}`)}</div>`;
    } else {
      const pts = (cpuHist().data?.points ?? []).map((p) => [p[0], p[1]]);
      body = html`<div class="rl-board">
        ${cpuCell(s.cpu, pts, range)}
        ${memCell(s.mem)}
        ${split(s.gpu && gpuCell(s.gpu), s.npu && npuCell(s.npu))}
        ${(s.fans ?? []).length ? fansCell(s.fans, fan.data?.profile) : ''}
        ${procsCell(s.procs)}
      </div>`;
    }
    paint(subpage(ctx, { slip: 'page.system', head, body, hostName: panel.data?.host?.name }));
    if (s && ctx.params.section === 'fans' && !scrolled) {
      scrolled = true;
      requestAnimationFrame(() => ctx.el.querySelector('#t6-fans')?.scrollIntoView({ block: 'start' }));
    }
  }

  on(ctx.el, 'click', '[data-range]', async () => {
    const id = await sheet({ title: t('range.title'), actions: RANGES.map((r) => ({ id: r, icon: r === range ? 'check-square' : 'clock', label: t(`range.${r}`) })) });
    if (!id || id === range) return;
    range = id;
    save('overview.range', range);
    cpuHist().refresh();
    render();
  });

  ctx.own(sysmon.changed.on((r) => { if (r.status === 'idle') updated = Date.now() / 1000; render(); }));
  for (const r of RANGES) ctx.own(history('system/cpu', r).changed.on(() => r === range && render()));
  ctx.own(fan.changed.on(render));
  let histTimer = 0;
  return {
    title: 'page.system',
    render,
    show() { live.start(); fan.refresh(); cpuHist().refresh(); histTimer = setInterval(() => cpuHist().refresh(), 30000); },
    hide() { live.stop(); clearInterval(histTimer); },
  };
}
