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

/** @type {string | null} */
let CURRENT_DIR = null;

/**
 * The folder the tool is pointed at. Starts as the launch directory and can
 * be repointed from the UI, which beats quitting and re-running the command
 * somewhere else.
 */
export function getCwd() {
    return CURRENT_DIR || process.env.STIGNORE_CWD || process.cwd();
}


/**
 * Point the tool at a different folder without restarting the process.
 * @param {string} next
 */
export function setCwd(next) {
    const resolved = path.resolve(next);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) return false;
    CURRENT_DIR = resolved;
    return true;
}

export function currentDir() {
    return CURRENT_DIR;
}

/**
 * Native folder picker. One dialog per platform, no dependency. Returns null
 * when the user cancels, which is not an error.
 */
export async function pickDirectory() {
    const { spawn } = await import('child_process');
    const os = await import('os');

    let cmd, args;
    if (os.platform() === 'win32') {
        cmd = 'powershell';
        args = ['-NoProfile', '-STA', '-Command', `
            Add-Type -AssemblyName System.Windows.Forms
            $d = New-Object System.Windows.Forms.FolderBrowserDialog
            $d.Description = "Pick a Syncthing folder"
            $d.ShowNewFolderButton = $false
            if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }
        `];
    } else if (os.platform() === 'darwin') {
        cmd = 'osascript';
        args = ['-e', 'POSIX path of (choose folder)'];
    } else {
        cmd = 'zenity';
        args = ['--file-selection', '--directory'];
    }

    return new Promise((resolve) => {
        let out = '';
        try {
            const child = spawn(cmd, args);
            child.stdout.on('data', (d) => (out += d.toString()));
            child.on('error', () => resolve(null));
            child.on('close', () => resolve(out.trim() || null));
        } catch {
            resolve(null);
        }
    });
}
