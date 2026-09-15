// Bridge between the renderer (panel UI) and the main process. Kept minimal for
// now; the fnOS login/session API lands here next.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fnos', {
  login: (user, password) => ipcRenderer.invoke('fnos:login', { user, password }),
  session: () => ipcRenderer.invoke('fnos:session'),
  logout: () => ipcRenderer.invoke('fnos:logout'),
});
