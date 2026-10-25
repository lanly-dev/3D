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
  const { onLog, onPhase, registerChild, onSyntaxIssue, onGateNotes } = opts;
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
  const splitDir = path.join(tmp, 'split');

  const modelDir = path.join(cfg.home, 'llama-3-models');
  // Greedy decoding, always: the same mesh must produce the same
  // code. Correctness comes from short per-part generations plus the
  // gate below — never from re-rolling the sampler.
  const runInference = async (npzPath, destPath) => {
    if (onPhase) onPhase('generating');
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
        destPath,
        '--batch_size',
        '1',
        '--max_new_tokens',
        '12288',
        '--zero_out_normals',
        'True',
        '--do_sample',
        'False',
      ],
      { cwd: cfg.home }
    );
  };

  try {
    // 1. mesh -> one NPZ per shell, all in one global frame (trimesh
    // lives in the MeshCoder env already). A single-shell mesh yields
    // exactly one part — the classic whole-object conversion.
    if (onPhase) onPhase('sampling');
    await exec(cfg.python, [path.join(__dirname, 'mesh-to-npz.py'), meshPath, splitDir, '--split']);
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(splitDir, 'manifest.json'), 'utf8'));
    } catch {
      throw new Error('Mesh splitting produced no manifest — the mesh could not be sampled.');
    }
    const partFiles = Array.isArray(manifest.parts) ? manifest.parts : [];
    if (!partFiles.length) throw new Error('Mesh splitting found no convertible parts.');
    const gateNotes = [];
    if (partFiles.length > 1 && onLog) {
      onLog(`Split into ${partFiles.length} parts by shell — one short generation each`);
    }
    if (manifest.droppedAreaFraction >= 0.005) {
      gateNotes.push(
        `${(manifest.droppedAreaFraction * 100).toFixed(1)}% of the surface was tiny fragments and was not converted`
      );
    }

    // 2. One short generation per part. Long single generations are
    // where MeshCoder's code falls apart (fused calls, truncation);
    // per-part streams stay in the length range it handles cleanly.
    const partCodes = [];
    for (let i = 0; i < partFiles.length; i++) {
      const destPath = path.join(tmp, `part-${i + 1}.py`);
      if (partFiles.length > 1 && onLog) onLog(`Generating part ${i + 1} of ${partFiles.length}`);
      await runInference(path.join(splitDir, partFiles[i].file), destPath);
      if (!fs.existsSync(destPath)) {
        throw new Error(`MeshCoder finished but produced no code for part ${i + 1}.`);
      }
      partCodes.push(fs.readFileSync(destPath, 'utf8'));
    }

    // 3. Deterministic repair per part (the Verify-and-fix passes:
    // bracket repair, same-line splits, fused create_curve splits),
    // then assembly + the correctness gate, which validates the
    // assembled file against bpy_lib's contract and quarantines
    // anything unfixable instead of shipping it broken.
    const repairedCodes = [];
    for (let i = 0; i < partCodes.length; i++) {
      const label = partFiles.length > 1 ? `part ${i + 1}: ` : '';
      try {
        const rep = await repairSource(cfg.python, partCodes[i]);
        if (rep && rep.status === 'fixed') {
          repairedCodes.push(rep.fixed);
          for (const c of rep.changes || []) gateNotes.push(label + c);
          if (onLog) onLog(`Repair (${label.trim()}): ${(rep.changes || []).join('; ')}`);
          continue;
        }
        if (rep && rep.status === 'unfixable') {
          gateNotes.push(`${label}had damage the repair pass could not fix — the gate reviews it below`);
        }
      } catch {
        /* repair is best-effort; the gate still reviews the raw code */
      }
      repairedCodes.push(partCodes[i]);
    }
    const bpyLibPath = path.join(cfg.home, 'src', 'llama_recipes', 'blender_scripts', 'bpy_lib.py');
    const gated = await assembleAndGate(cfg.python, repairedCodes, fs.existsSync(bpyLibPath) ? bpyLibPath : '');
    let finalSource;
    if (gated && gated.source) {
      finalSource = gated.source;
      for (const n of gated.notes || []) gateNotes.push(n);
    } else {
      if (gated && gated.failed) {
        for (const n of gated.notes || []) gateNotes.push(n);
        gateNotes.push('the correctness gate could not make this file parse — delivered as generated');
      } else {
        gateNotes.push('the correctness gate did not run — delivered as generated');
      }
      finalSource = repairedCodes.join('\n');
    }
    if (partFiles.length > 1) gateNotes.unshift(`converted in ${partFiles.length} parts (split by shell)`);
    if (onGateNotes) onGateNotes(gateNotes);
    if (gateNotes.length) {
      const block = [
        '# --- Hunyuan3D conversion notes (correctness gate) ---',
        ...gateNotes.map((n) => `# ${n}`),
        '# Lines the gate removed are kept in the file as comments starting with "# [gate]".',
        '# --- end conversion notes ---',
        '',
        '',
      ].join('\n');
      finalSource = block + finalSource;
    }
    fs.writeFileSync(codePath, finalSource);

    // 4. Final parse check on what actually landed on disk. After
    // the gate this should always pass; if the gate could not run,
    // flag a bad line exactly as before — a syntax issue does not
    // fail the conversion.
    const issue = await checkSyntax(cfg.python, codePath);
    if (issue) {
      if (onLog) onLog(`Syntax check: line ${issue.line} — ${issue.message}`);
      if (onSyntaxIssue) onSyntaxIssue(issue);
    }

    // 5. Stamp the bpy_lib header (see stampBlenderHeader): without
    // it, running the script in Blender dies immediately with
    // ModuleNotFoundError: No module named 'bpy_lib'. Best-effort —
    // a stamping failure never fails the conversion.
    try {
      if (stampBlenderHeader(codePath, cfg.home) && onLog) {
        onLog('Stamped the bpy_lib path header');
      }
    } catch {
      /* header is a convenience, not a requirement */
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return codePath;
}

