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

It does not automate anything — no page scripting, no auto-clicking. You use
the site yourself; the app just stops it from forgetting you.

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
