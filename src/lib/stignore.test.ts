/**
 * Self-check for the .stignore parser, matcher and writer. Run it with `npm test`.
 * No framework on purpose: this is one file of asserts against the format spec.
 */
import assert from 'assert';
import {
    parseStignore,
    isIgnored,
    matchRule,
    compilePattern,
    lineForPath,
    isWritablePath,
    renderStignore,
    managedPatterns,
    MANAGED_BEGIN,
    MANAGED_END,
    INCLUDE_LINE,
    GLOBAL_IGNORE_FILE,
    isSharedMode
} from './stignore.ts';

const ign = (file: string, p: string) => isIgnored(p, parseStignore(file).rules);
const NL = '\n';

// --- matching ---------------------------------------------------------------

// A bare name matches at any depth, and covers the directory's contents.
assert.equal(ign('node_modules', 'node_modules'), true);
assert.equal(ign('node_modules', 'src/node_modules'), true);
assert.equal(ign('node_modules', 'node_modules/react/index.js'), true);
assert.equal(ign('node_modules', 'src/index.js'), false);

// A leading slash anchors to the root.
assert.equal(ign('/build', 'build'), true);
assert.equal(ign('/build', 'app/build'), false);

// A trailing slash takes the contents but leaves the directory itself.
assert.equal(ign('cache/', 'cache/a.bin'), true);
assert.equal(ign('cache/', 'cache'), false);

// Globs.
assert.equal(ign('*.log', 'debug.log'), true);
assert.equal(ign('*.log', 'logs/debug.log'), true);
assert.equal(ign('/*.log', 'logs/debug.log'), false);
assert.equal(ign('{dist,build}', 'dist'), true);
assert.equal(ign('src/**/*.tmp', 'src/a/b/c.tmp'), true);

// First match wins, so a negation only bites when it sits above the ignore.
assert.equal(ign('!/keep.log' + NL + '*.log', 'keep.log'), false);
assert.equal(ign('*.log' + NL + '!/keep.log', 'keep.log'), true);

// The trap: a rule covering a directory decides everything under it, in file
// order. Walking ancestors as a separate pass after failing to match the path
// would report `a/b/c` as kept here, which is the opposite of what Syncthing
// does. Coverage has to live in the pattern, not in a second pass.
assert.equal(ign('/a' + NL + '!/a/b/c', 'a/b/c'), true);
assert.equal(ign('!/a/b/c' + NL + '/a', 'a/b/c'), false);
assert.equal(ign('/a' + NL + '!/a/b/c', 'a/b/d'), true);

// Prefixes, in any order and combination.
assert.equal(ign('(?i)NODE_MODULES', 'node_modules'), true);
assert.equal(ign('(?d)/dist', 'dist/app.js'), true);
assert.equal(ign('(?d)(?i)/DIST', 'dist/app.js'), true);
assert.equal(ign('!(?d)/dist' + NL + '/dist', 'dist/app.js'), false);

// Comments, blanks and directives never match anything.
assert.equal(ign('// node_modules', 'node_modules'), false);
assert.equal(ign(NL + NL + '   ' + NL, 'anything'), false);
assert.equal(parseStignore('#include other.txt' + NL + '/dist').includes.length, 1);
assert.equal(parseStignore('#escape=\\' + NL + '/dist').hasEscapeDirective, true);

// The managed block is tracked so the UI can tell our lines from hand-written ones.
const mixed = parseStignore(
    ['/hand-written', MANAGED_BEGIN, '(?d)/node_modules', MANAGED_END, ''].join(NL)
);
assert.equal(mixed.rules.length, 2);
assert.equal(mixed.rules[0].managed, false);
assert.equal(mixed.rules[1].managed, true);
assert.equal(mixed.rules[1].deletable, true);

// The deciding rule comes back so the UI can name it.
const decided = matchRule('node_modules/x', parseStignore('/src' + NL + '/node_modules').rules);
assert.equal(decided?.pattern, '/node_modules');

// Windows separators in a pattern normalise to forward slashes.
assert.deepEqual(compilePattern('a\\b'), ['**/a/b', '**/a/b/**']);

// What we write for a path.
assert.equal(lineForPath('src/node_modules/', true), '(?d)/src/node_modules');
assert.equal(lineForPath('secrets', false), '/secrets');
assert.equal(ign(lineForPath('.venv', true), '.venv/lib/python3.12/site.py'), true);
// Anchored, so a same-named folder elsewhere is untouched.
assert.equal(ign(lineForPath('app/dist', true), 'other/dist'), false);

// Glob syntax in a path is refused rather than written wrong.
assert.equal(isWritablePath('build[old]'), false);
assert.equal(isWritablePath('a*b'), false);
assert.equal(isWritablePath('src/lib'), true);

// --- writing ----------------------------------------------------------------

// A fresh file is nothing but the block.
assert.equal(
    renderStignore('', ['(?d)/node_modules']),
    [MANAGED_BEGIN, '(?d)/node_modules', MANAGED_END, ''].join(NL)
);

