/**
 * Prepare Blender for MeshCoder-generated scripts.
 *
 * A generated script starts with `from bpy_lib import *`, and bpy_lib
 * (inside the MeshCoder clone) does `import torch` — which Blender's
 * bundled Python does not ship. The fix is a one-time install of
 * CPU-only torch into Blender's per-user modules folder:
 *
 *   %APPDATA%\Blender Foundation\Blender\<version>\scripts\modules
 *
 * Blender puts that folder on sys.path at startup, so bpy_lib's torch
 * import resolves. No admin rights needed and the Blender install
 * itself is never written to. Verification launches Blender headless
 * and imports bpy_lib for real.
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const TORCH_INDEX = 'https://download.pytorch.org/whl/cpu';

/** Streaming spawn in the same shape as meshcoder.runStreaming. */
function runStreaming(cmd, args, { onLog = () => {}, registerChild } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    if (registerChild) registerChild(child);
    const push = (buf) => {
      for (const line of String(buf).split(/\r?\n/)) {
        if (line.trim()) onLog(line.slice(0, 300));
      }
    };
    child.stdout.on('data', push);
    child.stderr.on('data', push);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(cmd)} exited with code ${code}`));
    });
  });
}

/** Buffered spawn: resolves { code, out } — nonzero exit is not an error. */
function runCapture(cmd, args, { timeoutMs = 120000, registerChild } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    if (registerChild) registerChild(child);
    let out = '';
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }, timeoutMs);
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.stderr.on('data', (d) => {
      out += d;
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

function compareVersions(a, b) {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Find Blender installs under one "Blender Foundation" root folder.
 * The standard Windows layout is:
 *   <root>/Blender 4.5/blender.exe
 *   <root>/Blender 4.5/4.5/python/bin/python.exe
 * Each result: { version, dir, exe, python, modulesDir } where
 * modulesDir is the per-user scripts/modules folder for that version.
 */
function findBlendersInRoot(root, appData) {
  const found = [];
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^Blender\b/i.test(entry.name)) continue;
    const dir = path.join(root, entry.name);
    let subs = [];
    try {
      subs = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const sub of subs) {
      if (!sub.isDirectory() || !/^\d+\.\d+$/.test(sub.name)) continue;
      const pyWin = path.join(dir, sub.name, 'python', 'bin', 'python.exe');
      const pyPosix = path.join(dir, sub.name, 'python', 'bin', 'python3');
      const python = fs.existsSync(pyWin) ? pyWin : fs.existsSync(pyPosix) ? pyPosix : null;
      if (!python) continue;
      const exeWin = path.join(dir, 'blender.exe');
      found.push({
        version: sub.name,
        dir,
        exe: fs.existsSync(exeWin) ? exeWin : null,
        python,
        modulesDir: path.join(appData, 'Blender Foundation', 'Blender', sub.name, 'scripts', 'modules'),
      });
    }
  }
  return found;
}

/** The "Blender Foundation" roots worth scanning on this platform. */
function defaultRoots() {
  if (process.platform !== 'win32') return [];
  const roots = [];
  const pf = process.env.ProgramFiles || 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const local = process.env.LOCALAPPDATA || '';
  roots.push(path.join(pf, 'Blender Foundation'));
  roots.push(path.join(pf86, 'Blender Foundation'));
  if (local) roots.push(path.join(local, 'Programs', 'Blender Foundation'));
  return roots;
}

/** All detected installs, newest version first, deduped by python. */
function findBlenders(appData) {
  const byPython = new Map();
  for (const root of defaultRoots()) {
    for (const b of findBlendersInRoot(root, appData)) {
      if (!byPython.has(b.python)) byPython.set(b.python, b);
    }
  }
  return [...byPython.values()].sort((a, b) => compareVersions(b.version, a.version));
}

/** True when a torch package already sits in the install's modules folder. */
function torchInModules(blender) {
  return fs.existsSync(path.join(blender.modulesDir, 'torch'));
}

/**
 * Install CPU-only torch into the install's per-user modules folder.
 * Streams pip's output to onLog. Uses the Blender python's own pip
 * (bootstrapped via ensurepip when missing).
 */
async function installTorch(blender, { onLog = () => {}, registerChild } = {}) {
  fs.mkdirSync(blender.modulesDir, { recursive: true });
  try {
    await runStreaming(blender.python, ['-m', 'ensurepip', '--default-pip'], { onLog, registerChild });
  } catch {
    onLog('ensurepip skipped (pip may already be present)');
  }
  await runStreaming(
    blender.python,
    ['-m', 'pip', 'install', '--target', blender.modulesDir, 'torch', '--index-url', TORCH_INDEX],
    { onLog, registerChild }
  );
}

/**
 * Verify end-to-end: launch Blender headless and import bpy_lib (with
 * the MeshCoder clone's blender_scripts on sys.path, exactly like a
 * stamped generated script). Without a clone, verify torch alone.
 * Resolves { ok, mode, detail } — mode is 'bpy_lib' or 'torch'.
 */
async function verifyBlender(blender, meshcoderHome, { registerChild } = {}) {
  if (!blender.exe) return { ok: false, mode: 'none', detail: 'blender.exe not found next to its Python' };
  const scriptsDir = meshcoderHome
    ? path.join(meshcoderHome, 'src', 'llama_recipes', 'blender_scripts')
    : null;
  const expr =
    scriptsDir && fs.existsSync(path.join(scriptsDir, 'bpy_lib.py'))
      ? [
          'import sys',
          `sys.path.append(${JSON.stringify(scriptsDir)})`,
          'import bpy_lib',
          'print("BPYLIB_OK")',
        ].join('\n')
      : ['import torch', 'print("TORCH_OK " + torch.__version__)'].join('\n');
  const mode = expr.includes('BPYLIB_OK') ? 'bpy_lib' : 'torch';
  const res = await runCapture(blender.exe, ['--background', '--python-expr', expr], {
    timeoutMs: 240000,
    registerChild,
  });
  const ok = mode === 'bpy_lib' ? res.out.includes('BPYLIB_OK') : res.out.includes('TORCH_OK');
  const tail = res.out.trim().split('\n').slice(-6).join('\n');
  return { ok, mode, detail: tail };
}

module.exports = {
  TORCH_INDEX,
  findBlenders,
  findBlendersInRoot,
  defaultRoots,
  compareVersions,
  torchInModules,
  installTorch,
  verifyBlender,
  runCapture,
  runStreaming,
};
