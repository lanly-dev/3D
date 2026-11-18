# Architecture

## What this is

3D Kits (renamed from Hunyuan3D Desktop on 2026-11-01) — a desktop workshop around the Hunyuan3D web app (`https://3d.hunyuan.tencent.com/`) and friends. The packaged build pins its userData to the pre-rename `Hunyuan3D` folder so the rename doesn't strand logins or the asset index.
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
| `updater.js` | Self-update for the sidebar's Update button: `git pull --ff-only` in a checkout, else a file sync from GitHub main; package.json changes never auto-restart |
| `rig.js` | Local rigging engine (RigAnything), app-managed: one-click resumable install of a portable Python + PyTorch + checkpoint under `<userData>/rig-engine/`; drives RigAnything's simplify → inference → export steps and writes `<name>.rigged.glb` + `<name>.rig.npz` next to the source model |
| `glb2ts.mjs` | Model → self-contained TypeScript module (Three.js runtime rebuild, textures embedded) |
| `sidebar.html` / `sidebar.js` / `sidebar-preload.js` / `sidebar.css` | Left asset sidebar UI |
| `mixamo-export.html` / `mixamo-export.js` | Hidden worker page: re-export a model's geometry as OBJ for Mixamo's character upload |
| `formats.html` / `formats.css` | Static 3D format guide window (Help menu): what each download format keeps and is for |
| `assistant-bar.html` / `assistant-bar.css` / `assistant-bar.js` / `assistant-bar-preload.js` | Sub-tab strip for the Assistant site tab: Copilot / Gemini / Claude picker |
| `services-bar.html` / `services-bar.css` / `services-bar.js` / `services-bar-preload.js` | Sub-tab strip for the Services site tab: Hunyuan3D / Mixamo / Poly Pizza picker |
| `package.json` | Scripts: `npm start`, `npm run package-win` |

The content area hosts two site tabs, switched from the nav bar, each with a sub-tab strip of its own. The Services tab groups the three 3D sites: Hunyuan3D (`persist:hunyuan3d`), Mixamo (`persist:mixamo`, its own Adobe ID login), Poly Pizza (`persist:polypizza`, free premade low-poly models with direct .glb downloads; its login cookie is session-scoped, so main.js promotes poly.pizza session cookies to 30-day persistent ones and the login survives restarts) — and the Assistant tab — Copilot, Gemini, Claude, Muse and Boba sharing one session (`persist:assistant`) under a sub-tab strip, with the last-picked assistant persisted in settings. All site views and their popups present one consistent Chrome identity: a Chrome 138 UA string plus matching client hints (`navigator.userAgentData` / Sec-CH-UA), the latter aligned via a DevTools-protocol `Emulation.setUserAgentOverride` (`applyChromeIdentity` in main.js) because Chromium otherwise reports the real engine brand ("Chromium") — a mismatch Google's sign-in check blocks. Downloads from any session land in the active workspace and are tracked as assets. Sidebar items can be dragged out of the app as an OS-level file drag (main-process `startDrag`, since HTML drags can't cross views): images carry their own file, models carry their cached thumbnail PNG when one exists (chat assistants reject .glb attachments), and anything else carries its own file — so a model can be dropped straight onto an Assistant chat to show the AI what it looks like. "Prepare for Mixamo upload" (asset context menu / Tools) writes `<name>.mixamo.obj` next to the model; "Rig (local)" (asset context menu) rigs a fused model on the machine's GPU via the app-managed RigAnything engine (see `rig.js`) — the first click offers the engine install, later clicks produce `<name>.rigged.glb` (skeleton + skinning) and `<name>.rig.npz` (joints/weights for later pipeline stages) next to the source. The viewer plays animation clips carried by FBX/GLB files (Mixamo downloads) with a play/pause + clip-picker bar.

## Conventions

- Persistence goes in Electron `userData` (e.g. `assets.json`, `workspaces.json`).
- Untracking an asset never touches the file on disk.
- The nav bar has two tabs, Services and Assistant, each with a sub-tab strip
  (`services-bar.*`, `assistant-bar.*`). The last-picked service is persisted
  as `settings.serviceTab`, the assistant as `settings.assistantTab`.

## Common gotchas

- SmartScreen warns on unsigned Windows builds; click "More info → Run anyway".
