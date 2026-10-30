/* Sidebar renderer logic — the "asset dashboard". */
// NOTE: do not name this `api` — contextBridge already defines a global
// `window.api`, and a top-level `const api` would collide with it.
const bridge = window.api;

const state = {
  assets: [],
  filter: '',
  kind: 'all',
  /** Feature filters from the + popup: show only models carrying the
   *  checked features (probed with their thumbnails). */
  features: { tex: false, rig: false, anim: false, parts: false },
  /** List layout: 'detail' rows (default) or 'grid' thumbnail tiles. */
  view: 'detail',
  workspaces: [],
  activeId: null,
  /** 'all' | 'unassigned' | <workspace id> */
  scope: 'all',
};

const $ = (id) => document.getElementById(id);

// Stroke icons for the per-asset action buttons (24x24, Lucide-style,
// drawn in the button's own color). SVG beats emoji here: consistent
// weight and size at 15px, no platform emoji style surprises.
function icon(paths) {
  return (
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    paths +
    '</svg>'
  );
}
// Thumbnail corner markers: one colored triangle per model feature,
// each pinned to a fixed corner so the model itself stays visible —
// top-left texture (amber), top-right multipart (violet), bottom-left
// rig (sky), bottom-right animation (green). The wrap's tooltip lists
// the features in words. Colors live in sidebar.css (.corner.tex etc).

const ICONS = {
  open:
    '<path d="M15 3h6v6"/><path d="M10 14 21 3"/>' +
    '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  move:
    '<path d="M5 9l-3 3 3 3"/><path d="M9 5l3-3 3 3"/><path d="M15 19l-3 3-3-3"/>' +
    '<path d="M19 9l3 3-3 3"/><path d="M2 12h20"/><path d="M12 2v20"/>',
  code:
    '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
  remove: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
};

function formatSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function setStatus(text) {
  // The visible line truncates with an ellipsis, so the tooltip carries
  // the whole message. (The transient 'Copied' flash writes textContent
  // directly and leaves the title on the real message.)
  $('status').textContent = text;
  $('status').title = text;
}

/**
 * Turn an asset's name into an inline editor (double-click to rename).
 * Edits the base name only — the extension stays, so the file keeps its
 * kind and a model's companion script keeps matching. Enter commits,
 * Escape cancels, blur commits if it hasn't already. The list refreshes
 * from the main process after a successful rename.
 */
function startRename(nameEl, asset) {
  if (nameEl.querySelector('input')) return;
  const input = document.createElement('input');
  input.className = 'rename-input';
  input.type = 'text';
  input.value = asset.name;
  input.setAttribute('aria-label', `Rename ${asset.name}`);
  nameEl.textContent = '';
  nameEl.appendChild(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (commit) => {
    if (done) return;
    done = true;
    const next = input.value.trim();
    nameEl.textContent = asset.name;
    if (!commit || !next || next === asset.name) return;
    if (typeof bridge.rename !== 'function') {
      setStatus('Rename unavailable — restart the app to load the new sidebar');
      return;
    }
    bridge.rename(asset.id, next).then((res) => {
      setStatus(res && res.ok ? 'Renamed' : (res && res.message) || 'Rename failed');
    }).catch((err) => {
      setStatus('Rename failed: ' + (err && err.message ? err.message : err));
    });
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') finish(false);
    e.stopPropagation();
  });
  input.addEventListener('blur', () => finish(true));
}

function visibleAssets() {
  const q = state.filter.trim().toLowerCase();
  return state.assets.filter((a) => {
    // The kind dropdown's 'Other' means "not a model" (converted code,
    // images, misc files) — it is a bucket, not the literal kind.
    if (state.kind === 'model' && a.kind !== 'model') return false;
    if (state.kind === 'other' && a.kind === 'model') return false;
    // Feature filters (the + popup): a checked feature must be present.
    // Assets whose features were never probed (no thumbnail yet) count
    // as not having it — they reappear once rendered, or when the
    // filter is unchecked.
    if (state.features.tex && !a.tex) return false;
    if (state.features.rig && !a.rig) return false;
    if (state.features.anim && !(a.clips > 0)) return false;
    if (state.features.parts && !(a.parts > 1)) return false;
    if (state.scope === 'unassigned' && a.workspaceId) return false;
    if (state.scope !== 'all' && state.scope !== 'unassigned' && a.workspaceId !== state.scope) {
      return false;
    }
    if (!q) return true;
    return (
      a.name.toLowerCase().includes(q) ||
      (a.fileName || '').toLowerCase().includes(q) ||
      (a.ext || '').toLowerCase().includes(q)
    );
  });
}

