import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { templates, type CodebaseTemplate } from '$lib/templates';

// ADD THIS:
import { logDebug } from '$lib/server/logger.js';

// --- ADD THIS CONSTANT ---

const BINARY_EXTENSIONS = new Set([
    // Images & Textures (Game Dev)
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svg', '.bmp', '.tiff', '.heic',
    '.dds', '.tga', '.hdr', '.exr',
    // Fonts
    '.ttf', '.otf', '.woff', '.woff2', '.eot',
    // Audio/Video
    '.mp3', '.wav', '.ogg', '.mp4', '.webm', '.mov', '.avi', '.mkv',
    // 3D Models
    '.fbx', '.obj', '.blend', '.glb', '.gltf', '.3ds',
    // Archives/Binaries
    '.pdf', '.zip', '.tar', '.gz', '.7z', '.rar', '.exe', '.dll', '.so', '.dylib', '.bin', '.apk', '.aab',
    // Godot Binary Formats
    '.res', '.scn',
    // Android Specific
    '.keystore', '.jks'
]);

export type SaveMode = 'root' | 'global' | 'custom' | 'clipboard';

// --- HELPER FUNCTIONS ---

async function analyzeMaven(dir: string, ids: Set<string>, reasons: Record<string, string[]>) {
    try {
        const content = await fs.readFile(path.join(dir, 'pom.xml'), 'utf-8');

        // Check Spring Boot
        if (content.includes('spring-boot-starter')) {
            ids.add('spring-boot');
            reasons['spring-boot'] = ['Found spring-boot-starter in pom.xml'];
            ids.add('java');
        }

        // Check Kotlin
        if (content.includes('kotlin-stdlib')) {
            ids.add('kotlin');
            reasons['kotlin'] = ['Found kotlin-stdlib in pom.xml'];
        } else {
            ids.add('java'); // Default to Java if no Kotlin explicitly defined
        }
    } catch (e) { }
}

async function analyzeGradle(dir: string, ids: Set<string>, reasons: Record<string, string[]>) {
    try {
        const filename = (await fs.readdir(dir)).find(f => f.startsWith('build.gradle'));
        if (!filename) return;
        const content = await fs.readFile(path.join(dir, filename), 'utf-8');

        // Check Android
        if (content.includes('com.android.application') || content.includes('com.android.library')) {
            ids.add('android');
            reasons['android'] = ['Found Android plugin in gradle'];
        }

        // Check Spring
        if (content.includes('org.springframework.boot')) {
            ids.add('spring-boot');
            reasons['spring-boot'] = ['Found Spring Boot plugin'];
        }

        // Check Kotlin
        if (content.includes('kotlin("jvm")') || content.includes('kotlin-stdlib')) {
            ids.add('kotlin');
            reasons['kotlin'] = ['Found Kotlin plugin'];
        } else {
            // If strictly Android, it might be Java or Kotlin.
            // We let extension scanner confirm Java if Kotlin isn't explicit here.
        }
    } catch (e) { }
}

async function analyzeNode(dir: string, ids: Set<string>, reasons: Record<string, string[]>) {
    try {
        const content = await fs.readFile(path.join(dir, 'package.json'), 'utf-8');
        const pkg = JSON.parse(content);
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };

        for (const [key, _] of Object.entries(deps)) {
            const tmpl = templates.find(t => t.id === key); // e.g. 'react', 'vue', 'express'
            if (tmpl) {
                ids.add(tmpl.id);
                reasons[tmpl.id] = [`Dependency: ${key}`];
            }

            // Manual mappings
            if (key.includes('react-scripts')) ids.add('react');
            if (key.includes('next')) ids.add('nextjs');
        }
    } catch (e) { }
}

export interface ProcessConfig {
    sourceDir: string;
    saveMode: SaveMode;
    customPath?: string;
    templateIds: string[];
    maxChars: number;
    // selectedFiles?: string[]; // <-- REMOVED (Legacy)
    selectionRules?: Record<string, 'include' | 'exclude'>; // <-- ADDED
    hideIgnoredInTree?: boolean;
    disableSplitting?: boolean;
}

interface ProcessResult {
    success: boolean;
    message: string;
    outputPath: string;
    files: string[];
    gitIgnoreModified?: boolean; // <--- NEW FIELD
    clipboardText?: string; // <--- ADDED
}

export interface DetectionResult {
    ids: string[];
    reasons: Record<string, string[]>; // templateId -> list of filenames that triggered it
    gitStatus: 'none' | 'clean' | 'ignored'; // 'none' = no .git, 'clean' = has .git but no ignore entry, 'ignored' = already configured
}

