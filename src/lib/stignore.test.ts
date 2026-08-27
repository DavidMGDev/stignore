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
    MANAGED_END
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

console.log('stignore: all assertions passed');
