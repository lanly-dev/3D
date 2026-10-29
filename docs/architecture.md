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
| `assets.js` | Tracked asset index (models, scripts, workspaces) |
| `workspaces.js` | Named project folders + active workspace |
| `meshcoder.js` | Calls MeshCoder inference on a mesh |
| `glb2ts.mjs` | Model → self-contained TypeScript module (Three.js runtime rebuild, textures embedded) |
| `mesh-to-npz.py` | Samples a mesh into a point cloud for MeshCoder |
| `sidebar.html` / `sidebar.js` / `sidebar-preload.js` / `sidebar.css` | Left asset sidebar UI |
| `mixamo-export.html` / `mixamo-export.js` | Hidden worker page: re-export a model's geometry as OBJ for Mixamo's character upload |
| `package.json` | Scripts: `npm start`, `npm run package-win` |

The content area hosts three site tabs, switched from the nav bar: Hunyuan3D (`persist:hunyuan3d`), Mixamo (`persist:mixamo`, its own Adobe ID login), and Poly Pizza (`persist:polypizza`, free premade low-poly models with direct .glb downloads). Downloads from any session land in the active workspace and are tracked as assets. "Prepare for Mixamo upload" (asset context menu / Tools) writes `<name>.mixamo.obj` next to the model; the viewer plays animation clips carried by FBX/GLB files (Mixamo downloads) with a play/pause + clip-picker bar.

## Conventions

- Persistence goes in Electron `userData` (e.g. `assets.json`, `workspaces.json`).
- Untracking an asset never touches the file on disk.
- MeshCoder output: `<name>.blender.py` next to the mesh, run inside Blender 4.x.

## Common gotchas

- `bpy.path.abspath()` resolves against the `.blend` file, not the script — use script-relative paths in generated code.
- MeshCoder scripts usually guard their entry point with `if __name__ == "__main__":` — re-executed scripts must run with `__name__ == "__main__"`.
- SmartScreen warns on unsigned Windows builds; click "More info → Run anyway".