const HEADER_MARKER = '# --- Hunyuan3D header: bpy_lib path (auto-added) ---';

/**
 * The header prepended to every generated script. MeshCoder's code
 * starts with `from bpy_lib import *`, and bpy_lib ships inside the
 * clone (src/llama_recipes/blender_scripts) — a folder that is not on
 * Blender's sys.path, so an unstamped script dies on its first import
 * inside Blender. The header tries the clone location baked in at
 * conversion time first, then the app's managed clone location.
 */
function blenderHeader(home) {
  const scriptsDir = path.join(home || '', 'src', 'llama_recipes', 'blender_scripts');
  return [
    HEADER_MARKER,
    '# MeshCoder code does `from bpy_lib import *`; bpy_lib ships inside the',
    '# MeshCoder clone, so put its folder on sys.path before anything runs.',
    'import os as _h3d_os, sys as _h3d_sys',
    `for _h3d_p in (${JSON.stringify(scriptsDir)}, _h3d_os.path.join(_h3d_os.path.expanduser('~'), 'Documents', 'Hunyuan3D', 'MeshCoder', 'src', 'llama_recipes', 'blender_scripts')):`,
    '    if _h3d_os.path.isdir(_h3d_p) and _h3d_p not in _h3d_sys.path:',
    '        _h3d_sys.path.append(_h3d_p)',
    '# --- end Hunyuan3D header ---',
    '',
    '',
  ].join('\n');
}

/**
 * Prepend the bpy_lib header to a generated script. Idempotent: a
 * file already carrying the marker is left alone. Returns true when
 * the header was added. Only lines are added at the top — the model's
 * code below is untouched.
 */
function stampBlenderHeader(codePath, home) {
  const src = fs.readFileSync(codePath, 'utf8');
  if (src.includes(HEADER_MARKER)) return false;
  fs.writeFileSync(codePath, blenderHeader(home) + src);
  return true;
}

const SYNTAX_CHECK_SRC = [
  'import ast, sys',
  'src = sys.stdin.read()',
  'try:',
  '    ast.parse(src)',
  'except SyntaxError as e:',
  '    print("LINE", e.lineno or 0)',
  '    print("MSG", e.msg or "syntax error")',
  '    print("TEXT", (e.text or "").strip())',
  '    sys.exit(3)',
].join('\n');

/**
 * Parse Python source with the given interpreter (ast only — nothing
 * is executed or imported). Resolves with null when the source
 * parses, or { line, message, text } for the first syntax error. A
 * checker failure (python missing, odd exit) also resolves null —
 * the check must never break a conversion.
 */
function parseSource(python, source) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(python, ['-c', SYNTAX_CHECK_SRC], { windowsHide: true });
    } catch {
      return resolve(null);
    }
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      if (code === 0) return resolve(null);
      const get = (key) => {
        const m = out.match(new RegExp(`^${key} (.*)$`, 'm'));
        return m ? m[1].trim() : '';
      };
      const line = Number(get('LINE')) || 0;
      const message = get('MSG');
      if (!line && !message) return resolve(null); // the checker itself failed — stay silent
      resolve({ line, message: message || 'syntax error', text: get('TEXT') });
    });
    try {
      child.stdin.write(source);
      child.stdin.end();
    } catch {
      resolve(null);
    }
  });
}

/** checkSyntax for a file on disk — see parseSource. */
async function checkSyntax(python, codePath) {
  let source;
  try {
    source = fs.readFileSync(codePath, 'utf8');
  } catch {
    return null;
  }
  return parseSource(python, source);
}