function workspaceName(id) {
  if (!id) return 'Unassigned';
  const ws = state.workspaces.find((w) => w.id === id);
  return ws ? ws.name : 'Unassigned';
}

/** Render the workspace switcher dropdown. */
function renderWorkspaces() {
  const sel = $('ws-select');
  sel.innerHTML = '';

  const opts = [
    { id: 'all', label: 'All workspaces' },
    ...state.workspaces.map((w) => ({ id: w.id, label: w.name })),
    { id: 'unassigned', label: 'Unassigned' },
  ];
  for (const o of opts) {
    const opt = document.createElement('option');
    opt.value = o.id;
    opt.textContent = o.label;
    if (o.id === state.scope) opt.selected = true;
    sel.appendChild(opt);
  }
}

function renderStats(stats) {
  // The counts are no longer an always-visible row (Lan's ask): they
  // ride as the tooltip on the Workspace label, and as a second line
  // on the workspace select's own tooltip.
  const counts = `${stats.total || 0} assets · ${stats.models || 0} models · ${stats.codes || 0} code · ${formatSize(stats.totalSize)} on disk`;
  $('ws-label').title = counts;
  $('ws-select').title = `Active workspace — new downloads save here\n${counts}`;
  $('subtitle').textContent = stats.lastAsset
    ? `Last: ${stats.lastAsset.name}`
    : 'Hunyuan3D';
}

