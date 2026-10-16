// Edge swipe back: a drag from the left edge of a page below a tab moves the
// page with the finger. Released past 30% of the width (or flicked), it
// finishes going back; otherwise it settles where it was.

import { capture } from '../core/dom.js';
import { keyboardEl } from './keyboard.js';
import { topLayer } from './layers.js';
import { depth, finishSwipeBack, isBusy, topEntry, underEntry } from './router.js';

const EDGE_PX = 24;
const START_PX = 8;
const COMMIT = 0.3;
const FLICK_PX_PER_MS = 0.5;
const DURATION_MS = 224; // duration-page × 0.8, as rl-page--exit
const SHADOW = '-12px 0 24px rgba(28, 33, 26, .12)';

let drag = null;

function place(p) {
  drag.top.el.style.transform = `translateX(${p * 100}%)`;
  drag.under.el.style.transform = `translateX(${-20 + 20 * p}%)`;
  drag.under.el.style.opacity = String(0.7 + 0.3 * p);
}

function clear(entry) {
  entry.el.style.transform = '';
  entry.el.style.opacity = '';
  entry.el.style.boxShadow = '';
}

function release(e) {
  const d = drag;
  drag = null;
  if (!d?.started) return;
  const width = d.top.el.clientWidth;
  const p = Math.max(0, e.clientX - d.x0) / width;
  const speed = (e.clientX - d.x0) / Math.max(1, e.timeStamp - d.t0);
  const commit = p > COMMIT || speed > FLICK_PX_PER_MS;
  const end = commit ? 1 : 0;
  const opts = {
    duration: DURATION_MS * Math.max(0.3, Math.abs(end - p)),
    easing: commit ? 'cubic-bezier(.4, 0, 1, 1)' : 'cubic-bezier(.2, .8, .2, 1)',
    fill: 'forwards',
  };
  d.top.el.animate([{ transform: `translateX(${end * 100}%)` }], opts);
  const anim = d.under.el.animate([{ transform: `translateX(${-20 + 20 * end}%)`, opacity: 0.7 + 0.3 * end }], opts);
  anim.onfinish = () => {
    for (const entry of [d.top, d.under]) {
      entry.el.getAnimations().forEach((a) => a.cancel());
      clear(entry);
    }
    if (commit) finishSwipeBack();
    else d.under.el.hidden = true;
  };
}

export function mountSwipe(screen) {
  screen.addEventListener('pointerdown', (e) => {
    if (e.clientX > EDGE_PX || depth() < 2 || isBusy() || topLayer() || keyboardEl()) return;
    drag = { x0: e.clientX, y0: e.clientY, t0: e.timeStamp, id: e.pointerId, top: topEntry(), under: underEntry(), started: false };
  });
  screen.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x0;
    if (!drag.started) {
      if (Math.abs(e.clientY - drag.y0) > dx) { drag = null; return; } // a scroll, not a swipe
      if (dx < START_PX) return;
      drag.started = true;
      capture(screen, e.pointerId);
      drag.under.el.hidden = false;
      drag.top.el.style.boxShadow = SHADOW;
    }
    place(Math.max(0, dx) / drag.top.el.clientWidth);
  });
  screen.addEventListener('pointerup', release);
  screen.addEventListener('pointercancel', release);
}
