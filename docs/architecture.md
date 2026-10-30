# Architecture

## What this is

A desktop wrapper around the Hunyuan3D web app (`https://3d.hunyuan.tencent.com/`).
Keeps the login session alive across restarts, tracks downloaded models in
workspaces, converts them to Three.js code (glb2ts), and prepares them for
Mixamo.

## Stack

- Electron (main + preload + renderer)
- Node.js / CommonJS
- Three.js (in-app viewer and the glb2ts code conversion)

## Key files

| File | Purpose |
|------|---------|
| `main.js` | Electron main process: windows, menu, IPC, downloads, conversions |
| `assets.js` | Tracked asset index (models, scripts, workspaces) |
| `workspaces.js` | Named project folders + active workspace |
| `glb2ts.mjs` | Model → self-contained TypeScript module (Three.js runtime rebuild, textures embedded) |
| `sidebar.html` / `sidebar.js` / `sidebar-preload.js` / `sidebar.css` | Left asset sidebar UI |
| `mixamo-export.html` / `mixamo-export.js` | Hidden worker page: re-export a model's geometry as OBJ for Mixamo's character upload |
| `formats.html` / `formats.css` | Static 3D format guide window (Help menu): what each download format keeps and is for |
| `package.json` | Scripts: `npm start`, `npm run package-win` |

The content area hosts three site tabs, switched from the nav bar: Hunyuan3D (`persist:hunyuan3d`), Mixamo (`persist:mixamo`, its own Adobe ID login), and Poly Pizza (`persist:polypizza`, free premade low-poly models with direct .glb downloads). Downloads from any session land in the active workspace and are tracked as assets. "Prepare for Mixamo upload" (asset context menu / Tools) writes `<name>.mixamo.obj` next to the model; the viewer plays animation clips carried by FBX/GLB files (Mixamo downloads) with a play/pause + clip-picker bar.

## Conventions

- Persistence goes in Electron `userData` (e.g. `assets.json`, `workspaces.json`).
- Untracking an asset never touches the file on disk.

## Common gotchas

- SmartScreen warns on unsigned Windows builds; click "More info → Run anyway".