function renderList() {
  const list = $('list');
  list.classList.toggle('grid', state.view === 'grid');
  const items = visibleAssets();
  list.innerHTML = '';

  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = state.assets.length
      ? 'No assets match this filter.'
      : 'No assets yet.\nDownload a model or hit “Scan”.';
    list.appendChild(empty);
    return;
  }

  for (const a of items) {
    const el = document.createElement('div');
    el.className = 'item' + (a.exists ? '' : ' missing');
    el.title = a.filePath;
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (typeof bridge.assetMenu !== 'function') {
        setStatus('Context menu unavailable — restart the app to load the new sidebar');
        return;
      }
      bridge.assetMenu(a.id);
    });

    const top = document.createElement('div');
    top.className = 'item-top';
    const badge = document.createElement('span');
    badge.className = `badge ${a.kind}`;
    badge.textContent = a.ext.replace('.', '') || 'file';
    const name = document.createElement('span');
    name.className = 'item-name';
    name.textContent = a.name;
    name.title = 'Double-click to rename this file';
    name.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      startRename(name, a);
    });
    top.append(badge, name);

    const meta = document.createElement('div');
    meta.className = 'item-meta';
    const size = document.createElement('span');
    size.textContent = formatSize(a.size);
    const date = document.createElement('span');
    date.textContent = formatDate(a.updatedAt);
    meta.append(size, date);
    const wsTag = document.createElement('span');
    wsTag.className = 'ws-tag';
    wsTag.textContent = workspaceName(a.workspaceId);
    meta.append(wsTag);
    if (!a.exists) {
      const gone = document.createElement('span');
      gone.textContent = 'missing';
      meta.append(gone);
    }

    const actions = document.createElement('div');
    actions.className = 'item-actions';

    // Move this asset to another workspace — an icon button that opens a
    // small menu (a <select> can't show an SVG as its collapsed label).
    const move = document.createElement('button');
    move.className = 'btn icon-btn move-btn';
    move.innerHTML = icon(ICONS.move);
    move.title = 'Move this file into another workspace folder (Unassigned = Documents\\Hunyuan3D\\Unassigned)';
    move.addEventListener('click', (e) => {
      e.stopPropagation();
      openMoveMenu(move, a);
    });

    const open = document.createElement('button');
    open.className = 'btn icon-btn';
    open.innerHTML = icon(ICONS.open);
    // The main process marks each asset with `viewer` when opening it
    // routes to the in-app viewer (models, and converted code files whose
    // header it checked). Fall back to the extension rule when the flag
    // is absent (an older main process).
    const isModel = typeof a.viewer === 'boolean' ? a.viewer
      : a.kind === 'model' || /\.(glb|gltf|obj|fbx|stl|ply)$/i.test(a.filePath || '');
    open.title = isModel ? 'View in the in-app 3D viewer' : 'Open this file with its default app';
    open.addEventListener('click', (e) => {
      e.stopPropagation();
      // Report synchronously, before any IPC: if even this never shows,
      // the click is not reaching this listener at all (stale renderer,
      // frozen sidebar), which is a different problem from the viewer.
      setStatus(isModel ? 'Opening viewer…' : 'Opening…');
      if (typeof bridge.view !== 'function') {
        setStatus('Viewer unavailable — restart the app to load the new sidebar');
        return;
      }
      bridge.view(a.id).then((res) => {
        if (!res) setStatus('Viewer: no response');
        else if (res.ok === false) setStatus(res.message || 'Cannot open this file');
        else setStatus('Opened');
      }).catch((err) => {
        // e.g. running an older build with no 'assets:view' handler — say
        // so instead of silently doing nothing.
        setStatus('Viewer failed: ' + (err && err.message ? err.message : err));
      });
    });
    actions.append(open, move);

    const del = document.createElement('button');
    del.className = 'btn icon-btn';
    del.innerHTML = icon(ICONS.remove);
    del.title = 'Stop tracking this asset — the file itself is NOT deleted';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      bridge.remove(a.id).then(() => refresh());
    });
    actions.append(del);

    const body = document.createElement('div');
    body.className = 'item-body';
    body.append(top, meta, actions);
    if (a.viewer) {
      // Rendered preview when cached, else a small placeholder tile with
      // the extension while the background worker renders it. Covers
      // models and converted code files (.ts/.js/.mjs from glb2ts),
      // which the main process flags `viewer` in assets:list.
      let thumb;
      if (a.thumb) {
        thumb = document.createElement('img');
        thumb.className = 'thumb';
        thumb.src = a.thumb;
        thumb.alt = '';
        // Corner markers for what the model carries, probed by the
        // thumb worker when it rendered: TL texture, TR multipart,
        // BL rig, BR animation. The thumbnail's tooltip carries the
        // full file path plus every feature in words (or the plain
        // summary when it has none).
        const corners = [];
        const words = [];
        if (a.tex) { corners.push(['tl', 'tex']); words.push('Textured'); }
        if (a.parts > 1) { corners.push(['tr', 'parts']); words.push(`Multipart (${a.parts} parts)`); }
        if (a.rig) { corners.push(['bl', 'rig']); words.push('Rigged'); }
        if (a.clips > 0) { corners.push(['br', 'anim']); words.push(a.clips === 1 ? 'Animation (1 clip)' : `Animation (${a.clips} clips)`); }
        // Images carry no model features — the tooltip is just the path.
        const tip = a.image
          ? a.filePath
          : `${a.filePath}\n${words.length ? words.join(' · ') : 'Single mesh — no textures, rig, or animation'}`;
        if (corners.length) {
          const wrap = document.createElement('div');
          wrap.className = 'thumb-wrap';
          wrap.title = tip;
          const layer = document.createElement('div');
          layer.className = 'thumb-corners';
          for (const [pos, kind] of corners) {
            const c = document.createElement('span');
            c.className = `corner ${pos} ${kind}`;
            layer.appendChild(c);
          }
          wrap.append(thumb, layer);
          thumb = wrap;
        } else {
          thumb.title = tip;
        }
      } else {
        thumb = document.createElement('div');
        thumb.className = 'thumb placeholder';
        thumb.textContent = (a.ext || 'file').replace('.', '');
        // No thumbnail yet, so no probed features — the path still helps.
        thumb.title = a.filePath;
      }
      el.append(thumb, body);
    } else if (state.view === 'grid') {
      // Grid tiles need a visual block even for files the viewer never
      // renders (misc 'other' files) — a placeholder tile, ext label.
      const ph = document.createElement('div');
      ph.className = 'thumb placeholder';
      ph.textContent = (a.ext || 'file').replace('.', '');
      ph.title = a.filePath;
      el.append(ph, body);
    } else {
      el.append(body);
    }
    list.appendChild(el);
  }
}

