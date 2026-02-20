/* primary extension code for VSCode plugin */

const vscode = require('vscode');
const path = require('path');

const { 
    getSigmaRuntime, 
    findConfigXml, 
    isWithinConfiguredKB 
} = require('./src/sigma');

const { KBTreeProvider } = require('./src/sigma/kb-tree');

const { 
    searchSymbolCommand, 
    goToDefinitionCommand, 
    provideDefinition,
    buildWorkspaceDefinitions,
    updateDocumentDefinitions,
    getKBFiles
} = require('./src/navigation');

const { showTaxonomyCommand } = require('./src/taxonomy');

const { 
    formatAxiomCommand, 
    formatDocument, 
    formatRange 
} = require('./src/formatting');

const { 
    checkErrorsCommand, 
    tokenize, 
    parse, 
    collectMetadata, 
    validateNode, 
    validateVariables
} = require('./src/validation');

const { 
    queryProverCommand, 
    runProverOnScopeCommand 
} = require('./src/prover');

const { generateTPTPCommand } = require('./src/generate-tptp');

const { 
    setKBTreeProvider, 
    openKnowledgeBaseCommand, 
    addFileToKBCommand, 
    removeFileFromKBCommand, 
    createKnowledgeBaseCommand 
} = require('./src/kb-management');

const { 
    setSymbolMetadata, 
    provideHover, 
    provideCompletionItems, 
    provideSignatureHelp 
} = require('./src/providers');

const { provideTPTPDocumentSymbols } = require('./src/tptp-provider');

let kbTreeProvider;
let symbolMetadata = {};

