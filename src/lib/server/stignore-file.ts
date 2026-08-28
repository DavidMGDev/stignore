import fs from 'fs/promises';
import fsSync from 'fs';
import os from 'os';
import crypto from 'crypto';
import path from 'path';
import { getCwd } from '$lib/server/sys-utils';
import {
    STIGNORE_FILE,
    GLOBAL_IGNORE_FILE,
    INCLUDE_LINE,
    parseStignore,
    managedPatterns,
    renderStignore,
    matchRule,
    isSharedMode,
    type ParsedStignore
} from '$lib/stignore';

const BOM = '﻿';

export interface FileFacts {
    exists: boolean;
    readable: boolean;
    error: string | null;
    path: string;
    size: number;
    mtimeMs: number;
    hasBom: boolean;
    text: string;
}

export interface State {
    /** `.stignore`, which Syncthing never syncs. */
    stignore: FileFacts;
    /** `.stglobalignore`, an ordinary file the folder syncs like any other. */
    global: FileFacts;
    /** Combined view, with includes inlined in evaluation order. */
    parsed: ParsedStignore;
    /** True when `.stignore` delegates to the shared file. */
    shared: boolean;
    /** The file managed patterns are written to, given the current mode. */
    targetName: string;
    targetPath: string;
}

function emptyFacts(p: string): FileFacts {
    return {
        exists: false,
        readable: true,
        error: null,
        path: p,
        size: 0,
        mtimeMs: 0,
        hasBom: false,
        text: ''
    };
}

async function readFacts(filePath: string): Promise<FileFacts> {
    const facts = emptyFacts(filePath);
    let stat;
    try {
        stat = await fs.stat(filePath);
    } catch (e: any) {
        if (e?.code === 'ENOENT') return facts;
        return { ...facts, exists: true, readable: false, error: e?.code || String(e) };
    }

    try {
        let text = await fs.readFile(filePath, 'utf-8');
        const hasBom = text.startsWith(BOM);
        if (hasBom) text = text.slice(1);
        return {
            exists: true,
            readable: true,
            error: null,
            path: filePath,
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            hasBom,
            text
        };
    } catch (e: any) {
        return {
            ...facts,
            exists: true,
            readable: false,
            error: e?.code || String(e),
            size: stat.size,
            mtimeMs: stat.mtimeMs
        };
    }
}

export function stignorePath() {
    return path.join(getCwd(), STIGNORE_FILE);
}

export function globalIgnorePath() {
    return path.join(getCwd(), GLOBAL_IGNORE_FILE);
}

export async function readState(): Promise<State> {
    const stignore = await readFacts(stignorePath());
    const global = await readFacts(globalIgnorePath());

    // Includes are resolved against the folder root. Reading is synchronous so
    // the parser can stay a plain function the tests can drive with a map.
    const parsed = parseStignore(stignore.text, (name) => {
        const target = path.resolve(getCwd(), name);
        if (!target.startsWith(path.resolve(getCwd()))) return null;
        try {
            return fsSync.readFileSync(target, 'utf-8').replace(/^﻿/, '');
        } catch {
            return null;
        }
    });

    const shared = isSharedMode(parsed);
    return {
        stignore,
        global,
        parsed,
        shared,
        targetName: shared ? GLOBAL_IGNORE_FILE : STIGNORE_FILE,
        targetPath: shared ? globalIgnorePath() : stignorePath()
    };
}

/**
 * Where a backup of `filePath` goes.
 *
 * Deliberately outside the synced folder. A `.bak` sitting next to `.stignore`
 * would sync to every device, and each device writing its own would produce
 * conflict files, which is worse than having no backup at all.
 */
export function backupPath(filePath: string): string {
    const key = crypto.createHash('sha1').update(filePath).digest('hex').slice(0, 12);
    return path.join(os.tmpdir(), 'stignore-backups', `${key}-${path.basename(filePath)}.bak`);
}

async function backup(filePath: string) {
    const dest = backupPath(filePath);
    await fs.mkdir(path.dirname(dest), { recursive: true }).catch(() => {});
    await fs.copyFile(filePath, dest).catch(() => {});
}

/** Write text to `filePath` atomically. */
async function writeAtomic(filePath: string, content: string | null, hasBom: boolean) {
    if (content === null) {
        await fs.rm(filePath, { force: true });
        return;
    }
    const tmp = filePath + '.tmp';
    await fs.writeFile(tmp, (hasBom ? BOM : '') + content, 'utf-8');
    await fs.rename(tmp, filePath);
}

export interface WriteResult {
    ok: boolean;
    conflict?: boolean;
    error?: string;
    added: string[];
    removed: string[];
    shadowed: { path: string; by: string }[];
}

/**
 * Add and remove managed lines in whichever file currently holds the patterns.
 */
