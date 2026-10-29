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
  a row for **Open in viewer** (models and converted code files),
  **Show in Explorer**, **Verify and fix** (generated Python
  scripts only: re-runs the syntax check and repairs the formatting
  failures this generator produces — two curve loops fused into one
  `create_curve` call (split back into per-loop calls; this one is
  valid syntax but silently builds nothing in Blender, so it is
  fixed even when the file parses), bracket balance, statements
  merged onto one line, a truncated tail — keeping a `<file>.orig`
  backup; a repair is written only when the result parses), **Delete file**
  (moves it to the Recycle Bin, with
  confirmation), or **Remove from list**. **Toggle DevTools** (Navigate
  menu, Ctrl+Shift+I or F12) toggles DevTools on the focused view.
- **3D viewer** — clicking a model opens it in an in-app viewer (Three.js)
  instead of the machine's default app: orbit / zoom / pan, texture
  on/off, wireframe, auto-rotate, grid, and camera reset. Supports GLB, GLTF, OBJ, STL, PLY
  and FBX; other files still open with the default app. Converted
  Three.js code files (`.ts` / `.js` from the converter) open in the
  viewer too — it constructs the model by running the module's
  `create…()` and renders the result. Model and converted-code rows also
  get a small rendered thumbnail (cached under userData `thumbs/`),
  generated in the background on first sight.
- **Three.js code export** — converts any tracked model into a
  self-contained TypeScript module that rebuilds it with Three.js at
  runtime (geometry, materials, node tree, textures embedded). No AI and
  no approximation: the model's own numbers, as code. *Tools → Convert
  last download to Three.js code*, or right-click a model → **Convert to
  Three.js code** — both open a submenu of variants; the `.ts` lands
  next to the model. **Exact** is the faithful copy. **Simplified** keeps
  about half the triangles for much smaller code (shape slightly
  approximate; textures unchanged) and writes `<name>.simple.ts`.
  **Small textures** caps embedded textures at 1024 px — usually the
  biggest saving on textured models — and writes `<name>.small.ts`.
  **Smallest** applies both and writes `<name>.smallest.ts`. **Tiny**
  goes further — half the triangles, 512 px textures, and the color
  textures re-encoded as JPEG (data maps like normals stay exact) — and
  writes `<name>.tiny.ts`.

It does not automate the site — no page scripting, no auto-clicking.

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
| `<userData>/layout.json` | Sidebar width + visibility |

**View → Reveal asset index file** opens the folder. Untracking an asset never
touches the file on disk.

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
