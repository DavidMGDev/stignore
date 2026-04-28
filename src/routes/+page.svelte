<script lang="ts">
    import { onMount, onDestroy, tick, untrack } from "svelte";

    import { templates } from "$lib/templates";

    import FileTreeNode from "$lib/components/FileTreeNode.svelte";
    import PretextButton from "$lib/components/PretextButton.svelte";

    import { fade, slide } from "svelte/transition";

    // --- STATE ---

    let isDetecting = $state(true);

    let isProcessing = $state(false);

    let isAppLoading = $state(true);

    let isShuttingDown = $state(false);

    let settingsOpen = $state(false);

    let templatesExpanded = $state(false);

    // Data

    let appVersion = $state("..."); // <--- Add this line

    let detectedIds: string[] = $state([]);

    let projectConfig: any = $state(null); // <--- NEW

    let detectionReasons: Record<string, string[]> = $state({});

    let gitStatus: "none" | "clean" | "ignored" = $state("none");

    let selectedIds: string[] = $state([]);

    let maxChars = $state(75000);
    let disableSplitting = $state(false);

    let customPath = $state("");

    let cwd = $state("");

    let sessionId = $state("");

    let savedCustomPath = $state("");

    let globalVaultPath = $state("");

    // Connection State
    let connectionLost = $state(false);

    // Debug State

    let isDebug = $state(false);

    function logUI(msg: string, data: any = "") {
        if (isDebug) {
            console.log(
                `%c[UI DEBUG] ${msg}`,
                "color: #f97316; font-weight: bold;",
                data,
            );
        }
    }

    // TREE STATE

    let treeNodes: any[] = $state([]);

    let treeLoading = $state(false);

    let treeExpanded = $state(false);

    // NEW: Toggle for Tree Generation context
    // UPDATED: Variable reflects UI toggle state (ON = Include files)
    let includeIgnoredFiles = $state(true);

    // State for Visuals (Derived from Rules)
    let selectedFilePaths: Set<string> = $state(new Set());

    // State for Logic (The Source of Truth)
    let selectionRules: Record<string, "include" | "exclude"> = $state({});

    // Baseline (Auto-detected) paths, used to calculate "default" state
    let defaultIncludedPaths: Set<string> = $state(new Set());

    // Check if rules exist (Modified if selectionRules has keys)
    let isTreeModified = $derived(Object.keys(selectionRules).length > 0);

    // FIX: Converted from $derived to a pure function to avoid state_unsafe_mutation.
    // Using untrack() ensures this doesn't accidentally lock state if called during a reaction.
    function getIsConfigDirty() {
        // In the template, this function re-runs whenever the template re-renders.
        // We safely read state here.

        if (!projectConfig) return true;

        // 1. Max Chars
        const savedMax = projectConfig.maxChars || 75000;
        if (maxChars !== savedMax) return true;

        // 2. Disable Splitting (New)
        const savedSplit = !!projectConfig.disableSplitting;
        if (disableSplitting !== savedSplit) return true;

        // 3. Ignored Files Toggle
        const configInclude = !projectConfig.hideIgnoredInTree;
        if (includeIgnoredFiles !== configInclude) return true;

        // 4. Templates
        // Create copies to avoid mutating original arrays with sort()
        const currentTmpl = [...selectedIds].sort();
        const savedTmpl = [...(projectConfig.templateIds || [])].sort();
        if (JSON.stringify(currentTmpl) !== JSON.stringify(savedTmpl))
            return true;

        // 5. Selection Rules (Deep Compare)
        const savedRules = projectConfig.selectionRules || {};
        if (JSON.stringify(selectionRules) !== JSON.stringify(savedRules))
            return true;

        return false;
    }

    // NEW: Cache map for instant toggling performance
    let folderDescendants = new Map<string, string[]>();

    let treeCardElement: HTMLElement;

    // UPDATED: Store metadata to help bulk actions filter media/ignored files
    let fileTypeMap = new Map<
        string,
        { type: "file" | "folder"; isMedia: boolean; isIgnored: boolean }
    >();

    let useTreeMode = $derived(treeExpanded);

    // Dialog State

    let showSuccessDialog = $state(false);

    let showErrorDialog = $state(false);

    let showVersionResetDialog = $state(false);

    let showUpdateDialog = $state(false);
    let showUpdateSuccessDialog = $state(false); // <--- NEW
    let updateInfo: any = $state(null);
    let isUpdating = $state(false);

    let dialogTitle = $state("");

    let dialogMessage = $state("");

    let successOutputPath = $state("");

    // --- COMPUTED ---

    // UPDATED: Added .sort() to display alphabetically
    // Note: .filter() creates a new array, so .sort() mutating it is technically safe,
    // but explicit spread helps readability and safety guarantees.
    let selectedTemplateObjects = $derived(
        [...templates]
            .filter((t) => selectedIds.includes(t.id))
            .sort((a, b) => a.name.localeCompare(b.name)),
    );

    let unselectedTemplateObjects = $derived(
        [...templates]
            .filter((t) => !selectedIds.includes(t.id))
            .sort((a, b) => a.name.localeCompare(b.name)),
    );

    let selectedFileCount = $derived.by(() => {
        let count = 0;

        for (const path of selectedFilePaths) {
            const meta = fileTypeMap.get(path);

            if (meta && meta.type === "file") {
                count++;
            }
        }

        return count;
    });

    // --- LOGIC ---

    let healthInterval: any;

    onMount(async () => {
        await detect();

        await loadFileTree();

        setTimeout(() => {
            isAppLoading = false;
        }, 100);

        // REMOVED: window.addEventListener('beforeunload', handleUnload);

        // Start Heartbeat (every 2 seconds)
        healthInterval = setInterval(async () => {
            if (isShuttingDown || connectionLost) return;

            try {
                // Timeout after 2s to prevent hanging requests
                const controller = new AbortController();
                const id = setTimeout(() => controller.abort(), 2000);

                // This call keeps the server process alive via src/lib/server/session.ts
                const res = await fetch("/api/health", {
                    signal: controller.signal,
                });
                clearTimeout(id);

                if (!res.ok) throw new Error("Server unreachable");
            } catch (e) {
                // Only trigger if we are NOT currently trying to exit/switch
                if (!isShuttingDown) {
                    connectionLost = true;
                }
            }
        }, 2000);
    });

    onDestroy(() => {
        if (healthInterval) clearInterval(healthInterval);
        if (healthInterval) clearInterval(healthInterval);
        // REMOVED: if (typeof window !== 'undefined') window.removeEventListener('beforeunload', handleUnload);
    });

    // REMOVED: function handleUnload() { ... }

    async function detect() {
        try {
            const res = await fetch("/api/detect");

            const data = await res.json();

            detectedIds = data.ids;

            detectionReasons = data.reasons || {};

            gitStatus = data.gitStatus;

            cwd = data.cwd;

            sessionId = data.sessionId;

            savedCustomPath = data.savedCustomPath;

            customPath = data.savedCustomPath;

            globalVaultPath = data.globalVaultPath;

            projectConfig = data.projectConfig;

            appVersion = data.appVersion; // <--- Add this line

            isDebug = data.isDebug;

            // NEW: Check for Version Reset
            if (data.configWasReset) {
                showVersionResetDialog = true;
            }

            // NEW: Check for Update
            if (data.shouldShowUpdate) {
                updateInfo = data.updateInfo;
                showUpdateDialog = true;
            }

            logUI("Debug mode active. Session:", sessionId);

            // Apply Config if exists
            if (projectConfig) {
                selectedIds = projectConfig.templateIds || [...detectedIds];
                // Note: Config stores 'hide', UI uses 'include' (inverted)
                if (projectConfig.hideIgnoredInTree !== undefined) {
                    includeIgnoredFiles = !projectConfig.hideIgnoredInTree;
                }
                // Load Max Chars
                if (projectConfig.maxChars) {
                    maxChars = projectConfig.maxChars;
                }
                // Load Split Setting
                if (projectConfig.disableSplitting !== undefined) {
                    disableSplitting = projectConfig.disableSplitting;
                }
            } else {
                selectedIds = [...detectedIds];
            }
        } catch (e) {
            console.error(e);

            dialogTitle = "Detection Failed";

            dialogMessage =
                "Could not scan directory. Please ensure the server is running correctly.";

            showErrorDialog = true;
        } finally {
            isDetecting = false;
        }
    }

    function areArraysEqual(a: string[], b: string[]) {
        if (a.length !== b.length) return false;

        const s = new Set(b);

        return a.every((x) => s.has(x));
    }

    function toggleTemplate(id: string) {
        if (selectedIds.includes(id)) {
            selectedIds = selectedIds.filter((i) => i !== id);
        } else {
            selectedIds = [...selectedIds, id];
        }

        // Update: Pass false to prevent loading screen flash

        loadFileTree(false);
    }

    // Applies Rules (Whitelist/Blacklist) to the Tree to determine what is checked
    function recalculateVisualSelection() {
        const newSet = new Set<string>();

        // Helper to check rule hierarchy
        const checkRule = (pathStr: string): "include" | "exclude" | null => {
            let current = pathStr;
            while (true) {
                if (selectionRules[current]) return selectionRules[current];
                if (current === "" || current === ".") break;
                const parent = current.substring(0, current.lastIndexOf("/"));
                if (parent === current) break; // Safety
                current = parent;
            }
            return null;
        };

        // Iterate ALL known nodes (we need a flat list or traverse treeNodes)
        // Since we have folderDescendants and fileTypeMap, we can iterate fileTypeMap keys
        for (const [pathStr, meta] of fileTypeMap.entries()) {
            const ruleState = checkRule(pathStr);

            if (ruleState === "include") {
                newSet.add(pathStr);
            } else if (ruleState === "exclude") {
                // Do not add
            } else {
                // No rule -> Default
                if (defaultIncludedPaths.has(pathStr)) {
                    newSet.add(pathStr);
                }
            }
        }

        selectedFilePaths = newSet;
    }

    function resetTreeSelection() {
        selectionRules = {};
        recalculateVisualSelection();
    }

    function toggleTemplatesSection() {
        const wasExpanded = templatesExpanded;

        templatesExpanded = !templatesExpanded;

        if (wasExpanded) {
            const targetIds = [...detectedIds];

            if (!areArraysEqual(selectedIds, targetIds)) {
                selectedIds = targetIds;

                // Update: Pass false to prevent loading screen flash

                loadFileTree(false);
            }
        }
    }

    async function scrollToTree() {
        treeExpanded = !treeExpanded;

        if (treeExpanded && treeCardElement) {
            await tick();

            treeCardElement.scrollIntoView({
                behavior: "smooth",
                block: "center",
            });
        }
    }

    async function exitApp() {
        isShuttingDown = true;

        // UPDATED: Reduced wait time to 1 second

        await new Promise((resolve) => setTimeout(resolve, 1000));

        // Send Shutdown Request

        if (sessionId) {
            // Fire and forget (don't await, so we close faster)

            fetch("/api/shutdown", {
                method: "POST",

                headers: { "Content-Type": "application/json" },

                body: JSON.stringify({ sessionId }),

                keepalive: true,
            }).catch(() => {});
        }

        // Close Window

        window.close();

        // Fallback: If window.close() is blocked by browser security,

        // we just stay on the "Terminating Session" loader which is already active.

        // We DO NOT replace the HTML body, preventing the "jumpscare".
    }

    async function handleAutoUpdate() {
        isUpdating = true;
        try {
            const res = await fetch("/api/update", { method: "POST" });
            const data = await res.json();

            if (data.success) {
                // Close update modal, show success modal
                showUpdateDialog = false;
                showUpdateSuccessDialog = true;
            } else {
                alert(
                    "Auto-update failed. Please run: npm install -g txt-forge",
                );
                showUpdateDialog = false;
            }
        } catch (e) {
            alert("Auto-update failed. Please run: npm install -g txt-forge");
        } finally {
            isUpdating = false;
        }
    }

    async function handleSkipUpdate() {
        if (!updateInfo) return;
        showUpdateDialog = false;
        await fetch("/api/skip-update", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ version: updateInfo.latest }),
        });
    }

    async function handleSwitchDirectory() {
        isProcessing = true;
        try {
            // 1. Pick Folder
            const res = await fetch("/api/select-folder", { method: "POST" });
            const data = await res.json();

            if (data.success && data.path) {
                // 2. Trigger Switch (Launches new CMD window in background)
                const switchRes = await fetch("/api/switch-dir", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ path: data.path }),
                });

                if (switchRes.ok) {
                    // 3. Close THIS session immediately.
                    // The new CMD window is waiting 3 seconds, then it will start.
                    // This prevents port conflicts and cleans up the UI.
                    await exitApp();
                } else {
                    alert("Failed to switch directory.");
                    isProcessing = false;
                }
            } else {
                isProcessing = false;
            }
        } catch (err) {
            console.error(err);
            alert("An error occurred.");
            isProcessing = false;
        }
    }

    // Update: Add showOverlay parameter with default 'true'

    async function loadFileTree(showOverlay: boolean = true) {
        if (showOverlay) treeLoading = true;

        try {
            const params = new URLSearchParams();

            if (selectedIds.length > 0)
                params.append("templates", selectedIds.join(","));

            const res = await fetch(`/api/tree?${params.toString()}`);

            const data = await res.json();

            treeNodes = data.tree;

            fileTypeMap.clear();

            folderDescendants.clear(); // Clear cache

            const initialSet = new Set<string>();

            // UPDATED: Added parentIgnored parameter to handle nested ignored folders (e.g. node_modules contents)

            const processNode = (
                nodes: any[],
                parentIgnored: boolean = false,
            ) => {
                const currentLevelPaths: string[] = [];

                for (const node of nodes) {
                    // A node is effectively ignored if it is marked ignored OR its parent is ignored

                    const isEffectivelyIgnored =
                        node.isIgnored || parentIgnored;

                    // UPDATED: Store isEffectivelyIgnored instead of node.isIgnored.

                    // This ensures children of ignored folders are treated as ignored by bulk actions.

                    fileTypeMap.set(node.path, {
                        type: node.type,

                        isMedia: node.isMedia,

                        isIgnored: isEffectivelyIgnored,
                    });

                    // FIX: Only add to the selectable paths list if it is a folder OR a non-media file.

                    if (node.type === "folder" || !node.isMedia) {
                        currentLevelPaths.push(node.path);
                    }

                    // Logic for initial selection: Only add if NOT effectively ignored

                    // We verify it is not media before adding it to the initial selection

                    if (!isEffectivelyIgnored && !node.isMedia) {
                        initialSet.add(node.path);
                    }

                    if (node.type === "folder" && node.children) {
                        // Recursively get all children paths, PASSING DOWN the ignored state

                        const childrenPaths = processNode(
                            node.children,
                            isEffectivelyIgnored,
                        );

                        // FILTER: Map descendants that are VALID text files (including ignored ones).
                        // We exclude Media because they are never text-processable, but we KEEP Ignored files
                        // so the user can force-select them via the UI.
                        const mappableDescendants = childrenPaths.filter(
                            (path) => {
                                const meta = fileTypeMap.get(path);
                                return (
                                    meta &&
                                    meta.type === "file" &&
                                    !meta.isMedia
                                );
                            },
                        );

                        // Map this folder path to ALL its text descendants
                        folderDescendants.set(node.path, mappableDescendants);

                        // Add children to current level for the parent's map (we pass everything up, filtering happens at the map set)

                        currentLevelPaths.push(...childrenPaths);
                    }
                }

                return currentLevelPaths;
            };

            // Start recursion assuming root is not ignored

            processNode(treeNodes, false);

            // Set baseline (what the templates/gitignore say should be included)

            defaultIncludedPaths = new Set(initialSet);

            // Load Rules from Config

            if (projectConfig && projectConfig.selectionRules) {
                selectionRules = { ...projectConfig.selectionRules };
            } else {
                selectionRules = {};
            }

            // Apply Rules to Generate Visual Selection

            recalculateVisualSelection();
        } catch (e) {
            dialogTitle = "Tree Scan Failed";

            dialogMessage = "Could not load file structure.";

            showErrorDialog = true;
        } finally {
            // Update: Only turn off if we turned it on

            if (showOverlay) treeLoading = false;
        }
    }

    function handleTreeToggle(pathStr: string, isFolder: boolean) {
        const newRules = { ...selectionRules };

        if (!isFolder) {
            // Simple File Toggle
            const currentlySelected = selectedFilePaths.has(pathStr);
            newRules[pathStr] = currentlySelected ? "exclude" : "include";
        } else {
            const descendants = folderDescendants.get(pathStr) || [];
            
            // SPECIAL CASE: Massive Folder (Unloaded)
            // If the map has no descendants, but it is a folder, check if it's the Massive case.
            // We rely on the fact that if it has no descendants mapped, we treat it as a simple binary toggle.
            if (descendants.length === 0) {
                 // Check if the folder ITSELF is selected in our set
                 const isCurrentlySelected = selectedFilePaths.has(pathStr);
                 // Simple Toggle: If selected -> Exclude. If not -> Include.
                 newRules[pathStr] = isCurrentlySelected ? "exclude" : "include";
                 
                 selectionRules = newRules;
                 recalculateVisualSelection();
                 return;
            }

            // FOLDER LOGIC: 3-State Cycle (Smart -> Force -> Clear)
            
            // 1. Analyze Current State
            let countSelected = 0;
            let countIgnoredButSelected = 0;
            let countIgnoredTotal = 0;
            let countStandardTotal = 0;

            descendants.forEach((child) => {
                const meta = fileTypeMap.get(child);
                const isSel = selectedFilePaths.has(child);

                if (meta?.isIgnored) {
                    countIgnoredTotal++;
                    if (isSel) countIgnoredButSelected++;
                } else {
                    countStandardTotal++;
                    if (isSel) countSelected++;
                }
            });

            // Determine Action
            let action: "smart" | "force" | "clear";

            const isFullSelection =
                countSelected === countStandardTotal &&
                countIgnoredButSelected === countIgnoredTotal &&
                descendants.length > 0;
            const isSmartSelection =
                countSelected === countStandardTotal &&
                countIgnoredButSelected < countIgnoredTotal &&
                countStandardTotal > 0;
            const isEmpty =
                countSelected === 0 && countIgnoredButSelected === 0;

            if (isEmpty) {
                // If empty, go to Smart. If no standard files exist (only ignored), go straight to Force.
                action = countStandardTotal > 0 ? "smart" : "force";
            } else if (isSmartSelection) {
                // If smart selected, go to Force (select the ignored ones too)
                action = "force";
            } else if (isFullSelection) {
                // If fully selected, clear all
                action = "clear";
            } else {
                // If mixed/indeterminate, reset to Smart (or Force if only ignored exist)
                action = countStandardTotal > 0 ? "smart" : "force";
            }

            // Apply Rules
            // We explicitly set the rule for the folder and all descendants
            newRules[pathStr] = action === "clear" ? "exclude" : "include";

            descendants.forEach((child) => {
                const meta = fileTypeMap.get(child);
                if (action === "clear") {
                    newRules[child] = "exclude";
                } else if (action === "smart") {
                    // Select only if NOT ignored
                    newRules[child] = meta?.isIgnored ? "exclude" : "include";
                } else if (action === "force") {
                    // Select EVERYTHING
                    newRules[child] = "include";
                }
            });
        }

        selectionRules = newRules;
        recalculateVisualSelection();
    }

    // --- BULK ACTIONS ---

    function handleSelectAll() {
        // Cycle: Smart Select All -> Force Select All (incl ignored)

        // Check current state to decide
        let allStandardSelected = true;
        let allIgnoredSelected = true;

        for (const [pathStr, meta] of fileTypeMap.entries()) {
            if (meta.type === "file" && !meta.isMedia) {
                const isSel = selectedFilePaths.has(pathStr);
                if (!meta.isIgnored && !isSel) allStandardSelected = false;
                if (meta.isIgnored && !isSel) allIgnoredSelected = false;
            }
        }

        const newRules: Record<string, "include" | "exclude"> = {};

        // If standard files are selected but ignored ones aren't, DO FORCE SELECT
        const targetMode =
            allStandardSelected && !allIgnoredSelected ? "force" : "smart";

        for (const [pathStr, meta] of fileTypeMap.entries()) {
            if (!meta.isMedia) {
                if (targetMode === "smart") {
                    // Select everything except ignored
                    newRules[pathStr] = meta.isIgnored ? "exclude" : "include";
                } else {
                    // Select everything PERIOD
                    newRules[pathStr] = "include";
                }
            }
        }

        selectionRules = newRules;
        recalculateVisualSelection();
    }

    function handleDeselectAll() {
        // Strategy: Explicitly EXCLUDE everything eligible.

        // CRITICAL FIX: We must exclude FOLDERS too. If we only exclude files,

        // folders fall back to their Default State (Included), making them appear checked

        // even if they are empty or contain only media.

        const newRules: Record<string, "include" | "exclude"> = {};

        for (const [pathStr, meta] of fileTypeMap.entries()) {
            // Filter: Don't touch Media or Ignored items (they are already excluded by default logic)

            // But DO touch Folders and Files that are eligible.

            if (!meta.isMedia && !meta.isIgnored) {
                newRules[pathStr] = "exclude";
            }
        }

        selectionRules = newRules;

        recalculateVisualSelection();
    }

    function handleInvert() {
        // Strategy: Iterate everything eligible and flip state.

        // CRITICAL FIX: Include FOLDERS in the inversion to ensure consistent visual state.

        const newRules: Record<string, "include" | "exclude"> = {};

        for (const [pathStr, meta] of fileTypeMap.entries()) {
            // Filter: Eligible items only

            if (!meta.isMedia && !meta.isIgnored) {
                // Check visual state (Source of truth for "current" state)

                const isCurrentlySelected = selectedFilePaths.has(pathStr);

                newRules[pathStr] = isCurrentlySelected ? "exclude" : "include";
            }
        }

        selectionRules = newRules;

        recalculateVisualSelection();
    }

    // NEW: Handle Lazy Load

    async function handleLoadChildren(folderPath: string) {
        try {
            const params = new URLSearchParams();

            params.append("path", folderPath);

            if (selectedIds.length > 0)
                params.append("templates", selectedIds.join(","));

            const res = await fetch(`/api/tree?${params.toString()}`);

            const data = await res.json();

            if (data.tree && data.tree.length > 0) {
                // We need to insert these children into the existing treeNodes structure

                // Helper to find and update

                const updateNode = (nodes: any[]) => {
                    for (const node of nodes) {
                        if (node.path === folderPath) {
                            node.children = data.tree;

                            // --- FIX: Mark as no longer massive so it behaves like a normal open folder ---

                            node.isMassive = false;

                            // ---------------------------------------------------------------------------

                            return true;
                        }

                        if (node.children && node.children.length > 0) {
                            if (updateNode(node.children)) return true;
                        }
                    }

                    return false;
                };

                updateNode(treeNodes);

                // Re-run caching for new nodes

                // We only need to process the NEW subtree

                const processNode = (nodes: any[], parentIgnored: boolean) => {
                    const paths: string[] = [];

                    for (const node of nodes) {
                        const isEffectivelyIgnored =
                            node.isIgnored || parentIgnored;

                        // UPDATED: Store isEffectivelyIgnored

                        fileTypeMap.set(node.path, {
                            type: node.type,

                            isMedia: node.isMedia,

                            isIgnored: isEffectivelyIgnored,
                        });

                        // FIX: Filter out media from bulk operations in lazy loaded trees too

                        if (node.type === "folder" || !node.isMedia) {
                            paths.push(node.path);
                        }

                        // Do NOT auto-select Massive children (user just expanded it, doesn't mean select)

                        // Unless the parent was ALREADY selected?

                        // Logic: If parent (folderPath) is in selectedFilePaths, we should add these?

                        if (
                            selectedFilePaths.has(folderPath) &&
                            !isEffectivelyIgnored &&
                            !node.isMedia
                        ) {
                            selectedFilePaths.add(node.path);

                            // Force reactivity

                            selectedFilePaths = new Set(selectedFilePaths);
                        }

                        // 2. NEW: Update Default Baseline (Sync with parent's default state)

                        if (
                            defaultIncludedPaths.has(folderPath) &&
                            !isEffectivelyIgnored &&
                            !node.isMedia
                        ) {
                            defaultIncludedPaths.add(node.path);

                            defaultIncludedPaths = new Set(
                                defaultIncludedPaths,
                            ); // Reactivity
                        }

                        if (node.type === "folder" && node.children) {
                            const kids = processNode(
                                node.children,
                                isEffectivelyIgnored,
                            );

                            // FILTER for Lazy Load too
                            const mappableDescendants = kids.filter((path) => {
                                const meta = fileTypeMap.get(path);
                                return (
                                    meta &&
                                    meta.type === "file" &&
                                    !meta.isMedia
                                );
                            });

                            folderDescendants.set(
                                node.path,
                                mappableDescendants,
                            );

                            paths.push(...kids);
                        }
                    }

                    return paths;
                };

                // We need parent ignored state.

                // Approximate: Assume false for lazy loaded massive folders (simplification)

                const newPaths = processNode(data.tree, false);

                // Update the parent's descendant cache in the Map

                folderDescendants.set(folderPath, newPaths);

                // Trigger Svelte reactivity

                treeNodes = [...treeNodes];
            }
        } catch (e) {
            console.error("Failed to load subtree", e);
        }
    }

    async function handleCustomClick(e: MouseEvent) {
        if (e.shiftKey && savedCustomPath) {
            customPath = savedCustomPath;

            runForge("custom");

            return;
        }

        isProcessing = true;

        try {
            const res = await fetch("/api/select-folder", { method: "POST" });

            const data = await res.json();

            if (data.success && data.path) {
                customPath = data.path;

                savedCustomPath = data.path;

                await runForge("custom");
            }
        } catch (err) {
            console.error(err);
        } finally {
            isProcessing = false;
        }
    }

    async function saveCurrentConfig() {
        const config = {
            templateIds: selectedIds,

            selectionRules: selectionRules,

            hideIgnoredInTree: !includeIgnoredFiles,

            maxChars: maxChars,

            disableSplitting: disableSplitting,
        };

        try {
            await fetch("/api/save-config", {
                method: "POST",

                headers: { "Content-Type": "application/json" },

                body: JSON.stringify({ path: cwd, config }),
            });

            // FIX: Removed await tick(). In Svelte 5, updating state immediately

            // after an async op is standard. The derived/function conflict is solved

            // by using a helper function instead of $derived.

            projectConfig = config;

            return true;
        } catch (e) {
            console.error("Failed to save config");

            return false;
        }
    }

    async function runForge(mode: "root" | "global" | "custom" | "clipboard") {
        logUI("runForge initiated", mode);

        isProcessing = true;

        // We no longer send the huge file list. We send the rules.
        try {
            logUI("Sending fetch request to /api/forge");

            const res = await fetch("/api/forge", {
                method: "POST",

                headers: { "Content-Type": "application/json" },

                body: JSON.stringify({
                    saveMode: mode,

                    customPath,

                    templateIds: selectedIds,

                    maxChars,

                    selectionRules: selectionRules,

                    // UPDATED: Invert logic for backend.
                    // If "Include" is TRUE, then "Hide" is FALSE.
                    hideIgnoredInTree: !includeIgnoredFiles,

                    disableSplitting,
                }),
            });

            logUI("Fetch complete, parsing JSON...");

            const result = await res.json();

            logUI("Result received", result);

            if (result.success) {
                logUI("Backend Success. Stopping processing loader...");

                // 1. Stop loader

                isProcessing = false;

                if (mode === "clipboard" && result.clipboardText) {
                    try {
                        await navigator.clipboard.writeText(result.clipboardText);
                        successOutputPath = "Clipboard";
                        showSuccessDialog = true;
                    } catch (err) {
                        dialogTitle = "Clipboard Error";
                        dialogMessage = "Failed to copy to clipboard. Make sure you are in a secure context.";
                        showErrorDialog = true;
                    }
                    return; // Skip normal file UI flow
                }

                // 2. Wait for loader transition to effectively start clearing

                await tick();

                // 3. Use a slightly longer timeout to ensure we are in a new frame

                // and previous transitions have registered.

                setTimeout(() => {
                    try {
                        logUI("TIMEOUT: Setting successOutputPath...");

                        successOutputPath = result.outputPath;

                        logUI("TIMEOUT: Setting showSuccessDialog to TRUE...");

                        // This is the line that likely crashes if state is unstable

                        showSuccessDialog = true;

                        logUI("TIMEOUT: State updates complete.");
                    } catch (err) {
                        console.error("CRASH INSIDE TIMEOUT:", err);

                        logUI("CRASH INSIDE TIMEOUT", err);
                    }
                }, 50); // Increased to 50ms to ensure frame separation

                logUI("Triggering /api/open...");

                // Fire and forget the open request so it doesn't block UI

                fetch("/api/open", {
                    method: "POST",

                    body: JSON.stringify({ path: result.outputPath }),
                }).catch((e) => logUI("Open API failed", e));
            } else {
                logUI("Backend returned failure", result.message);

                dialogTitle = "Forging Failed";

                dialogMessage = result.message;

                showErrorDialog = true;
            }
        } catch (e) {
            console.error(e); // Always log real errors

            logUI("Exception caught", e);

            dialogTitle = "Connection Error";

            dialogMessage = "Failed to communicate with server.";

            showErrorDialog = true;
        } finally {
            // Only set false if it wasn't already handled in success block

            // (Though setting it again is harmless)

            if (isProcessing) isProcessing = false;

            logUI("runForge sequence finished");
        }
    }
