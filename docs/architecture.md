# Architecture

## What this is

A desktop wrapper around the Hunyuan3D web app (`https://3d.hunyuan.tencent.com/`).
Keeps the login session alive across restarts, tracks downloaded models, and runs
MeshCoder to turn meshes into editable Blender Python code.

## Stack

- Electron (main + preload + renderer)
- Node.js / CommonJS
- Blender 4.x (for running generated Python)
- MeshCoder (separate Python env with CUDA; not inside Electron)

## Key files

| File | Purpose |
|------|---------|
| `main.js` | Electron main process: windows, menu, IPC, downloads, MeshCoder conversion |
| `compounding.js` | Part library + compound Blender script generation |
| `assets.js` | Tracked asset index (models, scripts, workspaces) |
| `workspaces.js` | Named project folders + active workspace |
| `meshcoder.js` | Calls MeshCoder inference on a mesh |
| `mesh-to-npz.py` | Samples a mesh into a point cloud for MeshCoder |
| `sidebar.html` / `sidebar.js` / `sidebar-preload.js` / `sidebar.css` | Left asset sidebar UI |
| `package.json` | Scripts: `npm start`, `npm run package-win` |

## Conventions

- Persistence goes in Electron `userData` (e.g. `assets.json`, `compounding.json`, `workspaces.json`).
- Untracking an asset never touches the file on disk.
- MeshCoder output: `<name>.blender.py` next to the mesh, run inside Blender 4.x.
- Compound builds: `<workspace>.compound.py`; excludes prior `.compound.py` scripts from reuse.

## Common gotchas

- `bpy.path.abspath()` resolves against the `.blend` file, not the script — use script-relative paths in generated code.
- MeshCoder scripts usually guard their entry point with `if __name__ == "__main__":` — re-executed scripts must run with `__name__ == "__main__"`.
- SmartScreen warns on unsigned Windows builds; click "More info → Run anyway".
