// Preload for the assistant sub-tab strip: a narrow bridge so the
// strip can ask main to switch assistants and hear which is active.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('assistantApi', {
  setAssistant: (name) => ipcRenderer.send('assistant:set', name),
  onState: (cb) => ipcRenderer.on('assistant:state', (_e, state) => cb(state)),
});
