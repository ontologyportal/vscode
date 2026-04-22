// Export the active KB (or the current file) to TPTP.
//
// Delegates to the kernel's `kb.generateTptp` RPC -- the kernel
// reuses its already-loaded KB and invokes the same converter
// `sumo ask` would use for conjecture compilation, so the output
// is byte-identical to what the prover sees internally.  Keeping
// this server-side means the extension never has to ship or
// maintain a translator of its own.
//
// Scope options presented to the user:
//   - "Full KB" — every loaded file, producing one large TPTP file.
//   - "Current file" — only the axioms in the active editor.
//
// The TPTP dialect (`fof` | `tff` | `thf`) is read from the
// `sumo.tptp.lang` setting.

import * as path from 'path';
import { QuickPickItem, Uri, window, workspace } from 'vscode';

import { SumoKernelClient } from './kernelClient';
import { ActiveKb } from './kbSession';

export async function generateTptpCommand(
    kernel:    SumoKernelClient,
    getActive: () => ActiveKb | null,
): Promise<void> {
    const active = getActive();
    if (!active) {
        window.showInformationMessage('No active knowledge base.  Load one first.');
        return;
    }

    const editor = window.activeTextEditor;
    const editorIsKif = editor && editor.document.languageId === 'kif';

    type Scope = 'kb' | 'file';
    interface ScopeItem extends QuickPickItem { scope: Scope; }
    const scopeItems: ScopeItem[] = [
        {
            label:       `$(library) Full KB — "${active.name}" (${active.files.size} file${active.files.size === 1 ? '' : 's'})`,
            description: 'Export every constituent of the active KB',
            scope:       'kb',
        },
    ];
    if (editorIsKif) {
        scopeItems.push({
            label:       `$(file) Current file — ${path.basename(editor!.document.uri.fsPath)}`,
            description: 'Export only the axioms in the active editor',
            scope:       'file',
        });
    }
    const pick = await window.showQuickPick(scopeItems, {
        title:          'Generate TPTP — choose scope',
        ignoreFocusOut: true,
    });
    if (!pick) { return; }

    const lang = workspace.getConfiguration('sumo')
        .get<string>('tptp.lang', 'fof');

    const files = pick.scope === 'kb'
        ? Array.from(active.files).sort()
        : [editor!.document.uri.fsPath];

    let result: { tptp: string };
    try {
        result = await window.withProgress(
            { location: { viewId: 'sumoKnowledgeBases' }, title: 'SUMO: generating TPTP…', cancellable: false },
            () => kernel.generateTptp({ lang, files }),
        );
    } catch (err) {
        window.showErrorMessage(`TPTP generation failed: ${String(err)}`);
        return;
    }

    const defaultUri = defaultTargetUri(active, pick.scope, editor);
    const target = await window.showSaveDialog({
        defaultUri,
        filters: { TPTP: ['p', 'tptp'] },
        title:   'Save generated TPTP',
    });
    if (!target) { return; }

    await workspace.fs.writeFile(target, Buffer.from(result.tptp, 'utf8'));
    const doc = await workspace.openTextDocument(target);
    await window.showTextDocument(doc, { preview: false });
}

function defaultTargetUri(
    active: ActiveKb,
    scope:  'kb' | 'file',
    editor: import('vscode').TextEditor | undefined,
): Uri | undefined {
    if (scope === 'file' && editor) {
        const base = editor.document.uri.fsPath;
        const stem = base.replace(/\.kif(\.tq)?$/, '');
        return Uri.file(`${stem}.p`);
    }
    // KB scope: drop the .tptp next to the first constituent,
    // named after the KB.  If that's not writable the user gets
    // a dialog and can pick somewhere else.
    const first = Array.from(active.files).sort()[0];
    const dir = first ? path.dirname(first) : undefined;
    if (!dir) { return undefined; }
    return Uri.file(path.join(dir, `${active.name}.p`));
}
