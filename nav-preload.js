/**
 * Preload for the top navigation bar.
 * Exposes the navigation and zoom actions, plus the state push that
 * enables/disables the arrows and updates the zoom percentage.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('navApi', {
  back: () => ipcRenderer.send('nav:back'),
  forward: () => ipcRenderer.send('nav:forward'),
  reload: () => ipcRenderer.send('nav:reload'),
  zoomIn: () => ipcRenderer.send('nav:zoomIn'),
  zoomOut: () => ipcRenderer.send('nav:zoomOut'),
  zoomReset: () => ipcRenderer.send('nav:zoomReset'),
  onState: (cb) => {
    ipcRenderer.on('nav:state', (_e, state) => cb(state));
  },
});
