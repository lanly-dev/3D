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
  webContents,
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
const blenderprep = require('./blenderprep');
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

/* ------------------------------------------------------------------ */
/* Live conversion progress in the sidebar status bar. A dedicated    */
/* lightweight channel (not notifySidebar) so the 1-second elapsed    */
/* tick never triggers a full sidebar re-render. The full output is   */
/* kept in memory; on failure the real traceback is extracted for     */
/* the status line and the whole log is written to userData.          */
/* ------------------------------------------------------------------ */

const conversionUi = { file: '', phase: '', startedAt: 0, timer: null, lines: [], syntaxIssue: null };

function pushSidebarStatus(text) {
  if (sidebarView && !sidebarView.webContents.isDestroyed()) {
    sidebarView.webContents.send('sidebar:status', String(text));
  }
}

function formatElapsed(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function conversionStatusText() {
  const phaseLabel = conversionUi.phase === 'sampling' ? 'Sampling points' : 'Generating code';
  const last = conversionUi.lines.length ? conversionUi.lines[conversionUi.lines.length - 1] : '';
  const tail = last && last.length <= 90 ? ` — ${last}` : '';
  return `MeshCoder · ${phaseLabel}: ${conversionUi.file} · ${formatElapsed(Date.now() - conversionUi.startedAt)}${tail}`;
}

/** Options handed to meshcoder.convertToCode so progress streams here. */
function conversionProgressOpts() {
  return {
    onPhase: (phase) => {
      conversionUi.phase = phase;
      pushSidebarStatus(conversionStatusText());
    },
    onLog: (line) => {
      conversionUi.lines.push(line);
      if (conversionUi.lines.length > 400) conversionUi.lines.splice(0, conversionUi.lines.length - 400);
    },
    onSyntaxIssue: (issue) => {
      conversionUi.syntaxIssue = issue;
    },
  };
}

function startConversionUi(filePath) {
  conversionUi.file = path.basename(filePath);
  conversionUi.phase = 'sampling';
  conversionUi.startedAt = Date.now();
  conversionUi.lines = [];
  conversionUi.syntaxIssue = null;
  pushSidebarStatus(conversionStatusText());
  clearInterval(conversionUi.timer);
  conversionUi.timer = setInterval(() => {
    if (converting) pushSidebarStatus(conversionStatusText());
  }, 1000);
}

function stopConversionUi() {
  clearInterval(conversionUi.timer);
  conversionUi.timer = null;
}

/**
 * The part of a failed run worth showing: the traceback (warnings and
 * progress noise sit above it), or the last lines when there is none.
 * Also writes the full log to userData and returns its path.
 */
function conversionFailureReport(err) {
  const text = conversionUi.lines.join('\n');
  let logPath = '';
  try {
    logPath = path.join(app.getPath('userData'), 'meshcoder-last-conversion.log');
    fs.writeFileSync(logPath, `${new Date().toISOString()}\n${text}\n${err && err.stack ? err.stack : ''}`);
  } catch {
    logPath = '';
  }
  const idx = text.lastIndexOf('Traceback (most recent call last)');
  const excerpt = (idx >= 0 ? text.slice(idx) : text.slice(-1200)).trim() || String(err && err.message ? err.message : err);
  return { excerpt, logPath };
}

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
 * so a big library does not spawn a storm of windows; completions notify
 * the sidebar (debounced — see notifySidebarSoon), so thumbnails appear
 * progressively without hammering the main process. A failed
 * render is recorded against the file's mtime and retried only when the
 * file changes.
 */
const thumbQueue = new Set();
let thumbWorking = false;
let thumbCurrent = null;
let thumbNotifyTimer = null;

/**
 * Sidebar refresh for thumbnail completions, debounced: a catch-up run
 * can finish a thumbnail every second or two, and each full sidebar
 * refresh costs a sync list rebuild on the main process — unbatched,
 * those bursts land on the same UI thread that tracks the native menu
 * bar, so menu hover stutters. At most one refresh per 800ms, plus one
 * final refresh when the queue drains (pumpThumbQueue flushes).
 */
function notifySidebarSoon() {
  if (thumbNotifyTimer) return;
  thumbNotifyTimer = setTimeout(() => {
    thumbNotifyTimer = null;
    notifySidebar();
  }, 800);
}

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
    // Land the last thumbnails even if the debounce is still pending.
    if (thumbNotifyTimer) {
      clearTimeout(thumbNotifyTimer);
      thumbNotifyTimer = null;
    }
    notifySidebar();
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
      notifySidebarSoon();
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
  // ...but that shrink lands asynchronously (measured: still pre-menu
  // height 100ms after setApplicationMenu, shrunk by 600ms), so a single
  // re-layout is not enough. Keep re-laying out until the size stops
  // changing (see settleLayout).
  settleLayout();
  return win;
}

