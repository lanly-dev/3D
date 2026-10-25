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
const os = require('os');
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
function runCapture(cmd, args, { timeoutMs = 120000, registerChild, onData } = {}) {
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
      if (onData) onData(String(d));
    });
    child.stderr.on('data', (d) => {
      out += d;
      if (onData) onData(String(d));
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

/**
 * Parse Get-AppxPackage JSON output (a single object, or an array
 * when several packages match) into plain { name, version,
 * installLocation } records. Unparseable output yields [].
 */
function parseStorePackagesOutput(out) {
  try {
    const parsed = JSON.parse(String(out || '').trim());
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list
      .filter((p) => p && p.InstallLocation)
      .map((p) => ({
        name: String(p.Name || ''),
        version: String(p.Version || ''),
        installLocation: String(p.InstallLocation),
      }));
  } catch {
    return [];
  }
}

/**
 * Ask Windows about Microsoft Store Blender packages. Store installs
 * live under C:\Program Files\WindowsApps\<package>\, a protected
 * folder that cannot be scanned directly — but Get-AppxPackage
 * reports each package's install location. Every failure mode is
 * reported through onDiag (this used to swallow errors silently,
 * which made a missed detection undebuggable from the prep log).
 */
async function queryStorePackages(onDiag = () => {}) {
  if (process.platform !== 'win32') {
    onDiag('Store query skipped (not Windows)');
    return [];
  }
  const script =
    "Get-AppxPackage | Where-Object { $_.Name -like '*Blender*' } | " +
    "Select-Object @{n='Name';e={$_.Name}}, @{n='Version';e={$_.Version.ToString()}}, InstallLocation | " +
    'ConvertTo-Json -Compress';
  let res;
  try {
    res = await runCapture('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      timeoutMs: 30000,
    });
  } catch (err) {
    onDiag(`Store query could not run PowerShell: ${err && err.message ? err.message : err}`);
    return [];
  }
  if (res.code !== 0) {
    const tail = res.out.trim().split('\n').slice(-3).join(' ').slice(0, 240);
    onDiag(`Store query exited with code ${res.code}${tail ? `: ${tail}` : ''}`);
    return [];
  }
  const pkgs = parseStorePackagesOutput(res.out).filter((p) => /blender/i.test(p.name) || /blender/i.test(p.installLocation));
  onDiag(
    pkgs.length
      ? `Store query found: ${pkgs.map((p) => `${p.name || 'Blender'} ${p.version}`).join('; ')}`
      : 'Store query ran but no Blender package was returned'
  );
  return pkgs;
}

/**
 * Last-resort Store detection: the app execution alias. Store
 * installs register %LOCALAPPDATA%\Microsoft\WindowsApps\blender.exe;
 * if it exists, `blender.exe --version` reports the version, which is
 * all a Store entry needs (install and verification both go through
 * Blender itself; the package's python.exe is never spawned).
 */
async function aliasProbe(appData, onDiag = () => {}) {
  const local = process.env.LOCALAPPDATA || '';
  if (!local) return null;
  const alias = path.join(local, 'Microsoft', 'WindowsApps', 'blender.exe');
  if (!fs.existsSync(alias)) {
    onDiag('No blender.exe app alias found');
    return null;
  }
  onDiag(`Found the app alias: ${alias}`);
  let res;
  try {
    res = await runCapture(alias, ['--version'], { timeoutMs: 30000 });
  } catch (err) {
    onDiag(`Alias --version failed to launch: ${err && err.message ? err.message : err}`);
    return null;
  }
  const m = /Blender\s+(\d+)\.(\d+)/.exec(res.out || '');
  if (!m) {
    onDiag(`Alias ran but its version output was unreadable (exit ${res.code})`);
    return null;
  }
  const version = `${m[1]}.${m[2]}`;
  onDiag(`Alias reports Blender ${version}`);
  return {
    version,
    dir: '(Microsoft Store — launched via app alias)',
    exe: alias,
    python: null,
    modulesDir: path.join(appData, 'Blender Foundation', 'Blender', version, 'scripts', 'modules'),
    store: true,
    viaAlias: true,
  };
}

/**
 * Map Store packages to install entries. The package layout mirrors
 * the normal one under a `Blender` subfolder:
 *   <pkg>\Blender\blender.exe
 *   <pkg>\Blender\<major.minor>\python\bin\python.exe
 * Paths are constructed, not probed — the WindowsApps folder denies
 * casual listing, so existence is proven by the flow's own steps,
 * not by fs checks here. The exe prefers the app execution alias in
 * %LOCALAPPDATA%\Microsoft\WindowsApps, the sanctioned launch path.
 */
function storeEntries(packages, appData) {
  const out = [];
  const local = process.env.LOCALAPPDATA || '';
  const alias = local ? path.join(local, 'Microsoft', 'WindowsApps', 'blender.exe') : null;
  for (const pkg of packages || []) {
    const short = pkg.version.split('.').slice(0, 2).join('.');
    if (!/^\d+\.\d+$/.test(short) || !pkg.installLocation) continue;
    const dir = path.join(pkg.installLocation, 'Blender');
    out.push({
      version: short,
      dir,
      exe: alias && fs.existsSync(alias) ? alias : path.join(dir, 'blender.exe'),
      python: path.join(dir, short, 'python', 'bin', 'python.exe'),
      modulesDir: path.join(appData, 'Blender Foundation', 'Blender', short, 'scripts', 'modules'),
      store: true,
    });
  }
  return out;
}

/**
 * All detected installs — standard folders, then Microsoft Store
 * packages, then (only if no Store entry came out of the package
 * query) the app-alias probe — newest version first. On a version
 * tie a standard install wins, then a package entry (it knows its
 * Python path), then an alias-only entry.
 */
async function findBlenders(appData, packages, onDiag = () => {}) {
  const all = [];
  for (const root of defaultRoots()) all.push(...findBlendersInRoot(root, appData));
  onDiag(`Standard folder scan: ${all.length} install(s)`);
  const pkgs = packages !== undefined ? packages : await queryStorePackages(onDiag);
  const store = storeEntries(pkgs, appData);
  all.push(...store);
  if (!all.length) {
    // Nothing found by folder or package: one last probe, so a stale
    // alias from an old install can never outrank a real detection.
    const viaAlias = await aliasProbe(appData, onDiag);
    if (viaAlias) all.push(viaAlias);
  }
  const rank = (b) => (b.store ? (b.viaAlias ? 2 : 1) : 0);
  const byKey = new Map();
  for (const b of all) {
    const key = `${b.version}|${b.modulesDir}`;
    const prev = byKey.get(key);
    if (!prev || rank(b) < rank(prev)) byKey.set(key, b);
  }
  return [...byKey.values()].sort(
    (a, b) => compareVersions(b.version, a.version) || rank(a) - rank(b)
  );
}

/** True when a torch package already sits in the install's modules folder. */
function torchInModules(blender) {
  return fs.existsSync(path.join(blender.modulesDir, 'torch'));
}

/**
 * The pip script run INSIDE Blender for Microsoft Store installs.
 * The Store package folder is protected, so the app cannot spawn
 * the package's python.exe directly — but Blender itself can run
 * its own Python via subprocess, inside its own package context.
 */
function storeInstallScript(modulesDir) {
  return [
    'import subprocess, sys',
    'def run(args):',
    "    print('+ ' + ' '.join(args), flush=True)",
    '    subprocess.check_call(args)',
    'try:',
    "    run([sys.executable, '-m', 'ensurepip', '--default-pip'])",
    'except Exception as e:',
    "    print('ensurepip skipped:', e, flush=True)",
    `run([sys.executable, '-m', 'pip', 'install', '--target', ${JSON.stringify(modulesDir)}, 'torch', '--index-url', ${JSON.stringify(TORCH_INDEX)}])`,
    "print('TORCH_INSTALL_OK', flush=True)",
    '',
  ].join('\n');
}

/**
 * Install CPU-only torch into the install's per-user modules folder,
 * streaming output to onLog. Standard installs use Blender's Python
 * directly (its pip bootstrapped via ensurepip when missing); Store
 * installs run the same pip through Blender itself (see above).
 */
async function installTorch(blender, { onLog = () => {}, registerChild } = {}) {
  fs.mkdirSync(blender.modulesDir, { recursive: true });
  if (blender.store) {
    if (!blender.exe) throw new Error('Store install has no launchable blender.exe');
    const scriptPath = path.join(os.tmpdir(), 'hunyuan3d-torch-install.py');
    fs.writeFileSync(scriptPath, storeInstallScript(blender.modulesDir));
    let buf = '';
    const res = await runCapture(blender.exe, ['--background', '--python', scriptPath], {
      timeoutMs: 900000,
      registerChild,
      onData: (chunk) => {
        buf += chunk;
        const lines = buf.split(/\r?\n/);
        buf = lines.pop();
        for (const line of lines) if (line.trim()) onLog(line.slice(0, 300));
      },
    });
    if (buf.trim()) onLog(buf.slice(0, 300));
    if (!res.out.includes('TORCH_INSTALL_OK')) {
      throw new Error('Blender-side pip install did not complete (see the output above)');
    }
    return;
  }
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
  queryStorePackages,
  parseStorePackagesOutput,
  aliasProbe,
  storeEntries,
  storeInstallScript,
  defaultRoots,
  compareVersions,
  torchInModules,
  installTorch,
  verifyBlender,
  runCapture,
  runStreaming,
};
