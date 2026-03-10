/* primary extension code for VSCode plugin */

const vscode = require('vscode');
const fs = require('fs');

const { 
    getSigmaRuntime,
} = require('./src/sigma');

const { KBTreeProvider } = require('./src/kb-tree');

const {
    searchSymbolCommand,
    provideDefinition,
    setDiagnosticCollection,
    browseInSigmaCommand,
    lookupQueryCommand,
} = require('./src/navigation');
const { setExtensionContext, getKB, handleFileChange } = require('./src/state');

const { showTaxonomyCommand } = require('./src/taxonomy');

const { 
    formatAxiomCommand, 
    formatDocument, 
    formatRange 
} = require('./src/formatting');

const {
    checkErrorsCommand,
    setDiagnosticCollection: setValidationDiagnosticCollection
} = require('./src/validation');

const { generateTPTPCommand } = require('./src/generate-tptp');

const { openSumoRepl } = require('./src/sumo-repl');

const {
    setKBTreeProvider,
    openKnowledgeBaseCommand,
    refreshKBExplorerCommand,
    addFileToKBCommand,
    removeFileFromKBCommand,
    createKnowledgeBaseCommand,
    updateActiveEditorContext
} = require('./src/kb-management');
const { 
    provideHover, 
    provideCompletionItems, 
    provideSignatureHelp 
} = require('./src/providers');

const { provideTPTPDocumentSymbols } = require('./src/tptp-provider');

let kbTreeProvider;

/**
 * Extension activation entrypoint
 * @param {vscode.ExtensionContext} context 
 */
