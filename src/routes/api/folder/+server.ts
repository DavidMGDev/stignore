import { json } from '@sveltejs/kit';
import fs from 'fs/promises';
import path from 'path';
import { getCwd, setCwd, pickDirectory } from '$lib/server/sys-utils';

/**
 * Repoint the tool at another folder without restarting it.
 *
 * `action: "browse"` opens the OS folder dialog and switches to whatever comes
 * back. `action: "set"` takes a typed path, for when no dialog is available.
 */
export async function POST({ request }) {
    let body: any = {};
    try {
        body = await request.json();
    } catch {
        return json({ ok: false, error: 'Bad request body' }, { status: 400 });
    }

    let target: string | null = null;

    if (body.action === 'browse') {
        target = await pickDirectory();
        // Cancelling the dialog is a normal outcome, not a failure.
        if (!target) return json({ ok: true, cancelled: true, cwd: getCwd() });
    } else {
        target = typeof body.path === 'string' ? body.path.trim() : '';
        if (!target) return json({ ok: false, error: 'No folder given' }, { status: 400 });
    }

    const resolved = path.resolve(target.replace(/^["']|["']$/g, ''));
    try {
        if (!(await fs.stat(resolved)).isDirectory()) {
            return json({ ok: false, error: 'That path is not a folder.' }, { status: 400 });
        }
    } catch {
        return json({ ok: false, error: `Not found: ${resolved}` }, { status: 400 });
    }

    if (!setCwd(resolved)) {
        return json({ ok: false, error: 'Could not switch to that folder.' }, { status: 400 });
    }

    console.log('\x1b[36m%s\x1b[0m', `› Now managing: ${resolved}`);
    return json({ ok: true, cwd: getCwd() });
}
