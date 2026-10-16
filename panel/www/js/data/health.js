// "Is it all right?" in one list, most severe first, for the line at the top
// of 总览 and its warning banner. From what t6-paneld sees locally every poll
// (temperatures, fans, battery, volume fill, memory: status.items), the
// storage pools (health, SMART, the last disk check) and fnOS's unread
// warnings. No markup here.
//
// An issue: { level: 'warn' | 'err', text, open } where `open` is what the
// overview's [data-open] goes to (storage, thermals, system, notices) or ''.

import { t } from '../core/i18n.js';

const OPEN = {
  cpu_hot: 'thermals', gpu_hot: 'thermals', drives_hot: 'thermals', fan_stopped: 'thermals',
  volume_full: 'storage', volume_nearly_full: 'storage', memory_full: 'system',
};

export function healthIssues(panelData, pools, notices) {
  const out = [];
  for (const i of panelData?.status?.items ?? []) {
    out.push({ level: i.level, text: t(`health.${i.kind}`, { v: i.value ?? '', name: i.name ?? '' }), open: OPEN[i.kind] ?? '' });
  }
  for (const p of pools ?? []) {
    if (p.health && p.health !== 'ok') out.push({ level: 'err', text: t(p.health === 'faulted' ? 'health.pool_faulted' : 'health.pool_degraded', { name: p.name }), open: 'storage' });
    for (const d of p.disks ?? []) if (d.smart_ok === false) out.push({ level: 'err', text: t('health.smart', { name: d.name }), open: 'storage' });
    if (p.check?.errors) out.push({ level: 'warn', text: t('health.check_errors', { name: p.name, v: p.check.errors }), open: 'storage' });
  }
  const unread = (notices?.items ?? []).filter((n) => !n.read && n.level >= 1);
  if (unread.length) {
    out.push({ level: unread.some((n) => n.level >= 2) ? 'err' : 'warn', text: t('health.notices', { v: unread.length }), open: 'notices' });
  }
  return out.sort((a, b) => (a.level === b.level ? 0 : a.level === 'err' ? -1 : 1));
}

/** The one line: 一切正常, or the most severe issue (and how many more). */
export function healthLine(issues) {
  if (!issues.length) return t('health.ok');
  return issues.length > 1 ? t('health.more', { text: issues[0].text, n: issues.length - 1 }) : issues[0].text;
}
