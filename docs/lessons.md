# Lessons

Hard-won "don't do that" notes. Each lesson is an entry.

## Adding a lesson

Append a new entry:

```markdown
## <lesson title>

**What happened:** Brief description.

**Why it went wrong:** Root cause.

**Rule going forward:** What to do instead.
```

## Current lessons

## A stale local tree silently reverts parallel work on push

**What happened:** While the Services tab, Meshy site, and Settings tab
were landing on top of the Rig (local) commit, another session's local
tree stayed at the older head. The API push script replaces every file
in its list with the local copy, so pushing a one-file README change
from the stale tree would have reverted all of that work in main.js,
rig.js, and the nav files.

**Why it went wrong:** The local tree is a snapshot, not a sync.
Editing an unrelated file (README.md) gives no warning that sibling
files have moved on the remote.

**Rule going forward:** Run the pre-push remote diff before every push
and read every hunk; sync any file that moved on the remote down
first, so only the intended change rides the push. New app files must
also be added to both the push list and the updater's SYNC_FILES, or
packaged installs silently miss them when they update.
