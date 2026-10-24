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
 *    in place with a small injected translator of our own (the site ships
 *    Chinese-first). No Google widget — it left a banner and a floating
 *    button on the page no matter how hard we hid them.
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
  clipboard,
  Notification,
  dialog,
  ipcMain,
} = require('electron');
const path = require('path');
const fs = require('fs');
const url = require('url');
const meshcoder = require('./meshcoder');
const assets = require('./assets');
const thumbs = require('./thumbs');
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

// Top navigation bar (back / forward / reload), under the app menu.
const NAV_BAR_HEIGHT = 34;

// Site view zoom steps (browser-style), for the nav bar's scaling buttons.
const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
const SIDEBAR_COLLAPSED_WIDTH = 36;

let lastDownloadPath = null;
let converting = false;

/** Main window + its two views (sidebar + site). */
let mainWindow = null;
let sidebarView = null;
let siteView = null;
let navView = null;
const viewerWindows = new Set();
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

// In-page translator, injected when translation is on. Self-contained on
// purpose: it is stringified with Function#toString and run inside the
// site's page, so it cannot reference anything from this module's scope.
// It walks the page's text (and placeholders/tooltips), sends Chinese
// strings to Google Translate's free endpoint in small batches, and swaps
// the English in place. If Google refuses (rate limit / block), it falls
// back to the MyMemory API; if that fails too, the Chinese is left as-is.
// Translations are cached in the page's localStorage, so repeat strings
// cost nothing. No Google widget is loaded — there is no banner, button
// or other foreign UI to hide.
function pageTranslator() {
  if (window.__hy3dTranslator) return;
  window.__hy3dTranslator = true;
  // A leftover cookie from the old widget days; harmless, but tidy it up.
  try {
    document.cookie = 'googtrans=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
  } catch (e) {}

  var ZH = /[\u3400-\u9FFF\uF900-\uFAFF]/;
  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEXTAREA: 1, CODE: 1, PRE: 1 };
  var ATTRS = ['placeholder', 'title', 'alt', 'aria-label'];
  var CACHE_KEY = 'hy3dTrCacheV1';

  var cache = {};
  try {
    cache = JSON.parse(localStorage.getItem(CACHE_KEY) || '{}') || {};
  } catch (e) {
    cache = {};
  }
  var saveTimer = null;
  function saveCache() {
    if (saveTimer) return;
    saveTimer = setTimeout(function () {
      saveTimer = null;
      try {
        localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
      } catch (e) {}
    }, 400);
  }

  var waiters = {}; // src -> [job]; job: {kind:'text',node} | {kind:'attr',el,attr} | {kind:'title'}
  var queued = {}; // src -> true while it sits in the request queue
  var queue = []; // srcs waiting to be requested
  var singles = {}; // srcs that must be requested one at a time (batch alignment failed)
  var inFlight = 0;
  var flushTimer = null;
  var googleFails = 0;
  var applied = new WeakMap(); // node/element -> what we last set (mutation-loop guard)

  function resolve(src, dst) {
    delete queued[src];
    var jobs = waiters[src] || [];
    delete waiters[src];
    if (dst) {
      cache[src] = dst;
      saveCache();
    }
    jobs.forEach(function (job) {
      if (!dst) return; // translation failed — leave the Chinese untouched
      if (job.kind === 'text') applyText(job.node, src, dst);
      else if (job.kind === 'attr') applyAttr(job.el, job.attr, src, dst);
      else if (job.kind === 'title' && document.title === src) document.title = dst;
    });
  }

  function applyText(node, src, dst) {
    var cur = node.nodeValue || '';
    if (cur.trim() !== src) {
      scanTextNode(node); // the text changed while we were translating
      return;
    }
    var next = cur.match(/^\s*/)[0] + dst + cur.match(/\s*$/)[0];
    applied.set(node, next);
    node.nodeValue = next;
    // English runs longer than the Chinese it replaces, so a translated
    // label can spill past its button or tab. If it does, shrink the
    // overflowing container's font until it fits (floor: 70% of the
    // original size — readability wins over a perfect fit).
    fitText(node);
  }

  var fitOriginal = new WeakMap(); // element -> its original font size (px)

  function fitText(node) {
    var el = node.parentElement;
    var depth = 0;
    while (el && el !== document.body && depth < 4) {
      depth++;
      var cs = null;
      try {
        cs = window.getComputedStyle(el);
      } catch (e) {}
      var overflowing =
        el.scrollWidth > el.clientWidth + 1 ||
        (cs &&
          (cs.overflowY === 'hidden' || cs.overflowY === 'clip') &&
          el.scrollHeight > el.clientHeight + 1);
      if (overflowing) {
        var base = fitOriginal.get(el);
        if (!base) {
          base = (cs && parseFloat(cs.fontSize)) || 16;
          fitOriginal.set(el, base);
        }
        var size = base;
        var floor = base * 0.7;
        while (
          size > floor &&
          (el.scrollWidth > el.clientWidth + 1 ||
            (cs &&
              (cs.overflowY === 'hidden' || cs.overflowY === 'clip') &&
              el.scrollHeight > el.clientHeight + 1))
        ) {
          size = Math.max(floor, size * 0.92);
          el.style.fontSize = size + 'px';
        }
        return;
      }
      el = el.parentElement;
    }
  }

  function applyAttr(el, attr, src, dst) {
    if (el.getAttribute(attr) !== src) {
      scanAttrs(el);
      return;
    }
    var m = applied.get(el) || {};
    m[attr] = dst;
    applied.set(el, m);
    el.setAttribute(attr, dst);
  }

  function applyJob(job, src, dst) {
    if (job.kind === 'text') applyText(job.node, src, dst);
    else if (job.kind === 'attr') applyAttr(job.el, job.attr, src, dst);
    else if (job.kind === 'title' && document.title === src) document.title = dst;
  }

  function addWaiter(src, job) {
    if (Object.prototype.hasOwnProperty.call(cache, src)) {
      applyJob(job, src, cache[src]);
      return;
    }
    (waiters[src] = waiters[src] || []).push(job);
    if (!queued[src]) {
      queued[src] = true;
      queue.push(src);
    }
    scheduleFlush();
  }

  function fetchGoogle(text) {
    var url =
      'https://translate.googleapis.com/translate_a/single?client=gtx&sl=zh-CN&tl=en&dt=t&q=' +
      encodeURIComponent(text);
    return fetch(url, { credentials: 'omit' })
      .then(function (r) {
        if (!r.ok) throw new Error('http ' + r.status);
        return r.json();
      })
      .then(function (data) {
        if (!data || !data[0]) throw new Error('unexpected response');
        var out = '';
        data[0].forEach(function (seg) {
          if (seg && seg[0]) out += seg[0];
        });
        return out;
      })
      .catch(function () {
        return null;
      });
  }

  function fetchMyMemory(text) {
    var url =
      'https://api.mymemory.translated.net/get?langpair=zh-CN|en&q=' +
      encodeURIComponent(text);
    return fetch(url, { credentials: 'omit' })
      .then(function (r) {
        return r.json();
      })
      .then(function (d) {
        var t = d && d.responseData && d.responseData.translatedText;
        if (!t || t === text || /MYMEMORY|INVALID|QUOTA/i.test(t)) return null;
        return t;
      })
      .catch(function () {
        return null;
      });
  }

  function translateSingle(src) {
    inFlight++;
    var finish = function (dst) {
      inFlight--;
      resolve(src, dst ? dst.trim() : null);
      flush();
    };
    if (googleFails < 3) {
      fetchGoogle(src).then(function (g) {
        if (g !== null) {
          googleFails = 0;
          finish(g);
        } else {
          googleFails++;
          fetchMyMemory(src).then(finish);
        }
      });
    } else {
      fetchMyMemory(src).then(finish);
    }
  }

  function sendBatch(batch) {
    inFlight++;
    fetchGoogle(batch.join('\n')).then(function (full) {
      inFlight--;
      var lines = full !== null ? full.split('\n') : null;
      if (lines && lines.length === batch.length) {
        googleFails = 0;
        batch.forEach(function (src, i) {
          resolve(src, lines[i].trim() || null);
        });
      } else {
        // The lines did not line up (or Google refused): redo one by one.
        // (queued[src] is still set from the original queueing — the
        // strings just need to go back into the queue as singles.)
        if (full === null) googleFails++;
        batch.forEach(function (src) {
          singles[src] = true;
          queue.unshift(src);
        });
      }
      flush();
    });
  }

  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(flush, 150);
  }

  function flush() {
    flushTimer = null;
    while (inFlight < 3 && queue.length) {
      if (singles[queue[0]]) {
        delete singles[queue[0]];
        translateSingle(queue.shift());
        continue;
      }
      var batch = [];
      var chars = 0;
      while (queue.length && batch.length < 40 && !singles[queue[0]]) {
        var s = queue[0];
        if (batch.length && chars + s.length > 900) break;
        batch.push(queue.shift());
        chars += s.length + 1;
      }
      if (batch.length === 1) translateSingle(batch[0]);
      else if (batch.length > 1) sendBatch(batch);
    }
  }

  function skippable(el) {
    var n = el;
    while (n && n !== document.body) {
      if (SKIP_TAGS[n.tagName]) return true;
      if (n.isContentEditable) return true;
      if (n.getAttribute && n.getAttribute('translate') === 'no') return true;
      if (typeof n.className === 'string' && n.className.indexOf('notranslate') >= 0) return true;
      n = n.parentElement;
    }
    return false;
  }

  function scanTextNode(node) {
    var v = node.nodeValue || '';
    if (applied.get(node) === v) return;
    var src = v.trim();
    if (!src || !ZH.test(src)) return;
    var parent = node.parentElement;
    if (!parent || skippable(parent)) return;
    addWaiter(src, { kind: 'text', node: node });
  }

  function scanAttrs(el) {
    if (!el.getAttribute || skippable(el)) return;
    var attrs = ATTRS;
    if (el.tagName === 'INPUT') {
      var t = (el.getAttribute('type') || '').toLowerCase();
      if (t === 'button' || t === 'submit' || t === 'reset') attrs = ATTRS.concat(['value']);
    }
    var m = applied.get(el) || {};
    attrs.forEach(function (attr) {
      var v = el.getAttribute(attr);
      if (!v || m[attr] === v) return;
      var src = v.trim();
      if (src && ZH.test(src)) addWaiter(src, { kind: 'attr', el: el, attr: attr });
    });
  }

  function scanRoot(root) {
    if (!root) return;
    if (root.nodeType === 3) {
      scanTextNode(root);
      return;
    }
    if (root.nodeType !== 1) return;
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    var n;
    while ((n = walker.nextNode())) scanTextNode(n);
    scanAttrs(root);
    var els = root.querySelectorAll(
      '[placeholder],[title],[alt],[aria-label],input[type=button],input[type=submit],input[type=reset]'
    );
    for (var i = 0; i < els.length; i++) scanAttrs(els[i]);
  }

  function scanTitle() {
    var t = document.title;
    if (t && ZH.test(t)) addWaiter(t, { kind: 'title' });
  }

  var pendingRoots = [];
  var scanTimer = null;
  function queueScan(root) {
    pendingRoots.push(root);
    if (scanTimer) return;
    scanTimer = setTimeout(function () {
      scanTimer = null;
      var roots = pendingRoots;
      pendingRoots = [];
      roots.forEach(scanRoot);
      scanTitle();
    }, 120);
  }

  new MutationObserver(function (muts) {
    muts.forEach(function (m) {
      if (m.type === 'characterData') queueScan(m.target);
      else if (m.type === 'attributes') queueScan(m.target);
      else if (m.addedNodes) {
        for (var i = 0; i < m.addedNodes.length; i++) queueScan(m.addedNodes[i]);
      }
    });
  }).observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['placeholder', 'title', 'alt', 'aria-label', 'value'],
  });

  scanRoot(document.body || document.documentElement);
  scanTitle();
}

