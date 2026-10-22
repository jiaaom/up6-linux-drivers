// The app shell: one screen that holds, in order,
//   status-bar mask · status bar · pages (one scroller each) · dock (tab bar)
//   · toast region · pull band for the control center · layers (sheets,
//   dialogs, control center) · keyboard
// Pages come and go; everything else stays for the life of the app.

import { html } from '../core/dom.js';
import { userForgotten, watchSession } from '../data/session.js';
import { mountControlCenter } from './control-center.js';
import { mountDesk } from './desk.js';
import { mountKeyboard } from './keyboard.js';
import { mountLayers } from './layers.js';
import { mountOffline } from './offline.js';
import { mountRemote } from './remote.js';
import { resetTab, startRouter } from './router.js';
import { mountStatusbar } from './statusbar.js';
import { mountSwipe } from './swipe.js';
import { mountTabbar } from './tabbar.js';
import { mountTasks } from './tasks.js';

export function startShell(screen, firstTab = 'overview') {
  screen.innerHTML = String(html`<div class="rl-statusmask" aria-hidden="true"></div>
    <div class="rl-statusbar" role="status"></div>
    <div class="rl-dock"></div>
    <div class="rl-toast-region" aria-live="polite"></div>`);
  const dock = screen.querySelector('.rl-dock');
  mountStatusbar(screen.querySelector('.rl-statusbar'));
  mountTasks(screen.querySelector('.rl-statusbar'));
  mountLayers(screen, screen.querySelector('.rl-toast-region'));
  mountKeyboard(screen);
  mountOffline(screen);
  mountRemote(dock);
  mountSwipe(screen);
  mountControlCenter(screen);
  const ready = startRouter(screen, dock, firstTab);
  mountDesk(screen);
  // signed out: the folders that were open close (their names belong to that person)
  watchSession();
  userForgotten.on(() => resetTab('files'));
  mountTabbar(dock);
  return ready;
}
