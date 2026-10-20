# Hunyuan3D Desktop

A personal desktop wrapper for the Hunyuan3D web app (`https://3d.hunyuan.tencent.com/`).

## Why

The site's login session dies constantly in a VS Code webview (webviews don't
persist cookies and extensions can't save/restore them). This app keeps the
session alive with a persistent Chromium profile, the same way Chrome does.

## What it does

- Loads the Hunyuan3D web app in its own window, next to a collapsible
  asset-management sidebar.
- Persists cookies/localStorage across restarts (session partition
  `persist:hunyuan3d`) — log in once, stay logged in until Tencent expires
  the session server-side.
- Login popups (QQ/WeChat) open in in-app windows sharing the session;
  other external links open in your system browser.
- Model downloads (GLB/OBJ) auto-save to the active workspace's folder with a
  completion notification.
- **Workspaces** — named projects that own a folder; the active one decides
  where downloads and generated Blender code are written. See below.
- Menu: **Navigate** (Back / Forward / Reload / DevTools),
  **Hunyuan3D → Home**, **View** (toggle/resize sidebar, scan folders),
  **Workspaces** (switch/create/reveal), and **Clear session & restart** for
  when a login gets wedged.

It does not automate anything — no page scripting, no auto-clicking. You use
the site yourself; the app just stops it from forgetting you.

## Asset sidebar (manage your models)

The app window is split into two panes: the Hunyuan3D site on the right and a
**collapsible asset dashboard** on the left.

The sidebar keeps an index of everything the app has produced or imported, so
you have one place to look at your models instead of hunting through
`Downloads`.

- **Stats** — asset / model / script counts and total size on disk.
- **Live list** — every tracked asset with its size and last-modified time.
  Downloads are registered automatically the moment they finish.
- **Filter** — a text filter plus a kind dropdown (Models / Blender code / All).
- **Actions per asset** — `Reveal` (open in Explorer), `Open` (open with the
  system default app), `To Blender` (run MeshCoder on that mesh), `Move to…`
  (reassign the asset to a workspace), `Untrack` (drop it from the index — the
  file on disk is *not* deleted).
- **Workspace filter** — a dropdown at the top scopes the list to one
  workspace, *All workspaces*, or *Unassigned*.
- **Scan** — pull in model files that already sit in your Downloads folder.
  This also runs automatically the first time you launch the app.

### Collapsing and resizing

| Action | How |
| --- | --- |
| Collapse / expand | The `❯` / `❮` button in the sidebar header, or **Ctrl+B** |
| Resize | Drag the right edge of the sidebar (200–520 px) |
| Wider / narrower | **Ctrl+Alt+]** / **Ctrl+Alt+[** |

The width and collapsed state are remembered between launches.

## Workspaces

A **workspace** is a named project that owns a folder and groups the assets
belonging to it. Switching the active workspace changes where the app saves
things:

- **Downloads** from the Hunyuan3D site land in the active workspace's folder
  (falling back to your normal Downloads folder if the workspace has none).
- **MeshCoder output** — the generated `<name>.blender.py` — is written into
  the owning workspace's folder rather than next to the mesh.
- **Scanning** (`Ctrl+Shift+F`) looks in the active workspace's folder.

Every asset row shows its workspace as a purple tag, and a **Move to…**
dropdown reassigns an asset to another workspace. The workspace dropdown at
the top of the sidebar filters the list (including an *Unassigned* bucket for
assets that don't belong to any workspace yet).

### Managing workspaces

- **Sidebar** — the dropdown at the top filters; **+** creates a new one; the
  **⋯** button edits the current one (name, folder, notes).
- **Menu → Workspaces** — switch the active workspace, create one, change its
  folder, or open its folder in Explorer.

Workspaces are stored in `<userData>/workspaces.json`. The first workspace is
created automatically and points at your Downloads folder, so the app behaves
exactly as it did before workspaces existed.

### Where the data lives

| File | Contents |
| --- | --- |
| `<userData>/assets.json` | The asset index (paths, sizes, kinds, workspace) |
| `<userData>/workspaces.json` | Workspaces + which one is active |
| `<userData>/layout.json` | Sidebar width + visibility |

All of them live in Electron's `userData` folder. **View → Reveal asset store**
opens it in Explorer. Untracking an asset never touches the file on disk — it
only removes the entry from the index.

## MeshCoder: mesh → editable Blender code (optional)

[MeshCoder](https://github.com/InternRobotics/MeshCoder) (MIT) converts a
point cloud into a **part-segmented Blender Python script** — a generated
mesh stops being a fused blob and becomes code you can edit, repose, and
split into parts. The app wires it in as one extra step:

1. Download a model in the app as usual.
2. **Tools → Convert last download to Blender code (MeshCoder).**
3. The app samples the mesh into a point cloud (`mesh-to-npz.py`), runs
   MeshCoder's inference on your GPU, and saves `<model name>.blender.py` in
   the owning workspace's folder. Run that script inside Blender 4.x to
   rebuild the model as editable parts.

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
