import { json } from '@sveltejs/kit';
import { findJunk } from '$lib/tree';
import { getCwd } from '$lib/server/sys-utils';
import { readStignore } from '$lib/server/stignore-file';

const DEFAULT_DEPTH = 3;
const MAX_DEPTH = 8;

export async function GET({ url }) {
    const raw = Number(url.searchParams.get('depth'));
    // Clamp rather than reject: an out-of-range depth is a slider that got
    // dragged, not an attack.
    const depth = Number.isFinite(raw)
        ? Math.min(MAX_DEPTH, Math.max(1, Math.trunc(raw)))
        : DEFAULT_DEPTH;

    const state = await readStignore();

    try {
        const found = await findJunk(getCwd(), depth, state.parsed.rules);
        return json({ depth, found });
    } catch (e) {
        console.error(e);
        return json({ depth, found: [], error: 'Scan failed' }, { status: 500 });
    }
}