/**
 * Re-run layoutViews until the window's content bounds stop changing.
 * Covers anything that resizes the content area asynchronously after
 * startup without a resize event (the menu bar is the known case). Polls
 * every 100ms and stops after 500ms of stability, or after 5s at most —
 * it never runs past startup.
 */
function settleLayout() {
  const win = mainWindow;
  if (!win) return;
  let lastW = -1;
  let lastH = -1;
  let stablePolls = 0;
  const timer = setInterval(() => {
    if (win.isDestroyed() || win !== mainWindow) {
      clearInterval(timer);
      return;
    }
    const { width: w, height: h } = win.getContentBounds();
    if (w !== lastW || h !== lastH) {
      lastW = w;
      lastH = h;
      stablePolls = 0;
      layoutViews();
    } else if (++stablePolls >= 5) {
      clearInterval(timer);
    }
  }, 100);
  setTimeout(() => clearInterval(timer), 5000);
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

/** F12: toggle DevTools on whichever view or window currently has focus. */
function toggleDevTools() {
  const wc = webContents.getFocusedWebContents();
  // If DevTools itself has focus, fall through to the site view instead of
  // trying to open DevTools for DevTools.
  if (wc && !wc.isDestroyed() && !wc.getURL().startsWith('devtools://')) {
    wc.toggleDevTools();
    return;
  }
  if (siteView && !siteView.webContents.isDestroyed()) siteView.webContents.toggleDevTools();
}

async function convertLastDownload() {
  const win = focusedWindow();
  if (converting) {
    pushSidebarStatus(conversionStatusText());
    return;
  }
  if (!lastDownloadPath) {
    await dialog.showMessageBox(win, {
      type: 'info',
      message: 'Nothing to convert yet',
      detail: 'Generate and download a model first — MeshCoder converts the most recent download.',
    });
    return;
  }
  if (!(await ensureMeshcoder(win))) return;
  converting = true;
  startConversionUi(lastDownloadPath);
  new Notification({
    title: 'Hunyuan3D',
    body: `MeshCoder: converting ${path.basename(lastDownloadPath)}…`,
  }).show();
  try {
    // Write the generated script into the mesh's workspace folder.
    const meshAsset = assets.findByPath(lastDownloadPath);
    const owner = meshAsset && meshAsset.workspaceId ? workspaces.find(meshAsset.workspaceId) : null;
    const outDir = owner && owner.folder ? owner.folder : path.dirname(lastDownloadPath);
    const codePath = await meshcoder.convertToCode(lastDownloadPath, outDir, conversionProgressOpts());
    // Register the generated script as an asset linked to its source mesh.
    const mesh = assets.track(lastDownloadPath, 'model', owner ? owner.id : null);
    assets.linkCode(codePath, mesh.id);
    // Feed the new parts into the compounding library.
    compounding.harvest(codePath, path.basename(lastDownloadPath));
    notifySidebar();
    new Notification({ title: 'Hunyuan3D', body: `Blender code saved: ${path.basename(codePath)}` }).show();
    if (conversionUi.syntaxIssue) {
      const si = conversionUi.syntaxIssue;
      pushSidebarStatus(
        `Saved ${path.basename(codePath)} — ⚠ syntax error at line ${si.line}: ${si.message} — Blender can't run it until that line is fixed (click to copy)${si.text ? `\n${si.text}` : ''}`
      );
    }
  } catch (err) {
    const report = conversionFailureReport(err);
    pushSidebarStatus(`MeshCoder failed (${conversionUi.file}) — click to copy the traceback\n${report.excerpt}`);
    await dialog.showMessageBox(win, {
      type: 'error',
      message: 'MeshCoder conversion failed',
      detail: `${report.excerpt}${report.logPath ? `\n\nFull log: ${report.logPath}` : ''}`,
    });
  } finally {
    converting = false;
    stopConversionUi();
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
 * Syntax-check one generated script on demand (the asset row's Verify
 * menu item) and describe the verdict for the status line: parses
 * cleanly, or the first bad line — the same check that runs after a
 * conversion, re-runnable after a hand fix. Uses the MeshCoder env's
 * python (configured, or auto-detected).
 */
async function verifyAssetFile(id) {
  const found = assets.find(String(id || ''));
  if (!found) return 'Asset not found';
  const name = path.basename(found.filePath);
  if (!fs.existsSync(found.filePath)) return `Verify: ${name} — file not found on disk`;
  let python = meshcoder.loadConfig().python;
  if (!python || !fs.existsSync(python)) python = meshcoder.detect().python;
  if (!python || !fs.existsSync(python)) {
    return 'Verify needs the MeshCoder Python env — run Tools → Set up MeshCoder automatically… (or Detect) first.';
  }
  const issue = await meshcoder.checkSyntax(python, found.filePath);
  if (!issue) return `Verify: ${name} — parses cleanly. Blender can run it.`;
  return `Verify: ${name} — ⚠ syntax error at line ${issue.line}: ${issue.message}${issue.text ? `\n${issue.text}` : ''}`;
}

/**
 * Move an asset's file to the Recycle Bin (with confirmation) and drop its
 * row. A model's companion Blender script moves along with it, and its
 * row goes too. A file already missing from disk just drops its row.
 */
async function deleteAssetFile(id) {
  const found = assets.find(String(id || ''));
  if (!found) return;
  const win = focusedWindow();
  if (!fs.existsSync(found.filePath)) {
    assets.remove(found.id);
    thumbs.remove(found.id);
    notifySidebar();
    return;
  }
  const ext = path.extname(found.filePath).toLowerCase();
  const compPath = assets.MODEL_EXTS.includes(ext)
    ? path.join(path.dirname(found.filePath), `${path.basename(found.filePath, ext)}.blender.py`)
    : null;
  const compRec = compPath ? assets.findByPath(compPath) : null;
  const res = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Delete file', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message: `Delete ${path.basename(found.filePath)}?`,
    detail: 'The file will be moved to the Recycle Bin, and the asset will be removed from the list.' +
      (compPath && fs.existsSync(compPath) ? ' Its companion Blender script is moved along with it.' : ''),
  });
  if (res.response !== 0) return;
  try {
    await shell.trashItem(found.filePath);
    if (compPath && fs.existsSync(compPath)) await shell.trashItem(compPath);
    if (lastDownloadPath === found.filePath) lastDownloadPath = null;
    assets.remove(found.id);
    if (compRec) assets.remove(compRec.id);
    thumbs.remove(found.id);
    notifySidebar();
  } catch (err) {
    await dialog.showMessageBox(win, {
      type: 'error',
      message: 'Could not delete file',
      detail: String(err && err.message ? err.message : err),
    });
  }
}

/**
 * Make sure MeshCoder is usable: detect first; if no clone exists anywhere,
 * offer to download it into Documents/Hunyuan3D/MeshCoder and detect again
 * (its Python env may already be present). Returns true when a conversion
 * can proceed. Shows its own dialogs; the false paths are already explained
 * (or the user declined the download).
 */
async function ensureMeshcoder(win) {
  if (meshcoder.isConfigured()) return true;
  meshcoder.detectAndSave();
  if (meshcoder.isConfigured()) return true;
  if (!meshcoder.loadConfig().home) {
    // No clone anywhere — offer the managed download.
    const dest = meshcoder.downloadDest();
    const res = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['Download', 'Not now'],
      defaultId: 0,
      cancelId: 1,
      message: 'MeshCoder not found',
      detail: `Download the MeshCoder code into ${dest}?\n\nIt is cloned from ${meshcoder.REPO_URL} (needs git on PATH). The Python env and the model checkpoints are still set up separately — see the MeshCoder section of the README.`,
    });
    if (res.response !== 0) return false;
    new Notification({ title: 'Hunyuan3D', body: 'Downloading MeshCoder…' }).show();
    try {
      await meshcoder.cloneRepo(dest);
    } catch (err) {
      await dialog.showMessageBox(win, {
        type: 'error',
        message: 'MeshCoder download failed',
        detail: String(err && err.message ? err.message : err),
      });
      return false;
    }
    const after = meshcoder.detectAndSave();
    if (!after.cfg.home) {
      await dialog.showMessageBox(win, {
        type: 'warning',
        message: 'Downloaded, but the clone was not recognized',
        detail: `Expected MeshCoder's inference script under ${dest}. Check the folder, or point the app at a clone via Tools → Open MeshCoder config.`,
      });
      return false;
    }
    new Notification({ title: 'Hunyuan3D', body: `MeshCoder downloaded to ${dest}` }).show();
  }
  if (meshcoder.isConfigured()) return true;
  // Code is in place; the env and/or checkpoints are missing. Offer the
  // automated native-Windows setup rather than manual instructions.
  const pick = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['Set up automatically', 'Not now'],
    defaultId: 0,
    cancelId: 1,
    message: 'MeshCoder needs its env and checkpoints',
    detail: 'The code is in place. Automatic setup (native Windows — no WSL2, no conda) creates a Python 3.10 env in Documents\\Hunyuan3D\\MeshCoderEnv, installs the packages (several GB), and downloads the checkpoints from Hugging Face (one-time access form on the model page, plus your token).',
  });
  if (pick.response === 0) openSetupWindow();
  return false;
}

