// Colour theme: light (晨纸, the default) or dark (夜案), chosen as light,
// dark or night (跟随夜间: dark inside a window of the day, t6-paneld
// night.rs). Under 跟随夜间, 夜案 in the control center can hold the other
// theme until the window's next change.
//
// settings.json (PUT api/settings/theme) is the source of truth; /api/panel
// reports the theme in effect (`theme`), the choice (`theme_mode`) and the
// window (`theme_night`). Storage holds an echo of the theme in effect that
// index.html reads before the first paint. Electron is told the desk colour
// too, for the two surfaces the page can't paint: the window behind it
// (scroll overshoot, first frame) and the Preview view.

import { api } from './api.js';
import { panel, refreshPanel } from './panel.js';
import { save } from './storage.js';

const THEMES = ['light', 'dark'];
const SETTLE_MS = 4000; // a poll that left before our PUT landed may still report the old theme
const root = document.documentElement;
let chosenAt = 0;

/** The theme in effect: light or dark. */
export function getTheme() {
  return root.dataset.theme === 'dark' ? 'dark' : 'light';
}

/** The choice in 设置 › 主题: light, dark or night. */
export function getMode() {
  return panel.data?.theme_mode ?? getTheme();
}

/** Under 跟随夜间: { from, to, dark, next_change, hold: { theme, until } | null }. */
export function nightInfo() {
  return panel.data?.theme_night ?? null;
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

/** Take a theme PUT's answer (the same fields as /api/panel) at once. */
function adopt(r) {
  chosenAt = Date.now();
  if (panel.data) Object.assign(panel.data, { theme: r.theme, theme_mode: r.theme_mode, theme_night: r.theme_night });
  applyTheme(r.theme);
  if (panel.data) panel.changed.emit(panel.data);
  refreshPanel(); // and not undone by a poll that left before the change
  return r;
}

/** Choose light, dark or night and store it in settings.json. */
export async function setTheme(mode) {
  chosenAt = Date.now();
  if (THEMES.includes(mode)) applyTheme(mode); // night waits for the backend's answer
  return adopt(await api.put('settings/theme', { theme: mode }));
}

/** 设置 › 夜间时段: the window ("HH:MM"). */
export async function setNightWindow(from, to) {
  return adopt(await api.put('settings/night', { from, to }));
}

/** Hold the other theme until the window's next change, or go back to the window. */
export async function setThemeHold(on) {
  return adopt(await api.put('settings/theme-hold', { on }));
}

/** 夜案 in the control center: under 跟随夜间 hold or release, else switch. */
export function toggleDark() {
  if (getMode() === 'night') return setThemeHold(!nightInfo()?.hold);
  return setTheme(getTheme() === 'dark' ? 'light' : 'dark');
}
