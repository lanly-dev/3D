/**
 * MeshCoder bridge (main process).
 *
 * Converts a downloaded mesh (GLB/OBJ) into part-segmented, editable
 * Blender Python code using a local MeshCoder install
 * (https://github.com/InternRobotics/MeshCoder, MIT).
 *
 * Pipeline:
 *   mesh --(mesh-to-npz.py)--> point-cloud NPZ --(MeshCoder inference)--> Blender .py
 *
 * MeshCoder needs a CUDA GPU and its own Python/conda env; it does NOT run
 * inside Electron. The app just shells out to it. Configure via env vars
 * or <userData>/meshcoder.json:
 *   MESHCODER_HOME    path to the MeshCoder clone
 *   MESHCODER_PYTHON  python executable of the MeshCoder conda env
 *
 * Anything the env vars / config file leave blank is auto-detected when
 * it is needed (first conversion, or Tools -> Detect MeshCoder
 * automatically): a clone is recognized by its inference entry script in
 * the usual folders, and a python by torch + trimesh in its site-packages.
 * Detection only fills gaps — an explicitly set value always wins — and a
 * successful detection is saved to meshcoder.json so it runs once.
 * If no clone exists anywhere, the app offers to download one into
 * Documents/Hunyuan3D/MeshCoder (see cloneRepo) — that folder is checked
 * first by detection.
 *
 * Expected layout under MESHCODER_HOME (per MeshCoder's README):
 *   llama-3-models/Llama3.2-1B/           base model
 *   llama-3-models/object_to_code_model/  shape tokenizer + LoRA checkpoint
 *   recipes/inference/local_inference/custom_inference/inference_shape2code_point_input.py
 */
const { app } = require('electron');
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');

const INFERENCE_REL = path.join(
  'recipes',
  'inference',
  'local_inference',
  'custom_inference',
  'inference_shape2code_point_input.py'
);

const REPO_URL = 'https://github.com/InternRobotics/MeshCoder';

/**
 * Where the app clones MeshCoder when the user accepts the download offer:
 * Documents/Hunyuan3D/MeshCoder (next to the app's other on-disk home).
 */
function downloadDest() {
  return path.join(os.homedir(), 'Documents', 'Hunyuan3D', 'MeshCoder');
}

function configPath() {
  return path.join(app.getPath('userData'), 'meshcoder.json');
}

function loadConfig() {
  let fileCfg = {};
  try {
    fileCfg = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    /* no config file yet */
  }
  return {
    home: process.env.MESHCODER_HOME || fileCfg.home || '',
    python: process.env.MESHCODER_PYTHON || fileCfg.python || '',
  };
}

function isConfigured(cfg = loadConfig()) {
  return Boolean(
    cfg.home && cfg.python && fs.existsSync(path.join(cfg.home, INFERENCE_REL))
  );
}

function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(
    configPath(),
    JSON.stringify({ home: cfg.home || '', python: cfg.python || '' }, null, 2)
  );
}

/** Folders a MeshCoder clone commonly lives in (plus one level of guessing). */
function homeCandidates() {
  const home = os.homedir();
  const dirs = [
    // The app's own managed download location wins over a stray clone.
    path.join(home, 'Documents', 'Hunyuan3D', 'MeshCoder'),
    path.join(home, 'MeshCoder'),
    path.join(home, 'meshcoder'),
    path.join(home, 'Documents', 'MeshCoder'),
    path.join(home, 'Documents', 'GitHub', 'MeshCoder'),
    path.join(home, 'source', 'repos', 'MeshCoder'),
  ];
  // A clone under a different name still counts if it holds the entry script.
  for (const parent of [
    home,
    path.join(home, 'Documents'),
    path.join(home, 'Documents', 'GitHub'),
    path.join(home, 'source', 'repos'),
  ]) {
    try {
      for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
        if (entry.isDirectory()) dirs.push(path.join(parent, entry.name));
      }
    } catch {
      /* folder missing — skip */
    }
  }
  return [...new Set(dirs)];
}