async function activate(context) {
    // Make the extension context available to the parser cache layer first,
    // before any KB loading or parsing happens.
    setExtensionContext(context);

    // Create a single diagnostic collector shared by all validation paths
    const diagnosticCollection = vscode.languages.createDiagnosticCollection('sumo');
    context.subscriptions.push(diagnosticCollection);
    setDiagnosticCollection(diagnosticCollection);           // navigation.js
    setValidationDiagnosticCollection(diagnosticCollection); // validation.js checkErrorsCommand

    // Create storage URI
    if (!fs.existsSync(context.storageUri.fsPath)) {
        fs.mkdirSync(context.storageUri.fsPath, { mode: 0o744 });
    }

    // Create a new provider to track the knowledge bases on the system
    kbTreeProvider = new KBTreeProvider();
    setKBTreeProvider(kbTreeProvider);

    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('sumo.kbExplorer', kbTreeProvider)
    );

    const outputChannel = vscode.window.createOutputChannel("Sigma");
    outputChannel.show();

    // Register Commands
    context.subscriptions.push(vscode.commands.registerCommand('sumo.searchSymbol', searchSymbolCommand));
    context.subscriptions.push(vscode.commands.registerCommand('sumo.showTaxonomy', (arg) => showTaxonomyCommand(context, arg)));
    context.subscriptions.push(vscode.commands.registerCommand('sumo.formatAxiom', formatAxiomCommand));
    context.subscriptions.push(vscode.commands.registerCommand('sumo.browseInSigma', browseInSigmaCommand));
    context.subscriptions.push(vscode.commands.registerCommand('sumo.lookupQuery', lookupQueryCommand));
    context.subscriptions.push(vscode.commands.registerCommand('sumo.checkErrors', checkErrorsCommand));
    context.subscriptions.push(vscode.commands.registerCommand('sumo.generateTPTP', () => generateTPTPCommand(context)));
    context.subscriptions.push(vscode.commands.registerCommand('sumo.openRepl', openSumoRepl));
    context.subscriptions.push(vscode.commands.registerCommand('sumo.restartSigma', async () => {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Restarting Sigma...',
            cancellable: false
        }, async () => {
            try {
                await getSigmaRuntime().shutdown();
                await getSigmaRuntime().initialize(context, outputChannel);
                vscode.window.showInformationMessage('Sigma runtime restarted');
            } catch (e) {
                vscode.window.showErrorMessage('Failed to restart Sigma runtime: ' + e.message);
            }
        });
    }));
    context.subscriptions.push(vscode.commands.registerCommand('sumo.openKnowledgeBase', openKnowledgeBaseCommand));
    context.subscriptions.push(vscode.commands.registerCommand('sumo.createKnowledgeBase', createKnowledgeBaseCommand));
    context.subscriptions.push(vscode.commands.registerCommand('sumo.kbExplorer.refresh', refreshKBExplorerCommand));
    context.subscriptions.push(vscode.commands.registerCommand('sumo.kbExplorer.addFile', addFileToKBCommand));
    context.subscriptions.push(vscode.commands.registerCommand('sumo.kbExplorer.removeFile', removeFileFromKBCommand));

    // Listen for editor focus changes
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(updateActiveEditorContext)
    );

    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async (event) => {
        if (event.affectsConfiguration("sumo.sigma.runtime")) {
            await getSigmaRuntime().shutdown();
            await getSigmaRuntime().initialize(context, outputChannel);
        }
    }));

    const kbStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    kbStatusBarItem.command = 'sumo.generateTPTP';
    context.subscriptions.push(kbStatusBarItem);

    const updateKBStatusBar = async () => {
        const kbContext = getKB();

        if (kbContext) {
            kbStatusBarItem.text = `$(database) KB: ${kbContext}`;
            kbStatusBarItem.tooltip = `Working within Sigma KB\nConfig: ${kbContext}\nClick to generate TPTP`;
            kbStatusBarItem.backgroundColor = undefined;
            kbStatusBarItem.show();
        } else {
            kbStatusBarItem.hide();
        }
    };

    context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(updateKBStatusBar),
        vscode.window.onDidChangeActiveTextEditor(updateKBStatusBar)
    );

    context.subscriptions.push(
        vscode.languages.registerDefinitionProvider('suo-kif', {
            provideDefinition(document, position, token) {
                return provideDefinition(document, position);
            }
        })
    );

    context.subscriptions.push(
        vscode.languages.registerDocumentFormattingEditProvider('suo-kif', {
            provideDocumentFormattingEdits(document) {
                return formatDocument(document);
            }
        })
    );

    context.subscriptions.push(
        vscode.languages.registerDocumentRangeFormattingEditProvider('suo-kif', {
            provideDocumentRangeFormattingEdits(document, range) {
                return formatRange(document, range);
            }
        })
    );

    // Debounce map: fsPath → pending setTimeout handle
    const pendingSaves = new Map();

    /** @type {(document: vscode.TextDocument) => void} */
    const parseOnSave = (document) => {
        if (document.languageId !== 'suo-kif') return;
        const filePath = document.uri.fsPath;

        // Cancel any queued parse for this file
        if (pendingSaves.has(filePath)) {
            clearTimeout(pendingSaves.get(filePath));
        }

        pendingSaves.set(filePath, setTimeout(() => {
            pendingSaves.delete(filePath);
            vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: `Running Sigma Translation...`,
                cancellable: false
            }, async () => {
                handleFileChange(document);
            });
        }, 150));
    };

    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(doc => {
            if (doc.languageId !== 'suo-kif') return;
            handleFileChange(doc, true);
        }),
        vscode.workspace.onDidSaveTextDocument((document) => {
            parseOnSave(document);
            if (document.languageId !== 'suo-kif') return;
            const filePath = document.uri.fsPath;
            const affectedKBs = (kbTreeProvider?.kbs || [])
                .filter(kb => kb.constituents.includes(filePath));
            const runtime = getSigmaRuntime();
            for (const kb of affectedKBs) {
                runtime.markDirty(kb.name);
            }
        })
    );

    context.subscriptions.push(
        vscode.languages.registerHoverProvider('suo-kif', {
            provideHover(document, position, token) {
                return provideHover(document, position, token);
            }
        })
    );

    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider('suo-kif', {
            provideCompletionItems(document, position, token, context) {
                return provideCompletionItems(document, position, token, context);
            }
        })
    );

    context.subscriptions.push(
        vscode.languages.registerDocumentSymbolProvider('tptp', {
            provideDocumentSymbols(document, token) {
                return provideTPTPDocumentSymbols(document);
            }
        })
    );

    context.subscriptions.push(
        vscode.languages.registerSignatureHelpProvider('suo-kif', {
            provideSignatureHelp(document, position, token) {
                return provideSignatureHelp(document, position, token);
            }
        }, ' ', '(')
    );

    // Set initial state
    updateActiveEditorContext(vscode.window.activeTextEditor);

    // Update the status bar
    updateKBStatusBar();

    // Defer heavy initialization (KB loading + Sigma) until a KIF file is
    // actually the active editor.  The extension activates on onLanguage:suo-kif
    // (so a KIF file was opened), but it may not be focused yet.
    let kbInitialized = false;
    async function initializeForKif() {
        if (kbInitialized) return;
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.languageId !== 'suo-kif') return;
        kbInitialized = true;

        // Reveal the KB Explorer pane now that a KIF file is open.
        vscode.commands.executeCommand('setContext', 'sumo.kifFileOpened', true);

        openKnowledgeBaseCommand().catch(e => console.error('Failed to initialize KB:', e));

        vscode.workspace.textDocuments.forEach(doc => {
            if (doc.languageId === 'suo-kif') handleFileChange(doc, true);
        });

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Starting Sigma...`,
            cancellable: false
        }, async () => {
            try {
                await getSigmaRuntime().initialize(context, outputChannel);
                vscode.window.showInformationMessage('Successfully started Sigma runtime');
            } catch (e) {
                vscode.window.showErrorMessage('Failed to start Sigma runtime');
            }
        });
    }

    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(initializeForKif)
    );

    // Also run immediately if a KIF file is already the active editor at activation time.
    initializeForKif();
}

/**
 * Extension deactivation entrypoint
 * @param {vscode.ExtensionContext} context 
 */
async function deactivate() {
    await getSigmaRuntime().shutdown();
}

module.exports = { activate, deactivate };
