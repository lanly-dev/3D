/**
 * Local rigging engine (main process) — app-managed RigAnything.
 *
 * Backs the asset menu's "Rig (local)": turns a fused, unrigged model
 * (.glb/.obj) into a rigged GLB with a skeleton and skinning weights,
 * plus the .npz (joints + weights) that later pipeline stages consume.
 *
 * The engine is NOT bundled with the app. On first use the app offers
 * a one-click install that builds a self-contained runtime under
 * <userData>/rig-engine/:
 *
 *   python/       portable Python 3.11 (python.org embeddable build)
 *   RigAnything/  the RigAnything repo, with ckpt/riganything_ckpt.pt
 *   state.json    which install steps have completed (resume marker)
 *   jobs/         one folder per rig run (staged input, outputs, log)
 *   install.log   the install transcript
 *
 * No terminal, no Conda: the app downloads and drives everything.
 * Install steps are idempotent — a step already marked done in
 * state.json (and whose files are still on disk) is skipped, so an
 * interrupted install resumes where it stopped.
 *
 * RigAnything itself is Adobe Research code under a noncommercial
 * research license — fine for local experimentation; the engine
 * boundary here (status/install/run over a folder of files) is what
 * a future MIT-licensed rigger (e.g. UniRig) would slot into.
 *
 * This module is pure Node (no Electron) so it can be tested
 * standalone; main.js supplies the root dir and status callbacks.
 * Test hooks: the factory accepts injected exec/download/platform.
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const PYTHON_VERSION = '3.11.9';
const PYTHON_ZIP_URL = `https://www.python.org/ftp/python/${PYTHON_VERSION}/python-${PYTHON_VERSION}-embed-amd64.zip`;
const GET_PIP_URL = 'https://bootstrap.pypa.io/get-pip.py';
const TORCH_INDEX_URL = 'https://download.pytorch.org/whl/cu126';
const REPO_ZIP_URL = 'https://github.com/Isabella98Liu/RigAnything/archive/refs/heads/main.zip';
const CKPT_URL = 'https://huggingface.co/Isabellaliu/RigAnything/resolve/main/riganything_ckpt.pt';
const SIMPLIFY_COUNT = 8192; // RigAnything's own example target face count
const EXEC_TIMEOUT_MS = 30 * 60 * 1000; // pip's torch download is the long pole
const RIG_EXTS = ['.glb', '.obj'];

function defaultDownload(url, dest) {
  return fetch(url, { redirect: 'follow' }).then(async (res) => {
    if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`);
    const tmp = `${dest}.part`;
    const out = fs.createWriteStream(tmp);
    const { Readable } = require('stream');
    await require('stream/promises').pipeline(Readable.fromWeb(res.body), out);
    fs.renameSync(tmp, dest);
  });
}

function defaultExec(file, args, opts) {
  return new Promise((resolve) => {
    execFile(file, args, {
      cwd: opts.cwd,
      timeout: opts.timeout || EXEC_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0,
        out: `${stdout || ''}${stderr || ''}`,
        error: err ? String(err.message || err) : '',
      });
    });
  });
}

function createRigEngine(opts) {
  const rootDir = opts.rootDir;
  const platform = opts.platform || process.platform;
  const runExec = opts.execFile || defaultExec;
  const download = opts.download || defaultDownload;
  const onLog = typeof opts.onLog === 'function' ? opts.onLog : () => {};

  const pythonDir = path.join(rootDir, 'python');
  const pythonExe = path.join(pythonDir, platform === 'win32' ? 'python.exe' : 'python');
  const repoDir = path.join(rootDir, 'RigAnything');
  const ckptPath = path.join(repoDir, 'ckpt', 'riganything_ckpt.pt');
  const statePath = path.join(rootDir, 'state.json');
  const installLogPath = path.join(rootDir, 'install.log');

  let busy = false; // one install or rig run at a time

  function readState() {
    try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { return { steps: {} }; }
  }
  function markStep(id) {
    const s = readState();
    s.steps = s.steps || {};
    s.steps[id] = new Date().toISOString();
    fs.mkdirSync(rootDir, { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(s, null, 2));
  }
  function log(line) {
    onLog(line);
    try {
      fs.mkdirSync(rootDir, { recursive: true });
      fs.appendFileSync(installLogPath, `${line}\n`);
    } catch { /* logging must never break the work */ }
  }

  // Files on disk are the truth; state.json only speeds up the answer.
  function stepDone(id) {
    switch (id) {
      case 'python': return fs.existsSync(pythonExe);
      case 'torch': return fs.existsSync(path.join(pythonDir, 'Lib', 'site-packages', 'torch'))
        || fs.existsSync(path.join(pythonDir, 'lib', 'site-packages', 'torch'));
      case 'repo': return fs.existsSync(path.join(repoDir, 'inference.py'));
      case 'requirements': return Boolean(readState().steps && readState().steps.requirements)
        && fs.existsSync(path.join(repoDir, 'inference.py'));
      case 'checkpoint': return fs.existsSync(ckptPath) && fs.statSync(ckptPath).size > 0;
      default: return false;
    }
  }
  const STEP_IDS = ['python', 'torch', 'repo', 'requirements', 'checkpoint'];

  function status() {
    if (platform !== 'win32') {
      return { state: 'unsupported', reason: 'The local rigging engine installs a Windows Python runtime — it is only available on Windows.' };
    }
    const missing = STEP_IDS.filter((id) => !stepDone(id));
    if (!missing.length) return { state: 'ready' };
    return { state: missing.length === STEP_IDS.length ? 'missing' : 'partial', missing };
  }

  async function execOrThrow(file, args, cwd, label) {
    log(`$ ${file} ${args.join(' ')}`);
    const res = await runExec(file, args, { cwd });
    if (res.out) log(res.out.trimEnd().split('\n').slice(-40).join('\n'));
    if (!res.ok) throw new Error(`${label} failed (exit ${res.code})${res.error ? `: ${res.error}` : ''} — see install.log in the rig-engine folder`);
    return res;
  }

  const installSteps = [
    {
      id: 'python',
      label: 'portable Python',
      async run() {
        fs.mkdirSync(pythonDir, { recursive: true });
        const zip = path.join(rootDir, 'python-embed.zip');
        await download(PYTHON_ZIP_URL, zip);
        await execOrThrow('tar', ['-xf', zip, '-C', pythonDir], rootDir, 'Extract Python');
        fs.rmSync(zip, { force: true });
        // The embeddable build ignores site-packages until `import site`
        // is enabled in its ._pth file — pip cannot work without this.
        const pthName = fs.readdirSync(pythonDir).find((f) => /^python\d+\._pth$/.test(f));
        if (!pthName) throw new Error('Portable Python extract did not produce a ._pth file');
        const pthPath = path.join(pythonDir, pthName);
        const text = fs.readFileSync(pthPath, 'utf8');
        fs.writeFileSync(pthPath, text.replace('#import site', 'import site'));
        const getPip = path.join(rootDir, 'get-pip.py');
        await download(GET_PIP_URL, getPip);
        await execOrThrow(pythonExe, [getPip, '--no-warn-script-location'], rootDir, 'Bootstrap pip');
        fs.rmSync(getPip, { force: true });
      },
    },
    {
      id: 'torch',
      label: 'PyTorch (CUDA — the big download)',
      async run() {
        await execOrThrow(pythonExe, ['-m', 'pip', 'install', '--no-warn-script-location', 'torch', 'torchvision', '--index-url', TORCH_INDEX_URL], rootDir, 'Install PyTorch');
      },
    },
    {
      id: 'repo',
      label: 'RigAnything code',
      async run() {
        const zip = path.join(rootDir, 'riganything.zip');
        await download(REPO_ZIP_URL, zip);
        await execOrThrow('tar', ['-xf', zip, '-C', rootDir], rootDir, 'Extract RigAnything');
        fs.rmSync(zip, { force: true });
        const extracted = path.join(rootDir, 'RigAnything-main');
        if (fs.existsSync(extracted) && !fs.existsSync(repoDir)) fs.renameSync(extracted, repoDir);
        if (!fs.existsSync(path.join(repoDir, 'inference.py'))) throw new Error('RigAnything extract did not produce inference.py');
      },
    },
    {
      id: 'requirements',
      label: 'RigAnything dependencies',
      async run() {
        await execOrThrow(pythonExe, ['-m', 'pip', 'install', '--no-warn-script-location', '-r', path.join(repoDir, 'requirements.txt')], rootDir, 'Install dependencies');
      },
    },
    {
      id: 'checkpoint',
      label: 'RigAnything checkpoint',
      async run() {
        fs.mkdirSync(path.dirname(ckptPath), { recursive: true });
        await download(CKPT_URL, ckptPath);
      },
    },
  ];

  /** Install (or resume installing) the engine. onStatus(stepLabel). */
  async function install(onStatus) {
    const st = status();
    if (st.state === 'unsupported') return { ok: false, message: st.reason };
    if (st.state === 'ready') return { ok: true, message: 'Rigging engine is already installed.' };
    if (busy) return { ok: false, message: 'The rigging engine is busy — try again when the current job finishes.' };
    busy = true;
    try {
      for (const step of installSteps) {
        if (stepDone(step.id)) continue;
        if (onStatus) onStatus(`Installing rigging engine: ${step.label}…`);
        log(`--- step ${step.id}: ${step.label}`);
        await step.run();
        markStep(step.id);
      }
      const after = status();
      if (after.state !== 'ready') return { ok: false, message: `Install finished but the engine is not ready (missing: ${(after.missing || []).join(', ')}) — see install.log in the rig-engine folder` };
      return { ok: true, message: 'Rigging engine installed.' };
    } catch (err) {
      return { ok: false, message: String(err && err.message ? err.message : err) };
    } finally {
      busy = false;
    }
  }

  function findOutput(dir, suffix) {
    if (!fs.existsSync(dir)) return null;
    const hit = fs.readdirSync(dir).find((f) => f.toLowerCase().endsWith(suffix));
    return hit ? path.join(dir, hit) : null;
  }

  function dedupePath(target) {
    if (!fs.existsSync(target)) return target;
    const dir = path.dirname(target);
    const ext = path.extname(target);
    const base = path.basename(target, ext);
    let n = 2;
    let candidate = path.join(dir, `${base} (${n})${ext}`);
    while (fs.existsSync(candidate)) { n += 1; candidate = path.join(dir, `${base} (${n})${ext}`); }
    return candidate;
  }

  /**
   * Rig one model file. Drives RigAnything's three documented steps
   * with the managed python (the repo's inference.sh, minus the
   * shell): simplify → infer joints/weights → export the rigged GLB.
   * Outputs land next to the source: <name>.rigged.glb + <name>.rig.npz.
   */
  async function run(filePath, onStatus) {
    const st = status();
    if (st.state === 'unsupported') return { ok: false, message: st.reason };
    if (st.state !== 'ready') return { ok: false, message: 'The rigging engine is not installed yet.' };
    if (busy) return { ok: false, message: 'A rig job is already running — one at a time.' };
    if (!fs.existsSync(filePath)) return { ok: false, message: `File not found on disk: ${path.basename(filePath)}` };
    const ext = path.extname(filePath).toLowerCase();
    if (!RIG_EXTS.includes(ext)) return { ok: false, message: `Rig (local) works on .glb and .obj models — this is ${ext || 'an unknown type'}.` };
    busy = true;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const jobDir = path.join(rootDir, 'jobs', stamp);
    const outDir = path.join(jobDir, 'outputs');
    const jobLog = path.join(jobDir, 'rig.log');
    const note = (line) => {
      try { fs.mkdirSync(jobDir, { recursive: true }); fs.appendFileSync(jobLog, `${line}\n`); } catch { /* ignore */ }
    };
    try {
      fs.mkdirSync(outDir, { recursive: true });
      const staged = path.join(jobDir, `input${ext}`);
      fs.copyFileSync(filePath, staged);
      const simplified = () => findOutput(outDir, '_simplified.glb');
      if (onStatus) onStatus('Simplifying mesh…');
      let res = await runExec(pythonExe, [path.join('inference_utils', 'mesh_simplify.py'), '--data_path', staged, '--mesh_simplify', '1', '--simplify_count', String(SIMPLIFY_COUNT), '--output_path', outDir], { cwd: repoDir });
      note(res.out || '');
      if (!res.ok || !simplified()) return { ok: false, message: `Rig failed while simplifying ${path.basename(filePath)} — log: ${jobLog}` };
      if (onStatus) onStatus('Rigging — predicting skeleton and skin weights…');
      res = await runExec(pythonExe, ['inference.py', '--config', 'config.yaml', '--load', path.join('ckpt', 'riganything_ckpt.pt'), '-s', 'inference', 'true', '-s', 'inference_out_dir', outDir, '--mesh_path', simplified()], { cwd: repoDir });
      note(res.out || '');
      const npz = findOutput(outDir, '.npz');
      if (!res.ok || !npz) return { ok: false, message: `Rig inference failed for ${path.basename(filePath)} — log: ${jobLog}` };
      if (onStatus) onStatus('Exporting the rigged model…');
      res = await runExec(pythonExe, [path.join('inference_utils', 'vis_skel.py'), '--data_path', npz, '--save_path', outDir, '--mesh_path', simplified()], { cwd: repoDir });
      note(res.out || '');
      const rigged = findOutput(outDir, '_rig.glb');
      if (!res.ok || !rigged) return { ok: false, message: `Rig export failed for ${path.basename(filePath)} — log: ${jobLog}` };
      const base = path.basename(filePath, ext);
      const dir = path.dirname(filePath);
      const riggedDest = dedupePath(path.join(dir, `${base}.rigged.glb`));
      fs.copyFileSync(rigged, riggedDest);
      const npzDest = dedupePath(path.join(dir, `${base}.rig.npz`));
      fs.copyFileSync(npz, npzDest);
      return { ok: true, riggedPath: riggedDest, npzPath: npzDest, message: `Rigged ${path.basename(filePath)} → ${path.basename(riggedDest)} (+ ${path.basename(npzDest)} for later stages)` };
    } catch (err) {
      return { ok: false, message: `Rig failed (${path.basename(filePath)}): ${String(err && err.message ? err.message : err)} — log: ${jobLog}` };
    } finally {
      busy = false;
    }
  }

  return { status, install, run, isBusy: () => busy, rootDir, repoDir, pythonExe, STEP_IDS };
}

module.exports = { createRigEngine, RIG_EXTS, SIMPLIFY_COUNT };