// Helper to determine if a file is included based on whitelist/blacklist rules
// Helper to determine if a file is included based on whitelist/blacklist rules
function isFileIncluded(
    relPath: string,
    rules: Record<string, 'include' | 'exclude'>,
    isIgnoredByDefault: boolean,
    isMedia: boolean
): boolean {
    if (isMedia) return false; // Never include media content text

    // 1. Normalize path to ensure it matches UI keys (always forward slashes)
    let current = relPath.replace(/\\/g, '/');

    // 2. Traverse up the folder tree checking for rules at every level
    while (true) {
        // Check for explicit rule on this specific path (file or folder)
        if (rules[current] === 'include') return true;
        if (rules[current] === 'exclude') return false;

        // If we just checked the root ('.'), we are done searching.
        if (current === '.' || current === '') break;

        // Move to parent directory using string manipulation
        // We avoid path.dirname() to prevent OS-specific separator mismatches
        const lastSlash = current.lastIndexOf('/');
        if (lastSlash === -1) {
            // We are at a top-level file (e.g. "README.md"), so parent is root
            current = '.';
        } else {
            current = current.substring(0, lastSlash);
        }
    }

    // 3. Fallback to default state (Templates + GitIgnore)
    return !isIgnoredByDefault;
}

// Regex to find safe places to split code
const SAFE_SPLIT_REGEX = /\n(?=(function|class|export|interface|type|def|func|const|let|var|public|private|protected|struct|impl|package|import)\s)/g;

// --- CONSTANTS FOR STRICT DETECTION ---

// Extensions that are too common to act as proof of a specific framework
// UPDATED: Added .py, .php, .java, .rb, .go, .rs to prevent frameworks from stealing generic language attribution
const GENERIC_EXTENSIONS = new Set([
    '.js', '.jsx', '.ts', '.tsx', '.css', '.scss', '.html', '.json', '.md', '.yaml', '.yml',
    '.py', '.php', '.java', '.rb', '.go', '.rs', '.c', '.cpp', '.h'
]);

// Triggers that are too common to prove a specific framework
const GENERIC_TRIGGERS = new Set([
    'package.json', 'README.md', '.gitignore', '.env', '.editorconfig', 'LICENSE', 'tsconfig.json',
    'vite.config.ts', 'vite.config.js', 'vite.config.mts', 'vite.config.mjs'
]);

const FRAMEWORK_DEPENDENCIES: Record<string, string[]> = {
    'react': ['javascript', 'typescript', 'html-css'],
    'nextjs': ['react', 'javascript', 'typescript', 'html-css'],
    'vuejs': ['javascript', 'typescript', 'html-css'],
    'nuxtjs': ['vuejs', 'javascript', 'typescript', 'html-css'],
    'sveltekit': ['javascript', 'typescript', 'html-css'],
    'angular': ['typescript', 'html-css'],
    'astro': ['javascript', 'typescript', 'html-css'],
    'remix': ['react', 'javascript', 'typescript', 'html-css'],
    'solidjs': ['javascript', 'typescript', 'html-css'],
    'qwik': ['javascript', 'typescript', 'html-css'],
    'laravel': ['php', 'html-css'],
    'django': ['python', 'html-css'],
    'flask': ['python', 'html-css'],
    'spring-boot': ['java'],
    'flutter': ['dart'],
    'rails': ['ruby', 'html-css']
};

// --- PUBLIC API ---

/**
 * 1. Detect Codebase
 * Returns detected IDs, the files that triggered them, and git status.
 */
/**

 * 1. Detect Codebase (Content-Aware Mode)

 */

