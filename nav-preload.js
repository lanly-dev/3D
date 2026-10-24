/**
 * Preload for the top navigation bar.
 * Exposes the three navigation actions and the state push that enables
 * or disables the back/forward arrows.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('navApi', {
  back: () => ipcRenderer.send('nav:back'),
  forward: () => ipcRenderer.send('nav:forward'),
  reload: () => ipcRenderer.send('nav:reload'),
  onState: (cb) => {
    ipcRenderer.on('nav:state', (_e, state) => cb(state));
  },
});
