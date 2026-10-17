// 设置 › 闲置: the screen dims, then goes off (t6-paneld idle.rs). Both times
// count from the last touch or key; 0 = never. Each segment saves at once.

import { api } from '../../core/api.js';
import { html, on, painter } from '../../core/dom.js';
import { t } from '../../core/i18n.js';
import { panel, refreshPanel } from '../../core/panel.js';
import { toast } from '../../shell/layers.js';
import { subpage } from '../../ui/page.js';
import { foot, list, pressSegment, section, segRow } from '../../ui/settings.js';

const DIM_AFTER = [0, 60, 120, 300, 900];
const DIM_PERCENT = [10, 25, 50];
const OFF_AFTER = [0, 3600, 43200, 86400];

/** The screen's idle settings, with t6-paneld's defaults. */
export function idleOf(d) {
  const s = d?.screen ?? {};
  return { dim: s.dim_after_s ?? 120, percent: s.dim_percent ?? 25, off: s.off_after_s ?? 3600 };
}

/** 设置's row value: 「2 分变暗 · 1 小时熄屏」, 「不变暗 · …」, 「… · 不熄屏」, or 「从不」. */
export function idleValue(d) {
  const { dim, off } = idleOf(d);
  if (!dim && !off) return t('settings.never');
  return [
    dim ? t('settings.idleDim', { n: dim / 60 }) : t('settings.idleNoDim'),
    off ? t('settings.idleOff', { n: off / 3600 }) : t('settings.idleNoOff'),
  ].join(' · ');
}

export default function idlePage(ctx) {
  const paint = painter(ctx.el);

  function render() {
    const { dim, percent, off } = idleOf(panel.data);
    const body = html`<div class="rl-set">
      ${section('idle.secDim')}
      ${list([
        segRow({
          label: t('settings.dimAfter'), current: dim, attrs: html` data-idle="dim_after_s"`,
          options: DIM_AFTER.map((s) => ({ value: s, label: s ? t('settings.minutes', { n: s / 60 }) : t('settings.off') })),
        }),
        // how dim only matters while it dims
        dim > 0 && segRow({
          label: t('settings.dimLevel'), current: percent, sub: true, attrs: html` data-idle="dim_percent"`,
          options: DIM_PERCENT.map((p) => ({ value: p, label: `${p}%` })),
        }),
      ])}
      ${dim > 0 ? foot(t('idle.dimFoot')) : ''}
      ${section('idle.secOff')}
      ${list([
        segRow({
          label: t('settings.timeout'), current: off, attrs: html` data-idle="off_after_s"`,
          options: OFF_AFTER.map((s) => ({ value: s, label: s ? t('settings.hours', { n: s / 3600 }) : t('settings.never') })),
        }),
      ])}
      ${foot(t('idle.foot'), 'margin-bottom:18px')}
    </div>`;
    paint(subpage(ctx, { slip: 'page.idle', body, hostName: panel.data?.host?.name }));
  }

  on(ctx.el, 'click', '[data-idle] .rl-seg__btn', async (e, btn) => {
    const key = btn.parentElement.dataset.idle;
    if (btn.getAttribute('aria-pressed') === 'true') return;
    pressSegment(btn);
    const d = panel.data;
    if (d) d.screen = { ...d.screen, [key]: +btn.dataset.value }; // shown at once; the next poll confirms it
    if (key === 'dim_after_s') render(); // 变暗到 folds away with 关
    try {
      await api.put('settings/screen-idle', { [key]: +btn.dataset.value });
    } catch (err) {
      toast(t('common.failed', { why: err.message }));
    }
    refreshPanel();
  });

  ctx.own(panel.changed.on(render));
  return { title: 'page.idle', render };
}
