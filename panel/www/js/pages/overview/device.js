// 总览 › 本机: the UP6 as an ink line drawing (Ridgeline Dashboard › 本机,
// device-up6.png as a mask, so it follows the theme) with 图注: a leader from
// where each reading lives in the box to its note. CPU and memory under the
// fins, temperature low in the fins, the network at its port, storage low in
// the body. Pins are in the drawing's 160 × 240 space and the notes are
// ordered by pin height, so the leaders never cross. Tapping opens 系统.

import { html } from '../../core/dom.js';
import { rateParts, size, sizeIn } from '../../core/format.js';
import { getLang, t } from '../../core/i18n.js';
import { diskHeat, storageSummary } from '../../data/pools.js';
import * as net from '../../data/network.js';
import { level } from '../../ui/board.js';

// pin [x, y] per note, top to bottom; a note's leader ends at its top + 15
const PINS = [[92, 60], [80, 98], [98, 132], [118, 147], [48, 166]];
const NOTE_TOP = 11;
const NOTE_STEP = 48;

const meter = (v, warn) => {
  const pct = Math.max(0, Math.min(100, Math.round(v ?? 0)));
  return html`<span class="rl-device__meter${warn ? ' is-warn' : ''}" style="--v:${pct}" role="meter" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"></span>`;
};

/** The hottest pool disk that is warm, as "盘 4 偏热 52°" / "Disk 4 · 52°C". */
function warmDisk(pools) {
  const disks = (pools ?? []).flatMap((p) => p.disks ?? []).filter((x) => x.temp_c != null);
  let hot = -1;
  disks.forEach((x, i) => { if (diskHeat(x) && (hot < 0 || x.temp_c > disks[hot].temp_c)) hot = i; });
  return hot < 0 ? '' : t('device.warmDisk', { n: hot + 1, c: Math.round(disks[hot].temp_c) });
}

/**
 * The five notes from the readings: sysmon (CPU, memory, temperature, fan),
 * the pools (storage, disk temperatures), the panel poll (link) and the
 * current throughput (`rate`: { rx, tx } in bytes per second, or null).
 */
function notes(s, pools, d, rate) {
  const cpu = s?.cpu?.busy?.total;
  const mem = s?.mem;
  const temp = s?.cpu?.temp_c;
  const fan = (s?.fans ?? []).find((f) => f.rpm);
  const warm = warmDisk(pools);
  const port = (d.network?.ethernet_ports ?? []).filter((p) => p.connected).reduce((m, p) => Math.max(m, p.speed_mbps ?? 0), 0);
  const wired = net.wired(d.network)?.state === 'on';
  const st = storageSummary(pools, d.storage);
  let flow = '';
  if (wired && rate) {
    const [rv, ru] = rateParts(rate.rx);
    const [tv, tu] = rateParts(rate.tx);
    flow = `↓ ${rv} ${ru} · ↑ ${tv}${tu === ru ? '' : ` ${tu}`}`;
  }
  const speed = wired && port ? net.speedShort(port) : '';
  return [
    { name: t('device.cpu'), fig: cpu == null ? '—' : Math.round(cpu), unit: '%', more: meter(cpu, level(cpu ?? 0)) },
    { name: t('device.mem'), fig: mem ? sizeIn(mem.used, mem.total) : '—', unit: mem ? `/ ${size(mem.total, 0)}` : '', more: meter(mem?.used_pct, level(mem?.used_pct ?? 0)) },
    {
      name: t('device.temp'), fig: temp == null ? '—' : Math.round(temp), unit: '°C', state: warm ? 'warn' : '',
      more: warm ? html`<span class="rl-device__tag">${warm}</span>` : fan ? html`<span class="rl-device__detail">${t('device.fan', { rpm: fan.rpm })}</span>` : '',
    },
    {
      name: t('device.lan'), fig: speed ? speed.replace(/[GM]$/, '') : '—', unit: speed ? speed.slice(-1) : '', state: wired ? 'on' : '',
      more: html`<span class="rl-device__detail">${wired ? flow : t('device.unplugged')}</span>`,
    },
    {
      name: t('device.storage'), fig: st.total ? sizeIn(st.used, st.total) : '—', unit: st.total ? `/ ${size(st.total)}` : '',
      state: st.total && st.pct >= 90 ? 'warn' : '', more: meter(st.pct, st.pct >= 90),
    },
  ];
}

export function deviceCell(s, pools, d, rate) {
  const list = notes(s, pools, d, rate);
  const leads = list.map((n, i) => {
    const [x, y] = PINS[i];
    const ly = NOTE_TOP + i * NOTE_STEP + 15;
    const cls = n.state ? ` is-${n.state}` : '';
    return html`<polyline class="rl-device__lead${cls}" points="${x},${y} 164,${ly} 174,${ly}"/><circle class="rl-device__pin${cls}" cx="${x}" cy="${y}" r="3"/>`;
  });
  const en = getLang() !== 'zh';
  return html`<a class="rl-board__cell rl-device${en ? ' rl-device--en' : ''}" href="#" data-open="system">
    <h2 class="rl-board__sec">${t('device.title')}${en ? '' : html`<small>UP6</small>`}</h2>
    <div class="rl-device__plate"><div class="rl-device__inner">
      <span class="rl-device__art" role="img" aria-label="${t('device.art')}"></span>
      <svg class="rl-device__leads" viewBox="0 0 330 248" width="330" height="248" aria-hidden="true">${leads}</svg>
      <ul class="rl-device__notes">${list.map((n, i) => html`<li class="rl-device__note${n.state ? ` is-${n.state}` : ''}" style="top:${NOTE_TOP + i * NOTE_STEP}px"><b>${n.name}</b><span class="rl-device__fig">${n.fig}${n.unit ? html`<small>${n.unit}</small>` : ''}</span>${n.more}</li>`)}</ul>
    </div></div>
  </a>`;
}
