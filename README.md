# Hunyuan3D Desktop

A small desktop wrapper around the Hunyuan3D web app
(`https://3d.hunyuan.tencent.com/`), with a local asset sidebar.

## What it does

- Loads the site in a real Chromium shell and keeps the login session alive
  across restarts (persistent partition `persist:hunyuan3d`).
- Login popups open in-app; other external links open in the system browser.
- Downloads (GLB/OBJ) auto-save into the active workspace folder.
- **Translate site to English** (Hunyuan3D menu) — the site ships
  Chinese-first, so this restarts the app asking for English (en-US locale
  + `Accept-Language`) and machine-translates whatever still renders in
  Chinese with a small built-in translator that calls Google Translate's
  free endpoint directly — no Google widget, no banner or floating button.
  Translated text that would overflow its button or tab is shrunk to fit
  (never below 70% of its size).
- **Navigation bar** — back / forward / reload buttons and zoom controls
  (− / % / +) under the app menu; the site defaults to 75% zoom, and the
  zoom choice persists across restarts.
- **Workspaces** — named folders that own a project and its assets.
- **Asset sidebar** — an index of tracked models and generated scripts, with
  filters, per-asset actions, and a workspace scope. Double-click a name
  to rename the file in place (a model's companion script is renamed
  along with it); clicking the status line copies its message; right-click
  a row for **Show in Explorer**, **Verify and fix** (generated Python
  scripts only: re-runs the syntax check and repairs the formatting
  failures this generator produces — two curve loops fused into one
  `create_curve` call (split back into per-loop calls; this one is
  valid syntax but silently builds nothing in Blender, so it is
  fixed even when the file parses), bracket balance, statements
  merged onto one line, a truncated tail — keeping a `<file>.orig`
  backup; a repair is written only when the result parses), **Delete file**
  (moves it to the Recycle Bin, with
  confirmation), or **Remove from list**. **F12** toggles DevTools on
  the focused view.
- **3D viewer** — clicking a model opens it in an in-app viewer (Three.js)
  instead of the machine's default app: orbit / zoom / pan, wireframe,
  auto-rotate, grid, and camera reset. Supports GLB, GLTF, OBJ, STL, PLY
  and FBX; other files still open with the default app. Model rows also
  get a small rendered thumbnail (cached under userData `thumbs/`),
  generated in the background on first sight.
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

- **Menu** — *Tools → Compound active workspace*, *Tools → Reveal parts library file*.
- **Sidebar** — the *Compounding engine* panel, with **Compound build** and
  **Library file** buttons.

Compound scripts are excluded from later builds' reuse chain, so the chain
stays bounded.

## Workspaces

A workspace is a named project that owns a folder. The active one decides
where downloads and generated code are written. An asset belongs to a
workspace purely because its file sits in that folder — an asset's
**Move to…** action physically moves the file (to Unassigned it goes to
`Documents/Hunyuan3D/Unassigned`). Manage workspaces from the sidebar
dropdown, the **+** / **⋯** buttons, or **Menu → Workspaces**. Stored in
`<userData>/workspaces.json`.

## Where the data lives

| File | Contents |
| --- | --- |
| `<userData>/assets.json` | Asset index |
| `<userData>/workspaces.json` | Workspaces + active one |
| `<userData>/compounding.json` | Part library + build history |
| `<userData>/layout.json` | Sidebar width + visibility |

**View → Reveal asset index file** opens the folder. Untracking an asset never
touches the file on disk.

## MeshCoder setup (optional)

MeshCoder runs in its own Python env (needs a CUDA GPU) — it does not run
inside Electron.