async function activate(context) {
    const diagnosticCollection = vscode.languages.createDiagnosticCollection('sumo');
    context.subscriptions.push(diagnosticCollection);

    kbTreeProvider = new KBTreeProvider();
    setKBTreeProvider(kbTreeProvider);

    await getSigmaRuntime().initialize(context);

    context.subscriptions.push(
        vscode.window.registerTreeDataProvider('sumo.kbExplorer', kbTreeProvider)
    );

    // Register Commands
    context.subscriptions.push(vscode.commands.registerCommand('sumo.searchSymbol', searchSymbolCommand));
    context.subscriptions.push(vscode.commands.registerCommand('sumo.showTaxonomy', showTaxonomyCommand));
    context.subscriptions.push(vscode.commands.registerCommand('sumo.formatAxiom', formatAxiomCommand));
    context.subscriptions.push(vscode.commands.registerCommand('sumo.goToDefinition', goToDefinitionCommand));
    context.subscriptions.push(vscode.commands.registerCommand('sumo.browseInSigma', require('./src/navigation').browseInSigmaCommand));
    context.subscriptions.push(vscode.commands.registerCommand('sumo.checkErrors', checkErrorsCommand));
    context.subscriptions.push(vscode.commands.registerCommand('sumo.queryProver', queryProverCommand));
    context.subscriptions.push(vscode.commands.registerCommand('sumo.runProverOnScope', runProverOnScopeCommand));
    context.subscriptions.push(vscode.commands.registerCommand('sumo.generateTPTP', () => generateTPTPCommand(context)));
    context.subscriptions.push(vscode.commands.registerCommand('sumo.openKnowledgeBase', openKnowledgeBaseCommand));
    context.subscriptions.push(vscode.commands.registerCommand('sumo.createKnowledgeBase', createKnowledgeBaseCommand));
    context.subscriptions.push(vscode.commands.registerCommand('sumo.kbExplorer.refresh', openKnowledgeBaseCommand));
    context.subscriptions.push(vscode.commands.registerCommand('sumo.kbExplorer.addFile', addFileToKBCommand));
    context.subscriptions.push(vscode.commands.registerCommand('sumo.kbExplorer.removeFile', removeFileFromKBCommand));

    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async (event) => {
        if (event.affectsConfiguration("sumo.sigma.runtime")) {
            await getSigmaRuntime().shutdown();
            await getSigmaRuntime().initialize(context);
        }
    }));

    buildWorkspaceDefinitions();

    const kbStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    kbStatusBarItem.command = 'sumo.generateTPTP';
    context.subscriptions.push(kbStatusBarItem);

    const updateKBStatusBar = async () => {
        const config = vscode.workspace.getConfiguration('sumo');
        const enforceKBContext = config.get('enforceKBContext') !== false;
        const kbContext = await isWithinConfiguredKB();

        if (kbContext) {
            kbStatusBarItem.text = `$(database) KB: ${kbContext.kbName || 'Configured'}`;
            kbStatusBarItem.tooltip = `Working within Sigma KB\nConfig: ${kbContext.configPath}\nClick to generate TPTP`;
            kbStatusBarItem.backgroundColor = undefined;
            kbStatusBarItem.show();
        } else if (await findConfigXml()) {
            if (enforceKBContext) {
                kbStatusBarItem.text = `$(warning) KB: Outside`;
                kbStatusBarItem.tooltip = 'Not within a configured KB directory. KB-level operations disabled.\nOpen a folder from your Sigma KBs directory to enable.\nOr disable "sumo.enforceKBContext" setting.';
                kbStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
            } else {
                kbStatusBarItem.text = `$(unlock) KB: Unrestricted`;
                kbStatusBarItem.tooltip = 'KB enforcement disabled. All operations available.\nClick to generate TPTP';
                kbStatusBarItem.backgroundColor = undefined;
            }
            kbStatusBarItem.show();
        } else {
            kbStatusBarItem.hide();
        }
    };

    context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(updateKBStatusBar),
        vscode.window.onDidChangeActiveTextEditor(updateKBStatusBar),
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('sumo.enforceKBContext') ||
                e.affectsConfiguration('sumo.configXmlPath')) {
                updateKBStatusBar();
            }
        })
    );

    updateKBStatusBar();

    context.subscriptions.push(
        vscode.languages.registerDefinitionProvider('sumo', {
            provideDefinition(document, position, token) {
                return provideDefinition(document, position);
            }
        })
    );

    context.subscriptions.push(
        vscode.languages.registerDocumentFormattingEditProvider('sumo', {
            provideDocumentFormattingEdits(document) {
                return formatDocument(document);
            }
        })
    );

    context.subscriptions.push(
        vscode.languages.registerDocumentRangeFormattingEditProvider('sumo', {
            provideDocumentRangeFormattingEdits(document, range) {
                return formatRange(document, range);
            }
        })
    );

    const validate = (document) => {
        if (document.languageId !== 'sumo') return;

        const diagnostics = [];
        const text = document.getText();
        const tokens = tokenize(text);
        const ast = parse(tokens, document, diagnostics);
        symbolMetadata = collectMetadata(ast);
        setSymbolMetadata(symbolMetadata);

        ast.forEach(node => validateNode(node, diagnostics, symbolMetadata));
        validateVariables(ast, diagnostics);

        diagnosticCollection.set(document.uri, diagnostics);

        updateDocumentDefinitions(document);
    };

    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(validate),
        vscode.workspace.onDidChangeTextDocument(e => validate(e.document)),
        vscode.workspace.onDidSaveTextDocument(validate)
    );

    vscode.workspace.textDocuments.forEach(validate);

    context.subscriptions.push(
        vscode.languages.registerHoverProvider('sumo', {
            provideHover(document, position, token) {
                return provideHover(document, position, token);
            }
        })
    );

    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider('sumo', {
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
        vscode.languages.registerSignatureHelpProvider('sumo', {
            provideSignatureHelp(document, position, token) {
                return provideSignatureHelp(document, position, token);
            }
        }, ' ', '(')
    );
}

async function deactivate() {
    await getSigmaRuntime().shutdown();
}

module.exports = { activate, deactivate };
