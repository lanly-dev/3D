// Preload for the MeshCoder setup window: a narrow bridge to the setup
// orchestration in the main process. The Hugging Face token crosses once,
// as the argument of start(); it is never stored by the app.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('setupApi', {
  start: (token) => ipcRenderer.invoke('setup:start', token),
  cancel: () => ipcRenderer.invoke('setup:cancel'),
  openModelPage: () => ipcRenderer.invoke('setup:openModelPage'),
  onLog: (cb) => ipcRenderer.on('setup:log', (_e, line) => cb(line)),
  onState: (cb) => ipcRenderer.on('setup:state', (_e, state) => cb(state)),
});
