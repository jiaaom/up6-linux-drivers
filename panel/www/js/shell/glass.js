// 长虹琉璃: the screen's backdrop seen through fluted glass, drawn by
// Ridgeline's one WebGL2 shader (ridgeline/<v>/Backdrop/liuli-glass.js) on a
// canvas behind everything (Backdrop README › 长虹琉璃).
//
// The glass follows the theme by itself. What the panel decides is when it
// stands still (on one frame; the glass stays):
//   - 设置 › 外观 › 动态背景 off;
//   - in the kiosk only (the NAS's own screen and power; a browser showing the
//     panel elsewhere is not on that screen):
//     - the screen dimmed or off (/api/panel `display`);
//     - on battery, with 用电池时暂停 on: `battery.ac` is false (null, no
//       mains reading at all, is not battery);
//   - any layer up: the control center, a sheet or dialog with its scrim, the
//     file viewer;
//   - mpv playing (its own window covers the panel; see holdGlass).
// A hidden page stops it too (liuli-glass.js itself). Without WebGL2 the
// screen keeps the CSS sky.

import { panel } from '../core/panel.js';
import { layersChanged, topLayer } from './layers.js';

// the kiosk's preload (panel/app/preload.js) gives it the player bridge
const KIOSK = !!window.playerBridge;

let glass = null;
const held = new Set(); // reasons from elsewhere: 'player'

function still() {
  const d = panel.data;
  const look = d?.backdrop;
  return look?.motion === false
    || (KIOSK && (d?.display?.on === false || d?.display?.dimmed === true))
    || (KIOSK && look?.battery_pause !== false && d?.battery?.ac === false)
    || topLayer() !== null
    || held.size > 0;
}

let paused = false;
function apply() {
  if (!glass) return;
  const p = still();
  if (p === paused) return;
  paused = p;
  if (p) glass.pause(); else glass.resume();
}

/** Keep the glass still for `reason` (on) or let it go (off). */
export function holdGlass(reason, on) {
  if (on) held.add(reason); else held.delete(reason);
  apply();
}

export function mountGlass(screen) {
  const canvas = screen.querySelector(':scope > .rl-glass-backdrop');
  try {
    glass = window.RidgelineGlass?.mount(canvas) ?? null;
  } catch (e) {
    console.warn('glass:', e); // a shader that won't compile: the CSS sky
    glass = null;
  }
  if (!glass) { canvas.remove(); return; }
  screen.classList.add('has-glass');
  panel.changed.on(apply);
  layersChanged.on(apply);
  window.playerBridge?.onClosed?.(() => holdGlass('player', false));
  apply();
}