</script>

<div
    class="min-h-screen flex flex-col items-center p-8 relative overflow-hidden font-sans"
>
    <!-- BACKGROUND BLOBS -->

    <div
        class="absolute top-0 left-0 w-full h-full overflow-hidden pointer-events-none z-0"
    >
        <!-- UPDATED: Increased opacity for all blobs (/10 -> /20 and /20 -> /30) -->
        <div
            class="absolute top-[-20%] left-1/2 -translate-x-1/2 w-[800px] h-[600px] bg-orange-600/20 rounded-full blur-[120px] animate-blob mix-blend-screen"
        ></div>

        <div
            class="absolute top-[20%] left-[10%] w-[500px] h-[500px] bg-rose-700/20 rounded-full blur-[100px] animate-blob animation-delay-2000 mix-blend-screen"
        ></div>

        <div
            class="absolute bottom-[10%] right-[10%] w-[600px] h-[600px] bg-violet-900/30 rounded-full blur-[100px] animate-blob animation-delay-4000 mix-blend-screen"
        ></div>
    </div>

    <!-- LOADER -->

    {#if isAppLoading || isDetecting || isShuttingDown}
        <div
            class="fixed inset-0 z-[200] bg-[#020617] flex flex-col items-center justify-center"
            transition:fade
        >
            <!-- NEW: Ultimate Blackout Overlay for Shutdown -->
            {#if isShuttingDown}
                <div
                    class="absolute inset-0 bg-black z-[210] animate-[fadeIn_1.5s_ease-in_forwards] pointer-events-none"
                ></div>
            {/if}

            <div class="relative z-[205]">
                <div
                    class="w-32 h-32 bg-orange-500/10 rounded-full animate-ping absolute top-0 left-0"
                ></div>

                <div
                    class="w-32 h-32 bg-orange-600/20 rounded-full relative flex items-center justify-center border border-orange-500/30 shadow-[0_0_80px_rgba(249,115,22,0.4)]"
                >
                    <svg
                        class="w-12 h-12 text-orange-500 animate-spin duration-[3s] {isShuttingDown
                            ? 'direction-reverse'
                            : ''}"
                        fill="none"
                        viewBox="0 0 24 24"
                    >
                        <circle
                            class="opacity-20"
                            cx="12"
                            cy="12"
                            r="10"
                            stroke="currentColor"
                            stroke-width="2"
                        ></circle>

                        <path
                            class="opacity-90"
                            fill="currentColor"
                            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                        ></path>
                    </svg>
                </div>
            </div>

            <h2
                class="mt-10 text-xl font-black text-orange-500 tracking-[0.3em] uppercase animate-pulse-slow"
            >
                {#if isShuttingDown}
                    Terminating Session...
                {:else}
                    Initializing Forge...
                {/if}
            </h2>
        </div>
    {/if}

    <!-- OPERATION LOADER -->

    {#if (treeLoading || isProcessing) && !isAppLoading && !isDetecting && !isShuttingDown}
        <!-- CHANGED: Added transition:fade with 250ms duration, removed CSS transition classes -->

        <div
            class="fixed inset-0 z-[150] bg-[#020617]/80 backdrop-blur-sm flex flex-col items-center justify-center"
            transition:fade={{ duration: 250 }}
        >
            <div
                class="w-24 h-24 bg-black/50 rounded-full relative flex items-center justify-center border border-white/10 shadow-2xl"
            >
                <svg
                    class="w-10 h-10 text-orange-400 animate-spin duration-[2s]"
                    fill="none"
                    viewBox="0 0 24 24"
                >
                    <circle
                        class="opacity-20"
                        cx="12"
                        cy="12"
                        r="10"
                        stroke="currentColor"
                        stroke-width="2"
                    ></circle>

                    <path
                        class="opacity-90"
                        fill="currentColor"
                        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    ></path>
                </svg>
            </div>

            <h2
                class="mt-6 text-sm font-bold text-slate-300 tracking-[0.2em] uppercase animate-pulse"
            >
                {treeLoading
                    ? "Calibrating File Singularity..."
                    : "Compressing Matter..."}
            </h2>
        </div>
    {/if}

    <!-- CONNECTION LOST DIALOG -->
    {#if connectionLost && !isShuttingDown}
        <div
            class="fixed inset-0 z-[300] flex items-center justify-center bg-black/95 backdrop-blur-md"
            transition:fade
        >
            <div
                class="bg-slate-950 border border-red-900/50 rounded-3xl p-10 w-full max-w-md shadow-[0_0_50px_rgba(220,38,38,0.2)] relative flex flex-col items-center text-center animate-pulse-slow"
            >
                <div
                    class="w-20 h-20 bg-red-900/20 rounded-full flex items-center justify-center mb-6 border border-red-500/20"
                >
                    <svg
                        class="w-10 h-10 text-red-500"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                        ><path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            stroke-width="2"
                            d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                        ></path></svg
                    >
                </div>
                <h3 class="text-2xl font-black text-white mb-3 tracking-tight">
                    Connection Lost
                </h3>
                <p class="text-slate-400 mb-8 leading-relaxed text-sm">
                    The TXT-Forge background process has stopped or was closed.
                    <br /><br />
                    Please return to your terminal, restart
                    <code class="text-red-400">txt-forge</code>, and refresh
                    this page.
                </p>
                <button
                    onclick={() => window.location.reload()}
                    class="w-full py-3 bg-slate-800 hover:bg-slate-700 border border-slate-700 text-white font-bold rounded-xl transition-all"
                >
                    Refresh Page
                </button>
            </div>
        </div>
    {/if}

    <!-- SUCCESS DIALOG -->

    {#if showSuccessDialog && !isShuttingDown}
        <div
            class="fixed inset-0 z-[100] flex items-center justify-center bg-black/90 backdrop-blur-md"
            transition:fade
        >
            <div
                class="bg-[#0a0a0a] border border-emerald-500/30 rounded-3xl p-10 w-full max-w-lg shadow-[0_0_50px_rgba(16,185,129,0.15)] relative flex flex-col items-center text-center animate-fade-in-up"
            >
                <div
                    class="w-24 h-24 bg-emerald-900/20 rounded-full flex items-center justify-center mb-8 shadow-[0_0_30px_rgba(16,185,129,0.1)] border border-emerald-500/20"
                >
                    <svg
                        class="w-12 h-12 text-emerald-400"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                        ><path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            stroke-width="2"
                            d="M5 13l4 4L19 7"
                        ></path></svg
                    >
                </div>

                <h3 class="text-3xl font-black text-white mb-3 tracking-tight">
                    Forge Complete
                </h3>

                <p class="text-slate-400 mb-8 leading-relaxed">
                    Your files have been successfully merged and saved to:<br />

                    <span
                        class="text-emerald-400/90 font-mono text-xs bg-emerald-950/30 px-3 py-1.5 rounded mt-3 inline-block border border-emerald-500/20 tracking-wide"
                        >{successOutputPath}</span
                    >
                </p>

                <div class="flex flex-col gap-4 w-full">
                    <!-- SAVE CONFIG OPTION -->

                    <div class="flex items-center justify-center gap-2 mb-2">
                        <button
                            disabled={!getIsConfigDirty()}
                            onclick={async (e) => {
                                if (!getIsConfigDirty()) return;

                                await saveCurrentConfig();
                            }}
                            class="text-[10px] font-bold uppercase tracking-wider py-2 px-4 rounded-lg border transition-all

                            {!getIsConfigDirty()
                                ? 'bg-emerald-900/20 border-emerald-500/30 text-slate-400 cursor-default'
                                : 'border-slate-800 bg-slate-900/50 text-slate-400 hover:text-white hover:bg-slate-800 hover:border-slate-600 cursor-pointer'}"
                        >
                            {#if !getIsConfigDirty()}
                                <span class="text-emerald-400"
                                    >✓ Configuration Saved</span
                                >
                            {:else}
                                Save Project Configuration
                            {/if}
                        </button>
                    </div>

                    <button
                        onclick={exitApp}
                        class="w-full py-4 bg-slate-800 hover:bg-slate-700 border border-slate-700 hover:border-orange-500/50 text-orange-100 hover:text-white font-bold rounded-xl shadow-lg transition-all flex items-center justify-center gap-3 group"
                    >
                        <span
                            class="text-orange-500 group-hover:scale-125 transition-transform duration-300"
                            >⦿</span
                        >

                        <span>Conclude Session</span>
                    </button>

                    <button
                        onclick={() => (showSuccessDialog = false)}
                        class="w-full py-3 text-slate-500 hover:text-slate-300 text-sm font-medium transition-colors"
                    >
                        Continue Forging
                    </button>
                </div>
            </div>
        </div>
    {/if}

    <!-- ERROR DIALOG -->

    {#if showErrorDialog && !isShuttingDown}
        <div
            class="fixed inset-0 z-[100] flex items-center justify-center bg-black/90 backdrop-blur-sm"
            transition:fade
        >
            <div
                class="bg-slate-950 border border-red-900/50 rounded-3xl p-8 w-full max-w-md shadow-2xl shadow-red-900/20 relative flex flex-col items-center text-center"
            >
                <div
                    class="w-16 h-16 bg-red-500/10 rounded-full flex items-center justify-center mb-5 border border-red-500/20"
                >
                    <span class="text-3xl text-red-500">⚠</span>
                </div>

                <h3 class="text-2xl font-bold text-white mb-2">
                    {dialogTitle}
                </h3>

                <p class="text-slate-400 mb-8 text-sm">{dialogMessage}</p>

                <button
                    onclick={() => (showErrorDialog = false)}
                    class="w-full py-3 bg-red-900/30 hover:bg-red-900/50 border border-red-500/30 text-red-200 font-bold rounded-xl transition-colors"
                >
                    Close
                </button>
            </div>
        </div>
    {/if}

    <!-- UPDATE DIALOG -->
    {#if showUpdateDialog && !isShuttingDown && !showVersionResetDialog}
        <div
            class="fixed inset-0 z-[110] flex items-center justify-center bg-black/90 backdrop-blur-sm"
            transition:fade
        >
            <div
                class="bg-slate-950 border border-indigo-500/30 rounded-3xl p-8 w-full max-w-md shadow-[0_0_50px_rgba(99,102,241,0.15)] relative flex flex-col items-center text-center animate-fade-in-up"
            >
                <div
                    class="w-16 h-16 bg-indigo-900/20 rounded-full flex items-center justify-center mb-5 border border-indigo-500/20"
                >
                    <span class="text-3xl animate-bounce">🚀</span>
                </div>
                <h3 class="text-2xl font-bold text-white mb-2">
                    Update Available
                </h3>
                <p class="text-slate-400 mb-6 text-sm">
                    A new version of TXT-Forge is available!
                    <br />
                    <span
                        class="font-mono text-indigo-400 bg-indigo-950/30 px-2 py-0.5 rounded mt-2 inline-block border border-indigo-500/20"
                        >v{updateInfo?.latest}</span
                    >
                </p>

                <div class="flex flex-col gap-3 w-full">
                    <button
                        onclick={handleAutoUpdate}
                        disabled={isUpdating}
                        class="w-full py-3 bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded-xl transition-all shadow-lg shadow-indigo-900/20 flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {#if isUpdating}
                            <svg
                                class="animate-spin h-4 w-4 text-white"
                                xmlns="http://www.w3.org/2000/svg"
                                fill="none"
                                viewBox="0 0 24 24"
                                ><circle
                                    class="opacity-25"
                                    cx="12"
                                    cy="12"
                                    r="10"
                                    stroke="currentColor"
                                    stroke-width="4"
                                ></circle><path
                                    class="opacity-75"
                                    fill="currentColor"
                                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                                ></path></svg
                            >
                            Installing...
                        {:else}
                            Update Automatically
                        {/if}
                    </button>

                    <div class="relative flex py-2 items-center">
                        <div class="flex-grow border-t border-slate-800"></div>
                        <span
                            class="flex-shrink-0 mx-4 text-slate-600 text-[10px] uppercase font-bold"
                            >OR</span
                        >
                        <div class="flex-grow border-t border-slate-800"></div>
                    </div>

                    <code
                        class="text-[10px] bg-black p-3 rounded border border-slate-800 text-slate-500 font-mono select-all"
                        >npm install -g txt-forge</code
                    >

                    <div class="flex gap-3 mt-2">
                        <button
                            onclick={() => (showUpdateDialog = false)}
                            class="flex-1 py-2 bg-slate-900 hover:bg-slate-800 text-slate-400 text-xs font-bold rounded-lg transition-colors"
                        >
                            Remind Me Later
                        </button>
                        <button
                            onclick={handleSkipUpdate}
                            class="flex-1 py-2 bg-transparent hover:bg-slate-900 text-slate-500 hover:text-slate-300 text-xs font-bold rounded-lg transition-colors"
                        >
                            Skip v{updateInfo?.latest}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    {/if}

    <!-- UPDATE SUCCESS DIALOG -->
    {#if showUpdateSuccessDialog}
        <div
            class="fixed inset-0 z-[120] flex items-center justify-center bg-black/90 backdrop-blur-md"
            transition:fade
        >
            <div
                class="bg-[#0a0a0a] border border-indigo-500/30 rounded-3xl p-10 w-full max-w-md shadow-[0_0_50px_rgba(99,102,241,0.2)] relative flex flex-col items-center text-center animate-fade-in-up"
            >
                <div
                    class="w-24 h-24 bg-indigo-900/20 rounded-full flex items-center justify-center mb-6 shadow-[0_0_30px_rgba(99,102,241,0.15)] border border-indigo-500/20"
                >
                    <span class="text-4xl">🎉</span>
                </div>
                <h3 class="text-2xl font-black text-white mb-3 tracking-tight">
                    Update Complete
                </h3>
                <p class="text-slate-400 mb-8 leading-relaxed text-sm">
                    TXT-Forge has been updated to <span
                        class="text-indigo-400 font-mono"
                        >v{updateInfo?.latest}</span
                    >.
                    <br /><br />
                    This tab will now close. Please run the command again in your
                    terminal to use the new version.
                </p>
                <button
                    onclick={exitApp}
                    class="w-full py-3 bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded-xl shadow-lg transition-all flex items-center justify-center gap-2 hover:scale-[1.02]"
                >
                    <svg
                        class="w-5 h-5"
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                        ><path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            stroke-width="2"
                            d="M6 18L18 6M6 6l12 12"
                        ></path></svg
                    >
                    <span>Close Session</span>
                </button>
            </div>
        </div>
    {/if}

    <!-- VERSION RESET DIALOG -->

    {#if showVersionResetDialog && !isShuttingDown}
        <div
            class="fixed inset-0 z-[100] flex items-center justify-center bg-black/90 backdrop-blur-sm"
            transition:fade
        >
            <div
                class="bg-slate-950 border border-amber-500/30 rounded-3xl p-8 w-full max-w-md shadow-[0_0_50px_rgba(245,158,11,0.15)] relative flex flex-col items-center text-center animate-fade-in-up"
            >
                <div
                    class="w-16 h-16 bg-amber-900/20 rounded-full flex items-center justify-center mb-5 border border-amber-500/20"
                >
                    <span class="text-3xl text-amber-500">⚡</span>
                </div>

                <h3 class="text-2xl font-bold text-white mb-2">
                    Project Config Reset
                </h3>

                <p class="text-slate-400 mb-8 text-sm leading-relaxed">
                    TXT-Forge has been updated. To ensure compatibility, your
                    previous project configuration has been reset to defaults.

                    <br /><br />

                    <span class="text-amber-500/80 text-xs"
                        >Please re-select your preferences and save a new
                        configuration after your next export.</span
                    >
                </p>

                <button
                    onclick={() => (showVersionResetDialog = false)}
                    class="w-full py-3 bg-amber-900/20 hover:bg-amber-900/40 border border-amber-500/30 text-amber-200 font-bold rounded-xl transition-colors"
                >
                    Acknowledge & Continue
                </button>
            </div>
        </div>
    {/if}

    <!-- Header -->

    <div class="text-center mb-12 mt-8 animate-fade-in-up relative z-10">
        <h1
            class="text-8xl font-black tracking-tighter mb-6 drop-shadow-[0_0_40px_rgba(249,115,22,0.3)]"
        >
            <span
                class="bg-gradient-to-r from-orange-400 via-rose-500 to-violet-500 bg-clip-text text-transparent animate-text-gradient bg-[length:200%_auto]"
            >
                TXT-FORGE
            </span>
        </h1>

        <!-- UPDATED: Removed 'inline-flex', 'truncate', and 'max-w' constraints. Added 'break-all' -->
        <div
            class="flex flex-col md:flex-row items-center justify-center gap-4 bg-black/40 backdrop-blur-md pl-6 pr-2 py-2 rounded-2xl border border-white/5 shadow-lg max-w-[90vw]"
        >
            <span
                class="text-slate-500 text-[10px] uppercase font-bold tracking-[0.2em] whitespace-nowrap"
                >Target:</span
            >

            <span
                class="text-orange-300 font-mono text-xs break-all text-center drop-shadow-md leading-relaxed"
            >
                {cwd || "Scanning..."}
            </span>

            <!-- Rectangular Browse Button -->
            <button
                onclick={handleSwitchDirectory}
                disabled={isProcessing}
                class="px-4 py-1 bg-white/5 hover:bg-orange-500/10 border border-white/10 hover:border-orange-500/30 text-[10px] font-bold uppercase tracking-wider text-slate-400 hover:text-orange-300 rounded flex items-center gap-2 h-8 transition-all"
                title="Switch Folder"
            >
                <span>Browse</span>
                <svg
                    class="w-3 h-3"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    ><path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width="2"
                        d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
                    ></path></svg
                >
            </button>
        </div>
    </div>

    <!-- Main Grid -->

    <!-- UPDATED: Added 'relative z-20' to ensure this entire section (and its tooltips)
         sits ABOVE the Header (which is z-10). -->
    <div
        class="w-full max-w-6xl grid grid-cols-1 lg:grid-cols-3 gap-8 relative z-20"
    >
        <!-- LEFT COLUMN: Configuration -->

        <div
            class="lg:col-span-2 flex flex-col gap-6 animate-fade-in-up"
            style="animation-delay: 0.1s;"
        >
            <!-- TEMPLATES CARD -->

            <!-- UPDATED: Removed 'overflow-hidden' so tooltips can popup outside the box.
                 Added 'z-20' to ensure it sits above other elements when tooltips open. -->
            <div
                class="bg-slate-900/40 backdrop-blur-xl border border-white/10 rounded-3xl p-8 shadow-2xl relative z-20"
            >
                <div
                    class="absolute top-0 left-0 w-full h-[1px] bg-gradient-to-r from-transparent via-orange-500/20 to-transparent"
                ></div>

                <div class="flex justify-between items-center mb-6">
                    <div class="flex items-center gap-3">
                        <h2
                            class="text-xs font-bold text-slate-300 uppercase tracking-[0.2em] flex items-center gap-2"
                        >
                            {#if isDetecting}
                                <span
                                    class="w-2 h-2 bg-orange-500 rounded-full animate-ping"
                                ></span> Detecting...
                            {:else if templatesExpanded}
                                <span
                                    class="w-2 h-2 bg-amber-500 rounded-full shadow-[0_0_10px_#f59e0b]"
                                ></span>

                                Manual Selection
                            {:else}
                                <span
                                    class="w-2 h-2 bg-emerald-500 rounded-full shadow-[0_0_10px_#10b981]"
                                ></span>

                                Auto-Detected Stack
                            {/if}
                        </h2>
                    </div>

                    <button
                        onclick={toggleTemplatesSection}
                        class="px-3 py-1 rounded-full border border-white/10 bg-white/5 hover:bg-white/10 text-[10px] uppercase font-bold tracking-wider text-orange-400/80 hover:text-orange-300 transition-all hover:shadow-[0_0_10px_rgba(251,146,60,0.2)] hover:border-orange-500/30"
                    >
                        {templatesExpanded ? "Reset to Auto" : "Edit Templates"}
                    </button>
                </div>

                {#if selectedIds.length > 0}
                    <div class="grid grid-cols-2 md:grid-cols-3 gap-4 mb-6">
                        {#each selectedTemplateObjects as tmpl}
                            <div class="group relative">
                                <button
                                    onclick={() => toggleTemplate(tmpl.id)}
                                    class="w-full relative flex items-center gap-4 bg-white/5 hover:bg-orange-500/10 border border-white/5 hover:border-orange-500/30 text-slate-200 px-5 py-4 rounded-2xl transition-all duration-300 hover:shadow-[0_0_20px_rgba(249,115,22,0.1)] hover:-translate-y-0.5"
                                >
                                    <img
                                        src={tmpl.iconUrl}
                                        alt={tmpl.name}
                                        class="w-6 h-6 brightness-0 invert opacity-60 group-hover:opacity-100 transition-all"
                                    />

                                    <span
                                        class="font-bold text-sm tracking-wide group-hover:text-orange-100"
                                        >{tmpl.name}</span
                                    >

                                    <span
                                        class="absolute top-3 right-3 w-1.5 h-1.5 bg-orange-500 rounded-full shadow-[0_0_8px_#f97316]"
                                    ></span>
                                </button>

                                <!-- RESTORED TOOLTIP -->
                                {#if detectionReasons[tmpl.id]}
                                    <div
                                        class="absolute bottom-full left-1/2 -translate-x-1/2 mb-3 w-max max-w-[200px] bg-black/90 border border-white/10 p-3 rounded-xl shadow-2xl opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-50 backdrop-blur-md"
                                    >
                                        <div
                                            class="text-[10px] text-slate-400 font-mono"
                                        >
                                            <div
                                                class="text-orange-400 font-bold mb-1 border-b border-white/10 pb-1 uppercase tracking-wider"
                                            >
                                                Detected via:
                                            </div>

                                            <ul
                                                class="list-disc list-inside space-y-0.5"
                                            >
                                                {#each detectionReasons[tmpl.id] as reason}
                                                    <li
                                                        class="truncate text-slate-300"
                                                    >
                                                        {reason}
                                                    </li>
                                                {/each}
                                            </ul>
                                        </div>

                                        <!-- Arrow -->

                                        <div
                                            class="absolute top-full left-1/2 -translate-x-1/2 -mt-1 border-4 border-transparent border-t-black/90"
                                        ></div>
                                    </div>
                                {/if}
                            </div>
                        {/each}
                    </div>
                {:else}
                    <div
                        class="text-center py-12 text-slate-600 border border-dashed border-slate-800 rounded-2xl mb-6 bg-black/30"
                    >
                        <div class="text-3xl mb-2 opacity-50">🔍</div>

                        <p class="text-xs uppercase tracking-widest">
                            No templates detected.
                        </p>

                        <button
                            onclick={toggleTemplatesSection}
                            class="text-orange-400 text-xs mt-3 hover:text-orange-300 font-bold"
                            >Select manually</button
                        >
                    </div>
                {/if}

                {#if templatesExpanded}
                    <div
                        transition:slide
                        class="border-t border-white/5 pt-6 mt-2"
                    >
                        <h3
                            class="text-[10px] uppercase font-bold text-slate-500 mb-4 px-1 tracking-widest"
                        >
                            Add More Templates
                        </h3>

                        <div
                            class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2 max-h-[400px] overflow-y-auto pr-2 custom-scrollbar"
                        >
                            {#each unselectedTemplateObjects as tmpl}
                                <button
                                    onclick={() => toggleTemplate(tmpl.id)}
                                    class="flex items-center gap-3 px-3 py-3 rounded-lg text-xs text-left transition-all bg-slate-900/40 text-slate-400 border border-transparent hover:bg-slate-800 hover:text-orange-200 hover:border-orange-500/20 group"
                                >
                                    <img
                                        src={tmpl.iconUrl}
                                        alt=""
                                        class="w-4 h-4 opacity-30 group-hover:opacity-100 brightness-0 invert transition-all"
                                    />

                                    {tmpl.name}
                                </button>
                            {/each}
                        </div>
                    </div>
                {/if}
            </div>

            <!-- FILE TREE CARD -->

            <!-- UPDATED: Removed 'overflow-hidden' so tooltips are not cut off -->
            <!-- FIXED: Changed z-10 to z-30 so this card (and its tooltips) sits ABOVE the Templates card (z-20) -->
            <div
                class="bg-slate-900/40 backdrop-blur-xl border border-white/10 rounded-3xl p-8 shadow-2xl flex flex-col gap-4 animate-fade-in-up relative z-30"
                style="animation-delay: 0.15s;"
                bind:this={treeCardElement}
            >
                <div class="flex justify-between items-center relative z-10">
                    <div class="flex items-center gap-3">
                        <div
                            class="w-10 h-10 rounded-xl bg-orange-500/10 flex items-center justify-center border border-orange-500/20 text-orange-400 shadow-[0_0_15px_rgba(249,115,22,0.1)]"
                        >
                            🌳
                        </div>

                        <div>
                            <h2
                                class="text-xs font-bold text-slate-200 uppercase tracking-[0.2em]"
                            >
                                Source Tree
                            </h2>

                            <div class="text-[10px] text-slate-500 font-mono">
                                {treeExpanded
                                    ? `${selectedFileCount} files selected`
                                    : "Standard Filter Mode"}
                            </div>
                        </div>
                    </div>

                    <!-- Right Side Actions -->

                    <div class="flex items-center gap-3">
                        {#if isTreeModified}
                            <button
                                onclick={resetTreeSelection}
                                class="text-[10px] font-bold uppercase tracking-wider text-slate-500 hover:text-orange-400 transition-colors flex items-center gap-1 animate-fade-in-up"
                                title="Reset selection to auto-detected defaults"
                            >
                                <span class="text-lg leading-none">↺</span> Reset
                            </button>
                        {/if}

                        <button
                            onclick={scrollToTree}
                            class="px-4 py-2 rounded-lg text-[10px] font-bold uppercase tracking-wider transition-all border duration-300

                            {treeExpanded
                                ? 'bg-orange-900/20 text-orange-200 border-orange-500/30 shadow-[0_0_15px_rgba(249,115,22,0.2)]'
                                : 'bg-slate-900 text-slate-500 border-slate-800 hover:bg-slate-800 hover:text-white'}"
                        >
                            {treeExpanded ? "Close Tree" : "Open Tree Browser"}
                        </button>
                    </div>
                </div>

                {#if treeNodes.length > 0 || treeLoading}
                    <div
                        class="grid transition-[grid-template-rows] duration-500 ease-[cubic-bezier(0.16,1,0.3,1)] {treeExpanded
                            ? 'grid-rows-[1fr] border-t border-white/5 mt-2 pt-2'
                            : 'grid-rows-[0fr] mt-0 pt-0'}"
                    >
                        <div class="overflow-hidden">
                            <div
                                class="bg-black/40 rounded-xl border border-white/5 p-4 max-h-[500px] overflow-y-auto custom-scrollbar font-mono text-sm relative z-10 mt-2"
                            >
                                {#each treeNodes as node (node.path)}
                                    <FileTreeNode
                                        {node}
                                        selectedPaths={selectedFilePaths}
                                        {folderDescendants}
                                        onToggle={handleTreeToggle}
                                        onLoadChildren={handleLoadChildren}
                                    />
                                {/each}
                            </div>

                            <!-- BULK ACTIONS -->
                            <div
                                class="mt-3 grid grid-cols-3 gap-2 relative z-10"
                            >
                                <button
                                    onclick={handleSelectAll}
                                    class="py-2 bg-slate-800 hover:bg-emerald-900/30 border border-slate-700 hover:border-emerald-500/30 text-[10px] font-bold uppercase tracking-wider text-slate-400 hover:text-emerald-400 rounded-lg transition-all"
                                >
                                    Select All
                                </button>
                                <button
                                    onclick={handleDeselectAll}
                                    class="py-2 bg-slate-800 hover:bg-red-900/30 border border-slate-700 hover:border-red-500/30 text-[10px] font-bold uppercase tracking-wider text-slate-400 hover:text-red-400 rounded-lg transition-all"
                                >
                                    Deselect All
                                </button>
                                <button
                                    onclick={handleInvert}
                                    class="py-2 bg-slate-800 hover:bg-orange-900/30 border border-slate-700 hover:border-orange-500/30 text-[10px] font-bold uppercase tracking-wider text-slate-400 hover:text-orange-400 rounded-lg transition-all"
                                >
                                    Invert
                                </button>
                            </div>
                        </div>
                    </div>
                {/if}
            </div>
        </div>

        <!-- RIGHT COLUMN: Actions -->

        <div
            class="flex flex-col gap-6 animate-fade-in-up"
            style="animation-delay: 0.2s;"
        >
            <!-- INCLUDE IGNORED PANEL (Fixed Layout) -->

            <div
                class="bg-slate-900/40 backdrop-blur-xl border border-white/10 rounded-3xl p-6 shadow-2xl flex items-center justify-between relative z-40"
            >
                <!-- Label Section -->

                <div class="flex flex-col cursor-help group/info relative">
                    <div class="flex items-center gap-3">
                        <span
                            class="text-xs font-bold text-slate-300 uppercase tracking-[0.2em]"
                            >Include Ignored Files</span
                        >

                        <!-- Question Mark -->

                        <div
                            class="w-5 h-5 rounded-full bg-slate-800 flex items-center justify-center text-[10px] text-slate-400 border border-slate-700 hover:bg-slate-700 hover:text-white transition-colors"
                        >
                            ?
                        </div>
                    </div>

                    <span class="text-[10px] text-slate-500 mt-1"
                        >Controls <code class="text-orange-400"
                            >Source-Tree.txt</code
                        > context</span
                    >

                    <!-- RESTORED TOOLTIP -->

                    <div
                        class="absolute bottom-full left-0 mb-4 w-64 bg-black/95 backdrop-blur-md border border-white/10 p-4 rounded-xl shadow-[0_10px_40px_rgba(0,0,0,0.5)] opacity-0 group-hover/info:opacity-100 transition-all pointer-events-none z-[100] text-[10px] text-slate-400 leading-relaxed translate-y-2 group-hover/info:translate-y-0 duration-200"
                    >
                        <strong
                            class="text-orange-400 block mb-1 uppercase tracking-wider"
                            >Tree Map Context</strong
                        >

                        When <strong>ON</strong>, ignored files (like
                        <code class="text-slate-300">package-lock.json</code>)
                        will appear in
                        <code class="text-slate-300">Source-Tree.txt</code>.

                        <br /><br />

                        This gives the AI context about your project structure
                        without wasting tokens on the actual file content.

                        <!-- Arrow -->

                        <div
                            class="absolute top-full left-6 -mt-1 border-4 border-transparent border-t-black/95"
                        ></div>
                    </div>
                </div>

                <!-- Toggle Switch (Text Removed) -->

                <label class="flex items-center cursor-pointer relative">
                    <div class="relative">
                        <input
                            type="checkbox"
                            bind:checked={includeIgnoredFiles}
                            class="sr-only peer"
                        />

                        <div
                            class="w-11 h-6 bg-slate-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-slate-400 after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-600 peer-checked:after:bg-white shadow-inner border border-white/5"
                        ></div>
                    </div>
                </label>
            </div>

            <!-- SETTINGS CARD -->

            <div
                class="bg-slate-900/40 backdrop-blur-xl border border-white/10 rounded-3xl p-6 shadow-2xl relative overflow-hidden transition-all duration-300"
            >
                <div class="flex justify-between items-center z-20 relative">
                    <div
                        class="flex items-center gap-2 text-slate-300 text-xs font-bold tracking-[0.2em] uppercase"
                    >
                        <span>Split Strategy</span>
                    </div>

                    <button
                        onclick={() => (settingsOpen = !settingsOpen)}
                        class="w-8 h-8 flex items-center justify-center rounded-full bg-white/5 hover:bg-orange-500 text-slate-400 hover:text-white transition-all {settingsOpen
                            ? 'bg-orange-500 text-white rotate-180'
                            : ''}"
                    >
                        <!-- CONFIG SVG -->
                        <svg
                            class="w-4 h-4"
                            fill="none"
                            stroke="currentColor"
                            viewBox="0 0 24 24"
                            ><path
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                stroke-width="2"
                                d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
                            ></path><path
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                stroke-width="2"
                                d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                            ></path></svg
                        >
                    </button>
                </div>

                <div
                    class="grid transition-[grid-template-rows] duration-300 ease-out {settingsOpen
                        ? 'grid-rows-[1fr] pt-4'
                        : 'grid-rows-[0fr]'}"
                >
                    <div class="overflow-hidden min-h-0 flex flex-col gap-4">
                        <!-- TOGGLE: Disable Splitting -->

                        <div
                            class="flex items-center justify-between bg-black/20 p-3 rounded-xl border border-white/5"
                        >
                            <div class="flex flex-col">
                                <span
                                    class="text-[10px] font-bold text-slate-300 uppercase tracking-wider"
                                    >Single File Mode</span
                                >

                                <span class="text-[9px] text-slate-500"
                                    >Tree and files merged into one .txt file.</span
                                >
                            </div>

                            <label
                                class="relative inline-flex items-center cursor-pointer"
                            >
                                <input
                                    type="checkbox"
                                    bind:checked={disableSplitting}
                                    class="sr-only peer"
                                />

                                <div
                                    class="w-9 h-5 bg-slate-800 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-slate-400 after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-orange-600 peer-checked:after:bg-white"
                                ></div>
                            </label>
                        </div>

                        <!-- SLIDER: Max Chars -->

                        <div
                            class="bg-black/20 p-3 rounded-xl border border-white/5 opacity-100 transition-opacity duration-300 {disableSplitting
                                ? 'opacity-30 pointer-events-none grayscale'
                                : ''}"
                        >
                            <label
                                for="maxCharsInput"
                                class="text-[10px] text-orange-400 uppercase font-bold mb-2 block"
                                >Split Threshold</label
                            >

                            <div class="flex gap-4 items-center">
                                <input
                                    id="maxCharsInput"
                                    type="range"
                                    min="10000"
                                    max="600000"
                                    step="5000"
                                    bind:value={maxChars}
                                    disabled={disableSplitting}
                                    class="flex-1 accent-orange-500 h-1.5 bg-slate-700 rounded-lg appearance-none cursor-pointer disabled:cursor-not-allowed"
                                />

                                <span
                                    class="font-mono text-white text-xs bg-orange-600 px-2 py-1 rounded shadow-lg"
                                >
                                    {(maxChars / 1000).toFixed(0)}k
                                </span>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- SUMMARY TEXT (Visible when closed) -->

                <div
                    class="grid transition-[grid-template-rows] duration-300 ease-out {!settingsOpen
                        ? 'grid-rows-[1fr] mt-3'
                        : 'grid-rows-[0fr] mt-0'}"
                >
                    <div class="overflow-hidden min-h-0">
                        <div
                            class="text-[11px] text-slate-500 font-medium leading-relaxed"
                        >
                            {#if disableSplitting}
                                <span class="text-orange-400"
                                    >Single File Mode</span
                                > active.
                            {:else}
                                Splitting files larger than <span
                                    class="text-orange-400"
                                    >{(maxChars / 1000).toFixed(0)}k</span
                                > chars.
                            {/if}
                        </div>
                    </div>
                </div>
            </div>

            <!-- ACTIONS -->

            <div class="grid gap-4">
                <!-- SAVE TO PROJECT -->

                <button
                    onclick={() => runForge("root")}
                    disabled={isProcessing || selectedIds.length === 0}
                    class="group relative overflow-hidden min-h-[8rem] rounded-3xl bg-black/50 border border-white/5 hover:border-orange-500/50 transition-all text-left disabled:opacity-50 disabled:cursor-not-allowed shadow-xl hover:shadow-[0_0_30px_rgba(249,115,22,0.2)] hover:-translate-y-1 flex flex-col justify-center px-8 py-6"
                >
                    <div
                        class="absolute inset-0 bg-gradient-to-br from-orange-900/20 to-red-900/20 opacity-0 group-hover:opacity-100 transition-opacity duration-500"
                    ></div>

                    <svg
                        class="absolute -right-5 -bottom-5 w-40 h-40 text-orange-500/5 group-hover:text-orange-500/20 transition-colors -rotate-12 pointer-events-none"
                        fill="currentColor"
                        viewBox="0 0 24 24"
                    >
                        <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z" />
                    </svg>

                    <div class="relative z-10">
                        <div class="flex items-center justify-between mb-2">
                            <div class="flex items-center gap-2">
                                <div
                                    class="w-8 h-8 rounded-lg bg-orange-500/10 flex items-center justify-center text-orange-400 group-hover:scale-110 transition-transform shrink-0 border border-orange-500/20"
                                >
                                    <svg
                                        class="w-5 h-5"
                                        fill="none"
                                        stroke="currentColor"
                                        viewBox="0 0 24 24"
                                        ><path
                                            stroke-linecap="round"
                                            stroke-linejoin="round"
                                            stroke-width="2"
                                            d="M5 19a2 2 0 01-2-2V7a2 2 0 012-2h4l2 2h4a2 2 0 012 2v1M5 19h14a2 2 0 002-2v-5a2 2 0 00-2-2H9a2 2 0 00-2 2v5a2 2 0 01-2 2z"
                                        ></path></svg
                                    >
                                </div>

                                {#if gitStatus !== "none"}
                                    <span
                                        class="text-[9px] font-bold uppercase bg-orange-950 border border-orange-900 text-orange-300 px-2 py-0.5 rounded"
                                        >Git Detected</span
                                    >
                                {/if}
                            </div>
                        </div>

                        <div
                            class="font-black text-lg text-white group-hover:text-orange-100 transition-colors tracking-tight"
                        >
                            Save to Project
                        </div>

                        <div
                            class="text-[10px] text-slate-500 font-mono mt-1 break-all pr-8 uppercase tracking-wider"
                        >
                            {#if gitStatus === "ignored"}
                                <span class="text-emerald-500/80"
                                    >✓ .gitignore configured</span
                                >
                            {:else if gitStatus === "clean"}
                                <span class="text-amber-500/80"
                                    >⚠ Will update .gitignore</span
                                >
                            {:else}
                                ./TXT-Forge/
                            {/if}
                        </div>
                    </div>
                </button>

                <!-- SAVE TO GLOBAL VAULT -->

                <button
                    onclick={() => runForge("global")}
                    disabled={isProcessing || selectedIds.length === 0}
                    class="group relative overflow-hidden min-h-[8rem] rounded-3xl bg-black/50 border border-white/5 hover:border-violet-500/50 transition-all text-left disabled:opacity-50 disabled:cursor-not-allowed shadow-xl hover:shadow-[0_0_30px_rgba(139,92,246,0.2)] hover:-translate-y-1 flex flex-col justify-center px-8 py-6"
                >
                    <div
                        class="absolute inset-0 bg-gradient-to-br from-violet-900/20 to-fuchsia-900/20 opacity-0 group-hover:opacity-100 transition-opacity duration-500"
                    ></div>

                    <svg
                        class="absolute -right-8 -bottom-8 w-48 h-48 text-violet-500/5 group-hover:text-violet-500/15 transition-colors rotate-6 pointer-events-none"
                        fill="currentColor"
                        viewBox="0 0 24 24"
                    >
                        <path
                            d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z"
                        />
                    </svg>

                    <div class="relative z-10">
                        <div class="mb-2">
                            <div
                                class="w-8 h-8 rounded-lg bg-violet-500/10 flex items-center justify-center text-violet-400 group-hover:scale-110 transition-transform shrink-0 border border-violet-500/20"
                            >
                                <svg
                                    class="w-5 h-5"
                                    fill="none"
                                    stroke="currentColor"
                                    viewBox="0 0 24 24"
                                    ><path
                                        stroke-linecap="round"
                                        stroke-linejoin="round"
                                        stroke-width="2"
                                        d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"
                                    ></path></svg
                                >
                            </div>
                        </div>

                        <div
                            class="font-black text-lg text-white group-hover:text-violet-100 transition-colors tracking-tight"
                        >
                            Save to Global Vault
                        </div>

                        <div
                            class="text-[10px] text-slate-500 font-mono mt-1 break-all pr-10 relative uppercase tracking-wider"
                            title={globalVaultPath}
                        >
                            <!-- UPDATED: Use the variable, fallback to default if empty -->
                            {globalVaultPath || "~/.txt-forge-vault"}
                        </div>
                    </div>
                </button>

                <!-- SAVE TO CUSTOM -->

                <button
                    onclick={handleCustomClick}
                    disabled={isProcessing || selectedIds.length === 0}
                    class="group relative overflow-hidden min-h-[8rem] rounded-3xl bg-black/50 border border-white/5 hover:border-amber-500/50 transition-all text-left disabled:opacity-50 disabled:cursor-not-allowed shadow-xl hover:shadow-[0_0_30px_rgba(245,158,11,0.2)] hover:-translate-y-1 flex flex-col justify-center px-8 py-6"
                >
                    <div
                        class="absolute inset-0 bg-gradient-to-br from-amber-900/20 to-yellow-900/20 opacity-0 group-hover:opacity-100 transition-opacity duration-500"
                    ></div>

                    <svg
                        class="absolute -right-8 -bottom-8 w-44 h-44 text-amber-500/5 group-hover:text-amber-500/15 transition-colors rotate-6 pointer-events-none"
                        fill="currentColor"
                        viewBox="0 0 24 24"
                    >
                        <path
                            d="M12 2c5.514 0 10 4.486 10 10s-4.486 10-10 10-10-4.486-10-10 4.486-10 10-10zm0-2c-6.627 0-12 5.373-12 12s5.373 12 12 12 12-5.373 12-12-5.373-12-12-12zm-1 6h2v8h-2v-8zm1 12.25c-.69 0-1.25-.56-1.25-1.25s.56-1.25 1.25-1.25 1.25.56 1.25 1.25-.56 1.25-1.25 1.25z"
                        />
                    </svg>

                    <div class="relative z-10">
                        <div class="flex items-center justify-between mb-2">
                            <div
                                class="w-8 h-8 rounded-lg bg-amber-500/10 flex items-center justify-center text-amber-400 group-hover:scale-110 transition-transform shrink-0 border border-amber-500/20"
                            >
                                <svg
                                    class="w-5 h-5"
                                    fill="none"
                                    stroke="currentColor"
                                    viewBox="0 0 24 24"
                                    ><path
                                        stroke-linecap="round"
                                        stroke-linejoin="round"
                                        stroke-width="2"
                                        d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"
                                    ></path><path
                                        stroke-linecap="round"
                                        stroke-linejoin="round"
                                        stroke-width="2"
                                        d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"
                                    ></path></svg
                                >
                            </div>

                            {#if savedCustomPath}
                                <span
                                    class="hidden group-hover:inline-block text-[9px] font-bold uppercase bg-amber-950 border border-amber-500/30 text-amber-300 px-2 py-1 rounded animate-fade-in-up"
                                >
                                    Shift+Click
                                </span>
                            {/if}
                        </div>

                        <div
                            class="font-black text-lg text-white group-hover:text-amber-100 transition-colors tracking-tight"
                        >
                            Save to Custom Location
                        </div>

                        <div
                            class="text-[10px] text-slate-500 font-mono mt-1 break-all pr-6 relative uppercase tracking-wider"
                            title={savedCustomPath}
                        >
                            {savedCustomPath
                                ? savedCustomPath
                                : "Click to browse folders..."}
                        </div>
                    </div>
                </button>
                
                <!-- PRETEXT ASCII BUTTON: COPY TO CLIPBOARD -->
                <PretextButton variant="rotated" onclick={() => runForge("clipboard")} disabled={isProcessing || selectedIds.length === 0} />
            </div>
        </div>
    </div>

    <!-- FOOTER -->

    <div class="mt-auto pt-16 pb-8 text-center">
        <p
            class="text-[9px] text-slate-700 font-bold tracking-[0.3em] uppercase hover:text-orange-900 transition-colors cursor-default"
        >
            TXT-FORGE v{appVersion} • Local Environment
        </p>
    </div>
</div>

<style>
    .custom-scrollbar {
        scrollbar-width: thin;

        scrollbar-color: rgba(249, 115, 22, 0.2) rgba(255, 255, 255, 0.02);
    }

    .custom-scrollbar::-webkit-scrollbar {
        width: 8px;
    }

    .custom-scrollbar::-webkit-scrollbar-track {
        background: rgba(0, 0, 0, 0.2);

        border-radius: 4px;
    }

    .custom-scrollbar::-webkit-scrollbar-thumb {
        background: rgba(249, 115, 22, 0.15);

        border-radius: 4px;

        border: 1px solid rgba(249, 115, 22, 0.05);
    }

    .custom-scrollbar::-webkit-scrollbar-thumb:hover {
        background: rgba(249, 115, 22, 0.3);
    }
</style>
