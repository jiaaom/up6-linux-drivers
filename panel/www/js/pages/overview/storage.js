// 总览 › 存储池: how full each volume is, how fast it fills, the disks under
// it and their care. With several volumes, segments pick one. The trend
// chart covers 30 days, 90 days or a year; the sentence under it says when
// the warning line will be reached at the recent pace.

import { api } from '../../core/api.js';
import { html, on, painter } from '../../core/dom.js';
import { icon } from '../../core/icons.js';
import { clock, day, size, sizeIn, sizeParts } from '../../core/format.js';
import { t } from '../../core/i18n.js';
import { panel } from '../../core/panel.js';
import { poller } from '../../core/resource.js';
import { load, save } from '../../core/storage.js';
import { RANGE_SECONDS, history, pools } from '../../data/stores.js';
import { confirm, toast } from '../../shell/layers.js';
import { cap, cell, figure, foot, kv, sec, split, track } from '../../ui/board.js';
import { chart, followCrosshair } from '../../ui/charts.js';
import { subpage } from '../../ui/page.js';
import { busyRing, loadFailed, skeleton } from '../../ui/states.js';
import { diskHeat, layoutLabel } from '../../data/pools.js';

const RANGES = ['30d', '90d', '1y'];
const WARN = 90;
const id = (p) => p.mount.replace(/^\//, '').replace(/\//g, '_');

/** "约 7 个月后到达提醒线" from the last 30 days' growth, or why it can't say. */
function forecast(p, pts) {
  const month = pts.filter(([tm]) => tm >= Date.now() / 1000 - 30 * 86400);
  if (month.length < 7) return t('pool.forecastWait');
  const [t0, v0] = month[0];
  const [t1, v1] = month[month.length - 1];
  const perDay = (v1 - v0) / Math.max(1, (t1 - t0) / 86400);
  const line = (p.total_bytes * WARN) / 100;
  if (p.used_bytes >= line) return t('pool.forecastOver');
  if (perDay <= 0) return t('pool.forecastFlat');
  const days = (line - p.used_bytes) / perDay;
  if (days > 730) return t('pool.forecastYears');
  return days > 60 ? t('pool.forecastMonths', { n: Math.round(days / 30) }) : t('pool.forecastDays', { n: Math.round(days) });
}

function diskRows(p) {
  return html`<ul class="rl-toc" style="border-top:0">${p.disks.map((d, i) => {
    const lv = diskHeat(d);
    const sub = [d.model, size(d.size_bytes), d.power_on_hours != null ? t('pool.days', { n: Math.round(d.power_on_hours / 24) }) : ''].filter(Boolean).join(' · ');
    return html`<li><div class="rl-toc__item"><span class="rl-toc__lead">${icon('hard-drive', 'light')}</span><span class="rl-toc__main"><span class="rl-toc__title">${t('board.disk', { n: i + 1 })}</span><span class="rl-toc__sub">${sub}</span></span><span class="rl-toc__leader"></span>${lv ? html`<span class="rl-tag rl-tag--warn"><span class="rl-tag__dot"></span>${t(`board.heat.${lv}`)}</span>` : ''}${d.smart_ok === false ? html`<span class="rl-tag rl-tag--danger"><span class="rl-tag__dot"></span>${t('pool.smartBad')}</span>` : ''}<span class="rl-toc__value">${d.temp_c == null ? '—' : Math.round(d.temp_c)}</span><span class="rl-toc__unit">°C</span></div></li>`;
  })}</ul>`;
}

function careRows(p) {
  const c = p.check ?? {};
  const last = c.running
    ? t('pool.checking', { pct: c.progress != null ? Math.round(c.progress) : '…' })
    : c.last ? day(c.last) : t('pool.neverChecked');
  return kv([
    { label: t('pool.lastCheck'), value: last, muted: !c.last && !c.running },
    c.errors != null && c.last && { label: t('pool.found'), value: c.errors ? t('pool.errors', { n: c.errors }) : t('pool.noErrors') },
    { label: t('pool.warnLine'), value: `${WARN}%` },
  ]);
}

export default function storagePage(ctx) {
  const paint = painter(ctx.el);
  const live = poller(pools, 10000);
  let range = RANGES.includes(load('storage.range')) ? load('storage.range') : '90d';
  let pick = ctx.params?.pick ?? 0; // which volume (from 文件 › 设备)
  let updated = Date.now() / 1000;
  let manual = false; // a refresh the person asked for shows; polls stay quiet

  const trend = (p) => history(`${id(p)}/used`, range);

  function poolBody(p) {
    const pct = p.total_bytes ? (p.used_bytes / p.total_bytes) * 100 : 0;
    const healthy = p.health === 'ok';
    const tag = html`<span class="rl-tag ${healthy ? 'rl-tag--tint' : 'rl-tag--warn'}"><span class="rl-tag__dot"></span>${t(healthy ? 'pool.healthy' : `pool.${p.health}`)}</span>`;
    const [, unit] = sizeParts(p.total_bytes);
    const scale = 1000 ** ['B', 'KB', 'MB', 'GB', 'TB', 'PB'].indexOf(unit);
    const pts = (trend(p).data?.points ?? []).map(([tm, v]) => [tm, v / scale]);
    const c = chart(pts, {
      label: t('pool.chartLabel', { range: t(`range.${range}`) }),
      unit,
      ref: { value: (p.total_bytes / scale) * (WARN / 100), label: t('board.warnLine', { pct: WARN }) },
      dates: (tm) => (tm >= Date.now() / 1000 - 43200 ? t('time.today') : day(tm)),
      top: p.total_bytes / scale,
      t0: Date.now() / 1000 - RANGE_SECONDS[range],
      t1: Date.now() / 1000,
    });
    const running = p.check?.running;
    return {
      chart: c,
      markup: html`
        ${cell(html`${figure(sizeIn(p.used_bytes, p.total_bytes), `/ ${size(p.total_bytes)}`, { hero: true, tag })}
          ${track(pct, { label: t('board.storageUsed'), mark: WARN, style: 'margin-top:8px' })}
          ${foot(t('pool.usedLeft', { pct: Math.round(pct), left: size(p.total_bytes - p.used_bytes) }), t('board.warnLine', { pct: WARN }))}`)}
        ${cell(html`${sec('pool.trend')}
          <div class="rl-seg rl-glass rl-chart__range" role="group" aria-label="${t('range.title')}" data-range>${RANGES.map((r) => html`<button class="rl-seg__btn" data-value="${r}" aria-pressed="${r === range}">${t(`range.${r}`)}</button>`)}</div>
          ${pts.length ? c.markup : html`<p class="rl-board__cap" style="padding:30px 0">${t('pool.noHistory')}</p>`}
          ${cap(forecast(p, pts.map(([tm, v]) => [tm, v * scale])))}`)}
        ${cell(html`${sec('pool.disks', { count: [layoutLabel(p), t('board.disks', { n: p.disks.length })].join(' · ') })}${diskRows(p)}`, { style: 'padding-bottom:4px' })}
        ${split(
          cell(html`${sec('pool.array')}${kv([
            { label: t('pool.type'), value: layoutLabel(p) },
            { label: t('pool.tolerance'), value: p.redundancy ? t('pool.canLose', { n: p.redundancy }) : t('pool.noTolerance'), muted: !p.redundancy },
            { label: t('pool.fs'), value: p.fs === 'zfs' ? 'ZFS' : p.fs === 'btrfs' ? 'Btrfs' : p.fs },
          ])}`),
          cell(html`${sec('pool.care')}${careRows(p)}`),
        )}
        ${['zfs', 'btrfs'].includes(p.fs) ? cell(html`<button class="rl-btn rl-btn--secondary rl-btn--block" data-check="${p.mount}"${running ? html` disabled` : ''}>${icon('stethoscope')}${running ? t('pool.checkingButton') : t('pool.check')}</button>`) : ''}`,
    };
  }

  function skeletonBody() {
    return html`<div class="rl-board">${cell(html`${skeleton('title', '45%')}${skeleton('text', '100%')}`)}${cell(html`${sec('pool.trend')}${skeleton('text', '100%')}${skeleton('text', '70%')}`)}${cell(html`${sec('pool.disks')}${skeleton('text', '90%')}${skeleton('text', '90%')}`)}</div>`;
  }

  let current = null;
  function render() {
    const ps = pools.data;
    const busy = manual || (!pools.data && pools.status === 'loading');
    let body;
    let subtitle = '';
    if (!ps) {
      body = pools.status === 'failed' ? loadFailed() : skeletonBody();
    } else {
      pick = Math.min(pick, ps.length - 1);
      const p = ps[pick];
      current = poolBody(p);
      subtitle = [p.name, layoutLabel(p), t('board.disks', { n: p.disks.length })].join(' · ');
      body = html`<div class="rl-board">
        ${ps.length > 1 ? cell(html`<div class="rl-seg rl-glass" role="group" aria-label="${t('pool.volumes')}" data-pool>${ps.map((x, i) => html`<button class="rl-seg__btn" data-value="${i}" aria-pressed="${i === pick}">${x.name}</button>`)}</div>`) : ''}
        ${current.markup}
      </div>`;
    }
    const failed = pools.status === 'failed' && ps;
    const line = busy ? t('board.refreshing') : failed ? t('board.refreshFailed', { time: clock(updated) }) : t('board.updated', { time: clock(updated) });
    const head = html`<div class="rl-toolbar"><span class="rl-board__updated" style="margin-left:0">${[subtitle, line].filter(Boolean).join(' · ')}</span>
      ${busy && ps ? html`<span style="margin-left:auto">${busyRing(t('board.refreshing'))}</span>` : html`<button class="rl-btn rl-btn--secondary rl-btn--icon rl-btn--sm" style="margin-left:auto" data-refresh aria-label="${t('board.refresh')}">${icon('arrows-clockwise')}</button>`}</div>`;
    paint(subpage(ctx, { slip: 'page.storage', head, body, hostName: panel.data?.host?.name }));
    const wrap = ctx.el.querySelector('[data-chart]');
    if (wrap && current && !wrap.dataset.wired) {
      wrap.dataset.wired = '1';
      const [, unit] = sizeParts(ps[pick].total_bytes);
      followCrosshair(wrap, current.chart, ([tm, v]) => ({ value: `${+v.toFixed(2)} ${unit}`, date: day(tm) }));
    }
  }

  on(ctx.el, 'click', '[data-range] .rl-seg__btn', (e, b) => {
    range = b.dataset.value;
    save('storage.range', range);
    for (const p of pools.data ?? []) trend(p).refresh();
    render();
  });
  on(ctx.el, 'click', '[data-pool] .rl-seg__btn', (e, b) => { pick = +b.dataset.value; trend(pools.data[pick]).refresh(); render(); });
  on(ctx.el, 'click', '[data-refresh]', async () => {
    manual = true;
    render();
    for (const p of pools.data ?? []) trend(p).refresh();
    await pools.refresh();
    manual = false;
    render();
  });
  on(ctx.el, 'click', '[data-check]', async (e, b) => {
    const ok = await confirm({ title: t('pool.checkTitle'), body: t('pool.checkBody'), action: t('pool.check'), actionIcon: 'stethoscope' });
    if (!ok) return;
    try {
      await api.post('storage/check', { mount: b.dataset.check });
      toast(t('pool.checkStarted'));
    } catch (err) {
      toast(t('common.failed', { why: err.message }));
    }
    pools.refresh();
  });

  const watched = new Set(); // trend stores this page listens to
  ctx.own(pools.changed.on((r) => {
    if (r.status === 'idle') {
      updated = Date.now() / 1000;
      for (const p of r.data ?? []) {
        for (const rg of RANGES) {
          const h = history(`${id(p)}/used`, rg);
          if (!watched.has(h)) { watched.add(h); ctx.own(h.changed.on(render)); }
        }
        if (!trend(p).data && trend(p).status === 'idle') trend(p).refresh();
      }
    }
    render();
  }));

  return { title: 'page.storage', render, show: live.start, hide: live.stop };
}
