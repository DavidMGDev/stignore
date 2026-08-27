# stignore

A local browser UI for one folder's Syncthing `.stignore` file. Hard fork of
[txt-forge](https://github.com/DavidMGDev/txt-forge).

## What it is

You `cd` into a Syncthing folder and type `stignore`. A Node CLI starts a SvelteKit server on
port 4568 scoped to that directory and opens your browser. The top panel tells you the state of
that folder's `.stignore`. The bottom panel is a file tree marking what the file currently
ignores. You tick folders, press a button, rules land in the file. You press Exit and the server
stops.

The tool edits exactly one file in exactly one directory: `<cwd>/.stignore`. It never walks up
looking for a folder root, never touches a second folder, and never talks to the Syncthing API.

### Vocabulary

One event, one word, everywhere in the UI and the code.

A path is **ignored** when `.stignore` makes Syncthing skip it. Adding a rule is **ignoring**.
Removing one is **stop ignoring**. A path with no matching rule **syncs**. A path matched by a
`!` rule is **kept**.

The words "include" and "exclude" appear nowhere. Syncthing's own docs call `!` lines includes,
which collides head-on with a user's sense of "include this folder in the ignore file". Both
words are banned rather than disambiguated.

Rules split into two classes. **Managed** rules are lines this tool wrote, inside the managed
block. **Manual** rules are every other pattern line in the file. The tool reads manual rules,
shows what they do, and never edits them.

## The one semantic that shapes everything

Syncthing's `.stignore` is first match wins. The first pattern matching a path decides that
path, and every later pattern is dead for it. A `!pattern` line only carves an exception out of
a broader ignore when it sits *above* that ignore.

Two consequences drive the whole design.

The tool writes its block at the **end** of the file. That placement is the design, not a
detail. Every hand-written line sits above the block and therefore outranks it. The tool can
never silently override a rule you wrote, and you override the tool by putting any line above
the block.

The cost of that choice is the opposite failure: a rule the tool writes can be shadowed by an
earlier rule and quietly do nothing. So every write is followed by re-reading the file and
re-evaluating the paths just added. Anything that did not take effect comes back to the UI
naming the rule that beat it. A visible non-effect beats an invisible override.

## Startup and shutdown

`bin/cli.js` kills whatever holds port 4568, spawns `build/index.js` with `STIGNORE_CWD` set to
the launch directory, waits 1.5 seconds, and opens the browser. `--debug` turns on server
logging, `--help` prints usage. There are no other flags.

Port 4568, not txt-forge's 4567, because the boot sequence kills whatever squats on its port.
Sharing a port would mean launching either tool kills the other.

**The server never exits on its own.** txt-forge shipped a watchdog that killed the process
about 13 seconds after the browser stopped pinging `/api/health`. That is gone: `session.ts` is
deleted and `/api/health` now returns `{ok: true}` and nothing else. The server is stateless and
idle when abandoned, and the next launch reclaims the port anyway, so an orphan costs nothing.

Three things stop it: the Exit button in the page header, Ctrl+C in the terminal, or the next
`stignore` launch. Exit posts to `/api/shutdown`, which keeps txt-forge's session-id equality
check so a stale tab from a previous run cannot kill the current server.

The page still polls `/api/health` every 5 seconds, but only to notice the server dying. A
failed poll shows "Server stopped", which explains a frozen page instead of leaving you
guessing. Nothing shuts down on a missed ping.

## Reading and matching

`src/lib/stignore.ts` parses and matches. It has no dependencies.

Parsing splits on `/\r?\n/` and classifies each line. `//` at line start is a comment. `#include`
is recorded and skipped. `#escape=` on the first line sets a flag. Blank lines are skipped.
Anything else is a rule: strip `!`, `(?i)` and `(?d)` prefixes in **any order and combination**,
and what remains is the pattern.

Matching compiles each pattern to one or two globs and hands them to `path.matchesGlob`, which
has shipped in Node since 22.5 and implements exactly the glob grammar Syncthing documents:
`*` within a segment, `**` across separators, `?`, `[a-z]`, `{a,b}`. No dependency, no
hand-rolled regex translator, and no gitignore library, whose last-match-wins precedence is
backwards here and would produce a confidently wrong tree.

The compilation is three rules from the spec:

- A leading `/` anchors to the folder root, so `/foo` becomes glob `foo`.
- No `/` at all means the pattern matches at any depth, so `foo` becomes `**/foo`. `**/` also
  matches zero directories, which covers the root case in the same glob.
- A trailing `/` matches the directory's contents but not the directory itself.

**Directory coverage lives in the pattern, not in a second pass.** A pattern without a trailing
slash compiles to two globs, `base` and `base/**`, so one rule decides the directory and
everything under it in a single ordered walk. The tempting alternative, matching the path first
and then walking its ancestors if nothing hit, inverts first-match-wins: given `/a` followed by
`!/a/b/c`, the ancestor walk reports `a/b/c` as kept, while Syncthing ignores it because `/a`
came first. That case is a test, not a comment.

Evaluation walks rules in file order and returns the first that matches, along with which rule
it was, so the UI can name it. A `!` hit means kept. No hit means syncing.

`#include` is not followed. Following it buys accuracy on a directive almost nobody uses, at the
cost of recursion, cycle caps, and line attribution across files. Instead the status panel says
the tree may be incomplete. Appending to the end of the file stays safe regardless of what an
included file says.

## Writing

### The managed block

Two exact marker lines delimit the region the tool owns:

```
// stignore: managed block. Lines here are rewritten by the tool.
(?d)/node_modules
/src/generated
// stignore: end of managed block.
```

Everything above the opening marker and below the closing marker is preserved byte for byte:
comments, blank lines, `#include`, trailing whitespace, all of it. The tool only ever replaces
what sits between the markers, and it replaces it wholesale rather than diffing. Hand edits
inside the markers do not survive, which is what the opening marker says.

The block goes at the end of the file, for the reason in the section above. If the markers are
missing it is appended after one blank line. If only an opening marker survives, everything from
it to the end of the file is treated as the block, so a half-deleted marker does not graft on a
second one.

### Line format

One line per path:

```
(?d)/packages/web/node_modules
/src/generated
```

Root-anchored with a leading `/`. A bare `node_modules` would match every directory of that name
at any depth, including ones you never saw in the tree, and then removing one of them could not
be expressed without writing a negation. Anchoring keeps one line matching exactly one tree row,
and that correspondence is the only reason the remove button can exist at all.

No trailing slash, so the directory goes too. A trailing slash would leave an empty directory
syncing forever.

`(?d)` lets Syncthing delete the contents when they block removing an otherwise-empty parent,
which is the fix for the classic wedged-deletion bug. It is written **only when the directory's
name is on the junk list**, because that is the only case where the tool can honestly claim the
contents are regenerable. A folder you picked by hand might be the only copy of something, and
the tool has no business granting delete permission over it. Keying this off the name rather
than off which button you pressed means ticking `node_modules` by hand still gets the protection,
and ticking `secrets` never does.

`(?i)` is never written. It is already implicit on Windows and macOS, and forcing it on Linux
would change matching you did not ask for.

Every line the tool writes starts with `(` or `/`, so none of them can ever be read back as a
comment, a negation, or a directive. That falls out of the format for free.

Paths containing `* ? [ ] { } \ !` are refused, not escaped, and the UI names them. `\` only
escapes when the file opens with `#escape=\`, so writing an escape can silently produce a
pattern matching nothing. Refusing beats writing a rule that quietly does not work, and
directory names like that are rare enough that nobody will meet this.

### Write algorithm

Every mutation reads the real file first, so an edit made in another editor while the page was
open is never clobbered.

1. Read `.stignore`. Missing is the normal starting state, not an error.
2. If the caller passed the mtime it loaded and the file's mtime differs, refuse the write,
   return a conflict, and let the UI reload. No merge attempt.
3. Compute the new managed set: current lines, minus removals, plus additions. Deduplicate.
   Sort, which is safe because every managed line is a positive anchored literal, and which
   keeps diffs readable.
4. Copy the existing file to `.stignore.bak`. That is the entire undo story, and it costs one
   line.
5. Render. If the managed set is empty, drop both markers rather than leave a hollow pair. If
   the whole file would then be empty, delete `.stignore` instead of writing an empty one.
6. Write to `.stignore.tmp` and rename over the target, so a crash or a full disk can never
   truncate a file you hand-wrote. A UTF-8 BOM is stripped for parsing and re-emitted on write.
   Line endings are detected and preserved.
7. Re-read, re-evaluate every path just added, and return the ones an earlier rule shadows,
   naming that rule.

## Removal

Removal only ever deletes lines from the managed block. The tool will not edit a line you wrote,
for any reason.

Three ways in, all landing on the same call:

- **Stop ignoring selected** takes the tree selection and removes the managed lines matching
  those paths.
- **The remove control on a tree row**, shown on any row ignored by a managed rule. Rows ignored
  by a manual rule show the badge with no control and a tooltip naming the rule instead.
- **The managed rules list in the status panel**, one `✕` per rule. This is the only route that
  works for a rule whose directory no longer exists on disk, which the tree cannot show.

When a selected path is ignored by a manual rule, the confirm dialog says so before you commit,
with a count. Silently doing nothing there is the trap this requirement exists to prevent.

## Auto-detection and depth

`JUNK_DIRS` in `src/lib/tree.ts` is a hardcoded set matched on directory name. There is no UI to
edit it: the tree plus the manual ignore button already covers anything it misses, and a list
editor would be a settings framework for one person.

```
node_modules bower_components .next .nuxt .svelte-kit .output .turbo .parcel-cache .vite .yarn
.venv venv __pycache__ .tox .mypy_cache .pytest_cache .ruff_cache .ipynb_checkpoints
dist build target obj CMakeFiles
.gradle .cache .terraform coverage Pods DerivedData .godot .dart_tool .stack-work
```

Every name on that list is unambiguous in practice. Names that are sometimes generated and
sometimes hand-written are deliberately absent, because one wrong auto-ignore silently stops
syncing real work: `bin`, `env`, `out`, `lib` and `vendor` all failed that bar.

`.git` is absent too. A repository is not junk, losing one is unrecoverable, and plenty of people
sync repositories on purpose. It stays on the separate lazy-load list so the tree does not walk
into it, and you can still tick it by hand in two seconds.

Lockfiles are absent. They are repository content, and auto-ignoring them makes synced checkouts
silently diverge.

### Depth

Depth is the maximum number of path segments, counted from the folder root, at which a junk
directory is detected. The junk directory's own name is the last segment and it counts.

```
node_modules                    1 segment,  found at depth >= 1
packages/web/node_modules       3 segments, found at depth >= 3
apps/api/services/auth/.venv    5 segments, found at depth >= 5
```

A direct child of the root is depth 1. That needs no explanation, unlike a zero-origin count,
which forces you to describe the launch directory as an implicit depth -1 container.

Depth does not describe how deep inside a junk folder anything goes, and it does not affect tree
expansion. It only bounds how far the detection scan looks.

Default 3, clamped 1 to 8. Depth 1 covers a plain repository and depth 3 covers the
`packages/<name>/node_modules` monorepo shape, which together are almost everything. The value
persists in `localStorage` keyed by absolute path, so it is remembered per project with no
server route, no config file on disk, and no version-migration logic.

### The scan

The detection walk is separate from the tree walk, because the two have different stopping
rules. The tree refuses to descend into a huge directory and waits for you to click, which is
right for browsing. Detection has to descend *past* a huge directory to find a `.venv` two levels
into a monorepo, then stop the instant it matches a junk name, which is right for detection.

The scan never descends into a directory it just matched: `node_modules` inside `node_modules`
is not a separate decision. Directories already ignored are still reported, flagged
`alreadyIgnored`, so the UI can show them struck through as done rather than pretending it found
nothing.

## The panels

### Top panel: status

Replaces txt-forge's framework picker.

A state chip reads "No .stignore yet", ".stignore active", or "Unreadable". Then eight facts in
a grid: file path, total rules, how many you wrote, how many are managed here, negations, how
many tree paths are currently ignored, pending detections, and last modification as relative
time.

Warning banners, stacking when more than one applies:

- **Unreadable.** Names the errno. Both ignore buttons disable. The tree still renders but
  nothing below reflects real ignore state, and the banner says so.
- **No `.stfolder`.** Syncthing drops that marker in every folder it manages, so its absence
  means this probably is not a synced folder root and a `.stignore` here does nothing yet. Never
  blocking: people write the ignore file before adding the folder to Syncthing all the time.
- **`#include` present.** Names the included files and says the tree may show a path as syncing
  when Syncthing ignores it.
- **`#escape=` present.** Says escaped patterns may be displayed wrong, and that rules written
  here are plain paths and therefore unaffected.

Below the facts, a collapsible managed rules list with a remove control per rule, plus "Open
file" and "Reload".

No file yet is not an error and gets no "create" button. The first rule you add creates the
file, and a button that makes an empty file is a button that does nothing.

### Bottom panel: the tree

Keeps txt-forge's `FileTreeNode.svelte`: same recursion, same expander, same lazy-load spinner,
same indentation. What changes:

`isIgnored` now means matched by the live `.stignore`. All `.gitignore` reading is deleted; git
and Syncthing ignores are unrelated and showing git's opinion here would be a lie. The
dotfile-hiding list is deleted too, because deciding whether `.venv` syncs is the entire job and
hiding it would hide the answer.

`isMedia` and everything downstream of it is deleted. There is no such thing as a media file
here; every file type is equally syncable.

**The checkbox no longer means "in the output".** It means "queued for the next action", and it
is completely independent of whether the row is ignored. That decoupling is what lets one column
of checkboxes feed both the ignore button and the stop-ignoring button: tick an unignored folder
and press Ignore, tick an ignored one and press Stop ignoring. txt-forge's three-way click cycle
collapses to a plain two-state toggle, since the third state existed to force a file past a
gitignore rule during a merge and there is nothing to force here. Indeterminate stays as a
display state produced by children, never a click result.

Badges: **Ignored** in amber for a managed rule, in slate reading "Ignored (yours)" for a manual
one, both with a tooltip naming the exact deciding line. **Kept** in emerald for a `!` match.
**Detected** in cyan on a junk-named row not yet ignored, so auto-detect candidates are visible
while browsing rather than only after clicking. **Unscanned** on a lazy-load folder. Ignored rows
dim and strike through.

`.stfolder`, `.stignore` and `.stversions` appear at the root with a disabled checkbox. Syncthing
owns those names and a rule for them would do nothing, but showing them answers "where did my
.stignore go".

Selection is pruned before writing: a selected path whose ancestor is also selected is dropped,
so ticking a folder with two hundred files writes one line, not two hundred and one.

### Actions

A depth stepper, then three buttons. Each opens one confirm dialog listing the exact lines to be
written or deleted, with a `+` or `-` gutter, capped at 200 rows.

- **Ignore detected junk (N)** where N counts pending detections.
- **Ignore selected (N)** where N counts ticked paths not already ignored.
- **Stop ignoring (N)** where N counts ticked paths whose deciding rule is managed.

After any write the page reloads status, tree and detections from the server rather than patching
state locally, because one rule can change the state of every node. The result dialog reports
what was added or removed, plus the shadowed and rejected lists when either is non-empty.

## Rebrand

The visual language is unchanged: `slate-950` base, two fixed radial gradients, three blurred
animated blobs, `bg-slate-900/40 backdrop-blur-xl border-white/10 rounded-3xl` cards,
`font-black uppercase tracking-[0.2em]` headings, 10px mono labels, the same keyframes. Only
colour values and the wordmark change.

| Role | txt-forge | stignore |
|---|---|---|
| Accent, fills and checkboxes | `orange-500` `#f97316` | `cyan-500` `#06b6d4` |
| Accent, text and icons | `orange-400` | `cyan-400` `#22d3ee` |
| Accent glow | `rgba(249,115,22,a)` | `rgba(34,211,238,a)` |
| Ignored state | n/a | `amber-400` on `amber-950/30` |
| Kept state | n/a | `emerald-400` |
| Destructive, errors, Exit | `red-500` | `rose-500` |
| Blob 1, top | `bg-orange-600/20` | `bg-cyan-500/20` |
| Blob 2, mid | `bg-rose-700/20` | `bg-sky-600/20` |
| Blob 3, bottom | `bg-violet-900/30` | `bg-indigo-900/30` |
| Scrollbar thumb hover | `#f97316` | `#22d3ee` |
| Wordmark gradient | `from-orange-400 via-rose-500 to-violet-500` | `from-cyan-300 via-sky-400 to-indigo-400` |

Cyan because it is Syncthing's own brand family, so the tool reads as belonging to the thing it
manages, and because it is far enough from orange that nobody confuses the two tools on screen.
The ignored state gets its own colour, amber, deliberately separate from the accent, so "this row
is ignored" never reads as "this row is hovered".

The wordmark is `STIGNORE` in the same 8xl animated gradient, with the subtitle
`// syncthing ignore manager` beneath it in the 10px mono label style. The `//` is Syncthing's
comment token and does the branding work an icon would otherwise do. The favicon is an inline SVG
of a crossed-out circle in cyan on the base colour.

## Every inherited feature, and its fate

| Feature | Fate | Reason |
|---|---|---|
| CLI boot: kill port, spawn, open browser, SIGINT | Keep | It is the shell, and it works. Port moves to 4568, env vars rename. |
| CLI `--auto` mode, `--vault`, `--ignore`, `--single`, `--custom` | Cut | All of them drive file merging, which no longer exists. |
| CLI `--debug` | Keep | One env var, useful when a scan misbehaves. |
| Heartbeat auto-shutdown watchdog (`session.ts`) | Cut | The idle exit is exactly the behaviour being replaced by an Exit button. |
| Browser health ping, "Connection Lost" modal | Keep, reworked | Now at 5s and only reports a dead server. It no longer implies a pending shutdown. |
| `/api/shutdown` and its session-id check | Keep | This is the Exit button. The check stops a stale tab killing a live server. |
| npm update checker, self-update, skip-update, version-reset modal | Cut | Shelling out to `npm install -g` on a user's machine is a trust liability for a feature `npm update -g` already provides. Also removes an HTTPS call from startup. |
| Per-project config store (`~/.txt-forge/`, `projects.json`) | Cut | It would survive to hold one integer. `localStorage` keyed by absolute path does that with no server route, no file, and no migration logic. |
| Native folder picker (`pickDirectory`, `/api/select-folder`) | Cut | It chose an output directory. There is no output directory. It also carried three platform-specific shell hacks. |
| Switch directory (`relaunchInNewWindow`, `/api/switch-dir`) | Cut | Three platforms of terminal spawning with sleep-based timing races, to replace `cd` and retyping eight characters. |
| `scanDirectory` and lazy loading of huge folders | Keep, reworked | Required. `node_modules` is now the subject of the tool rather than an obstacle, and inspecting what is inside an ignored folder is a real action. |
| `.gitignore` reading in the scanner | Cut | Git's precedence is reversed and its opinion is unrelated. Showing it as "ignored" would be a lie. |
| `SYSTEM_HIDDEN` dotfile hiding | Cut | Deciding whether dotfiles sync is the job. |
| `generateTreeString` | Cut | It drew the ASCII map inside the merged output. |
| `MEDIA_EXTENSIONS`, `isMedia`, media badge | Cut | Meaningless here. |
| Tri-state checkbox | Keep, simplified | Two clickable states, indeterminate derived. The third state overrode gitignore during a merge. |
| Badges "Massive", "Ignored", "Force Included", "Media" | Two kept, two cut | "Massive" becomes "Unscanned", "Ignored" gets real backing. The other two go with their features. |
| Framework template picker, `templates.ts`, old `/api/detect` | Cut | Replaced by the status panel and the junk scan. |
| Layout skeleton, cards, loaders, modal shapes, blobs, gradients | Keep | Restyled, refilled, same bones. |
| Three "Save to X" buttons, split-size settings | Cut | Output settings for an output that no longer exists. |
| `PretextButton.svelte` and `@chenglou/pretext` | Cut | A canvas particle animation on a clipboard button, and there is no clipboard step. |
| `processor.ts`, `/api/forge`, `/api/cli-forge` | Cut | The discarded half of the fork. |
| `/api/open` | Keep, reworked | Now opens `.stignore` or the folder. It is the escape hatch for manual rules. |
| `getCwd`, `APP_VERSION` | Keep | `setCwd` goes with switch-directory. `sys-utils.js` drops from 277 lines to 23. |
| `logger.js` | Keep | Two functions behind a debug flag. |

## Not building

No plugin system, no settings screen beyond the depth stepper, no profile manager, no undo stack
past `.stignore.bak`, no telemetry, no multi-folder workspace, no Syncthing REST integration, no
`.gitignore` import, no editable junk list, no `#include` evaluation, no filesystem watcher, and
no junk *file* patterns. The tree edits paths, and a second pattern shape for files would break
the one-to-one match between a tree row and a line that makes removal work.

## Done means

Typing `stignore` in a folder with no `.stignore` opens the UI, the top panel says no file, and
the tree shows nothing ignored. Pressing "Ignore detected junk" at depth 3 lists every
`node_modules` and `.venv` down to three segments, and confirming creates `.stignore` containing
only the managed block. The tree repaints with those folders dimmed and badged. Hand-writing
`!/dist/keep.txt` above the block and reloading shows `keep.txt` as Kept while the rest of
`dist` stays ignored. Pressing "Stop ignoring" on one folder removes exactly that line and leaves
every hand-written byte identical. Removing the last managed rule takes the markers with it, and
removing it from a file that was only the block deletes the file. Closing the browser tab and
waiting ten minutes leaves the server running. Pressing Exit stops it.