async function detectMeshcoder() {
  const win = focusedWindow();
  if (!(await ensureMeshcoder(win))) return; // already explained, or declined
  const cfg = meshcoder.loadConfig();
  await dialog.showMessageBox(win, {
    type: 'info',
    message: 'MeshCoder ready',
    detail: `Home: ${cfg.home}\nPython: ${cfg.python}\n\nSaved to ${meshcoder.configPath()}.`,
  });
}

/* ------------------------------------------------------------------ */
/* MeshCoder automatic setup window: clone (if needed) -> Python 3.10  */
/* -> venv -> pip packages -> HF checkpoints -> import verification.   */
/* Native Windows only; the log streams to the window so a 20-minute   */
/* install is watchable and cancellable.                               */
/* ------------------------------------------------------------------ */

let setupWin = null;
let setupRunning = false;
let setupCancelled = false;
let setupChild = null;
let setupCancelDownload = null;

function openSetupWindow() {
  if (setupWin && !setupWin.isDestroyed()) {
    setupWin.focus();
    return setupWin;
  }
  setupWin = new BrowserWindow({
    width: 780,
    height: 620,
    title: 'MeshCoder setup',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'setup-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  setupWin.on('closed', () => {
    setupWin = null;
  });
  setupWin.loadFile(path.join(__dirname, 'setup.html'));
  return setupWin;
}

