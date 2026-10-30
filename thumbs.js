/**
 * Cached model thumbnails (main process).
 *
 * A thumbnail is a small render of the model itself (same Three.js path
 * as the viewer), saved under <userData>/thumbs/<asset-id>.png. Keying by
 * asset id — not by file path — means a rename or workspace move keeps
 * the thumbnail. thumbs.json records the file mtime each thumbnail was
 * rendered from, so a changed file re-renders and a failed render is not
 * retried until the file changes again. Each entry also records the
 * renderer version: bump RENDER_VERSION whenever the render path changes
 * in a way that makes older thumbnails wrong (v2: the thumb page's CSP
 * blocked embedded textures, so every textured model rendered grey) and
 * stale entries are re-rendered once. v3: thumbnails for converted code
 * files — the bump also clears failures that were pinned while the
 * viewer's esbuild dependency was not yet installed on some machines.
 * v4: the transpiler changed (esbuild → sucrase) after npm's
 * allow-scripts silently blocked esbuild's postinstall on the user's
 * machine; failures pinned at v3 during that broken window would
 * otherwise never retry, leaving code thumbnails permanently absent
 * with no error anywhere.
 * v5: each successful render also records what the model carries —
 * `tex` (any material texture) and `clips` (animation clip count) —
 * for the sidebar's thumbnail badges. Without the bump, already-fresh
 * entries would never re-render and the badges would never appear.
 * v6: the record gains `rig` (skinned mesh or bones present) and
 * `parts` (mesh count) for two more badges; same reasoning — without
 * the bump, v5-fresh entries would show no rig/parts badges forever.
 */
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

function dir() {
  return path.join(app.getPath('userData'), 'thumbs');
}

function metaPath() {
  return path.join(dir(), 'thumbs.json');
}

function readMeta() {
  try {
    const raw = JSON.parse(fs.readFileSync(metaPath(), 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function writeMeta(meta) {
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(metaPath(), JSON.stringify(meta, null, 2));
}

const RENDER_VERSION = 6;

function thumbPath(id) {
  return path.join(dir(), `${String(id)}.png`);
}

function get(id) {
  return readMeta()[String(id)] || null;
}

function set(id, mtimeMs, info) {
  const meta = readMeta();
  const entry = { mtimeMs, v: RENDER_VERSION };
  // What the thumb worker saw in the model (see thumb.js probe): the
  // sidebar badges read these. Absent when the worker reported nothing.
  if (info) {
    entry.tex = !!info.tex;
    entry.clips = Math.max(0, info.clips | 0);
    entry.rig = !!info.rig;
    entry.parts = Math.max(0, info.parts | 0);
  }
  meta[String(id)] = entry;
  writeMeta(meta);
}

function markFailed(id, mtimeMs) {
  const meta = readMeta();
  meta[String(id)] = { mtimeMs, failed: true, v: RENDER_VERSION };
  writeMeta(meta);
}

function remove(id) {
  const meta = readMeta();
  delete meta[String(id)];
  writeMeta(meta);
  try {
    fs.unlinkSync(thumbPath(id));
  } catch { /* already gone */ }
}

module.exports = { dir, thumbPath, get, set, markFailed, remove, RENDER_VERSION };
