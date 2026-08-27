<script lang="ts">
    import { slide } from 'svelte/transition';
    import Self from './FileTreeNode.svelte';

    let {
        node,
        selectedPaths,
        folderDescendants,
        onToggle,
        onLoadChildren,
        onRemove
    }: {
        node: any;
        selectedPaths: Set<string>;
        folderDescendants: Map<string, string[]>;
        onToggle: (path: string, isFolder: boolean) => void;
        onLoadChildren: (path: string) => Promise<void>;
        onRemove: (path: string) => void;
    } = $props();

    let expanded = $state(false);
    let loading = $state(false);

    const isFolder = $derived(node.type === 'folder');
    const selfChecked = $derived(selectedPaths.has(node.path));

    // The checkbox means "queued for the next action", not "ignored". That
    // separation is what lets one column of checkboxes drive both the ignore
    // button and the un-ignore button.
    const descendants = $derived(folderDescendants.get(node.path) || []);
    const selectedCount = $derived(
        descendants.reduce((n, p) => n + (selectedPaths.has(p) ? 1 : 0), 0)
    );
    const fullyChecked = $derived(
        isFolder && descendants.length
            ? selfChecked && selectedCount === descendants.length
            : selfChecked
    );
    const indeterminate = $derived(
        isFolder && !fullyChecked && (selfChecked || selectedCount > 0)
    );

    const hasChildren = $derived(node.children && node.children.length > 0);

    // Only rules this tool wrote can be removed from a row. A hand-written
    // rule stays the user's to change, in their editor.
    const removable = $derived(node.isIgnored && node.isManaged);

    async function handleExpand() {
        if (!isFolder) return;
        if (!expanded && node.isMassive && !hasChildren) {
            loading = true;
            expanded = true;
            await onLoadChildren(node.path);
            loading = false;
            return;
        }
        expanded = !expanded;
    }
</script>

<div class="select-none">
    <div
        class="flex items-center gap-2 py-1 px-2 rounded-lg hover:bg-white/5 group transition-colors border border-transparent hover:border-cyan-500/20"
        style="padding-left: {node.depth * 1.25 + 0.5}rem"
    >
        <button
            onclick={(e) => {
                e.stopPropagation();
                handleExpand();
            }}
            aria-label={expanded ? 'Collapse' : 'Expand'}
            class="w-5 h-5 flex items-center justify-center rounded hover:bg-white/10 text-slate-500 transition-transform duration-200 {expanded
                ? 'rotate-90 text-cyan-400'
                : ''} {isFolder ? '' : 'invisible'}"
        >
            {#if loading}
                <svg class="animate-spin h-3 w-3 text-cyan-400" fill="none" viewBox="0 0 24 24">
                    <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                    <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
                </svg>
            {:else}
                ▶
            {/if}
        </button>

        <button
            onclick={(e) => {
                e.stopPropagation();
                if (!node.neverSynced) onToggle(node.path, isFolder);
            }}
            disabled={node.neverSynced}
            title={node.neverSynced
                ? 'Syncthing handles this name itself. A rule for it would do nothing.'
                : fullyChecked
                  ? 'Deselect'
                  : 'Select'}
            aria-label="Select {node.name}"
            class="w-4 h-4 rounded border flex items-center justify-center transition-all duration-200 shrink-0
            {node.neverSynced
                ? 'bg-slate-800 border-slate-800 opacity-20 cursor-not-allowed'
                : fullyChecked
                  ? 'bg-cyan-500 border-cyan-500 text-slate-950 shadow-[0_0_8px_rgba(34,211,238,0.4)]'
                  : indeterminate
                    ? 'bg-slate-900 border-cyan-500 shadow-[0_0_5px_rgba(34,211,238,0.2)]'
                    : 'border-slate-700 bg-slate-900/50 hover:border-cyan-500 hover:bg-cyan-500/20'}"
        >
            {#if fullyChecked}
                <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M5 13l4 4L19 7"></path>
                </svg>
            {:else if indeterminate}
                <div class="w-2.5 h-0.5 bg-cyan-400 rounded-full"></div>
            {/if}
        </button>

        <div
            class="flex items-center gap-2 text-sm font-mono truncate cursor-pointer flex-1 min-w-0"
            role="button"
            tabindex="0"
            onclick={handleExpand}
            onkeydown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') handleExpand();
            }}
        >
            <span class="shrink-0 {node.isIgnored ? 'opacity-40' : 'opacity-90'}">
                {isFolder ? '📁' : '📄'}
            </span>

            <span
                class="truncate {node.isIgnored
                    ? 'text-slate-600 line-through decoration-slate-700'
                    : selfChecked
                      ? 'text-cyan-100'
                      : 'text-slate-400'} group-hover:text-cyan-50 transition-colors"
            >
                {node.name}
            </span>

            {#if node.isIgnored}
                <span
                    title="{node.isManaged ? 'Managed rule' : 'Your rule'}: {node.decidedBy}"
                    class="ml-1 shrink-0 text-[9px] uppercase px-1.5 rounded tracking-wider border
                    {node.isManaged
                        ? 'border-amber-900/50 text-amber-400/80 bg-amber-950/30'
                        : 'border-slate-700 text-slate-500 bg-slate-900'}"
                >
                    Ignored{node.isManaged ? '' : ' (yours)'}
                </span>
            {:else if node.isNegated}
                <span
                    title="Kept by your rule: {node.decidedBy}"
                    class="ml-1 shrink-0 text-[9px] uppercase border border-emerald-900/50 text-emerald-400/80 px-1.5 rounded bg-emerald-950/30 tracking-wider"
                >
                    Kept
                </span>
            {:else if node.isJunk}
                <span
                    title="Auto-detect would pick this up"
                    class="ml-1 shrink-0 text-[9px] uppercase border border-cyan-900/50 text-cyan-400/70 px-1.5 rounded bg-cyan-950/30 tracking-wider"
                >
                    Detected
                </span>
            {/if}

            {#if node.isMassive}
                <span
                    title="Not scanned yet. Click to expand."
                    class="ml-1 shrink-0 text-[9px] uppercase border border-slate-700 text-slate-500 px-1.5 rounded bg-slate-900/60 tracking-wider"
                >
                    Unscanned
                </span>
            {/if}
        </div>

        {#if removable}
            <button
                onclick={(e) => {
                    e.stopPropagation();
                    onRemove(node.path);
                }}
                title="Remove this rule from .stignore"
                aria-label="Stop ignoring {node.name}"
                class="shrink-0 w-5 h-5 rounded flex items-center justify-center text-slate-600 hover:text-rose-400 hover:bg-rose-500/10 opacity-0 group-hover:opacity-100 transition-all text-xs"
            >
                ✕
            </button>
        {/if}
    </div>

    {#if expanded && (hasChildren || node.isMassive)}
        <div transition:slide|local={{ duration: 200 }}>
            {#if node.children}
                {#each node.children as child (child.path)}
                    <Self
                        node={child}
                        {selectedPaths}
                        {folderDescendants}
                        {onToggle}
                        {onLoadChildren}
                        {onRemove}
                    />
                {/each}
            {/if}
        </div>
    {/if}
</div>
