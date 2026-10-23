// The desk strips that fade in above a page's sticky head as the page scrolls:
// Ridgeline gives them `opacity: var(--rl-desk-in)` and leaves setting it to
// the app (Navigation README › The desk strips): 0 at the top, 1 from 72px of
// scroll, in 1/24 steps, from the page on top.
//
// They used to be scroll-driven animations, which the kiosk's compositor kept
// after every re-render of a page (every 2 s poll), so each frame got slower
// the longer the panel ran. Ridgeline hand-off › 13; fixed in 1.13.1.

import { routeChanged } from './router.js';

const RANGE = 72; // px
const STEPS = 24; // write only when the value moves a step (3px)

export function mountDesk(screen) {
  let shown = -1;
  let queued = false;
  const update = () => {
    queued = false;
    const top = screen.querySelector(':scope > .rl-scroller.is-top');
    const v = Math.round(Math.min(1, Math.max(0, (top?.scrollTop ?? 0) / RANGE)) * STEPS) / STEPS;
    if (v === shown) return;
    shown = v;
    screen.style.setProperty('--rl-desk-in', String(v));
  };
  const queue = () => { if (!queued) { queued = true; requestAnimationFrame(update); } };
  // scroll doesn't bubble: listen in the capture phase for every page's scroller
  screen.addEventListener('scroll', (e) => { if (e.target.classList?.contains('is-top')) queue(); }, { capture: true, passive: true });
  routeChanged.on(queue);
  queue();
}