export async function detectCodebase(sourceDir: string): Promise<DetectionResult> {

    logDebug(`Starting detection in: ${sourceDir}`);



    try {

        const detectedIds = new Set<string>();

        const reasons: Record<string, string[]> = {};

        let gitStatus: 'none' | 'clean' | 'ignored' = 'none';



        // 1. Scan root files

        const rootFiles = await fs.readdir(sourceDir);



        // Check .gitignore status

        if (rootFiles.includes('.git')) {

            gitStatus = 'clean';

            if (rootFiles.includes('.gitignore')) {

                try {

                    const content = await fs.readFile(path.join(sourceDir, '.gitignore'), 'utf-8');

                    if (content.includes('TXT-Forge')) gitStatus = 'ignored';

                } catch (e) { }

            }

        }



        // 2. PRE-ANALYSIS: Check Package Managers (The Source of Truth)

        let isManagedProject = false;



        // --- A. Maven (Java/Spring/Kotlin) ---

        if (rootFiles.includes('pom.xml')) {

            isManagedProject = true;

            try {

                const pomContent = await fs.readFile(path.join(sourceDir, 'pom.xml'), 'utf-8');



                // Check for Spring Boot

                if (pomContent.includes('spring-boot') || pomContent.includes('springframework')) {

                    detectedIds.add('spring-boot');

                    reasons['spring-boot'] = ['Found Spring dependencies in pom.xml'];

                    detectedIds.add('java'); // Spring implies Java usually

                }



                // Check for Kotlin

                if (pomContent.includes('kotlin-stdlib') || pomContent.includes('kotlin-maven-plugin')) {

                    detectedIds.add('kotlin');

                    reasons['kotlin'] = ['Found Kotlin dependencies in pom.xml'];

                } else {

                    detectedIds.add('java');

                    reasons['java'] = ['Found pom.xml (Java Project)'];

                }

            } catch (e) { console.error("Error reading pom.xml", e); }

        }



        // --- B. Gradle (Android/Java/Spring) ---

        const gradleFile = rootFiles.find(f => f === 'build.gradle' || f === 'build.gradle.kts');

        if (gradleFile) {

            isManagedProject = true;

            try {

                const gradleContent = await fs.readFile(path.join(sourceDir, gradleFile), 'utf-8');



                if (gradleContent.includes('com.android.application') || gradleContent.includes('com.android.library')) {

                    detectedIds.add('android');

                    reasons['android'] = ['Found Android plugin in gradle'];

                }



                if (gradleContent.includes('org.springframework.boot')) {

                    detectedIds.add('spring-boot');

                    reasons['spring-boot'] = ['Found Spring Boot plugin'];

                }



                if (gradleContent.includes('kotlin')) {

                    detectedIds.add('kotlin');

                    reasons['kotlin'] = ['Found Kotlin plugin'];

                }

            } catch (e) { }

        }



        // --- C. Node (JS/TS Frameworks) ---

        if (rootFiles.includes('package.json')) {

            isManagedProject = true;

            try {

                const pkgContent = await fs.readFile(path.join(sourceDir, 'package.json'), 'utf-8');

                const pkg = JSON.parse(pkgContent);

                const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };



                // STRICT: Use the new 'packageMatch' property from templates

                for (const t of templates) {

                    if (t.packageMatch && t.packageMatch.length > 0) {

                        const match = t.packageMatch.find(p => allDeps[p]);

                        if (match) {

                            detectedIds.add(t.id);

                            reasons[t.id] = [`Dependency: ${match}`];

                        }

                    }

                }



                // Explicitly detect JS/TS based on deps/files if not already added

                if (allDeps['typescript']) {

                    detectedIds.add('typescript');

                    reasons['typescript'] = ['Found typescript dependency'];

                } else {

                    // If package.json exists but no typescript, likely JS

                    if (!detectedIds.has('typescript')) {

                        detectedIds.add('javascript');

                        reasons['javascript'] = ['Found package.json (Node Project)'];

                    }

                }

            } catch (e) {

                console.error("Error parsing package.json", e);

            }

        }



        // --- D. PHP Composer (Laravel/Symfony/etc) ---

        if (rootFiles.includes('composer.json')) {

            isManagedProject = true;

            try {

                const composerContent = await fs.readFile(path.join(sourceDir, 'composer.json'), 'utf-8');

                const composer = JSON.parse(composerContent);

                const allDeps = { ...composer.require, ...composer['require-dev'] };



                // STRICT: Check packageMatch against composer dependencies

                for (const t of templates) {

                    if (t.packageMatch && t.packageMatch.length > 0) {

                        const match = t.packageMatch.find(p => allDeps[p]);

                        if (match) {

                            detectedIds.add(t.id);

                            reasons[t.id] = [`Composer Dependency: ${match}`];

                        }

                    }

                }



                // Detect PHP Language explicitly if composer exists

                if (!detectedIds.has('php')) {

                    detectedIds.add('php');

                    reasons['php'] = ['Found composer.json'];

                }



            } catch (e) {

                console.error("Error parsing composer.json", e);

            }

        }



        // 3. Deep Scan for Utilities and Base Languages (Always run this)

        // Even if it is a Node project, we want to know if HTML/CSS/SQL/Shell exists.

        const foundExtensions = await deepScanExtensions(sourceDir, 3);



        if (rootFiles.includes('Dockerfile') || rootFiles.includes('docker-compose.yml')) {

            detectedIds.add('docker');

            reasons['docker'] = ['Docker config found'];

        }



        if (foundExtensions.has('.sql')) {

            detectedIds.add('sql');

            reasons['sql'] = ['SQL files found'];

        }



        if (foundExtensions.has('.sh')) {

            detectedIds.add('bash-shell');

            reasons['bash-shell'] = ['Shell scripts found'];

        }



        // Always check for HTML/CSS unless strict backend? 

        // It's safer to just detect them if files exist.

        if (foundExtensions.has('.html') || foundExtensions.has('.css')) {

            detectedIds.add('html-css');

            reasons['html-css'] = ['HTML/CSS files found'];

        }



        // 4. Fallback: File Trigger Detection

        // This catches frameworks that DON'T rely on package managers (e.g. pure Python/Go/Rust)

        // OR if we failed to identify a managed project context.



        for (const t of templates) {

            if (detectedIds.has(t.id)) continue; // Already found



            // Skip generic languages if we already identified the major platform

            if (isManagedProject) {

                // If we found package.json, don't guess generic JS/TS/Java again based on loose files

                if (['java', 'kotlin', 'android', 'javascript', 'typescript', 'react', 'vuejs', 'angular'].includes(t.id)) continue;

            }



            // Check Triggers

            const triggerMatch = t.triggers.some(trig => {

                if (trig.startsWith('*')) {

                    // Suffix check (e.g. *.go) - verify against root files

                    return rootFiles.some(f => f.endsWith(trig.slice(1)));

                }

                return rootFiles.includes(trig);

            });



            if (triggerMatch) {

                detectedIds.add(t.id);

                reasons[t.id] = ['File trigger detected'];

            }

        }



        return {

            ids: Array.from(detectedIds),

            reasons,

            gitStatus

        };

    } catch (e) {

        console.error("Detection failed", e);

        return { ids: [], reasons: {}, gitStatus: 'none' };

    }

}

