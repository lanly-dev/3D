/**
 * Hunyuan3D Desktop — a personal desktop wrapper around the Hunyuan3D web app.
 *
 * What it does:
 *  - Loads https://3d.hunyuan.tencent.com/ in a real Chromium shell.
 *  - Keeps the login session alive across restarts via a persistent
 *    session partition ('persist:hunyuan3d'), so cookies/localStorage
 *    behave like a normal Chrome profile.
 *  - Routes login popups (QQ/WeChat/Tencent domains) into in-app windows
 *    that share the same session; anything else opens in the system browser.
 *  - Auto-saves downloaded models (GLB/OBJ) into the Downloads folder
 *    and shows a notification when done.
 *  - Optional MeshCoder step (Tools menu): converts the last downloaded
 *    mesh into part-segmented, editable Blender Python code using a local
 *    MeshCoder install on your GPU. See meshcoder.js + the README.
 *  - Menu option "Translate site to English": restarts the app with an
 *    en-US locale + Accept-Language, and machine-translates the site text
 *    in place via Google Translate's widget (the site ships Chinese-first).
 *
 * What it does NOT do:
 *  - No automation of the web app, no page scripting, no generation-driving.
 *    You click things yourself, same as in a browser — just without
 *    having to switch windows or re-log-in every time.
 */
const {
  app,
  BrowserWindow,
  WebContentsView,
  session,
  Menu,
  shell,
  Notification,
  dialog,
  ipcMain,
} = require('electron');
const path = require('path');
const fs = require('fs');
const meshcoder = require('./meshcoder');
const assets = require('./assets');
const workspaces = require('./workspaces');
const compounding = require('./compounding');

const HOME_URL = 'https://3d.hunyuan.tencent.com/';
const APP_TITLE = 'Hunyuan3D';
// Chrome UA (the raw Electron UA makes many sites serve broken pages).
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';

// Domains that belong to the login/app flow and should stay in-app.
const IN_APP_HOSTS = ['tencent.com', 'qq.com', 'weixin.qq.com', 'wechat.com', 'gtimg.com', 'qpic.cn'];

// Sidebar layout
const SIDEBAR_MIN_WIDTH = 200;
const SIDEBAR_MAX_WIDTH = 520;
const SIDEBAR_DEFAULT_WIDTH = 288;
const SIDEBAR_COLLAPSED_WIDTH = 36;

let lastDownloadPath = null;
let converting = false;

/** Main window + its two views (sidebar + site). */
let mainWindow = null;
let sidebarView = null;
let siteView = null;
let sidebarVisible = true;
let sidebarWidth = SIDEBAR_DEFAULT_WIDTH;

// --- App settings (persisted in userData/settings.json) ---
function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}
function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch {
    return {};
  }
}
function saveSettings(s) {
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
  } catch {
    /* best effort */
  }
}
const settings = loadSettings();
// If translation is on, start Chromium with an English UI locale.
if (settings.translateToEnglish) {
  app.commandLine.appendSwitch('lang', 'en-US');
}

function toggleTranslate() {
  const s = loadSettings();
  s.translateToEnglish = !s.translateToEnglish;
  saveSettings(s);
  app.relaunch();
  app.exit(0);
}

