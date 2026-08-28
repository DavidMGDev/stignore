import path from 'path';

/**
 * Syncthing .stignore parsing and matching.
 * Format reference: https://docs.syncthing.net/users/ignoring.html
 *
 * The one semantic that drives everything here: the FIRST pattern that matches
 * decides a file's fate. Not the last. A `!` negation only works if it sits
 * above the broader rule it carves out of.
 */

export const STIGNORE_FILE = '.stignore';

/**
 * The shared pattern file.
 *
 * Syncthing never syncs `.stignore` itself, so rules written there apply to one
 * device and no other. A file the folder *does* sync, pulled in with `#include`,
 * is the documented way around that: write the rules once, every device gets
 * them, and each device's `.stignore` only has to carry the include line.
 *
 * `.stglobalignore` is the name the Syncthing community settled on.
 */
export const GLOBAL_IGNORE_FILE = '.stglobalignore';
export const INCLUDE_LINE = `#include ${GLOBAL_IGNORE_FILE}`;

/** A line that carries a pattern. Comments and blanks are not Rules. */
export interface Rule {
    /** The line exactly as it appears in the file. */
    raw: string;
    /** Zero-based index of this line in the file. */
    line: number;
    /** `!` prefix: a match means the path is synced, not ignored. */
    negate: boolean;
    /** `(?i)` prefix. Implicit on macOS and Windows, but we only honour it when written. */
    caseInsensitive: boolean;
    /** `(?d)` prefix: Syncthing may delete these to unblock a directory removal. */
    deletable: boolean;
    /** The pattern with all prefixes stripped. */
    pattern: string;
    /** Compiled globs. A path matches the rule if it matches any of them. */
    globs: string[];
    /** True when the tool wrote this line, i.e. it sits inside the managed block. */
    managed: boolean;
    /** Which file the line came from. Null for `.stignore` itself. */
    source: string | null;
}

export interface ParsedStignore {
    /** Rules in evaluation order, with included files inlined where they appear. */
    rules: Rule[];
    /** Every line of `.stignore`, unmodified. */
    lines: string[];
    /** `#include` targets found, in order. */
    includes: string[];
    /** Includes we were asked to follow but could not read. Syncthing errors the folder on these. */
    missingIncludes: string[];
    /** True if the file opens with `#escape=`, which changes escaping for the whole file. */
    hasEscapeDirective: boolean;
}

/** Reads an included file by name, relative to the folder root. Null when absent. */
export type IncludeResolver = (name: string) => string | null;

export const MANAGED_BEGIN = '// stignore: managed block. Lines here are rewritten by the tool.';
export const MANAGED_END = '// stignore: end of managed block.';

/**
 * Translate one Syncthing pattern into globs that `path.matchesGlob` understands.
 *
 * Three rules from the spec drive this:
 *  - a leading `/` anchors to the folder root
 *  - a pattern with no `/` matches at any depth
 *  - a trailing `/` matches the directory's contents but not the directory itself
 */
export function compilePattern(pattern: string): string[] {
    let p = pattern.replace(/\\/g, '/');

    const contentsOnly = p.endsWith('/');
    if (contentsOnly) p = p.slice(0, -1);
    if (!p) return [];

    let base: string;
    if (p.startsWith('/')) {
        base = p.slice(1);
    } else {
        // `**/` also matches zero directories, so this covers the root case too.
        base = '**/' + p;
    }
    if (!base) return [];

    // Matching the directory itself is what lets the tree grey out a whole subtree.
    return contentsOnly ? [base + '/**'] : [base, base + '/**'];
}

function parseLine(
    raw: string,
    line: number,
    managed: boolean,
    source: string | null
): Rule | null {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (trimmed.startsWith('//')) return null;
    if (trimmed.startsWith('#')) return null;

    let rest = trimmed;
    let negate = false;
    let caseInsensitive = false;
    let deletable = false;

    // Syncthing accepts these prefixes in any order and any combination.
    for (;;) {
        if (rest.startsWith('!')) { negate = true; rest = rest.slice(1); continue; }
        if (rest.startsWith('(?i)')) { caseInsensitive = true; rest = rest.slice(4); continue; }
        if (rest.startsWith('(?d)')) { deletable = true; rest = rest.slice(4); continue; }
        break;
    }
    if (!rest) return null;

    return {
        raw,
        line,
        negate,
        caseInsensitive,
        deletable,
        pattern: rest,
        globs: compilePattern(rest),
        managed,
        source
    };
}

/**
 * Parse `.stignore`, following `#include` when a resolver is given.
 *
 * Included patterns are inlined where the directive appears, because
 * first-match-wins runs across the combined list and the position of the
 * include decides what the included rules can still override.
 */
export function parseStignore(text: string, resolve?: IncludeResolver): ParsedStignore {
    const lines = text.split(/\r?\n/);
    const rules: Rule[] = [];
    const includes: string[] = [];
    const missingIncludes: string[] = [];
    // Syncthing treats including the same file twice as an error, and it also
    // stops us looping forever on a file that includes itself.
    const seen = new Set<string>();

    function walk(body: string, source: string | null) {
        let inManaged = false;

        body.split(/\r?\n/).forEach((raw, i) => {
            const trimmed = raw.trim();
            if (trimmed === MANAGED_BEGIN) { inManaged = true; return; }
            if (trimmed === MANAGED_END) { inManaged = false; return; }

            if (trimmed.startsWith('#include')) {
                const name = trimmed.slice('#include'.length).trim();
                if (!name) return;
                if (source === null) includes.push(name);
                if (seen.has(name)) return;
                seen.add(name);

                const included = resolve ? resolve(name) : null;
                if (included === null) {
                    if (resolve) missingIncludes.push(name);
                    return;
                }
                walk(included, name);
                return;
            }

            const rule = parseLine(raw, i, inManaged, source);
            if (rule) rules.push(rule);
        });
    }

    walk(text, null);

    return {
        rules,
        lines,
        includes,
        missingIncludes,
        hasEscapeDirective: (lines[0] || '').trim().startsWith('#escape=')
    };
}