// Import the tree helper
import { generateTreeString, type TreeNode, scanDirectory } from '$lib/tree';

/**
 * 2. Process Files
 */
export async function processFiles(config: ProcessConfig): Promise<ProcessResult> {
    try {
        const sourceRoot = path.resolve(config.sourceDir);
        const projectName = path.basename(sourceRoot);

        // --- DETERMINE FILES TO PROCESS (OFFLOADED LOGIC) ---

        let filesToProcess: string[] = [];

        // 1. Setup Ignores

        // UPDATED: Added '*.uid' to exclude Godot uid files
        const ignorePatterns = new Set<string>(['.git', 'node_modules', '.godot', 'TXT-Forge', '.txt-forge-vault', '*.import', '*.uid']);

        // ADDED: '.godot' to massive folders list
        const massiveFolders = new Set<string>(['node_modules', '.git', '.godot', '.svelte-kit', '.next', 'dist', 'build', 'vendor']); // Explicit massive folders

        // Fix: Ensure templateIds is an array before filtering
        const safeTemplateIds = Array.isArray(config.templateIds) ? config.templateIds : [];
        const activeTemplates = templates.filter(t => safeTemplateIds.includes(t.id));

        activeTemplates.forEach(t => t.ignores.forEach(ign => ignorePatterns.add(ign.replace(/\/$/, ''))));

        // 2. Determine Content Files based on Whitelist/Blacklist Rules

        // Step A: Perform a broad scan of candidates. 
        // We include everything initially, then filter using the rules engine.
        // We pass the ignorePatterns to scanFiles, BUT strictly speaking, a Whitelist rule should override a gitignore.
        // However, scanFiles is optimized to skip massive folders like node_modules. 
        // Use standard ignore patterns for the scan, assuming user won't whitelist deep inside node_modules usually.
        // If they do, scanFiles needs to know, but for stability, we stick to standard scan + filter.

        const validExtensions = new Set<string>();
        // If specific templates selected, collect extensions.
        activeTemplates.forEach(t => t.extensions.forEach(ext => validExtensions.add(ext)));

        // Scan everything (recursively), filtering binaries by default
        // CHANGE: We pass [] as extensions to scanFiles so it returns ALL files.
        // This ensures files NOT in the template extension list are still found, so the Rules Engine can decide their fate.
        const allCandidates = await scanFiles(sourceRoot, sourceRoot, [], Array.from(ignorePatterns), false);

        // --- CHANGE START: Normalize Rules Keys ---
        // Ensure all rule keys use forward slashes to match the file scanner's paths
        const rawRules = config.selectionRules || {};
        const rules: Record<string, 'include' | 'exclude'> = {};
        for (const [key, val] of Object.entries(rawRules)) {
            rules[key.replace(/\\/g, '/')] = val;
        }
        // --- CHANGE END ---
        const explicitFiles = new Set<string>();

        // We also need a set of relative paths that are included, to pass to the Tree Generator for the [✓] indicators
        const includedRelativePaths = new Set<string>();

        for (const fullPath of allCandidates) {
            // FIX: Robust normalization. Replace ALL backslashes with forward slashes explicitly.
            // .split(path.sep) relies on the string containing the OS separator, which might not be true if path methods mix them.
            const relPath = path.relative(sourceRoot, fullPath).replace(/\\/g, '/');

            // Determine "Default State" for this file
            // If templates are active, default state depends on extension match.
            // If the file extension is NOT in the template, it is Ignored By Default.
            // BUT, if the user has a Rule saying "Include", isFileIncluded will return true.
            let isIgnoredByDefault = false;
            if (activeTemplates.length > 0) {
                const ext = path.extname(fullPath).toLowerCase();
                if (!validExtensions.has(ext)) isIgnoredByDefault = true;
            }

            // Check Whitelist/Blacklist Logic
            const shouldInclude = isFileIncluded(relPath, rules, isIgnoredByDefault, false); // isMedia handled by scanFiles

            if (shouldInclude) {
                explicitFiles.add(fullPath);
                includedRelativePaths.add(relPath);
            }
        }

        filesToProcess = Array.from(explicitFiles);

        // 3. Determine Tree Files (The Visual Map)
        // We need to build the Tree Nodes data structure to pass to generateTreeString
        // We use the same 'scanDirectory' logic from tree.ts but we do it manually via a simpler scan here or reuse scanFiles
        // actually, we need the TreeNode structure.

        // To generate the pretty tree with [✓], we need the full file list available to the tree generator.
        let treeScanFiles: string[] = [];

        if (!config.hideIgnoredInTree) {
            // If "Hide" is FALSE (Default): We want the broad scan (show context).
            const massiveIgnores = Array.from(massiveFolders);
            massiveIgnores.push('*.import');
            massiveIgnores.push('*.uid');
            // Scan for ALL files for the tree map
            treeScanFiles = await scanFiles(sourceRoot, sourceRoot, [], massiveIgnores, true);
        } else {
            // If "Hide" is TRUE: Tree matches content exactly.
            treeScanFiles = [...filesToProcess];
        }

        // Sort tree alphabetically
        treeScanFiles.sort();

        // CONVERT FLAT FILES TO TREE NODES
        // We need to reconstruct a simple TreeNode structure from the flat file list to use generateTreeString
        // This is a lightweight reconstruction
        const rootNodes: TreeNode[] = [];
        const pathMap = new Map<string, TreeNode>();

        // NEW: Track all paths (files AND folders) that should appear in the tree.
        // scanFiles only gives us files, so we must manually add the folder paths as we traverse.
        const visibleTreePaths = new Set<string>();

        for (const file of treeScanFiles) {
            // FIX: Robust normalization for tree generation as well
            const relPath = path.relative(sourceRoot, file).replace(/\\/g, '/');
            const parts = relPath.split('/');

            let currentPath = '';
            let currentChildren = rootNodes;

            for (let i = 0; i < parts.length; i++) {
                const part = parts[i];
                const isFile = i === parts.length - 1;
                currentPath = currentPath ? `${currentPath}/${part}` : part;

                // CRITICAL FIX: Add this path (folder or file) to the visible set
                visibleTreePaths.add(currentPath);

                let node = pathMap.get(currentPath);
                if (!node) {
                    node = {
                        name: part,
                        path: currentPath,
                        type: isFile ? 'file' : 'folder',
                        children: isFile ? undefined : [],
                        isIgnored: false,
                        isMedia: false,
                        isMassive: false,
                        depth: i
                    };
                    pathMap.set(currentPath, node);
                    currentChildren.push(node);
                }

                if (!isFile && node.children) {
                    currentChildren = node.children;
                }
            }
        }

        // Helper to sort nodes
        const sortNodes = (nodes: TreeNode[]) => {
            nodes.sort((a, b) => {
                if (a.type === b.type) return a.name.localeCompare(b.name);
                return a.type === 'folder' ? -1 : 1;
            });
            nodes.forEach(n => {
                if (n.children) sortNodes(n.children);
            });
        };
        sortNodes(rootNodes);

        // Generate Tree String with Indicators
        // We pass visibleTreePaths (which now includes folders) so the recursive generator doesn't stop at the root
        const sourceTreeContent = generateTreeString(rootNodes, visibleTreePaths, includedRelativePaths);

        if (filesToProcess.length === 0) return { success: false, message: "No matching files found.", outputPath: '', files: [] };

        // --- PREPARE OUTPUT (Keep existing logic) ---

        let outputBaseDir = '';
        if (config.saveMode === 'root') outputBaseDir = path.join(sourceRoot, 'TXT-Forge');
        else if (config.saveMode === 'global') outputBaseDir = path.join(os.homedir(), '.txt-forge-vault', projectName);
        else if (config.saveMode === 'custom' && config.customPath) outputBaseDir = path.resolve(config.customPath);
        else if (config.saveMode === 'clipboard') outputBaseDir = '';
        else throw new Error("Invalid save path configuration.");

        let gitIgnoreModified = false;

        if (config.saveMode === 'root') {

            gitIgnoreModified = await ensureGitIgnore(sourceRoot);

        }

        let mergedDir = '';
        if (config.saveMode !== 'clipboard') {
            mergedDir = path.join(outputBaseDir, 'Merged');
            await cleanDirectory(mergedDir);
        }

        // --- READ & MERGE (Keep existing logic) ---

        const fileMap: { original: string, relPath: string, content: string }[] = [];

        for (const filePath of filesToProcess) {
            try {
                // Size check for massive files check inside export
                const stats = await fs.stat(filePath);
                if (stats.size > 1024 * 1024 * 5) { // Skip > 5MB in content processing
                    console.warn(`Skipping huge file > 5MB: ${filePath}`);
                    continue;
                }

                // BINARY CONTENT CHECK (New)
                // Even if extension is safe, check if content is binary to prevent
                // encoding garbage or breaking the splitter.
                const isBinary = await isBinaryFile(filePath);
                if (isBinary) {
                    console.warn(`Skipping binary content file: ${filePath}`);
                    continue;
                }

                const content = await fs.readFile(filePath, 'utf-8');
                const relPath = path.relative(sourceRoot, filePath);
                fileMap.push({ original: filePath, relPath, content });
            } catch (e) {
                console.warn(`Failed to read file: ${filePath}`, e);
            }
        }

        // --- GENERATE FILES (Keep existing) ---

        const treeBody = sourceTreeContent.trim();
        const indentedBody = treeBody.split('\n').map(line => '│   ' + line).join('\n');
        // CONSTRUCT STANDARDIZED HEADER & LEGEND
        const header = "--- PROJECT STRUCTURE ---\n";
        const legend = "Legend: [✓] Included in merged content, [-] Excluded from merged content\n";
        const finalTreeContent = `${header}${legend}repository/\n${indentedBody}`;

        let generatedFiles: string[] = [];
        let clipboardText: string | undefined = undefined;
        
        if (config.saveMode === 'clipboard') {
            let fullContent = "";
            if (finalTreeContent) {
                fullContent += finalTreeContent + "\n" + "=".repeat(50) + "\n\n";
            }
            fileMap.sort((a, b) => a.relPath.localeCompare(b.relPath));
            for (const file of fileMap) {
                const fileHeader = `\n${'='.repeat(50)}\nFile: ${file.relPath}\n${'='.repeat(50)}\n\n`;
                fullContent += fileHeader + file.content + "\n\n";
            }
            clipboardText = fullContent;
        } else {
            if (config.disableSplitting) {
                // Single File Mode: Pass FULL tree content (Header+Legend+Tree)
                // Note: We updated mergeFiles to NOT prepend the header anymore.
                generatedFiles = await mergeFiles(fileMap, mergedDir, config.maxChars, true, finalTreeContent);
            } else {
                // Normal Mode: Write separate tree file
                await fs.writeFile(path.join(mergedDir, 'Source-Tree.txt'), finalTreeContent, 'utf-8');
                generatedFiles = await mergeFiles(fileMap, mergedDir, config.maxChars, false);
                generatedFiles.unshift('Source-Tree.txt');
            }
        }

        return {
            success: true,
            message: config.saveMode === 'clipboard' ? "Copied to clipboard" : "Processing Complete",
            outputPath: config.saveMode === 'clipboard' ? "Clipboard" : mergedDir,
            files: generatedFiles,
            gitIgnoreModified, // <--- Pass status
            clipboardText
        };
    } catch (error: any) {
        return { success: false, message: error.message || "Unknown Error", outputPath: '', files: [] };
    }
}

