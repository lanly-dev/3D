# Project docs

Start here. These files are the project's shared memory — any AI agent should
read them at the start of a session so it doesn't start from zero.

| File | What it tells you |
|------|-------------------|
| `architecture.md` | Stack, key files, conventions, gotchas |
| `decisions.md` | Why we chose X instead of Y |
| `skills.md` | Verified reusable procedures |
| `lessons.md` | Hard-won "don't do that" notes |

## The rule

Before ending a session, leave one deposit: edit one of these files with
something new you learned or confirmed. If nothing changed, say so explicitly.

## Agnostic by design

Plain markdown, no custom tooling. Copy this `docs/` folder into any
repository and it works the same way.
