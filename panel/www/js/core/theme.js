// Colour theme: light (晨纸, the default) or dark (夜案).
//
// settings.json (PUT api/settings/theme) is the source of truth; storage
// holds an echo that index.html reads before the first paint. Electron is
// told the desk colour too, for the two surfaces the page can't paint: the
// window behind it (scroll overshoot, first frame) and the Preview view.

import { api } from './api.js';
import { save } from './storage.js';

const THEMES = ['light', 'dark'];
const SETTLE_MS = 4000; // a poll that left before our PUT landed may still report the old theme
const root = document.documentElement;
let chosenAt = 0;

export function getTheme() {
  return root.dataset.theme === 'dark' ? 'dark' : 'light';
}

/** Apply a theme reported by the backend or chosen here (no request). */
export function applyTheme(theme) {
  if (!THEMES.includes(theme)) theme = 'light';
  root.dataset.theme = theme;
  save('theme', theme);
  const desk = getComputedStyle(root).getPropertyValue('--rl-desk').trim();
  window.themeBridge?.set(theme, desk);
}

/** The theme /api/panel reports: follow it unless the user just chose one here. */
export function themeFromBackend(theme) {
  if (theme && theme !== getTheme() && Date.now() - chosenAt > SETTLE_MS) applyTheme(theme);
}

/** Choose a theme: apply it now and store it in settings.json. */
export function setTheme(theme) {
  chosenAt = Date.now();
  applyTheme(theme);
  return api.put('settings/theme', { theme: getTheme() });
}
