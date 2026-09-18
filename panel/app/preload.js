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