// ---- "Move to" popup menu (one open at a time) ----
let moveMenuEl = null;

function closeMoveMenu() {
  if (moveMenuEl) {
    moveMenuEl.remove();
    moveMenuEl = null;
  }
}

function openMoveMenu(anchor, asset) {
  closeMoveMenu();
  const menu = document.createElement('div');
  menu.className = 'move-menu';
  const add = (label, target) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', () => {
      closeMoveMenu();
      bridge.assign(asset.id, target).then((res) => {
        if (res && res.ok === false) {
          setStatus(res.message || 'Move failed');
        } else {
          setStatus(`File moved to ${target ? workspaceName(target) : 'Unassigned'}`);
        }
        refresh();
      });
    });
    menu.appendChild(b);
  };
  for (const w of state.workspaces) {
    add((w.id === asset.workspaceId ? '✓ ' : '') + w.name, w.id);
  }
  add(asset.workspaceId ? 'Unassigned' : '✓ Unassigned', null);
  document.body.appendChild(menu);
  // Sit under the button; flip above it if the viewport runs out.
  const r = anchor.getBoundingClientRect();
  let top = r.bottom + 4;
  if (top + menu.offsetHeight > window.innerHeight) {
    top = Math.max(4, r.top - menu.offsetHeight - 4);
  }
  menu.style.left = Math.max(8, Math.min(window.innerWidth - menu.offsetWidth - 8, r.left)) + 'px';
  menu.style.top = top + 'px';
  moveMenuEl = menu;
}

// Clicking anywhere outside the menu (or its button) dismisses it.
document.addEventListener('click', (e) => {
  if (moveMenuEl && !moveMenuEl.contains(e.target) && !e.target.closest('.move-btn')) {
    closeMoveMenu();
  }
});

// ---- Feature filter popup (the + button next to the search box) ----
// Checkmarks toggle the state.features flags; the list re-filters on
// every toggle and the popup stays open so combos are one click apart.
let featureMenuEl = null;
const FEATURE_FILTERS = [
  ['tex', 'Texture'],
  ['rig', 'Rig'],
  ['anim', 'Animation'],
  ['parts', 'Multipart'],
];

function closeFeatureMenu() {
  if (featureMenuEl) {
    featureMenuEl.remove();
    featureMenuEl = null;
  }
}

function syncFeatureBtn() {
  const on = FEATURE_FILTERS.filter(([k]) => state.features[k]).map(([, label]) => label);
  const btn = $('feature-btn');
  btn.classList.toggle('active', on.length > 0);
  btn.title = on.length
    ? `Feature filters on: ${on.join(', ')} — click to change`
    : 'Filter by model features (texture, rig, animation, multipart)';
}

function openFeatureMenu() {
  if (featureMenuEl) {
    closeFeatureMenu();
    return;
  }
  closeMoveMenu();
  const menu = document.createElement('div');
  menu.className = 'move-menu feature-menu';
  const head = document.createElement('div');
  head.className = 'menu-head';
  head.textContent = 'Show only models with:';
  menu.appendChild(head);
  for (const [key, label] of FEATURE_FILTERS) {
    const b = document.createElement('button');
    const check = document.createElement('span');
    check.className = 'check';
    check.textContent = state.features[key] ? '✓' : '';
    b.append(check, label);
    b.addEventListener('click', () => {
      state.features[key] = !state.features[key];
      check.textContent = state.features[key] ? '✓' : '';
      syncFeatureBtn();
      renderList();
    });
    menu.appendChild(b);
  }
  document.body.appendChild(menu);
  const anchor = $('feature-btn');
  const r = anchor.getBoundingClientRect();
  let top = r.bottom + 4;
  if (top + menu.offsetHeight > window.innerHeight) {
    top = Math.max(4, r.top - menu.offsetHeight - 4);
  }
  menu.style.left = Math.max(8, Math.min(window.innerWidth - menu.offsetWidth - 8, r.left)) + 'px';
  menu.style.top = top + 'px';
  featureMenuEl = menu;
}

