<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import { fade, slide } from 'svelte/transition';
    import FileTreeNode from '$lib/components/FileTreeNode.svelte';
    import { PRESET_GROUPS, type PresetGroup } from '$lib/presets';

    // --- state ---------------------------------------------------------------

    let booting = $state(true);
    let busy = $state(false);
    let treeLoading = $state(false);
    let shuttingDown = $state(false);
    let serverGone = $state(false);

    let status: any = $state(null);
    let treeNodes: any[] = $state([]);
    let detected: any[] = $state([]);
    let depth = $state(3);

    let selectedPaths: Set<string> = $state(new Set());
    let folderDescendants = new Map<string, string[]>();
    let nodeMeta: Map<string, { isIgnored: boolean; isManaged: boolean }> = $state(new Map());

    let confirmAction: {
        mode: 'add' | 'remove';
        title: string;
        paths: string[];
    } | null = $state(null);
    let result: any = $state(null);
    let managedOpen = $state(false);
    let copied = $state(false);
    let presetsOpen = $state(false);
    let folderOpen = $state(false);
    let folderInput = $state('');
    let clearAsk: 'managed' | 'all' | null = $state(null);

    /**
     * Which catalogue patterns are currently in the file. Nothing is on by
     * default: the file is the state, so a pattern is ticked only because it
     * is actually written.
     */
    const activeLines = $derived(
        new Set<string>((status?.managedRules || []).map((r: any) => r.line))
    );

    function groupState(g: PresetGroup): 'all' | 'some' | 'none' {
        const on = g.patterns.filter((p) => activeLines.has(p)).length;
        return on === 0 ? 'none' : on === g.patterns.length ? 'all' : 'some';
    }

    const MAX_DEPTH = 12;

    let healthTimer: any;

    // --- derived -------------------------------------------------------------

    const pendingDetected = $derived(detected.filter((d) => !d.alreadyIgnored));

    /** Paths ticked in the tree that are not ignored yet. */
    const selectedToIgnore = $derived(
        [...selectedPaths].filter((p) => !nodeMeta.get(p)?.isIgnored)
    );

    /** Ticked paths whose deciding rule is one we wrote, so we can take it back. */
    const selectedToUnignore = $derived(
        [...selectedPaths].filter((p) => nodeMeta.get(p)?.isManaged)
    );

    /** Ticked paths ignored by a rule the user wrote. We will not touch those. */
    const selectedManual = $derived(
        [...selectedPaths].filter(
            (p) => nodeMeta.get(p)?.isIgnored && !nodeMeta.get(p)?.isManaged
        )
    );

    const ignoredCount = $derived(
        [...nodeMeta.values()].filter((m) => m.isIgnored).length
    );

    // --- lifecycle -----------------------------------------------------------

    onMount(async () => {
        await refreshStatus();
        depth = readSavedDepth();
        await Promise.all([loadTree(), loadDetected()]);
        booting = false;

        // Polls only to notice the server dying. Nothing shuts down on a
        // missed ping: the old watchdog that did that is gone.
        healthTimer = setInterval(async () => {
            if (shuttingDown || serverGone) return;
            try {
                const c = new AbortController();
                const t = setTimeout(() => c.abort(), 3000);
                const res = await fetch('/api/health', { signal: c.signal });
                clearTimeout(t);
                if (!res.ok) throw new Error();
            } catch {
                if (!shuttingDown) serverGone = true;
            }
        }, 5000);
    });

    onDestroy(() => clearInterval(healthTimer));

    function readSavedDepthFor(cwd: string): number {
        try {
            const v = Number(localStorage.getItem(`stignore:depth:${cwd}`));
            return Number.isFinite(v) && v >= 1 && v <= MAX_DEPTH ? v : 3;
        } catch {
            return 3;
        }
    }

    function readSavedDepth(): number {
        return readSavedDepthFor(status?.cwd || '');
    }

    function depthKey() {
        return `stignore:depth:${status?.cwd || ''}`;
    }

    function saveDepth(v: number) {
        try {
            localStorage.setItem(depthKey(), String(v));
        } catch {
            // Private browsing. The number just does not persist.
        }
    }

    // --- data ----------------------------------------------------------------

    async function refreshStatus() {
        try {
            status = await (await fetch('/api/status')).json();
        } catch {
            serverGone = true;
        }
    }

    function indexTree(nodes: any[]): string[] {
        const here: string[] = [];
        for (const node of nodes) {
            if (node.neverSynced) continue;
            nodeMeta.set(node.path, {
                isIgnored: node.isIgnored,
                isManaged: node.isManaged
            });
            here.push(node.path);
            if (node.type === 'folder' && node.children) {
                const kids = indexTree(node.children);
                folderDescendants.set(node.path, kids);
                here.push(...kids);
            }
        }
        return here;
    }

    async function loadTree(showOverlay = true) {
        if (showOverlay) treeLoading = true;
        try {
            const data = await (await fetch('/api/tree')).json();
            treeNodes = data.tree || [];
            nodeMeta = new Map();
            folderDescendants.clear();
            indexTree(treeNodes);
            nodeMeta = new Map(nodeMeta);
            // Drop anything that no longer exists so counts stay honest.
            selectedPaths = new Set(
                [...selectedPaths].filter((p) => nodeMeta.has(p))
            );
        } catch {
            serverGone = true;
        } finally {
            if (showOverlay) treeLoading = false;
        }
    }

    async function loadDetected() {
        try {
            const data = await (await fetch(`/api/detect?depth=${depth}`)).json();
            detected = data.found || [];
        } catch {
            detected = [];
        }
    }

    async function handleLoadChildren(folderPath: string) {
        try {
            const data = await (
                await fetch(`/api/tree?path=${encodeURIComponent(folderPath)}`)
            ).json();
            if (!data.tree?.length) return;

            const graft = (nodes: any[]): boolean => {
                for (const node of nodes) {
                    if (node.path === folderPath) {
                        node.children = data.tree;
                        node.isMassive = false;
                        return true;
                    }
                    if (node.children?.length && graft(node.children)) return true;
                }
                return false;
            };
            graft(treeNodes);

            const kids = indexTree(data.tree);
            folderDescendants.set(folderPath, kids);
            // A folder ticked before expanding should stay fully ticked after.
            if (selectedPaths.has(folderPath)) {
                const next = new Set(selectedPaths);
                kids.forEach((k) => next.add(k));
                selectedPaths = next;
            }
            treeNodes = [...treeNodes];
        } catch {
            // A folder that will not open is not worth a modal.
        }
    }

    // --- selection -----------------------------------------------------------

    function toggleNode(nodePath: string, isFolder: boolean) {
        const kin = isFolder
            ? [nodePath, ...(folderDescendants.get(nodePath) || [])]
            : [nodePath];
        const next = new Set(selectedPaths);
        const full = kin.every((p) => next.has(p));
        kin.forEach((p) => (full ? next.delete(p) : next.add(p)));
        selectedPaths = next;
    }

    function selectAll() {
        selectedPaths = new Set(nodeMeta.keys());
    }

    function selectNone() {
        selectedPaths = new Set();
    }

    function invert() {
        const next = new Set<string>();
        for (const p of nodeMeta.keys()) if (!selectedPaths.has(p)) next.add(p);
        selectedPaths = next;
    }

    // --- actions -------------------------------------------------------------

    function askIgnoreDetected() {
        confirmAction = {
            mode: 'add',
            title: `Ignore ${pendingDetected.length} detected folder${pendingDetected.length === 1 ? '' : 's'}`,
            paths: pendingDetected.map((d) => d.path)
        };
    }

    function askIgnoreSelected() {
        confirmAction = {
            mode: 'add',
            title: `Ignore ${selectedToIgnore.length} selected path${selectedToIgnore.length === 1 ? '' : 's'}`,
            paths: selectedToIgnore
        };
    }

    function askUnignoreSelected() {
        confirmAction = {
            mode: 'remove',
            title: `Stop ignoring ${selectedToUnignore.length} path${selectedToUnignore.length === 1 ? '' : 's'}`,
            paths: selectedToUnignore
        };
    }

    function askRemoveOne(p: string) {
        confirmAction = { mode: 'remove', title: 'Stop ignoring this path', paths: [p] };
    }

    async function runConfirmed() {
        if (!confirmAction) return;
        const { mode, paths } = confirmAction;
        confirmAction = null;
        busy = true;

        try {
            const res = await fetch('/api/rules', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    add: mode === 'add' ? paths : [],
                    remove: mode === 'remove' ? paths : [],
                    expectMtimeMs: status?.file?.mtimeMs || 0
                })
            });
            const data = await res.json();

            result = { mode, ...data };

            if (data.ok) {
                selectedPaths = new Set();
                await reloadAll();
            } else if (data.conflict) {
                // Someone edited the file underneath us. Reload rather than merge.
                await reloadAll();
            }
        } catch {
            result = { mode, ok: false, error: 'Could not reach the server.' };
        } finally {
            busy = false;
        }
    }

    async function changeDepth(next: number) {
        depth = Math.min(MAX_DEPTH, Math.max(1, next));
        saveDepth(depth);
        await loadDetected();
    }

    /**
     * Ignore rules are per device: Syncthing never syncs .stignore. Handing the
     * file to the clipboard is the practical way to repeat them on a phone or
     * another machine, where there is no shell to run this tool.
     */
    async function copyRules() {
        try {
            await navigator.clipboard.writeText(status?.file?.raw || '');
            copied = true;
            setTimeout(() => (copied = false), 2000);
        } catch {
            result = { mode: 'add', ok: false, error: 'The browser blocked clipboard access. Use Open file instead.' };
        }
    }

    /** Write or unwrite literal catalogue lines. No confirm: one click, visibly reversible. */
    async function writeLines(addLines: string[], removeLines: string[]) {
        busy = true;
        try {
            const res = await fetch('/api/rules', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ addLines, removeLines })
            });
            const data = await res.json();
            if (!data.ok) result = { mode: 'add', ...data };
            await reloadAll();
        } catch {
            result = { mode: 'add', ok: false, error: 'Could not reach the server.' };
        } finally {
            busy = false;
        }
    }

    function togglePreset(pattern: string) {
        if (activeLines.has(pattern)) writeLines([], [pattern]);
        else writeLines([pattern], []);
    }

    function toggleGroup(g: PresetGroup) {
        if (groupState(g) === 'all') writeLines([], g.patterns);
        else writeLines(g.patterns.filter((p) => !activeLines.has(p)), []);
    }

    /** Move rules between this device only and the shared, synced file. */
    async function toggleShared() {
        busy = true;
        try {
            const res = await fetch('/api/share', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ shared: !status?.shared })
            });
            const data = await res.json();
            if (!data.ok) result = { mode: 'add', ok: false, error: data.error };
            await reloadAll();
        } catch {
            result = { mode: 'add', ok: false, error: 'Could not reach the server.' };
        } finally {
            busy = false;
        }
    }

    /** Reload everything after the folder or the file changes underneath us. */
    async function reloadAll() {
        await refreshStatus();
        await Promise.all([loadTree(false), loadDetected()]);
    }

    async function switchFolder(action: 'browse' | 'set', p = '') {
        busy = true;
        try {
            const res = await fetch('/api/folder', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action, path: p })
            });
            const data = await res.json();
            if (!data.ok) {
                result = { mode: 'add', ok: false, error: data.error };
                return;
            }
            if (data.cancelled) return;
            selectedPaths = new Set();
            folderInput = '';
            folderOpen = false;
            depth = readSavedDepthFor(data.cwd);
            await reloadAll();
        } catch {
            result = { mode: 'add', ok: false, error: 'Could not reach the server.' };
        } finally {
            busy = false;
        }
    }

    async function doClear(scope: 'managed' | 'all') {
        clearAsk = null;
        busy = true;
        try {
            const res = await fetch('/api/clear', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ scope })
            });
            const data = await res.json();
            result = data.ok
                ? { mode: 'remove', ok: true, removed: new Array(data.cleared), shadowed: [] }
                : { mode: 'remove', ok: false, error: data.error };
            selectedPaths = new Set();
            await reloadAll();
        } catch {
            result = { mode: 'remove', ok: false, error: 'Could not reach the server.' };
        } finally {
            busy = false;
        }
    }

    async function openFile(target: 'file' | 'folder') {
        await fetch('/api/open', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ target })
        }).catch(() => {});
    }

    async function exitApp() {
        shuttingDown = true;
        fetch('/api/shutdown', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: status?.sessionId }),
            keepalive: true
        }).catch(() => {});
        await new Promise((r) => setTimeout(r, 600));
        window.close();
    }

    function relTime(ms: number): string {
        if (!ms) return 'never';
        const s = Math.round((Date.now() - ms) / 1000);
        if (s < 60) return 'just now';
        if (s < 3600) return `${Math.round(s / 60)} min ago`;
        if (s < 86400) return `${Math.round(s / 3600)} h ago`;
        return `${Math.round(s / 86400)} d ago`;
    }