// --- INTERNAL HELPERS ---

async function ensureGitIgnore(rootDir: string): Promise<boolean> {
    try {
        const gitIgnorePath = path.join(rootDir, '.gitignore');
        let content = "";

        try {
            content = await fs.readFile(gitIgnorePath, 'utf-8');
        } catch (e) {
            // File doesn't exist, we will create it
            content = "";
        }

        if (!content.includes('TXT-Forge')) {
            const append = content.endsWith('\n') || content === "" ? "TXT-Forge/" : "\nTXT-Forge/";
            await fs.appendFile(gitIgnorePath, append, 'utf-8');
            return true; // <--- Modified
        }
    } catch (e) {
        console.warn("Could not update .gitignore", e);
    }

    return false; // <--- Not Modified
}

/**
 * Checks if a file contains binary data by reading the first 4KB
 * and looking for null bytes (0x00).
 */
async function isBinaryFile(filePath: string): Promise<boolean> {
    let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
    try {
        handle = await fs.open(filePath, 'r');
        const buffer = Buffer.alloc(4096);
        const { bytesRead } = await handle.read(buffer, 0, 4096, 0);

        // Check for null bytes in the read chunk
        for (let i = 0; i < bytesRead; i++) {
            if (buffer[i] === 0) return true;
        }
        return false;
    } catch (e) {
        return false; // Assume text if we can't read (error will be caught later)
    } finally {
        if (handle) await handle.close();
    }
}

