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
async function convertToCode(meshPath, outDir) {
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
    await run(cfg.python, [path.join(__dirname, 'mesh-to-npz.py'), meshPath, npzPath]);

    // 2. NPZ -> Blender code (MeshCoder single-GPU inference)
    const modelDir = path.join(cfg.home, 'llama-3-models');
    await run(
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

module.exports = { loadConfig, saveConfig, isConfigured, convertToCode, configPath, detect, detectAndSave, findHome, findPython, downloadDest, cloneRepo, REPO_URL };
