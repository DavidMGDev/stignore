import fs from 'fs/promises';
import path from 'path';

// ADD THIS:
import { logDebug } from '$lib/server/logger.js';

export interface TreeNode {
    name: string;
    path: string; // Relative path from root
    type: 'file' | 'folder';
    children?: TreeNode[];
    isIgnored: boolean; // True if matched by .gitignore or system hidden
    isMedia: boolean;
    // ADD THIS:
    isMassive: boolean;
    depth: number;
}

const SYSTEM_HIDDEN = [
    '.git',
    '.DS_Store',
    'Thumbs.db',
    'node_modules',
    '.godot', // <--- ADDED
    '.svelte-kit',
    '.txt-forge-vault',
    'TXT-Forge',
    'package-lock.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    'bun.lockb'
];

// ADD THIS LIST:

const MEDIA_EXTENSIONS = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svg', '.bmp', '.tiff',
    '.dds', '.tga', '.hdr', '.exr',
    '.mp3', '.wav', '.ogg', '.mp4', '.webm', '.mov', '.avi',
    // Godot Binary Formats
    '.res', '.scn',
    // Issue #3 Fix: Add 3D formats here
    '.fbx', '.obj', '.blend', '.glb', '.gltf', '.3ds',
    '.pdf', '.zip', '.tar', '.gz', '.7z', '.rar',
    '.exe', '.dll', '.so', '.dylib', '.bin',
    '.ttf', '.otf', '.woff', '.woff2', '.eot'
]);

const MASSIVE_FOLDERS = new Set([
    'node_modules', 'bower_components', 'vendor',
    '.git', '.svn', '.hg',
    '.godot', // <--- ADDED
    '.svelte-kit', '.next', '.nuxt', '.output',
    'dist', 'build', 'out', 'target',
    'CMakeFiles', '.gradle', '.idea', '.vscode'
]);

const MAX_FOLDER_ITEMS = 150;
const MAX_FILE_SIZE_MB = 1 * 1024 * 1024; // 1MB

/**
 * specific ignore logic for the tree view (lighter than the full processor)
 */
function isSystemIgnored(name: string): boolean {
    // UPDATED: Added check for Godot .import and .uid files
    return SYSTEM_HIDDEN.includes(name) || name.startsWith('.') || name.endsWith('.import') || name.endsWith('.uid');
}

