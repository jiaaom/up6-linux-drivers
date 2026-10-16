// Boot: theme and language from their echoes (index.html already painted
// with them), then the shell, then the live state from t6-paneld.

import { langFromBackend } from './core/i18n.js';
import { panel, startPanel } from './core/panel.js';
import { applyTheme, getTheme, themeFromBackend } from './core/theme.js';
import { startShell } from './shell/shell.js';

// An appliance: no context menu, no long-press callout, no dragging images or text.
for (const type of ['contextmenu', 'dragstart']) addEventListener(type, (e) => e.preventDefault());

applyTheme(getTheme()); // tells Electron the desk colour

panel.changed.on((d) => {
  themeFromBackend(d.theme);
  langFromBackend(d.language);
});

startShell(document.getElementById('app'));
startPanel();
