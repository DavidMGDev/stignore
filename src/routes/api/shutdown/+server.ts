import { json } from '@sveltejs/kit';

export async function POST({ request }) {
    let body: any = {};
    try { body = await request.json(); } catch {}

    // A stale tab from a previous run must not be able to kill this server.
    if (body.sessionId !== process.env.STIGNORE_SESSION_ID) {
        return json({ ok: false }, { status: 403 });
    }

    console.log('\n\x1b[32m%s\x1b[0m', '✓ Closed from the UI.');
    setTimeout(() => process.exit(0), 100);
    return json({ ok: true });
}
