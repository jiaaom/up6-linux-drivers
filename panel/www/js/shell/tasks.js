// Copies and moves running in the background (t6-paneld's /api/fnos/tasks):
// a chip after the time in the status bar on every page — the one tappable
// thing in the bar — and the sheet it opens, one row per task with cancel.
// When the last task ends the chip leaves and a toast says what was done.

import { api } from '../core/api.js';
import { emitter } from '../core/events.js';
import { html, on } from '../core/dom.js';
import { icon } from '../core/icons.js';
import { size } from '../core/format.js';
import { langChanged, t } from '../core/i18n.js';
import { displayPath } from '../data/files.js';
import { panelSheet, toast } from './layers.js';

const POLL_MS = 1000;

let slot = null; // the status bar's task slot
let tasks = [];
let timer = 0;
const seen = new Set(); // task ids already reported as ended

/** A task ended: { task } — folder pages refresh on it. */
export const taskEnded = emitter();
export const tasksChanged = emitter();

const running = () => tasks.filter((x) => x.state === 'running');
const what = (x) => (x.count > 1 ? t('files.andMore', { name: x.name, n: x.count }) : x.name);
const opWord = (x) => t(x.op === 'move' ? 'tasks.move' : 'tasks.copy');

function ring(pct) {
  return html`<svg class="rl-ring rl-ring--sm" viewBox="0 0 24 24" style="--v:${Math.round(pct)}" aria-hidden="true"><path class="rl-ring__track" d="M12 3H21V21H3V3Z" pathLength="100"/><path class="rl-ring__bar" d="M12 3H21V21H3V3H12" pathLength="100"/></svg>`;
}

function paintChip() {
  const live = running();
  if (!live.length) { slot.innerHTML = ''; return; }
  const total = live.reduce((s, x) => s + (x.size_total || 0), 0);
  const done = live.reduce((s, x) => s + (x.size || 0), 0);
  const pct = total ? (done / total) * 100 : live[0].percent;
  const label = live.length > 1 ? t('tasks.chipMany', { n: live.length, pct: Math.round(pct) }) : `${opWord(live[0])} ${Math.round(pct)}%`;
  slot.innerHTML = String(html`<button class="rl-statusbar__task" data-tasks aria-label="${t('tasks.chipLabel', { what: what(live[0]), pct: Math.round(pct) })}">${ring(pct)}${label}</button>`);
}

function taskRow(x) {
  const left = x.time_left ? t('tasks.left', { s: x.time_left > 90 ? t('tasks.minutes', { n: Math.round(x.time_left / 60) }) : t('tasks.seconds', { n: x.time_left }) }) : '';
  const state = x.state === 'running' ? left : t(`tasks.state.${x.state}`);
  return html`<li class="rl-task"><span class="rl-toc__lead"><span class="rl-ficon" data-kind="${x.count > 1 ? 'folder' : 'other'}">${icon(x.count > 1 ? 'folder' : 'file', 'light')}</span></span>
    <div class="rl-task__main"><div class="rl-task__head"><b>${what(x)}</b><span>${Math.round(x.percent)}%</span></div>
      <span class="rl-progress rl-progress--sm${x.state === 'failed' ? ' rl-progress--error' : ''}" role="progressbar" aria-valuenow="${Math.round(x.percent)}" style="--v:${Math.round(x.percent)}"></span>
      <small>${[t(x.op === 'move' ? 'tasks.moveTo' : 'tasks.copyTo', { to: displayPath(x.to, t('files.home')) }), x.size_total ? size(x.size_total) : '', state].filter(Boolean).join(' · ')}</small></div>
    ${x.state === 'running' ? html`<button class="rl-btn rl-btn--secondary rl-btn--icon rl-btn--sm" data-cancel="${x.id}" aria-label="${t('common.cancel')}">${icon('x')}</button>` : ''}</li>`;
}

function openSheet() {
  panelSheet({
    title: t('tasks.title'),
    closeLabel: t('tasks.hide'),
    mount(body, done) {
      const draw = () => {
        if (!tasks.length) { done(); return; }
        body.innerHTML = String(html`<p class="rl-sheet__sub rl-sheet__lead">${t('tasks.sub', { n: running().length })}</p><ul class="rl-tasks">${tasks.map(taskRow)}</ul>`);
      };
      draw();
      on(body, 'click', '[data-cancel]', async (e, b) => {
        try { await api.del(`fnos/tasks/${b.dataset.cancel}`); } catch (err) { toast(t('common.failed', { why: err.message })); }
        poll();
      });
      return tasksChanged.on(draw);
    },
  });
}

async function poll() {
  clearTimeout(timer);
  try {
    tasks = await api.get('fnos/tasks');
  } catch {
    tasks = [];
  }
  for (const x of tasks) {
    if (x.state !== 'running' && !seen.has(x.id)) {
      seen.add(x.id);
      taskEnded.emit(x);
      if (!running().length) {
        if (x.state === 'done') toast(t(x.op === 'move' ? 'tasks.moved' : 'tasks.copied', { what: what(x) }), { iconName: 'check-circle' });
        else if (x.state === 'failed') toast(t('tasks.failed', { what: what(x), why: x.error ?? '' }));
      }
    }
  }
  paintChip();
  tasksChanged.emit(tasks);
  if (running().length) timer = setTimeout(poll, POLL_MS);
}

/** Start a copy or move in the background; the chip follows it. */
export async function startTask(op, paths, to, overwrite) {
  const r = await api.post('fnos/tasks', { op, paths, to, overwrite });
  await poll();
  return r.id;
}

export function mountTasks(statusbar) {
  slot = statusbar.querySelector('[data-task]');
  slot.addEventListener('click', (e) => { if (e.target.closest('[data-tasks]')) openSheet(); });
  langChanged.on(paintChip);
  poll(); // tasks still running from before a reload
}
