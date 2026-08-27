import { json } from '@sveltejs/kit';
import path from 'path';
import { scanDirectory } from '$lib/tree';
import { getCwd } from '$lib/server/sys-utils';
import { readStignore, isSafeRelPath } from '$lib/server/stignore-file';

export async function GET({ url }) {
    const cwd = getCwd();
    const subPath = url.searchParams.get('path') || '';

    if (subPath && !isSafeRelPath(subPath)) {
        return json({ tree: [], error: 'Path outside the folder' }, { status: 400 });
    }

    // Re-read on every request so the tree reflects the file as it is now,
    // including edits made in another editor while this page was open.
    const state = await readStignore();

    const scanRoot = subPath ? path.join(cwd, subPath) : cwd;
    const startDepth = subPath ? subPath.split('/').length : 0;

    try {
        const tree = await scanDirectory(
            cwd,
            scanRoot,
            state.parsed.rules,
            startDepth,
            !!subPath
        );
        return json({ tree });
    } catch (e) {
        console.error(e);
        return json({ tree: [], error: 'Scan failed' }, { status: 500 });
    }
}
