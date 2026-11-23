# Decisions

Records of why we chose X instead of Y, so the reasoning survives after the ticket is closed.

## Adding a decision

Append a new entry:

```markdown
## <decision title>

**Decision:** What was chosen.

**Alternatives considered:** What else was looked at.

**Why:** Reasoning.

**Revisit:** Conditions under which to reconsider.
```

## Current decisions

## Settings lives in the nav bar, not a window

**Decision:** App setup is a third top-level nav tab (`settings.html`),
rendered as a plain local page in the content area instead of a separate
window or a sidebar section.

**Alternatives considered:** A modal settings window opened from the app
menu; a section inside the sidebar; dumping the install output to a terminal
or a file the user opens by hand.

**Why:** The only setup the app has is the multi-GB rigging-engine install,
whose failure mode is a long pip/download log — the log is the point, so it
belongs on screen, in the app, without extra window management. The tab
carries two panes: the app's own log (`userData/app.log` — startup, failed
downloads, renderer crashes, failed page loads) and the engine's `install.log`
transcript. They answer different questions — "why is this tab blank?" versus
"why did pip stop?" — so neither replaces the other. The app log records only
what the UI cannot show: install progress is in `install.log` and each rig run
in its job's `rig.log`, so mirroring those here would be a second activity
feed with no new information. It also trims itself once per launch, not on
every line.

In development the log lands in `%APPDATA%\Electron` because an unpackaged
run has no app name — the same folder as `settings.json` and `rig-engine`;
packaged builds use `%APPDATA%\Hunyuan3D`. Giving the dev app its own name
would move the multi-GB engine, so the path stays and the quirk is accepted.

The tab reuses the existing switch/layout machinery, but it is app chrome
rather than a site:
`layoutViews` gives it the whole content rect (no sub-tab strip) and the nav
bar's history arrows and zoom controls go inert while it shows.

**Revisit:** When setup grows past one engine (model defaults, export
settings, update channel) — a sectioned page then earns its keep, and the tab
may want its own sub-tab strip like Services and Assistant.
