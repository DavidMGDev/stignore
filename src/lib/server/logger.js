export function logDebug(message, data = null) {
    if (process.env.STIGNORE_DEBUG !== 'true') return;
    const stamp = new Date().toISOString().slice(11, 23);
    console.log(`\x1b[35m[debug ${stamp}]\x1b[0m ${message}`);
    if (data) console.dir(data, { depth: 3, colors: true });
}
