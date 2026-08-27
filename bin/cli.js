#!/usr/bin/env node

import { spawn, exec } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import open from 'open';
import { randomUUID } from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(__dirname, '../build/index.js');

const USER_CWD = process.cwd();
const PORT = 4568;
const SESSION_ID = randomUUID();

const args = process.argv.slice(2);
const isDebug = args.includes('--debug') || args.includes('-d');

if (args.includes('--help') || args.includes('-h')) {
    console.log(`
  stignore - manage a Syncthing .stignore file from your browser

  Usage:
    stignore [options]

  Runs against the current directory. Opens a local UI on port ${PORT}
  and stays up until you press Exit in the UI or Ctrl+C here.

  Options:
    -d, --debug    Print server logs to this terminal
    -h, --help     Show this
`);
    process.exit(0);
}

console.log('\x1b[36m%s\x1b[0m', '› Starting stignore...');
console.log('\x1b[90m%s\x1b[0m', `  Folder: ${USER_CWD}`);
if (isDebug) console.log('\x1b[33m%s\x1b[0m', '› Debug mode enabled');

/** Clear a stale server left behind by a previous run. */
async function killPort(port) {
    return new Promise((resolve) => {
        const isWin = process.platform === 'win32';
        // On Windows, filter to LISTENING so we never kill an ESTABLISHED browser connection.
        const command = isWin
            ? `netstat -ano | findstr :${port} | findstr LISTENING`
            : `lsof -i :${port} -t`;

        exec(command, (err, stdout) => {
            if (!stdout) return resolve();
            console.log('\x1b[90m%s\x1b[0m', '› Clearing previous session...');

            const pid = isWin
                ? stdout.trim().split('\n')[0].trim().split(/\s+/).pop()
                : stdout.trim().split('\n')[0].trim();

            if (pid && pid !== '0') {
                exec(isWin ? `taskkill /PID ${pid} /F` : `kill -9 ${pid}`, () =>
                    setTimeout(resolve, 500)
                );
            } else {
                resolve();
            }
        });
    });
}

async function start() {
    await killPort(PORT);

    const server = spawn('node', [serverPath], {
        env: {
            ...process.env,
            PORT: PORT.toString(),
            STIGNORE_CWD: USER_CWD,
            ORIGIN: `http://localhost:${PORT}`,
            STIGNORE_SESSION_ID: SESSION_ID,
            NODE_ENV: 'production',
            STIGNORE_DEBUG: isDebug ? 'true' : 'false'
        },
        stdio: 'inherit'
    });

    let serverExited = false;
    server.on('exit', (code) => {
        serverExited = true;
        if (code !== 0 && code !== null) {
            console.error(
                '\x1b[31m%s\x1b[0m',
                `✕ Server failed to start (exit ${code}). Port ${PORT} may be locked.`
            );
            process.exit(code);
        }
        process.exit(0);
    });

    setTimeout(async () => {
        if (serverExited) return;
        console.log('\x1b[32m%s\x1b[0m', `✓ Ready at http://localhost:${PORT}`);
        console.log('\x1b[90m%s\x1b[0m', '  Press Exit in the UI, or Ctrl+C here, to stop.');
        await open(`http://localhost:${PORT}`);
    }, 1500);

    process.on('SIGINT', () => {
        server.kill();
        process.exit(0);
    });
}

start();
