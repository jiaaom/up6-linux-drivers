// Storage pools as the overview and 存储池 read them. No markup here.

import { t } from '../core/i18n.js';

/** A disk's warmth: SSDs run warmer than spinning disks. */
export function diskHeat(d) {
  const [warn, alert] = d.ssd ? [60, 70] : [50, 55];
  if (d.temp_c >= alert) return 'alert';
  if (d.temp_c >= warn) return 'warn';
  return '';
}

/** Storage across every volume: used, total, and whether all is well. */
export function storageSummary(ps, fallback) {
  const list = ps ?? (fallback ?? []).map((v) => ({ ...v, health: 'ok', disks: [] }));
  const used = list.reduce((s, p) => s + (p.used_bytes ?? 0), 0);
  const total = list.reduce((s, p) => s + (p.total_bytes ?? 0), 0);
  const ok = list.every((p) => p.health === 'ok');
  return { list, used, total, ok, pct: total ? (used / total) * 100 : 0 };
}

export const layoutLabel = (p) => t(`pool.layout.${p.layout}`) || p.layout;
