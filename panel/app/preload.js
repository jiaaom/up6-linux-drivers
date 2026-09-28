// fnOS's "Preview" micro-app (see refs/fnos-preview-app.md) renders in its own
// main-process-owned WebContentsView, not an <iframe> in this page — both
// because it's a different origin with its own cookie auth (which needs the
// privileged `session.cookies` API; page JS can't read/write httpOnly cookies)
// and because a native view layered over subpageScroll can be shown/hidden
// instantly without touching the file-browser page underneath. This bridge
// just forwards open/close to main.js; `open` takes the file path and the
// screen rect (subpageScroll's own getBoundingClientRect()) to place the view.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('previewBridge', {
  open: (path, bounds) => ipcRenderer.invoke('preview:open', { path, bounds }),
  close: () => ipcRenderer.invoke('preview:close'),
});

// Video player (bundled mpv, a separate Wayland window above this one; see
// main.js). `open` starts it on an absolute file path; `onClosed` fires when
// it exits and the panel is on top again.
contextBridge.exposeInMainWorld('playerBridge', {
  open: (path) => ipcRenderer.invoke('player:open', { path }),
  onClosed: (cb) => ipcRenderer.on('player:closed', () => cb()),
});

// Remote/keyboard keys the main process takes before the page sees them
// (BrowserBack, BrowserHome, ContextMenu, volume); www/nav.js acts on them.
contextBridge.exposeInMainWorld('navBridge', {
  onKey: (cb) => ipcRenderer.on('nav:key', (event, key) => cb(key)),
});

// Colour theme (see www/theme.js). The renderer owns the choice; main needs it
// for the two surfaces the renderer can't paint: the BrowserWindow's own
// background (visible on a scroll overshoot / before first paint) and the
// native Preview view, which is a separate web contents and takes the theme as
// a query parameter of fnOS's trim-preview app.
contextBridge.exposeInMainWorld('themeBridge', {
  set: (theme, bg) => ipcRenderer.invoke('theme:set', { theme, bg }),
});
