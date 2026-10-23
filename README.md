# Hunyuan3D Desktop

A small desktop wrapper around the Hunyuan3D web app
(`https://3d.hunyuan.tencent.com/`), with a local asset sidebar.

## What it does

- Loads the site in a real Chromium shell and keeps the login session alive
  across restarts (persistent partition `persist:hunyuan3d`).
- Login popups open in-app; other external links open in the system browser.
- Downloads (GLB/OBJ) auto-save into the active workspace folder.
- **Workspaces** — named folders that own a project and its assets.
- **Asset sidebar** — an index of tracked models and generated scripts, with
  filters, per-asset actions, and a workspace scope.
- **MeshCoder** (optional) — converts a mesh into part-segmented, editable
  Blender Python code using a local MeshCoder install.
- **Compounding engine** — accumulates the parts produced by every conversion
  into a reusable library, and can compound a workspace into a single Blender
  scene script that re-uses earlier work instead of regenerating it.

It does not automate the site — no page scripting, no auto-clicking.

## Compounding engine

Every MeshCoder conversion is harvested for part names and added to a
persistent library (`<userData>/compounding.json`). The sidebar shows the
accumulated parts; **Compound build** writes `<workspace>.compound.py`, a
Blender 4.x script that imports the tracked meshes and re-executes the
previously generated scripts, so each build accumulates on the last.

- **Menu** — *Tools → Compound active workspace*, *Tools → Reveal compounding store*.
- **Sidebar** — the *Compounding engine* panel, with **Compound build** and
  **Store** buttons.

Compound scripts are excluded from later builds' reuse chain, so the chain
stays bounded.

## Workspaces

A workspace is a named project that owns a folder. The active one decides
where downloads and generated code are written. Manage them from the sidebar
dropdown, the **+** / **⋯** buttons, or **Menu → Workspaces**. Stored in
`<userData>/workspaces.json`.

## Where the data lives

| File | Contents |
| --- | --- |
| `<userData>/assets.json` | Asset index |
| `<userData>/workspaces.json` | Workspaces + active one |
| `<userData>/compounding.json` | Part library + build history |
| `<userData>/layout.json` | Sidebar width + visibility |

**View → Reveal asset store** opens the folder. Untracking an asset never
touches the file on disk.

## MeshCoder setup (optional)

MeshCoder runs in its own Python env (needs a CUDA GPU) — it does not run
inside Electron.

1. Clone MeshCoder and create its conda env per its README (Python 3.10,
   PyTorch 2.4.1 + CUDA 11.8). WSL2 is the smoother path on Windows.
2. Download the checkpoints into `MeshCoder/llama-3-models/`:
   `Llama3.2-1B/` (base model) and `object_to_code_model/` (tokenizer + LoRA).
3. Point the app at it via **Tools → Open MeshCoder config** (`home`, `python`)
   or the `MESHCODER_HOME` / `MESHCODER_PYTHON` env vars.

Then use **Tools → Convert last download to Blender code**, or the **To
Blender** button on a mesh row.

MeshCoder was trained on human-made objects, so AI-generated meshes are
out-of-distribution — expect approximate results, and convert one part at a
time (a limb, a torso) rather than a whole fused character.

## Run

```sh
npm install
npm start
```

## Package for Windows

```sh
npm run package-win
```

Output: `dist/Hunyuan3D-win32-x64/`. The build is unsigned — on first launch
SmartScreen will warn; click **More info → Run anyway**.
