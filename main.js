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
  webFrameMain,
  session,
  Menu,
  shell,
  clipboard,
  Notification,
  dialog,
  ipcMain,
  nativeImage,
} = require('electron');
const path = require('path');
const fs = require('fs');
const url = require('url');
const assets = require('./assets');
const thumbs = require('./thumbs');
const workspaces = require('./workspaces');
const updater = require('./updater');

const HOME_URL = 'https://3d.hunyuan.tencent.com/';
const MIXAMO_URL = 'https://www.mixamo.com/';
const POLYPIZZA_URL = 'https://poly.pizza/';
const APP_TITLE = 'Hunyuan3D';
// Chrome UA (the raw Electron UA makes many sites serve broken pages).
const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';

// Domains that belong to the login/app flow and should stay in-app.
const IN_APP_HOSTS = ['tencent.com', 'qq.com', 'weixin.qq.com', 'wechat.com', 'gtimg.com', 'qpic.cn'];
// Mixamo sign-in runs through Adobe ID — its hosts stay in-app too.
const MIXAMO_IN_APP_HOSTS = ['mixamo.com', 'adobe.com', 'adobelogin.com'];
const POLYPIZZA_IN_APP_HOSTS = ['poly.pizza'];

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

/* ------------------------------------------------------------------ */
/* Live conversion progress in the sidebar status bar. A dedicated    */
/* lightweight channel (not notifySidebar) so the 1-second elapsed    */
/* tick never triggers a full sidebar re-render. The full output is   */
/* kept in memory; on failure the real traceback is extracted for     */
/* the status line and the whole log is written to userData.          */
/* ------------------------------------------------------------------ */


function pushSidebarStatus(text) {
  if (sidebarView && !sidebarView.webContents.isDestroyed()) {
    sidebarView.webContents.send('sidebar:status', String(text));
  }
}

/** Main window + its views (sidebar + the two site tabs). */
let mainWindow = null;
let sidebarView = null;
let siteView = null;
let mixamoView = null;
let pizzaView = null;
let navView = null;
/** Which site tab fills the content area: 'hunyuan' | 'mixamo' | 'polypizza'. */
let activeSite = 'hunyuan';

/** The site view the nav bar currently drives (history + zoom). */
function activeView() {
  if (activeSite === 'mixamo' && mixamoView) return mixamoView;
  if (activeSite === 'polypizza' && pizzaView) return pizzaView;
  return siteView;
}

/** Switch the content area between the site tabs. */
function setActiveSite(name) {
  activeSite = name === 'mixamo' || name === 'polypizza' ? name : 'hunyuan';
  layoutViews();
  pushNavState();
}
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

function isInApp(url, hosts = IN_APP_HOSTS) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return hosts.some((d) => host === d || host.endsWith('.' + d));
  } catch {
    return false;
  }
}


/**
 * Scrollbar styling for two of the hosted tabs (Lan's picks; Poly Pizza
 * keeps stock bars):
 *  - Hunyuan3D: transparent track with a translucent thumb.
 *  - Mixamo: no bar at all — `display: none` on the pseudo-element.
 *    Scrolling still works with wheel / touch / keyboard.
 * insertCSS reaches only the main frame, so subframes receive the same
 * rules as a <style> element — Mixamo's scroller lives in a frame.
 */
const HUNYUAN_SCROLLBAR_CSS = `
  html { scrollbar-width: thin !important; scrollbar-color: rgba(125, 130, 145, .45) transparent !important; }
  ::-webkit-scrollbar { width: 10px !important; height: 10px !important; }
  ::-webkit-scrollbar-track { background: transparent !important; }
  ::-webkit-scrollbar-thumb { background: rgba(125, 130, 145, .45) !important; border: 3px solid transparent !important; background-clip: padding-box !important; border-radius: 6px !important; }
  ::-webkit-scrollbar-thumb:hover { background: rgba(125, 130, 145, .75) !important; background-clip: padding-box !important; }
  ::-webkit-scrollbar-corner { background: transparent !important; }
`;

const MIXAMO_SCROLLBAR_CSS = `
  * { scrollbar-width: none !important; scrollbar-color: transparent transparent !important; }
  ::-webkit-scrollbar { display: none !important; }
`;

function injectScrollbarStyle(contents, css = HUNYUAN_SCROLLBAR_CSS) {
  const apply = () => {
    contents.insertCSS(css).catch(() => {});
  };
  contents.on('dom-ready', apply);
  contents.on('did-finish-load', apply);
  contents.on('did-frame-finish-load', (_e, isMainFrame, processId, routingId) => {
    if (isMainFrame) return;
    let frame = null;
    try {
      frame = webFrameMain.fromId(processId, routingId);
    } catch {
      frame = null;
    }
    if (!frame) return;
    frame
      .executeJavaScript(
        `(() => {
          if (document.getElementById('__app_scrollbar_style')) return;
          const s = document.createElement('style');
          s.id = '__app_scrollbar_style';
          s.textContent = ${JSON.stringify(css)};
          (document.head || document.documentElement).appendChild(s);
        })()`
      )
      .catch(() => {});
  });
  // window.open children (login flows) get the same treatment.
  contents.on('did-create-window', (child) => injectScrollbarStyle(child.webContents, css));
}

