import fs from 'fs/promises';
import path from 'path';
import { getCwd } from '$lib/server/sys-utils';
import {
    STIGNORE_FILE,
    parseStignore,
    managedPatterns,
    renderStignore,
    matchRule,
    type ParsedStignore
} from '$lib/stignore';

const BOM = '﻿';

export interface FileState {
    exists: boolean;
    readable: boolean;
    /** errno string when readable is false. */
    error: string | null;
    path: string;
    size: number;
    mtimeMs: number;
    hasBom: boolean;
    text: string;
    parsed: ParsedStignore;
}

export function stignorePath(): string {
    return path.join(getCwd(), STIGNORE_FILE);
}

export async function readStignore(): Promise<FileState> {
    const filePath = stignorePath();
    const empty = {
        path: filePath,
        size: 0,
        mtimeMs: 0,
        hasBom: false,
        text: '',
        parsed: parseStignore('')
    };

    let stat;
    try {
        stat = await fs.stat(filePath);
    } catch (e: any) {
        if (e?.code === 'ENOENT') {
            // No file yet is the normal starting state, not an error.
            return { exists: false, readable: true, error: null, ...empty };
        }
        return { exists: true, readable: false, error: e?.code || String(e), ...empty };
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
            text,
            parsed: parseStignore(text)
        };
    } catch (e: any) {
        return {
            exists: true,
            readable: false,
            error: e?.code || String(e),
            ...empty,
            size: stat.size,
            mtimeMs: stat.mtimeMs
        };
    }
}

export interface WriteResult {
    ok: boolean;
    /** Set when the file changed underneath us and we refused to write. */
    conflict?: boolean;
    error?: string;
    added: string[];
    removed: string[];
    /**
     * Lines we wrote that an earlier rule already decides. Appending below the
     * user's own rules means a rule can land in the file and still do nothing,
     * so we re-read after writing and say which ones those are rather than
     * reporting a success that did not happen.
     */
    shadowed: { path: string; by: string }[];
    state: FileState;
}

/**
 * Add and remove managed lines in one atomic write.
 *
 * `add` and `remove` are managed lines, exactly as they appear in the block,
 * not bare paths. `expectMtimeMs` guards against clobbering an edit made in
 * another editor while the page was open; pass 0 to skip the check.
 */
export async function writeManaged(
    add: string[],
    remove: string[],
    expectMtimeMs = 0,
    addedPaths: string[] = []
): Promise<WriteResult> {
    const before = await readStignore();

    if (!before.readable) {
        return {
            ok: false,
            error: before.error || 'unreadable',
            added: [],
            removed: [],
            shadowed: [],
            state: before
        };
    }

    if (expectMtimeMs && before.exists && before.mtimeMs !== expectMtimeMs) {
        return {
            ok: false,
            conflict: true,
            error: 'The file changed on disk since it was loaded.',
            added: [],
            removed: [],
            shadowed: [],
            state: before
        };
    }

    const current = managedPatterns(before.parsed);
    const removeSet = new Set(remove);
    const next = [...current.filter((l) => !removeSet.has(l)), ...add];

    const rendered = renderStignore(before.text, next);
    const filePath = stignorePath();

    try {
        // One generation of undo, for the price of a copy. If a write ever goes
        // wrong, the previous file is sitting right next to it.
        if (before.exists) {
            await fs.copyFile(filePath, filePath + '.bak').catch(() => {});
        }

        if (rendered === null) {
            // Nothing left to say. An empty .stignore is noise, so remove it.
            if (before.exists) await fs.rm(filePath, { force: true });
        } else {
            // Write beside the target and rename, so a crash or a full disk
            // can never truncate a file the user hand-wrote.
            const tmp = filePath + '.tmp';
            await fs.writeFile(tmp, (before.hasBom ? BOM : '') + rendered, 'utf-8');
            await fs.rename(tmp, filePath);
        }
    } catch (e: any) {
        await fs.rm(filePath + '.tmp', { force: true }).catch(() => {});
        return {
            ok: false,
            error: e?.code || String(e),
            added: [],
            removed: [],
            shadowed: [],
            state: before
        };
    }

    const after = await readStignore();
    const shadowed: { path: string; by: string }[] = [];
    for (const p of addedPaths) {
        const hit = matchRule(p, after.parsed.rules);
        // Ignored is what we wanted. Anything else means an earlier rule,
        // almost always a hand-written `!` line, got there first.
        if (hit && !hit.negate) continue;
        shadowed.push({ path: p, by: hit ? hit.raw.trim() : 'an earlier rule' });
    }

    return {
        ok: true,
        added: add,
        removed: remove.filter((l) => current.includes(l)),
        shadowed,
        state: after
    };
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