</script>

<div class="min-h-screen flex flex-col items-center p-6 md:p-8 relative overflow-hidden font-sans">
    <!-- ambient background -->
    <div class="absolute inset-0 overflow-hidden pointer-events-none z-0">
        <div class="absolute top-[-20%] left-1/2 -translate-x-1/2 w-[800px] h-[600px] bg-cyan-500/20 rounded-full blur-[120px] animate-blob mix-blend-screen"></div>
        <div class="absolute top-[20%] left-[10%] w-[500px] h-[500px] bg-sky-600/20 rounded-full blur-[100px] animate-blob mix-blend-screen"></div>
        <div class="absolute bottom-[10%] right-[10%] w-[600px] h-[600px] bg-indigo-900/30 rounded-full blur-[100px] animate-blob mix-blend-screen"></div>
    </div>

    {#if booting || shuttingDown}
        <div class="fixed inset-0 z-[200] bg-[#020617] flex flex-col items-center justify-center" transition:fade>
            <div class="relative">
                <div class="w-32 h-32 bg-cyan-500/10 rounded-full animate-ping absolute top-0 left-0"></div>
                <div class="w-32 h-32 bg-cyan-600/20 rounded-full relative flex items-center justify-center border border-cyan-500/30 shadow-[0_0_80px_rgba(34,211,238,0.4)]">
                    <svg class="w-12 h-12 text-cyan-400 animate-spin duration-[3s]" fill="none" viewBox="0 0 24 24">
                        <circle class="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"></circle>
                        <path class="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
                    </svg>
                </div>
            </div>
            <h2 class="mt-10 text-xl font-black text-cyan-400 tracking-[0.3em] uppercase animate-pulse-slow">
                {shuttingDown ? 'Closing' : 'Reading .stignore'}
            </h2>
            {#if shuttingDown}
                <p class="mt-4 text-[11px] text-slate-600 font-mono">You can close this tab.</p>
            {/if}
        </div>
    {/if}

    {#if (treeLoading || busy) && !booting && !shuttingDown}
        <div class="fixed inset-0 z-[150] bg-[#020617]/80 backdrop-blur-sm flex items-center justify-center" transition:fade={{ duration: 200 }}>
            <div class="w-24 h-24 bg-black/50 rounded-full flex items-center justify-center border border-white/10 shadow-2xl">
                <svg class="w-10 h-10 text-cyan-400 animate-spin duration-[2s]" fill="none" viewBox="0 0 24 24">
                    <circle class="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2"></circle>
                    <path class="opacity-90" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
                </svg>
            </div>
        </div>
    {/if}

    {#if serverGone && !shuttingDown}
        <div class="fixed inset-0 z-[300] flex items-center justify-center bg-black/95 backdrop-blur-md" transition:fade>
            <div class="bg-slate-950 border border-rose-900/50 rounded-3xl p-10 w-full max-w-md text-center">
                <h3 class="text-2xl font-black text-white mb-3">Server stopped</h3>
                <p class="text-slate-400 mb-8 text-sm leading-relaxed">
                    The stignore process is no longer running. Close this tab and run
                    <code class="text-cyan-400">stignore</code> again.
                </p>
                <button
                    onclick={() => window.location.reload()}
                    class="w-full py-3 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-white font-bold rounded-xl transition-all"
                >
                    Reload
                </button>
            </div>
        </div>
    {/if}

    <!-- confirm -->
    {#if confirmAction}
        <div class="fixed inset-0 z-[100] flex items-center justify-center bg-black/90 backdrop-blur-md p-6" transition:fade>
            <div class="bg-[#0a0a0a] border border-cyan-500/30 rounded-3xl p-8 w-full max-w-lg shadow-[0_0_50px_rgba(34,211,238,0.12)] animate-fade-in-up">
                <h3 class="text-xl font-black text-white mb-2 tracking-tight">{confirmAction.title}</h3>
                <p class="text-[11px] text-slate-500 font-mono mb-4 break-all">{status?.file?.path}</p>

                <div class="bg-black/50 rounded-xl border border-white/5 p-3 max-h-64 overflow-y-auto custom-scrollbar font-mono text-xs">
                    {#each confirmAction.paths.slice(0, 200) as p}
                        <div class="flex gap-2 py-0.5">
                            <span class={confirmAction.mode === 'add' ? 'text-cyan-400' : 'text-rose-400'}>
                                {confirmAction.mode === 'add' ? '+' : '-'}
                            </span>
                            <span class="text-slate-400 break-all">/{p}</span>
                        </div>
                    {/each}
                    {#if confirmAction.paths.length > 200}
                        <div class="text-slate-600 pt-2">and {confirmAction.paths.length - 200} more</div>
                    {/if}
                </div>

                {#if confirmAction.mode === 'remove' && selectedManual.length}
                    <p class="mt-4 text-[11px] text-amber-400/80 leading-relaxed">
                        {selectedManual.length} selected path{selectedManual.length === 1 ? '' : 's'}
                        stay ignored by rules you wrote. This tool never edits those.
                    </p>
                {/if}

                <div class="flex gap-3 mt-6">
                    <button
                        onclick={() => (confirmAction = null)}
                        class="flex-1 py-3 text-slate-400 hover:text-white text-sm font-bold transition-colors"
                    >
                        Cancel
                    </button>
                    <button
                        onclick={runConfirmed}
                        class="flex-1 py-3 bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold rounded-xl transition-all shadow-lg"
                    >
                        Write to .stignore
                    </button>
                </div>
            </div>
        </div>
    {/if}

    <!-- clear -->
    {#if clearAsk}
        <div class="fixed inset-0 z-[105] flex items-center justify-center bg-black/90 backdrop-blur-md p-6" transition:fade>
            <div class="bg-[#0a0a0a] border border-rose-500/30 rounded-3xl p-8 w-full max-w-lg animate-fade-in-up">
                <h3 class="text-xl font-black text-white mb-2 tracking-tight">Clear ignore rules</h3>
                <p class="text-[11px] text-slate-500 font-mono mb-4 break-all">{status?.file?.targetPath}</p>

                <div class="flex flex-col gap-3">
                    <button
                        onclick={() => doClear('managed')}
                        class="text-left px-4 py-3 rounded-xl border border-cyan-500/30 bg-cyan-500/10 hover:bg-cyan-500/20 transition-all"
                    >
                        <div class="text-xs font-black text-cyan-100">
                            Remove the {status?.counts?.managed ?? 0} managed rule{status?.counts?.managed === 1 ? '' : 's'}
                        </div>
                        <div class="text-[10px] text-slate-400 mt-1 leading-relaxed">
                            Everything this tool wrote. Your own
                            {status?.counts?.manual ?? 0} hand-written line{status?.counts?.manual === 1 ? '' : 's'} stay.
                        </div>
                    </button>

                    <button
                        onclick={() => doClear('all')}
                        class="text-left px-4 py-3 rounded-xl border border-rose-500/40 bg-rose-950/30 hover:bg-rose-900/40 transition-all"
                    >
                        <div class="text-xs font-black text-rose-200">
                            Empty the file completely ({status?.counts?.total ?? 0} rules)
                        </div>
                        <div class="text-[10px] text-slate-400 mt-1 leading-relaxed">
                            Wipes hand-written rules too, and deletes
                            <code class="text-slate-300">.stignore</code> if nothing is left.
                            {#if status?.shared}
                                Sharing stays wired up so the folder does not error.
                            {/if}
                        </div>
                    </button>

                    {#if status?.file?.raw}
                        <details class="bg-black/50 rounded-xl border border-white/5">
                            <summary class="cursor-pointer text-[10px] uppercase font-bold tracking-wider text-slate-500 hover:text-cyan-300 px-3 py-2">
                                Show what is in there now
                            </summary>
                            <pre class="px-3 pb-3 text-[10px] font-mono text-slate-400 whitespace-pre-wrap break-all max-h-48 overflow-y-auto custom-scrollbar">{status.file.raw}</pre>
                        </details>
                    {/if}

                    <p class="text-[10px] text-slate-600 leading-relaxed">
                        A copy of the previous file is kept outside the synced folder, so a
                        mistake here is recoverable.
                    </p>

                    <button
                        onclick={() => (clearAsk = null)}
                        class="w-full py-3 text-slate-400 hover:text-white text-sm font-bold transition-colors"
                    >
                        Cancel
                    </button>
                </div>
            </div>
        </div>
    {/if}

    <!-- result -->
    {#if result}
        <div class="fixed inset-0 z-[110] flex items-center justify-center bg-black/90 backdrop-blur-md p-6" transition:fade>
            <div
                class="bg-[#0a0a0a] border rounded-3xl p-8 w-full max-w-lg animate-fade-in-up
                {result.ok ? 'border-cyan-500/30' : 'border-rose-500/30'}"
            >
                <h3 class="text-xl font-black text-white mb-4 tracking-tight">
                    {#if !result.ok}
                        {result.conflict ? 'File changed on disk' : 'Could not write'}
                    {:else if result.mode === 'add'}
                        Added {result.added?.length ?? 0} rule{result.added?.length === 1 ? '' : 's'}
                    {:else}
                        Removed {result.removed?.length ?? 0} rule{result.removed?.length === 1 ? '' : 's'}
                    {/if}
                </h3>

                {#if !result.ok}
                    <p class="text-slate-400 text-sm leading-relaxed">
                        {result.conflict
                            ? 'Something else edited .stignore while this page was open. Nothing was written and the page has reloaded. Try again.'
                            : result.error}
                    </p>
                {/if}

                {#if result.shadowed?.length}
                    <div class="mt-4 border border-amber-500/30 bg-amber-950/20 rounded-xl p-4">
                        <p class="text-[11px] text-amber-300 font-bold uppercase tracking-wider mb-2">
                            {result.shadowed.length} written but not in effect
                        </p>
                        <p class="text-[11px] text-slate-400 leading-relaxed mb-3">
                            Syncthing takes the first rule that matches. These sit below a rule
                            you wrote that matches first, so they do nothing.
                        </p>
                        <div class="font-mono text-[11px] space-y-1 max-h-40 overflow-y-auto custom-scrollbar">
                            {#each result.shadowed as s}
                                <div class="text-slate-500 break-all">
                                    /{s.path} <span class="text-amber-500/70">← {s.by}</span>
                                </div>
                            {/each}
                        </div>
                    </div>
                {/if}

                {#if result.rejected?.length}
                    <div class="mt-4 border border-rose-500/30 bg-rose-950/20 rounded-xl p-4">
                        <p class="text-[11px] text-rose-300 font-bold uppercase tracking-wider mb-2">
                            {result.rejected.length} skipped
                        </p>
                        <p class="text-[11px] text-slate-400 leading-relaxed">
                            These names contain glob characters, which .stignore would read as
                            pattern syntax. Add them by hand if you need them.
                        </p>
                        <div class="font-mono text-[11px] text-slate-500 mt-2 break-all">
                            {result.rejected.join(', ')}
                        </div>
                    </div>
                {/if}

                <button
                    onclick={() => (result = null)}
                    class="w-full mt-6 py-3 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-white font-bold rounded-xl transition-all"
                >
                    Close
                </button>
            </div>
        </div>
    {/if}

    <!-- header -->
    <div class="text-center mb-8 mt-4 animate-fade-in-up relative z-10 w-full max-w-6xl">
        <div class="flex items-start justify-between gap-4">
            <div class="flex-1 text-center">
                <h1 class="text-6xl md:text-8xl font-black tracking-tighter drop-shadow-[0_0_40px_rgba(34,211,238,0.3)]">
                    <span class="bg-gradient-to-r from-cyan-300 via-sky-400 to-indigo-400 bg-clip-text text-transparent animate-text-gradient bg-[length:200%_auto]">
                        STIGNORE
                    </span>
                </h1>
                <p class="text-[10px] text-slate-600 font-mono uppercase tracking-[0.3em] mt-2">
                    // syncthing ignore manager
                </p>
            </div>

            <button
                onclick={exitApp}
                class="shrink-0 px-4 py-2 rounded-lg border border-rose-500/30 bg-rose-950/20 hover:bg-rose-900/40 text-[10px] font-bold uppercase tracking-wider text-rose-300 hover:text-white transition-all"
            >
                Exit
            </button>
        </div>

        <div class="mt-6 inline-flex flex-col items-center gap-2 bg-black/40 backdrop-blur-md px-5 py-3 rounded-2xl border border-white/5 max-w-[90vw]">
            <div class="flex flex-wrap items-center justify-center gap-3">
                <span class="text-slate-500 text-[10px] uppercase font-bold tracking-[0.2em]">Folder</span>
                <span class="text-cyan-300 font-mono text-xs break-all">{status?.cwd || '...'}</span>
                <button
                    onclick={() => switchFolder('browse')}
                    disabled={busy}
                    class="px-3 py-1 bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-500/30 text-[10px] font-bold uppercase tracking-wider text-cyan-200 rounded transition-all disabled:opacity-40"
                >
                    Change
                </button>
                <button
                    onclick={() => openFile('folder')}
                    class="px-3 py-1 bg-white/5 hover:bg-cyan-500/10 border border-white/10 hover:border-cyan-500/30 text-[10px] font-bold uppercase tracking-wider text-slate-400 hover:text-cyan-300 rounded transition-all"
                >
                    Open
                </button>
                <button
                    onclick={() => (folderOpen = !folderOpen)}
                    class="px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-600 hover:text-cyan-300 transition-colors"
                    title="Type a path instead"
                >
                    {folderOpen ? '×' : '⌨'}
                </button>
            </div>

            {#if folderOpen}
                <!-- The dialog needs a desktop session. Typing a path always works. -->
                <form
                    transition:slide={{ duration: 150 }}
                    class="flex gap-2 w-full"
                    onsubmit={(e) => {
                        e.preventDefault();
                        if (folderInput.trim()) switchFolder('set', folderInput);
                    }}
                >
                    <input
                        bind:value={folderInput}
                        placeholder="/path/to/synced/folder"
                        spellcheck="false"
                        class="flex-1 min-w-[16rem] bg-black/50 border border-white/10 focus:border-cyan-500/40 rounded px-3 py-1.5 text-xs font-mono text-slate-200 outline-none"
                    />
                    <button
                        type="submit"
                        disabled={busy || !folderInput.trim()}
                        class="px-3 py-1.5 bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-500/30 text-[10px] font-bold uppercase tracking-wider text-cyan-200 rounded transition-all disabled:opacity-30"
                    >
                        Go
                    </button>
                </form>
            {/if}
        </div>
    </div>

    <div class="w-full max-w-6xl flex flex-col gap-6 relative z-20">
        <!-- TOP PANEL: status -->
        <div class="bg-slate-900/40 backdrop-blur-xl border border-white/10 rounded-3xl p-6 md:p-8 shadow-2xl animate-fade-in-up relative">
            <div class="absolute top-0 left-0 w-full h-[1px] bg-gradient-to-r from-transparent via-cyan-500/20 to-transparent"></div>

            <div class="flex flex-wrap justify-between items-center gap-4 mb-6">
                <h2 class="text-xs font-bold text-slate-300 uppercase tracking-[0.2em] flex items-center gap-2">
                    {#if !status?.file?.readable}
                        <span class="w-2 h-2 bg-rose-500 rounded-full shadow-[0_0_10px_#f43f5e]"></span> Unreadable
                    {:else if status?.file?.exists}
                        <span class="w-2 h-2 bg-cyan-400 rounded-full shadow-[0_0_10px_#22d3ee]"></span> .stignore active
                    {:else}
                        <span class="w-2 h-2 bg-slate-600 rounded-full"></span> No .stignore yet
                    {/if}
                </h2>

                <div class="flex gap-2">
                    <button
                        onclick={copyRules}
                        disabled={!status?.file?.exists}
                        class="px-3 py-1.5 rounded-lg border text-[10px] uppercase font-bold tracking-wider transition-all disabled:opacity-30 disabled:cursor-not-allowed
                        {copied
                            ? 'border-cyan-500/50 bg-cyan-500/20 text-cyan-200'
                            : 'border-white/10 bg-white/5 hover:bg-cyan-500/10 hover:border-cyan-500/30 text-slate-400 hover:text-cyan-300'}"
                        title="Copy the whole file, to paste into another device's ignore patterns"
                    >
                        {copied ? 'Copied' : 'Copy rules'}
                    </button>
                    <button
                        onclick={() => openFile('file')}
                        disabled={!status?.file?.exists}
                        class="px-3 py-1.5 rounded-lg border border-white/10 bg-white/5 hover:bg-cyan-500/10 hover:border-cyan-500/30 text-[10px] uppercase font-bold tracking-wider text-slate-400 hover:text-cyan-300 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                        Open file
                    </button>
                    <button
                        onclick={async () => {
                            await refreshStatus();
                            await Promise.all([loadTree(), loadDetected()]);
                        }}
                        class="px-3 py-1.5 rounded-lg border border-white/10 bg-white/5 hover:bg-cyan-500/10 hover:border-cyan-500/30 text-[10px] uppercase font-bold tracking-wider text-slate-400 hover:text-cyan-300 transition-all"
                    >
                        Reload
                    </button>
                    <button
                        onclick={() => (clearAsk = 'managed')}
                        disabled={!status?.counts?.total}
                        class="px-3 py-1.5 rounded-lg border border-rose-500/25 bg-rose-950/20 hover:bg-rose-900/40 text-[10px] uppercase font-bold tracking-wider text-rose-300/90 hover:text-rose-200 transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                    >
                        Clear
                    </button>
                </div>
            </div>

            <!-- warnings -->
            <div class="flex flex-col gap-2 mb-6 empty:mb-0">
                {#if status && !status.file.readable}
                    <p class="text-[11px] text-rose-300 bg-rose-950/30 border border-rose-500/20 rounded-lg px-4 py-2.5">
                        Cannot read .stignore ({status.file.error}). Fix the permissions and reload.
                        Nothing below reflects the real ignore state.
                    </p>
                {/if}
                {#if status && !status.hasStfolder}
                    <p class="text-[11px] text-amber-300/90 bg-amber-950/20 border border-amber-500/20 rounded-lg px-4 py-2.5">
                        No .stfolder marker here, so Syncthing probably is not syncing this
                        directory yet. A .stignore only takes effect at a folder root.
                    </p>
                {/if}
                {#if status?.missingIncludes?.length}
                    <p class="text-[11px] text-rose-300 bg-rose-950/30 border border-rose-500/20 rounded-lg px-4 py-2.5 leading-relaxed">
                        <span class="font-bold">Broken include.</span>
                        <code class="text-slate-300">.stignore</code> includes
                        <code class="text-slate-300">{status.missingIncludes.join(', ')}</code>, which
                        is not here. Syncthing treats a missing include as a folder error, so no
                        rules are being applied at all. Restore the file or remove the include line.
                    </p>
                {/if}

                {#if status?.hasStfolder}
                    <div class="bg-slate-900/40 border border-white/10 rounded-lg px-4 py-3">
                        <div class="flex items-start justify-between gap-4">
                            <div class="min-w-0">
                                <div class="text-[11px] font-bold uppercase tracking-wider mb-1 {status.shared ? 'text-cyan-300' : 'text-amber-300'}">
                                    {status.shared ? 'Shared with every device' : 'This device only'}
                                </div>
                                <p class="text-[11px] text-slate-400 leading-relaxed">
                                    {#if status.shared}
                                        Rules live in <code class="text-slate-300">{status.globalFileName}</code>,
                                        which the folder syncs like any other file, and
                                        <code class="text-slate-300">.stignore</code> pulls them in with
                                        <code class="text-slate-300">#include</code>. Every device that
                                        includes that file gets these rules. A device still needs the
                                        include line in its own <code class="text-slate-300">.stignore</code> once.
                                    {:else}
                                        Syncthing never syncs <code class="text-slate-300">.stignore</code>,
                                        so these rules apply here and nowhere else. Other devices keep
                                        their copies and push the files back. Sharing moves the rules
                                        into <code class="text-slate-300">{status.globalFileName}</code>,
                                        which does sync.
                                    {/if}
                                </p>
                            </div>

                            <button
                                onclick={toggleShared}
                                disabled={busy || !status?.file?.readable}
                                class="shrink-0 px-3 py-1.5 rounded-lg border text-[10px] uppercase font-bold tracking-wider transition-all disabled:opacity-30 disabled:cursor-not-allowed
                                {status.shared
                                    ? 'border-white/10 bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white'
                                    : 'border-cyan-500/40 bg-cyan-500/15 hover:bg-cyan-500/25 text-cyan-200'}"
                            >
                                {status.shared ? 'Make local' : 'Share with all devices'}
                            </button>
                        </div>
                    </div>
                {/if}
                {#if status?.hasEscapeDirective}
                    <p class="text-[11px] text-amber-300/90 bg-amber-950/20 border border-amber-500/20 rounded-lg px-4 py-2.5">
                        This file sets a custom escape character, which changes how patterns
                        are read. The tree below may be wrong about escaped patterns. Rules
                        written here are plain paths, so they are unaffected.
                    </p>
                {/if}
                {#if status?.includes?.length}
                    <p class="text-[11px] text-amber-300/90 bg-amber-950/20 border border-amber-500/20 rounded-lg px-4 py-2.5">
                        This file pulls patterns from another file ({status.includes.join(', ')}).
                        Those are not read here, so the tree below may show a path as syncing
                        when Syncthing ignores it.
                    </p>
                {/if}
            </div>

            <!-- facts -->
            <div class="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-4">
                {#each [['Path', status?.file?.exists ? status.file.path : 'will be created on first write'], ['Rules total', String(status?.counts?.total ?? 0)], ['Written by you', String(status?.counts?.manual ?? 0)], ['Managed here', String(status?.counts?.managed ?? 0)], ['Negations', String(status?.counts?.negations ?? 0)], ['Ignored in tree', `${ignoredCount}`], ['Detected junk', `${pendingDetected.length} pending`], ['Last change', status?.file?.exists ? relTime(status.file.mtimeMs) : 'never']] as [label, value]}
                    <div class="min-w-0">
                        <div class="text-[9px] uppercase font-bold tracking-[0.15em] text-slate-600 mb-1">
                            {label}
                        </div>
                        <div class="text-xs font-mono text-slate-300 break-all">{value}</div>
                    </div>
                {/each}
            </div>

            <!-- common patterns catalogue -->
            <div class="mt-6 border-t border-white/5 pt-4">
                <button
                    onclick={() => (presetsOpen = !presetsOpen)}
                    class="text-[10px] uppercase font-bold tracking-widest text-slate-500 hover:text-cyan-300 transition-colors flex items-center gap-2"
                >
                    <span class="transition-transform duration-200 {presetsOpen ? 'rotate-90' : ''}">▶</span>
                    Common patterns
                    <span class="text-slate-700 normal-case tracking-normal font-normal">
                        ({PRESET_GROUPS.reduce((n, g) => n + g.patterns.filter((p) => activeLines.has(p)).length, 0)} on)
                    </span>
                </button>

                {#if presetsOpen}
                    <div transition:slide={{ duration: 200 }} class="mt-3 flex flex-col gap-3">
                        <p class="text-[11px] text-slate-500 leading-relaxed">
                            Nothing here is on until you turn it on. Click a group to toggle all of
                            it, or a single pattern to toggle just that one. Everything written here
                            goes in the managed block and comes back out the same way.
                        </p>

                        {#each PRESET_GROUPS as g (g.id)}
                            {@const st = groupState(g)}
                            <div
                                class="rounded-xl border p-3 transition-colors
                                {st === 'none'
                                    ? 'border-white/5 bg-black/20'
                                    : g.risk === 'risky'
                                      ? 'border-rose-500/30 bg-rose-950/20'
                                      : 'border-cyan-500/30 bg-cyan-950/20'}"
                            >
                                <div class="flex items-start justify-between gap-3 mb-2">
                                    <div class="min-w-0">
                                        <button
                                            onclick={() => toggleGroup(g)}
                                            disabled={busy}
                                            class="text-left group/g disabled:opacity-50"
                                        >
                                            <span class="text-xs font-bold text-slate-200 group-hover/g:text-cyan-200 transition-colors">
                                                {g.name}
                                            </span>
                                            <span
                                                class="ml-2 text-[9px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded border
                                                {g.risk === 'safe'
                                                    ? 'border-emerald-900/50 text-emerald-400/80 bg-emerald-950/30'
                                                    : g.risk === 'careful'
                                                      ? 'border-amber-900/50 text-amber-400/80 bg-amber-950/30'
                                                      : 'border-rose-900/50 text-rose-400/90 bg-rose-950/30'}"
                                            >
                                                {g.risk}
                                            </span>
                                        </button>
                                        <p class="text-[10px] text-slate-500 mt-1 leading-relaxed">{g.note}</p>
                                    </div>

                                    <button
                                        onclick={() => toggleGroup(g)}
                                        disabled={busy}
                                        class="shrink-0 px-2.5 py-1 rounded-lg border text-[9px] uppercase font-bold tracking-wider transition-all disabled:opacity-30
                                        {st === 'all'
                                            ? 'border-cyan-500/40 bg-cyan-500/20 text-cyan-200'
                                            : st === 'some'
                                              ? 'border-cyan-500/30 bg-cyan-950/40 text-cyan-400'
                                              : 'border-white/10 bg-white/5 text-slate-500 hover:text-cyan-300 hover:border-cyan-500/30'}"
                                    >
                                        {st === 'all' ? 'All on' : st === 'some' ? 'Some' : 'Off'}
                                    </button>
                                </div>

                                <div class="flex flex-wrap gap-1.5">
                                    {#each g.patterns as p (p)}
                                        <button
                                            onclick={() => togglePreset(p)}
                                            disabled={busy}
                                            title={activeLines.has(p) ? 'Remove from .stignore' : 'Add to .stignore'}
                                            class="text-[10px] font-mono px-2 py-0.5 rounded border transition-all disabled:opacity-40
                                            {activeLines.has(p)
                                                ? 'border-cyan-500/50 bg-cyan-500/20 text-cyan-200'
                                                : 'border-slate-800 bg-slate-900/60 text-slate-500 hover:border-cyan-500/30 hover:text-cyan-300'}"
                                        >
                                            {p}
                                        </button>
                                    {/each}
                                </div>
                            </div>
                        {/each}
                    </div>
                {/if}
            </div>

            <!-- managed rules -->
            {#if status?.managedRules?.length}
                <div class="mt-6 border-t border-white/5 pt-4">
                    <button
                        onclick={() => (managedOpen = !managedOpen)}
                        class="text-[10px] uppercase font-bold tracking-widest text-slate-500 hover:text-cyan-300 transition-colors flex items-center gap-2"
                    >
                        <span class="transition-transform duration-200 {managedOpen ? 'rotate-90' : ''}">▶</span>
                        Managed rules ({status.managedRules.length})
                    </button>

                    {#if managedOpen}
                        <div transition:slide={{ duration: 200 }} class="mt-3 bg-black/40 rounded-xl border border-white/5 p-3 max-h-64 overflow-y-auto custom-scrollbar">
                            {#each status.managedRules as rule}
                                <div class="flex items-center gap-2 py-1 group hover:bg-white/5 rounded px-2">
                                    <span class="font-mono text-xs text-slate-400 flex-1 break-all">{rule.line}</span>
                                    <button
                                        onclick={() => askRemoveOne(rule.path)}
                                        title="Remove this rule"
                                        aria-label="Remove {rule.line}"
                                        class="shrink-0 w-5 h-5 rounded flex items-center justify-center text-slate-600 hover:text-rose-400 hover:bg-rose-500/10 opacity-0 group-hover:opacity-100 transition-all text-xs"
                                    >
                                        ✕
                                    </button>
                                </div>
                            {/each}
                        </div>
                        <p class="text-[10px] text-slate-600 mt-2 leading-relaxed">
                            This list is the only way to remove a rule whose folder is already
                            gone from disk, since the tree cannot show it.
                        </p>
                    {/if}
                </div>
            {/if}
        </div>

        <!-- BOTTOM PANEL: tree -->
        <div class="bg-slate-900/40 backdrop-blur-xl border border-white/10 rounded-3xl p-6 md:p-8 shadow-2xl flex flex-col gap-4 animate-fade-in-up relative" style="animation-delay: 0.1s;">
            <div class="flex flex-wrap justify-between items-center gap-4">
                <div>
                    <h2 class="text-xs font-bold text-slate-200 uppercase tracking-[0.2em]">Files</h2>
                    <div class="text-[10px] text-slate-500 font-mono mt-1">
                        {selectedPaths.size} selected · {ignoredCount} ignored
                    </div>
                </div>

                <div class="flex flex-wrap gap-2">
                    <button onclick={selectAll} class="px-3 py-1.5 bg-slate-800/80 hover:bg-slate-700 border border-slate-700 text-[10px] font-bold uppercase tracking-wider text-slate-400 hover:text-white rounded-lg transition-all">Select all</button>
                    <button onclick={selectNone} class="px-3 py-1.5 bg-slate-800/80 hover:bg-slate-700 border border-slate-700 text-[10px] font-bold uppercase tracking-wider text-slate-400 hover:text-white rounded-lg transition-all">Clear</button>
                    <button onclick={invert} class="px-3 py-1.5 bg-slate-800/80 hover:bg-slate-700 border border-slate-700 text-[10px] font-bold uppercase tracking-wider text-slate-400 hover:text-white rounded-lg transition-all">Invert</button>
                </div>
            </div>

            <!-- action bar -->
            <div class="flex flex-wrap items-stretch gap-3 border-y border-white/5 py-4">
                <div class="flex items-center gap-2 bg-black/30 border border-white/5 rounded-xl px-3 py-2">
                    <div class="flex flex-col">
                        <span class="text-[9px] uppercase font-bold tracking-[0.15em] text-slate-500">Depth</span>
                        <span class="text-[9px] text-slate-600">levels to search</span>
                    </div>
                    <div class="flex items-center gap-1 ml-2">
                        <button onclick={() => changeDepth(depth - 1)} disabled={depth <= 1} aria-label="Search one level shallower" class="w-6 h-6 rounded bg-white/5 hover:bg-cyan-500/20 text-slate-400 hover:text-cyan-300 disabled:opacity-30 transition-all">−</button>
                        <span class="w-6 text-center font-mono text-sm text-cyan-300">{depth}</span>
                        <button onclick={() => changeDepth(depth + 1)} disabled={depth >= MAX_DEPTH} aria-label="Search one level deeper" class="w-6 h-6 rounded bg-white/5 hover:bg-cyan-500/20 text-slate-400 hover:text-cyan-300 disabled:opacity-30 transition-all">+</button>
                        <button
                            onclick={() => changeDepth(MAX_DEPTH)}
                            disabled={depth >= MAX_DEPTH}
                            title="Search as deep as it goes"
                            class="ml-1 px-2 h-6 rounded bg-white/5 hover:bg-cyan-500/20 text-[9px] uppercase font-bold tracking-wider text-slate-500 hover:text-cyan-300 disabled:opacity-30 transition-all"
                        >
                            Max
                        </button>
                    </div>
                </div>

                <button
                    onclick={askIgnoreDetected}
                    disabled={!pendingDetected.length || !status?.file?.readable}
                    class="flex-1 min-w-[15rem] px-5 py-3 rounded-xl bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/30 hover:border-cyan-400/60 text-left transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                >
                    <div class="text-xs font-black text-cyan-100 tracking-tight">
                        Ignore detected junk ({pendingDetected.length})
                    </div>
                    <!-- Say why the button is dead, rather than just greying it out. -->
                    <div class="text-[10px] font-mono mt-0.5 {pendingDetected.length ? 'text-slate-500' : 'text-amber-400/80'}">
                        {#if pendingDetected.length}
                            {detected.length} found within {depth} level{depth === 1 ? '' : 's'}
                        {:else if detected.length}
                            all {detected.length} already ignored
                        {:else if depth < MAX_DEPTH}
                            nothing within {depth} level{depth === 1 ? '' : 's'}, try deeper
                        {:else}
                            nothing found at any depth
                        {/if}
                    </div>
                </button>

                <button
                    onclick={askIgnoreSelected}
                    disabled={!selectedToIgnore.length || !status?.file?.readable}
                    class="flex-1 min-w-[12rem] px-5 py-3 rounded-xl bg-white/5 hover:bg-cyan-500/10 border border-white/10 hover:border-cyan-500/30 text-left transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                >
                    <div class="text-xs font-black text-slate-100 tracking-tight">
                        Ignore selected ({selectedToIgnore.length})
                    </div>
                    <div class="text-[10px] text-slate-500 font-mono mt-0.5">from the tree below</div>
                </button>

                <button
                    onclick={askUnignoreSelected}
                    disabled={!selectedToUnignore.length || !status?.file?.readable}
                    class="flex-1 min-w-[12rem] px-5 py-3 rounded-xl bg-white/5 hover:bg-rose-500/10 border border-white/10 hover:border-rose-500/30 text-left transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                >
                    <div class="text-xs font-black text-slate-100 tracking-tight">
                        Stop ignoring ({selectedToUnignore.length})
                    </div>
                    <div class="text-[10px] text-slate-500 font-mono mt-0.5">managed rules only</div>
                </button>
            </div>

            {#if detected.length}
                <div class="bg-black/20 rounded-xl border border-white/5 p-3 max-h-32 overflow-y-auto custom-scrollbar">
                    <div class="text-[9px] uppercase font-bold tracking-[0.15em] text-slate-600 mb-2">
                        Detected at depth {depth}
                    </div>
                    <div class="flex flex-wrap gap-1.5">
                        {#each detected as d}
                            <span
                                title={d.alreadyIgnored ? 'Already ignored' : 'Will be added'}
                                class="text-[10px] font-mono px-2 py-0.5 rounded border
                                {d.alreadyIgnored
                                    ? 'border-slate-800 text-slate-600 bg-slate-900/50 line-through'
                                    : 'border-cyan-900/50 text-cyan-300/80 bg-cyan-950/30'}"
                            >
                                {d.path}
                            </span>
                        {/each}
                    </div>
                </div>
            {/if}

            <div class="bg-black/40 rounded-xl border border-white/5 p-4 max-h-[520px] overflow-y-auto custom-scrollbar font-mono text-sm">
                {#if treeNodes.length}
                    {#each treeNodes as node (node.path)}
                        <FileTreeNode
                            {node}
                            selectedPaths={selectedPaths}
                            {folderDescendants}
                            onToggle={toggleNode}
                            onLoadChildren={handleLoadChildren}
                            onRemove={askRemoveOne}
                        />
                    {/each}
                {:else}
                    <p class="text-center text-slate-600 text-xs py-8 uppercase tracking-widest">
                        Nothing here
                    </p>
                {/if}
            </div>
        </div>
    </div>

    <div class="mt-auto pt-12 pb-6 text-center relative z-10">
        <p class="text-[9px] text-slate-700 font-bold tracking-[0.3em] uppercase">
            stignore v{status?.appVersion || '...'} · local only
        </p>
    </div>
</div>

<style>
    .custom-scrollbar {
        scrollbar-width: thin;
        scrollbar-color: rgba(34, 211, 238, 0.2) rgba(255, 255, 255, 0.02);
    }
</style>