// The block goes at the BOTTOM, under the user's own lines, so first-match-wins
// leaves every hand-written rule outranking the tool.
const withManual = renderStignore('!/keep' + NL + '/secret' + NL, ['(?d)/dist'])!;
assert.ok(withManual.startsWith(['!/keep', '/secret', '', MANAGED_BEGIN].join(NL)));
assert.ok(withManual.indexOf('!/keep') < withManual.indexOf('(?d)/dist'));

// A second save replaces the block instead of stacking another one.
const twice = renderStignore(withManual, ['(?d)/dist', '(?d)/build'])!;
assert.equal(twice.split(MANAGED_BEGIN).length - 1, 1);
assert.ok(twice.includes('!/keep'));
// Sorted, so diffs stay readable.
assert.ok(twice.indexOf('(?d)/build') < twice.indexOf('(?d)/dist'));

// Emptying the block removes the markers rather than leaving a hollow pair.
const emptied = renderStignore(twice, [])!;
assert.equal(emptied, '!/keep' + NL + '/secret' + NL);
assert.ok(!emptied.includes(MANAGED_BEGIN));

// Emptying a file that was only ever the block returns null, meaning delete it.
assert.equal(
    renderStignore([MANAGED_BEGIN, '(?d)/dist', MANAGED_END, ''].join(NL), []),
    null
);

// CRLF in, CRLF out.
assert.ok(renderStignore('/a\r\n', ['(?d)/b'])!.includes('\r\n'));

// Duplicates collapse.
assert.equal(renderStignore('', ['(?d)/a', '(?d)/a'])!.split('(?d)/a').length - 1, 1);

// A round trip: what we render, we read back as managed.
assert.deepEqual(
    managedPatterns(parseStignore(renderStignore('/manual', ['(?d)/dist', '(?d)/node_modules'])!)),
    ['(?d)/dist', '(?d)/node_modules']
);

// The (?d) survives a rewrite. Losing it would silently re-enable the wedged
// directory bug it exists to prevent.
const kept = renderStignore(renderStignore('', [lineForPath('node_modules', true)])!, [
    lineForPath('node_modules', true),
    lineForPath('dist', true)
])!;
assert.ok(kept.includes('(?d)/node_modules'));

// A user line written above the block still wins after a rewrite.
const carved = renderStignore('!/dist/keep.txt' + NL, ['(?d)/dist'])!;
assert.equal(ign(carved, 'dist/keep.txt'), false);
assert.equal(ign(carved, 'dist/other.txt'), true);

// --- #include ---------------------------------------------------------------

// `.stignore` never syncs, so the shared-rules trick is to include a file that
// does. Patterns from the included file have to apply as if written in place.
const shared = [MANAGED_BEGIN, '(?d)/node_modules', '*.log', MANAGED_END, ''].join(NL);
const host = ['// mine', MANAGED_BEGIN, INCLUDE_LINE, MANAGED_END, ''].join(NL);
const resolver = (n: string) => (n === GLOBAL_IGNORE_FILE ? shared : null);

const inc = parseStignore(host, resolver);
assert.equal(isSharedMode(inc), true);
assert.equal(inc.missingIncludes.length, 0);
assert.equal(isIgnored('node_modules/react/x.js', inc.rules), true);
assert.equal(isIgnored('logs/a.log', inc.rules), true);
assert.equal(isIgnored('notes/a.md', inc.rules), false);
// Rules carry the file they came from, so the UI can say where a rule lives.
assert.equal(inc.rules[0].source, GLOBAL_IGNORE_FILE);
assert.equal(inc.rules[0].managed, true);

// Patterns inline where the directive sits, so a negation ABOVE the include
// still wins under first-match. This is the whole reason the include is not
// simply appended at the end.
const carve = parseStignore(
    ['!/logs/keep.log', MANAGED_BEGIN, INCLUDE_LINE, MANAGED_END, ''].join(NL),
    resolver
);
assert.equal(isIgnored('logs/keep.log', carve.rules), false);
assert.equal(isIgnored('logs/other.log', carve.rules), true);

// A missing include is a folder error in Syncthing, so it must be reported.
const broken = parseStignore(host, () => null);
assert.deepEqual(broken.missingIncludes, [GLOBAL_IGNORE_FILE]);

// Without a resolver we still record the include but follow nothing.
const unresolved = parseStignore(host);
assert.deepEqual(unresolved.includes, [GLOBAL_IGNORE_FILE]);
assert.equal(unresolved.rules.length, 0);
assert.equal(unresolved.missingIncludes.length, 0);

// A file that includes itself must not loop forever.
const selfRef = ['#include a', ''].join(NL);
const loop = parseStignore(selfRef, (n) => (n === 'a' ? selfRef : null));
assert.equal(loop.rules.length, 0);

// Catalogue patterns survive a managed-block rewrite unchanged.
assert.equal(
    managedPatterns(parseStignore(renderStignore('', ['*.log', '.DS_Store'])!)).length,
    2
);

console.log('stignore: all assertions passed');