/** A directory is a MeshCoder home iff it holds the inference entry script. */
function findHome() {
  for (const dir of homeCandidates()) {
    try {
      if (fs.existsSync(path.join(dir, INFERENCE_REL))) return dir;
    } catch {
      /* unreadable — skip */
    }
  }
  return '';
}

/**
 * Does this python have the packages the pipeline needs (torch for
 * inference, trimesh for the NPZ step)? Filesystem check only — no
 * interpreter is launched, so a bare `python` stub that would open the
 * Microsoft Store is never executed.
 */
function pythonHasDeps(pythonExe) {
  const roots = [path.dirname(pythonExe), path.dirname(path.dirname(pythonExe))];
  for (const root of roots) {
    const winPkgs = path.join(root, 'Lib', 'site-packages');
    if (
      fs.existsSync(path.join(winPkgs, 'torch')) &&
      fs.existsSync(path.join(winPkgs, 'trimesh'))
    ) {
      return true;
    }
    try {
      const lib = path.join(root, 'lib');
      for (const entry of fs.readdirSync(lib, { withFileTypes: true })) {
        if (!entry.isDirectory() || !entry.name.startsWith('python')) continue;
        const pkgs = path.join(lib, entry.name, 'site-packages');
        if (
          fs.existsSync(path.join(pkgs, 'torch')) &&
          fs.existsSync(path.join(pkgs, 'trimesh'))
        ) {
          return true;
        }
      }
    } catch {
      /* no lib dir — try the next root */
    }
  }
  return false;
}

function condaBaseDirs() {
  const bases = [];
  try {
    const r = spawnSync('conda', ['info', '--base'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
    });
    if (r.status === 0 && r.stdout) bases.push(r.stdout.trim());
  } catch {
    /* no conda on PATH */
  }
  const home = os.homedir();
  for (const name of ['anaconda3', 'miniconda3', 'miniforge3']) {
    bases.push(path.join(home, name));
  }
  if (process.env.LOCALAPPDATA) {
    for (const name of ['anaconda3', 'miniconda3']) {
      bases.push(path.join(process.env.LOCALAPPDATA, name));
    }
  }
  return [...new Set(bases)].filter(Boolean);
}

function pyLauncherInterpreters() {
  if (process.platform !== 'win32') return [];
  try {
    const r = spawnSync('py', ['-0p'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
    });
    if (r.status !== 0 || !r.stdout) return [];
    const out = [];
    for (const line of r.stdout.split(/\r?\n/)) {
      const m = line.match(/^\s*-V:\S+\s+\*?\s*(.+?)\s*$/);
      if (m) out.push(m[1]);
      else {
        const d = line.match(/([A-Za-z]:\\[^"]*python\w*\.exe)/i);
        if (d) out.push(d[1]);
      }
    }
    return out;
  } catch {
    return [];
  }
}

function pathPythons() {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  const arg = process.platform === 'win32' ? 'python' : 'python3';
  try {
    const r = spawnSync(cmd, [arg], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 15000,
    });
    if (r.status !== 0 || !r.stdout) return [];
    return r.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.includes('WindowsApps')); // the Store stub, not an install
  } catch {
    return [];
  }
}

function findPython() {
  // Conda env pythons live at the env root on Windows (<env>\python.exe)
  // but under bin/ on POSIX (<env>/bin/python).
  const exeRel = process.platform === 'win32' ? 'python.exe' : path.join('bin', 'python');
  const candidates = [];
  for (const base of condaBaseDirs()) {
    candidates.push(path.join(base, exeRel));
    try {
      const envsDir = path.join(base, 'envs');
      for (const entry of fs.readdirSync(envsDir, { withFileTypes: true })) {
        if (entry.isDirectory()) candidates.push(path.join(envsDir, entry.name, exeRel));
      }
    } catch {
      /* no envs dir */
    }
  }
  candidates.push(...pyLauncherInterpreters(), ...pathPythons());
  for (const py of [...new Set(candidates)]) {
    try {
      if (fs.existsSync(py) && pythonHasDeps(py)) return py;
    } catch {
      /* unreadable — skip */
    }
  }
  return '';
}

/**
 * Fill in whatever the env vars / config file leave blank, from the usual
 * places (clone folders, conda envs, the py launcher, PATH). Never
 * overrides an explicitly set value.
 */
function detect() {
  const cfg = loadConfig();
  if (!cfg.home) cfg.home = findHome();
  if (!cfg.python) cfg.python = findPython();
  return cfg;
}

/**
 * Detect missing pieces and persist them to meshcoder.json, so detection
 * runs once and later runs just use the config. Returns the merged config
 * plus which fields were newly detected.
 */
function detectAndSave() {
  const before = loadConfig();
  const cfg = detect();
  const newly = {
    home: !before.home && Boolean(cfg.home),
    python: !before.python && Boolean(cfg.python),
  };
  if (newly.home || newly.python) saveConfig(cfg);
  return { cfg, newly };
}

/**
 * Clone the MeshCoder code into `dest` (shallow — the multi-GB checkpoints
 * are a separate download, not part of the repo). Resolves with `dest`.
 * Rejects with a readable error (git missing, network failure, git's own
 * stderr tail) for the caller to show.
 */
async function cloneRepo(dest = downloadDest(), repoUrl = REPO_URL) {
  if (fs.existsSync(path.join(dest, INFERENCE_REL))) return dest; // already there
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    await run('git', ['clone', '--depth', '1', repoUrl, dest]);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      throw new Error('git was not found on PATH — install Git for Windows, or clone MeshCoder manually.');
    }
    throw err;
  }
  return dest;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts, windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.stderr.on('data', (d) => {
      err += d;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(out);
      else
        reject(
          new Error(`${path.basename(cmd)} exited with code ${code}\n${err.slice(-2000)}`)
        );
    });
  });
}