function applyWindowOpenHandler(contents, hosts = IN_APP_HOSTS, css = null) {
  contents.setWindowOpenHandler(({ url }) => {
    if (isInApp(url, hosts)) {
      // A WebContentsView cannot open a child window directly — create it.
      // The child shares the SOURCE view's session, so a Mixamo popup
      // stays in the Adobe login session and a Hunyuan popup in Tencent's.
      if (contents.getType() === 'window') {
        return { action: 'allow', overrideBrowserWindowOptions: childWindowOptions(contents.session) };
      }
      const child = new BrowserWindow(childWindowOptions(contents.session));
      child.webContents.setUserAgent(CHROME_UA);
      child.loadURL(url);
      applyWindowOpenHandler(child.webContents, hosts, css);
      if (css) injectScrollbarStyle(child.webContents, css);
      return { action: 'deny' };
    }
    shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
}

function childWindowOptions(ses) {
  return {
    width: 1000,
    height: 760,
    title: APP_TITLE,
    webPreferences: {
      session: ses || session.fromPartition('persist:hunyuan3d'),
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
// Converted-code thumbnail failures are surfaced on the sidebar status
// line (once per file per session) instead of failing silently — the
// usual cause is a missing `npm install` for a dependency, which the
// user can only fix if the app says what is missing.
const thumbErrorSurfaced = new Set();
let codeDepChecked = false;
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
  // Images thumbnail themselves: decode + downscale with nativeImage
  // instead of the Three.js worker. The feature record is all-empty —
  // the corner markers describe 3D models, not pictures.
  if (assets.IMAGE_EXTS.includes(path.extname(asset.filePath).toLowerCase())) {
    try {
      const img = nativeImage.createFromPath(asset.filePath);
      if (img.isEmpty()) throw new Error('unreadable image');
      const size = img.getSize();
      const scale = Math.min(1, 144 / Math.max(size.width, size.height));
      const small = scale < 1
        ? img.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) })
        : img;
      fs.mkdirSync(thumbs.dir(), { recursive: true });
      fs.writeFileSync(thumbs.thumbPath(id), small.toPNG());
      thumbs.set(id, fs.statSync(asset.filePath).mtimeMs, { tex: false, clips: 0, rig: false, parts: 0 });
      notifySidebarSoon();
    } catch {
      if (fs.existsSync(asset.filePath)) {
        thumbs.markFailed(id, fs.statSync(asset.filePath).mtimeMs);
      }
    }
    return;
  }
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
      // What the worker saw in the model (textures / animation clips)
      // rides along with the thumbnail record for the sidebar badges.
      const info = await win.webContents.executeJavaScript('window.__thumbMeta || null').catch(() => null);
      const img = await win.webContents.capturePage();
      fs.mkdirSync(thumbs.dir(), { recursive: true });
      fs.writeFileSync(thumbs.thumbPath(id), img.toPNG());
      thumbs.set(id, fs.statSync(asset.filePath).mtimeMs, info);
      notifySidebarSoon();
    } else if (fs.existsSync(asset.filePath)) {
      // A failure caused by a missing dependency (the transpiler the
      // code viewer/thumbnail path needs, before `npm install` has run)
      // is an environment problem, not a bad file — don't pin it as
      // failed, or the thumbnail would never retry once fixed.
      const pageError = win.isDestroyed() ? null
        : await win.webContents.executeJavaScript('window.__thumbError || null').catch(() => null);
      const missingDep = /sucrase|esbuild|cannot find module|err_module/i.test(String(pageError || ''));
      if (!missingDep) {
        thumbs.markFailed(id, fs.statSync(asset.filePath).mtimeMs);
      }
      if (isConvertedCodeFile(asset.filePath) && !thumbErrorSurfaced.has(asset.id)) {
        thumbErrorSurfaced.add(asset.id);
        pushSidebarStatus(missingDep
          ? `Thumbnail for ${path.basename(asset.filePath)} needs a dependency: run npm install in the app folder, then restart`
          : `Thumbnail failed for ${path.basename(asset.filePath)}: ${pageError || 'timed out'}`);
      }
    }
  } finally {
    if (!win.isDestroyed()) win.close();
  }
}

/**
 * The 3D Format Guide (Help menu): a static beginner reference window
 * explaining what each download format (GLB/FBX/OBJ/STL/USDZ/MP4/GIF)
 * keeps and what it is for. Singleton — reopening focuses it.
 */
let formatsWin = null;
function openFormatsGuide() {
  if (formatsWin && !formatsWin.isDestroyed()) {
    formatsWin.show();
    formatsWin.focus();
    return formatsWin;
  }
  formatsWin = new BrowserWindow({
    width: 560,
    height: 700,
    minWidth: 420,
    minHeight: 480,
    title: '3D Format Guide',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  formatsWin.on('closed', () => { formatsWin = null; });
  void formatsWin.loadFile(path.join(__dirname, 'formats.html'));
  return formatsWin;
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
  // The viewer is a focused model window — no application menu bar
  // (the main window keeps the menu; its actions target the site tabs).
  win.removeMenu();
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
const downloadSessions = new Set();

/**
 * Downloads from a site session: auto-save into the active workspace
 * folder (or Downloads) with a de-duplicated filename, then register the
 * file as a managed asset. Shared by the Hunyuan3D and Mixamo tabs.
 */
function attachDownloadHandler(ses, label, fallbackName) {
  if (downloadSessions.has(ses)) return;
  downloadSessions.add(ses);
  ses.on('will-download', (_event, item) => {
    const ws = workspaces.active();
    const downloads = ws && ws.folder ? ws.folder : app.getPath('downloads');
    try {
      fs.mkdirSync(downloads, { recursive: true });
    } catch {
      /* fall through — item.setSavePath will surface the real error */
    }
    let target = path.join(downloads, item.getFilename() || fallbackName);
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
        new Notification({ title: label, body: `Saved: ${path.basename(target)}` }).show();
        void record;
      }
    });
  });
}

