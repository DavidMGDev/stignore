import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export let APP_VERSION = '0.0.0';
try {
    APP_VERSION = JSON.parse(
        fs.readFileSync(path.resolve(__dirname, '../../../package.json'), 'utf-8')
    ).version;
} catch {
    // A missing package.json only costs us the footer version string.
}

/**
 * The folder the user ran `stignore` in. Fixed for the life of the process:
 * the tool is scoped to one folder by definition, and changing it means
 * running the command somewhere else.
 */
export function getCwd() {
    return process.env.STIGNORE_CWD || process.cwd();
}