/**
 * Convert a mesh file to Blender Python code via MeshCoder.
 *
 * Writes `<mesh name>.blender.py` next to the mesh and resolves with its path.
 * If `outDir` is given, the script is written there instead (used by the
 * active workspace so generated code lands in the project folder).
 */
async function convertToCode(meshPath, outDir, opts = {}) {
  const { onLog, onPhase, registerChild } = opts;
  // With a log sink, stream the child's output live; without one, buffer it.
  const exec = onLog ? (cmd, args, runOpts) => runStreaming(cmd, args, { onLog, registerChild, ...runOpts }) : run;
  let cfg = loadConfig();
  if (!isConfigured(cfg)) {
    // One automatic attempt before giving up: a clone in the usual places
    // and a conda env with torch + trimesh configure themselves.
    cfg = detectAndSave().cfg;
  }
  if (!isConfigured(cfg)) {
    throw new Error(
      'MeshCoder is not configured and auto-detection found nothing. Set MESHCODER_HOME / MESHCODER_PYTHON ' +
        `or edit ${configPath()} — see the MeshCoder section of the README.`
    );
  }
  // If the app manages this env, make sure the compatibility stand-ins
  // are current — a shim fix then lands with an app update, with no
  // setup re-run. Never touches a python the app does not own.
  refreshShimsIfManaged(cfg);
  const base = path.basename(meshPath, path.extname(meshPath));
  const dir = outDir ? path.resolve(outDir) : path.dirname(meshPath);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    throw new Error(`Cannot create output folder: ${dir}`);
  }
  const codePath = path.join(dir, `${base}.blender.py`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'meshcoder-'));
  const npzPath = path.join(tmp, 'points.npz');

  try {
    // 1. mesh -> point-cloud NPZ (trimesh lives in the MeshCoder env already)
    if (onPhase) onPhase('sampling');
    await exec(cfg.python, [path.join(__dirname, 'mesh-to-npz.py'), meshPath, npzPath]);

    // 2. NPZ -> Blender code (MeshCoder single-GPU inference)
    if (onPhase) onPhase('generating');
    const modelDir = path.join(cfg.home, 'llama-3-models');
    await exec(
      cfg.python,
      [
        path.join(cfg.home, INFERENCE_REL),
        '--model_name',
        path.join(modelDir, 'Llama3.2-1B'),
        '--peft_model',
        path.join(modelDir, 'object_to_code_model'),
        '--npz_data_file',
        npzPath,
        '--code_save_file',
        codePath,
        '--batch_size',
        '1',
        '--max_new_tokens',
        '5000',
        '--zero_out_normals',
        'True',
        '--do_sample',
        'False',
      ],
      { cwd: cfg.home }
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  if (!fs.existsSync(codePath)) {
    throw new Error('MeshCoder finished but produced no code file.');
  }
  return codePath;
}

/* ------------------------------------------------------------------ */
/* Automatic setup (native Windows — no WSL2, no conda).              */
/*                                                                    */
/* A venv in Documents/Hunyuan3D/MeshCoderEnv, built from a Python    */
/* 3.10 (the user's own, or the official installer), the pip-         */
/* installable subset of MeshCoder's recipe, and the checkpoints      */
/* from Hugging Face. Where the recipe cannot run on Windows, the     */
/* setup bridges the gap (all verified by an import smoke test of     */
/* the real inference module):                                        */
/*   - pytorch3d has no Windows builds, and bpy==4.0.0 was never      */
/*     published to PyPI at all. Both are imported at module level    */
/*     by a reconstruction-evaluation module in the inference chain,  */
/*     so the setup installs small stand-ins (meshcoder-shim/): a     */
/*     functional pure-PyTorch pytorch3d (chamfer_distance,           */
/*     sample_points_from_meshes, Meshes) and a bpy stand-in whose    */
/*     bpy.ops.* calls are no-ops. Inference generates the code       */
/*     first, then scores it via batch_code_to_mesh — which cannot   */
/*     run on Windows anyway (its per-script time limit uses the     */
/*     Unix-only signal.SIGALRM), so every script scores success=0   */
/*     and the generated code is still saved; only the Chamfer-      */
/*     distance metrics are skipped. The one bpy call that must not  */
/*     raise is the failure handler's read_homefile() reset — it     */
/*     sits outside the per-script try/except.                       */
/*   - accelerate is pinned to 1.11.0: newer releases renamed         */
/*     is_ccl_available, which MeshCoder's code imports.              */
/*   - fvcore/iopath are only pytorch3d dependencies; the inference   */
/*     chain never imports them, so they are not installed.           */
/* ------------------------------------------------------------------ */

const HF_REPO = 'InternRobotics/MeshCoder';
const HF_API = `https://huggingface.co/api/models/${HF_REPO}?blobs=true`;
const HF_RESOLVE = `https://huggingface.co/${HF_REPO}/resolve/main`;
const PY310_INSTALLER_URL = 'https://www.python.org/ftp/python/3.10.11/python-3.10.11-amd64.exe';
// Root files of the HF repo that belong in object_to_code_model/.
// Everything under Llama3.2-1B/ keeps its path inside Llama3.2-1B/.
const OBJECT_TO_CODE_FILES = ['adapter_config.json', 'adapter_model.safetensors', 'config.yaml', 'shape_tokenizer.pt'];

/** The app-managed env folder (sibling of the managed clone). */
function envDir() {
  return path.join(os.homedir(), 'Documents', 'Hunyuan3D', 'MeshCoderEnv');
}

function envPython() {
  return process.platform === 'win32'
    ? path.join(envDir(), 'Scripts', 'python.exe')
    : path.join(envDir(), 'bin', 'python');
}

function checkpointsPresent(home) {
  if (!home) return false;
  const o2c = path.join(home, 'llama-3-models', 'object_to_code_model');
  const llama = path.join(home, 'llama-3-models', 'Llama3.2-1B');
  return (
    OBJECT_TO_CODE_FILES.every((f) => fs.existsSync(path.join(o2c, f))) &&
    fs.existsSync(path.join(llama, 'model.safetensors')) &&
    fs.existsSync(path.join(llama, 'config.json')) &&
    fs.existsSync(path.join(llama, 'tokenizer.json'))
  );
}

/**
 * Map the HF repo's file list ([{path, size}]) to download jobs with local
 * destinations under <home>/llama-3-models. Repo docs/attributes are not
 * checkpoints and are skipped.
 */
function checkpointPlan(home, siblings) {
  const plan = [];
  for (const s of siblings || []) {
    const rel = String((s && (s.path || s.rfilename)) || '');
    if (!rel) continue;
    let dest = null;
    if (rel.startsWith('Llama3.2-1B/')) {
      dest = path.join(home, 'llama-3-models', rel);
    } else if (OBJECT_TO_CODE_FILES.includes(rel)) {
      dest = path.join(home, 'llama-3-models', 'object_to_code_model', rel);
    } else {
      continue;
    }
    plan.push({ rel, url: `${HF_RESOLVE}/${rel}`, dest, size: s.size || 0 });
  }
  return plan;
}

function httpGet(url, headers, redirects = 0) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (redirects >= 6) return reject(new Error('Too many redirects'));
        // The CDN target of a redirect is pre-signed — drop the token.
        const next = new URL(res.headers.location, url);
        const hdrs = next.host === new URL(url).host ? headers : {};
        return resolve(httpGet(next.href, hdrs, redirects + 1));
      }
      resolve(res);
    });
    req.on('error', reject);
  });
}

