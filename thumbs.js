/**
 * Cached model thumbnails (main process).
 *
 * A thumbnail is a small render of the model itself (same Three.js path
 * as the viewer), saved under <userData>/thumbs/<asset-id>.png. Keying by
 * asset id — not by file path — means a rename or workspace move keeps
 * the thumbnail. thumbs.json records the file mtime each thumbnail was
 * rendered from, so a changed file re-renders and a failed render is not
 * retried until the file changes again.
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

function thumbPath(id) {
  return path.join(dir(), `${String(id)}.png`);
}

function get(id) {
  return readMeta()[String(id)] || null;
}

function set(id, mtimeMs) {
  const meta = readMeta();
  meta[String(id)] = { mtimeMs };
  writeMeta(meta);
}

function markFailed(id, mtimeMs) {
  const meta = readMeta();
  meta[String(id)] = { mtimeMs, failed: true };
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

module.exports = { dir, thumbPath, get, set, markFailed, remove };
