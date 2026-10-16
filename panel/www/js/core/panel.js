// The panel's live state (/api/panel) and whether the backend answers.
//
// /api/panel is polled every 2 s. The last answer is kept in storage and
// shown at once on the next start. Two polls in a row without an answer
// mean the backend is down: the shell swaps the whole app for the offline
// page and polls every 5 s until it answers again.

import { api, noAnswer } from './api.js';
import { emitter } from './events.js';
import { load, save } from './storage.js';

const POLL_MS = 2000;
const RETRY_MS = 5000;
const MISSES_FOR_OFFLINE = 2;

export const panel = {
  /** Last /api/panel payload, or null before the first answer. */
  data: load('panel'),
  changed: emitter(),
};

export const backend = {
  online: true,
  /** Polls tried since the backend went away. */
  tries: 0,
  changed: emitter(),
};

let misses = 0;
let timer = 0;
let inFlight = false;
let again = false;

async function poll() {
  clearTimeout(timer);
  if (inFlight) { again = true; return; }
  inFlight = true;
  try {
    const d = await api.get('panel');
    misses = 0;
    panel.data = d;
    save('panel', d);
    if (!backend.online) {
      backend.online = true;
      backend.tries = 0;
      backend.changed.emit();
    }
    panel.changed.emit(d);
  } catch (e) {
    if (e.unreachable) {
      misses++;
      if (!backend.online) {
        backend.tries++;
        backend.changed.emit();
      } else if (misses >= MISSES_FOR_OFFLINE) {
        backend.online = false;
        backend.tries = misses;
        backend.changed.emit();
      }
    }
  }
  inFlight = false;
  if (again) { again = false; poll(); return; }
  clearTimeout(timer);
  timer = setTimeout(poll, backend.online ? POLL_MS : RETRY_MS);
}

/** Poll now (after a change the user just made, or a request that got no answer). */
export function refreshPanel() {
  poll();
}

export function startPanel() {
  noAnswer.on(() => { if (backend.online && !inFlight) { clearTimeout(timer); timer = setTimeout(poll, 300); } });
  poll();
}
