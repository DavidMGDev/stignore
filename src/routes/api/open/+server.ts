import { json } from '@sveltejs/kit';
import open from 'open';
import { stignorePath } from '$lib/server/stignore-file';
import { getCwd } from '$lib/server/sys-utils';

/**
 * The escape hatch. Rules the user wrote by hand are never edited by this
 * tool, so the answer to "change that one" is to open the file.
 */
export async function POST({ request }) {
    let target = 'file';
    try { target = (await request.json()).target || 'file'; } catch {}

    try {
        await open(target === 'folder' ? getCwd() : stignorePath());
        return json({ ok: true });
    } catch (e: any) {
        return json({ ok: false, error: e?.message || 'Could not open' }, { status: 500 });
    }
}
