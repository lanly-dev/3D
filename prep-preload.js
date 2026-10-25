// Preload for the Prepare Blender window: a narrow bridge to the
// Blender preparation flow in the main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('prepApi', {
  start: () => ipcRenderer.invoke('prep:start'),
  cancel: () => ipcRenderer.invoke('prep:cancel'),
  onLog: (cb) => ipcRenderer.on('prep:log', (_e, line) => cb(line)),
  onState: (cb) => ipcRenderer.on('prep:state', (_e, state) => cb(state)),
});
