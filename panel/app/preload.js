// Bridge between the renderer (panel UI) and the main process. Kept minimal for
// now; the fnOS login/session API lands here next.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('fnos', {
  login: (user, password) => ipcRenderer.invoke('fnos:login', { user, password }),
  session: () => ipcRenderer.invoke('fnos:session'),
  logout: () => ipcRenderer.invoke('fnos:logout'),
  // Ethernet config via fnOS's own API (admin-gated; see main.js). Wi-Fi does
  // NOT go through here — it uses t6-paneld's no-login nmcli endpoints.
  net: {
    list: () => ipcRenderer.invoke('net:list'),
    info: (ifName) => ipcRenderer.invoke('net:info', ifName),
    set: (cfg) => ipcRenderer.invoke('net:set', cfg),
  },
});
