// Numbers, sizes, rates and dates as the panel prints them, in either language.

import { getLang, t } from './i18n.js';

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

/** Split a byte count into a figure and its unit: 5.1e12 → ['5.1', 'TB']. */
export function sizeParts(bytes, digits) {
  if (!(bytes > 0)) return ['0', 'B'];
  const i = Math.min(UNITS.length - 1, Math.floor(Math.log(bytes) / Math.log(1000)));
  const v = bytes / 1000 ** i;
  const d = digits ?? (v >= 100 ? 0 : 1);
  return [String(+v.toFixed(d)), UNITS[i]];
}

/** 5.1e12 → "5.1 TB". */
export const size = (bytes, digits) => sizeParts(bytes, digits).join(' ');

/** Size of `bytes` in the unit of `ref` (for "5.1 / 8 TB"). */
export function sizeIn(bytes, ref) {
  const [, unit] = sizeParts(ref);
  const v = bytes / 1000 ** UNITS.indexOf(unit);
  return String(+v.toFixed(v >= 100 ? 0 : 1));
}

/** Bytes per second → ['38', 'MB/s']. */
export function rateParts(bps) {
  const [v, u] = sizeParts(bps);
  return [v, `${u}/s`];
}

export const percent = (v) => (v == null ? '—' : `${Math.round(v)}%`);

/** 12 天 4 小时 / 3 小时 20 分 */
export function uptime(s) {
  if (s == null) return null;
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return d ? t('time.daysHours', { d, h }) : t('time.hoursMinutes', { h, m });
}

const locale = () => (getLang() === 'zh' ? 'zh-CN' : 'en-GB');

/** 9:41 */
export const clock = (unix) => new Intl.DateTimeFormat(locale(), { hour: 'numeric', minute: '2-digit', hour12: false }).format(new Date(unix * 1000));

/** 10月12日 / 12 Oct */
export const day = (unix) => new Intl.DateTimeFormat(locale(), { month: 'short', day: 'numeric' }).format(new Date(unix * 1000));

/** 今天 9:41 · 昨天 · 10月12日 — for lists grouped by day. */
export function when(unix) {
  const d = new Date(unix * 1000);
  const today = new Date();
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  const same = (a, b) => a.toDateString() === b.toDateString();
  if (same(d, today)) return clock(unix);
  if (same(d, y)) return `${t('time.yesterday')} ${clock(unix)}`;
  return day(unix);
}

/** Which day group a time falls in: 'today' | 'yesterday' | 'earlier'. */
export function dayGroup(unix) {
  const d = new Date(unix * 1000);
  const today = new Date();
  const y = new Date(today);
  y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'today';
  if (d.toDateString() === y.toDateString()) return 'yesterday';
  return 'earlier';
}
