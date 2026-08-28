import { json } from '@sveltejs/kit';
import fs from 'fs/promises';
import path from 'path';
import { getCwd, APP_VERSION } from '$lib/server/sys-utils';
import { readState } from '$lib/server/stignore-file';
import { GLOBAL_IGNORE_FILE } from '$lib/stignore';

export async function GET() {
    const cwd = getCwd();
    const state = await readState();
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
    const target = state.shared ? state.global : state.stignore;

    return json({
        cwd,
        appVersion: APP_VERSION,
        sessionId: process.env.STIGNORE_SESSION_ID || '',
        hasStfolder,
        shared: state.shared,
        globalFileName: GLOBAL_IGNORE_FILE,
        globalExists: state.global.exists,
        // A dangling include is a folder error in Syncthing, not a warning.
        missingIncludes: state.parsed.missingIncludes,
        file: {
            exists: state.stignore.exists,
            readable: state.stignore.readable && state.global.readable,
            error: state.stignore.error || state.global.error,
            path: state.stignore.path,
            // Which file the buttons will actually write to.
            targetName: state.targetName,
            targetPath: state.targetPath,
            size: target.size,
            mtimeMs: target.mtimeMs,
            lineCount: state.stignore.exists ? state.parsed.lines.length : 0,
            // The rules, for handing to a device that cannot run this tool.
            raw: state.shared ? state.global.text : state.stignore.text
        },
        counts: {
            total: rules.length,
            managed: managed.length,
            manual: rules.length - managed.length,
            negations: rules.filter((r) => r.negate).length
        },
        includes: state.parsed.includes,
        hasEscapeDirective: state.parsed.hasEscapeDirective,
        managedRules: managed.map((r) => ({
            line: r.raw.trim(),
            path: r.pattern.replace(/^\//, ''),
            deletable: r.deletable,
            source: r.source
        }))
    });
}