function setupLog(line) {
  if (setupWin && !setupWin.isDestroyed()) setupWin.webContents.send('setup:log', String(line));
}

function setupState(state) {
  if (setupWin && !setupWin.isDestroyed()) setupWin.webContents.send('setup:state', state);
}

async function runSetup(token) {
  if (setupRunning) return { ok: false, message: 'Setup is already running' };
  setupRunning = true;
  setupCancelled = false;
  const log = (line) => setupLog(line);
  const registerChild = (child) => {
    setupChild = child;
  };
  const registerCancel = (fn) => {
    setupCancelDownload = fn;
  };
  const checkCancel = () => {
    if (setupCancelled) throw new Error('Setup cancelled');
  };
  try {
    // 1. Clone (usually already handled by the download offer).
    let home = meshcoder.loadConfig().home || meshcoder.detect().home;
    if (!home) {
      setupState({ phase: 'running', label: 'Cloning MeshCoder…', pct: -1 });
      home = await meshcoder.cloneRepo(meshcoder.downloadDest());
      log(`Cloned MeshCoder to ${home}`);
    } else {
      log(`MeshCoder clone: ${home}`);
    }
    checkCancel();
    // 2. Env: base Python 3.10 (install if missing), then the venv.
    if (!fs.existsSync(meshcoder.envPython())) {
      setupState({ phase: 'running', label: 'Finding Python 3.10…', pct: -1 });
      let base = meshcoder.findBasePython310();
      if (!base) {
        log('No Python 3.10 found — installing it from python.org.');
        base = await meshcoder.installPython310({ onLog: log, registerCancel });
      }
      log(`Base Python: ${base}`);
      checkCancel();
      setupState({ phase: 'running', label: 'Creating the env…', pct: -1 });
      await meshcoder.createEnv(base, { onLog: log, registerChild });
      log(`Env created: ${meshcoder.envDir()}`);
    } else {
      log(`Env already exists: ${meshcoder.envDir()} (pip will check its packages)`);
    }
    // 3. Packages.
    const steps = meshcoder.installSteps(home);
    for (let i = 0; i < steps.length; i += 1) {
      checkCancel();
      const s = steps[i];
      setupState({ phase: 'running', label: `Packages ${i + 1}/${steps.length}: ${s.label}`, pct: -1 });
      log(`\n=== ${s.label} ===`);
      try {
        await meshcoder.runStreaming(s.cmd, s.args, { cwd: s.cwd, onLog: log, registerChild });
      } catch (err) {
        if (setupCancelled) throw err;
        if (s.optional) {
          log(`(optional step failed — continuing: ${err.message})`);
          continue;
        }
        throw err;
      }
    }
    checkCancel();
    // 3b. Windows stand-ins for pytorch3d / bpy (see meshcoder.js).
    setupState({ phase: 'running', label: 'Installing compatibility stand-ins…', pct: -1 });
    log('\n=== Compatibility stand-ins (pytorch3d / bpy) ===');
    meshcoder.installShims(log);
    checkCancel();
    // 4. Checkpoints from Hugging Face.
    if (!meshcoder.checkpointsPresent(home)) {
      setupState({ phase: 'running', label: 'Downloading checkpoints…', pct: 0 });
      await meshcoder.downloadCheckpoints(home, token, {
        onLog: log,
        registerCancel,
        onProgress: (done, total) => {
          if (total) {
            setupState({ phase: 'running', label: 'Downloading checkpoints…', pct: Math.floor((done / total) * 100) });
          }
        },
      });
      log('Checkpoints downloaded.');
    } else {
      log('Checkpoints already present.');
    }
    checkCancel();
    // 5. Verify exactly as conversion will run, then persist the config.
    setupState({ phase: 'running', label: 'Verifying the install…', pct: -1 });
    const { cuda } = await meshcoder.verifyEnv(home, { onLog: log, registerChild });
    meshcoder.saveConfig({ home, python: meshcoder.envPython() });
    log(
      cuda
        ? '\nSetup complete — MeshCoder imports cleanly and CUDA is visible.'
        : '\nSetup complete — imports pass, but PyTorch cannot see CUDA. Conversions need the GPU; check the NVIDIA driver.'
    );
    setupState({ phase: 'done', label: cuda ? 'Setup complete' : 'Setup complete (CUDA not visible — check the NVIDIA driver)', pct: 100 });
    new Notification({ title: 'Hunyuan3D', body: 'MeshCoder setup finished.' }).show();
    return { ok: true };
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    if (setupCancelled || /cancelled/i.test(msg)) {
      log('\nSetup cancelled. Re-running setup resumes where it left off.');
      setupState({ phase: 'cancelled', label: 'Setup cancelled', pct: -1 });
    } else {
      log(`\nSetup failed: ${msg}`);
      log('Tip: if the env is half-created, delete Documents\\Hunyuan3D\\MeshCoderEnv and run setup again.');
      setupState({ phase: 'error', label: `Failed: ${msg.slice(0, 140)}`, pct: -1 });
    }
    return { ok: false, message: msg };
  } finally {
    setupRunning = false;
    setupChild = null;
    setupCancelDownload = null;
  }
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

// --- Prepare Blender window -----------------------------------------
// bpy_lib (inside the MeshCoder clone) imports torch, which Blender's
// Python doesn't ship. This flow installs CPU-only torch into
// Blender's per-user modules folder and verifies by having Blender
// import bpy_lib headless. See blenderprep.js.
let prepWin = null;
let prepRunning = false;
let prepCancelled = false;
let prepChild = null;

function openPrepWindow() {
  if (prepWin && !prepWin.isDestroyed()) {
    prepWin.focus();
    return prepWin;
  }
  prepWin = new BrowserWindow({
    width: 780,
    height: 620,
    title: 'Prepare Blender',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'prep-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  prepWin.on('closed', () => {
    prepWin = null;
  });
  prepWin.loadFile(path.join(__dirname, 'prep.html'));
  return prepWin;
}

function prepLog(line) {
  if (prepWin && !prepWin.isDestroyed()) prepWin.webContents.send('prep:log', String(line));
}

function prepState(state) {
  if (prepWin && !prepWin.isDestroyed()) prepWin.webContents.send('prep:state', state);
}

async function runBlenderPrep() {
  if (prepRunning) return { ok: false, message: 'Preparation is already running' };
  prepRunning = true;
  prepCancelled = false;
  const log = (line) => prepLog(line);
  const registerChild = (child) => {
    prepChild = child;
  };
  const checkCancel = () => {
    if (prepCancelled) throw new Error('Preparation cancelled');
  };
  try {
    prepState({ phase: 'running', label: 'Finding Blender…' });
    const installs = await blenderprep.findBlenders(app.getPath('appData'), undefined, log);
    if (!installs.length) {
      log('No Blender installation found — checked the standard locations:');
      for (const r of blenderprep.defaultRoots()) log(`  ${r}`);
      log('…and Microsoft Store packages (Get-AppxPackage).');
      log('Install Blender 4.x from blender.org or the Microsoft Store, then re-run. (Portable installs in custom folders are not detected yet.)');
      prepState({ phase: 'error', label: 'Blender not found' });
      return { ok: false, message: 'Blender not found' };
    }
    const target = installs[0];
    if (installs.length > 1) log(`Found ${installs.length} Blender installs; using the newest.`);
    log(`Blender ${target.version} — ${target.dir}`);
    if (target.store) {
      log('Microsoft Store install: the package folder is protected, so pip will run through Blender itself.');
    }
    log(`Modules folder: ${target.modulesDir}`);
    checkCancel();

    if (blenderprep.torchInModules(target)) {
      log('torch is already in the modules folder — skipping the install.');
    } else {
      prepState({ phase: 'running', label: 'Installing CPU torch (~200 MB)…' });
      log("Installing CPU-only torch with Blender's own Python — a few minutes, mostly downloading…");
      await blenderprep.installTorch(target, { onLog: log, registerChild });
      checkCancel();
      if (!blenderprep.torchInModules(target)) {
        throw new Error('pip finished but torch is not in the modules folder');
      }
      log('torch installed.');
    }

    prepState({ phase: 'running', label: 'Verifying in Blender…' });
    const home = meshcoder.loadConfig().home || meshcoder.detect().home;
    log(
      home
        ? 'Launching Blender headless to import bpy_lib…'
        : 'Launching Blender headless to import torch (no MeshCoder clone found for the full bpy_lib check)…'
    );
    const verdict = await blenderprep.verifyBlender(target, home, { registerChild, onLog: log });
    if (!verdict.ok) {
      log('Blender output (tail):');
      for (const l of String(verdict.detail || '').split('\n')) if (l.trim()) log(l);
      throw new Error(
        `Verification failed — Blender could not import ${verdict.mode === 'bpy_lib' ? 'bpy_lib' : 'torch'}`
      );
    }
    log(
      verdict.mode === 'bpy_lib'
        ? 'Verified: Blender imported bpy_lib successfully.'
        : 'Verified: Blender imported torch successfully.'
    );
    log('Done. Restart Blender (if it is open), then run the generated script.');
    prepState({ phase: 'done', label: 'Blender is ready' });
    return { ok: true };
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    if (prepCancelled || /cancelled/i.test(msg)) {
      prepState({ phase: 'cancelled', label: 'Cancelled' });
      log('Cancelled.');
      return { ok: false, message: 'Preparation cancelled' };
    }
    log(`Failed: ${msg}`);
    prepState({ phase: 'error', label: 'Preparation failed' });
    return { ok: false, message: msg };
  } finally {
    prepRunning = false;
    prepChild = null;
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
        { label: 'Toggle Developer Tools', accelerator: 'F12', click: () => toggleDevTools() },
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
        { label: 'Set up MeshCoder automatically…', click: () => openSetupWindow() },
        { label: 'Prepare Blender for MeshCoder scripts…', click: () => openPrepWindow() },
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
  // Right-click menu on an asset row. No coordinates are passed: popup
  // without a position opens at the cursor, which is already on the row.
  ipcMain.handle('assets:contextMenu', (_e, id) => {
    const found = assets.find(String(id || ''));
    if (!found) return false;
    const items = [
      { label: 'Show in Explorer', click: () => shell.showItemInFolder(found.filePath) },
    ];
    // Generated Python gets an on-demand syntax check (Verify) — the
    // same parse that runs after a conversion, re-runnable after a
    // hand fix. The verdict lands on the sidebar status line.
    if (/\.py$/i.test(found.filePath || '')) {
      items.push({
        label: 'Verify',
        click: () => {
          verifyAssetFile(found.id).then((msg) => pushSidebarStatus(msg)).catch(() => {});
        },
      });
    }
    items.push(
      { type: 'separator' },
      { label: 'Delete file', click: () => deleteAssetFile(found.id) },
      {
        label: 'Remove from list',
        click: () => {
          assets.remove(found.id);
          thumbs.remove(found.id);
          notifySidebar();
        },
      }
    );
    const menu = Menu.buildFromTemplate(items);
    menu.popup({ window: mainWindow });
    return true;
  });
  ipcMain.handle('assets:verify', async (_e, id) => ({ message: await verifyAssetFile(id) }));
  ipcMain.handle('setup:start', (_e, token) => runSetup(String(token || '').trim()));
  ipcMain.handle('setup:cancel', () => {
    setupCancelled = true;
    if (setupChild && !setupChild.killed) setupChild.kill();
    if (setupCancelDownload) {
      try {
        setupCancelDownload();
      } catch {
        /* already settled */
      }
    }
    return true;
  });
  ipcMain.handle('prep:start', () => runBlenderPrep());
  ipcMain.handle('prep:cancel', () => {
    prepCancelled = true;
    if (prepChild && !prepChild.killed) prepChild.kill();
    return true;
  });
  ipcMain.handle('setup:openModelPage', () => {
    shell.openExternal('https://huggingface.co/InternRobotics/MeshCoder');
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
    if (converting) return { message: conversionStatusText() };
    if (!(await ensureMeshcoder(focusedWindow()))) {
      return { message: 'MeshCoder is not set up — see the dialog, or Tools → Detect MeshCoder automatically' };
    }
    converting = true;
    startConversionUi(asset.filePath);
    notifySidebar();
    try {
      // Write the generated script into the owning workspace folder.
      const owner = asset.workspaceId ? workspaces.find(asset.workspaceId) : null;
      const outDir = owner && owner.folder ? owner.folder : path.dirname(asset.filePath);
      const codePath = await meshcoder.convertToCode(asset.filePath, outDir, conversionProgressOpts());
      const mesh = assets.track(asset.filePath, 'model', owner ? owner.id : null);
      assets.linkCode(codePath, mesh.id);
      compounding.harvest(codePath, path.basename(asset.filePath));
      notifySidebar();
      new Notification({
        title: 'Hunyuan3D',
        body: `Blender code saved: ${path.basename(codePath)}`,
      }).show();
      const si = conversionUi.syntaxIssue;
      return {
        message: si
          ? `Saved ${path.basename(codePath)} — ⚠ syntax error at line ${si.line}: ${si.message} — Blender can't run it until that line is fixed${si.text ? `\n${si.text}` : ''}`
          : `Saved ${path.basename(codePath)}`,
      };
    } catch (err) {
      const detail = String(err && err.message ? err.message : err);
      const report = conversionFailureReport(err);
      new Notification({ title: 'Hunyuan3D', body: `MeshCoder failed: ${detail.slice(0, 120)}` }).show();
      return {
        message: `MeshCoder failed (${path.basename(asset.filePath)}) — click to copy the traceback\n${report.excerpt}${report.logPath ? `\nFull log: ${report.logPath}` : ''}`,
      };
    } finally {
      converting = false;
      stopConversionUi();
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