async function fetchJson(url, token) {
  const res = await httpGet(url, token ? { Authorization: `Bearer ${token}` } : {});
  if (res.statusCode !== 200) {
    res.resume();
    throw new Error(`Hugging Face answered HTTP ${res.statusCode}${res.statusCode === 401 || res.statusCode === 403 ? ' — access needs your token, and the one-time access form on the model page must be submitted first' : ''}`);
  }
  const body = await new Promise((resolve, reject) => {
    let data = '';
    res.setEncoding('utf8');
    res.on('data', (d) => { data += d; });
    res.on('end', () => resolve(data));
    res.on('error', reject);
  });
  return JSON.parse(body);
}

/**
 * Download one file, streaming progress. `registerCancel(fn)` hands the
 * caller a way to abort the transfer.
 */
function downloadFile(url, dest, { token, onProgress = () => {}, registerCancel } = {}) {
  return (async () => {
    const res = await httpGet(url, token ? { Authorization: `Bearer ${token}` } : {});
    if (res.statusCode !== 200) {
      res.resume();
      throw new Error(`Download failed with HTTP ${res.statusCode} for ${path.basename(dest)}${res.statusCode === 401 || res.statusCode === 403 ? ' — Hugging Face needs a token with access to the model (submit the access form on the model page first)' : ''}`);
    }
    const total = Number(res.headers['content-length'] || 0);
    let done = 0;
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(dest);
      if (registerCancel) {
        registerCancel(() => {
          res.destroy(new Error('Download cancelled'));
          out.destroy();
          reject(new Error('Download cancelled'));
        });
      }
      res.on('data', (chunk) => {
        done += chunk.length;
        onProgress(done, total);
      });
      res.on('error', reject);
      out.on('error', reject);
      out.on('finish', resolve);
      res.pipe(out);
    });
    return done;
  })();
}