const TRANSLATE_SNIPPET = '(' + pageTranslator.toString() + ')();';

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
 * Thumbnail worker: renders one model in a hidden window and caches the
 * capture under <userData>/thumbs/<asset-id>.png. Jobs run one at a time
 * so a big library does not spawn a storm of windows; each completion
 * notifies the sidebar, so thumbnails appear progressively. A failed
 * render is recorded against the file's mtime and retried only when the
 * file changes.
 */
const thumbQueue = new Set();
let thumbWorking = false;
let thumbCurrent = null;

function queueThumb(asset) {
  if (!asset || asset.id === thumbCurrent) return;
  thumbQueue.add(asset.id);
  pumpThumbQueue();
}

async function pumpThumbQueue() {
  if (thumbWorking) return;
  thumbWorking = true;
  try {
    while (thumbQueue.size) {
      const id = thumbQueue.values().next().value;
      thumbQueue.delete(id);
      thumbCurrent = id;
      try {
        await renderThumb(id);
      } catch { /* a failed render is recorded inside renderThumb */ }
      thumbCurrent = null;
      await new Promise((r) => setTimeout(r, 200));
    }
  } finally {
    thumbWorking = false;
    thumbCurrent = null;
  }
}

async function renderThumb(id) {
  const asset = assets.find(id);
  if (!asset || !fs.existsSync(asset.filePath)) return;
  const win = new BrowserWindow({
    width: 144,
    height: 144,
    show: false,
    frame: false, // no title bar, so the capture is a true square
    webPreferences: {
      preload: path.join(__dirname, 'viewer-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  try {
    await win.loadFile(path.join(__dirname, 'thumb.html'), { query: { file: asset.filePath } });
    const deadline = Date.now() + 30000;
    let status = null;
    while (Date.now() < deadline) {
      if (win.isDestroyed()) break;
      status = await win.webContents.executeJavaScript('window.__thumbStatus || null').catch(() => null);
      if (status) break;
      await new Promise((r) => setTimeout(r, 300));
    }
    if (status === 'ok') {
      const img = await win.webContents.capturePage();
      fs.mkdirSync(thumbs.dir(), { recursive: true });
      fs.writeFileSync(thumbs.thumbPath(id), img.toPNG());
      thumbs.set(id, fs.statSync(asset.filePath).mtimeMs);
      notifySidebar();
    } else if (fs.existsSync(asset.filePath)) {
      thumbs.markFailed(id, fs.statSync(asset.filePath).mtimeMs);
    }
  } finally {
    if (!win.isDestroyed()) win.close();
  }
}

/**
 * Open a model in the in-app 3D viewer window (Three.js). The file path
 * travels as a URL query; the bytes travel over IPC when the page asks.
 */
function openViewer(filePath) {
  const win = new BrowserWindow({
    width: 1000,
    height: 750,
    minWidth: 640,
    minHeight: 480,
    title: `Viewer — ${path.basename(filePath)}`,
    webPreferences: {
      preload: path.join(__dirname, 'viewer-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  viewerWindows.add(win);
  win.on('closed', () => viewerWindows.delete(win));
  win.loadFile(path.join(__dirname, 'viewer.html'), { query: { file: filePath } });
  return win;
}

/**
 * Layout: the main window hosts three WebContentsViews —
 *   - navView:     a slim top bar with back / forward / reload buttons
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

  // --- top navigation bar --------------------------------------------
  navView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'nav-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  navView.webContents.loadFile(path.join(__dirname, 'nav.html'));

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
  // Keep the nav bar's back/forward arrows in sync with the site history.
  siteView.webContents.on('did-navigate', pushNavState);
  siteView.webContents.on('did-navigate-in-page', pushNavState);
  siteView.webContents.on('did-finish-load', () => {
    // Apply the saved zoom — and on first launch, default to 75%,
    // because the site renders big. (Chromium forgets zoom across
    // restarts, so it is re-applied on every load.)
    if (settings.zoomFactor == null) {
      settings.zoomFactor = 0.75;
      saveSettings(settings);
    }
    if (settings.zoomFactor !== 1) {
      try {
        siteView.webContents.setZoomFactor(settings.zoomFactor);
      } catch {
        /* view going away — ignore */
      }
    }
    pushNavState();
  });
  siteView.webContents.on('zoom-changed', pushNavState);
  if (settings.translateToEnglish) {
    const siteContents = siteView.webContents;
    siteContents.on('dom-ready', () => injectTranslator(siteContents));
  }

  win.contentView.addChildView(navView);
  win.contentView.addChildView(sidebarView);
  win.contentView.addChildView(siteView);

  layoutViews();
  win.on('resize', layoutViews);
  win.on('maximize', layoutViews);
  win.on('unmaximize', layoutViews);

  win.on('closed', () => {
    mainWindow = null;
    navView = null;
    sidebarView = null;
    siteView = null;
  });

  buildMenu();
  // The menu bar shrinks the content area (~28px on Windows) without
  // firing a resize event, so lay out again now that it exists — otherwise
  // the views keep their pre-menu bounds and the sidebar footer sits
  // below the visible area until the user resizes the window.
  layoutViews();
  return win;
}

/** Position the nav bar, sidebar and site view inside the window. */
function layoutViews() {
  if (!mainWindow || !sidebarView || !siteView) return;
  const { width: w, height: h } = mainWindow.getContentBounds();
  const sidebarW = sidebarVisible ? Math.round(sidebarWidth) : SIDEBAR_COLLAPSED_WIDTH;
  const below = Math.max(0, h - NAV_BAR_HEIGHT);
  if (navView) navView.setBounds({ x: 0, y: 0, width: w, height: NAV_BAR_HEIGHT });
  sidebarView.setBounds({ x: 0, y: NAV_BAR_HEIGHT, width: sidebarW, height: below });
  siteView.setBounds({ x: sidebarW, y: NAV_BAR_HEIGHT, width: Math.max(0, w - sidebarW), height: below });
}

/** navigationHistory is the modern API; fall back to the legacy methods. */
function navCan(wc, dir) {
  try {
    if (wc.navigationHistory) {
      return dir === 'back' ? wc.navigationHistory.canGoBack() : wc.navigationHistory.canGoForward();
    }
    return dir === 'back' ? wc.canGoBack() : wc.canGoForward();
  } catch {
    return false;
  }
}

function navGo(wc, dir) {
  try {
    if (wc.navigationHistory) {
      if (dir === 'back') wc.navigationHistory.goBack();
      else wc.navigationHistory.goForward();
    } else if (dir === 'back') {
      wc.goBack();
    } else {
      wc.goForward();
    }
  } catch {
    /* navigation raced a page change — nothing to do */
  }
}

/** Enable/disable the nav bar arrows and set its zoom readout. */
function pushNavState() {
  if (!navView || navView.webContents.isDestroyed() || !siteView) return;
  const zoom = currentZoom();
  navView.webContents.send('nav:state', {
    canGoBack: navCan(siteView.webContents, 'back'),
    canGoForward: navCan(siteView.webContents, 'forward'),
    zoomPct: Math.round(zoom * 100),
    canZoomIn: zoom < ZOOM_STEPS[ZOOM_STEPS.length - 1] - 0.001,
    canZoomOut: zoom > ZOOM_STEPS[0] + 0.001,
  });
}

function currentZoom() {
  if (!siteView) return 1;
  try {
    return siteView.webContents.getZoomFactor();
  } catch {
    return 1;
  }
}

/** Set the site zoom, remember it for next launch, refresh the nav bar. */
function applyZoom(factor) {
  if (!siteView) return;
  const f = Math.min(ZOOM_STEPS[ZOOM_STEPS.length - 1], Math.max(ZOOM_STEPS[0], factor));
  try {
    siteView.webContents.setZoomFactor(f);
  } catch {
    return;
  }
  settings.zoomFactor = f;
  saveSettings(settings);
  pushNavState();
}

/** Move one step up/down the zoom ladder, from wherever the zoom sits. */
function stepZoom(dir) {
  const cur = currentZoom();
  let idx = 0;
  let best = Infinity;
  ZOOM_STEPS.forEach((s, i) => {
    const d = Math.abs(s - cur);
    if (d < best) {
      best = d;
      idx = i;
    }
  });
  // Between steps (e.g. after Ctrl+wheel), head to the next step in the
  // requested direction rather than snapping to the nearest one.
  if (dir > 0 && ZOOM_STEPS[idx] <= cur) idx = Math.min(ZOOM_STEPS.length - 1, idx + 1);
  if (dir < 0 && ZOOM_STEPS[idx] >= cur) idx = Math.max(0, idx - 1);
  applyZoom(ZOOM_STEPS[idx]);
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
    const detected = meshcoder.detectAndSave();
    if (!meshcoder.isConfigured(detected.cfg)) {
      await dialog.showMessageBox(win, {
        type: 'warning',
        message: 'MeshCoder is not configured',
        detail:
          'Auto-detection looked in the usual clone folders and conda envs and found nothing. ' +
          'Point the app at your local MeshCoder install via Tools → Open MeshCoder config ' +
          '(set "home" and "python"), or the MESHCODER_HOME / MESHCODER_PYTHON env vars. ' +
          'See the MeshCoder section of the README for the full setup.',
      });
      return;
    }
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

async function detectMeshcoder() {
  const win = focusedWindow();
  const { cfg, newly } = meshcoder.detectAndSave();
  const configured = meshcoder.isConfigured(cfg);
  await dialog.showMessageBox(win, {
    type: configured ? 'info' : 'warning',
    message: configured ? 'MeshCoder detected' : 'MeshCoder not found',
    detail: configured
      ? `Home: ${cfg.home}${newly.home ? ' (auto-detected)' : ''}\nPython: ${cfg.python}${newly.python ? ' (auto-detected)' : ''}\n\nSaved to ${meshcoder.configPath()}.`
      : 'Auto-detection looked in the usual clone folders (~/MeshCoder, ~/Documents/GitHub, ~/source/repos), conda envs, and PATH pythons with torch + trimesh, and found nothing. Set it via Tools → Open MeshCoder config or the MESHCODER_HOME / MESHCODER_PYTHON env vars.',
  });
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
        { label: 'Detect MeshCoder automatically', click: () => detectMeshcoder() },
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

/** IPC surface used by the sidebar and nav bar renderers. */
function registerIpc() {
  // Top navigation bar: back / forward / reload for the site view.
  ipcMain.on('nav:back', () => {
    if (siteView) {
      navGo(siteView.webContents, 'back');
      pushNavState();
    }
  });
  ipcMain.on('nav:forward', () => {
    if (siteView) {
      navGo(siteView.webContents, 'forward');
      pushNavState();
    }
  });
  ipcMain.on('nav:reload', () => {
    if (siteView) siteView.webContents.reload();
  });
  ipcMain.on('nav:zoomIn', () => stepZoom(1));
  ipcMain.on('nav:zoomOut', () => stepZoom(-1));
  ipcMain.on('nav:zoomReset', () => applyZoom(1));

  ipcMain.handle('assets:list', (_e, workspaceId) => {
    const list = assets.list(workspaceId || null);
    for (const a of list) {
      if (a.kind !== 'model' || !a.exists) continue;
      const meta = thumbs.get(a.id);
      const pngExists = fs.existsSync(thumbs.thumbPath(a.id));
      const fresh = meta && !meta.failed && meta.mtimeMs === a.updatedAt && pngExists;
      if (fresh) {
        a.thumb = url.pathToFileURL(thumbs.thumbPath(a.id)).href;
      } else if (!meta || !meta.failed || meta.mtimeMs !== a.updatedAt) {
        // Missing, stale, or deleted PNG — but a render that failed for
        // this exact file version is not retried until the file changes.
        queueThumb(a);
      }
    }
    return list;
  });
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
    thumbs.remove(String(id || ''));
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
  // Open an asset: models go to the in-app 3D viewer, everything else to
  // the machine's default app.
  ipcMain.handle('assets:view', (_e, id) => {
    const found = assets.find(String(id || ''));
    if (!found || !fs.existsSync(found.filePath)) return { ok: false, message: 'File not found' };
    // Route by extension, not just the stored kind: a record tracked before
    // kinds existed (or re-tracked from a stale entry) must still open its
    // .glb in the viewer instead of falling through to the default app.
    const ext = path.extname(found.filePath).toLowerCase();
    if (found.kind === 'model' || assets.MODEL_EXTS.includes(ext)) {
      openViewer(found.filePath);
      return { ok: true };
    }
    return shell.openPath(found.filePath).then(() => ({ ok: true })).catch(() => ({ ok: false, message: 'Cannot open this file' }));
  });
  // The viewer window's file bytes, as a clean ArrayBuffer (a Node Buffer
  // would arrive with a pooled backing store and a nonzero byteOffset).
  ipcMain.handle('viewer:readFile', (_e, filePath) => {
    const p = String(filePath || '');
    const buf = fs.readFileSync(p);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  });
  // Rename an asset's file in place, then refresh the sidebar.
  ipcMain.handle('assets:rename', (_e, id, newName) => {
    const res = assets.rename(String(id || ''), String(newName || ''));
    if (res.ok) notifySidebar();
    return res;
  });
  // Copy the sidebar status line to the clipboard (main process owns the
  // clipboard API; the renderer must not depend on navigator.clipboard).
  ipcMain.handle('sidebar:copy', (_e, text) => {
    clipboard.writeText(String(text || ''));
    return true;
  });
  ipcMain.handle('assets:convert', async (_e, id) => {
    const found = assets.find(String(id || ''));
    if (!found) return { message: 'Asset not found' };
    // Re-resolve the workspace (it may have been inferred from the folder).
    const asset = assets.findByPath(found.filePath) || found;
    if (converting) return { message: 'A conversion is already running' };
    if (!meshcoder.isConfigured()) {
      const detected = meshcoder.detectAndSave();
      if (!meshcoder.isConfigured(detected.cfg)) {
        return { message: 'MeshCoder is not configured and auto-detection found nothing — see Tools → Detect MeshCoder automatically' };
      }
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