/**
 * Repair program for generated scripts (Verify and fix). Reads the
 * source on stdin and tries, in order, the formatting failures this
 * generator actually produces — two curve loops fused into one
 * create_curve call (split back into per-loop calls whose arguments
 * satisfy bpy_lib's contract), extra or missing closing brackets,
 * two statements merged onto one line, a truncated trailing
 * statement — accepting a candidate ONLY when ast.parse accepts it,
 * so a "fix" can never make a file worse than unparseable-in-a-new-
 * way. Prints STATUS clean / STATUS unfixable, or STATUS fixed with
 * CHANGE notes and the repaired source as a byte-counted payload.
 * Nothing is executed; ast and tokenize only.
 */
const REPAIR_SRC = [
  'import ast, io, sys, tokenize',
  'src = sys.stdin.read()',
  'def parses(s):',
  '    try:',
  '        ast.parse(s)',
  '        return True',
  '    except SyntaxError:',
  '        return False',
  'def emit_fixed(fixed, notes):',
  '    data = fixed.encode("utf-8")',
  '    head = ["STATUS fixed", "CHANGES " + str(len(notes))]',
  '    for n in notes:',
  '        head.append("CHANGE " + n)',
  '    head.append("BYTES " + str(len(data)))',
  '    sys.stdout.write("\\n".join(head) + "\\n")',
  '    sys.stdout.flush()',
  '    sys.stdout.buffer.write(data)',
  '    sys.exit(0)',
  'err_line = 0',
  'try:',
  '    ast.parse(src)',
  'except SyntaxError as e:',
  '    err_line = e.lineno or 0',
  'OPEN = {"(": ")", "[": "]", "{": "}"}',
  'CLOSE = {v: k for k, v in OPEN.items()}',
  'def collect_tokens(s):',
  '    toks = []',
  '    try:',
  '        for tok in tokenize.generate_tokens(io.StringIO(s).readline):',
  '            toks.append(tok)',
  '    except Exception:',
  '        pass',
  '    return toks',
  'def bracket_scan(s):',
  '    stack = []',
  '    negatives = []',
  '    toks = collect_tokens(s)',
  '    if not toks:',
  '        return None',
  '    for tok in toks:',
  '        if tok.type != tokenize.OP:',
  '            continue',
  '        t = tok.string',
  '        if t in OPEN:',
  '            stack.append(t)',
  '        elif t in CLOSE:',
  '            if stack and stack[-1] == CLOSE[t]:',
  '                stack.pop()',
  '            elif CLOSE[t] in stack:',
  '                while stack and stack[-1] != CLOSE[t]:',
  '                    stack.pop()',
  '                stack.pop()',
  '            else:',
  '                negatives.append((tok.start[0] - 1, tok.start[1], t))',
  '    return stack, negatives',
  'def apply_rebalance(s):',
  '    scan = bracket_scan(s)',
  '    if scan is None:',
  '        return None, []',
  '    stack, negatives = scan',
  '    notes = []',
  '    lines = s.split("\\n")',
  '    if negatives:',
  '        by_line = {}',
  '        for ln, col, ch in negatives:',
  '            by_line.setdefault(ln, []).append((col, ch))',
  '        for ln, items in by_line.items():',
  '            row = lines[ln]',
  '            for col, ch in sorted(items, reverse=True):',
  '                if col < len(row) and row[col] == ch:',
  '                    row = row[:col] + row[col + 1:]',
  '            lines[ln] = row',
  '        notes.append("removed " + str(len(negatives)) + " extra closing bracket(s) on line(s) " + ", ".join(str(ln + 1) for ln in sorted(by_line)))',
  '    out = "\\n".join(lines)',
  '    if stack:',
  '        out = out + "".join(OPEN[c] for c in reversed(stack))',
  '        notes.append("closed " + str(len(stack)) + " unclosed bracket(s) at the end of the file")',
  '    if not notes:',
  '        return None, []',
  '    return out, notes',
  'def split_points(s):',
  '    toks = collect_tokens(s)',
  '    depth = 0',
  '    found = []',
  '    for i, tok in enumerate(toks):',
  '        if tok.type != tokenize.OP:',
  '            continue',
  '        if tok.string in OPEN:',
  '            depth += 1',
  '        elif tok.string in CLOSE:',
  '            depth -= 1',
  '            if depth == 0:',
  '                j = i + 1',
  '                while j < len(toks) and toks[j].type in (tokenize.NL, tokenize.COMMENT):',
  '                    j += 1',
  '                if j < len(toks):',
  '                    nt = toks[j]',
  '                    if nt.type == tokenize.NAME and nt.start[0] == tok.end[0]:',
  '                        found.append((nt.start[0] - 1, nt.start[1]))',
  '    return found',
  'def apply_split(s, ln, col):',
  '    lines = s.split("\\n")',
  '    lines[ln] = lines[ln][:col].rstrip() + "\\n" + lines[ln][col:]',
  '    return "\\n".join(lines)',
  'def scan_bracket(s, start):',
  '    depth = 0',
  '    quote = None',
  '    i = start',
  '    while i < len(s):',
  '        c = s[i]',
  '        if quote:',
  '            if c == quote:',
  '                quote = None',
  '        elif c == chr(34) or c == chr(39):',
  '            quote = c',
  '        elif c == "[":',
  '            depth += 1',
  '        elif c == "]":',
  '            depth -= 1',
  '            if depth == 0:',
  '                return s[start:i + 1], i + 1',
  '        i += 1',
  '    return None',
  'def extract_list_after(line, key):',
  '    idx = line.find(key)',
  '    if idx < 0:',
  '        return None, -1',
  '    b = line.find("[", idx)',
  '    if b < 0:',
  '        return None, -1',
  '    got = scan_bracket(line, b)',
  '    if not got:',
  '        return None, -1',
  '    try:',
  '        return ast.literal_eval(got[0]), got[1]',
  '    except Exception:',
  '        return None, -1',
  'def is_triples(g):',
  '    return isinstance(g, list) and len(g) > 0 and all(isinstance(p, list) and len(p) == 3 and all(isinstance(v, (int, float)) for v in p) for p in g)',
  'def is_triple(p):',
  '    return isinstance(p, list) and len(p) == 3 and all(isinstance(v, (int, float)) for v in p)',
  'def fit_handle(ht, n_points):',
  '    if not isinstance(ht, list) or not ht:',
  '        return None',
  '    need = 2 * (n_points - ht.count(3))',
  '    if need <= 0:',
  '        return None',
  '    if len(ht) == n_points and ht.count(3) == 0:',
  '        out = []',
  '        for t in ht:',
  '            out += [t, t]',
  '        return out',
  '    if len(ht) >= need:',
  '        return ht',
  '    return ht + [ht[-1]] * (need - len(ht))',
  'def split_fused_line(line):',
  '    ci = line.find("create_curve(")',
  '    if ci < 0:',
  '        return None',
  '    ni = line.find("name=", ci)',
  '    if ni < 0 or line[ci + 13:ni].strip() != "":',
  '        return None',
  '    names, _ = extract_list_after(line, "name=")',
  '    if not (isinstance(names, list) and len(names) == 2 and all(isinstance(n, str) for n in names)):',
  '        return None',
  '    cp, end = extract_list_after(line, "control_points=")',
  '    if cp is None:',
  '        return None',
  '    groups = None',
  '    if is_triples(cp):',
  '        rest = line[end:]',
  '        pending = []',
  '        while True:',
  '            rest = rest.lstrip(" ,")',
  '            if not rest.startswith("["):',
  '                break',
  '            got = scan_bracket(rest, 0)',
  '            if not got:',
  '                break',
  '            try:',
  '                lit = ast.literal_eval(got[0])',
  '            except Exception:',
  '                break',
  '            if is_triples(lit):',
  '                groups = [cp, lit]',
  '                break',
  '            if isinstance(lit, list) and len(lit) == 1 and is_triples(lit[0]):',
  '                groups = [cp, lit[0]]',
  '                break',
  '            if is_triple(lit):',
  '                pending.append(lit)',
  '                rest = rest[got[1]:]',
  '                continue',
  '            break',
  '        if not groups and len(pending) >= 8:',
  '            groups = [cp, pending]',
  '    elif isinstance(cp, list) and len(cp) == 2 and is_triples(cp[0]) and is_triples(cp[1]):',
  '        groups = cp',
  '    elif isinstance(cp, list) and len(cp) > 1 and is_triples(cp[0]) and all(is_triple(p) for p in cp[1:]):',
  '        groups = [cp[0], cp[1:]]',
  '    if not groups:',
  '        return None',
  '    ht, _ = extract_list_after(line, "handle_type=")',
  '    closed = "closed=True" in line',
  '    assumed = False',
  '    if ht is None and all(len(g) == 12 for g in groups):',
  '        ht = [3] * 8',
  '        closed = True',
  '        assumed = True',
  '    out = []',
  '    for name, g in zip(names, groups):',
  '        h = fit_handle(ht, len(g)) if ht is not None else None',
  '        if h is None:',
  '            return None',
  '        out.append("create_curve(name=" + repr(name) + ", control_points=" + repr(g) + ", handle_type=" + repr(h) + (", closed=True" if closed else "") + ")")',
  '    return out, assumed',
  'def fused_transform(s):',
  '    out = []',
  '    splits = 0',
  '    assumed_any = False',
  '    for line in s.split("\\n"):',
  '        got = split_fused_line(line) if "create_curve(" in line else None',
  '        if got:',
  '            new_lines, assumed = got',
  '            out.extend(new_lines)',
  '            splits += 1',
  '            assumed_any = assumed_any or assumed',
  '        else:',
  '            out.append(line)',
  '    notes = []',
  '    if splits:',
  '        notes.append("split " + str(splits) + " fused create_curve call(s) into separate per-loop calls")',
  '        if assumed_any:',
  '            notes.append("one call had lost its handle_type entirely — assumed [3]*8, the pattern its sibling loops use")',
  '    return "\\n".join(out), notes',
  'if parses(src):',
  '    fs_src, fs_notes = fused_transform(src)',
  '    if fs_src != src and parses(fs_src):',
  '        emit_fixed(fs_src, fs_notes)',
  '    print("STATUS clean")',
  '    sys.exit(0)',
  'cands = []',
  'fused_src, fused_notes = fused_transform(src)',
  'if fused_src != src:',
  '    cands.append((fused_src, fused_notes))',
  '    rb_f, rb_f_notes = apply_rebalance(fused_src)',
  '    if rb_f:',
  '        cands.append((rb_f, fused_notes + rb_f_notes))',
  'rb, rb_notes = apply_rebalance(src)',
  'if rb:',
  '    cands.append((rb, rb_notes))',
  'for (ln, col) in split_points(src)[:3]:',
  '    note = "split the statements merged on line " + str(ln + 1)',
  '    cands.append((apply_split(src, ln, col), [note]))',
  '    if rb:',
  '        cands.append((apply_split(rb, ln, col), rb_notes + [note]))',
  'lines = src.split("\\n")',
  'if not err_line or err_line >= len(lines) - 25:',
  '    for k in range(len(lines) - 1, max(len(lines) - 26, 0), -1):',
  '        cand = "\\n".join(lines[:k])',
  '        if cand.strip() and parses(cand):',
  '            cands.append((cand if cand.endswith("\\n") else cand + "\\n", ["removed " + str(len(lines) - k) + " incomplete trailing line(s) starting at line " + str(k + 1)]))',
  '            break',
  'seen = set()',
  'for cand, notes in cands:',
  '    if cand != src and cand not in seen:',
  '        seen.add(cand)',
  '        if parses(cand):',
  '            emit_fixed(cand, notes)',
  'print("STATUS unfixable")',
].join('\n');