/** Download every missing checkpoint file into <home>/llama-3-models. */
async function downloadCheckpoints(home, token, { onLog = () => {}, onProgress = () => {}, registerCancel } = {}) {
  const info = await fetchJson(HF_API, token);
  const plan = checkpointPlan(home, info.siblings);
  if (!plan.length) throw new Error('Hugging Face returned no checkpoint files for InternRobotics/MeshCoder.');
  const totalBytes = plan.reduce((a, p) => a + (p.size || 0), 0);
  let doneBytes = 0;
  for (const item of plan) {
    if (item.size && fs.existsSync(item.dest) && fs.statSync(item.dest).size === item.size) {
      doneBytes += item.size;
      onProgress(doneBytes, totalBytes);
      continue;
    }
    fs.mkdirSync(path.dirname(item.dest), { recursive: true });
    onLog(`Downloading ${item.rel} (${item.size ? `${(item.size / 1e6).toFixed(0)} MB` : 'size unknown'})…`);
    const written = await downloadFile(item.url, item.dest, {
      token,
      registerCancel,
      onProgress: (n) => onProgress(doneBytes + n, totalBytes),
    });
    doneBytes += item.size || written;
    onProgress(doneBytes, totalBytes);
  }
  return plan.length;
}

function pythonVersion(exe) {
  try {
    const r = spawnSync(exe, ['--version'], { encoding: 'utf8', windowsHide: true });
    const m = /Python (\d+)\.(\d+)\.(\d+)/.exec(`${r.stdout || ''} ${r.stderr || ''}`);
    return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) } : null;
  } catch {
    return null;
  }
}