export async function scanDirectory(
    rootDir: string,
    currentDir: string,
    depth: number = 0,
    additionalIgnores: string[] = [],
    isLazyLoadRoot: boolean = false // <--- NEW PARAMETER
): Promise<TreeNode[]> {
    logDebug(`Scanning directory: ${currentDir} (Depth: ${depth})`);

    const nodes: TreeNode[] = [];
    let entries: import('fs').Dirent[] = [];
    try {
        entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch (e) {
        return [];
    }

    // --- MASSIVE FOLDER CHECK (Optimized) ---

    // If this folder has too many items, we mark it massive and STOP here.

    // EXCEPTION: If this is the specific folder the user requested to expand (isLazyLoadRoot),

    // we MUST process its immediate children, otherwise the UI shows nothing.

    const isTooManyItems = entries.length > MAX_FOLDER_ITEMS;

    const dirName = path.basename(currentDir);

    const isKnownMassive = MASSIVE_FOLDERS.has(dirName);

    // If we are deep in recursion OR (it is massive AND NOT the root of this specific scan request)

    if (depth > 0 && (isKnownMassive || isTooManyItems) && !isLazyLoadRoot) {

        return []; // Returning empty triggers the "Massive" state in the parent node logic

    }

    // -------------------------------------------

    // Merge passed ignores with local .gitignore...
    const activeIgnores = [...additionalIgnores];
    const gitIgnorePath = path.join(currentDir, '.gitignore');
    try {
        const gitIgnoreContent = await fs.readFile(gitIgnorePath, 'utf-8');
        gitIgnoreContent.split('\n').forEach(line => {
            const l = line.trim();
            if (l && !l.startsWith('#')) activeIgnores.push(l);
        });
    } catch (e) { }

    // Sort: Folders first, then files
    entries.sort((a, b) => {
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
    });

    for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        const relPath = path.relative(rootDir, fullPath);
        const normalizedRelPath = relPath.split(path.sep).join('/');
        const isDirectory = entry.isDirectory();

        // Check simple ignore logic (System files)...
        let isIgnored = isSystemIgnored(entry.name);
        if (!isIgnored) {
            isIgnored = activeIgnores.some(pattern => {
                // ... existing regex logic ...
                let p = pattern.trim();
                if (!p || p.startsWith('#')) return false;
                if (p.startsWith('!')) return false;
                p = p.replace(/\\/g, '/');
                const isDirPattern = p.endsWith('/');
                if (isDirPattern) {
                    p = p.slice(0, -1);
                    if (!isDirectory) return false;
                }
                if (p.startsWith('*')) return entry.name.endsWith(p.slice(1));
                if (p.startsWith('/')) {
                    const clean = p.slice(1);
                    return normalizedRelPath === clean || normalizedRelPath.startsWith(clean + '/');
                }
                if (!p.includes('/')) return entry.name === p;
                return normalizedRelPath === p || normalizedRelPath.startsWith(p + '/');
            });
        }

        // --- MASSIVE & MEDIA CHECKS ---

        const ext = path.extname(entry.name).toLowerCase();
        const isMedia = !isDirectory && MEDIA_EXTENSIONS.has(ext);

        let isMassive = false;
        let children: TreeNode[] | undefined = undefined;
        if (isDirectory) {
            // Check if THIS specific child folder is known massive (e.g. node_modules)
            // If so, we mark it massive and DO NOT recurse.
            if (MASSIVE_FOLDERS.has(entry.name)) {
                isMassive = true;
                children = []; // Empty children = Massive/Lazy Load
            } else {
                // Recurse normally
                // Pass false for isLazyLoadRoot because children of the lazy load root are not exempt
                children = await scanDirectory(rootDir, fullPath, depth + 1, activeIgnores, false);
            }
        } else {
            // Check File Size
            try {
                const stats = await fs.stat(fullPath);
                if (stats.size > MAX_FILE_SIZE_MB) isMassive = true;
            } catch (e) { }
        }

        // ------------------------------

        // --- CHANGE START ---
        // Ensure the ID/Path sent to frontend is always forward-slash normalized
        // This prevents "src\lib" vs "src/lib" mismatches in selection rules
        const normalizedPath = relPath.replace(/\\/g, '/');

        const node: TreeNode = {
            name: entry.name,
            path: normalizedPath, // <--- CHANGED from 'relPath' to 'normalizedPath'
            type: isDirectory ? 'folder' : 'file',
            isIgnored: isIgnored,
            isMedia: isMedia,
            isMassive: isMassive, // <--- NEW
            children: children,
            depth: depth
        };
        // --- CHANGE END ---

        nodes.push(node);
    }

    return nodes;
}

/**
 * Generates a visual tree string for the Source-Tree.txt file
 */
export function generateTreeString(
    nodes: TreeNode[],
    // selectedPaths determines VISIBILITY in the tree (structure)
    selectedPaths: Set<string>,
    // includedContentPaths determines the STATUS MARKER (✓/✕)
    includedContentPaths: Set<string>,
    prefix = ''
): string {
    let output = '';

    // Filter nodes that are effectively visible in the tree map
    const validNodes = nodes.filter(n => selectedPaths.has(n.path));

    for (let i = 0; i < validNodes.length; i++) {
        const node = validNodes[i];
        const isLast = i === validNodes.length - 1;
        const connector = isLast ? '└── ' : '├── ';
        const childPrefix = isLast ? '    ' : '│   ';

        // Determine suffix
        let suffix = '';
        if (node.type === 'file') {
            // Check if this specific file ended up in the processed list
            if (includedContentPaths.has(node.path)) {
                suffix = '  [✓]'; // Included in merged text
            } else {
                suffix = '  [-]'; // Excluded (Binary, huge, or rule excluded)
            }
        }

        output += prefix + connector + node.name + (node.type === 'folder' ? '/' : '') + suffix + '\n';

        if (node.children && node.children.length > 0) {
            output += generateTreeString(node.children, selectedPaths, includedContentPaths, prefix + childPrefix);
        }
    }
    return output;
}