/**
 * One repair pass (REPAIR_SRC). The passes inside are alternatives:
 * a file with both a broken tail AND fused create_curve calls gets
 * its tail dropped by one strategy, and the fused calls — which the
 * fused pass only reaches on a parseable file — survive. repairSource
 * below therefore chains passes.
 */
function repairSourceOnce(python, source) {
  return new Promise((resolve) => {
    let child;
    const chunks = [];
    try {
      child = spawn(python, ['-c', REPAIR_SRC], { windowsHide: true });
    } catch {
      return resolve(null);
    }
    child.stdout.on('data', (d) => chunks.push(d));
    child.on('error', () => resolve(null));
    child.on('close', () => {
      const buf = Buffer.concat(chunks);
      const head = buf.toString('utf8', 0, Math.min(buf.length, 4096));
      const statusMatch = head.match(/^STATUS (\w+)$/m);
      if (!statusMatch) return resolve(null);
      const status = statusMatch[1];
      if (status !== 'fixed') return resolve({ status });
      const bytesMatch = head.match(/^BYTES (\d+)$/m);
      if (!bytesMatch) return resolve(null);
      const n = Number(bytesMatch[1]);
      const bytesIdx = buf.indexOf('BYTES ');
      const nl = buf.indexOf(0x0a, bytesIdx);
      if (nl < 0 || buf.length < nl + 1 + n) return resolve(null);
      const fixed = buf.subarray(nl + 1, nl + 1 + n).toString('utf8');
      const changes = [];
      const changeRe = /^CHANGE (.*)$/gm;
      let m;
      while ((m = changeRe.exec(head)) !== null) changes.push(m[1].trim());
      resolve({ status, fixed, changes });
    });
    try {
      child.stdin.write(source);
      child.stdin.end();
    } catch {
      resolve(null);
    }
  });
}