function createMainWindow() {
  const ses = session.fromPartition('persist:hunyuan3d');
  ses.setUserAgent(CHROME_UA);
  attachDownloadHandler(ses, 'Hunyuan3D', 'hunyuan3d-model.glb');
  const mixamoSes = session.fromPartition('persist:mixamo');
  mixamoSes.setUserAgent(CHROME_UA);
  attachDownloadHandler(mixamoSes, 'Mixamo', 'mixamo-model.fbx');
  const pizzaSes = session.fromPartition('persist:polypizza');
  pizzaSes.setUserAgent(CHROME_UA);
  attachDownloadHandler(pizzaSes, 'Poly Pizza', 'polypizza-model.glb');

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
  applyWindowOpenHandler(siteView.webContents, IN_APP_HOSTS, HUNYUAN_SCROLLBAR_CSS);
  injectScrollbarStyle(siteView.webContents, HUNYUAN_SCROLLBAR_CSS);
  attachWebContextMenu(siteView.webContents);
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

  // --- Mixamo tab -----------------------------------------------------
  // A second hosted site on its own persistent session (Adobe ID login
  // survives restarts, like the Hunyuan login does). Hidden until the
  // nav bar's Mixamo tab is picked; layoutViews owns visibility.
  mixamoView = new WebContentsView({
    webPreferences: {
      session: mixamoSes,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mixamoView.webContents.setUserAgent(CHROME_UA);
  mixamoView.webContents.loadURL(MIXAMO_URL);
  applyWindowOpenHandler(mixamoView.webContents, MIXAMO_IN_APP_HOSTS, MIXAMO_SCROLLBAR_CSS);
  injectScrollbarStyle(mixamoView.webContents, MIXAMO_SCROLLBAR_CSS);
  attachWebContextMenu(mixamoView.webContents);
  mixamoView.webContents.on('did-navigate', pushNavState);
  mixamoView.webContents.on('did-navigate-in-page', pushNavState);
  mixamoView.webContents.on('did-finish-load', () => {
    if (settings.zoomFactor && settings.zoomFactor !== 1) {
      try {
        mixamoView.webContents.setZoomFactor(settings.zoomFactor);
      } catch {
        /* view going away — ignore */
      }
    }
    pushNavState();
  });
  mixamoView.webContents.on('zoom-changed', pushNavState);
  mixamoView.setVisible(false);

  // --- Poly Pizza tab ---------------------------------------------------
  // Free premade low-poly models; downloads are direct .glb files, so
  // they flow through the same workspace tracking as the other tabs.
  pizzaView = new WebContentsView({
    webPreferences: {
      session: pizzaSes,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  pizzaView.webContents.setUserAgent(CHROME_UA);
  pizzaView.webContents.loadURL(POLYPIZZA_URL);
  applyWindowOpenHandler(pizzaView.webContents, POLYPIZZA_IN_APP_HOSTS);
  attachWebContextMenu(pizzaView.webContents);
  pizzaView.webContents.on('did-navigate', pushNavState);
  pizzaView.webContents.on('did-navigate-in-page', pushNavState);
  pizzaView.webContents.on('did-finish-load', () => {
    if (settings.zoomFactor && settings.zoomFactor !== 1) {
      try {
        pizzaView.webContents.setZoomFactor(settings.zoomFactor);
      } catch {
        /* view going away — ignore */
      }
    }
    pushNavState();
  });
  pizzaView.webContents.on('zoom-changed', pushNavState);
  pizzaView.setVisible(false);

  win.contentView.addChildView(navView);
  win.contentView.addChildView(sidebarView);
  win.contentView.addChildView(siteView);
  win.contentView.addChildView(mixamoView);
  win.contentView.addChildView(pizzaView);

  layoutViews();
  win.on('resize', layoutViews);
  win.on('maximize', layoutViews);
  win.on('unmaximize', layoutViews);

  win.on('closed', () => {
    mainWindow = null;
    navView = null;
    sidebarView = null;
    siteView = null;
    mixamoView = null;
    pizzaView = null;
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
  // The two site tabs share the content rect; only the active one shows.
  const content = { x: sidebarW, y: NAV_BAR_HEIGHT, width: Math.max(0, w - sidebarW), height: below };
  const active = activeView();
  for (const v of [siteView, mixamoView, pizzaView]) {
    if (!v) continue;
    const isActive = v === active;
    try {
      v.setVisible(isActive);
      if (isActive) v.setBounds(content);
    } catch {
      /* view going away — ignore */
    }
  }
  if (toastView) positionToast();
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
  if (!navView || navView.webContents.isDestroyed() || !activeView()) return;
  const zoom = currentZoom();
  navView.webContents.send('nav:state', {
    site: activeSite,
    canGoBack: navCan(activeView().webContents, 'back'),
    canGoForward: navCan(activeView().webContents, 'forward'),
    zoomPct: Math.round(zoom * 100),
    canZoomIn: zoom < ZOOM_STEPS[ZOOM_STEPS.length - 1] - 0.001,
    canZoomOut: zoom > ZOOM_STEPS[0] + 0.001,
  });
}

function currentZoom() {
  const view = activeView();
  if (!view) return 1;
  try {
    return view.webContents.getZoomFactor();
  } catch {
    return 1;
  }
}

/** Set the site zoom, remember it for next launch, refresh the nav bar. */
function applyZoom(factor) {
  const view = activeView();
  if (!view) return;
  const f = Math.min(ZOOM_STEPS[ZOOM_STEPS.length - 1], Math.max(ZOOM_STEPS[0], factor));
  try {
    view.webContents.setZoomFactor(f);
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
  // The contents that actually has keyboard focus — the active site tab,
  // the sidebar/nav UI, or a popup window — so Navigate actions and
  // Toggle DevTools apply to what the user is looking at, not always to
  // the Hunyuan3D view.
  try {
    const focused = webContents.getFocusedWebContents();
    if (focused && !focused.isDestroyed()) return focused;
  } catch {
    /* fall through to the fallbacks */
  }
  const w = BrowserWindow.getFocusedWindow();
  // A login popup has focus — act on that window instead of the site view.
  if (w && w !== mainWindow && w.webContents && !w.webContents.isDestroyed()) {
    return w.webContents;
  }
  const active = activeView();
  if (active && !active.webContents.isDestroyed()) return active.webContents;
  return w ? w.webContents : null;
}

/**
 * Toggle DevTools for the focused contents. Detached mode is explicit:
 * a view's DevTools window can otherwise open BEHIND the main window
 * (seen on the Mixamo / Poly Pizza tabs), so after opening, its window
 * is pulled to the front as soon as it exists.
 */
/** Open a contents' DevTools detached and pull its window to the front. */
function openDevToolsForward(wc) {
  if (!wc.isDevToolsOpened()) wc.openDevTools({ mode: 'detach' });
  let tries = 0;
  const pullForward = () => {
    tries += 1;
    try {
      const dt = wc.devToolsWebContents;
      const win = dt && !dt.isDestroyed() ? BrowserWindow.fromWebContents(dt) : null;
      if (win) {
        win.show();
        win.focus();
        return;
      }
    } catch {
      /* DevTools window not created yet */
    }
    if (tries < 10) setTimeout(pullForward, 120);
  };
  setTimeout(pullForward, 120);
}

function toggleFocusedDevTools() {
  const wc = focusedWebContents();
  if (!wc) return;
  if (wc.isDevToolsOpened()) {
    wc.closeDevTools();
    return;
  }
  openDevToolsForward(wc);
}

// --- Browser context menu for the site views -------------------------------
// Electron shows no right-click menu by default; this gives the hosted
// pages the menu a normal browser has: navigation, link/image actions,
// edit actions in fields, a page screenshot, and Inspect Element.
function buildWebContextMenu(contents, params) {
  const template = [];
  const sep = () => template.push({ type: 'separator' });
  if (params.linkURL) {
    template.push({
      label: 'Copy Link Address',
      click: () => clipboard.writeText(params.linkURL),
    });
    sep();
  }
  if (params.mediaType === 'image' && params.srcURL) {
    template.push(
      { label: 'Save Image As…', click: () => void saveImageAs(contents, params.srcURL) },
      { label: 'Copy Image', click: () => contents.copyImageAt(params.x, params.y) },
      { label: 'Copy Image Address', click: () => clipboard.writeText(params.srcURL) }
    );
    sep();
  }
  if (params.isEditable) {
    const flags = params.editFlags || {};
    template.push(
      { label: 'Undo', click: () => contents.undo(), enabled: !!flags.canUndo },
      { label: 'Redo', click: () => contents.redo(), enabled: !!flags.canRedo },
      { type: 'separator' },
      { label: 'Cut', click: () => contents.cut(), enabled: !!flags.canCut },
      { label: 'Copy', click: () => contents.copy(), enabled: !!flags.canCopy },
      { label: 'Paste', click: () => contents.paste(), enabled: !!flags.canPaste },
      { label: 'Select All', click: () => contents.selectAll() }
    );
    sep();
  } else if (params.selectionText && params.selectionText.trim()) {
    template.push({ label: 'Copy', click: () => contents.copy() });
    sep();
  }
  template.push(
    { label: 'Back', click: () => navGo(contents, 'back'), enabled: navCan(contents, 'back') },
    { label: 'Forward', click: () => navGo(contents, 'forward'), enabled: navCan(contents, 'forward') },
    { label: 'Reload', click: () => contents.reload() },
    { type: 'separator' },
    { label: 'Take Screenshot', click: () => void takeScreenshot(contents) },
    {
      label: 'Open Page in Default Browser',
      click: () => void shell.openExternal(contents.getURL()),
    },
    { type: 'separator' },
    {
      label: 'Inspect Element',
      click: () => {
        openDevToolsForward(contents);
        contents.inspectElement(params.x, params.y);
      },
    }
  );
  return template;
}

/** Screenshots and saved images land in the active workspace folder. */
function screenshotDir() {
  const ws = workspaces.active();
  return ws && ws.folder ? ws.folder : app.getPath('pictures');
}

/** Capture the visible page into the active workspace folder as a PNG. */
async function takeScreenshot(contents) {
  try {
    const img = await contents.capturePage();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    let host = 'page';
    try {
      host = new URL(contents.getURL()).hostname.replace(/^www\./, '') || 'page';
    } catch {
      /* keep the generic name */
    }
    const dir = screenshotDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `screenshot-${host}-${stamp}.png`);
    await fs.promises.writeFile(file, img.toPNG());
    void showToast(`Screenshot saved — ${path.basename(file)}`);
  } catch {
    void showToast('Screenshot failed — try again');
  }
}

/** Download an image through the page's own session (keeps its login). */
async function saveImageAs(contents, srcURL) {
  try {
    const res = await contents.session.fetch(srcURL);
    if (!res.ok) return;
    const buf = Buffer.from(await res.arrayBuffer());
    let name = 'image';
    try {
      name = decodeURIComponent(path.basename(new URL(srcURL).pathname)) || 'image';
    } catch {
      /* keep the generic name */
    }
    if (!path.extname(name)) name += '.png';
    const dir = screenshotDir();
    const win = BrowserWindow.fromWebContents(contents) || mainWindow;
    const picked = await dialog.showSaveDialog(win, { defaultPath: path.join(dir, name) });
    if (picked.canceled || !picked.filePath) return;
    await fs.promises.writeFile(picked.filePath, buf);
    void showToast(`Image saved — ${path.basename(picked.filePath)}`);
  } catch {
    /* offline / blocked image — leave the page as-is */
  }
}

const contextMenuAttached = new WeakSet();
function attachWebContextMenu(contents) {
  if (contextMenuAttached.has(contents)) return;
  contextMenuAttached.add(contents);
  contents.on('context-menu', (_e, params) => {
    Menu.buildFromTemplate(buildWebContextMenu(contents, params)).popup({
      window: BrowserWindow.fromWebContents(contents) || mainWindow,
    });
  });
  // Popup windows (login flows) get the same menu.
  contents.on('did-create-window', (child) => attachWebContextMenu(child.webContents));
}

// --- In-app toast ------------------------------------------------------------
// OS notifications are easy to miss (quiet hours, focus assist), so short
// confirmations like "Screenshot saved" also show as a toast pill at the
// bottom of the window. The toast is a transparent overlay view, visible
// only while a message is up.
let toastView = null;
let toastTimer = null;
let toastReady = null;

function toastHostWindow() {
  return mainWindow || BrowserWindow.getAllWindows()[0] || null;
}

function ensureToastView() {
  if (toastView && !toastView.webContents.isDestroyed()) return toastView;
  const win = toastHostWindow();
  if (!win) return null;
  toastView = new WebContentsView({
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  toastView.setBackgroundColor('#00000000');
  win.contentView.addChildView(toastView);
  toastView.setVisible(false);
  toastReady = new Promise((resolve) => {
    toastView.webContents.once('did-finish-load', resolve);
  });
  toastView.webContents.loadFile(path.join(__dirname, 'toast.html')).catch(() => {});
  positionToast();
  return toastView;
}

function positionToast() {
  const win = toastHostWindow();
  if (!toastView || !win) return;
  const { width: w, height: h } = win.getContentBounds();
  const width = Math.min(560, Math.max(0, w - 32));
  toastView.setBounds({
    x: Math.round((w - width) / 2),
    y: Math.max(0, h - 62),
    width,
    height: 44,
  });
}

async function showToast(message) {
  const view = ensureToastView();
  if (!view) return;
  positionToast();
  view.setVisible(true);
  try {
    await toastReady;
    await view.webContents.executeJavaScript(
      `window.showToast && window.showToast(${JSON.stringify(String(message))})`
    );
  } catch {
    /* toast page unavailable — the pill still appears on the next call */
  }
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    if (toastView) toastView.setVisible(false);
  }, 2800);
}

function toastViewState() {
  return { exists: !!toastView, visible: toastView ? toastView.getVisible() : false };
}

// --- Three.js code conversion (glb2ts) -------------------------------------
// Vendored from the glb2ts project: converts a model file into a
// self-contained TypeScript module that rebuilds it with Three.js at
// runtime — geometry, materials, node tree, and textures (embedded as
// data). Pure CPU, no setup; GLB/GLTF/OBJ/STL/PLY.
let glb2tsModule = null;
async function loadGlb2ts() {
  if (!glb2tsModule) {
    glb2tsModule = await import(url.pathToFileURL(path.join(__dirname, 'glb2ts.mjs')).href);
  }
  return glb2tsModule;
}

/**
 * Convert one model file to <name>.ts next to it — <name>.simple.ts when
 * opts.simplify keeps only a fraction of the triangles, <name>.small.ts
 * when opts.textureSize caps the embedded textures, <name>.smallest.ts
 * when both apply, <name>.tiny.ts when opts.jpegTextures re-encodes the
 * color textures as JPEG; returns a status message.
 */
async function convertFileToTs(filePath, opts = {}) {
  const name = path.basename(filePath);
  if (!fs.existsSync(filePath)) return `Convert to Three.js code: ${name} — file not found on disk`;
  try {
    const { convertToTs } = await loadGlb2ts();
    const convOpts = {};
    if (opts.simplify) convOpts.simplify = opts.simplify;
    if (opts.textureSize) convOpts.textureSize = opts.textureSize;
    if (opts.jpegTextures) convOpts.jpegTextures = true;
    const res = await convertToTs(filePath, convOpts);
    const suffix = opts.jpegTextures ? '.tiny.ts'
      : opts.simplify && opts.textureSize ? '.smallest.ts'
      : opts.simplify ? '.simple.ts' : opts.textureSize ? '.small.ts' : '.ts';
    const outPath = path.join(path.dirname(filePath), path.basename(filePath, path.extname(filePath)) + suffix);
    fs.writeFileSync(outPath, res.code);
    assets.track(outPath);
    notifySidebar();
    const s = res.stats;
    const texNote = s.textures ? `, ${s.textures} texture${s.textures === 1 ? '' : 's'} embedded` : '';
    const triNote = s.originalTriangles && s.originalTriangles !== s.triangles
      ? `, triangles ${s.originalTriangles} → ${s.triangles}` : '';
    const texSizeNote = s.textureResize && (s.textureResize.resized || s.textureResize.jpeg)
      ? `, textures ${(s.textureResize.beforeBytes / 1048576).toFixed(1)} MB → ${(s.textureResize.afterBytes / 1048576).toFixed(1)} MB${s.textureResize.cap ? ` (max ${s.textureResize.cap}px)` : ''}${s.textureResize.jpeg ? `, ${s.textureResize.jpeg} as JPEG` : ''}` : '';
    const warnNote = res.warnings.length ? ` — ${res.warnings.length} warning(s): ${res.warnings[0]}` : '';
    return `Saved ${path.basename(outPath)} — ${s.parts} part(s)${triNote}${texNote}${texSizeNote}${warnNote}`;
  } catch (err) {
    return `Convert to Three.js code failed (${name}): ${String(err && err.message ? err.message : err)}`;
  }
}

/** True for a code file produced by glb2ts (the sniff lives in assets.js). */
const isConvertedCodeFile = assets.isConvertedCode;

/**
 * Prepare a model for Mixamo's character upload: re-export its geometry
 * as <name>.mixamo.obj next to the source (Mixamo accepts OBJ uploads
 * and only needs the mesh — it adds its own skeleton and skinning). The
 * export runs in a hidden window using the viewer's loaders; the result
 * is tracked as an asset and revealed in Explorer so it can be dragged
 * straight into Mixamo's upload. Returns a status message.
 */
async function exportForMixamo(filePath) {
  const name = path.basename(filePath);
  if (!fs.existsSync(filePath)) return `Prepare for Mixamo: ${name} — file not found on disk`;
  const win = new BrowserWindow({
    show: false,
    width: 320,
    height: 240,
    webPreferences: {
      preload: path.join(__dirname, 'viewer-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  try {
    await win.loadFile(path.join(__dirname, 'mixamo-export.html'), { query: { file: filePath } });
    const deadline = Date.now() + 30000;
    let status = '';
    while (Date.now() < deadline) {
      status = await win.webContents.executeJavaScript('window.__exportStatus || ""').catch(() => '');
      if (status) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    if (status !== 'ok') {
      const err = await win.webContents.executeJavaScript('window.__exportError || null').catch(() => null);
      return `Prepare for Mixamo failed (${name}): ${err || 'timed out'}`;
    }
    const objText = await win.webContents.executeJavaScript('window.__exportObj');
    const outPath = path.join(path.dirname(filePath), path.basename(filePath, path.extname(filePath)) + '.mixamo.obj');
    fs.writeFileSync(outPath, objText);
    assets.track(outPath);
    notifySidebar();
    shell.showItemInFolder(outPath);
    return `Saved ${path.basename(outPath)} — upload it in the Mixamo tab (Upload Character)`;
  } catch (err) {
    return `Prepare for Mixamo failed (${name}): ${String(err && err.message ? err.message : err)}`;
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

async function prepareLastDownloadForMixamo() {
  if (!lastDownloadPath || !fs.existsSync(lastDownloadPath)) {
    pushSidebarStatus('Prepare for Mixamo: no download yet this session');
    return;
  }
  pushSidebarStatus(await exportForMixamo(lastDownloadPath));
}

async function convertLastDownloadToTs(mode) {
  const win = focusedWindow();
  if (!lastDownloadPath || !fs.existsSync(lastDownloadPath)) {
    await dialog.showMessageBox(win, {
      type: 'info',
      message: 'Nothing to convert yet',
      detail: 'Generate and download a model first — this converts the most recent download.',
    });
    return;
  }
  const opts = mode === 'simple' ? { simplify: 0.5 }
    : mode === 'small' ? { textureSize: 1024 }
    : mode === 'smallest' ? { simplify: 0.5, textureSize: 1024 }
    : mode === 'tiny' ? { simplify: 0.5, textureSize: 512, jpegTextures: true }
    : {};
  const msg = await convertFileToTs(lastDownloadPath, opts);
  pushSidebarStatus(msg);
  new Notification({ title: 'Hunyuan3D', body: msg }).show();
}

/** Ask for a workspace name, then create it (folder can be set later). */
async function createWorkspaceDialog() {
  const win = focusedWindow();
  const res = await dialog.showMessageBox(win, {
    type: 'info',
    message: 'New workspace',
    detail:
      'A workspace groups your models and owns a folder. New downloads and ' +
      'generated code files are saved into the active workspace folder.',
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

/**
 * Move an asset's file into a workspace folder (or Unassigned) — the
 * context menu's counterpart of the row button's Move popup. Same
 * semantics as the assets:assign IPC: the file physically moves,
 * membership follows it.
 */
function moveAssetTo(found, targetId, targetName) {
  try {
    assets.assign(found.id, targetId);
    pushSidebarStatus(`File moved to ${targetName}`);
  } catch (err) {
    pushSidebarStatus(err && err.message ? err.message : 'Move failed');
  }
  notifySidebar();
}

/**
 * Move an asset's file to the Recycle Bin (with confirmation) and drop its
 * row. A file already missing from disk just drops its row.
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
  const res = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Delete file', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message: `Delete ${path.basename(found.filePath)}?`,
    detail: 'The file will be moved to the Recycle Bin, and the asset will be removed from the list.',
  });
  if (res.response !== 0) return;
  try {
    await shell.trashItem(found.filePath);
    if (lastDownloadPath === found.filePath) lastDownloadPath = null;
    assets.remove(found.id);
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
        { label: 'Toggle DevTools', accelerator: 'Ctrl+Shift+I', click: () => toggleFocusedDevTools() },
        // A menu item takes only one accelerator, so this hidden twin gives
        // Toggle DevTools its second shortcut (F12) with no second visible entry.
        { label: 'Toggle DevTools', accelerator: 'F12', visible: false, acceleratorWorksWhenHidden: true, click: () => toggleFocusedDevTools() },
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
                ? `Added ${added.length} file(s) to ${ws ? ws.name : 'the asset manager'}`
                : 'No new files found',
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
                ? `Added ${added.length} file(s) to the asset manager`
                : 'No new files found in Downloads',
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
          label: 'Convert last download to Three.js code',
          submenu: [
            { label: 'Exact', click: () => convertLastDownloadToTs() },
            { label: 'Simplified (half the triangles)', click: () => convertLastDownloadToTs('simple') },
            { label: 'Small textures (1024px)', click: () => convertLastDownloadToTs('small') },
            { label: 'Smallest (half + 1024px)', click: () => convertLastDownloadToTs('smallest') },
            { label: 'Tiny (half + 512px + JPEG textures)', click: () => convertLastDownloadToTs('tiny') },
          ],
        },
        {
          label: 'Prepare last download for Mixamo upload',
          click: () => prepareLastDownloadForMixamo(),
        },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: '3D Format Guide…', click: () => openFormatsGuide() },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** IPC surface used by the sidebar and nav bar renderers. */
function registerIpc() {
  // Top navigation bar: back / forward / reload for the active site tab.
  ipcMain.on('nav:back', () => {
    const view = activeView();
    if (view) {
      navGo(view.webContents, 'back');
      pushNavState();
    }
  });
  ipcMain.on('nav:forward', () => {
    const view = activeView();
    if (view) {
      navGo(view.webContents, 'forward');
      pushNavState();
    }
  });
  ipcMain.on('nav:reload', () => {
    const view = activeView();
    if (view) view.webContents.reload();
  });
  ipcMain.on('nav:zoomIn', () => stepZoom(1));
  ipcMain.on('nav:zoomOut', () => stepZoom(-1));
  ipcMain.on('nav:zoomReset', () => applyZoom(1));
  ipcMain.on('nav:switchSite', (_e, name) => setActiveSite(name));

  ipcMain.handle('assets:list', (_e, workspaceId) => {
    const list = assets.list(workspaceId || null);
    // Mirror the assets:view routing so the sidebar can label its Open
    // button truthfully: models, converted code files, and images open
    // in the in-app viewer, everything else in the default app.
    for (const a of list) {
      const ext = path.extname(a.filePath || '').toLowerCase();
      a.image = assets.IMAGE_EXTS.includes(ext);
      a.viewer = a.kind === 'model' || assets.MODEL_EXTS.includes(ext) || isConvertedCodeFile(a.filePath) || a.image;
    }
    // One-time functional check, the first time converted code is on
    // screen: viewing/thumbnailing it needs the sucrase transpiler. If
    // it is missing (npm install not run since it was added), say so on
    // the status line immediately instead of letting thumbnails fail
    // silently one by one.
    if (!codeDepChecked && list.some((a) => a.viewer && isConvertedCodeFile(a.filePath))) {
      codeDepChecked = true;
      try {
        require('sucrase').transform('let x: number = 1;', { transforms: ['typescript'] });
      } catch {
        pushSidebarStatus('Code viewer/thumbnails need a dependency: run npm install in the app folder, then restart the app');
      }
    }
    for (const a of list) {
      // Thumbnails for everything the viewer can show: model files and
      // converted code files (flagged `viewer` just above).
      if (!a.viewer || !a.exists) continue;
      const meta = thumbs.get(a.id);
      const pngExists = fs.existsSync(thumbs.thumbPath(a.id));
      // Entries from an older renderer version count as stale even when
      // the file itself has not changed (see thumbs.RENDER_VERSION).
      const current = meta && meta.v === thumbs.RENDER_VERSION;
      const fresh = current && !meta.failed && meta.mtimeMs === a.updatedAt && pngExists;
      if (fresh) {
        a.thumb = url.pathToFileURL(thumbs.thumbPath(a.id)).href;
        // Recorded by the thumb worker at render time (RENDER_VERSION
        // 5+, rig/parts 6+): the sidebar badges read these.
        a.tex = !!meta.tex;
        a.clips = meta.clips || 0;
        a.rig = !!meta.rig;
        a.parts = meta.parts || 0;
      } else if (!current || !meta.failed || meta.mtimeMs !== a.updatedAt) {
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
    if (folder) {
      const added = assets.scanFolder(folder);
      notifySidebar();
      return added;
    }
    // No folder named: sweep Downloads plus every workspace folder —
    // converted code lands next to its model, which usually lives in a
    // workspace folder, not in Downloads.
    const folders = [app.getPath('downloads'), ...workspaces.list().map((w) => w.folder).filter(Boolean)];
    const added = [];
    for (const f of new Set(folders)) added.push(...assets.scanFolder(f));
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
    const items = [];
    const viewExt = path.extname(found.filePath || '').toLowerCase();
    // The row's three action buttons, mirrored in the menu: Open,
    // Move, Remove (Remove sits at the bottom, next to Delete file).
    // Open routes like the row button: the viewer for files that have
    // one, the machine's default app for everything else.
    const viewerEligible = found.kind === 'model' || assets.MODEL_EXTS.includes(viewExt) || isConvertedCodeFile(found.filePath) || assets.IMAGE_EXTS.includes(viewExt);
    if (viewerEligible) {
      items.push({ label: 'Open in viewer', click: () => openViewer(found.filePath) });
    } else {
      items.push({ label: 'Open', click: () => { shell.openPath(found.filePath).catch(() => {}); } });
    }
    // Move to workspace — same targets as the row button's popup,
    // current home checkmarked.
    const currentWs = (assets.findByPath(found.filePath) || {}).workspaceId || null;
    const moveItems = workspaces.list().map((w) => ({
      label: `${w.id === currentWs ? '✓ ' : ''}${w.name}`,
      click: () => moveAssetTo(found, w.id, w.name),
    }));
    moveItems.push({
      label: `${currentWs ? '' : '✓ '}Unassigned`,
      click: () => moveAssetTo(found, null, 'Unassigned'),
    });
    items.push({ label: 'Move to workspace', submenu: moveItems });
    items.push(
      { label: 'Show in Explorer', click: () => shell.showItemInFolder(found.filePath) },
    );
    // Models can also become runtime code: a self-contained .ts module
    // that rebuilds the model with Three.js (textures embedded). The
    // variants live in a submenu so the menu stays short.
    if (found.kind === 'model') {
      const convert = (opts) => () => {
        convertFileToTs(found.filePath, opts).then((msg) => pushSidebarStatus(msg)).catch(() => {});
      };
      items.push({
        label: 'Convert to Three.js code',
        submenu: [
          { label: 'Exact', click: convert({}) },
          { label: 'Simplified (half the triangles)', click: convert({ simplify: 0.5 }) },
          { label: 'Small textures (1024px)', click: convert({ textureSize: 1024 }) },
          { label: 'Smallest (half + 1024px)', click: convert({ simplify: 0.5, textureSize: 1024 }) },
          { label: 'Tiny (half + 512px + JPEG textures)', click: convert({ simplify: 0.5, textureSize: 512, jpegTextures: true }) },
        ],
      });
      items.push({
        label: 'Prepare for Mixamo upload',
        click: () => {
          exportForMixamo(found.filePath).then((msg) => pushSidebarStatus(msg)).catch(() => {});
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
    // Converted Three.js code constructs itself — the viewer can run it.
    if (isConvertedCodeFile(found.filePath)) {
      openViewer(found.filePath);
      return { ok: true };
    }
    // Images open in the viewer's image mode.
    if (assets.IMAGE_EXTS.includes(ext)) {
      openViewer(found.filePath);
      return { ok: true };
    }
    return shell.openPath(found.filePath).then(() => ({ ok: true })).catch(() => ({ ok: false, message: 'Cannot open this file' }));
  });
  // The viewer window's copy of a converted code file: the source, with
  // TypeScript transpiled to JS so the page can import it as a module and
  // call its create…() factory. The transpiler is sucrase — pure
  // JavaScript, no native binary and no install scripts (esbuild's
  // postinstall/binary was silently blocked by npm's allow-scripts on
  // at least one machine, which killed only the code thumbnails).
  ipcMain.handle('viewer:readModule', (_e, filePath) => {
    const p = String(filePath || '');
    const code = fs.readFileSync(p, 'utf8');
    if (!/\.ts$/i.test(p)) return code;
    return require('sucrase').transform(code, { transforms: ['typescript'] }).code;
  });
  // The viewer window's file bytes, as a clean ArrayBuffer (a Node Buffer
  // would arrive with a pooled backing store and a nonzero byteOffset).
  ipcMain.handle('viewer:readFile', (_e, filePath) => {
    const p = String(filePath || '');
    const buf = fs.readFileSync(p);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  });
  // Save a viewer screenshot PNG into the active workspace folder;
  // returns the file's basename for the viewer's toast.
  ipcMain.handle('viewer:saveScreenshot', (_e, data, baseName) => {
    const dir = screenshotDir();
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const safe =
      String(baseName || 'model').replace(/[\\/:*?"<>|]/g, '_').replace(/\.[^.]*$/, '') || 'model';
    let target = path.join(dir, `${safe}-view-${stamp}.png`);
    let n = 1;
    while (fs.existsSync(target)) {
      target = path.join(dir, `${safe}-view-${stamp} (${n}).png`);
      n += 1;
    }
    fs.writeFileSync(target, Buffer.from(data));
    return path.basename(target);
  });
  // Rename an asset's file in place, then refresh the sidebar.
  ipcMain.handle('assets:rename', (_e, id, newName) => {
    const res = assets.rename(String(id || ''), String(newName || ''));
    if (res.ok) notifySidebar();
    return res;
  });
  // Copy the sidebar status line to the clipboard (main process owns the
  // clipboard API; the renderer must not depend on navigator.clipboard).
  // Sidebar Update button: pull the latest app code (git pull when
  // the app folder is a checkout, else a file sync from GitHub main)
  // and restart when the updater says it is safe. H3D_UPDATE_BASE
  // overrides the download source (mirrors/tests).
  ipcMain.handle('app:updateRestart', async () => {
    const res = await updater.performUpdate(app.getAppPath(), { base: process.env.H3D_UPDATE_BASE || undefined });
    if (res.action === 'restart') {
      // Answer first so the sidebar can show the message, then go.
      setTimeout(() => { app.relaunch(); app.exit(0); }, 900);
    }
    return res;
  });
  // Read-only companion: is a newer version available? Drives the
  // Update button's visibility (hidden while the app is current).
  ipcMain.handle('app:checkUpdate', () => updater.checkForUpdate(app.getAppPath(), { base: process.env.H3D_UPDATE_BASE || undefined }));
  ipcMain.handle('sidebar:copy', (_e, text) => {
    clipboard.writeText(String(text || ''));
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

module.exports = { registerIpc, createMainWindow, buildMenu, isConvertedCodeFile, injectScrollbarStyle, MIXAMO_SCROLLBAR_CSS, toggleFocusedDevTools, buildWebContextMenu, showToast, toastViewState, openFormatsGuide, openViewer };

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
