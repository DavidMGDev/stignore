# stignore

Manage a Syncthing `.stignore` file from a browser UI, scoped to whatever folder you run it in.

```bash
cd ~/my-synced-folder
stignore
```

That opens a page on `localhost:4568`. The top panel shows the state of that folder's
`.stignore`. The bottom panel is a file tree marking what the file currently ignores. You tick
folders, press a button, rules land in the file. Press Exit when you are done.

## Install

Not on npm. Install it from a clone, on each machine you want it:

```bash
git clone https://github.com/DavidMGDev/stignore.git
cd stignore
npm install
npm link
```

`npm install` builds the server as well, through the `prepare` script. `build/` is not committed,
so that step has to happen once on every machine before the command works. If anything skips it,
`stignore` says `stignore is not built yet` and names the command to run, and `npm run build`
fixes it.

`npm link` puts `stignore` on your PATH pointing at the clone, so `git pull && npm run build`
updates the command in place. `npm unlink -g stignore` removes it.

**Node 22.5 or newer is required.** The pattern matcher uses `path.matchesGlob`, which does not
exist in Node 20. Older versions fail at startup with a message saying so rather than crashing
mid-request. Check with `node --version`, and `nvm install 22` if you need it.

## What it does

**Finds the junk for you.** `node_modules`, `.venv`, `__pycache__`, `dist`, `target` and about
thirty other generated directories, down to a configurable depth. Depth 1 is direct children,
depth 3 reaches `packages/<name>/node_modules` in a monorepo. Default 3.

**Ignores what you tick.** Select anything in the tree and add it. Selecting a folder and its
contents writes one rule, not two hundred.

**Takes rules back out.** From the tree, from the row, or from the managed rules list in the
status panel. That last one is the only route that works once the folder is gone from disk.

**Leaves your own rules alone.** Anything you hand-wrote is preserved byte for byte and never
edited. The tool writes only inside a marked block at the end of the file.

## Why the block goes at the end

Syncthing takes the **first** matching pattern and ignores every later one. So a block at the
top of the file would override rules you wrote by hand. Putting it at the end means your lines
always win, and you override the tool just by writing above the block.

The trade is that a rule the tool writes can land in the file and still do nothing, because
something above it matched first. So after every write the tool re-reads the file and tells you
which lines are shadowed and by what. A visible non-effect beats an invisible override.

```
// my own rules
!/dist/keep.txt
/secrets

// stignore: managed block. Lines here are rewritten by the tool.
(?d)/node_modules
(?d)/packages/web/node_modules
/src/generated
// stignore: end of managed block.
```

`(?d)` appears only on directories whose name is on the junk list. It lets Syncthing delete the
contents when they block removing an otherwise-empty parent, which is worth having for a
`node_modules` and not worth having for a folder you picked by hand.

The previous version of the file is kept as `.stignore.bak` after every write.

## Options

```
stignore            Run against the current directory
stignore --debug    Print server logs to this terminal
stignore --help     Usage
```

## Development

```bash
npm install
npm test        # asserts the .stignore format against the Syncthing spec
npm run dev     # vite dev server, hot reload
npm run build   # produces build/, which is what the CLI runs
```

`build/` is not committed, so a clone always has to build once before the command works.

`src/lib/stignore.ts` is the parser, matcher and writer, with no dependencies. It uses Node's
built-in `path.matchesGlob`, which implements the glob grammar Syncthing documents.
`src/lib/stignore.test.ts` is a plain file of asserts, no framework.

See [PRD.md](PRD.md) for the design and the reasoning behind it, and
[docs/arena-synthesis.md](docs/arena-synthesis.md) for what was considered and rejected.

## Prior art

Forked from [txt-forge](https://github.com/DavidMGDev/txt-forge), which supplied the CLI shell,
the file tree, and the visual language. The text-merging half is gone.

## License

MIT
