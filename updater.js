/**
 * Self-update (main process) — backs the sidebar's Update button.
 *
 * Brings the app's own files up to lanly-dev/3D main; the caller
 * (main.js) restarts the app when the outcome says it is safe.
 * Two routes:
 *   - The app folder is a git checkout: `git pull --ff-only`. A dirty
 *     or diverged tree makes git refuse, and its own message is
 *     surfaced — local edits are never clobbered by an update.
 *   - Otherwise (packaged build): download the app files from GitHub
 *     main and overwrite the ones that changed. Every file is fetched
 *     BEFORE any is written, so a failed download never leaves a
 *     half-updated app behind.
 *
 * A change to package.json never auto-restarts: dependencies may have
 * changed, which a file sync cannot apply — the user restarts
 * manually (after `npm install` in a source checkout).
 */
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const RAW_BASE = 'https://raw.githubusercontent.com/lanly-dev/3D/main';

// The app's runtime files (the push script's FILES minus repo-only
// docs/meta). updater.js lists itself so it can update too.
const SYNC_FILES = [
  'main.js', 'updater.js', 'glb2ts.mjs', 'package.json',
  'sidebar.html', 'sidebar.js', 'sidebar-preload.js', 'sidebar.css',
  'assets.js', 'workspaces.js',
  'nav.html', 'nav.css', 'nav.js', 'nav-preload.js',
  'toast.html', 'toast.css', 'toast.js',
  'viewer.html', 'viewer.css', 'viewer.js', 'viewer-preload.js',
  'mixamo-export.html', 'mixamo-export.js',
  'thumb.html', 'thumb.css', 'thumb.js', 'thumbs.js',
  'formats.html', 'formats.css',
];

function gitPull(dir) {
  return new Promise((resolve) => {
    execFile('git', ['-C', dir, 'pull', '--ff-only'], { timeout: 60000 }, (err, stdout, stderr) => {
      const out = `${stdout || ''}${stderr || ''}`.trim();
      if (err) {
        resolve({ ok: false, message: (out.split('\n')[0] || 'git pull failed').slice(0, 200) });
        return;
      }
      if (/already up to date/i.test(out)) {
        resolve({ ok: true, changed: [] });
        return;
      }
      // Diffstat lines look like " sidebar.css | 2 +-".
      const changed = out.split('\n')
        .map((l) => l.trim())
        .filter((l) => l.includes('|'))
        .map((l) => l.split('|')[0].trim())
        .filter(Boolean);
      resolve({ ok: true, changed });
    });
  });
}

async function fetchAll(base, files) {
  const fetched = [];
  for (const f of files) {
    const res = await fetch(`${base}/${f}`);
    if (!res.ok) throw new Error(`Download failed for ${f} (${res.status})`);
    fetched.push([f, Buffer.from(await res.arrayBuffer())]);
  }
  return fetched;
}

/** Which of the fetched files differ from what's on disk in `dir`. */
function changedFrom(dir, fetched) {
  const changed = [];
  for (const [f, buf] of fetched) {
    let cur = null;
    try { cur = fs.readFileSync(path.join(dir, f)); } catch { /* not present yet */ }
    if (!cur || !cur.equals(buf)) changed.push(f);
  }
  return changed;
}

async function syncFiles(dir, base, files) {
  const fetched = await fetchAll(base, files);
  const changed = changedFrom(dir, fetched);
  const byName = new Map(fetched);
  for (const f of changed) {
    const p = path.join(dir, f);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, byName.get(f));
  }
  return changed;
}

function gitCmd(dir, args, timeout = 30000) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', dir, ...args], { timeout }, (err, stdout) => {
      if (err) reject(new Error((String(err.message) || 'git failed').slice(0, 200)));
      else resolve(String(stdout || ''));
    });
  });
}

/**
 * Read-only update check (backs the Update button's visibility):
 * does main hold anything this install doesn't? Git route fetches
 * (refs only — the working tree is never touched) and diffs HEAD
 * against origin/main; the download route fetches and compares
 * without writing. Errors come back as { error } so the caller can
 * leave the UI exactly as it was.
 */
async function checkForUpdate(dir, opts = {}) {
  try {
    if (fs.existsSync(path.join(dir, '.git'))) {
      await gitCmd(dir, ['fetch', '--quiet']);
      const out = await gitCmd(dir, ['diff', '--name-only', 'HEAD..origin/main']);
      const changed = out.split('\n').map((l) => l.trim()).filter(Boolean);
      return { available: changed.length > 0, changed };
    }
    const fetched = await fetchAll(opts.base || RAW_BASE, opts.files || SYNC_FILES);
    const changed = changedFrom(dir, fetched);
    return { available: changed.length > 0, changed };
  } catch (e) {
    return { available: false, changed: [], error: (e && e.message) || 'check failed' };
  }
}

function outcome(changed, how) {
  if (!changed.length) return { action: 'none', message: 'Already up to date', changed };
  if (changed.includes('package.json')) {
    return {
      action: 'manual',
      message: `Updated ${changed.length} file(s) via ${how} — package.json changed too, so no auto-restart (npm install may be needed)`,
      changed,
    };
  }
  return { action: 'restart', message: `Updated ${changed.length} file(s) via ${how} — restarting…`, changed };
}

/**
 * Run the update inside `dir`. Returns { action, message, changed }:
 * 'restart' = updated, safe to relaunch; 'none' = already current;
 * 'manual' = updated but restart by hand; 'error' = nothing applied.
 */
async function performUpdate(dir, opts = {}) {
  try {
    if (fs.existsSync(path.join(dir, '.git'))) {
      const r = await gitPull(dir);
      if (!r.ok) return { action: 'error', message: r.message, changed: [] };
      return outcome(r.changed, 'git pull');
    }
    const changed = await syncFiles(dir, opts.base || RAW_BASE, opts.files || SYNC_FILES);
    return outcome(changed, 'download');
  } catch (e) {
    return { action: 'error', message: (e && e.message) || 'Update failed', changed: [] };
  }
}

module.exports = { performUpdate, checkForUpdate, SYNC_FILES, RAW_BASE };