/** Every enumerable real interpreter path (Store stubs excluded). */
function basePythonCandidates() {
  const seen = new Set();
  const out = [];
  const add = (p) => {
    if (p && !/WindowsApps/i.test(p) && !seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
  };
  for (const p of pyLauncherInterpreters()) add(p);
  for (const p of pathPythons()) add(p);
  for (const base of condaBaseDirs()) {
    add(process.platform === 'win32' ? path.join(base, 'python.exe') : path.join(base, 'bin', 'python'));
  }
  return out;
}

/**
 * Find an installed Python 3.10 (any patch level) to build the venv from.
 * Runs --version on real installs only (never the Store stub) — setup is
 * an explicit user action, unlike silent detection.
 */
function findBasePython310() {
  for (const exe of basePythonCandidates()) {
    if (!fs.existsSync(exe)) continue;
    const v = pythonVersion(exe);
    if (v && v.major === 3 && v.minor === 10) return exe;
  }
  return '';
}

/** Download and silently install Python 3.10.11 per-user (Windows only). */
async function installPython310({ onLog = () => {}, registerCancel } = {}) {
  if (process.platform !== 'win32') {
    throw new Error('Automatic Python installation is Windows-only — install Python 3.10 manually.');
  }
  const installer = path.join(os.tmpdir(), 'python-3.10.11-amd64.exe');
  onLog('Downloading Python 3.10.11 from python.org…');
  await downloadFile(PY310_INSTALLER_URL, installer, { registerCancel });
  onLog('Installing Python 3.10 (per-user, silent)…');
  await run(installer, ['/quiet', 'InstallAllUsers=0', 'PrependPath=0', 'Include_launcher=1', 'Include_test=0']);
  const found = findBasePython310();
  if (!found) throw new Error('Python 3.10 installation finished, but no 3.10 interpreter was found afterwards.');
  return found;
}

/**
 * Spawn with line-streamed output (for the setup window's log).
 * `registerChild(child)` lets the caller kill the running step on cancel.
 */
function runStreaming(cmd, args, { cwd, onLog = () => {}, registerChild } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, windowsHide: true });
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

/** Create the venv (idempotent — an existing env python is kept). */
async function createEnv(basePython, { onLog = () => {}, registerChild } = {}) {
  if (fs.existsSync(envPython())) return envPython();
  fs.mkdirSync(path.dirname(envDir()), { recursive: true });
  await runStreaming(basePython, ['-m', 'venv', envDir()], { onLog, registerChild });
  if (!fs.existsSync(envPython())) throw new Error('venv creation finished, but its python.exe is missing.');
  return envPython();
}

/**
 * The pip install sequence, as data so the caller can run and label the
 * steps. Mirrors MeshCoder's README recipe with the native-Windows
 * adjustments described in the section note above (shims and the
 * accelerate pin are handled separately / last).
 */
function installSteps(home) {
  const py = envPython();
  const step = (label, extra, extraOpts = {}) => ({
    label,
    cmd: py,
    args: ['-m', 'pip', 'install', ...extra],
    ...extraOpts,
  });
  return [
    step('Upgrade pip', ['--upgrade', 'pip']),
    step('PyTorch 2.4.1 + CUDA 11.8', ['torch==2.4.1', 'torchvision==0.19.1', 'torchaudio==2.4.1', '--index-url', 'https://download.pytorch.org/whl/cu118']),
    step('torch-scatter', ['torch-scatter', '-f', 'https://data.pyg.org/whl/torch-2.4.1+cu118.html']),
    step('Remaining packages', ['opencv-python', 'trimesh', 'jaxtyping', 'einops', 'omegaconf', 'scikit-image', 'wandb', 'boto3', 'typeguard', 'fire', 'gradio']),
    step('xformers (optional)', ['-U', 'xformers==0.0.28', '--index-url', 'https://download.pytorch.org/whl/cu118', '--no-deps'], { optional: true }),
    step('MeshCoder package', ['-e', home]),
    step('Compatibility pins', ['accelerate==1.11.0']),
  ];
}

