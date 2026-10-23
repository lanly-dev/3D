# Hunyuan3D Desktop

A personal desktop wrapper for the Hunyuan3D web app (`https://3d.hunyuan.tencent.com/`).

## Why

The site's login session dies constantly in a VS Code webview (webviews don't
persist cookies and extensions can't save/restore them). This app keeps the
session alive with a persistent Chromium profile, the same way Chrome does.

## What it does

- Loads the Hunyuan3D web app in its own window.
- Persists cookies/localStorage across restarts (session partition
  `persist:hunyuan3d`) — log in once, stay logged in until Tencent expires
  the session server-side.
- Login popups (QQ/WeChat) open in in-app windows sharing the session;
  other external links open in your system browser.
- Model downloads (GLB/OBJ) auto-save to your Downloads folder with a
  completion notification.
- Menu: **Navigate** (Back / Forward / Reload / DevTools),
  **Hunyuan3D → Home**, and **Clear session & restart** for when a login
  gets wedged.
- Menu option **Hunyuan3D → Translate site to English**: the site ships
  Chinese-first, so this restarts the app asking for English (en-US locale
  + `Accept-Language`) and machine-translates whatever still renders in
  Chinese, in place, via Google Translate's widget. It's machine
  translation — good enough for buttons and labels, occasionally odd for
  longer text. Toggle it off and the app restarts back to normal.

It does not automate anything — no page scripting, no auto-clicking. You use
the site yourself; the app just stops it from forgetting you.

## MeshCoder: mesh → editable Blender code (optional)

[MeshCoder](https://github.com/InternRobotics/MeshCoder) (MIT) converts a
point cloud into a **part-segmented Blender Python script** — a generated
mesh stops being a fused blob and becomes code you can edit, repose, and
split into parts. The app wires it in as one extra step:

1. Download a model in the app as usual.
2. **Tools → Convert last download to Blender code (MeshCoder).**
3. The app samples the mesh into a point cloud (`mesh-to-npz.py`), runs
   MeshCoder's inference on your GPU, and saves `<model name>.blender.py`
   next to the download. Run that script inside Blender 4.x to rebuild the
   model as editable parts.

### One-time setup (on the Windows machine)

MeshCoder runs in its own Python env — it does not run inside Electron.

1. Clone MeshCoder and create its conda env per its README — Python 3.10,
   PyTorch 2.4.1 + CUDA 11.8. (Tested upstream on Linux; on Windows expect
   some dependency friction — WSL2 is the smoother path if conda fights you.)
2. Download the checkpoints from Hugging Face and place them:
   - shape tokenizer + LoRA files → `MeshCoder/llama-3-models/object_to_code_model/`
   - base model → `MeshCoder/llama-3-models/Llama3.2-1B/`
3. Point the app at it: **Tools → Open MeshCoder config** and set
   `"home"` (the clone path) and `"python"` (the env's python) — or set the
   `MESHCODER_HOME` / `MESHCODER_PYTHON` environment variables.

### Honest limits

MeshCoder was trained on human-made objects (Infinigen). AI-generated
meshes — Hunyuan3D's included — are out-of-distribution, and its authors
say the same about TRELLIS outputs: expect approximate reconstructions,
better on some parts than others. Convert **one part at a time** (a limb,
a torso) rather than a whole fused character for the best results.

## Run (dev)

```sh
npm install
npm start
```

## Package for Windows

```sh
npm run package-win
```

Output: `dist/Hunyuan3D-win32-x64/`. Zip it and move it to the Windows
machine. The build is unsigned — on first launch SmartScreen will say
"Windows protected your PC"; click **More info → Run anyway**.