document.addEventListener('click', (e) => {
  if (featureMenuEl && !featureMenuEl.contains(e.target) && e.target.id !== 'feature-btn') {
    closeFeatureMenu();
  }
});

async function refresh() {
  closeMoveMenu();
  closeFeatureMenu();
  const [wsData, assets] = await Promise.all([bridge.workspaces(), bridge.list()]);
  state.workspaces = wsData.workspaces || [];
  state.activeId = wsData.activeId || null;
  state.assets = assets;
  renderWorkspaces();
  // Stats follow the current scope ('all' means no filter).
  const scope = state.scope === 'all' ? null : state.scope;
  renderStats(await bridge.stats(scope));
  renderList();
  checkUpdate();
}

// ---- update availability ----
// Refresh also checks whether a newer app version exists on GitHub
// (Lan's ask). The check is network work and refresh() fires after
// every action, so it is throttled to once a minute and never blocks
// the refresh. The Update button hides while the app is current and
// reappears when an update lands; a failed check (offline, git
// trouble) leaves the button exactly as it was.
let updateCheckAt = 0;
let updateChecking = false;
async function checkUpdate() {
  if (typeof bridge.checkUpdate !== 'function' || updateChecking) return;
  const now = Date.now();
  if (now - updateCheckAt < 60000) return;
  updateChecking = true;
  updateCheckAt = now;
  try {
    const res = await bridge.checkUpdate();
    if (res && !res.error) {
      const btn = $('update');
      btn.hidden = !res.available;
      btn.title = res.available
        ? `${res.changed.length} file(s) changed on GitHub — pull them and restart`
        : 'Pull the latest app version from GitHub and restart';
    }
  } catch { /* leave the button as it was */ }
  updateChecking = false;
}

/** On a fresh store, pull in whatever models already sit in Downloads. */
async function bootstrapScan() {
  const stats = await bridge.stats();
  if (stats.total > 0) return;
  const added = await bridge.scan();
  if (added.length) {
    await refresh();
    setStatus(`Imported ${added.length} file(s) from Downloads`);
  }
}

// ---- workspace editor modal ----
let editingId = null;

function openModal(id) {
  editingId = id || null;
  const ws = id ? state.workspaces.find((w) => w.id === id) : null;
  $('ws-modal-title').textContent = ws ? 'Edit workspace' : 'New workspace';
  $('ws-name').value = ws ? ws.name : '';
  $('ws-folder').value = ws ? ws.folder : '';
  $('ws-notes').value = ws ? ws.notes : '';
  $('ws-delete').style.display = ws && state.workspaces.length > 1 ? '' : 'none';
  $('ws-modal').hidden = false;
  $('ws-name').focus();
}

function closeModal() {
  $('ws-modal').hidden = true;
  editingId = null;
}

$('ws-add').addEventListener('click', () => openModal(null));

$('ws-menu-btn').addEventListener('click', () => {
  // The menu button edits the *active* workspace, or the scoped one.
  const target = state.scope !== 'all' && state.scope !== 'unassigned'
    ? state.scope
    : state.activeId;
  openModal(target || (state.workspaces[0] && state.workspaces[0].id));
});

$('ws-cancel').addEventListener('click', closeModal);

$('ws-browse').addEventListener('click', async () => {
  const res = await bridge.pickWorkspaceFolder(editingId || '');
  if (res) $('ws-folder').value = res.folder || '';
});

$('ws-save').addEventListener('click', async () => {
  const name = $('ws-name').value.trim() || 'Untitled workspace';
  const folder = $('ws-folder').value.trim();
  const notes = $('ws-notes').value;
  if (editingId) {
    await bridge.updateWorkspace(editingId, { name, folder, notes });
  } else {
    const created = await bridge.createWorkspace({ name, folder, notes });
    if (created) await bridge.setActiveWorkspace(created.id);
  }
  closeModal();
  await refresh();
  setStatus('Workspace saved');
});

