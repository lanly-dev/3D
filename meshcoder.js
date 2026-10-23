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
 * Expected layout under MESHCODER_HOME (per MeshCoder's README):
 *   llama-3-models/Llama3.2-1B/           base model
 *   llama-3-models/object_to_code_model/  shape tokenizer + LoRA checkpoint
 *   recipes/inference/local_inference/custom_inference/inference_shape2code_point_input.py
 */
const { app } = require('electron');
const { spawn } = require('child_process');
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
 * Writes `<mesh name>.blender.py` next to the mesh and resolves with its path.
 */
async function convertToCode(meshPath) {
  const cfg = loadConfig();
  if (!isConfigured(cfg)) {
    throw new Error(
      'MeshCoder is not configured. Set MESHCODER_HOME / MESHCODER_PYTHON ' +
        `or edit ${configPath()} — see the MeshCoder section of the README.`
    );
  }
  const dir = path.dirname(meshPath);
  const base = path.basename(meshPath, path.extname(meshPath));
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

module.exports = { loadConfig, isConfigured, convertToCode, configPath };