async function cleanDirectory(dir: string) {
    try {
        await fs.rm(dir, { recursive: true, force: true });
        await fs.mkdir(dir, { recursive: true });
    } catch (e) { }
}

/**
 * Scans a few levels deep to find all active extensions in the project.
 * This allows us to detect "React" by finding .tsx files even if the config is weird.
 */
async function deepScanExtensions(dir: string, depth: number): Promise<Set<string>> {
    let extensions = new Set<string>();
    if (depth <= 0) return extensions;

    try {
        const list = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of list) {
            if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'build' || entry.name === 'vendor') continue;

            if (entry.isDirectory()) {
                const subExts = await deepScanExtensions(path.join(dir, entry.name), depth - 1);
                subExts.forEach(e => extensions.add(e));
            } else {
                const ext = path.extname(entry.name);
                if (ext) extensions.add(ext);
            }
        }
    } catch (e) {
        // ADD THIS:
        logDebug(`Error scanning dir ${dir}:`);
    }

    return extensions;
}

// UPDATED: Added includeBinaries parameter (default false)
async function scanFiles(rootDir: string, currentDir: string, extensions: string[], ignores: string[], includeBinaries: boolean = false): Promise<string[]> {
    let results: string[] = [];
    const list = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of list) {
        const fullPath = path.join(currentDir, entry.name);
        const relPath = path.relative(rootDir, fullPath);

        // ... (Keep existing ignore logic) ...
        const pathParts = relPath.split(path.sep);
        const isIgnored = pathParts.some(part =>
            ignores.some(ign => {
                if (ign.startsWith('*')) return part.endsWith(ign.slice(1));
                return part === ign || part.toLowerCase() === ign.toLowerCase();
            })
        );
        if (isIgnored) continue;

        if (entry.isDirectory()) {
            results = results.concat(await scanFiles(rootDir, fullPath, extensions, ignores));
        } else {
            const ext = path.extname(entry.name).toLowerCase();

            // UPDATED: Only skip binaries if the flag is explicitly FALSE
            if (!includeBinaries && BINARY_EXTENSIONS.has(ext)) {
                continue;
            }

            // UPDATED: If extensions list is empty, accept all
            if (extensions.length === 0 || extensions.includes(ext)) {
                results.push(fullPath);
            }
        }
    }
    return results;
}

