/* primary extension code for VSCode plugin */

const vscode = require('vscode');
const path = require('path');

const { 
    getSigmaRuntime, 
    findConfigXml, 
    isWithinConfiguredKB 
} = require('./src/sigma');

const { KBTreeProvider } = require('./src/kb-tree');

const { 
    searchSymbolCommand, 
    goToDefinitionCommand, 
    provideDefinition,
    updateDocumentDefinitions,
    getKB,
    setDiagnosticCollection
} = require('./src/navigation');

const { showTaxonomyCommand } = require('./src/taxonomy');

const { 
    formatAxiomCommand, 
    formatDocument, 
    formatRange 
} = require('./src/formatting');

const { 
    checkErrorsCommand
} = require('./src/validation');

const { 
    queryProverCommand, 
    runProverOnScopeCommand 
} = require('./src/prover');

const { generateTPTPCommand } = require('./src/generate-tptp');

const { openSumoRepl } = require('./src/sumo-repl');

const { 
    setKBTreeProvider, 
    openKnowledgeBaseCommand, 
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
    // Create diagnostic collector
    const diagnosticCollection = vscode.languages.createDiagnosticCollection('sumo');
    context.subscriptions.push(diagnosticCollection);
    setDiagnosticCollection(diagnosticCollection);

    // Create a new provider to track the knowledge bases on the system
    kbTreeProvider = new KBTreeProvider();
    setKBTreeProvider(kbTreeProvider);

    await getSigmaRuntime().initialize(context);

    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('sumo.kbExplorer', kbTreeProvider)
    );

    // Register Commands
    context.subscriptions.push(vscode.commands.registerCommand('sumo.searchSymbol', searchSymbolCommand));
    context.subscriptions.push(vscode.commands.registerCommand('sumo.showTaxonomy', (arg) => showTaxonomyCommand(context, arg)));
    context.subscriptions.push(vscode.commands.registerCommand('sumo.formatAxiom', formatAxiomCommand));
    context.subscriptions.push(vscode.commands.registerCommand('sumo.goToDefinition', goToDefinitionCommand));
    context.subscriptions.push(vscode.commands.registerCommand('sumo.browseInSigma', require('./src/navigation').browseInSigmaCommand));
    context.subscriptions.push(vscode.commands.registerCommand('sumo.checkErrors', checkErrorsCommand));
    context.subscriptions.push(vscode.commands.registerCommand('sumo.queryProver', queryProverCommand));
    context.subscriptions.push(vscode.commands.registerCommand('sumo.runProverOnScope', runProverOnScopeCommand));
    context.subscriptions.push(vscode.commands.registerCommand('sumo.generateTPTP', () => generateTPTPCommand(context)));
    context.subscriptions.push(vscode.commands.registerCommand('sumo.openRepl', openSumoRepl));
    context.subscriptions.push(vscode.commands.registerCommand('sumo.openKnowledgeBase', openKnowledgeBaseCommand));
    context.subscriptions.push(vscode.commands.registerCommand('sumo.createKnowledgeBase', createKnowledgeBaseCommand));
    context.subscriptions.push(vscode.commands.registerCommand('sumo.kbExplorer.refresh', openKnowledgeBaseCommand));
    context.subscriptions.push(vscode.commands.registerCommand('sumo.kbExplorer.addFile', addFileToKBCommand));
    context.subscriptions.push(vscode.commands.registerCommand('sumo.kbExplorer.removeFile', removeFileFromKBCommand));

    // Listen for editor focus changes
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(updateActiveEditorContext)
    );

    // Set initial state
    updateActiveEditorContext(vscode.window.activeTextEditor);

    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async (event) => {
        if (event.affectsConfiguration("sumo.sigma.runtime")) {
            await getSigmaRuntime().shutdown();
            await getSigmaRuntime().initialize(context);
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

    updateKBStatusBar();

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

    const validate = (document) => {
        if (document.languageId !== 'suo-kif') return;
        updateFileDefinitions(document);
    };

    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(validate),
        vscode.workspace.onDidChangeTextDocument(e => validate(e.document)),
        vscode.workspace.onDidSaveTextDocument(validate)
    );

    vscode.workspace.textDocuments.forEach(validate);

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
}

/**
 * Extension deactivation entrypoint
 * @param {vscode.ExtensionContext} context 
 */
async function deactivate() {
    await getSigmaRuntime().shutdown();
}

module.exports = { activate, deactivate };