/**
 * Repair Python source, chaining passes until one reports the file
 * clean or unfixable (max 3 passes): each pass's strategies are
 * alternatives, so a file needing two different repairs — a dropped
 * tail AND a fused-curve split — only gets both if the repaired
 * output goes through again. Resolves null when the repair tool
 * itself fails (never throws); otherwise
 * { status: 'clean' | 'unfixable' } or
 * { status: 'fixed', fixed, changes } with every pass's changes
 * accumulated. A later pass reporting 'unfixable' never discards an
 * earlier pass's successful repair.
 */
async function repairSource(python, source) {
  let current = source;
  const allChanges = [];
  for (let pass = 0; pass < 3; pass++) {
    const r = await repairSourceOnce(python, current);
    if (!r) return allChanges.length ? { status: 'fixed', fixed: current, changes: allChanges } : null;
    if (r.status === 'fixed') {
      allChanges.push(...(r.changes || []));
      current = r.fixed;
      continue;
    }
    if (allChanges.length) return { status: 'fixed', fixed: current, changes: allChanges };
    return r;
  }
  return { status: 'fixed', fixed: current, changes: allChanges };
}

/** repairSource for a file on disk. */
async function repairFile(python, codePath) {
  let source;
  try {
    source = fs.readFileSync(codePath, 'utf8');
  } catch {
    return null;
  }
  return repairSource(python, source);
}

