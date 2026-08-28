import { json } from '@sveltejs/kit';
import { clearRules } from '$lib/server/stignore-file';

/**
 * Empty the ignore rules.
 *
 * `scope: "managed"` drops only the lines this tool wrote and leaves anything
 * hand-written alone. `scope: "all"` empties the file completely, including
 * hand-written rules, which is why the UI shows the exact content first.
 */
export async function POST({ request }) {
    let scope = 'managed';
    try {
        scope = (await request.json()).scope === 'all' ? 'all' : 'managed';
    } catch {
        return json({ ok: false, error: 'Bad request body' }, { status: 400 });
    }

    const result = await clearRules(scope as 'managed' | 'all');
    return json(result, { status: result.ok ? 200 : 500 });
}
