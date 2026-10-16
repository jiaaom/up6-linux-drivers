// Cache-first data for pages (Ridgeline States › Loading and refreshing).
//
//   cached data      → shown at once; a refresh runs behind it
//   nothing cached   → skeleton, but only after 300 ms, so fast loads never flash
//   refresh fails    → keep what is on screen and say so
//   fails, no cache  → the error state with 重试
//
// Never clear data that is on screen because a refresh is running.

import { painter } from './dom.js';
import { emitter } from './events.js';
import { load, save } from './storage.js';

const SKELETON_DELAY_MS = 300;

/**
 * A cached backend answer. `fetcher()` returns a promise of the data.
 * status: 'idle' | 'loading' (nothing cached) | 'refreshing' | 'failed'.
 */
export function resource(key, fetcher, { persist = true } = {}) {
  const cached = persist ? load(`cache.${key}`) : null;
  const res = {
    data: cached?.data ?? null,
    ts: cached?.ts ?? 0,
    status: 'idle',
    error: null,
    changed: emitter(),
    async refresh() {
      if (res.status === 'loading' || res.status === 'refreshing') return;
      res.status = res.data == null ? 'loading' : 'refreshing';
      res.changed.emit(res);
      try {
        res.data = await fetcher();
        res.ts = Date.now();
        res.status = 'idle';
        res.error = null;
        if (persist) save(`cache.${key}`, { data: res.data, ts: res.ts });
      } catch (e) {
        res.status = 'failed';
        res.error = e;
      }
      res.changed.emit(res);
    },
    /** Drop the data and its cache (it belonged to someone who signed out). */
    reset() {
      res.data = null;
      res.ts = 0;
      res.status = 'idle';
      res.error = null;
      if (persist) save(`cache.${key}`, null);
      res.changed.emit(res);
    },
  };
  return res;
}

/**
 * Keep `container` showing `res`: render(data, res) when there is data,
 * skeleton() while the first load is slow, error(retry) when it failed with
 * nothing to show. Returns a function that stops watching.
 */
export function bindResource(container, res, { render, skeleton, error }) {
  const put = painter(container);
  let timer = 0;
  let shown = '';
  const paint = () => {
    clearTimeout(timer);
    if (res.data != null) {
      put(render(res.data, res));
      shown = 'data';
    } else if (res.status === 'failed') {
      put(error(() => res.refresh()));
      shown = 'error';
    } else if (shown !== 'skeleton') {
      put('');
      shown = '';
      timer = setTimeout(() => {
        if (res.data == null && res.status === 'loading') {
          put(skeleton());
          shown = 'skeleton';
        }
      }, SKELETON_DELAY_MS);
    }
  };
  const off = res.changed.on(paint);
  paint();
  return {
    /** Paint again (after a language change, or a change made here). */
    repaint: paint,
    stop() { off(); clearTimeout(timer); },
  };
}

/**
 * Refresh `res` every `ms` while a page is on screen: call start() in the
 * page's show() and stop() in hide() (a page is hidden before it is destroyed).
 * `hold()` skips refreshes for a moment after the user changed something,
 * so a refresh that left earlier doesn't undo what they just did.
 */
export function poller(res, ms = 3000) {
  let timer = 0;
  let holdUntil = 0;
  const tick = () => { if (Date.now() > holdUntil) res.refresh(); };
  return {
    /** Refresh now and every `ms`; a second start() while running does nothing. */
    start() { if (timer) return; res.refresh(); timer = setInterval(tick, ms); },
    stop() { clearInterval(timer); timer = 0; },
    hold(forMs = 1500) { holdUntil = Date.now() + forMs; },
  };
}
