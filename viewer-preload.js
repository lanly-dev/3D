/**
 * Preload for the in-app 3D viewer window.
 * The viewer page must not read the disk directly; the main process hands
 * it the file bytes for the model it was opened with.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('viewerApi', {
  readFile: (filePath) => ipcRenderer.invoke('viewer:readFile', filePath),
  readModule: (filePath) => ipcRenderer.invoke('viewer:readModule', filePath),
});