// Page snippet injected when translation is on: sets Google Translate's
// zh-CN -> en cookie and loads its (free) widget, which then translates the
// page text in place and keeps translating new UI as the SPA renders.
// The widget's own banner/gadget are hidden — translation just happens.
const TRANSLATE_SNIPPET = `
(function () {
  if (document.getElementById('hy3d-gt-script')) return;
  try { document.cookie = 'googtrans=/zh-CN/en; path=/'; } catch (e) {}
  window.__hy3dTranslateInit = function () {
    new google.translate.TranslateElement(
      { pageLanguage: 'zh-CN', includedLanguages: 'en', autoDisplay: false },
      'hy3d-gt-el'
    );
  };
  var holder = document.createElement('div');
  holder.id = 'hy3d-gt-el';
  holder.style.display = 'none';
  document.documentElement.appendChild(holder);
  var style = document.createElement('style');
  style.textContent =
    '.goog-te-banner-frame,.goog-te-balloon-frame,#goog-gt-tt,' +
    'iframe.skiptranslate,[class*="VIpgJd-ZVi9od-ORHb"]' +
    '{display:none!important;visibility:hidden!important;height:0!important}' +
    'body{top:0!important}';
  document.documentElement.appendChild(style);
  // The widget keeps re-inserting its banner under changing class names
  // and with inline styles that beat a plain stylesheet — so sweep for
  // every known banner variant and stamp inline !important hiding on
  // sight, and keep the page from being pushed down. The sweeper runs on
  // DOM mutations AND on a timer, because the banner can also appear
  // long after load (first translation, panel switches).
  function hideTranslateChrome() {
    document
      .querySelectorAll(
        '.goog-te-banner-frame,.goog-te-balloon-frame,iframe.skiptranslate,' +
          '[class*="VIpgJd-ZVi9od-ORHb"]'
      )
      .forEach(function (el) {
        el.style.setProperty('display', 'none', 'important');
        el.style.setProperty('visibility', 'hidden', 'important');
        el.style.setProperty('height', '0', 'important');
      });
    if (document.body && document.body.style.top && document.body.style.top !== '0px') {
      document.body.style.setProperty('top', '0px', 'important');
    }
  }
  new MutationObserver(hideTranslateChrome).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  setInterval(hideTranslateChrome, 1000);
  var s = document.createElement('script');
  s.id = 'hy3d-gt-script';
  s.src = 'https://translate.google.com/translate_a/element.js?cb=__hy3dTranslateInit';
  document.documentElement.appendChild(s);
  // Belt and suspenders: if the cookie alone doesn't start translation,
  // pick English in the widget's own language combo once it appears.
  var tries = 0;
  var iv = setInterval(function () {
    var combo = document.querySelector('.goog-te-combo');
    if (combo) {
      if (combo.value !== 'en') {
        combo.value = 'en';
        combo.dispatchEvent(new Event('change'));
      }
      clearInterval(iv);
    }
    if (++tries > 20) clearInterval(iv);
  }, 500);
})();
`;

function injectTranslator(contents) {
  contents.executeJavaScript(TRANSLATE_SNIPPET).catch(() => {});
}

function isInApp(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return IN_APP_HOSTS.some((d) => host === d || host.endsWith('.' + d));
  } catch {
    return false;
  }
}

