// Dynamically hide .kif files that aren't constituents of the
// active knowledge base from the VSCode file explorer.
//
// Strategy: manage entries in the workspace's `files.exclude`
// map.  VSCode anchors glob keys at each workspace-folder root,
// so we emit one entry per non-active .kif (relative to its
// containing folder).  The keys we've added are tracked in
// workspaceState so we can undo them on KB change, config toggle,
// or extension deactivation.
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

/**
 * Recompute `files.exclude` to reflect `activeFiles`.
 *
 * - When the feature is disabled (or there's no active KB), any
 *   keys we previously added are removed.
 * - When it's enabled and a KB is active, every `.kif` in the
 *   workspace that isn't in `activeFiles` gets a hide-entry.
 *
 * Writes to `ConfigurationTarget.Workspace` — that lands in
 * `.vscode/settings.json` (or the `.code-workspace` file) rather
 * than the user's global settings, so toggling the feature
 * doesn't leak between projects.
 */
export async function applyInactiveKbExcludes(
    context:     ExtensionContext,
    activeFiles: ReadonlySet<string> | null,
): Promise<void> {
    const enabled = workspace.getConfiguration('sumo')
        .get<boolean>('hideInactiveKbFiles', false);

    const filesCfg = workspace.getConfiguration('files');
    const current  = { ...(filesCfg.get<Record<string, boolean>>('exclude', {})) };

    // Strip our prior entries first.  If a user flipped them from
    // `true` to `false` by hand, leave the manual override alone --
    // we only clean what we own AND still matches our expected
    // shape (plain boolean-true hide).
    const prior: string[] = context.workspaceState.get(STATE_KEY, []);
    for (const key of prior) {
        if (current[key] === true) { delete current[key]; }
    }

    const newKeys: string[] = [];

    if (enabled && activeFiles && activeFiles.size > 0) {
        const activeAbs = new Set<string>(
            Array.from(activeFiles).map(p => path.resolve(p)),
        );

        // Find every .kif in the workspace.  `findFiles` respects
        // `files.exclude`, but since we're about to overwrite that
        // map anyway, the prior state doesn't influence the query.
        const kifs = await workspace.findFiles('**/*.{kif,kif.tq}');

        const folders = workspace.workspaceFolders ?? [];

        for (const uri of kifs) {
            if (uri.scheme !== 'file') { continue; }
            const abs = path.resolve(uri.fsPath);
            if (activeAbs.has(abs)) { continue; }

            // Anchor the glob at whichever workspace folder
            // contains the file.  Files outside every folder fall
            // through unchanged (nothing to hide from).
            const folder = folders
                .find(f => abs === f.uri.fsPath || abs.startsWith(f.uri.fsPath + path.sep));
            if (!folder) { continue; }

            const rel  = path.relative(folder.uri.fsPath, abs);
            if (rel === '' || rel.startsWith('..')) { continue; }
            // `files.exclude` globs always use forward slashes,
            // even on Windows.  Normalise.
            const glob = rel.split(path.sep).join('/');

            current[glob] = true;
            newKeys.push(glob);
        }
    }

    await filesCfg.update('exclude', current, ConfigurationTarget.Workspace);
    await context.workspaceState.update(STATE_KEY, newKeys);
}

/**
 * Called on extension deactivation.  Synchronous best-effort
 * cleanup: tries to strip our entries so the user doesn't land
 * back in a window with stale excludes.  `deactivate` has ~5 s
 * before VSCode force-kills, which is plenty for a config
 * write.
 */
export async function clearInactiveKbExcludes(context: ExtensionContext): Promise<void> {
    await applyInactiveKbExcludes(context, null);
}
