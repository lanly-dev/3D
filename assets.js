/**
 * Asset registry (main process).
 *
 * Keeps a small JSON index of every model / Blender script the app has
 * produced or seen, so the sidebar can act as an asset-management dashboard.
 *
 * Storage: <userData>/assets.json
 *   { id, name, filePath, kind, ext, size, createdAt, updatedAt, meshId?, workspaceId? }
 *
 * kind: 'model' | 'blender-code' | 'other'
 * Workspace membership is NOT stored: a file belongs to whichever
 * workspace's folder it physically sits in (see resolveWorkspace).
 */
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const workspaces = require('./workspaces');

const MODEL_EXTS = ['.glb', '.gltf', '.obj', '.fbx', '.stl', '.ply'];
const CODE_EXTS = ['.py'];

function storePath() {
  return path.join(app.getPath('userData'), 'assets.json');
}

function readStore() {
  try {
    const raw = JSON.parse(fs.readFileSync(storePath(), 'utf8'));
    return Array.isArray(raw.assets) ? raw.assets : [];
  } catch {
    return [];
  }
}

function writeStore(assets) {
  const file = storePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version: 1, assets }, null, 2));
}

function classify(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (MODEL_EXTS.includes(ext)) return 'model';
  if (CODE_EXTS.includes(ext) && filePath.endsWith('.blender.py')) return 'blender-code';
  if (CODE_EXTS.includes(ext)) return 'code';
  return 'other';
}

function describe(filePath, existing) {
  let size = 0;
  let mtime = Date.now();
  try {
    const st = fs.statSync(filePath);
    size = st.size;
    mtime = st.mtimeMs;
  } catch {
    /* file vanished — keep what we know */
  }
  return {
    name: path.basename(filePath, path.extname(filePath)) || path.basename(filePath),
    fileName: path.basename(filePath),
    filePath,
    ext: path.extname(filePath).toLowerCase(),
    kind: existing ? existing.kind : classify(filePath),
    size,
    createdAt: existing ? existing.createdAt : Date.now(),
    updatedAt: mtime,
    meshId: existing ? existing.meshId : null,
    compound: existing ? Boolean(existing.compound) : false,
    workspaceId: existing && existing.workspaceId !== undefined ? existing.workspaceId : null,
  };
}

/** True when `child` lives inside `parent` (case-insensitive, Windows-safe). */
function isInside(parent, child) {
  if (!parent) return false;
  const rel = path.relative(path.resolve(parent).toLowerCase(), path.resolve(child).toLowerCase());
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Work out which workspace a file belongs to, purely from where it sits:
 * the workspace whose folder contains it — the *most specific* (deepest)
 * folder wins, so a project folder nested inside another workspace's
 * folder is not swallowed by its parent. Null when it sits in no
 * workspace folder ('unassigned').
 */
function resolveWorkspace(filePath) {
  let best = null;
  let bestLen = -1;
  for (const ws of workspaces.list()) {
    if (!ws.folder || !isInside(ws.folder, filePath)) continue;
    const len = path.resolve(ws.folder).length;
    if (len > bestLen) {
      best = ws.id;
      bestLen = len;
    }
  }
  return best;
}

/** All tracked assets, newest first. */
function list(workspaceId) {
  const out = [];
  for (const a of readStore()) {
    const exists = fs.existsSync(a.filePath);
    const rec = describe(a.filePath, a);
    rec.workspaceId = resolveWorkspace(a.filePath);
    rec.exists = exists;
    rec.id = a.id;
    out.push(rec);
  }
  out.sort((x, y) => (y.updatedAt || 0) - (x.updatedAt || 0));
  if (workspaceId === 'unassigned') {
    return out.filter((a) => !a.workspaceId);
  }
  if (workspaceId) {
    return out.filter((a) => a.workspaceId === workspaceId);
  }
  return out;
}

/** Register (or refresh) an asset for a file path. */
function track(filePath, kind, _workspaceId) {
  const assets = readStore();
  const abs = path.resolve(filePath);
  const existing = assets.find((a) => a.filePath === abs);
  const record = { id: existing ? existing.id : crypto.randomUUID(), ...describe(abs, existing) };
  if (kind) record.kind = kind;
  record.workspaceId = resolveWorkspace(abs);
  const next = existing
    ? assets.map((a) => (a.id === existing.id ? record : a))
    : [record, ...assets];
  writeStore(next);
  return record;
}

/** Link a generated Blender script back to the mesh it came from. */
function linkCode(codePath, meshId) {
  const assets = readStore();
  const abs = path.resolve(codePath);
  const record = {
    id: crypto.randomUUID(),
    ...describe(abs, null),
    kind: 'blender-code',
    meshId,
    workspaceId: resolveWorkspace(abs),
  };
  writeStore([record, ...assets.filter((a) => a.filePath !== abs)]);
  return record;
}

/** Where files that belong to no workspace live when moved to Unassigned. */
function unassignedDir() {
  return path.join(app.getPath('documents'), 'Hunyuan3D', 'Unassigned');
}

/** A free destination path in `dir`, uniquified as "name (1).ext" on clashes. */
function uniqueDest(dir, fileName) {
  let dest = path.join(dir, fileName);
  if (!fs.existsSync(dest)) return dest;
  const ext = path.extname(fileName);
  const base = path.basename(fileName, ext);
  for (let i = 1; ; i += 1) {
    dest = path.join(dir, `${base} (${i})${ext}`);
    if (!fs.existsSync(dest)) return dest;
  }
}

function moveFile(src, dest) {
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if (!err || err.code !== 'EXDEV') throw err;
    // Different drive — copy across, then remove the original.
    fs.copyFileSync(src, dest);
    fs.unlinkSync(src);
  }
}

