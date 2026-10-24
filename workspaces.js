/**
 * Workspace registry (main process).
 *
 * A workspace is a named project that owns a folder: downloads land in
 * the active workspace's folder, and MeshCoder output is written there
 * too. An asset belongs to a workspace purely because its file sits in
 * that folder — moving the file is how an asset changes workspace.
 *
 * Storage: <userData>/workspaces.json
 *   {
 *     version: 1,
 *     workspaces: [{ id, name, folder, notes, createdAt, updatedAt }],
 *     activeId: string | null
 *   }
 */
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function storePath() {
  return path.join(app.getPath('userData'), 'workspaces.json');
}

function read() {
  try {
    const raw = JSON.parse(fs.readFileSync(storePath(), 'utf8'));
    return {
      workspaces: Array.isArray(raw.workspaces) ? raw.workspaces : [],
      activeId: raw.activeId || null,
    };
  } catch {
    return { workspaces: [], activeId: null };
  }
}

function write(state) {
  const file = storePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, ...state }, null, 2));
}

function list() {
  return read().workspaces;
}

/** The workspace new downloads/outputs go into. */
function active() {
  const state = read();
  return state.workspaces.find((w) => w.id === state.activeId) || null;
}

function find(id) {
  return list().find((w) => w.id === id) || null;
}

/** The workspace that owns a given folder (if any). */
function byFolder(folder) {
  if (!folder) return null;
  const abs = path.resolve(folder).toLowerCase();
  return (
    list().find((w) => w.folder && path.resolve(w.folder).toLowerCase() === abs) || null
  );
}

function create({ name, folder, notes }) {
  const state = read();
  const trimmed = String(name || '').trim() || 'Untitled workspace';
  const record = {
    id: crypto.randomUUID(),
    name: trimmed,
    folder: folder ? path.resolve(folder) : '',
    notes: String(notes || ''),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  state.workspaces.push(record);
  if (!state.activeId) state.activeId = record.id;
  write(state);
  ensureFolder(record);
  return record;
}

function update(id, patch) {
  const state = read();
  let updated = null;
  state.workspaces = state.workspaces.map((w) => {
    if (w.id !== id) return w;
    updated = {
      ...w,
      name: patch.name !== undefined ? String(patch.name).trim() || w.name : w.name,
      folder: patch.folder !== undefined ? (patch.folder ? path.resolve(patch.folder) : '') : w.folder,
      notes: patch.notes !== undefined ? String(patch.notes) : w.notes,
      updatedAt: Date.now(),
    };
    return updated;
  });
  write(state);
  if (updated) ensureFolder(updated);
  return updated;
}

/** Delete a workspace. Assets keep existing but become unassigned. */
function remove(id) {
  const state = read();
  state.workspaces = state.workspaces.filter((w) => w.id !== id);
  if (state.activeId === id) {
    state.activeId = state.workspaces.length ? state.workspaces[0].id : null;
  }
  write(state);
  return true;
}

function setActive(id) {
  const state = read();
  if (id && !state.workspaces.some((w) => w.id === id)) return active();
  state.activeId = id || null;
  write(state);
  return active();
}

function ensureFolder(ws) {
  if (!ws || !ws.folder) return;
  try {
    fs.mkdirSync(ws.folder, { recursive: true });
  } catch {
    /* the folder may be on a disconnected drive — not fatal */
  }
}

/**
 * Make sure there is always at least one workspace.
 * The first one points at Downloads so the app behaves exactly as before.
 */
function ensureDefault() {
  const state = read();
  if (state.workspaces.length) return state.workspaces[0];
  const ws = create({
    name: 'Default',
    folder: app.getPath('downloads'),
    notes: 'Where Hunyuan3D downloads land by default.',
  });
  return ws;
}

module.exports = {
  list,
  active,
  find,
  byFolder,
  create,
  update,
  remove,
  setActive,
  ensureDefault,
  ensureFolder,
  storePath,
};
