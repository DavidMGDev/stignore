/**
 * A catalogue of common ignore patterns, grouped, for ticking on and off.
 *
 * Risk is the important column here. Plenty of "commonly ignored" lists on the
 * internet mix genuine junk in with whole file types, and pasting one of those
 * into a folder that holds documents or photos silently stops syncing the
 * content people actually care about. Nothing is on by default, and the groups
 * that can eat real work say so.
 */

export type Risk = 'safe' | 'careful' | 'risky';

export interface PresetGroup {
    id: string;
    name: string;
    risk: Risk;
    /** Shown under the group name. Says what breaks, not what it does. */
    note: string;
    patterns: string[];
}

export const PRESET_GROUPS: PresetGroup[] = [
    {
        id: 'os',
        name: 'OS metadata',
        risk: 'safe',
        note: 'Junk the operating system writes. Never anything you made.',
        patterns: [
            '.DS_Store',
            'Thumbs.db',
            'desktop.ini',
            '.Spotlight-V100/',
            '.Trashes/',
            '.Trash-*/',
            '.AppleDouble/',
            '.fuse_hidden*/',
            '$RECYCLE.BIN/',
            'System Volume Information/'
        ]
    },
    {
        id: 'temp',
        name: 'Temporary and swap files',
        risk: 'safe',
        note: 'Editor scratch files. `*~` and `.#*` also catch emacs and vim leftovers.',
        patterns: ['*.tmp', '*.temp', '*.swp', '*~', '.*~', '*#', '.#*']
    },
    {
        id: 'logs',
        name: 'Log files',
        risk: 'safe',
        note: 'Regenerated constantly, which is what makes a folder churn.',
        patterns: ['*.log', '*.log.*']
    },
    {
        id: 'caches',
        name: 'Cache directories',
        risk: 'safe',
        note: 'Rebuildable. `temp/` and `tmp/` match at any depth, not just the root.',
        patterns: ['.cache/', '.tmp/', 'temp/', 'tmp/', '__pycache__/']
    },
    {
        id: 'packages',
        name: 'Package directories',
        risk: 'safe',
        note: 'Reinstallable from a lockfile. Usually the single biggest win.',
        patterns: ['node_modules/', 'vendor/', 'bower_components/']
    },
    {
        id: 'compiled',
        name: 'Compiled and binary output',
        risk: 'safe',
        note: 'Build products. Skip this group if you sync prebuilt tools you cannot rebuild.',
        patterns: [
            '*.class', '*.o', '*.obj', '*.pyc', '*.pyo',
            '*.dll', '*.exe', '*.so', '*.dylib'
        ]
    },
    {
        id: 'minified',
        name: 'Minified files and source maps',
        risk: 'safe',
        note: 'Generated from sources you are already syncing.',
        patterns: ['*.min.*', '*.map']
    },
    {
        id: 'editors',
        name: 'Editor and IDE settings',
        risk: 'careful',
        note: 'Some people deliberately sync these to keep one setup across machines.',
        patterns: ['.idea/', '.vscode/', '*.sublime*']
    },
    {
        id: 'backups',
        name: 'Backup files',
        risk: 'careful',
        note: 'If a recovered `.bak` is ever your only copy of something, leave this off.',
        patterns: ['*.bak', '*.backup', '*.old', '*.orig']
    },
    {
        id: 'vcs',
        name: 'Version control internals',
        risk: 'careful',
        note: 'Ignoring `.git/` means the repository history does not travel with the files.',
        patterns: ['.git/', '.svn/']
    },
    {
        id: 'fonts',
        name: 'Font files',
        risk: 'careful',
        note: 'Fine for a code folder. Wrong if the folder is a font library or a design project.',
        patterns: ['*.woff', '*.ttf', '*.eot', '*.otf']
    },
    {
        id: 'archives',
        name: 'Archive files',
        risk: 'careful',
        note: 'A zip is often the thing you meant to sync. Check before ticking.',
        patterns: ['*.zip', '*.tar', '*.rar', '*.7z']
    },
    {
        id: 'images',
        name: 'Images',
        risk: 'risky',
        note: 'Stops syncing every image anywhere in the folder. In a notes vault this silently breaks pasted screenshots and attachments.',
        patterns: ['*.jpg', '*.jpeg', '*.png', '*.gif', '*.bmp', '*.ico']
    },
    {
        id: 'media',
        name: 'Audio and video',
        risk: 'risky',
        note: 'Stops syncing every media file. Only sensible when you keep media somewhere else on purpose.',
        patterns: ['*.mp3', '*.mp4', '*.avi', '*.mkv', '*.mov', '*.swf']
    },
    {
        id: 'documents',
        name: 'Documents and data files',
        risk: 'risky',
        note: 'This is content, not junk. Ticking it stops syncing your spreadsheets, PDFs and exports. Almost never what you want.',
        patterns: [
            '*.csv', '*.json', '*.xml', '*.psd',
            '*.doc', '*.docx', '*.xls', '*.xlsx',
            '*.ppt', '*.pptx', '*.pdf'
        ]
    }
];

/** Every preset pattern, for telling catalogue lines apart from path rules. */
export const ALL_PRESET_PATTERNS = new Set(
    PRESET_GROUPS.flatMap((g) => g.patterns)
);
