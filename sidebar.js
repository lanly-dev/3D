/* Sidebar renderer logic — the "asset dashboard". */
// NOTE: do not name this `api` — contextBridge already defines a global
// `window.api`, and a top-level `const api` would collide with it.
const bridge = window.api;

const state = {
  assets: [],
  filter: '',
  kind: 'all',
  workspaces: [],
  activeId: null,
  /** 'all' | 'unassigned' | <workspace id> */
  scope: 'all',
};

const $ = (id) => document.getElementById(id);

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
  $('status').textContent = text;
}

function visibleAssets() {
  const q = state.filter.trim().toLowerCase();
  return state.assets.filter((a) => {
    if (state.kind !== 'all' && a.kind !== state.kind) return false;
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
  $('stat-total').textContent = stats.total;
  $('stat-models').textContent = stats.models;
  $('stat-codes').textContent = stats.codes;
  $('stat-size').textContent = formatSize(stats.totalSize);
  $('subtitle').textContent = stats.lastAsset
    ? `Last: ${stats.lastAsset.name}`
    : 'Hunyuan3D';
}

function renderList() {
  const list = $('list');
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

    const top = document.createElement('div');
    top.className = 'item-top';
    const badge = document.createElement('span');
    badge.className = `badge ${a.kind}`;
    badge.textContent = a.kind === 'blender-code' ? 'py' : a.ext.replace('.', '') || 'file';
    const name = document.createElement('span');
    name.className = 'item-name';
    name.textContent = a.name;
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

    // Move this asset to another workspace.
    const assign = document.createElement('select');
    assign.className = 'assign';
    assign.title = 'Move to workspace';
    const blank = document.createElement('option');
    blank.value = '';
    blank.textContent = 'Move to…';
    blank.selected = true;
    assign.appendChild(blank);
    for (const w of state.workspaces) {
      const opt = document.createElement('option');
      opt.value = w.id;
      opt.textContent = w.name;
      assign.appendChild(opt);
    }
    const noneOpt = document.createElement('option');
    noneOpt.value = '__none__';
    noneOpt.textContent = 'Unassigned';
    assign.appendChild(noneOpt);
    assign.addEventListener('change', (e) => {
      e.stopPropagation();
      const v = e.target.value;
      if (!v) return;
      const target = v === '__none__' ? null : v;
      bridge.assign(a.id, target).then(() => {
        setStatus(`Moved to ${target ? workspaceName(target) : 'Unassigned'}`);
        refresh();
      });
    });

    const reveal = document.createElement('button');
    reveal.className = 'btn';
    reveal.textContent = 'Reveal';
    reveal.addEventListener('click', (e) => {
      e.stopPropagation();
      bridge.reveal(a.filePath).then((ok) => setStatus(ok ? 'Revealed' : 'File not found'));
    });
    const open = document.createElement('button');
    open.className = 'btn';
    open.textContent = 'Open';
    open.addEventListener('click', (e) => {
      e.stopPropagation();
      bridge.open(a.filePath).then((ok) => setStatus(ok ? 'Opened' : 'Cannot open this file'));
    });
    actions.append(reveal, open, assign);

    if (a.kind === 'model') {
      const conv = document.createElement('button');
      conv.className = 'btn';
      conv.textContent = 'To Blender';
      conv.addEventListener('click', (e) => {
        e.stopPropagation();
        bridge.convert(a.id).then((res) => setStatus(res.message || 'Done'));
      });
      actions.append(conv);
    }

    const del = document.createElement('button');
    del.className = 'btn';
    del.textContent = 'Untrack';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      bridge.remove(a.id).then(() => refresh());
    });
    actions.append(del);

    el.append(top, meta, actions);
    list.appendChild(el);
  }
}

async function refresh() {
  const [wsData, assets] = await Promise.all([bridge.workspaces(), bridge.list()]);
  state.workspaces = wsData.workspaces || [];
  state.activeId = wsData.activeId || null;
  state.assets = assets;
  renderWorkspaces();
  // Stats follow the current scope ('all' means no filter).
  const scope = state.scope === 'all' ? null : state.scope;
  renderStats(await bridge.stats(scope));
  renderList();
}

/** On a fresh store, pull in whatever models already sit in Downloads. */
async function bootstrapScan() {
  const stats = await bridge.stats();
  if (stats.total > 0) return;
  const added = await bridge.scan();
  if (added.length) {
    await refresh();
    setStatus(`Imported ${added.length} model(s) from Downloads`);
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
$('search').addEventListener('input', (e) => {
  state.filter = e.target.value;
  renderList();
});

$('kind').addEventListener('change', (e) => {
  state.kind = e.target.value;
  renderList();
});

$('refresh').addEventListener('click', () => {
  refresh();
  setStatus('Refreshed');
});

$('scan').addEventListener('click', async () => {
  const added = await bridge.scan();
  await refresh();
  setStatus(added.length ? `Added ${added.length} asset(s)` : 'No new models found');
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

window.addEventListener('error', (e) => console.error('sidebar error:', e.message));

refresh().catch((e) => {
  console.error('refresh failed', e);
  setStatus('Failed to load assets');
});
bootstrapScan().catch((e) => console.error('bootstrap scan failed', e));
setStatus('Ready');
