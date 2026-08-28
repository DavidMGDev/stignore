import { json } from '@sveltejs/kit';
import path from 'path';
import fs from 'fs/promises';
import { lineForPath, isWritablePath } from '$lib/stignore';
import { isJunkName } from '$lib/tree';
import { getCwd } from '$lib/server/sys-utils';
import { writeManaged, isSafeRelPath } from '$lib/server/stignore-file';
import { logDebug } from '$lib/server/logger';

/**
 * Drop any path that already has an ancestor in the same batch. Ticking a
 * folder and everything under it should write one line, not two hundred.
 */
function pruneCovered(paths: string[]): string[] {
    const sorted = [...new Set(paths)].sort();
    const kept: string[] = [];
    for (const p of sorted) {
        if (kept.some((k) => p === k || p.startsWith(k + '/'))) continue;
        kept.push(p);
    }
    return kept;
}

export async function POST({ request }) {
    let body: any;
    try {
        body = await request.json();
    } catch {
        return json({ ok: false, error: 'Bad request body' }, { status: 400 });
    }

    const addPaths: string[] = Array.isArray(body.add) ? body.add : [];
    const removePaths: string[] = Array.isArray(body.remove) ? body.remove : [];
    const expectMtimeMs = Number(body.expectMtimeMs) || 0;

    // Catalogue patterns arrive as literal lines rather than paths, since
    // `*.log` is a glob and not something that exists in the tree.
    const cleanLine = (l: unknown) =>
        typeof l === 'string' && l.trim() && !/[\r\n]/.test(l) && l.length < 512
            ? l.trim()
            : null;
    const addLines0: string[] = (Array.isArray(body.addLines) ? body.addLines : [])
        .map(cleanLine)
        .filter(Boolean) as string[];
    const removeLines: string[] = (Array.isArray(body.removeLines) ? body.removeLines : [])
        .map(cleanLine)
        .filter(Boolean) as string[];

    const bad = [...addPaths, ...removePaths].filter((p) => !isSafeRelPath(p));
    if (bad.length) {
        return json({ ok: false, error: 'Path outside the folder', bad }, { status: 400 });
    }

    const cwd = getCwd();
    const pruned = pruneCovered(addPaths);

    // A path holding glob syntax cannot be written as a literal pattern, so we
    // say which ones instead of writing a rule that matches nothing.
    const rejected = pruned.filter((p) => !isWritablePath(p));
    const writable = pruned.filter((p) => isWritablePath(p));

    const addLines: string[] = [...addLines0];
    for (const p of writable) {
        // (?d) only where the name says the contents are regenerable.
        let deletable = isJunkName(path.basename(p));
        if (deletable) {
            try {
                deletable = (await fs.stat(path.join(cwd, p))).isDirectory();
            } catch {
                deletable = false;
            }
        }
        addLines.push(lineForPath(p, deletable));
    }

    // Removal targets both shapes, since we cannot know which one wrote the
    // line without reading it, and both are ours.
    const allRemoveLines = [
        ...removeLines,
        ...removePaths.flatMap((p) => [lineForPath(p, true), lineForPath(p, false)])
    ];

    logDebug('rules write', { add: addLines, remove: allRemoveLines });

    const result = await writeManaged(addLines, allRemoveLines, expectMtimeMs, writable);

    return json(
        {
            ok: result.ok,
            conflict: result.conflict || false,
            error: result.error,
            added: result.added,
            removed: result.removed,
            shadowed: result.shadowed,
            rejected
        },
        { status: result.ok ? 200 : result.conflict ? 409 : 500 }
    );
}
