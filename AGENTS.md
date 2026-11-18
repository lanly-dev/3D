# Project rules

## Commits

- **No attribution.** Never add `Co-Authored-By:` trailers, a
  "Generated with …" footer, or any other AI/tool credit. The message ends at
  the last line of its own body — if a tool template appends a footer, delete it.
- **Match the history.** Subject is `Area: what changed` (e.g. `Viewer: the
  ground grid sizes itself to the model`), imperative, no trailing period;
  explain *why* in the body only when it isn't obvious.
- **Check before you finish:** `git log -1 --pretty=%B` must show no
  attribution line.

## Docs

- `docs/` is the project's shared memory — start with `docs/README.md` and add
  one deposit per session. Use `AGENTS.md` (this file) only for rules.
- Line endings are git's job (`core.autocrlf`): the index is LF even though the
  worktree is CRLF, so don't reformat files to "fix" them.
