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
function runCapture(cmd, args, { timeoutMs = 120000, registerChild, onData, shell } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, shell: !!shell });
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

function quoteCmdArg(a) {
  return `"${String(a).replace(/"/g, '\\"')}"`;
}

function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

function safeRead(p) {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

/** Write a Python snippet to a temp file for `blender --background --python <file>`. */
function tempPyFile(name, source) {
  const p = path.join(os.tmpdir(), name);
  fs.writeFileSync(p, source);
  return p;
}

/**
 * Launch a Store install's blender.exe and capture its output.
 * Windows blocks a direct CreateProcess into the protected
 * WindowsApps package folder (spawn EPERM), so this falls back in
 * order: (1) direct spawn, (2) the command shell (which activates
 * app aliases / Store packages), (3) PowerShell Start-Process with
 * output redirected to files that are polled while it runs. Each
 * fallback is announced via onLog. Resolves { code, out, via };
 * throws only when every route fails to launch.
 */
async function runBlenderCapture(blender, args, { timeoutMs = 240000, registerChild, onLog = () => {}, onData } = {}) {
  try {
    const res = await runCapture(blender.exe, args, { timeoutMs, registerChild, onData });
    return { ...res, via: 'direct' };
  } catch (err) {
    if (!/EPERM|EACCES/i.test(String(err && (err.code || err.message)))) throw err;
    onLog(`Direct launch of Blender was blocked (${err.message}) — retrying through the command shell…`);
  }
  const cmdLine = [blender.exe, ...args].map(quoteCmdArg).join(' ');
  try {
    const res = await runCapture(cmdLine, [], { timeoutMs, registerChild, onData, shell: true });
    if (res.code === 0) return { ...res, via: 'shell' };
    onLog(`Shell launch exited with code ${res.code} — falling back to PowerShell Start-Process…`);
  } catch (err) {
    onLog(`Shell launch was blocked too (${err && err.message ? err.message : err}) — falling back to PowerShell Start-Process…`);
  }
  const outPath = path.join(os.tmpdir(), 'hunyuan3d-blender-out.log');
  const errPath = path.join(os.tmpdir(), 'hunyuan3d-blender-err.log');
  fs.writeFileSync(outPath, '');
  fs.writeFileSync(errPath, '');
  const argList = args.map((a) => (/\s/.test(String(a)) ? `"${a}"` : String(a))).join(' ');
  const ps =
    `try { $p = Start-Process -FilePath ${psQuote(blender.exe)} -ArgumentList ${psQuote(argList)} ` +
    `-Wait -PassThru -NoNewWindow -ErrorAction Stop -RedirectStandardOutput ${psQuote(outPath)} ` +
    `-RedirectStandardError ${psQuote(errPath)}; exit $p.ExitCode } ` +
    `catch { Write-Error $_; exit 1 }`;
  let streamed = 0;
  const poll = () => {
    if (!onData) return;
    const snap = safeRead(outPath) + safeRead(errPath);
    if (snap.length > streamed) {
      onData(snap.slice(streamed));
      streamed = snap.length;
    }
  };
  const timer = setInterval(poll, 1500);
  try {
    const res = await runCapture('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      timeoutMs,
      registerChild,
    });
    poll();
    // PowerShell's own output comes first: when Start-Process itself
    // fails, its error lands there — an earlier version returned only
    // the (empty) redirect files and threw the evidence away.
    return {
      code: res.code,
      out: `${res.out || ''}\n${safeRead(outPath)}${safeRead(errPath)}`,
      via: 'powershell',
    };
  } finally {
    clearInterval(timer);
  }
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

/** The version of the torch in the modules folder ('2.9.0'), or null. */
function installedTorchVersion(blender) {
  const clean = (v) => (v ? String(v).split('+')[0].trim() || null : null);
  try {
    const src = fs.readFileSync(path.join(blender.modulesDir, 'torch', 'version.py'), 'utf8');
    const m = src.match(/__version__\s*=\s*['"]([^'"]+)['"]/);
    if (m) return clean(m[1]);
  } catch {
    /* fall through to the dist-info folder name */
  }
  try {
    const dist = fs
      .readdirSync(blender.modulesDir)
      .find((f) => /^torch-.*\.dist-info$/i.test(f));
    if (dist) return clean(dist.slice('torch-'.length, -'.dist-info'.length));
  } catch {
    /* no modules folder yet */
  }
  return null;
}

/**
 * Newest torch version whose CPU-index wheels include one for the
 * given Blender (its bundled Python, win_amd64). `filenames` is the
 * file list from the index's simple API. Pure — testable.
 */
function pickNewestTorchWheel(filenames, blenderVersion) {
  const py = blenderPythonFor(blenderVersion).replace('.', '');
  const re = new RegExp(
    `^torch-([0-9]+(?:\\.[0-9]+)*)(?:\\+cpu)?-cp${py}-cp${py}-win_amd64\\.whl$`
  );
  let best = null;
  for (const f of filenames || []) {
    const m = String(f).match(re);
    if (m && (!best || compareVersions(m[1], best) > 0)) best = m[1];
  }
  return best;
}

/**
 * Ask the PyTorch CPU index for the newest torch version available
 * for this Blender's Python. Resolves null when the check cannot be
 * made (offline, index changed…) — callers treat that as "keep what
 * is installed", never as an error.
 */
async function fetchNewestTorchVersion(blender, { timeoutMs = 20000 } = {}) {
  try {
    const res = await fetch(`${TORCH_INDEX}/torch/`, {
      headers: { Accept: 'application/vnd.pypi.simple.v1+json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const text = await res.text();
    let names = [];
    try {
      names = (JSON.parse(text).files || []).map((f) => f.filename);
    } catch {
      /* the pytorch.org index serves HTML regardless of Accept */
    }
    if (!names.length) {
      // HTML simple index: wheel names appear in link hrefs with
      // '+' percent-encoded as %2B — decode before matching.
      names = text.replace(/%2B/gi, '+').match(/[A-Za-z0-9._+\-]+\.whl/g) || [];
    }
    return pickNewestTorchWheel(names, blender.version);
  } catch {
    return null;
  }
}

/**
 * The pip script run INSIDE Blender for Microsoft Store installs.
 * The Store package folder is protected, so the app cannot spawn
 * the package's python.exe directly — but Blender itself can run
 * its own Python via subprocess, inside its own package context.
 */
function storeInstallScript(modulesDir, upgrade = false) {
  return [
    'import subprocess, sys',
    'def run(args):',
    "    print('+ ' + ' '.join(args), flush=True)",
    '    subprocess.check_call(args)',
    'try:',
    "    run([sys.executable, '-m', 'ensurepip', '--default-pip'])",
    'except Exception as e:',
    "    print('ensurepip skipped:', e, flush=True)",
    `run([sys.executable, '-m', 'pip', 'install', '--target', ${JSON.stringify(modulesDir)}, ${upgrade ? "'--upgrade', " : ''}'torch', '--index-url', ${JSON.stringify(TORCH_INDEX)}])`,
    "print('TORCH_INSTALL_OK', flush=True)",
    '',
  ].join('\n');
}

/** The CPython version each Blender release bundles (4.x line). */
const BLENDER_PYTHON = {
  '3.6': '3.10',
  '4.0': '3.10',
  '4.1': '3.10',
  '4.2': '3.11',
  '4.3': '3.11',
  '4.4': '3.11',
  '4.5': '3.11',
};

function blenderPythonFor(version) {
  return BLENDER_PYTHON[version] || '3.11';
}

/**
 * pip arguments that install wheels for a DIFFERENT interpreter than
 * the one running pip: Blender's Python version, Windows, CPython
 * ABI, wheels only. This is what lets an unrelated Python (the
 * MeshCoder env's 3.10) fetch a torch build that Blender 4.2's
 * Python 3.11 can import — no Blender launch required, which matters
 * for Store installs whose exe resists being launched at all.
 */
function foreignPipBase(modulesDir, version) {
  const py = blenderPythonFor(version);
  return [
    '-m', 'pip', 'install',
    '--target', modulesDir,
    '--python-version', py,
    '--implementation', 'cp',
    '--abi', `cp${py.replace('.', '')}`,
    '--platform', 'win_amd64',
    '--only-binary=:all:',
  ];
}

/** True when the compiled torch core for some CPython is in place. */
function torchCompiledPresent(modulesDir) {
  try {
    return fs
      .readdirSync(path.join(modulesDir, 'torch'))
      .some((f) => /^_C\..*\.(pyd|so)$/.test(f) || f === '_C.pyd');
  } catch {
    return false;
  }
}

/**
 * Store-install route that never launches Blender: an installer
 * Python already on the machine (the MeshCoder env) downloads torch
 * wheels built for Blender's Python into the modules folder. numpy
 * is deliberately not installed — Blender bundles its own, and
 * torch's remaining small dependencies come in the second step.
 */
async function installTorchForeign(blender, installerPython, { onLog = () => {}, registerChild, upgrade = false } = {}) {
  const base = foreignPipBase(blender.modulesDir, blender.version);
  const up = upgrade ? ['--upgrade'] : [];
  onLog(
    `Fetching torch for Blender's Python ${blenderPythonFor(blender.version)} using ${installerPython} — the Store package itself is never launched…`
  );
  await runStreaming(installerPython, [...base, ...up, '--no-deps', 'torch', '--index-url', TORCH_INDEX], {
    onLog,
    registerChild,
  });
  await runStreaming(
    installerPython,
    [...base, ...up, 'filelock', 'typing-extensions', 'sympy', 'networkx', 'jinja2', 'fsspec', 'MarkupSafe'],
    { onLog, registerChild }
  );
  if (!torchCompiledPresent(blender.modulesDir)) {
    throw new Error("pip finished but the compiled torch build for Blender's Python is missing from the modules folder");
  }
}

/**
 * Install CPU-only torch into the install's per-user modules folder,
 * streaming output to onLog. Standard installs use Blender's Python
 * directly (its pip bootstrapped via ensurepip when missing). Store
 * installs prefer the foreign-target download via an installer
 * Python (opts.installerPython) and only fall back to running pip
 * through Blender itself when no installer Python is available.
 */
async function installTorch(blender, { onLog = () => {}, registerChild, installerPython, upgrade = false } = {}) {
  fs.mkdirSync(blender.modulesDir, { recursive: true });
  if (blender.store && installerPython) {
    await installTorchForeign(blender, installerPython, { onLog, registerChild, upgrade });
    return;
  }
  if (blender.store) {
    if (!blender.exe) throw new Error('Store install has no launchable blender.exe');
    onLog(`Launching Blender: ${blender.exe}`);
    const scriptPath = tempPyFile('hunyuan3d-torch-install.py', storeInstallScript(blender.modulesDir, upgrade));
    let buf = '';
    const res = await runBlenderCapture(blender, ['--background', '--python', scriptPath], {
      timeoutMs: 900000,
      registerChild,
      onLog,
      onData: (chunk) => {
        buf += chunk;
        const lines = buf.split(/\r?\n/);
        buf = lines.pop();
        for (const line of lines) if (line.trim()) onLog(line.slice(0, 300));
      },
    });
    if (buf.trim()) onLog(buf.slice(0, 300));
    if (res.via !== 'direct') onLog(`(Blender was launched via the ${res.via} route)`);
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
    [
      '-m', 'pip', 'install', '--target', blender.modulesDir,
      ...(upgrade ? ['--upgrade'] : []),
      'torch', '--index-url', TORCH_INDEX,
    ],
    { onLog, registerChild }
  );
}

/**
 * Verify end-to-end: launch Blender headless and import bpy_lib (with
 * the MeshCoder clone's blender_scripts on sys.path, exactly like a
 * stamped generated script). Without a clone, verify torch alone.
 * Resolves { ok, mode, detail } — mode is 'bpy_lib' or 'torch'.
 */
async function verifyBlender(blender, meshcoderHome, { registerChild, onLog = () => {} } = {}) {
  if (!blender.exe) return { ok: false, mode: 'none', detail: 'blender.exe not found next to its Python' };
  const scriptsDir = meshcoderHome
    ? path.join(meshcoderHome, 'src', 'llama_recipes', 'blender_scripts')
    : null;
  const source =
    scriptsDir && fs.existsSync(path.join(scriptsDir, 'bpy_lib.py'))
      ? [
          'import sys',
          `sys.path.append(${JSON.stringify(scriptsDir)})`,
          'import bpy_lib',
          'print("BPYLIB_OK")',
        ].join('\n')
      : ['import torch', 'print("TORCH_OK " + torch.__version__)'].join('\n');
  const mode = source.includes('BPYLIB_OK') ? 'bpy_lib' : 'torch';
  // A temp script file instead of --python-expr: the fallback launch
  // routes (shell / Start-Process) cannot quote a multi-line expr.
  const scriptPath = tempPyFile('hunyuan3d-verify.py', source);
  const args = ['--background', '--python', scriptPath];
  const res = blender.store
    ? await runBlenderCapture(blender, args, { timeoutMs: 240000, registerChild, onLog })
    : await runCapture(blender.exe, args, { timeoutMs: 240000, registerChild });
  const ok = mode === 'bpy_lib' ? res.out.includes('BPYLIB_OK') : res.out.includes('TORCH_OK');
  const tail = res.out.trim().split('\n').slice(-6).join('\n');
  return { ok, mode, detail: tail };
}

/** The DLL whose init failure shows up as WinError 1114 on import. */
function torchDllPath(blender) {
  return path.join(blender.modulesDir, 'torch', 'lib', 'c10.dll');
}

/**
 * Discriminator for WinError 1114: try loading c10.dll in a NEUTRAL
 * process (any Python with ctypes — the DLL has no Python deps).
 * Loads fine there → the failure is a conflict with something the
 * Blender process already loaded (classically a second OpenMP
 * runtime). Fails there too → a system runtime c10.dll needs is
 * missing from the machine (usually the VC++ redistributable).
 */
async function probeDll(python, dllPath, { registerChild } = {}) {
  const src = [
    'import ctypes',
    'try:',
    `    ctypes.WinDLL(${JSON.stringify(dllPath)})`,
    "    print('DLL_OK')",
    'except OSError as e:',
    "    print('DLL_FAIL', e)",
  ].join('\n');
  try {
    const res = await runCapture(python, ['-c', src], { timeoutMs: 60000, registerChild });
    return { ok: res.out.includes('DLL_OK'), out: res.out.trim() };
  } catch (err) {
    return { ok: false, out: String(err && err.message ? err.message : err) };
  }
}

/**
 * A numpy-backed stand-in for the slice of torch that MeshCoder's
 * bpy_lib.py actually uses — the fallback for Blenders where the
 * real torch's DLLs will not initialize (WinError 1114) no matter
 * what. Coverage was enumerated against the upstream file (90003
 * bytes, fetched 2026-10-25): `torch.tensor(...)` (incl. on a
 * mathutils Matrix), `torch.eye(4)`, the `torch.float32` /
 * `torch.long` dtype names, and on the resulting tensors
 * `.contiguous()`, `.clone()`, `.norm(dim=0)`, slicing, item
 * assignment, `@` matmul and `np.array(...)` back-conversion —
 * that is the whole surface (get_faces' two tensor returns plus
 * the two rotation_mode='MATRIX' blocks). Anything outside it
 * raises a clear AttributeError instead of silently misbehaving.
 * Written next to the startup script by installStartupScript; the
 * startup script puts its folder first on sys.path ONLY when the
 * real torch's c10/torch_cpu preload failed at launch, so a healthy
 * torch is never shadowed.
 */
const TORCH_SHIM_SRC = `# Hunyuan3D Desktop: numpy-backed stand-in for the slice of torch
# that MeshCoder's bpy_lib.py uses, for Blenders where the real
# torch's DLLs will not initialize (WinError 1114). Prepare Blender
# installed this file; its startup script puts this folder on
# sys.path ONLY when pre-loading the real torch's DLLs failed at
# launch - when real torch loads, this file is never imported.
# Coverage is exactly bpy_lib's torch surface: tensor(), eye(),
# the float32 / long dtype names, and Tensor .contiguous() /
# .clone() / .norm(dim=...) / slicing / item assignment / matmul /
# np.array() conversion. Anything else raises a clear error.
import numpy as _np

float32 = _np.float32
float64 = _np.float64
float16 = _np.float16
long = _np.int64
int32 = _np.int32
int64 = _np.int64
bool = _np.bool_

__version__ = '0.0.0+hunyuan3d-numpy-shim'


class Tensor:
    """A thin wrapper over a numpy array, with torch's call shapes."""

    def __init__(self, array):
        self._a = _np.asarray(array)

    @property
    def shape(self):
        return self._a.shape

    @property
    def dtype(self):
        return self._a.dtype

    def contiguous(self):
        return Tensor(_np.ascontiguousarray(self._a))

    def clone(self):
        return Tensor(self._a.copy())

    def norm(self, dim=None):
        if dim is None:
            return Tensor(_np.linalg.norm(self._a))
        return Tensor(_np.linalg.norm(self._a, axis=dim))

    def numpy(self):
        return self._a

    def tolist(self):
        return self._a.tolist()

    def __array__(self, dtype=None):
        return _np.asarray(self._a, dtype=dtype)

    def __getitem__(self, key):
        result = self._a[key]
        if isinstance(result, _np.ndarray):
            return Tensor(result)
        return result

    def __setitem__(self, key, value):
        if isinstance(value, Tensor):
            value = value._a
        self._a[key] = value

    def __matmul__(self, other):
        if isinstance(other, Tensor):
            other = other._a
        return Tensor(self._a @ other)

    def __rmatmul__(self, other):
        return Tensor(_np.asarray(other) @ self._a)

    def __repr__(self):
        return 'tensor(%r)' % (self._a,)


def tensor(data, dtype=None):
    if isinstance(data, Tensor):
        array = data._a
    else:
        array = _np.asarray(data)
    if dtype is not None:
        array = array.astype(dtype)
    return Tensor(array)


def eye(n, dtype=None):
    return Tensor(_np.eye(n, dtype=dtype if dtype is not None else _np.float64))


def __getattr__(name):
    raise AttributeError(
        'the Hunyuan3D numpy torch shim does not provide torch.%s - '
        'this code path needs the real torch (fix the WinError 1114 '
        'DLL failure to use it)' % name)
`;

/**
 * Source of the Blender startup script Prepare Blender installs.
 * Blender executes every .py in <user scripts>/startup at launch,
 * so this script does two jobs at every Blender launch, before any
 * generated script runs:
 *
 *  1. Puts MeshCoder's blender_scripts folder on sys.path — no
 *     console line and no reliance on the stamped header, old files
 *     included. Tries the clone location known at prep time first,
 *     then the app's managed clone location.
 *  2. On Windows, preps torch's DLLs for bpy_lib's `import torch`.
 *     Inside Blender that import can die with WinError 1114 (c10.dll
 *     will not initialize) when torch's OpenMP runtime clashes with
 *     a DLL Blender already loaded, or when the loader cannot find
 *     torch's own DLLs. Doing it here — in-process, at launch —
 *     beats the setx approach, which only reaches processes started
 *     after it ran and silently does nothing if a blender.exe was
 *     left running: allow the duplicate OpenMP runtime, register
 *     torch's lib folder as a DLL search directory, then pre-load
 *     the DLLs in dependency order so torch's own loader later
 *     reuses these already-initialized copies. Every preload result
 *     is printed and also written to hunyuan3d_preload.log next to
 *     the script, so a still-failing import has a paper trail.
 *     If a key DLL (c10 / torch_cpu / torch) still fails to load,
 *     the script falls back to the numpy torch shim (TORCH_SHIM_SRC,
 *     installed alongside): its folder goes first on sys.path, so
 *     bpy_lib's `import torch` resolves to the shim and generated
 *     scripts run anyway. Nothing here may break a Blender launch:
 *     every step is guarded, and a failed preload without the shim
 *     would just mean the import fails later exactly as it would
 *     have without this script.
 */
function startupScriptSource(meshcoderHome, modulesDir) {
  const baked = meshcoderHome
    ? path.join(meshcoderHome, 'src', 'llama_recipes', 'blender_scripts')
    : null;
  const candidates = [
    ...(baked ? [JSON.stringify(baked)] : []),
    "_h3d_os.path.join(_h3d_os.path.expanduser('~'), 'Documents', 'Hunyuan3D', 'MeshCoder', 'src', 'llama_recipes', 'blender_scripts')",
  ];
  const torchLib = modulesDir ? path.join(modulesDir, 'torch', 'lib') : null;
  const shimDir = modulesDir
    ? path.join(path.dirname(modulesDir), 'hunyuan3d_torch_shim')
    : null;
  return [
    '# Hunyuan3D Desktop: make MeshCoder\'s bpy_lib importable in Blender',
    '# and get torch\'s DLLs loaded before anything imports torch.',
    '# Written by Tools > Prepare Blender (Hunyuan3D app). Blender runs',
    '# this at every startup; deleting this file undoes it.',
    'import os as _h3d_os, sys as _h3d_sys',
    '',
    '# --- torch DLL prep (Windows only) ---',
    '# bpy_lib does `import torch`, and inside Blender that can die with',
    '# WinError 1114 (c10.dll fails to initialize): torch\'s OpenMP',
    '# runtime clashes with a DLL Blender already loaded, or the loader',
    '# cannot find torch\'s own DLLs. Fix it here, in-process, before',
    '# anything imports torch: allow the duplicate OpenMP runtime,',
    '# register torch\'s lib folder for DLL searches, and pre-load the',
    '# DLLs in dependency order. Outcomes land in hunyuan3d_preload.log',
    '# next to this script (and in Blender\'s system console). If the',
    '# real DLLs still will not load, fall back to the numpy torch',
    '# shim Prepare Blender installed next to this script: it covers',
    '# exactly the torch calls bpy_lib makes, so generated scripts',
    '# run anyway. A healthy real torch is never shadowed.',
    '_h3d_notes = []',
    "if _h3d_sys.platform.startswith('win'):",
    "    _h3d_os.environ.setdefault('KMP_DUPLICATE_LIB_OK', 'TRUE')",
    `    _h3d_torch_lib = ${torchLib ? JSON.stringify(torchLib) : 'None'}`,
    '    if _h3d_torch_lib and _h3d_os.path.isdir(_h3d_torch_lib):',
    '        try:',
    '            _h3d_sys._hunyuan3d_dll_dir = _h3d_os.add_dll_directory(_h3d_torch_lib)',
    '        except Exception:',
    '            pass',
    '        import ctypes as _h3d_ctypes',
    '        _h3d_failed = []',
    "        for _h3d_dll in ('libiomp5md.dll', 'c10.dll', 'torch_cpu.dll', 'torch.dll'):",
    '            _h3d_dll_path = _h3d_os.path.join(_h3d_torch_lib, _h3d_dll)',
    '            if not _h3d_os.path.isfile(_h3d_dll_path):',
    '                continue',
    '            try:',
    '                _h3d_ctypes.WinDLL(_h3d_dll_path)',
    "                _h3d_notes.append('torch preload OK: ' + _h3d_dll)",
    '            except Exception as _h3d_err:',
    "                _h3d_notes.append('torch preload FAILED: ' + _h3d_dll + ': ' + str(_h3d_err))",
    '                _h3d_failed.append(_h3d_dll)',
    "        if any(_h3d_f in _h3d_failed for _h3d_f in ('c10.dll', 'torch_cpu.dll', 'torch.dll')):",
    `            _h3d_shim_dir = ${shimDir ? JSON.stringify(shimDir) : 'None'}`,
    '            if _h3d_shim_dir and _h3d_os.path.isdir(_h3d_shim_dir):',
    '                _h3d_sys.path.insert(0, _h3d_shim_dir)',
    "                _h3d_notes.append('real torch DLLs failed - numpy torch shim active for bpy_lib')",
    'for _h3d_note in _h3d_notes:',
    "    print('Hunyuan3D: ' + _h3d_note)",
    'try:',
    "    _h3d_here = _h3d_os.path.dirname(_h3d_os.path.abspath(__file__))",
    "    with open(_h3d_os.path.join(_h3d_here, 'hunyuan3d_preload.log'), 'w') as _h3d_f:",
    "        _h3d_f.write('\\n'.join(_h3d_notes) + '\\n')",
    'except Exception:',
    '    pass',
    '',
    '# --- bpy_lib on sys.path ---',
    `for _h3d_p in (${candidates.join(', ')},):`,
    '    if _h3d_os.path.isdir(_h3d_p) and _h3d_p not in _h3d_sys.path:',
    '        _h3d_sys.path.append(_h3d_p)',
    '',
  ].join('\n');
}

/** Where the startup script lives for an install (sibling of modules/). */
function startupScriptPath(blender) {
  return path.join(path.dirname(blender.modulesDir), 'startup', 'hunyuan3d_meshcoder_path.py');
}

/** Where the numpy torch shim lives for an install (sibling of modules/). */
function torchShimPath(blender) {
  return path.join(path.dirname(blender.modulesDir), 'hunyuan3d_torch_shim', 'torch.py');
}

/** Write (or refresh) the startup script and the torch shim. Returns the script path. */
function installStartupScript(blender, meshcoderHome) {
  const file = startupScriptPath(blender);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, startupScriptSource(meshcoderHome, blender.modulesDir));
  const shim = torchShimPath(blender);
  fs.mkdirSync(path.dirname(shim), { recursive: true });
  fs.writeFileSync(shim, TORCH_SHIM_SRC);
  return file;
}

module.exports = {
  TORCH_INDEX,
  findBlenders,
  findBlendersInRoot,
  queryStorePackages,
  parseStorePackagesOutput,
  aliasProbe,
  runBlenderCapture,
  blenderPythonFor,
  foreignPipBase,
  torchCompiledPresent,
  installTorchForeign,
  torchDllPath,
  probeDll,
  installedTorchVersion,
  pickNewestTorchWheel,
  fetchNewestTorchVersion,
  TORCH_SHIM_SRC,
  torchShimPath,
  startupScriptSource,
  startupScriptPath,
  installStartupScript,
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