$('ws-delete').addEventListener('click', async () => {
  if (!editingId) return;
  await bridge.removeWorkspace(editingId);
  closeModal();
  await refresh();
  setStatus('Workspace deleted');
});

$('ws-select').addEventListener('change', (e) => {
  state.scope = e.target.value;
  refresh().then(() => {
    setStatus(`Showing ${e.target.selectedOptions[0].textContent}`);
  });
});

// ---- events ----
function syncViewToggle() {
  const grid = state.view === 'grid';
  const btn = $('view-toggle');
  btn.textContent = grid ? '☰' : '▦';
  btn.title = grid ? 'Switch to detailed view' : 'Switch to thumbnail view';
  btn.classList.toggle('active', grid);
}

$('view-toggle').addEventListener('click', () => {
  state.view = state.view === 'grid' ? 'detail' : 'grid';
  syncViewToggle();
  renderList();
});
syncViewToggle();

$('search').addEventListener('input', (e) => {
  state.filter = e.target.value;
  renderList();
});

$('kind').addEventListener('change', (e) => {
  state.kind = e.target.value;
  renderList();
});

$('feature-btn').addEventListener('click', () => {
  openFeatureMenu();
});

$('refresh').addEventListener('click', () => {
  refresh();
  setStatus('Refreshed');
});

$('update').addEventListener('click', async () => {
  if (typeof bridge.updateApp !== 'function') {
    setStatus('Update unavailable — restart the app to load the new sidebar');
    return;
  }
  const btn = $('update');
  btn.disabled = true;
  setStatus('Checking for updates…');
  try {
    const res = await bridge.updateApp();
    setStatus(res && res.message ? res.message : 'Update failed');
  } catch {
    setStatus('Update failed — check your connection and try again');
  } finally {
    btn.disabled = false;
  }
});

// Clicking the status line copies its message (e.g. an error to paste
// into a bug report). 'Copied' shows briefly, then the message returns.
$('status').addEventListener('click', () => {
  const el = $('status');
  const text = el.textContent || '';
  if (!text || text === 'Copied') return;
  if (typeof bridge.copy !== 'function') {
    el.textContent = 'Copy unavailable — restart the app to load the new sidebar';
    return;
  }
  bridge.copy(text).then(() => {
    el.textContent = 'Copied';
    setTimeout(() => { if (el.textContent === 'Copied') el.textContent = text; }, 1200);
  });
});

$('scan').addEventListener('click', async () => {
  const added = await bridge.scan();
  await refresh();
  setStatus(added.length ? `Added ${added.length} asset(s)` : 'No new files found');
});

$('collapse').addEventListener('click', () => bridge.toggle());
$('expand').addEventListener('click', () => bridge.toggle());

// --- collapsed state comes from the main process ---
function setCollapsed(collapsed) {
  document.body.classList.toggle('collapsed', Boolean(collapsed));
}
bridge.onVisibility((visible) => setCollapsed(!visible));
bridge.isVisible().then((visible) => setCollapsed(!visible));

// --- drag-to-resize on the right edge ---
const grip = $('grip');
let dragging = false;

grip.addEventListener('mousedown', (e) => {
  dragging = true;
  e.preventDefault();
});
window.addEventListener('mousemove', (e) => {
  if (!dragging) return;
  bridge.setWidth(e.clientX);
});
window.addEventListener('mouseup', () => {
  dragging = false;
});

bridge.onUpdate(() => refresh());

// Live progress (conversion phases + elapsed time) pushed by main.
if (typeof bridge.onStatus === 'function') {
  bridge.onStatus((text) => setStatus(text));
}

window.addEventListener('error', (e) => console.error('sidebar error:', e.message));

refresh().catch((e) => {
  console.error('refresh failed', e);
  setStatus('Failed to load assets');
});
bootstrapScan().catch((e) => console.error('bootstrap scan failed', e));
setStatus('Ready');
