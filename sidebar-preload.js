/**
 * Preload for the sidebar renderer.
 * Exposes a narrow, typed API over contextBridge (contextIsolation on).
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Assets
  list: (workspaceId) => ipcRenderer.invoke('assets:list', workspaceId),
  stats: (workspaceId) => ipcRenderer.invoke('assets:stats', workspaceId),
  track: (filePath, workspaceId) => ipcRenderer.invoke('assets:track', filePath, workspaceId),
  assign: (id, workspaceId) => ipcRenderer.invoke('assets:assign', id, workspaceId),
  scan: (folder) => ipcRenderer.invoke('assets:scan', folder),
  remove: (id) => ipcRenderer.invoke('assets:remove', id),
  reveal: (filePath) => ipcRenderer.invoke('assets:reveal', filePath),
  open: (filePath) => ipcRenderer.invoke('assets:open', filePath),
  view: (id) => ipcRenderer.invoke('assets:view', id),
  rename: (id, name) => ipcRenderer.invoke('assets:rename', id, name),
  assetMenu: (id) => ipcRenderer.invoke('assets:contextMenu', id),
  copy: (text) => ipcRenderer.invoke('sidebar:copy', text),
  convert: (id) => ipcRenderer.invoke('assets:convert', id),

  // Compounding engine
  library: () => ipcRenderer.invoke('compounding:library'),
  compound: (workspaceId, options) => ipcRenderer.invoke('compounding:compound', workspaceId, options),
  revealCompound: (filePath) => ipcRenderer.invoke('compounding:reveal', filePath),

  // Workspaces
  workspaces: () => ipcRenderer.invoke('workspaces:list'),
  createWorkspace: (payload) => ipcRenderer.invoke('workspaces:create', payload),
  updateWorkspace: (id, patch) => ipcRenderer.invoke('workspaces:update', id, patch),
  removeWorkspace: (id) => ipcRenderer.invoke('workspaces:remove', id),
  setActiveWorkspace: (id) => ipcRenderer.invoke('workspaces:setActive', id),
  pickWorkspaceFolder: (id) => ipcRenderer.invoke('workspaces:pickFolder', id),
  revealWorkspace: (id) => ipcRenderer.invoke('workspaces:reveal', id),

  // Layout
  toggle: () => ipcRenderer.invoke('sidebar:toggle'),
  setWidth: (width) => ipcRenderer.invoke('sidebar:setWidth', width),
  isVisible: () => ipcRenderer.invoke('sidebar:isVisible'),

  // Push updates from the main process
  onUpdate: (cb) => {
    ipcRenderer.on('assets:updated', (_e, payload) => cb(payload));
  },
  onVisibility: (cb) => {
    ipcRenderer.on('sidebar:visibility', (_e, visible) => cb(visible));
  },
});
