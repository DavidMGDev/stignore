import { json } from '@sveltejs/kit';

/**
 * The page polls this only to notice the server going away. Nothing here
 * shuts anything down: the watchdog that used to kill the process when the
 * browser stopped pinging is gone on purpose.
 */
export function GET() {
    return json({ ok: true });
}