/**
 * LINEAR MERGE (Next Fit)
 * Preserves file order from the source tree. Pushes multipart files to the end.
 */
async function mergeFiles(
    files: { relPath: string, content: string }[],
    outputDir: string,
    maxChars: number,
    disableSplitting: boolean = false,
    treeContent: string = ""
): Promise<string[]> {

    const createdFiles: string[] = [];
    let fileIndex = 1;

    // --- NO SPLIT MODE ---
    if (disableSplitting) {
        const filename = `Source-1 (Full Context).txt`;

        let fullContent = "";
        if (treeContent) {
            fullContent += treeContent;
            fullContent += "\n" + "=".repeat(50) + "\n\n";
        }

        files.sort((a, b) => a.relPath.localeCompare(b.relPath));

        for (const file of files) {
            const header = `\n${'='.repeat(50)}\nFile: ${file.relPath}\n${'='.repeat(50)}\n\n`;
            fullContent += header + file.content + "\n\n";
        }

        await fs.writeFile(path.join(outputDir, filename), fullContent, 'utf-8');
        return [filename];
    }

    // --- STANDARD SPLIT MODE ---
    const standardFiles: { relPath: string, fullText: string }[] = [];
    const multipartFiles: { relPath: string, content: string }[] = [];

    for (const file of files) {
        const header = `\n${'='.repeat(50)}\nFile: ${file.relPath}\n${'='.repeat(50)}\n\n`;
        const fullText = header + file.content + "\n\n";

        if (fullText.length > maxChars) {
            multipartFiles.push(file);
        } else {
            standardFiles.push({ relPath: file.relPath, fullText });
        }
    }

    // Process Standard Files
    let currentBuffer = "";
    let currentBufferIndex: string[] = [];

    const flushBuffer = async () => {
        if (currentBuffer.length === 0) return;
        const filename = `Source-${fileIndex} (${currentBufferIndex.length} Files).txt`;
        const indexHeader = "--- INDEX ---\n" + currentBufferIndex.join('\n') + "\n" + "-".repeat(30) + "\n\n";
        await fs.writeFile(path.join(outputDir, filename), indexHeader + currentBuffer, 'utf-8');
        createdFiles.push(filename);
        fileIndex++;
        currentBuffer = "";
        currentBufferIndex = [];
    };

    for (const item of standardFiles) {
        if (currentBuffer.length + item.fullText.length > maxChars) {
            await flushBuffer();
        }
        currentBuffer += item.fullText;
        currentBufferIndex.push(item.relPath);
    }
    await flushBuffer();

    // --- PROCESS MULTIPART FILES (FIXED) ---
    for (const file of multipartFiles) {
        let remaining = file.content;
        let part = 1;
        // Estimate parts (will be imprecise but useful for labeling)
        const estimatedParts = Math.ceil(remaining.length / (maxChars - 500));

        while (remaining.length > 0) {
            // 1. CRITICAL ERROR: LIMIT 999 PARTS
            if (part > 999) {
                throw new Error(`Critical Error: File ${file.relPath} exceeded 999 parts. Export cancelled to prevent infinite loop.`);
            }

            // Construct Headers to calculate TRUE available space
            const partStr = `${file.relPath} (Part ${part}/${estimatedParts})`;
            const indexHeader = "--- INDEX ---\n" + partStr + "\n" + "-".repeat(30) + "\n\n";
            const fileHeader = `\n${'='.repeat(50)}\nFile: ${partStr}\n${'='.repeat(50)}\n\n`;
            
            // Total overhead for this file
            const totalOverhead = indexHeader.length + fileHeader.length;
            const availableSpace = maxChars - totalOverhead;

            // Safety: If maxChars is too small for headers
            if (availableSpace < 100) {
                 throw new Error(`Configuration Error: maxChars (${maxChars}) is too small to fit file headers.`);
            }

            const filename = `Source-${fileIndex}.${part} (Multipart File).txt`;
            let splitIdx = -1;

            if (remaining.length <= availableSpace) {
                // Fits entirely
                splitIdx = remaining.length;
            } else {
                // Smart Split Logic
                const searchWindow = remaining.substring(0, availableSpace);
                let match;
                SAFE_SPLIT_REGEX.lastIndex = 0;
                
                // Find the LAST safe split point in the window
                while ((match = SAFE_SPLIT_REGEX.exec(searchWindow)) !== null) {
                    splitIdx = match.index;
                }

                // If no safe split found (or found at index 0), try newline
                if (splitIdx <= 0) splitIdx = searchWindow.lastIndexOf('\n');
                
                // 3. FORCE PROGRESS: If still invalid, force split at limit
                if (splitIdx <= 0) splitIdx = availableSpace;
            }

            // Extract content chunk
            const chunk = remaining.substring(0, splitIdx);

            // 2. ERROR HANDLING: EMPTY CHUNK
            if (!chunk && remaining.length > 0) {
                 throw new Error(`Critical Error: Generated empty multipart chunk for ${file.relPath}.`);
            }

            // Write File
            await fs.writeFile(path.join(outputDir, filename), indexHeader + fileHeader + chunk + "\n\n", 'utf-8');
            createdFiles.push(filename);

            // Advance
            remaining = remaining.substring(splitIdx);
            part++;
        }
        fileIndex++;
    }

    return createdFiles;
}