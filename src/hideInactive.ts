// Dynamically hide .kif files that aren't constituents of the
// active knowledge base from the VSCode file explorer.
//
// Strategy: manage entries in each workspace-folder's
// `files.exclude` map.  VSCode anchors glob keys at the folder
// root, and the Explorer only honours WorkspaceFolder-scoped
// excludes for per-folder subtree filtering.  So we compute one
// entry per non-active .kif under each folder, relative to that
// folder, and write to `ConfigurationTarget.WorkspaceFolder`.
// The keys we've added are tracked in workspaceState so we can
// undo them on KB change, config toggle, or extension
// deactivation.
//
// Opt-in via `sumo.hideInactiveKbFiles`.  Users who want a
// read-only git-tracked exclusion list can still edit
// `files.exclude` by hand — the cleanup pass only removes the
// keys *we* added (stored in `STATE_KEY`), so unrelated entries
// survive round-trips.

import * as path from 'path';
import {
    ConfigurationTarget,
    ExtensionContext,
    workspace,
} from 'vscode';

/// Workspace-state key tracking the glob keys we most recently
/// added to `files.exclude`.  Persists across window reloads so
/// we can clean up entries we added in a previous session.
const STATE_KEY = 'sumo.hiddenKbExcludes';

let logger: ((msg: string) => void) | undefined;

/**
 * Wire a logger (e.g. the SUMO output channel).  Without this,
 * the module silently no-ops on diagnostic messages — fine for
 * tests, but unhelpful for users asking "why isn't this working".
 */
export function setInactiveKbLogger(fn: (msg: string) => void): void {
    logger = fn;
}

/**
 * Recompute `files.exclude` to reflect `activeFiles`.
 *
 * - When the feature is disabled (or there's no active KB), any
 *   keys we previously added are removed.
 * - When it's enabled and a KB is active, every `.kif` in the
 *   workspace that isn't in `activeFiles` gets a hide-entry on
 *   its containing folder.
 */
export async function applyInactiveKbExcludes(
    context:     ExtensionContext,
    activeFiles: ReadonlySet<string> | null,
): Promise<void> {
    const enabled = workspace.getConfiguration('sumo')
        .get<boolean>('hideInactiveKbFiles', false);

    const prior: string[] = context.workspaceState.get(STATE_KEY, []);
    const folders = workspace.workspaceFolders ?? [];

    // If there are no folders (rare, usually a "no folder open"
    // window), nothing to do — the explorer isn't showing anything
    // to filter.  Still clear prior keys for cleanliness.
    if (folders.length === 0) {
        logger?.('[hideInactive] no workspace folders; nothing to apply');
        await context.workspaceState.update(STATE_KEY, []);
        return;
    }

    // Collect the set of new keys (relative globs) we'll want to
    // apply per-folder.  Key shape: `${folderIdx}\0${rel}` so the
    // reverse pass knows which folder a historical key belongs to.
    const newKeys: string[] = [];
    const perFolderNew: Map<number, Set<string>> = new Map();
    folders.forEach((_, i) => perFolderNew.set(i, new Set()));

    let kifsFound = 0;
    let outOfScope = 0;

    if (enabled && activeFiles && activeFiles.size > 0) {
        const activeAbs = new Set<string>(
            Array.from(activeFiles).map(p => path.resolve(p)),
        );

        const kifs = await workspace.findFiles('**/*.{kif,kif.tq}');
        kifsFound = kifs.length;

        for (const uri of kifs) {
            if (uri.scheme !== 'file') { continue; }
            const abs = path.resolve(uri.fsPath);
            if (activeAbs.has(abs)) { continue; }

            const folderIdx = folders.findIndex(f =>
                abs === f.uri.fsPath || abs.startsWith(f.uri.fsPath + path.sep));
            if (folderIdx < 0) { outOfScope++; continue; }

            const rel = path.relative(folders[folderIdx].uri.fsPath, abs);
            if (rel === '' || rel.startsWith('..')) { continue; }
            const glob = rel.split(path.sep).join('/');

            perFolderNew.get(folderIdx)!.add(glob);
            newKeys.push(`${folderIdx}\0${glob}`);
        }
    }

    // Apply per folder.  For each folder: read its files.exclude
    // (at the WorkspaceFolder scope), strip our prior entries,
    // add the new ones, write back.
    for (let i = 0; i < folders.length; i++) {
        const folderCfg  = workspace.getConfiguration('files', folders[i].uri);
        const inspection = folderCfg.inspect<Record<string, boolean>>('exclude');
        const folderExclude: Record<string, boolean> = {
            ...(inspection?.workspaceFolderValue ?? {}),
        };

        // Remove prior entries that belong to this folder.
        for (const key of prior) {
            const [idxStr, glob] = key.split('\0');
            if (Number(idxStr) !== i) { continue; }
            if (folderExclude[glob] === true) { delete folderExclude[glob]; }
        }

        // Add new entries for this folder.
        for (const glob of perFolderNew.get(i) ?? []) {
            folderExclude[glob] = true;
        }

        await folderCfg.update('exclude', folderExclude,
            ConfigurationTarget.WorkspaceFolder);
    }

    await context.workspaceState.update(STATE_KEY, newKeys);

    logger?.(
        `[hideInactive] enabled=${enabled} active=${activeFiles?.size ?? 0} ` +
        `kifs-found=${kifsFound} hidden=${newKeys.length} ` +
        `out-of-scope=${outOfScope} folders=${folders.length}`,
    );
}

/**
 * Called on extension deactivation.  Best-effort cleanup so the
 * user doesn't land in a window with stale excludes.
 */
export async function clearInactiveKbExcludes(context: ExtensionContext): Promise<void> {
    await applyInactiveKbExcludes(context, null);
}
