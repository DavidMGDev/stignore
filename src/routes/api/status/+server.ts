import { json } from '@sveltejs/kit';
import fs from 'fs/promises';
import path from 'path';
import { getCwd, APP_VERSION } from '$lib/server/sys-utils';
import { readStignore } from '$lib/server/stignore-file';

export async function GET() {
    const cwd = getCwd();
    const state = await readStignore();
    const rules = state.parsed.rules;

    // Syncthing drops a .stfolder marker in every folder it manages. Its
    // absence is worth saying out loud, because a .stignore only takes effect
    // at a folder root. It is not a blocker: people write the ignore file
    // before adding the folder to Syncthing all the time.
    let hasStfolder = false;
    try {
        hasStfolder = (await fs.stat(path.join(cwd, '.stfolder'))).isDirectory();
    } catch {
        hasStfolder = false;
    }

    const managed = rules.filter((r) => r.managed);

    return json({
        cwd,
        appVersion: APP_VERSION,
        sessionId: process.env.STIGNORE_SESSION_ID || '',
        hasStfolder,
        file: {
            exists: state.exists,
            readable: state.readable,
            error: state.error,
            path: state.path,
            size: state.size,
            mtimeMs: state.mtimeMs,
            lineCount: state.exists ? state.parsed.lines.length : 0,
            // The whole file, so the UI can hand it to another device.
            // .stignore is per device and Syncthing never syncs it.
            raw: state.exists ? state.text : ''
        },
        counts: {
            total: rules.length,
            managed: managed.length,
            manual: rules.length - managed.length,
            negations: rules.filter((r) => r.negate).length
        },
        // We preserve #include lines but cannot follow them, so the tree
        // preview can be incomplete. The UI says so rather than pretending.
        includes: state.parsed.includes,
        hasEscapeDirective: state.parsed.hasEscapeDirective,
        managedRules: managed.map((r) => ({
            line: r.raw.trim(),
            path: r.pattern.replace(/^\//, ''),
            deletable: r.deletable
        }))
    });
}