function applyWindowOpenHandler(contents) {
  contents.setWindowOpenHandler(({ url }) => {
    if (isInApp(url)) {
      // A WebContentsView cannot open a child window directly — create it.
      if (contents.getType() === 'window') {
        return { action: 'allow', overrideBrowserWindowOptions: childWindowOptions() };
      }
      const child = new BrowserWindow(childWindowOptions());
      child.webContents.setUserAgent(CHROME_UA);
      child.loadURL(url);
      applyWindowOpenHandler(child.webContents);
      return { action: 'deny' };
    }
    shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
}

function childWindowOptions() {
  return {
    width: 1000,
    height: 760,
    title: APP_TITLE,
    webPreferences: {
      session: session.fromPartition('persist:hunyuan3d'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  };
}

/** Sidebar layout preferences (persisted next to the asset store). */
function layoutPath() {
  return path.join(app.getPath('userData'), 'layout.json');
}

function loadLayout() {
  try {
    const cfg = JSON.parse(fs.readFileSync(layoutPath(), 'utf8'));
    if (Number.isFinite(cfg.sidebarWidth)) {
      sidebarWidth = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, cfg.sidebarWidth));
    }
    if (typeof cfg.sidebarVisible === 'boolean') sidebarVisible = cfg.sidebarVisible;
  } catch {
    /* first run — keep defaults */
  }
}

function saveLayout() {
  try {
    fs.mkdirSync(path.dirname(layoutPath()), { recursive: true });
    fs.writeFileSync(
      layoutPath(),
      JSON.stringify({ sidebarWidth: Math.round(sidebarWidth), sidebarVisible }, null, 2)
    );
  } catch {
    /* non-fatal */
  }
}

/**
 * Layout: the main window hosts two WebContentsViews —
 *   - sidebarView: the local asset dashboard (file:// page)
 *   - siteView:    the Hunyuan3D web app
 * The sidebar can be collapsed/expanded and resized by dragging its edge.
 */
function createMainWindow() {
  const ses = session.fromPartition('persist:hunyuan3d');
  ses.setUserAgent(CHROME_UA);

  // Downloads: auto-save into the active workspace folder (or Downloads)
  // with a de-duplicated filename.
  ses.on('will-download', (_event, item) => {
    const ws = workspaces.active();
    const downloads = ws && ws.folder ? ws.folder : app.getPath('downloads');
    try {
      fs.mkdirSync(downloads, { recursive: true });
    } catch {
      /* fall through — item.setSavePath will surface the real error */
    }
    let target = path.join(downloads, item.getFilename() || 'hunyuan3d-model.glb');
    const ext = path.extname(target);
    const base = path.basename(target, ext);
    let n = 1;
    while (fs.existsSync(target)) {
      target = path.join(downloads, `${base} (${n})${ext}`);
      n += 1;
    }
    item.setSavePath(target);
    item.once('done', (_e, state) => {
      if (state === 'completed') {
        lastDownloadPath = target;
        // Register the download as a managed asset in its workspace.
        const record = assets.track(target, 'model', ws ? ws.id : null);
        notifySidebar();
        new Notification({ title: 'Hunyuan3D', body: `Saved: ${path.basename(target)}` }).show();
        void record;
      }
    });
  });

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    title: APP_TITLE,
    autoHideMenuBar: false,
    webPreferences: {
      session: ses,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow = win;

  // --- sidebar view -------------------------------------------------
  sidebarView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'sidebar-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  sidebarView.webContents.loadFile(path.join(__dirname, 'sidebar.html'));

  // --- site view ----------------------------------------------------
  siteView = new WebContentsView({
    webPreferences: {
      session: ses,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  siteView.webContents.setUserAgent(CHROME_UA);
  siteView.webContents.loadURL(HOME_URL);
  applyWindowOpenHandler(siteView.webContents);
  if (settings.translateToEnglish) {
    const siteContents = siteView.webContents;
    siteContents.on('dom-ready', () => injectTranslator(siteContents));
  }

  win.contentView.addChildView(sidebarView);
  win.contentView.addChildView(siteView);

  layoutViews();
  win.on('resize', layoutViews);
  win.on('maximize', layoutViews);
  win.on('unmaximize', layoutViews);

  win.on('closed', () => {
    mainWindow = null;
    sidebarView = null;
    siteView = null;
  });

  buildMenu();
  return win;
}

/** Position the sidebar and the site view inside the window. */
function layoutViews() {
  if (!mainWindow || !sidebarView || !siteView) return;
  const { width: w, height: h } = mainWindow.getContentBounds();
  const sidebarW = sidebarVisible ? Math.round(sidebarWidth) : SIDEBAR_COLLAPSED_WIDTH;
  sidebarView.setBounds({ x: 0, y: 0, width: sidebarW, height: h });
  siteView.setBounds({ x: sidebarW, y: 0, width: Math.max(0, w - sidebarW), height: h });
}

function setSidebarVisible(visible) {
  sidebarVisible = Boolean(visible);
  layoutViews();
  if (sidebarView && !sidebarView.webContents.isDestroyed()) {
    sidebarView.webContents.send('sidebar:visibility', sidebarVisible);
  }
  saveLayout();
  return sidebarVisible;
}

function toggleSidebar() {
  return setSidebarVisible(!sidebarVisible);
}

function setSidebarWidth(width) {
  const n = Number(width);
  if (!Number.isFinite(n)) return sidebarWidth;
  sidebarWidth = Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, n));
  layoutViews();
  saveLayout();
  return sidebarWidth;
}

function notifySidebar() {
  if (sidebarView && !sidebarView.webContents.isDestroyed()) {
    sidebarView.webContents.send('assets:updated');
  }
}

function focusedWindow() {
  return BrowserWindow.getFocusedWindow() || mainWindow;
}

/** The web app's contents (for navigation menu items). */
function focusedWebContents() {
  const w = BrowserWindow.getFocusedWindow();
  // A login popup has focus — act on that window instead of the site view.
  if (w && w !== mainWindow && w.webContents && !w.webContents.isDestroyed()) {
    return w.webContents;
  }
  if (siteView && !siteView.webContents.isDestroyed()) return siteView.webContents;
  return w ? w.webContents : null;
}

async function convertLastDownload() {
  const win = focusedWindow();
  if (converting) return;
  if (!lastDownloadPath) {
    await dialog.showMessageBox(win, {
      type: 'info',
      message: 'Nothing to convert yet',
      detail: 'Generate and download a model first — MeshCoder converts the most recent download.',
    });
    return;
  }
  if (!meshcoder.isConfigured()) {
    await dialog.showMessageBox(win, {
      type: 'warning',
      message: 'MeshCoder is not configured',
      detail:
        'Point the app at your local MeshCoder install via Tools → Open MeshCoder config ' +
        '(set "home" and "python"), or the MESHCODER_HOME / MESHCODER_PYTHON env vars. ' +
        'See the MeshCoder section of the README for the full setup.',
    });
    return;
  }
  converting = true;
  new Notification({
    title: 'Hunyuan3D',
    body: `MeshCoder: converting ${path.basename(lastDownloadPath)}…`,
  }).show();
  try {
    // Write the generated script into the mesh's workspace folder.
    const meshAsset = assets.findByPath(lastDownloadPath);
    const owner = meshAsset && meshAsset.workspaceId ? workspaces.find(meshAsset.workspaceId) : null;
    const outDir = owner && owner.folder ? owner.folder : path.dirname(lastDownloadPath);
    const codePath = await meshcoder.convertToCode(lastDownloadPath, outDir);
    // Register the generated script as an asset linked to its source mesh.
    const mesh = assets.track(lastDownloadPath, 'model', owner ? owner.id : null);
    assets.linkCode(codePath, mesh.id);
    // Feed the new parts into the compounding library.
    compounding.harvest(codePath, path.basename(lastDownloadPath));
    notifySidebar();
    new Notification({ title: 'Hunyuan3D', body: `Blender code saved: ${path.basename(codePath)}` }).show();
    shell.showItemInFolder(codePath);
  } catch (err) {
    await dialog.showMessageBox(win, {
      type: 'error',
      message: 'MeshCoder conversion failed',
      detail: String(err && err.message ? err.message : err),
    });
  } finally {
    converting = false;
  }
}

/** Ask for a workspace name, then create it (folder can be set later). */
async function createWorkspaceDialog() {
  const win = focusedWindow();
  const res = await dialog.showMessageBox(win, {
    type: 'info',
    message: 'New workspace',
    detail:
      'A workspace groups your models and owns a folder. New downloads and ' +
      'generated Blender code are saved into the active workspace folder.',
    buttons: ['Create', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
  });
  if (res.response !== 0) return null;
  const ws = workspaces.create({ name: 'New workspace', folder: '' });
  notifySidebar();
  return ws;
}

/** Open the folder picker for a workspace and store the chosen path. */
async function pickWorkspaceFolder(id) {
  const win = focusedWindow();
  const ws = workspaces.find(id);
  if (!ws) return null;
  const res = await dialog.showOpenDialog(win, {
    title: 'Choose workspace folder',
    defaultPath: ws.folder || app.getPath('downloads'),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (res.canceled || !res.filePaths.length) return null;
  const updated = workspaces.update(id, { folder: res.filePaths[0] });
  notifySidebar();
  return updated;
}

async function openMeshcoderConfig() {
  const file = meshcoder.configPath();
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ home: '', python: '', _note: 'home = MeshCoder clone path, python = its conda env python.exe' }, null, 2)
    );
  }
  await shell.openPath(file);
}

/**
 * Build a compound script for the active workspace: import its meshes and
 * re-use the scripts generated earlier, so the work accumulates.
 */
async function compoundActiveWorkspace() {
  const win = focusedWindow();
  const ws = workspaces.active();
  try {
    const res = compounding.compoundWorkspace(ws ? ws.id : null);
    notifySidebar();
    new Notification({
      title: 'Hunyuan3D',
      body: `Compound build saved: ${path.basename(res.filePath)}`,
    }).show();
    shell.showItemInFolder(res.filePath);
  } catch (err) {
    await dialog.showMessageBox(win, {
      type: 'info',
      message: 'Nothing to compound',
      detail: String(err && err.message ? err.message : err),
    });
  }
}

function buildMenu() {
  const template = [
    {
      label: 'Hunyuan3D',
      submenu: [
        { label: 'Home', click: () => focusedWebContents()?.loadURL(HOME_URL) },
        {
          label: 'Translate site to English',
          type: 'checkbox',
          checked: Boolean(settings.translateToEnglish),
          click: () => toggleTranslate(),
        },
        { type: 'separator' },
        {
          label: 'Clear session && restart',
          click: () => {
            // Wipes the persisted cookies/localStorage, then restarts the app.
            session
              .fromPartition('persist:hunyuan3d')
              .clearStorageData()
              .finally(() => {
                app.relaunch();
                app.exit(0);
              });
          },
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Navigate',
      submenu: [
        { label: 'Back', accelerator: 'Alt+Left', click: () => focusedWebContents()?.goBack() },
        { label: 'Forward', accelerator: 'Alt+Right', click: () => focusedWebContents()?.goForward() },
        { label: 'Reload', accelerator: 'Ctrl+R', click: () => focusedWebContents()?.reload() },
        { type: 'separator' },
        { label: 'Toggle DevTools', accelerator: 'Ctrl+Shift+I', click: () => focusedWebContents()?.toggleDevTools() },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Toggle Asset Sidebar',
          accelerator: 'Ctrl+B',
          click: () => toggleSidebar(),
        },
        {
          label: 'Sidebar width: wider',
          accelerator: 'Ctrl+Alt+]',
          click: () => setSidebarWidth(sidebarWidth + 32),
        },
        {
          label: 'Sidebar width: narrower',
          accelerator: 'Ctrl+Alt+[',
          click: () => setSidebarWidth(sidebarWidth - 32),
        },
        { type: 'separator' },
        {
          label: 'Scan active workspace folder for models',
          accelerator: 'Ctrl+Shift+F',
          click: () => {
            const ws = workspaces.active();
            const folder = ws && ws.folder ? ws.folder : app.getPath('downloads');
            const added = assets.scanFolder(folder);
            notifySidebar();
            new Notification({
              title: 'Hunyuan3D',
              body: added.length
                ? `Added ${added.length} model(s) to ${ws ? ws.name : 'the asset manager'}`
                : 'No new models found',
            }).show();
          },
        },
        {
          label: 'Scan Downloads for models',
          click: () => {
            const added = assets.scanFolder(app.getPath('downloads'));
            notifySidebar();
            new Notification({
              title: 'Hunyuan3D',
              body: added.length
                ? `Added ${added.length} model(s) to the asset manager`
                : 'No new models found in Downloads',
            }).show();
          },
        },
        {
          label: 'Reveal asset index file',
          click: () => shell.showItemInFolder(assets.storePath()),
        },
      ],
    },
    {
      label: 'Workspaces',
      submenu: [
        ...workspaces.list().map((ws) => ({
          label: ws.name,
          type: 'radio',
          checked: (workspaces.active() || {}).id === ws.id,
          click: () => {
            workspaces.setActive(ws.id);
            notifySidebar();
          },
        })),
        { type: 'separator' },
        {
          label: 'New workspace…',
          click: () => createWorkspaceDialog(),
        },
        {
          label: 'Switch workspace folder…',
          click: () => {
            const ws = workspaces.active();
            if (!ws) return;
            pickWorkspaceFolder(ws.id);
          },
        },
        {
          label: 'Reveal active workspace folder',
          click: () => {
            const ws = workspaces.active();
            if (ws && ws.folder) shell.openPath(ws.folder);
          },
        },
        { type: 'separator' },
        {
          label: 'Reveal workspaces file',
          click: () => shell.showItemInFolder(workspaces.storePath()),
        },
      ],
    },
    {
      label: 'Tools',
      submenu: [
        {
          label: 'Convert last download to Blender code (MeshCoder)',
          click: () => convertLastDownload(),
        },
        { label: 'Open MeshCoder config', click: () => openMeshcoderConfig() },
        { type: 'separator' },
        {
          label: 'Compound active workspace',
          click: () => compoundActiveWorkspace(),
        },
        {
          label: 'Reveal parts library file',
          click: () => shell.showItemInFolder(compounding.storePath()),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** IPC surface used by the sidebar renderer. */
function registerIpc() {
  ipcMain.handle('assets:list', (_e, workspaceId) => assets.list(workspaceId || null));
  ipcMain.handle('assets:stats', (_e, workspaceId) => assets.stats(workspaceId || null));
  ipcMain.handle('assets:track', (_e, filePath, workspaceId) => {
    const record = assets.track(String(filePath || ''), null, workspaceId || null);
    notifySidebar();
    return record;
  });
  ipcMain.handle('assets:assign', (_e, id, workspaceId) => {
    // 'assign' physically moves the file into the workspace's folder.
    try {
      const record = assets.assign(String(id || ''), workspaceId || null);
      notifySidebar();
      return { ok: true, record };
    } catch (err) {
      return { ok: false, message: err && err.message ? err.message : 'Move failed.' };
    }
  });
  ipcMain.handle('assets:scan', (_e, folder) => {
    const target = folder || app.getPath('downloads');
    const added = assets.scanFolder(target);
    notifySidebar();
    return added;
  });
  ipcMain.handle('assets:remove', (_e, id) => {
    assets.remove(String(id || ''));
    notifySidebar();
    return true;
  });
  ipcMain.handle('assets:reveal', (_e, filePath) => {
    const p = String(filePath || '');
    if (!p || !fs.existsSync(p)) return false;
    shell.showItemInFolder(p);
    return true;
  });
  ipcMain.handle('assets:open', (_e, filePath) => {
    const p = String(filePath || '');
    if (!p || !fs.existsSync(p)) return false;
    return shell.openPath(p).then(() => true).catch(() => false);
  });
  ipcMain.handle('assets:convert', async (_e, id) => {
    const found = assets.find(String(id || ''));
    if (!found) return { message: 'Asset not found' };
    // Re-resolve the workspace (it may have been inferred from the folder).
    const asset = assets.findByPath(found.filePath) || found;
    if (converting) return { message: 'A conversion is already running' };
    if (!meshcoder.isConfigured()) {
      return { message: 'MeshCoder is not configured — see Tools → Open MeshCoder config' };
    }
    converting = true;
    notifySidebar();
    try {
      // Write the generated script into the owning workspace folder.
      const owner = asset.workspaceId ? workspaces.find(asset.workspaceId) : null;
      const outDir = owner && owner.folder ? owner.folder : path.dirname(asset.filePath);
      const codePath = await meshcoder.convertToCode(asset.filePath, outDir);
      const mesh = assets.track(asset.filePath, 'model', owner ? owner.id : null);
      assets.linkCode(codePath, mesh.id);
      compounding.harvest(codePath, path.basename(asset.filePath));
      notifySidebar();
      new Notification({
        title: 'Hunyuan3D',
        body: `Blender code saved: ${path.basename(codePath)}`,
      }).show();
      shell.showItemInFolder(codePath);
      return { message: `Saved ${path.basename(codePath)}` };
    } catch (err) {
      const detail = String(err && err.message ? err.message : err);
      new Notification({ title: 'Hunyuan3D', body: `MeshCoder failed: ${detail.slice(0, 120)}` }).show();
      return { message: `Failed: ${detail.slice(0, 200)}` };
    } finally {
      converting = false;
      notifySidebar();
    }
  });

  // --- compounding engine --------------------------------------------
  ipcMain.handle('compounding:library', () => compounding.library());
  ipcMain.handle('compounding:compound', async (_e, workspaceId, options) => {
    try {
      const res = compounding.compoundWorkspace(workspaceId || null, options || {});
      notifySidebar();
      new Notification({
        title: 'Hunyuan3D',
        body: `Compound build saved: ${path.basename(res.filePath)}`,
      }).show();
      return {
        message: `Saved ${path.basename(res.filePath)} (${res.meshes} mesh(es), ${res.scripts} script(s) re-used)`,
        filePath: res.filePath,
      };
    } catch (err) {
      return { message: `Failed: ${String(err && err.message ? err.message : err)}` };
    }
  });
  ipcMain.handle('compounding:reveal', (_e, filePath) => {
    const p = String(filePath || '');
    if (!p) {
      // No file given — reveal the compounding store itself.
      const store = compounding.storePath();
      fs.mkdirSync(path.dirname(store), { recursive: true });
      shell.showItemInFolder(store);
      return true;
    }
    if (!fs.existsSync(p)) return false;
    shell.showItemInFolder(p);
    return true;
  });

  ipcMain.handle('sidebar:toggle', () => toggleSidebar());
  ipcMain.handle('sidebar:setWidth', (_e, width) => setSidebarWidth(width));
  ipcMain.handle('sidebar:isVisible', () => sidebarVisible);

  // --- workspaces ----------------------------------------------------
  ipcMain.handle('workspaces:list', () => ({
    workspaces: workspaces.list(),
    activeId: (workspaces.active() || {}).id || null,
  }));
  ipcMain.handle('workspaces:create', (_e, payload) => {
    const ws = workspaces.create(payload || {});
    notifySidebar();
    return ws;
  });
  ipcMain.handle('workspaces:update', (_e, id, patch) => {
    const ws = workspaces.update(String(id || ''), patch || {});
    notifySidebar();
    return ws;
  });
  ipcMain.handle('workspaces:remove', (_e, id) => {
    workspaces.remove(String(id || ''));
    notifySidebar();
    return true;
  });
  ipcMain.handle('workspaces:setActive', (_e, id) => {
    const ws = workspaces.setActive(id || null);
    notifySidebar();
    return ws;
  });
  ipcMain.handle('workspaces:pickFolder', async (_e, id) => {
    const win = focusedWindow();
    const current = id ? workspaces.find(String(id)) : null;
    const res = await dialog.showOpenDialog(win, {
      title: 'Choose workspace folder',
      defaultPath: current && current.folder ? current.folder : app.getPath('downloads'),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || !res.filePaths.length) return null;
    const folder = res.filePaths[0];
    if (id) return workspaces.update(String(id), { folder });
    return workspaces.create({ name: path.basename(folder), folder });
  });
  ipcMain.handle('workspaces:reveal', (_e, id) => {
    const ws = workspaces.find(String(id || ''));
    if (!ws || !ws.folder || !fs.existsSync(ws.folder)) return false;
    shell.openPath(ws.folder);
    return true;
  });
}

module.exports = { registerIpc, createMainWindow, buildMenu };

/**
 * True when this file is the app's entry point.
 *
 * `require.main === module` is NOT reliable inside Electron — `require.main`
 * is the `electron` module itself, so that check is always false and the app
 * would never bootstrap. Instead we look at the entry script Electron was
 * launched with: the first non-flag argument in argv, resolved to an
 * absolute path and compared against this file.
 */
function isEntryPoint() {
  if (process.defaultApp) {
    // `electron .` or `electron path/to/app` — argv[1] is the app location.
    const arg = process.argv[1];
    if (!arg) return false;
    try {
      const resolved = path.resolve(arg);
      // argv[1] may be the app directory (".") rather than main.js itself.
      if (path.extname(resolved) === '.js') {
        return resolved === __filename;
      }
      return path.join(resolved, 'main.js') === __filename;
    } catch {
      return false;
    }
  }
  // Packaged app: main.js is loaded from the asar by the Electron binary.
  return path.basename(process.execPath).toLowerCase() !== 'electron.exe';
}

if (isEntryPoint()) {
  app.whenReady().then(() => {
    registerIpc();
    loadLayout();
    // Every app needs at least one workspace — the first one points at Downloads.
    workspaces.ensureDefault();

    // Every new webContents (popups included) gets the same window.open policy.
    app.on('web-contents-created', (_event, contents) => {
      if (contents.getType() === 'window') {
        applyWindowOpenHandler(contents);
        if (settings.translateToEnglish) {
          contents.on('dom-ready', () => injectTranslator(contents));
        }
      }
    });

    if (settings.translateToEnglish) {
      // Ask the site for English (helps if its i18n keys off the header),
      // and machine-translate whatever still renders in Chinese.
      const ses = session.fromPartition('persist:hunyuan3d');
      ses.webRequest.onBeforeSendHeaders((details, callback) => {
        details.requestHeaders['Accept-Language'] = 'en-US,en;q=0.9';
        callback({ requestHeaders: details.requestHeaders });
      });
    }

    createMainWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