/** True when `.stignore` delegates its patterns to the shared file. */
export function isSharedMode(parsed: ParsedStignore): boolean {
    return parsed.includes.includes(GLOBAL_IGNORE_FILE);
}

/**
 * Does `relPath` match this rule? `relPath` must use forward slashes and be
 * relative to the folder root, with no leading slash.
 */
export function ruleMatches(rule: Rule, relPath: string): boolean {
    const subject = rule.caseInsensitive ? relPath.toLowerCase() : relPath;
    return rule.globs.some((g) =>
        path.matchesGlob(subject, rule.caseInsensitive ? g.toLowerCase() : g)
    );
}

/**
 * First match wins. Returns the deciding rule, or null when nothing matches
 * and the path therefore syncs by default.
 */
export function matchRule(relPath: string, rules: Rule[]): Rule | null {
    for (const rule of rules) {
        if (ruleMatches(rule, relPath)) return rule;
    }
    return null;
}

export function isIgnored(relPath: string, rules: Rule[]): boolean {
    const hit = matchRule(relPath, rules);
    return hit ? !hit.negate : false;
}

/**
 * The line this tool writes for one path.
 *
 * Root-anchored with a leading `/`, so the line maps to exactly the path the
 * user picked in the tree and nothing else with the same name elsewhere. That
 * one-to-one match between a tree row and a line is what makes removal
 * expressible at all. No trailing slash, so the directory itself goes too and
 * we are not left with an empty directory syncing forever.
 *
 * `(?d)` lets Syncthing delete the contents when they block removing an
 * otherwise-empty parent. We write it only for directories whose name is on
 * the junk list, because that is the only case where we can honestly claim
 * the contents are regenerable. A folder the user picked by hand might be the
 * only copy of something.
 */
export function lineForPath(relPath: string, deletable: boolean): string {
    const clean = relPath.replace(/\\/g, '/').replace(/\/+$/, '');
    // Every line we write starts with `(` or `/`, so none of them can ever be
    // read back as a comment, a negation, or a directive. That falls out of
    // the format for free and is worth not breaking.
    return (deletable ? '(?d)/' : '/') + clean;
}

/**
 * Can this path be written as a literal pattern?
 *
 * A path holding glob syntax would need escaping, and `\` only escapes when
 * the file opens with `#escape=\`, so writing an escape can silently produce a
 * pattern that matches nothing. Refusing the path and saying so beats writing
 * a rule that quietly does not work. Directory names like this are rare enough
 * that nobody will meet this in practice.
 */
export function isWritablePath(relPath: string): boolean {
    return !/[*?[\]{}\\!]/.test(relPath);
}

/**
 * The lines the tool currently manages, in file order.
 *
 * These are whole lines, prefixes and all, not `Rule.pattern`, which has the
 * prefixes stripped for matching. Round-tripping through `pattern` would drop
 * the `(?d)` on every rewrite.
 */
export function managedPatterns(parsed: ParsedStignore): string[] {
    return parsed.rules.filter((r) => r.managed).map((r) => r.raw.trim());
}

/**
 * Rewrite a .stignore file so the managed block holds exactly `patterns`.
 *
 * The block goes at the BOTTOM of the file, and that placement is the whole
 * design. Syncthing takes the first matching rule, so anything the user wrote
 * by hand sits above the block and therefore outranks it. The tool can never
 * silently override a hand-written rule, and the user overrides the tool just
 * by putting a line above the block. Every byte outside the markers is
 * preserved untouched.
 *
 * Returns null when the result would be an empty file, which the caller turns
 * into "delete .stignore" rather than leaving an empty file behind.
 */
export function renderStignore(existing: string, patterns: string[]): string | null {
    const eol = existing.includes('\r\n') ? '\r\n' : '\n';
    const lines = existing.length ? existing.split(/\r?\n/) : [];

    const beginAt = lines.findIndex((l) => l.trim() === MANAGED_BEGIN);
    const endAt = lines.findIndex((l) => l.trim() === MANAGED_END);

    // Everything the user owns, with any previous block cut out.
    let before: string[];
    let after: string[];
    if (beginAt !== -1 && endAt > beginAt) {
        before = lines.slice(0, beginAt);
        after = lines.slice(endAt + 1);
    } else if (beginAt !== -1) {
        // A surviving opening marker with no close: treat the rest as ours.
        before = lines.slice(0, beginAt);
        after = [];
    } else {
        before = lines;
        after = [];
    }

    const outer = [...before, ...after];
    while (outer.length && !outer[outer.length - 1].trim()) outer.pop();

    const sorted = [...new Set(patterns)].sort((a, b) => a.localeCompare(b));

    if (!sorted.length) {
        // No managed rules left. Drop the markers rather than leave an empty pair.
        return outer.length ? outer.join(eol) + eol : null;
    }

    const block = [MANAGED_BEGIN, ...sorted, MANAGED_END];
    const out = outer.length ? [...outer, '', ...block] : block;
    return out.join(eol) + eol;
}