export async function writeManaged(
    add: string[],
    remove: string[],
    expectMtimeMs = 0,
    addedPaths: string[] = []
): Promise<WriteResult> {
    const before = await readState();
    const target = before.shared ? before.global : before.stignore;

    if (!target.readable || !before.stignore.readable) {
        return {
            ok: false,
            error: target.error || before.stignore.error || 'unreadable',
            added: [],
            removed: [],
            shadowed: []
        };
    }

    if (expectMtimeMs && target.exists && target.mtimeMs !== expectMtimeMs) {
        return {
            ok: false,
            conflict: true,
            error: 'The file changed on disk since it was loaded.',
            added: [],
            removed: [],
            shadowed: []
        };
    }

    // Parse the target file on its own. Its managed block is the only thing we
    // rewrite, and resolving includes here would mix in rules we do not own.
    const targetParsed = parseStignore(target.text);
    const current = managedPatterns(targetParsed);
    const removeSet = new Set(remove);
    const next = [...current.filter((l) => !removeSet.has(l)), ...add];

    const rendered = renderStignore(target.text, next);

    try {
        if (target.exists) await backup(target.path);
        // In shared mode the file has to survive even when empty: `.stignore`
        // includes it, and Syncthing errors the whole folder on a missing
        // include target.
        if (rendered === null && before.shared) {
            await writeAtomic(target.path, '', target.hasBom);
        } else {
            await writeAtomic(target.path, rendered, target.hasBom);
        }
    } catch (e: any) {
        await fs.rm(target.path + '.tmp', { force: true }).catch(() => {});
        return { ok: false, error: e?.code || String(e), added: [], removed: [], shadowed: [] };
    }

    const after = await readState();
    const shadowed: { path: string; by: string }[] = [];
    for (const p of addedPaths) {
        const hit = matchRule(p, after.parsed.rules);
        if (hit && !hit.negate) continue;
        shadowed.push({ path: p, by: hit ? hit.raw.trim() : 'an earlier rule' });
    }

    return {
        ok: true,
        added: add,
        removed: remove.filter((l) => current.includes(l)),
        shadowed
    };
}

/**
 * Move patterns between `.stignore` and the shared `.stglobalignore`.
 *
 * Turning sharing on writes the shared file BEFORE adding the include line.
 * Syncthing treats a missing include target as a folder error, so the order
 * here is not cosmetic.
 */
export async function setShared(on: boolean): Promise<{ ok: boolean; error?: string }> {
    const before = await readState();
    if (before.shared === on) return { ok: true };

    if (!before.stignore.readable || !before.global.readable) {
        return { ok: false, error: before.stignore.error || before.global.error || 'unreadable' };
    }

    try {
        if (on) {
            const local = managedPatterns(parseStignore(before.stignore.text));

            // 1. Shared file first, so the include never points at nothing.
            const globalBody =
                renderStignore(before.global.text, [
                    ...managedPatterns(parseStignore(before.global.text)),
                    ...local
                ]) ?? '';
            await writeAtomic(globalIgnorePath(), globalBody, before.global.hasBom);

            // 2. Then swap .stignore's managed block for the include line.
            await writeAtomic(
                stignorePath(),
                renderStignore(before.stignore.text, [INCLUDE_LINE]),
                before.stignore.hasBom
            );
        } else {
            const shared = managedPatterns(parseStignore(before.global.text));

            // Drop the include first, so the folder never references a file we
            // are about to stop maintaining.
            await writeAtomic(
                stignorePath(),
                renderStignore(before.stignore.text, shared),
                before.stignore.hasBom
            );
            // `.stglobalignore` is left on disk on purpose. Deleting it would
            // propagate that deletion to every other device, and those devices
            // may still be including it.
        }
        return { ok: true };
    } catch (e: any) {
        return { ok: false, error: e?.code || String(e) };
    }
}

/**
 * Reject anything that would escape the folder root. This is the only code
 * path that writes to disk from a browser request, so the guard is explicit.
 */
export function isSafeRelPath(p: string): boolean {
    if (!p || typeof p !== 'string') return false;
    if (path.isAbsolute(p)) return false;
    const normalized = path.normalize(p);
    if (normalized.startsWith('..')) return false;
    const root = path.resolve(getCwd());
    const resolved = path.resolve(root, normalized);
    return resolved !== root && (resolved + path.sep).startsWith(root + path.sep);
}

/**
 * Empty the rules.
 *
 * `managed` removes only what this tool wrote, so hand-written lines survive.
 * `all` empties both files completely. In shared mode `.stglobalignore` is
 * truncated rather than deleted, because `.stignore` includes it and Syncthing
 * errors the whole folder on a missing include target.
 */
export async function clearRules(
    scope: 'managed' | 'all'
): Promise<{ ok: boolean; error?: string; cleared: number }> {
    const before = await readState();
    const cleared = before.parsed.rules.filter((r) => (scope === 'all' ? true : r.managed)).length;

    if (!before.stignore.readable || !before.global.readable) {
        return { ok: false, error: before.stignore.error || before.global.error || 'unreadable', cleared: 0 };
    }

    try {
        if (before.stignore.exists) await backup(stignorePath());
        if (before.global.exists) await backup(globalIgnorePath());

        if (scope === 'all') {
            // Keep the include wiring intact when sharing is on, so the folder
            // does not error, but drop every rule from both files.
            if (before.shared) {
                await writeAtomic(globalIgnorePath(), '', before.global.hasBom);
                await writeAtomic(
                    stignorePath(),
                    renderStignore('', [INCLUDE_LINE]),
                    before.stignore.hasBom
                );
            } else {
                await writeAtomic(stignorePath(), null, false);
            }
        } else {
            const target = before.shared ? globalIgnorePath() : stignorePath();
            const targetFacts = before.shared ? before.global : before.stignore;
            const rendered = renderStignore(targetFacts.text, []);
            await writeAtomic(
                target,
                rendered === null && before.shared ? '' : rendered,
                targetFacts.hasBom
            );
        }
        return { ok: true, cleared };
    } catch (e: any) {
        return { ok: false, error: e?.code || String(e), cleared: 0 };
    }
}
