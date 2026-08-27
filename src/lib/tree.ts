import fs from 'fs/promises';
import path from 'path';
import { logDebug } from '$lib/server/logger.js';
import { matchRule, type Rule } from '$lib/stignore';

export interface TreeNode {
    name: string;
    /** Path relative to the folder root, forward slashes, no leading slash. */
    path: string;
    type: 'file' | 'folder';
    children?: TreeNode[];
    depth: number;
    /** Syncthing will skip this path given the current .stignore. */
    isIgnored: boolean;
    /** The pattern that decided, ignored or negated. Null when nothing matched. */
    decidedBy: string | null;
    /** The deciding rule was a `!` negation, so this path syncs on purpose. */
    isNegated: boolean;
    /** The deciding line sits inside our managed block. */
    isManaged: boolean;
    /** Name is on the junk list, so the auto-detect button would pick it up. */
    isJunk: boolean;
    /** Not walked into. Either a known-huge directory or one with too many entries. */
    isMassive: boolean;
    /** Syncthing owns this name. A rule for it would do nothing. */
    neverSynced: boolean;
}

/**
 * Directories that are generated, reinstallable, and expensive to sync.
 * Syncing these is what makes a Syncthing folder thrash: thousands of small
 * files, rewritten constantly, that any machine can rebuild on its own.
 *
 * Everything here has a name that is unambiguous in practice. Names that are
 * sometimes generated and sometimes hand-written stay off the list, because
 * one wrong auto-ignore silently stops syncing real work. `bin`, `env`, `out`,
 * `lib` and `vendor` all failed that bar and are deliberately absent. The user
 * can still tick those in the tree and use the selection button.
 */
export const JUNK_DIRS = new Set([
    // JavaScript
    'node_modules', 'bower_components', '.next', '.nuxt', '.svelte-kit',
    '.output', '.turbo', '.parcel-cache', '.vite', '.yarn',
    // Python
    '.venv', 'venv', '__pycache__', '.tox', '.mypy_cache',
    '.pytest_cache', '.ruff_cache', '.ipynb_checkpoints',
    // Compiled output
    'dist', 'build', 'target', 'obj', 'CMakeFiles',
    // Tooling caches
    '.gradle', '.cache', '.terraform', 'coverage', 'Pods', 'DerivedData',
    '.godot', '.dart_tool', '.stack-work'
    // `.git` is deliberately not here. It is not junk, losing one is
    // unrecoverable, and plenty of people sync repositories on purpose. It is
    // still in MASSIVE_DIRS so the tree does not walk it, and the user can
    // still tick it by hand in two seconds.
]);

/**
 * Directories we refuse to walk into during a normal render. Expanding one in
 * the UI re-requests it explicitly, which is the lazy-load path.
 */
const MASSIVE_DIRS = new Set([
    'node_modules', 'bower_components', 'vendor', '.git', '.svn', '.hg',
    '.godot', '.svelte-kit', '.next', '.nuxt', '.output', '.venv', 'venv',
    'dist', 'build', 'out', 'target', 'CMakeFiles', '.gradle'
]);

const MAX_FOLDER_ITEMS = 250;

/** Syncthing's own folder marker. Ignoring it would break the folder. */
const NEVER_TOUCH = new Set(['.stfolder', '.stignore', '.stversions']);

export function isJunkName(name: string): boolean {
    return JUNK_DIRS.has(name) || name.endsWith('.egg-info');
}

function toRel(rootDir: string, fullPath: string): string {
    return path.relative(rootDir, fullPath).split(path.sep).join('/');
}

export async function scanDirectory(
    rootDir: string,
    currentDir: string,
    rules: Rule[],
    depth = 0,
    /** True when the caller asked for this exact folder, so walk it even if it is huge. */
    isLazyLoadRoot = false
): Promise<TreeNode[]> {
    logDebug(`Scanning ${currentDir} (depth ${depth})`);

    let entries: import('fs').Dirent[] = [];
    try {
        entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch {
        return [];
    }

    const tooManyItems = entries.length > MAX_FOLDER_ITEMS;
    const knownMassive = MASSIVE_DIRS.has(path.basename(currentDir));
    if (depth > 0 && (knownMassive || tooManyItems) && !isLazyLoadRoot) {
        return [];
    }

    entries.sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
    });

    const nodes: TreeNode[] = [];

    for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        const relPath = toRel(rootDir, fullPath);
        const isDirectory = entry.isDirectory();

        // Shown but not selectable, so "where did my .stignore go" never comes up.
        const neverSynced = depth === 0 && NEVER_TOUCH.has(entry.name);

        const hit = matchRule(relPath, rules);
        const isNegated = !!hit?.negate;
        const isIgnored = hit ? !hit.negate : false;

        let isMassive = false;
        let children: TreeNode[] | undefined;

        if (isDirectory && !neverSynced) {
            if (MASSIVE_DIRS.has(entry.name)) {
                isMassive = true;
                children = [];
            } else {
                children = await scanDirectory(rootDir, fullPath, rules, depth + 1, false);
            }
        }

        nodes.push({
            name: entry.name,
            path: relPath,
            type: isDirectory ? 'folder' : 'file',
            children,
            depth,
            isIgnored,
            decidedBy: hit ? hit.raw.trim() : null,
            isNegated,
            isManaged: !!hit?.managed,
            isJunk: isDirectory && !neverSynced && isJunkName(entry.name),
            isMassive,
            neverSynced
        });
    }

    return nodes;
}

export interface JunkHit {
    /** Path relative to the folder root. */
    path: string;
    /** Directory name, which is also what put it on the list. */
    name: string;
    /** How many path segments deep it sits. A root-level hit is 1. */
    depth: number;
    /** Already covered by the current .stignore. */
    alreadyIgnored: boolean;
}

/**
 * Walk the folder looking for junk directories.
 *
 * `maxDepth` counts path segments, so 1 finds only root-level hits like
 * `./node_modules`, 2 also finds `packages/web/../node_modules` one level in,
 * and so on. The walk stops descending once it finds a hit, because
 * node_modules inside node_modules is not a separate decision.
 */
export async function findJunk(
    rootDir: string,
    maxDepth: number,
    rules: Rule[]
): Promise<JunkHit[]> {
    const hits: JunkHit[] = [];

    async function walk(dir: string, depth: number) {
        if (depth > maxDepth) return;

        let entries: import('fs').Dirent[] = [];
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            if (NEVER_TOUCH.has(entry.name)) continue;

            const fullPath = path.join(dir, entry.name);
            const relPath = toRel(rootDir, fullPath);

            if (isJunkName(entry.name)) {
                const hit = matchRule(relPath, rules);
                hits.push({
                    path: relPath,
                    name: entry.name,
                    depth,
                    alreadyIgnored: hit ? !hit.negate : false
                });
                // Do not descend. Junk inside junk is the same decision.
                continue;
            }

            await walk(fullPath, depth + 1);
        }
    }

    await walk(rootDir, 1);
    hits.sort((a, b) => a.path.localeCompare(b.path));
    return hits;
}