/**
 * Move an asset's file into a workspace's folder (or, with null, into the
 * Unassigned folder). Membership follows the file, so this is the only way
 * an asset changes workspace. A model's generated Blender script
 * (<name>.blender.py) sits beside the mesh and moves along with it.
 * Throws with a plain message when the move cannot happen.
 */
function assign(id, workspaceId) {
  const all = readStore();
  const rec = all.find((a) => a.id === id);
  if (!rec) return null;
  const ws = workspaceId ? workspaces.find(workspaceId) : null;
  if (workspaceId && !ws) throw new Error('That workspace no longer exists.');
  const destDir = ws ? ws.folder : unassignedDir();
  if (!destDir) throw new Error('That workspace has no folder set.');
  if (!fs.existsSync(rec.filePath)) throw new Error('The file is missing from disk — cannot move it.');
  fs.mkdirSync(destDir, { recursive: true });

  const src = path.resolve(rec.filePath);
  const srcDir = path.dirname(src);
  const moves = new Map(); // old absolute path -> new absolute path
  if (path.resolve(destDir).toLowerCase() !== srcDir.toLowerCase()) {
    const dest = uniqueDest(destDir, path.basename(src));
    moveFile(src, dest);
    moves.set(src, dest);
    if (classify(src) === 'model') {
      const base = path.basename(src, path.extname(src));
      const companion = path.join(srcDir, `${base}.blender.py`);
      if (fs.existsSync(companion)) {
        const compDest = uniqueDest(destDir, path.basename(companion));
        moveFile(companion, compDest);
        moves.set(companion, compDest);
      }
    }
  }

  const now = Date.now();
  let updated = null;
  const next = all.map((a) => {
    const np = moves.get(path.resolve(a.filePath));
    if (!np && a.id !== id) return a;
    const r = {
      ...a,
      filePath: np || a.filePath,
      workspaceId: resolveWorkspace(np || a.filePath),
      updatedAt: now,
    };
    if (a.id === id) updated = r;
    return r;
  });
  writeStore(next);
  return updated;
}

/** Forget an asset (does not touch the file on disk). */
function remove(id) {
  const assets = readStore();
  writeStore(assets.filter((a) => a.id !== id));
}

/** Update arbitrary fields on a tracked asset. */
function patch(id, fields) {
  const assets = readStore();
  let updated = null;
  const next = assets.map((a) => {
    if (a.id !== id) return a;
    updated = { ...a, ...fields, updatedAt: Date.now() };
    return updated;
  });
  writeStore(next);
  return updated;
}

function find(id) {
  return readStore().find((a) => a.id === id) || null;
}

/** Find a tracked asset by its file path, with the workspace resolved. */
function findByPath(filePath) {
  if (!filePath) return null;
  const abs = path.resolve(filePath);
  const assets = readStore();
  const raw = assets.find((a) => a.filePath === abs);
  if (!raw) return null;
  return { ...describe(raw.filePath, raw), exists: fs.existsSync(raw.filePath), id: raw.id,
    workspaceId: resolveWorkspace(raw.filePath) };
}

/**
 * Scan a folder for model files that are not tracked yet.
 * Returns the list of newly tracked assets.
 */
function scanFolder(folder) {
  let entries = [];
  try {
    entries = fs.readdirSync(folder);
  } catch {
    return [];
  }
  const known = new Set(readStore().map((a) => a.filePath));
  const owner = workspaces.byFolder(folder);
  const added = [];
  for (const name of entries) {
    const full = path.join(folder, name);
    if (known.has(full)) continue;
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if (classify(full) !== 'model') continue;
    added.push(track(full, null, owner ? owner.id : null));
  }
  return added;
}

function stats(workspaceId) {
  const assets = list(workspaceId);
  const models = assets.filter((a) => a.kind === 'model');
  const codes = assets.filter((a) => a.kind === 'blender-code');
  const totalSize = assets.reduce((sum, a) => sum + (a.size || 0), 0);
  const last = models[0] || assets[0] || null;
  return {
    total: assets.length,
    models: models.length,
    codes: codes.length,
    totalSize,
    lastUpdated: last ? last.updatedAt : null,
    lastAsset: last,
  };
}

module.exports = {
  list,
  track,
  linkCode,
  assign,
  patch,
  remove,
  find,
  findByPath,
  scanFolder,
  stats,
  storePath,
  unassignedDir,
  MODEL_EXTS,
};