/**
 * Assembly + correctness gate for per-part conversion output.
 * Reads a JSON request on stdin — { parts: [code, ...], bpyLib } —
 * and produces the final script:
 *   1. boilerplate (imports / delete_all) is hoisted once, at the
 *      top, no matter which part emitted it;
 *   2. with more than one part, every object name a part defines is
 *      prefixed (p1_, p2_, ...) and references inside the same part
 *      (name= / profile_name= / seq_name=) are rewritten to match, so
 *      parts cannot collide or cross-reference;
 *   3. the assembled file is validated against bpy_lib's contract —
 *      calls to functions bpy_lib does not have, and create_curve
 *      calls whose point/handle arithmetic bpy_lib would reject
 *      (including a non-string name, which silently builds nothing)
 *      are quarantined: commented out, with the reason recorded;
 *   4. if the file still does not parse, broken lines are
 *      quarantined one at a time until it does (bounded).
 * Prints NOTE lines, then STATUS ok + a byte-counted payload, or
 * STATUS failed. Nothing is executed; ast only.
 */
const GATE_SRC = [
  'import ast, json, sys',
  'req = json.loads(sys.stdin.read())',
  'parts = req.get("parts") or []',
  'bpy_path = req.get("bpyLib") or ""',
  'notes = []',
  'lib_funcs = set()',
  'if bpy_path:',
  '    try:',
  '        lib_tree = ast.parse(open(bpy_path, encoding="utf-8").read())',
  '        for n in lib_tree.body:',
  '            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)):',
  '                lib_funcs.add(n.name)',
  '    except Exception:',
  '        lib_funcs = set()',
  'BUILTINS_OK = {"print", "len", "range", "enumerate", "zip", "list", "dict", "set", "tuple", "float", "int", "str", "bool", "min", "max", "abs", "round", "sorted", "isinstance", "type", "repr"}',
  'BOILER = {"import bpy", "from math import radians, pi", "from bpy_lib import *", "delete_all()"}',
  'def scan_bracket(s, start):',
  '    depth = 0',
  '    quote = None',
  '    i = start',
  '    while i < len(s):',
  '        c = s[i]',
  '        if quote:',
  '            if c == quote:',
  '                quote = None',
  '        elif c == chr(34) or c == chr(39):',
  '            quote = c',
  '        elif c == "[":',
  '            depth += 1',
  '        elif c == "]":',
  '            depth -= 1',
  '            if depth == 0:',
  '                return s[start:i + 1], i + 1',
  '        i += 1',
  '    return None',
  'def scan_value(line, vstart):',
  '    i = vstart',
  '    while i < len(line) and line[i] == " ":',
  '        i += 1',
  '    if i >= len(line):',
  '        return None, None',
  '    if line[i] == "[":',
  '        got = scan_bracket(line, i)',
  '        if not got:',
  '            return None, None',
  '        try:',
  '            return got[1], ast.literal_eval(got[0])',
  '        except Exception:',
  '            return None, None',
  '    if line[i] == chr(34) or line[i] == chr(39):',
  '        q = line[i]',
  '        j = i + 1',
  '        while j < len(line) and line[j] != q:',
  '            j += 1',
  '        if j >= len(line):',
  '            return None, None',
  '        try:',
  '            return j + 1, ast.literal_eval(line[i:j + 1])',
  '        except Exception:',
  '            return None, None',
  '    return None, None',
  'def prefix_value(val, defined, prefix):',
  '    if isinstance(val, str):',
  '        return prefix + val if val in defined else None',
  '    if isinstance(val, list):',
  '        out = []',
  '        changed = False',
  '        for el in val:',
  '            nv = prefix_value(el, defined, prefix)',
  '            if nv is not None:',
  '                changed = True',
  '                out.append(nv)',
  '            else:',
  '                out.append(el)',
  '        return out if changed else None',
  '    return None',
  'def rewrite_kwarg(line, kw, defined, prefix):',
  '    key = kw + "="',
  '    out = []',
  '    i = 0',
  '    while True:',
  '        j = line.find(key, i)',
  '        if j < 0:',
  '            out.append(line[i:])',
  '            break',
  '        if j > 0 and (line[j - 1].isalnum() or line[j - 1] == "_"):',
  '            out.append(line[i:j + len(key)])',
  '            i = j + len(key)',
  '            continue',
  '        vend, val = scan_value(line, j + len(key))',
  '        if vend is None:',
  '            out.append(line[i:])',
  '            break',
  '        nv = prefix_value(val, defined, prefix)',
  '        out.append(line[i:j + len(key)])',
  '        out.append(repr(nv) if nv is not None else line[j + len(key):vend])',
  '        i = vend',
  '    return "".join(out)',
  'def part_defined_names(code):',
  '    defined = set()',
  '    try:',
  '        tree = ast.parse(code)',
  '    except SyntaxError:',
  '        return defined',
  '    for n in ast.walk(tree):',
  '        if isinstance(n, ast.Call) and isinstance(n.func, ast.Name):',
  '            if n.func.id.startswith("create_") or n.func.id == "join_obj":',
  '                for k in n.keywords:',
  '                    if k.arg == "name" and isinstance(k.value, ast.Constant) and isinstance(k.value.value, str):',
  '                        defined.add(k.value.value)',
  '    return defined',
  'header = []',
  'header_seen = set()',
  'assembled = []',
  'multi = len(parts) > 1',
  'for idx, code in enumerate(parts):',
  '    prefix = "p" + str(idx + 1) + "_"',
  '    defined = part_defined_names(code) if multi else set()',
  '    body = []',
  '    for ln in code.split("\\n"):',
  '        t = ln.strip()',
  '        if t in BOILER:',
  '            if t not in header_seen:',
  '                header_seen.add(t)',
  '                header.append(t)',
  '            continue',
  '        if t.startswith("# part ") or t == "# part separation":',
  '            continue',
  '        if multi and defined:',
  '            for kw in ("name", "profile_name", "seq_name"):',
  '                ln = rewrite_kwarg(ln, kw, defined, prefix)',
  '        body.append(ln)',
  '    while body and not body[0].strip():',
  '        body.pop(0)',
  '    while body and not body[-1].strip():',
  '        body.pop()',
  '    if multi:',
  '        assembled.append("# ---- part " + str(idx + 1) + " of " + str(len(parts)) + " ----")',
  '    assembled.extend(body)',
  '    assembled.append("")',
  'header = [h for h in header if h != "delete_all()"] + (["delete_all()"] if "delete_all()" in header_seen else [])',
  'source = "\\n".join(header + [""] + assembled) if header else "\\n".join(assembled)',
  'def curve_check(kw):',
  '    name = kw.get("name")',
  '    if not isinstance(name, str):',
  '        return "create_curve name is not a single string — in Blender that call silently builds nothing"',
  '    cp = kw.get("control_points")',
  '    ht = kw.get("handle_type")',
  '    if not isinstance(cp, list) or not isinstance(ht, list):',
  '        return None',
  '    if not all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in ht):',
  '        return "create_curve handle_type holds non-numeric values"',
  '    num_cp = len(cp) - ht.count(3)',
  '    if num_cp < 1:',
  '        return "create_curve point/handle counts describe no bezier point"',
  '    if len(ht) < 2 * num_cp:',
  '        return "create_curve handle_type has " + str(len(ht)) + " entries for " + str(num_cp) + " points (needs " + str(2 * num_cp) + ") — Blender would die with IndexError"',
  '    used = 0',
  '    for i in range(num_cp):',
  '        for side in (2 * i, 2 * i + 1):',
  '            t = ht[side]',
  '            if t not in (0, 1, 2, 3):',
  '                return "create_curve handle_type value " + repr(t) + " is not a known handle kind"',
  '            if t == 3:',
  '                used += 1',
  '            if side == 2 * i:',
  '                used += 1',
  '    if used != len(cp):',
  '        return "create_curve would leave " + str(len(cp) - used) + " control points unused — bpy_lib asserts on that"',
  '    return None',
  'def validate(source):',
  '    tree = ast.parse(source)',
  '    lines = source.split("\\n")',
  '    spans = []',
  '    local_defs = {n.name for n in tree.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))}',
  '    for node in tree.body:',
  '        if not isinstance(node, ast.Expr) or not isinstance(node.value, ast.Call):',
  '            continue',
  '        call = node.value',
  '        if not isinstance(call.func, ast.Name):',
  '            continue',
  '        fname = call.func.id',
  '        reason = None',
  '        if lib_funcs and fname not in lib_funcs and fname not in local_defs and fname not in BUILTINS_OK:',
  '            reason = fname + "(...) does not exist in bpy_lib — Blender would die with NameError"',
  '        elif fname == "create_curve":',
  '            kw = {}',
  '            for k in call.keywords:',
  '                try:',
  '                    kw[k.arg] = ast.literal_eval(k.value)',
  '                except Exception:',
  '                    kw[k.arg] = None',
  '            reason = curve_check(kw)',
  '        if reason:',
  '            spans.append((node.lineno - 1, (node.end_lineno or node.lineno) - 1, reason))',
  '    if not spans:',
  '        return source, True',
  '    drop = {}',
  '    for s0, e0, reason in spans:',
  '        for i in range(s0, e0 + 1):',
  '            drop[i] = reason',
  '    out = []',
  '    for i, ln in enumerate(lines):',
  '        if i in drop:',
  '            if (i - 1) not in drop:',
  '                out.append("# [gate] removed: " + drop[i])',
  '            out.append("# [gate] " + ln)',
  '            notes.append("line " + str(i + 1) + ": " + drop[i])',
  '        else:',
  '            out.append(ln)',
  '    new = "\\n".join(out)',
  '    try:',
  '        ast.parse(new)',
  '        return new, True',
  '    except SyntaxError:',
  '        return source, False',
  'def force_parseable(source):',
  '    lines = source.split("\\n")',
  '    for _ in range(30):',
  '        try:',
  '            ast.parse("\\n".join(lines))',
  '            return "\\n".join(lines)',
  '        except SyntaxError as e:',
  '            ln = (e.lineno or 1) - 1',
  '            if ln < 0 or ln >= len(lines):',
  '                return None',
  '            j = ln',
  '            while j >= 0 and (lines[j].startswith("# [gate]") or not lines[j].strip()):',
  '                j -= 1',
  '            if j < 0:',
  '                return None',
  '            lines[j] = "# [gate] " + lines[j]',
  '            notes.append("line " + str(j + 1) + ": could not be parsed (" + (e.msg or "syntax error") + ") — quarantined")',
  '    return None',
  'ok = True',
  'try:',
  '    source, ok = validate(source)',
  'except SyntaxError:',
  '    forced = force_parseable(source)',
  '    if forced is None:',
  '        ok = False',
  '    else:',
  '        source, ok = validate(forced)',
  '        if not ok:',
  '            source = forced',
  'for n in notes:',
  '    print("NOTE " + n)',
  'if not ok:',
  '    print("STATUS failed")',
  '    sys.exit(0)',
  'data = source.encode("utf-8")',
  'sys.stdout.write("STATUS ok\\nBYTES " + str(len(data)) + "\\n")',
  'sys.stdout.flush()',
  'sys.stdout.buffer.write(data)',
].join('\n');

