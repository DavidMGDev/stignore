# Arena synthesis note

How `PRD.md` was produced. Kept because the rejections are the part worth reading later.

## Setup

Four PRDs written in parallel from one shared brief, by four runners (fable, opus, sonnet,
and one inheriting the parent model). No dropouts: all four produced a PRD and a rationale.
One read-only cross-judge on a different runner scored all four against a seven-criterion
rubric it had not seen while they were writing.

## Base

Candidate 1. The judge and I picked it independently for the same reason: it is the only
candidate that answered every write-semantics question including the empty-file case, its
match evaluation is order-correct, and it caught a port collision two others missed, while
staying the most restrained document of the four.

## Convergence, which mattered more than the scores

Four independent authors landed on the same answers, with the same reasoning, on:

- A marker-delimited managed block appended at the **end** of the file, regenerated wholesale,
  everything outside it preserved byte for byte. All four rejected top placement for the same
  reason: first-match-wins means a top block would silently override hand-written negations.
- Root-anchored `/path` lines, no trailing slash, one line per tree row, because that
  correspondence is what makes removal expressible.
- Removal restricted to managed lines, with manual rules surfaced and routed to "open the file".
- Deleting the auto-shutdown watchdog outright rather than lengthening its timeout.
- Cutting the update checker, the folder picker, and switch-directory.
- Keeping lazy loading, and decoupling the checkbox from ignore state so one selection feeds
  both buttons.
- A hardcoded junk list with no editor UI.
- Atomic write via temp file plus rename.

Those were treated as settled and shipped without further argument.

## Grafts

- **From candidate 2**: post-write shadow detection, naming the earlier rule that beat a line we
  just wrote. This is the honest counterweight to appending at the end of the file, and no other
  candidate had it. Also the mtime conflict guard, `localStorage` for depth instead of keeping a
  server-side config store alive for one integer, and the observation that every managed line
  starts with `(` or `/` and so can never be re-read as a comment or directive.
- **From candidate 3**: the "Detected" badge on junk rows in the tree itself, so auto-detect
  candidates are visible while browsing, and the per-row remove control.
- **From candidate 4**: `.stignore.bak`, a one-line undo story, and the argument for putting
  directory coverage in the pattern rather than in an ancestor-walk pass.
- **From candidate 1**: everything else, including the depth definition, the status panel, the
  disposition table, and the acceptance checks.

## Rejections

- **`(?d)` on every managed line** (candidates 1 and 3). `(?d)` grants Syncthing permission to
  delete matched files. Correct for regenerable junk, wrong for a folder someone picked by hand
  that might be the only copy of something. Candidates 2 and 4 restricted it to auto-detected
  paths; shipped instead is a third answer neither proposed, keying it off whether the
  directory's *name* is on the junk list. That covers the same risk while behaving identically
  whether you reached the folder through the auto button or by ticking it yourself.
- **Zero-origin depth** (candidate 3, default 4). Three candidates used one-origin. "Depth 1
  means direct children" needs no explanation; zero-origin forced candidate 3 to describe the
  launch directory as an implicit depth -1 container.
- **Ancestor-walk match evaluation** (candidate 2). Given `/a` followed by `!/a/b/c`, walking
  ancestors after failing to match the path reports `a/b/c` as kept, while Syncthing ignores it.
  Candidate 2's own document admitted it "can disagree with Syncthing". A tool whose main job is
  showing what will sync should not ship a known display lie. Coverage went into the compiled
  pattern instead, and that exact case is now an assertion in `stignore.test.ts`.
- **Adding minimatch** (candidate 3). Node 24's built-in `path.matchesGlob` already implements
  the glob grammar Syncthing documents. Candidate 3's minimatch spec also silently dropped
  directory coverage, which would have marked every file inside every ignored directory as
  syncing.
- **Recursive `#include` expansion** (candidate 3). Buys accuracy on a directive almost nobody
  uses, at the cost of recursion, cycle caps, and cross-file line attribution. The other three
  warn and skip, which is what shipped.
- **Escaping glob characters in written paths** (candidate 2). `\` only escapes when the file
  opens with `#escape=\`, so an escape can silently produce a pattern matching nothing. Refusing
  such paths and naming them is smaller and cannot be wrong.
- **`.git`, `.idea`, `.vscode`, `bin`, `obj` on the junk list** (candidate 3) and **lockfiles**
  (candidate 4). A button labelled junk must not claim repository history, editor settings people
  sync on purpose, or content that makes checkouts diverge.
- **Port 4567** (candidate 2). The boot sequence kills whatever holds the port, so sharing one
  with txt-forge means launching either kills the other.
- **A "Create .stignore" button** (candidate 4). It writes a file containing an empty block. A
  button that makes an empty file is a button that does nothing.

## Verification

`npm test` runs `src/lib/stignore.test.ts`, which asserts the format against the Syncthing spec:
anchoring, trailing-slash contents-only, `*` versus `**`, prefix combinations in any order,
first-match-wins with negations above and below, the directory-coverage trap above, block
placement, marker cleanup, CRLF and duplicate handling, and the `(?d)` round trip.

Beyond the unit tests, the built server was run against a fixture folder holding a monorepo
shape, a pre-existing hand-written `.stignore`, and junk at depths 1 and 3. Verified live:
detection at both depths, creating the file from nothing, hand-written rules surviving six write
cycles byte for byte, shadow detection naming the exact blocking rule, selection pruning
collapsing four picks into one line, idempotent re-adds, removal, marker cleanup when the block
empties, file deletion when nothing is left, and the path-traversal, stale-session and mtime
guards all refusing.
