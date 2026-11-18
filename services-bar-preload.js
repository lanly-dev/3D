// Preload for the services sub-tab strip: a narrow bridge so the strip can
// ask main to switch services and hear which one is active.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('servicesApi', {
  setService: (name) => ipcRenderer.send('services:set', name),
  onState: (cb) => ipcRenderer.on('services:state', (_e, state) => cb(state)),
});
