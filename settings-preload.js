// Preload for the Settings tab: read the rigging engine's state and setup
// log, start an install, open the engine folder.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settingsApi', {
  getState: () => ipcRenderer.invoke('settings:state'),
  install: () => ipcRenderer.invoke('settings:install'),
  openFolder: () => ipcRenderer.invoke('settings:open-root'),
  onState: (cb) => ipcRenderer.on('settings:state', (_e, state) => cb(state)),
});
