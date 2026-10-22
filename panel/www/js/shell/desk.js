// The desk colour that fades in above a page's sticky head as the page
// scrolls (rl-desk-in over the first 72px).
//
// Ridgeline drives it with a scroll-driven animation (animation-timeline:
// scroll()). In the kiosk (Chromium 152 on Wayland) every re-render of a
// page — every 2 s poll — left the old animation in the compositor, so each
// frame got slower the longer the panel ran (14 ms per frame after a day,
// all pages stuttering). app.css turns it off and this sets --t6-desk (0–1)
// on the screen from the page on top instead. Ridgeline hand-off › 13.

import { routeChanged } from './router.js';

const RANGE = 72; // px, Ridgeline's animation-range: 0px 72px
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
    screen.style.setProperty('--t6-desk', String(v));
  };
  const queue = () => { if (!queued) { queued = true; requestAnimationFrame(update); } };
  // scroll doesn't bubble: listen in the capture phase for every page's scroller
  screen.addEventListener('scroll', (e) => { if (e.target.classList?.contains('is-top')) queue(); }, { capture: true, passive: true });
  routeChanged.on(queue);
  queue();
}