**Automatic (native Windows):** **Tools → Set up MeshCoder automatically…**
(or accept the offer when a conversion finds MeshCoder missing). The app
clones the code into `Documents/Hunyuan3D/MeshCoder` if needed, creates a
Python 3.10 venv in `Documents/Hunyuan3D/MeshCoderEnv` (installing Python
3.10 itself if none is found), pip-installs the packages, downloads the
checkpoints from Hugging Face, and verifies by importing the inference
module. Two gaps in MeshCoder's recipe are bridged with stand-ins in
`meshcoder-shim/`: `pytorch3d` (no Windows builds; the setup installs a
functional pure-PyTorch implementation of the three pieces the import
chain touches) and `bpy` (4.0.0 was never published to PyPI; a
stand-in makes `bpy.ops.*` calls no-ops). Inference always runs
MeshCoder's reconstruction scoring after generating the code, and
that scoring cannot run on native Windows (it time-limits each script
with the Unix-only SIGALRM), so conversions skip the score — the
generated `.blender.py` is still written; only the Chamfer-distance
metrics in MeshCoder's own eval output are absent.
`accelerate` is pinned to 1.11.0, the last line whose `accelerate.utils`
still exports a name MeshCoder imports. The checkpoints
are gated: submit the one-time access form on the
[Hugging Face model page](https://huggingface.co/InternRobotics/MeshCoder)
first, then paste a token into the setup window — it is used once and never
saved.

**Manual:** clone MeshCoder anywhere in the usual folders, create an env
with its dependencies (Python 3.10, PyTorch 2.4.1 + CUDA 11.8; their README
uses conda), and download the checkpoints into
`MeshCoder/llama-3-models/`: `Llama3.2-1B/` (base model) and
`object_to_code_model/` (tokenizer + LoRA). Then point the app at it via
**Tools → Open MeshCoder config** (`home`, `python`) or the
`MESHCODER_HOME` / `MESHCODER_PYTHON` env vars — or let
**Tools → Detect MeshCoder automatically** find the clone and an env with
torch + trimesh and save them to the config.

Then use **Tools → Convert last download to Blender code**, or the **To
Blender** button on a mesh row. Conversions are built for correctness,
not luck: decoding is deterministic, and the mesh is first split into
its shells (connected components) so MeshCoder generates **one short
program per part** in a single shared coordinate frame — long
whole-object generations are where its code falls apart (fused calls,
truncation). A mesh that arrives as one welded shell is instead cut
at its **necks**: local thickness is measured per face (inward ray
casts), thick regions separated by thin junctions become the parts,
and every face is regrown into its nearest part so borders land
mid-neck. When no clear necks exist, the mesh converts whole,
exactly as before.
Each part's object names are prefixed (`p1_`, `p2_`, …) so parts
can't collide, the parts are assembled under one header, and the
result passes a **correctness gate**: the deterministic formatting
repairs run first, then every call is validated against `bpy_lib`'s
real contract — calls to functions `bpy_lib` doesn't have, and
`create_curve` calls whose point/handle arithmetic it would reject,
are commented out (`# [gate]`) with the reason recorded in a notes
block at the top of the file instead of being shipped broken. The
status bar reports the part count and gate activity. The file also
gets a small header stamped at the top that puts the MeshCoder
clone's `blender_scripts` folder on `sys.path` — without it, Blender
can't resolve the script's `from bpy_lib import *` and dies with
`ModuleNotFoundError`. Shells under 1% of the total surface are
treated as fragments and skipped (noted in the file). After
hand-fixing a line, right-click the script's row and choose
**Verify and fix** to re-run the repair + validation on demand
(backing the original up as `<file>.orig`).

One more one-time step on the Blender side: `bpy_lib` imports
`torch`, which Blender's Python doesn't ship. **Tools → Prepare
Blender for MeshCoder scripts…** finds your Blender install
(including Microsoft Store installs — looked up as app packages,
with the `blender.exe` app alias as a fallback, and each probe's
result written to the window's log), adds CPU-only torch (~200 MB)
to Blender's per-user
modules folder (the Blender install itself is untouched, no admin
needed), and verifies by having Blender import `bpy_lib` headless.
For Store installs, Windows protects the package folder and blocks
outside processes from launching its exe, so the install never
launches Blender at all: the MeshCoder env's pip downloads torch
wheels built for Blender's own Python version (foreign-target
install) into the modules folder. Verification still tries to
launch Blender headless (with shell and PowerShell Start-Process
fallbacks); if Store activation prevents even that, the prep
reports "installed — verify in Blender" instead of failing. If
torch is found but its DLLs fail to initialize inside Blender
(WinError 1114), the prep probes `c10.dll` in a neutral process to
tell a DLL conflict (it sets `KMP_DUPLICATE_LIB_OK=TRUE` for the
classic duplicate-OpenMP clash; restart Blender afterwards) from a
missing Visual C++ runtime (it points at the installer). That probe
also runs on its own every prep — Store verification may never
launch Blender, and the DLL verdict (healthy vs missing runtime)
doesn't depend on it; on Store installs a healthy DLL gets the
OpenMP allowance set up front. The prep
also writes a small startup script into Blender's per-user
`scripts\startup` folder that puts the MeshCoder clone's
`blender_scripts` folder on `sys.path` at every Blender launch —
so generated scripts run with no console line and no reliance on
the header stamped into newer conversions.

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