/**
 * Assemble per-part outputs into the final script and run the
 * correctness gate (see GATE_SRC). Resolves null when the gate tool
 * itself fails; the caller then falls back to the raw parts.
 */
function assembleAndGate(python, partCodes, bpyLibPath) {
  return new Promise((resolve) => {
    let child;
    const chunks = [];
    try {
      child = spawn(python, ['-c', GATE_SRC], { windowsHide: true });
    } catch {
      return resolve(null);
    }
    child.stdout.on('data', (d) => chunks.push(d));
    child.on('error', () => resolve(null));
    child.on('close', () => {
      const buf = Buffer.concat(chunks);
      const head = buf.toString('utf8', 0, Math.min(buf.length, 65536));
      const notes = [];
      const noteRe = /^NOTE (.*)$/gm;
      let m;
      while ((m = noteRe.exec(head)) !== null) notes.push(m[1].trim());
      if (/^STATUS failed$/m.test(head)) return resolve({ failed: true, notes });
      const bytesMatch = head.match(/^BYTES (\d+)$/m);
      if (!/^STATUS ok$/m.test(head) || !bytesMatch) return resolve(null);
      const n = Number(bytesMatch[1]);
      const bytesIdx = buf.indexOf('BYTES ');
      const nl = buf.indexOf(0x0a, bytesIdx);
      if (nl < 0 || buf.length < nl + 1 + n) return resolve(null);
      resolve({ source: buf.subarray(nl + 1, nl + 1 + n).toString('utf8'), notes });
    });
    try {
      child.stdin.write(JSON.stringify({ parts: partCodes, bpyLib: bpyLibPath || '' }));
      child.stdin.end();
    } catch {
      resolve(null);
    }
  });
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

module.exports = { loadConfig, saveConfig, isConfigured, convertToCode, checkSyntax, parseSource, repairSource, repairFile, assembleAndGate, stampBlenderHeader, blenderHeader, configPath, detect, detectAndSave, findHome, findPython, downloadDest, cloneRepo, REPO_URL, envDir, envPython, checkpointsPresent, checkpointPlan, findBasePython310, installPython310, createEnv, installSteps, runStreaming, downloadCheckpoints, verifyEnv, sitePackagesDir, installShims, refreshShimsIfManaged, HF_REPO };