/** The env's site-packages folder (where pip put everything). */
function sitePackagesDir() {
  if (process.platform === 'win32') return path.join(envDir(), 'Lib', 'site-packages');
  try {
    const lib = path.join(envDir(), 'lib');
    const pyDir = fs.readdirSync(lib).find((d) => d.startsWith('python'));
    if (pyDir) return path.join(lib, pyDir, 'site-packages');
  } catch {
    /* env not created yet */
  }
  return path.join(envDir(), 'lib', 'python3.10', 'site-packages');
}

/**
 * Copy the pytorch3d / bpy stand-ins (meshcoder-shim/, next to this file)
 * into the env. A real pytorch3d or bpy already in the env is left
 * untouched — the stand-ins only fill gaps.
 */
function installShims(onLog = () => {}) {
  const dest = sitePackagesDir();
  fs.mkdirSync(dest, { recursive: true });
  const srcRoot = path.join(__dirname, 'meshcoder-shim');
  const p3dDest = path.join(dest, 'pytorch3d');
  const p3dInit = path.join(p3dDest, '__init__.py');
  const realP3d = fs.existsSync(p3dInit) && !fs.readFileSync(p3dInit, 'utf8').includes('Hunyuan3D');
  if (realP3d) {
    onLog('A real pytorch3d is installed — leaving it in place.');
  } else {
    fs.cpSync(path.join(srcRoot, 'pytorch3d'), p3dDest, { recursive: true, force: true });
    onLog('Installed the pure-PyTorch pytorch3d stand-in.');
  }
  const bpyDest = path.join(dest, 'bpy.py');
  if (fs.existsSync(bpyDest) && !fs.readFileSync(bpyDest, 'utf8').includes('Hunyuan3D')) {
    onLog('A real bpy module is installed — leaving it in place.');
  } else if (!fs.existsSync(path.join(dest, 'bpy')) && !fs.existsSync(bpyDest)) {
    fs.copyFileSync(path.join(srcRoot, 'bpy.py'), bpyDest);
    onLog('Installed the bpy stand-in (bpy.ops calls are no-ops).');
  } else if (fs.existsSync(bpyDest)) {
    fs.copyFileSync(path.join(srcRoot, 'bpy.py'), bpyDest);
    onLog('Refreshed the bpy stand-in.');
  }
  return dest;
}

/**
 * Refresh the stand-ins in the app-managed env (the one setup built).
 * A configured python that is not the managed env's is the user's own
 * install — never write into it. Failures are swallowed: a stale shim
 * must not block a conversion that would otherwise run.
 */
function refreshShimsIfManaged(cfg) {
  try {
    if (cfg && cfg.python && path.resolve(cfg.python) === path.resolve(envPython())) {
      installShims();
      return true;
    }
  } catch {
    /* best effort only */
  }
  return false;
}

/**
 * The real gate: import the inference module exactly as conversion will
 * (same interpreter, its own folder as cwd). Also reports CUDA visibility.
 */
async function verifyEnv(home, { onLog = () => {}, registerChild } = {}) {
  const py = envPython();
  const inferenceDir = path.join(home, path.dirname(INFERENCE_REL));
  await runStreaming(py, ['-c', 'import inference_shape2code_point_input; print("inference module imports cleanly")'], {
    cwd: inferenceDir,
    onLog,
    registerChild,
  });
  let cuda = false;
  try {
    const r = spawnSync(py, ['-c', 'import torch; print(torch.cuda.is_available())'], { encoding: 'utf8', windowsHide: true });
    cuda = /True/.test(r.stdout || '');
  } catch {
    /* reported as false below */
  }
  return { cuda };
}

module.exports = { loadConfig, saveConfig, isConfigured, convertToCode, configPath, detect, detectAndSave, findHome, findPython, downloadDest, cloneRepo, REPO_URL, envDir, envPython, checkpointsPresent, checkpointPlan, findBasePython310, installPython310, createEnv, installSteps, runStreaming, downloadCheckpoints, verifyEnv, sitePackagesDir, installShims, refreshShimsIfManaged, HF_REPO };
