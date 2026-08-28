import { json } from '@sveltejs/kit';
import { setShared } from '$lib/server/stignore-file';

/**
 * Move the managed rules between `.stignore` (this device only) and
 * `.stglobalignore` (a file the folder syncs, pulled in with #include).
 */
export async function POST({ request }) {
    let on = false;
    try {
        on = !!(await request.json()).shared;
    } catch {
        return json({ ok: false, error: 'Bad request body' }, { status: 400 });
    }

    const result = await setShared(on);
    return json(result, { status: result.ok ? 200 : 500 });
}
