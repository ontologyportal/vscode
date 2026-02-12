/* primary extension code for VSCode plugin */

const vscode = require('vscode');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { LOGIC_OPS, QUANTIFIERS, DEFINING_RELATIONS } = require('./src/const');

const {
    getSigmaRuntime,
    getSigmaPath,
    findConfigXml,
    isWithinConfiguredKB,
    getKBConstituentsFromConfig,
    runSigma
} = require('./src/sigma/index');

const {
    findLocalConfigXml,
    parseConfigXmlSync,
    addKBToConfig
} = require('./src/sigma/config');

const {
    parseKIFFormulas,
    convertFormulas,
    tptpParseSUOKIFString,
    setLanguage
} = require('./src/sigma/engine/native/index.js');

let symbolMetadata = {};
let workspaceDefinitions = {}; // symbol -> [{file, line, type, context}]

// TPTP formula roles for symbol categorization
const TPTP_ROLES = {
    'axiom': vscode.SymbolKind.Constant,
    'hypothesis': vscode.SymbolKind.Variable,
    'definition': vscode.SymbolKind.Class,
    'assumption': vscode.SymbolKind.Variable,
    'lemma': vscode.SymbolKind.Method,
    'theorem': vscode.SymbolKind.Method,
    'corollary': vscode.SymbolKind.Method,
    'conjecture': vscode.SymbolKind.Function,
    'negated_conjecture': vscode.SymbolKind.Function,
    'plain': vscode.SymbolKind.Field,
    'type': vscode.SymbolKind.TypeParameter,
    'interpretation': vscode.SymbolKind.Interface,
    'fi_domain': vscode.SymbolKind.Enum,
    'fi_functors': vscode.SymbolKind.EnumMember,
    'fi_predicates': vscode.SymbolKind.EnumMember,
    'unknown': vscode.SymbolKind.Null
};

async function openKnowledgeBaseCommand() {
    const configPath = findLocalConfigXml();
    if (!configPath) {
        const action = await vscode.window.showErrorMessage(
            'Could not find Sigma config.xml. Set the path in settings.',
            'Open Settings'
        );
        if (action === 'Open Settings') {
            vscode.commands.executeCommand('workbench.action.openSettings', 'suo-kif.sigma.configXmlPath');
        }
        return;
    }

    const parsed = parseConfigXmlSync(configPath);
    if (!parsed) {
        vscode.window.showErrorMessage('Failed to parse config.xml at: ' + configPath);
        return;
    }

    const kbNames = Object.keys(parsed.knowledgeBases);
    if (kbNames.length === 0) {
        vscode.window.showWarningMessage('No knowledge bases found in config.xml');
        return;
    }

    const selected = await vscode.window.showQuickPick(
        kbNames.map(name => ({
            label: name,
            description: `${parsed.knowledgeBases[name].constituents.length} constituent files`
        })),
        { placeHolder: 'Select Knowledge Base to open' }
    );
    if (!selected) return;

    const kbDir = parsed.preferences.kbDir || path.dirname(configPath);
    const folderUri = vscode.Uri.file(kbDir);

    vscode.commands.executeCommand('vscode.openFolder', folderUri, true);
}

async function createKnowledgeBaseCommand() {
    const configPath = findLocalConfigXml();
    if (!configPath) {
        const action = await vscode.window.showErrorMessage(
            'Could not find Sigma config.xml. Set the path in settings or create one first.',
            'Open Settings'
        );
        if (action === 'Open Settings') {
            vscode.commands.executeCommand('workbench.action.openSettings', 'suo-kif.sigma.configXmlPath');
        }
        return;
    }

    const kbName = await vscode.window.showInputBox({
        prompt: 'Enter a name for the new Knowledge Base',
        placeHolder: 'e.g. MyOntology',
        validateInput: (value) => {
            if (!value || !value.trim()) return 'Name is required';
            if (/[<>"&]/.test(value)) return 'Name cannot contain XML special characters';
            return null;
        }
    });
    if (!kbName) return;

    const folderUris = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        openLabel: 'Select KB Folder'
    });
    if (!folderUris || folderUris.length === 0) return;

    const folderPath = folderUris[0].fsPath;

    // Scan for .kif files
    const kifFiles = fs.readdirSync(folderPath).filter(f => f.endsWith('.kif'));
    if (kifFiles.length === 0) {
        vscode.window.showWarningMessage('No .kif files found in selected folder. The KB will have no constituents.');
    }

    // Build constituent filenames (relative to kbDir if possible)
    const parsed = parseConfigXmlSync(configPath);
    const kbDir = parsed && parsed.preferences.kbDir ? parsed.preferences.kbDir : path.dirname(configPath);
    const filenames = kifFiles.map(f => {
        const abs = path.join(folderPath, f);
        const rel = path.relative(kbDir, abs);
        // Use relative path if it doesn't escape kbDir
        if (!rel.startsWith('..')) return rel;
        return abs;
    });

    try {
        addKBToConfig(configPath, kbName, filenames);
    } catch (e) {
        vscode.window.showErrorMessage('Failed to update config.xml: ' + e.message);
        return;
    }

    const action = await vscode.window.showInformationMessage(
        `Knowledge Base "${kbName}" created with ${filenames.length} constituent(s).`,
        'Open KB'
    );
    if (action === 'Open KB') {
        const folderUri = vscode.Uri.file(folderPath);
        vscode.workspace.updateWorkspaceFolders(
            (vscode.workspace.workspaceFolders || []).length, 0,
            { uri: folderUri, name: `KB: ${kbName}` }
        );
    }
}

function activate(context) {
    // Root function for initializing the extension
    const diagnosticCollection = vscode.languages.createDiagnosticCollection('suo-kif');
    context.subscriptions.push(diagnosticCollection);

    // Register Commands
    context.subscriptions.push(vscode.commands.registerCommand('suo-kif.searchSymbol', searchSymbolCommand));
    context.subscriptions.push(vscode.commands.registerCommand('suo-kif.showTaxonomy', showTaxonomyCommand));
    context.subscriptions.push(vscode.commands.registerCommand('suo-kif.formatAxiom', formatAxiomCommand));
    context.subscriptions.push(vscode.commands.registerCommand('suo-kif.goToDefinition', goToDefinitionCommand));
    context.subscriptions.push(vscode.commands.registerCommand('suo-kif.browseInSigma', browseInSigmaCommand));
    context.subscriptions.push(vscode.commands.registerCommand('suo-kif.checkErrors', checkErrorsCommand));
    context.subscriptions.push(vscode.commands.registerCommand('suo-kif.queryProver', queryProverCommand));
    context.subscriptions.push(vscode.commands.registerCommand('suo-kif.runProverOnScope', runProverOnScopeCommand));
    context.subscriptions.push(vscode.commands.registerCommand('suo-kif.generateTPTP', generateTPTPCommand));
    context.subscriptions.push(vscode.commands.registerCommand('suo-kif.openKnowledgeBase', openKnowledgeBaseCommand));
    context.subscriptions.push(vscode.commands.registerCommand('suo-kif.createKnowledgeBase', createKnowledgeBaseCommand));

    // Build workspace definitions index on startup
    buildWorkspaceDefinitions();

    // Create KB status bar item
    const kbStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    kbStatusBarItem.command = 'suo-kif.generateTPTP';
    context.subscriptions.push(kbStatusBarItem);

    // Function to update KB status bar
    const updateKBStatusBar = () => {
        const config = vscode.workspace.getConfiguration('suo-kif');
        const enforceKBContext = config.get('enforceKBContext') !== false;
        const kbContext = isWithinConfiguredKB();

        if (kbContext) {
            kbStatusBarItem.text = `$(database) KB: ${kbContext.kbName || 'Configured'}`;
            kbStatusBarItem.tooltip = `Working within Sigma KB\nConfig: ${kbContext.configPath}\nClick to generate TPTP`;
            kbStatusBarItem.backgroundColor = undefined;
            kbStatusBarItem.show();
        } else if (findConfigXml()) {
            if (enforceKBContext) {
                kbStatusBarItem.text = `$(warning) KB: Outside`;
                kbStatusBarItem.tooltip = 'Not within a configured KB directory. KB-level operations disabled.\nOpen a folder from your Sigma KBs directory to enable.\nOr disable "suo-kif.enforceKBContext" setting.';
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

    // Update status bar on workspace change, editor change, or config change
    context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(updateKBStatusBar),
        vscode.window.onDidChangeActiveTextEditor(updateKBStatusBar),
        vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('suo-kif.enforceKBContext') ||
                e.affectsConfiguration('suo-kif.configXmlPath')) {
                updateKBStatusBar();
            }
        })
    );

    // Initial update
    updateKBStatusBar();

    // Register Definition Provider for F12
    context.subscriptions.push(
        vscode.languages.registerDefinitionProvider('suo-kif', {
            provideDefinition(document, position, token) {
                return provideDefinition(document, position);
            }
        })
    );

    // Register Document Formatting Provider
    context.subscriptions.push(
        vscode.languages.registerDocumentFormattingEditProvider('suo-kif', {
            provideDocumentFormattingEdits(document) {
                return formatDocument(document);
            }
        })
    );

    // Register Selection Formatting Provider
    context.subscriptions.push(
        vscode.languages.registerDocumentRangeFormattingEditProvider('suo-kif', {
            provideDocumentRangeFormattingEdits(document, range) {
                return formatRange(document, range);
            }
        })
    );

    const validate = (document) => {
        if (document.languageId !== 'suo-kif') return;

        const diagnostics = [];
        const text = document.getText();
        const tokens = tokenize(text);
        const ast = parse(tokens, document, diagnostics);
        symbolMetadata = collectMetadata(ast);

        // Enhanced validation
        ast.forEach(node => validateNode(node, diagnostics, symbolMetadata));
        validateVariables(ast, diagnostics);

        diagnosticCollection.set(document.uri, diagnostics);

        // Update definitions for this document
        updateDocumentDefinitions(document);
    };

    context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(validate),
        vscode.workspace.onDidChangeTextDocument(e => validate(e.document)),
        vscode.workspace.onDidSaveTextDocument(validate)
    );

    // Validate currently open documents
    vscode.workspace.textDocuments.forEach(validate);

    // Hover Provider
    context.subscriptions.push(
        vscode.languages.registerHoverProvider('suo-kif', {
            provideHover(document, position, token) {
                const range = document.getWordRangeAtPosition(position);
                if (!range) return;
                const word = document.getText(range);
                const meta = symbolMetadata[word];
                if (meta && meta.documentation) {
                    const md = new vscode.MarkdownString();
                    md.appendMarkdown(meta.documentation);
                    return new vscode.Hover(md);
                }
            }
        })
    );

    // Completion Provider
    context.subscriptions.push(
        vscode.languages.registerCompletionItemProvider('suo-kif', {
            provideCompletionItems(document, position, token, context) {
                const items = [];
                for (const [key, val] of Object.entries(symbolMetadata)) {
                    const item = new vscode.CompletionItem(key, vscode.CompletionItemKind.Function);
                    if (val.documentation) {
                        item.documentation = new vscode.MarkdownString(val.documentation);
                    }
                    if (val.domains) {
                        const types = Object.entries(val.domains).map(([p, t]) => `Arg ${p}: ${t}`).join(', ');
                        item.detail = types;
                    }
                    items.push(item);
                }
                return items;
            }
        })
    );

    // TPTP Document Symbol Provider
    context.subscriptions.push(
        vscode.languages.registerDocumentSymbolProvider('tptp', {
            provideDocumentSymbols(document, token) {
                return provideTPTPDocumentSymbols(document);
            }
        })
    );

    // Signature Help Provider
    context.subscriptions.push(
        vscode.languages.registerSignatureHelpProvider('suo-kif', {
            provideSignatureHelp(document, position, token) {
                const text = document.getText();
                const offset = document.offsetAt(position);
                
                // Find start of current list (naive backward search)
                let balance = 0;
                let start = -1;
                for (let i = offset - 1; i >= 0; i--) {
                    if (text[i] === ')') balance++;
                    else if (text[i] === '(') {
                        if (balance > 0) balance--;
                        else {
                            start = i;
                            break;
                        }
                    }
                }
                
                if (start === -1) return null;
                
                const rangeText = text.substring(start, offset);
                const tokens = tokenize(rangeText);
                
                if (tokens.length < 2) return null;
                if (tokens[0].type !== 'LPAREN') return null;
                if (tokens[1].type !== 'ATOM') return null;
                
                const op = tokens[1].value;
                const meta = symbolMetadata[op];
                if (!meta) return null;
                
                // Calculate active parameter
                let siblingCount = 0;
                let currentTokenIndex = 2; // Skip LPAREN and Op
                
                while (currentTokenIndex < tokens.length) {
                    const t = tokens[currentTokenIndex];
                    siblingCount++;
                    
                    if (t.type === 'LPAREN') {
                        let bal = 1;
                        currentTokenIndex++;
                        while (currentTokenIndex < tokens.length && bal > 0) {
                            if (tokens[currentTokenIndex].type === 'LPAREN') bal++;
                            else if (tokens[currentTokenIndex].type === 'RPAREN') bal--;
                            currentTokenIndex++;
                        }
                    } else {
                        currentTokenIndex++;
                    }
                }
                
                let paramIndex = 0;
                if (/\s$/.test(rangeText)) {
                    paramIndex = siblingCount;
                } else {
                    paramIndex = Math.max(0, siblingCount - 1);
                }
                
                const sigHelp = new vscode.SignatureHelp();
                
                const domainIndices = Object.keys(meta.domains || {}).map(k => parseInt(k));
                const maxDomain = domainIndices.length > 0 ? Math.max(...domainIndices) : 0;
                const count = Math.max(maxDomain, paramIndex + 1);
                
                let label = `(${op}`;
                const params = [];
                
                for (let i = 1; i <= count; i++) {
                    const type = (meta.domains && meta.domains[i]) ? meta.domains[i] : 'Term';
                    const pLabel = ` ?arg${i}: ${type}`;
                    label += pLabel;
                    const paramDoc = new vscode.MarkdownString(`**Type**: `);
                    paramDoc.appendCodeblock(type, 'suo-kif');
                    params.push(new vscode.ParameterInformation(pLabel, paramDoc));
                }
                label += ')';
                
                const sig = new vscode.SignatureInformation(label, new vscode.MarkdownString(meta.documentation || ''));
                sig.parameters = params;
                
                sigHelp.signatures = [sig];
                sigHelp.activeSignature = 0;
                sigHelp.activeParameter = paramIndex;
                
                return sigHelp;
            }
        }, ' ', '(')
    );
}

function deactivate() {} // Not needed, no cleanup required

function validateNode(node, diagnostics, metadata) {
    if (!node || node.type !== 'list') return;

    if (node.children.length > 0) {
        const head = node.children[0];
        if (head.type === 'atom') {
            const op = head.value;
            if (LOGIC_OPS.includes(op)) {
                // Validate operands for logical operators
                for (let i = 1; i < node.children.length; i++) {
                    validateOperand(node.children[i], diagnostics);
                }
            }

            // Feature 1: Warning for Class naming in subclass/instance
            if (op === 'subclass' || op === 'instance') {
                // (subclass Sub Super) or (instance Inst Class) -> Check 2nd argument (index 2)
                if (node.children.length > 2) {
                    const classArg = node.children[2];
                    if (classArg.type === 'atom') {
                        const firstChar = classArg.value.charAt(0);
                        if (firstChar >= 'a' && firstChar <= 'z') {
                            diagnostics.push(new vscode.Diagnostic(
                                classArg.range,
                                `Class/Type '${classArg.value}' should start with an uppercase letter.`,
                                vscode.DiagnosticSeverity.Warning
                            ));
                        }
                    }
                }
            }

            // Feature 4: Type Validation based on domain
            if (metadata && metadata[op] && metadata[op].domains) {
                const domains = metadata[op].domains;
                for (let i = 1; i < node.children.length; i++) {
                    if (domains[i]) {
                        /*
                        diagnostics.push(new vscode.Diagnostic(
                            node.children[i].range,
                            `Type Hint: Argument ${i} expected to be of type '${domains[i]}'.`,
                            vscode.DiagnosticSeverity.Information
                        ));
                        */
                    }
                }
            }
        }
    }

    // Recurse
    node.children.forEach(child => validateNode(child, diagnostics, metadata));
}

function validateOperand(node, diagnostics) {
    if (node.type === 'atom') {
        // Allow variables
        if (node.value.startsWith('?') || node.value.startsWith('@')) {
            return;
        }

        // An operand to a logical operator must be a sentence, not an atom (term/propositional constant)
        diagnostics.push(new vscode.Diagnostic(
            node.range,
            'Operand must be a logical sentence or relation, not an atom.',
            vscode.DiagnosticSeverity.Error
        ));
        return;
    }

    if (node.type === 'list') {
        if (node.children.length === 0) return;
        const head = node.children[0];
        
        if (head.type === 'atom') {
            const val = head.value;
            
            // Allowed sentence heads
            if (LOGIC_OPS.includes(val) || QUANTIFIERS.includes(val) || val === '=') {
                return;
            }

            // Check SUO-KIF conventions
            const firstChar = val.charAt(0);
            
            // Relations start with lowercase
            if (firstChar >= 'a' && firstChar <= 'z') {
                return;
            }
            
            // Functions/Classes/Instances start with Uppercase -> These are Terms, not Sentences
            if (firstChar >= 'A' && firstChar <= 'Z') {
                diagnostics.push(new vscode.Diagnostic(
                    node.range,
                    `Invalid operand: '${val}' appears to be a Function or Instance (starts with Uppercase). Expected a Relation or Logical Sentence.`,
                    vscode.DiagnosticSeverity.Error
                ));
                return;
            }
        }
    }
}

function tokenize(text) {
    const tokens = [];
    let i = 0;
    while (i < text.length) {
        const char = text[i];
        if (/\s/.test(char)) { i++; continue; }
        if (char === ';') { while (i < text.length && text[i] !== '\n') i++; continue; }
        if (char === '"') {
            const start = i; i++;
            while (i < text.length) {
                if (text[i] === '\\') { i += 2; continue; }
                if (text[i] === '"') { i++; break; }
                i++;
            }
            tokens.push({ type: 'ATOM', value: text.substring(start, i), offset: start });
            continue;
        }
        if (char === '(') { tokens.push({ type: 'LPAREN', offset: i }); i++; continue; }
        if (char === ')') { tokens.push({ type: 'RPAREN', offset: i }); i++; continue; }
        
        const start = i;
        while (i < text.length && !/\s/.test(text[i]) && text[i] !== '(' && text[i] !== ')' && text[i] !== '"') i++;
        tokens.push({ type: 'ATOM', value: text.substring(start, i), offset: start });
    }
    return tokens;
}

function parse(tokens, document, diagnostics) {
    let current = 0;
    function walk() {
        if (current >= tokens.length) return null;
        const token = tokens[current];
        if (token.type === 'LPAREN') {
            current++;
            const node = { type: 'list', children: [], start: token.offset };
            while (current < tokens.length && tokens[current].type !== 'RPAREN') {
                const child = walk();
                if (child) node.children.push(child);
            }
            
            // Feature 3: Highlight unclosed parenthesis
            if (current >= tokens.length) {
                diagnostics.push(new vscode.Diagnostic(
                    new vscode.Range(document.positionAt(node.start), document.positionAt(node.start + 1)),
                    'Unclosed parenthesis: Expected \')\'',
                    vscode.DiagnosticSeverity.Error
                ));
            }

            node.end = (current < tokens.length) ? tokens[current].offset + 1 : document.getText().length;
            if (current < tokens.length) current++;
            node.range = new vscode.Range(document.positionAt(node.start), document.positionAt(node.end));
            return node;
        }
        if (token.type === 'RPAREN') { current++; return null; }
        current++;
        return { type: 'atom', value: token.value, range: new vscode.Range(document.positionAt(token.offset), document.positionAt(token.offset + token.value.length)) };
    }
    const nodes = [];
    while (current < tokens.length) {
        const node = walk();
        if (node) nodes.push(node);
    }
    return nodes;
}

function collectMetadata(ast) {
    const metadata = {}; // { symbol: { domains: { pos: type }, documentation: "" } }
    const targetLang = vscode.workspace.getConfiguration('suo-kif').get('language') || 'EnglishLanguage';
    
    const visit = (node) => {
        if (node.type === 'list' && node.children.length >= 4) {
            const head = node.children[0];
            
            // Domain
            if (head.type === 'atom' && head.value === 'domain') {
                const relNode = node.children[1];
                const posNode = node.children[2];
                const typeNode = node.children[3];

                if (relNode.type === 'atom' && posNode.type === 'atom' && typeNode.type === 'atom') {
                    const rel = relNode.value;
                    const pos = parseInt(posNode.value);
                    const type = typeNode.value;

                    if (!isNaN(pos)) {
                        if (!metadata[rel]) metadata[rel] = { domains: {}, documentation: '' };
                        if (!metadata[rel].domains) metadata[rel].domains = {};
                        metadata[rel].domains[pos] = type;
                    }
                }
            }
            
            // Documentation
            if (head.type === 'atom' && head.value === 'documentation') {
                const symNode = node.children[1];
                const langNode = node.children[2];
                const docNode = node.children[3]; // (documentation <sym> <lang> <string>)
                
                if (symNode.type === 'atom' && langNode.type === 'atom' && docNode.type === 'atom') {
                    const sym = symNode.value;
                    const lang = langNode.value;
                    let doc = docNode.value;
                    if (doc.startsWith('"') && doc.endsWith('"')) {
                        doc = doc.substring(1, doc.length - 1);
                    }
                    
                    if (!metadata[sym]) metadata[sym] = { domains: {}, documentation: '' };
                    
                    if (lang === targetLang || !metadata[sym].docLang || metadata[sym].docLang !== targetLang) {
                        metadata[sym].documentation = doc;
                        metadata[sym].docLang = lang;
                    }
                }
            }
        }
        if (node.type === 'list') {
            node.children.forEach(visit);
        }
    };

    ast.forEach(visit);
    return metadata;
}

async function searchSymbolCommand() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const document = editor.document;
    const position = editor.selection.active;
    const range = document.getWordRangeAtPosition(position);
    if (!range) return;

    const symbol = document.getText(range);

    const positionOptions = [
        { label: 'All', description: 'Show all occurrences' },
        { label: '1', description: 'Predicate / Head' },
        { label: '2', description: 'First Argument' },
        { label: '3', description: 'Second Argument' },
        { label: '4', description: 'Third Argument' },
        { label: '5', description: 'Fourth Argument' }
    ];

    const selectedOption = await vscode.window.showQuickPick(positionOptions, {
        placeHolder: `Filter '${symbol}' by position in expression?`
    });

    if (!selectedOption) return;

    const filterPos = selectedOption.label === 'All' ? null : parseInt(selectedOption.label);
    
    const files = await vscode.workspace.findFiles('**/*.kif');
    const matches = [];

    for (const file of files) {
        const doc = await vscode.workspace.openTextDocument(file);
        const text = doc.getText();
        
        // Fast regex check to skip files
        const escapedSymbol = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const fastRegex = new RegExp(`\\b${escapedSymbol}\\b`);
        if (!fastRegex.test(text)) continue;

        const tokens = tokenize(text);
        const ast = parse(tokens, doc, []); // Pass empty diagnostics

        const visit = (node, indexInParent) => {
            if (node.type === 'atom') {
                if (node.value === symbol) {
                    if (filterPos === null || (indexInParent !== undefined && indexInParent + 1 === filterPos)) {
                        matches.push({
                            label: `${vscode.workspace.asRelativePath(file)}:${node.range.start.line + 1}`,
                            description: doc.lineAt(node.range.start.line).text.trim(),
                            uri: file,
                            range: node.range
                        });
                    }
                }
            } else if (node.type === 'list') {
                node.children.forEach((child, idx) => visit(child, idx));
            }
        };

        ast.forEach(n => visit(n));
    }

    if (matches.length === 0) {
        vscode.window.showInformationMessage(`No occurrences of '${symbol}' found${filterPos ? ' at position ' + filterPos : ''}.`);
        return;
    }

    const selected = await vscode.window.showQuickPick(matches, { placeHolder: `Occurrences of '${symbol}'` });
    if (selected) {
        const doc = await vscode.workspace.openTextDocument(selected.uri);
        const editor = await vscode.window.showTextDocument(doc);
        editor.selection = new vscode.Selection(selected.range.start, selected.range.end);
        editor.revealRange(selected.range);
    }
}

async function showTaxonomyCommand(argSymbol) {
    let symbol = (typeof argSymbol === 'string') ? argSymbol : undefined;
    
    if (!symbol) {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        const document = editor.document;
        const position = editor.selection.active;
        const range = document.getWordRangeAtPosition(position);
        if (!range) {
            vscode.window.showInformationMessage("Please select a symbol to view its taxonomy.");
            return;
        }
        symbol = document.getText(range);
    }
    
    const panel = vscode.window.createWebviewPanel(
        'suoKifTaxonomy',
        `Taxonomy: ${symbol}`,
        vscode.ViewColumn.Beside,
        { enableScripts: true }
    );

    const updateWebview = async (targetSymbol) => {
        panel.title = `Taxonomy: ${targetSymbol}`;
        panel.webview.html = `<!DOCTYPE html><html><body style="font-family: sans-serif; padding: 10px;"><h3>Loading taxonomy for ${targetSymbol}...</h3></body></html>`;
        
        const { parents, children, documentation } = await buildWorkspaceTaxonomy();
        const doc = (documentation[targetSymbol]) 
            ? documentation[targetSymbol]
            : "No documentation found in workspace.";

        panel.webview.html = generateTaxonomyHtml(targetSymbol, parents, children, doc);
    };

    // Handle messages from the webview
    panel.webview.onDidReceiveMessage(
        message => {
            switch (message.command) {
                case 'openTaxonomy':
                    updateWebview(message.symbol);
                    return;
                case 'searchSymbol':
                    vscode.commands.executeCommand('suo-kif.searchSymbol', message.symbol);
                    return;
            }
        },
        undefined,
        undefined
    );

    updateWebview(symbol);
}

async function buildWorkspaceTaxonomy() {
    const files = await vscode.workspace.findFiles('**/*.kif');
    const parentGraph = {}; // child -> [parents]
    const childGraph = {}; // parent -> [children]
    const docMap = {}; // symbol -> { text, lang }
    const targetLang = vscode.workspace.getConfiguration('suo-kif').get('language') || 'EnglishLanguage';

    for (const file of files) {
        const doc = await vscode.workspace.openTextDocument(file);
        const text = doc.getText().replace(/("(?:\\[\s\S]|[^"])*")|;.*$/gm, (m, g1) => g1 || '');
        
        // Capture (subclass Child Parent) or (subrelation Child Parent)
        const regex = /\(\s*(subclass|subrelation)\s+([^?\s\)][^\s\)]*)\s+([^?\s\)][^\s\)]*)/g;
        let match;
        while ((match = regex.exec(text)) !== null) {
            const child = match[2];
            const parent = match[3];
            
            if (!parentGraph[child]) parentGraph[child] = [];
            if (!parentGraph[child].includes(parent)) parentGraph[child].push(parent);

            if (!childGraph[parent]) childGraph[parent] = [];
            if (!childGraph[parent].includes(child)) childGraph[parent].push(child);
        }

        // Capture (documentation Symbol Language "String")
        const docRegex = /\(\s*documentation\s+([^\s\)]+)\s+([^\s\)]+)\s+"((?:[^"\\]|\\[\s\S])*)"/g;
        let docMatch;
        while ((docMatch = docRegex.exec(text)) !== null) {
            const sym = docMatch[1];
            const lang = docMatch[2];
            let docStr = docMatch[3];
            // Unescape quotes if necessary
            docStr = docStr.replace(/\\"/g, '"');
            
            if (!docMap[sym] || lang === targetLang || docMap[sym].lang !== targetLang) {
                docMap[sym] = { text: docStr, lang: lang };
            }
        }
    }
    
    const documentation = {};
    for (const [s, d] of Object.entries(docMap)) {
        documentation[s] = d.text;
    }

    return { parents: parentGraph, children: childGraph, documentation };
}

function generateTaxonomyHtml(symbol, parentGraph, childGraph, documentation) {
    const renderTree = (curr, graph, visited = new Set()) => {
        if (visited.has(curr)) return `<li><strong class="symbol-node" data-symbol="${curr}">${curr}</strong> (cycle)</li>`;
        visited.add(curr);
        
        const nextNodes = graph[curr] || [];
        
        // Leaf node (or the target symbol in the ancestor view)
        if (nextNodes.length === 0) return `<li><strong class="symbol-node" data-symbol="${curr}">${curr}</strong></li>`;
        
        let html = `<li><strong class="symbol-node" data-symbol="${curr}">${curr}</strong><ul>`;
        nextNodes.forEach(n => {
            html += renderTree(n, graph, new Set(visited));
        });
        html += `</ul></li>`;
        return html;
    };

    // Build Ancestor Tree (Inverted: Ancestor -> Descendant -> Symbol)
    const { tree: ancestorTree, roots: ancestorRoots } = buildAncestorGraph(symbol, parentGraph);

    const directChildren = childGraph[symbol] || [];
    const childrenHtml = directChildren.length > 0 
        ? `<ul>${directChildren.map(c => `<li><strong class="symbol-node" data-symbol="${c}">${c}</strong></li>`).join('')}</ul>` 
        : '<em>No direct subclasses found.</em>';

    return `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <style>
                body { font-family: var(--vscode-font-family); padding: 20px; color: var(--vscode-editor-foreground); background-color: var(--vscode-editor-background); }
                h2 { color: var(--vscode-textLink-foreground); border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 5px; }
                ul { list-style-type: none; border-left: 1px solid var(--vscode-tree-indentGuidesStroke); padding-left: 15px; }
                li { margin: 5px 0; }
                li > strong {
                    transition: transform 0.2s ease, color 0.2s ease;
                    display: inline-block;
                    cursor: context-menu;
                }
                li > strong:hover { transform: translateX(5px); color: var(--vscode-textLink-activeForeground); cursor: default; }
                
                /* Context Menu */
                #context-menu {
                    display: none;
                    position: absolute;
                    z-index: 1000;
                    background-color: var(--vscode-menu-background);
                    color: var(--vscode-menu-foreground);
                    border: 1px solid var(--vscode-menu-border);
                    box-shadow: 0 2px 8px rgba(0,0,0,0.15);
                    padding: 4px 0;
                    min-width: 150px;
                }
                .menu-item {
                    padding: 4px 12px;
                    cursor: pointer;
                    display: block;
                    font-size: 13px;
                }
                .menu-item:hover {
                    background-color: var(--vscode-menu-selectionBackground);
                    color: var(--vscode-menu-selectionForeground);
                }
                .doc-block {
                    margin-bottom: 15px;
                    padding: 10px;
                    background-color: var(--vscode-textBlockQuote-background);
                    border-left: 4px solid var(--vscode-textBlockQuote-border);
                }
            </style>
        </head>
        <body>
            <h1>Taxonomy: ${symbol}</h1>
            ${documentation ? `<div class="doc-block">${documentation}</div>` : ''}
            <h2>Superclasses (Ancestors)</h2>
            <ul>
                ${ancestorRoots.map(r => renderTree(r, ancestorTree)).join('') || '<li><em>No superclasses found.</em></li>'}
            </ul>
            <h2>Direct Subclasses (Children)</h2>
            ${childrenHtml}

            <div id="context-menu">
                <div class="menu-item" id="menu-focus">Focus Symbol</div>
                <div class="menu-item" id="menu-search">Search in Workspace</div>
            </div>

            <script>
                const vscode = acquireVsCodeApi();
                const menu = document.getElementById('context-menu');
                let currentSymbol = null;

                document.addEventListener('contextmenu', (e) => {
                    const target = e.target;
                    if (target.tagName === 'STRONG' && target.classList.contains('symbol-node')) {
                        e.preventDefault();
                        currentSymbol = target.getAttribute('data-symbol');
                        menu.style.display = 'block';
                        menu.style.left = e.pageX + 'px';
                        menu.style.top = e.pageY + 'px';
                    } else {
                        menu.style.display = 'none';
                    }
                });

                document.addEventListener('click', () => {
                    menu.style.display = 'none';
                });

                document.getElementById('menu-focus').addEventListener('click', () => {
                    if (currentSymbol) {
                        vscode.postMessage({ command: 'openTaxonomy', symbol: currentSymbol });
                    }
                });

                document.getElementById('menu-search').addEventListener('click', () => {
                    if (currentSymbol) {
                        vscode.postMessage({ command: 'searchSymbol', symbol: currentSymbol });
                    }
                });
            </script>
        </body>
        </html>
    `;
}

function buildAncestorGraph(symbol, parentGraph) {
    const tree = {}; // parent -> [children] (subset of graph leading to symbol)
    const visited = new Set();
    const queue = [symbol];
    const nodesInTree = new Set([symbol]);

    // 1. BFS Upwards to find all relevant ancestors
    while (queue.length > 0) {
        const child = queue.shift();
        if (visited.has(child)) continue;
        visited.add(child);

        const parents = parentGraph[child] || [];
        parents.forEach(p => {
            if (!tree[p]) tree[p] = [];
            if (!tree[p].includes(child)) tree[p].push(child);
            
            nodesInTree.add(p);
            queue.push(p);
        });
    }

    // 2. Find roots (nodes in the tree that are not children of any other node in the tree)
    const roots = [];
    const allChildren = new Set();
    Object.values(tree).forEach(children => children.forEach(c => allChildren.add(c)));

    nodesInTree.forEach(node => {
        // If a node is in the tree but never appears as a child in the tree, it is a root
        if (!allChildren.has(node) && node !== symbol) {
            roots.push(node);
        }
    });

    // Edge case: if symbol has no parents, roots is empty.
    return { tree, roots };
}

// =====================================================
// NEW FEATURES: Ported from SUMOjEdit Plugin
// =====================================================

/**
 * Format Axiom Command - Reformats selected axiom with standard SUMO indentation
 */
async function formatAxiomCommand() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const document = editor.document;
    let range = editor.selection;

    // If no selection, try to find the enclosing S-expression
    if (range.isEmpty) {
        range = findEnclosingSExpression(document, editor.selection.active);
        if (!range) {
            vscode.window.showWarningMessage('Please select an axiom to format or place cursor inside an S-expression.');
            return;
        }
    }

    const text = document.getText(range);
    const formatted = formatSExpression(text);

    if (formatted !== text) {
        await editor.edit(editBuilder => {
            editBuilder.replace(range, formatted);
        });
    }
}

/**
 * Find the enclosing S-expression at the given position
 */
function findEnclosingSExpression(document, position) {
    const text = document.getText();
    const offset = document.offsetAt(position);

    // Find matching parentheses
    let start = -1;
    let balance = 0;

    // Search backwards for opening paren
    for (let i = offset; i >= 0; i--) {
        if (text[i] === ')') balance++;
        else if (text[i] === '(') {
            if (balance === 0) {
                start = i;
                break;
            }
            balance--;
        }
    }

    if (start === -1) return null;

    // Search forwards for closing paren
    balance = 1;
    for (let i = start + 1; i < text.length; i++) {
        if (text[i] === '(') balance++;
        else if (text[i] === ')') {
            balance--;
            if (balance === 0) {
                return new vscode.Range(
                    document.positionAt(start),
                    document.positionAt(i + 1)
                );
            }
        }
    }

    return null;
}

/**
 * Format an S-expression with standard SUMO indentation
 */
function formatSExpression(text) {
    const config = vscode.workspace.getConfiguration('suo-kif');
    const indentSize = config.get('formatIndentSize') || 2;

    const tokens = tokenize(text);
    if (tokens.length === 0) return text;

    let result = '';
    let indent = 0;
    let prevToken = null;
    let inQuantifierVars = false;
    let parenStack = [];

    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        const nextToken = tokens[i + 1];

        if (token.type === 'LPAREN') {
            if (prevToken && prevToken.type !== 'LPAREN') {
                result += '\n' + ' '.repeat(indent * indentSize);
            }
            result += '(';
            parenStack.push({ indent, type: 'normal' });
            indent++;

            // Check if this is a quantifier with variable list
            if (nextToken && nextToken.type === 'ATOM' && QUANTIFIERS.includes(nextToken.value)) {
                parenStack[parenStack.length - 1].type = 'quantifier';
            }
        } else if (token.type === 'RPAREN') {
            indent = Math.max(0, indent - 1);
            if (parenStack.length > 0) parenStack.pop();
            result += ')';
        } else if (token.type === 'ATOM') {
            if (prevToken) {
                if (prevToken.type === 'LPAREN') {
                    // Operator right after opening paren - no newline
                    result += token.value;
                } else if (prevToken.type === 'ATOM' || prevToken.type === 'RPAREN') {
                    // Check if we're in a variable list for forall/exists
                    const currentParen = parenStack[parenStack.length - 1];
                    const parentParen = parenStack[parenStack.length - 2];

                    if (parentParen && parentParen.type === 'quantifier' && currentParen) {
                        // We're in the variable list - keep on same line
                        result += ' ' + token.value;
                    } else if (LOGIC_OPS.includes(getHeadAtPosition(tokens, i)) ||
                               QUANTIFIERS.includes(getHeadAtPosition(tokens, i))) {
                        // Arguments to logical operators go on new lines
                        result += '\n' + ' '.repeat(indent * indentSize) + token.value;
                    } else {
                        // Regular arguments - stay on same line
                        result += ' ' + token.value;
                    }
                }
            } else {
                result += token.value;
            }
        }

        prevToken = token;
    }

    return result.trim();
}

/**
 * Get the head atom of the current S-expression at token position
 */
function getHeadAtPosition(tokens, currentIndex) {
    let balance = 0;
    for (let i = currentIndex - 1; i >= 0; i--) {
        if (tokens[i].type === 'RPAREN') balance++;
        else if (tokens[i].type === 'LPAREN') {
            if (balance === 0) {
                // Found the opening paren, next should be head
                if (i + 1 < tokens.length && tokens[i + 1].type === 'ATOM') {
                    return tokens[i + 1].value;
                }
                return null;
            }
            balance--;
        }
    }
    return null;
}

/**
 * Format entire document
 */
function formatDocument(document) {
    const text = document.getText();
    const edits = [];

    // Find all top-level S-expressions and format them
    let i = 0;
    while (i < text.length) {
        // Skip whitespace and comments
        while (i < text.length && /\s/.test(text[i])) i++;
        if (i >= text.length) break;

        if (text[i] === ';') {
            while (i < text.length && text[i] !== '\n') i++;
            continue;
        }

        if (text[i] === '(') {
            const start = i;
            let balance = 1;
            i++;
            while (i < text.length && balance > 0) {
                if (text[i] === '(') balance++;
                else if (text[i] === ')') balance--;
                else if (text[i] === '"') {
                    i++;
                    while (i < text.length && text[i] !== '"') {
                        if (text[i] === '\\') i++;
                        i++;
                    }
                } else if (text[i] === ';') {
                    while (i < text.length && text[i] !== '\n') i++;
                    continue;
                }
                i++;
            }
            const end = i;
            const expr = text.substring(start, end);
            const formatted = formatSExpression(expr);

            if (formatted !== expr) {
                edits.push(vscode.TextEdit.replace(
                    new vscode.Range(document.positionAt(start), document.positionAt(end)),
                    formatted
                ));
            }
        } else {
            i++;
        }
    }

    return edits;
}

/**
 * Format a range of the document
 */
function formatRange(document, range) {
    const text = document.getText(range);
    const formatted = formatSExpression(text);

    if (formatted !== text) {
        return [vscode.TextEdit.replace(range, formatted)];
    }
    return [];
}

/**
 * Go to Definition Command
 */
async function goToDefinitionCommand() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const document = editor.document;
    const position = editor.selection.active;
    const wordRange = document.getWordRangeAtPosition(position);
    if (!wordRange) return;

    const symbol = document.getText(wordRange);
    const definitions = await findDefinitions(symbol);

    if (definitions.length === 0) {
        vscode.window.showInformationMessage(`No definition found for '${symbol}'.`);
        return;
    }

    if (definitions.length === 1) {
        const def = definitions[0];
        const doc = await vscode.workspace.openTextDocument(def.uri);
        const editor = await vscode.window.showTextDocument(doc);
        editor.selection = new vscode.Selection(def.range.start, def.range.end);
        editor.revealRange(def.range, vscode.TextEditorRevealType.InCenter);
    } else {
        // Multiple definitions - show quick pick
        const items = definitions.map(def => ({
            label: `${def.type}: ${symbol}`,
            description: vscode.workspace.asRelativePath(def.uri),
            detail: def.context,
            definition: def
        }));

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: `Multiple definitions found for '${symbol}'`
        });

        if (selected) {
            const def = selected.definition;
            const doc = await vscode.workspace.openTextDocument(def.uri);
            const editor = await vscode.window.showTextDocument(doc);
            editor.selection = new vscode.Selection(def.range.start, def.range.end);
            editor.revealRange(def.range, vscode.TextEditorRevealType.InCenter);
        }
    }
}

/**
 * Definition Provider for F12 functionality
 */
async function provideDefinition(document, position) {
    const wordRange = document.getWordRangeAtPosition(position);
    if (!wordRange) return null;

    const symbol = document.getText(wordRange);
    const definitions = await findDefinitions(symbol);

    return definitions.map(def => new vscode.Location(def.uri, def.range));
}

/**
 * Find all definitions of a symbol in the workspace
 */
async function findDefinitions(symbol) {
    const definitions = [];
    const files = await vscode.workspace.findFiles('**/*.kif');

    // Skip variables
    if (symbol.startsWith('?') || symbol.startsWith('@')) {
        return definitions;
    }

    for (const file of files) {
        const doc = await vscode.workspace.openTextDocument(file);
        const text = doc.getText();

        // Fast check
        if (!text.includes(symbol)) continue;

        // Look for defining relations
        for (const rel of DEFINING_RELATIONS) {
            // Pattern: (relation symbol ...) where symbol is second argument
            const pattern = new RegExp(
                `\\(\\s*${rel}\\s+(${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\s`,
                'g'
            );

            let match;
            while ((match = pattern.exec(text)) !== null) {
                const startOffset = match.index;
                const symbolStart = text.indexOf(symbol, startOffset + rel.length + 2);
                const lineNum = doc.positionAt(symbolStart).line;
                const line = doc.lineAt(lineNum).text;

                definitions.push({
                    uri: file,
                    range: new vscode.Range(
                        doc.positionAt(symbolStart),
                        doc.positionAt(symbolStart + symbol.length)
                    ),
                    type: rel,
                    context: line.trim()
                });
            }
        }

        // Also check for (subclass X Parent) pattern
        const subclassPattern = new RegExp(
            `\\(\\s*subclass\\s+(${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\s+([^\\s\\)]+)`,
            'g'
        );
        let match;
        while ((match = subclassPattern.exec(text)) !== null) {
            const startOffset = match.index;
            const symbolStart = text.indexOf(symbol, startOffset + 10);
            const lineNum = doc.positionAt(symbolStart).line;
            const line = doc.lineAt(lineNum).text;

            // Avoid duplicates
            const exists = definitions.some(d =>
                d.uri.fsPath === file.fsPath &&
                d.range.start.line === lineNum &&
                d.type === 'subclass'
            );
            if (!exists) {
                definitions.push({
                    uri: file,
                    range: new vscode.Range(
                        doc.positionAt(symbolStart),
                        doc.positionAt(symbolStart + symbol.length)
                    ),
                    type: 'subclass',
                    context: line.trim()
                });
            }
        }
    }

    // Prioritize instance and subclass definitions
    definitions.sort((a, b) => {
        const priority = ['instance', 'subclass', 'subrelation', 'domain', 'documentation'];
        return priority.indexOf(a.type) - priority.indexOf(b.type);
    });

    return definitions;
}

/**
 * Browse Term in Sigma Command
 */
async function browseInSigmaCommand() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const document = editor.document;
    const position = editor.selection.active;
    const wordRange = document.getWordRangeAtPosition(position);

    if (!wordRange) {
        vscode.window.showWarningMessage('Please place cursor on a term to browse.');
        return;
    }

    const symbol = document.getText(wordRange);

    // Skip variables
    if (symbol.startsWith('?') || symbol.startsWith('@')) {
        vscode.window.showWarningMessage('Cannot browse variables in Sigma.');
        return;
    }

    const config = vscode.workspace.getConfiguration('suo-kif');
    const sigmaUrl = config.get('sigmaUrl') || 'http://sigma.ontologyportal.org:8080/sigma/Browse.jsp';
    const kb = config.get('knowledgeBase') || 'SUMO';
    const lang = config.get('language') || 'EnglishLanguage';

    const url = `${sigmaUrl}?kb=${encodeURIComponent(kb)}&lang=${encodeURIComponent(lang)}&flang=SUO-KIF&term=${encodeURIComponent(symbol)}`;

    vscode.env.openExternal(vscode.Uri.parse(url));
}

/**
 * Check Errors Command - Enhanced error checking
 */
async function checkErrorsCommand() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const document = editor.document;

    // Force re-validation with enhanced checks
    const diagnostics = [];
    const text = document.getText();
    const tokens = tokenize(text);
    const ast = parse(tokens, document, diagnostics);
    const metadata = collectMetadata(ast);

    // Run all validations
    ast.forEach(node => validateNode(node, diagnostics, metadata));
    validateVariables(ast, diagnostics);
    validateArity(ast, diagnostics, metadata);
    validateRelationUsage(ast, diagnostics, metadata);

    const collection = vscode.languages.createDiagnosticCollection('suo-kif-check');
    collection.set(document.uri, diagnostics);

    if (diagnostics.length === 0) {
        vscode.window.showInformationMessage('No errors found in the current file.');
    } else {
        vscode.window.showWarningMessage(`Found ${diagnostics.length} issue(s). See Problems panel for details.`);
    }
}

/**
 * Validate variable usage - check for undefined/unused variables
 */
function validateVariables(ast, diagnostics) {
    const visit = (node, scope = new Set(), quantifierVars = new Set()) => {
        if (node.type === 'list' && node.children.length > 0) {
            const head = node.children[0];

            if (head.type === 'atom' && QUANTIFIERS.includes(head.value)) {
                // This is a quantified expression
                if (node.children.length >= 2 && node.children[1].type === 'list') {
                    const varList = node.children[1];
                    const newScope = new Set(scope);

                    // Add quantified variables to scope
                    varList.children.forEach(v => {
                        if (v.type === 'atom' && (v.value.startsWith('?') || v.value.startsWith('@'))) {
                            newScope.add(v.value);
                        }
                    });

                    // Validate the body with extended scope
                    for (let i = 2; i < node.children.length; i++) {
                        visit(node.children[i], newScope, quantifierVars);
                    }
                    return;
                }
            }

            // Check all children
            node.children.forEach(child => visit(child, scope, quantifierVars));
        } else if (node.type === 'atom') {
            const val = node.value;
            if ((val.startsWith('?') || val.startsWith('@')) && !scope.has(val)) {
                // Free variable - this is allowed but we can inform
                // In SUO-KIF, free variables are implicitly universally quantified
            }
        }
    };

    ast.forEach(node => visit(node));
}

/**
 * Validate arity based on domain declarations
 */
function validateArity(ast, diagnostics, metadata) {
    const visit = (node) => {
        if (node.type === 'list' && node.children.length > 0) {
            const head = node.children[0];

            if (head.type === 'atom' && metadata[head.value] && metadata[head.value].domains) {
                const domains = metadata[head.value].domains;
                const maxArg = Math.max(...Object.keys(domains).map(k => parseInt(k)));
                const actualArgs = node.children.length - 1;

                if (actualArgs < maxArg) {
                    diagnostics.push(new vscode.Diagnostic(
                        node.range,
                        `Relation '${head.value}' expects at least ${maxArg} arguments, but got ${actualArgs}.`,
                        vscode.DiagnosticSeverity.Warning
                    ));
                }
            }

            node.children.forEach(visit);
        }
    };

    ast.forEach(visit);
}

/**
 * Validate relation usage patterns
 */
function validateRelationUsage(ast, diagnostics, metadata) {
    const visit = (node) => {
        if (node.type === 'list' && node.children.length > 0) {
            const head = node.children[0];

            // Check for empty lists
            if (node.children.length === 1 && head.type === 'atom' && !LOGIC_OPS.includes(head.value)) {
                diagnostics.push(new vscode.Diagnostic(
                    node.range,
                    `Relation '${head.value}' has no arguments.`,
                    vscode.DiagnosticSeverity.Warning
                ));
            }

            node.children.forEach(visit);
        }
    };

    ast.forEach(visit);
}

/**
 * Query Theorem Prover Command
 */
async function queryProverCommand() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const document = editor.document;
    let range = editor.selection;

    // If no selection, try to find enclosing S-expression
    if (range.isEmpty) {
        range = findEnclosingSExpression(document, editor.selection.active);
        if (!range) {
            vscode.window.showWarningMessage('Please select an axiom to query.');
            return;
        }
    }

    const query = document.getText(range);
    const config = vscode.workspace.getConfiguration('suo-kif');
    const prover = config.get('theoremProver');
    vscode.window.showInformationMessage(prover);

    const proverPath = prover.get('path');
    const proverType = prover.get('type');
    const timeout = prover.get('timeout') || 30;

    if (!proverPath) {
        const configure = await vscode.window.showErrorMessage(
            'Theorem prover path not configured. Please set suo-kif.prover.path in settings.',
            'Open Settings'
        );
        if (configure === 'Open Settings') {
            vscode.commands.executeCommand('workbench.action.openSettings', 'suo-kif.prover.path');
        }
        return;
    }

    // Check if prover exists
    if (!fs.existsSync(proverPath)) {
        vscode.window.showErrorMessage(`Theorem prover not found at: ${proverPath}`);
        return;
    }

    // Convert SUO-KIF to TPTP format
    const tptpQuery = convertToTPTP(query);

    // Create temp file for query
    const tempDir = os.tmpdir();
    const tempFile = path.join(tempDir, `suokif-query-${Date.now()}.p`);

    // Get all KIF files for context
    const files = await vscode.workspace.findFiles('**/*.kif');
    let context = '';

    for (const file of files) {
        if (file.fsPath !== document.uri.fsPath) {
            const doc = await vscode.workspace.openTextDocument(file);
            context += doc.getText() + '\n';
        }
    }

    // Add current file content (except the query)
    const fullText = document.getText();
    const queryStart = document.offsetAt(range.start);
    const queryEnd = document.offsetAt(range.end);
    context += fullText.substring(0, queryStart) + fullText.substring(queryEnd);

    // Convert context to TPTP
    const tptpContext = convertKBToTPTP(context);
    const fullTPTP = tptpContext + '\n' + tptpQuery;

    fs.writeFileSync(tempFile, fullTPTP);

    // Show progress
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Running theorem prover...',
        cancellable: true
    }, async (progress, token) => {
        return new Promise((resolve, reject) => {
            let cmd;
            if (proverType === 'vampire') {
                cmd = `"${proverPath}" --mode casc -t ${timeout} "${tempFile}"`;
            } else {
                cmd = `"${proverPath}" --auto --cpu-limit=${timeout} "${tempFile}"`;
            }

            const proc = exec(cmd, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
                // Clean up temp file
                try { fs.unlinkSync(tempFile); } catch (e) {}

                if (token.isCancellationRequested) {
                    resolve();
                    return;
                }

                // Create output panel
                const outputChannel = vscode.window.createOutputChannel('SUO-KIF Prover');
                outputChannel.clear();
                outputChannel.appendLine(`Query: ${query}`);
                outputChannel.appendLine('='.repeat(60));
                outputChannel.appendLine('');

                if (error && !stdout) {
                    outputChannel.appendLine('Error running prover:');
                    outputChannel.appendLine(stderr || error.message);
                } else {
                    outputChannel.appendLine('Prover Output:');
                    outputChannel.appendLine(stdout);
                    if (stderr) {
                        outputChannel.appendLine('\nStderr:');
                        outputChannel.appendLine(stderr);
                    }

                    // Parse result
                    if (stdout.includes('Theorem') || stdout.includes('SZS status Theorem')) {
                        vscode.window.showInformationMessage('Theorem proved!');
                    } else if (stdout.includes('CounterSatisfiable') || stdout.includes('SZS status CounterSatisfiable')) {
                        vscode.window.showWarningMessage('Counter-satisfiable (theorem cannot be proved).');
                    } else if (stdout.includes('Timeout') || stdout.includes('SZS status Timeout')) {
                        vscode.window.showWarningMessage('Prover timed out.');
                    } else if (stdout.includes('Unsatisfiable') || stdout.includes('SZS status Unsatisfiable')) {
                        vscode.window.showInformationMessage('Unsatisfiable (negation is a theorem).');
                    }
                }

                outputChannel.show();
                resolve();
            });

            token.onCancellationRequested(() => {
                proc.kill();
            });
        });
    });
}

/**
 * Run Prover on Scope Command
 * Allows running the prover on Selection, File, or Workspace
 */
async function runProverOnScopeCommand() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const document = editor.document;
    const config = vscode.workspace.getConfiguration('suo-kif');
    const prover = config.get('theoremProver');
    const proverPath = prover.path;
    const proverType = prover.type || 'vampire';
    const timeout = prover.timeout || 30;

    if (!proverPath) {
        const configure = await vscode.window.showErrorMessage(
            'Theorem prover path not configured. Please set suo-kif.prover.path in settings.',
            'Open Settings'
        );
        if (configure === 'Open Settings') {
            vscode.commands.executeCommand('workbench.action.openSettings', 'suo-kif.prover.path');
        }
        return;
    }

    // Check if prover exists
    if (!fs.existsSync(proverPath)) {
        vscode.window.showErrorMessage(`Theorem prover not found at: ${proverPath}`);
        return;
    }

    // Offer options for scope
    const options = [
        { label: 'Selection / Current Line', description: 'Run prover on selected text or current line' },
        { label: 'Current File', description: 'Run prover on the current file' },
        { label: 'Entire Workspace', description: 'Run prover on all .kif files in workspace' }
    ];

    const selected = await vscode.window.showQuickPick(options, {
        placeHolder: 'Select scope for theorem prover'
    });

    if (!selected) return;

    let kifContent = '';
    let sourceName = '';

    // Collect content
    if (selected.label === 'Selection / Current Line') {
        if (!editor.selection.isEmpty) {
            kifContent = document.getText(editor.selection);
            sourceName = 'selection';
        } else {
            const line = document.lineAt(editor.selection.active.line);
            kifContent = line.text;
            sourceName = 'line';
        }
    } else if (selected.label === 'Current File') {
        kifContent = document.getText();
        sourceName = path.basename(document.fileName, '.kif');
    } else if (selected.label === 'Entire Workspace') {
        const files = await vscode.workspace.findFiles('**/*.kif');
        if (files.length === 0) {
            vscode.window.showWarningMessage('No .kif files found in workspace.');
            return;
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Collecting workspace files...',
            cancellable: false
        }, async (progress) => {
            for (let i = 0; i < files.length; i++) {
                progress.report({ message: `Processing ${i + 1}/${files.length} files...` });
                const doc = await vscode.workspace.openTextDocument(files[i]);
                kifContent += `; File: ${vscode.workspace.asRelativePath(files[i])}\n`;
                kifContent += doc.getText() + '\n\n';
            }
        });
        sourceName = 'workspace';
    }

    if (!kifContent.trim()) {
        vscode.window.showWarningMessage('No content to process.');
        return;
    }

    // Generate TPTP
    let tptpContent = '';
    let axiomCount = 0;

    const { useDocker, useNativeJS } = getSigmaRuntime();
    const sigmaPath = getSigmaPath();
    const tptpLang = config.get('tptpLang') || 'fof';

    if (useNativeJS) {
        // Use sigma native converter
        setLanguage(tptpLang);
        const formulas = parseKIFFormulas(kifContent);
        const result = convertFormulas(formulas, sourceName, null, false);
        tptpContent = result.content;
        axiomCount = result.axiomCount;
    } else if (useDocker || sigmaPath) {
        // Use Sigma
        const contextFiles = await collectFilesForContext();
        if (!contextFiles) return; // Cancelled

        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: useDocker ? 'Converting via Sigma Docker...' : 'Converting via local Sigma...',
                cancellable: false
            }, async (progress) => {
                if (sourceName === 'selection' || sourceName === 'line') {
                    const tmpKif = path.join(os.tmpdir(), `temp_selection_${Date.now()}.kif`);
                    fs.writeFileSync(tmpKif, kifContent);
                    contextFiles.push(tmpKif);
                }

                const result = await runSigma(contextFiles, 'PROVE', null, tptpLang);
                tptpContent = result.content;
                axiomCount = result.axiomCount;
            });
        } catch (err) {
            vscode.window.showErrorMessage(`Sigma conversion failed: ${err.message}`);
            return;
        }
    } else {
        vscode.window.showErrorMessage('Sigma not configured. Please set "suo-kif.sigmaPath", or select an alternative sigma runtime');
        return;
    }

    if (axiomCount === 0 && !tptpContent) {
        vscode.window.showWarningMessage('No valid axioms produced.');
        return;
    }

    // Write to temp file
    const tempDir = os.tmpdir();
    const tempFile = path.join(tempDir, `suokif-verify-${Date.now()}.p`);
    fs.writeFileSync(tempFile, tptpContent);

    // Run Prover
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Running ${proverType} on ${sourceName}...`,
        cancellable: true
    }, async (progress, token) => {
        return new Promise((resolve, reject) => {
            let cmd;
            if (proverType === 'vampire') {
                // Use cascade mode for best effort
                cmd = `"${proverPath}" --mode casc -t ${timeout} "${tempFile}"`;
            } else {
                cmd = `"${proverPath}" --auto --cpu-limit=${timeout} "${tempFile}"`;
            }

            const proc = exec(cmd, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
                // Clean up temp file
                try { fs.unlinkSync(tempFile); } catch (e) {}

                if (token.isCancellationRequested) {
                    resolve();
                    return;
                }

                const outputChannel = vscode.window.createOutputChannel('SUO-KIF Prover');
                outputChannel.clear();
                outputChannel.appendLine(`Scope: ${selected.label}`);
                outputChannel.appendLine(`Source: ${sourceName}`);
                outputChannel.appendLine(`Axioms: ${axiomCount}`);
                outputChannel.appendLine('='.repeat(60));
                outputChannel.appendLine('');

                if (error && !stdout) {
                    outputChannel.appendLine('Error running prover:');
                    outputChannel.appendLine(stderr || error.message);
                } else {
                    outputChannel.appendLine('Prover Output:');
                    outputChannel.appendLine(stdout);
                    if (stderr) {
                        outputChannel.appendLine('\nStderr:');
                        outputChannel.appendLine(stderr);
                    }

                    // Interpret results
                    if (stdout.includes('Unsatisfiable') || stdout.includes('SZS status Unsatisfiable')) {
                        vscode.window.showInformationMessage('Result: Unsatisfiable (Contradiction found).');
                    } else if (stdout.includes('Satisfiable') || stdout.includes('SZS status Satisfiable')) {
                        vscode.window.showInformationMessage('Result: Satisfiable (Consistent).');
                    } else if (stdout.includes('Theorem') || stdout.includes('SZS status Theorem')) {
                        vscode.window.showInformationMessage('Result: Theorem (Proof found).');
                    } else if (stdout.includes('CounterSatisfiable') || stdout.includes('SZS status CounterSatisfiable')) {
                        vscode.window.showWarningMessage('Result: Counter-Satisfiable.');
                    } else if (stdout.includes('Timeout') || stdout.includes('SZS status Timeout')) {
                        vscode.window.showWarningMessage('Result: Timeout.');
                    } else {
                        vscode.window.showInformationMessage('Prover finished. Check output.');
                    }
                }

                outputChannel.show();
                resolve();
            });

            token.onCancellationRequested(() => {
                proc.kill();
            });
        });
    });
}

/**
 * Generate TPTP File Command - Opens TPTP conversion in new editor pane
 * Uses Sigma if configured, else uses JS converter
 * Supports: single file, selection, workspace, or entire KB from config.xml
 * KB-level operations are only available when working within a configured KB directory
 */
async function generateTPTPCommand() {
    const editor = vscode.window.activeTextEditor;

    const config = vscode.workspace.getConfiguration('suo-kif');
    const { useDocker, useNativeJS } = getSigmaRuntime();
    const dockerImage = config.get('dockerImage') || 'apease/sigmakee';
    const sigmaPath = getSigmaPath();
    const tptpLang = config.get('tptpLang') || 'fof';
    const enforceKBContext = config.get('enforceKBContext') !== false; // Default true

    // Check if user is working within a configured KB
    const kbContext = isWithinConfiguredKB();
    const isInKB = kbContext !== null;

    // KB-level operations allowed if within KB or enforcement is disabled
    const allowKBOperations = isInKB || !enforceKBContext;

    // Build options based on what's available
    const options = [];

    // Single file/selection options are always available
    if (editor && editor.document.languageId === 'suo-kif') {
        options.push({ label: 'Current File', description: 'Convert the current file to TPTP' });
        options.push({ label: 'Selection Only', description: 'Convert selected text to TPTP' });
    }

    // KB-level operations only available when within a configured KB (or enforcement disabled)
    if (allowKBOperations) {
        options.push({ label: 'Entire Workspace', description: 'Convert all .kif files in workspace to TPTP' });

        // Add config.xml KB export option if Sigma is available
        if (useDocker || sigmaPath || useNativeJS) {
            const kbLabel = kbContext?.kbName || 'select KB';
            options.push({
                label: 'Knowledge Base from config.xml',
                description: `Export entire KB defined in Sigma config.xml (${kbLabel})`
            });
            options.push({
                label: 'Custom File Selection',
                description: 'Select specific .kif files to convert'
            });
        }
    } else {
        // Not in a KB and enforcement is on - show limited options with explanation
        if ((useDocker || sigmaPath || useNativeJS) && findConfigXml()) {
            options.push({
                label: '$(warning) Workspace Operations Disabled',
                description: 'Open a folder within a configured KB to enable workspace/KB operations',
                disabled: true
            });
        }
    }

    // If no valid options, show error
    if (options.length === 0 || (options.length === 1 && options[0].disabled)) {
        vscode.window.showWarningMessage(
            'No KIF file open. Please open a .kif file to convert to TPTP.'
        );
        return;
    }

    // Filter out disabled options for the picker
    const pickableOptions = options.filter(o => !o.disabled);

    const selected = await vscode.window.showQuickPick(pickableOptions, {
        placeHolder: isInKB
            ? 'What would you like to convert to TPTP?'
            : 'What would you like to convert to TPTP? (KB operations require opening a KB folder)'
    });

    if (!selected) return;

    let kifContent = '';
    let sourceName = '';
    let useFullKBExport = false;
    let kbConfig = null;
    let customFiles = null;

    if (selected.label === 'Current File') {
        if (!editor) return;
        kifContent = editor.document.getText();
        sourceName = path.basename(editor.document.fileName, '.kif');
    } else if (selected.label === 'Entire Workspace') {
        // Double-check KB context (should already be verified, but be safe)
        if (!allowKBOperations) {
            vscode.window.showWarningMessage(
                'Workspace conversion requires opening a folder within a configured knowledge base, or disable "suo-kif.enforceKBContext" setting.'
            );
            return;
        }

        const files = await vscode.workspace.findFiles('**/*.kif');
        if (files.length === 0) {
            vscode.window.showWarningMessage('No .kif files found in workspace.');
            return;
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Collecting workspace files...',
            cancellable: false
        }, async (progress) => {
            for (let i = 0; i < files.length; i++) {
                progress.report({ message: `Processing ${i + 1}/${files.length} files...` });
                const doc = await vscode.workspace.openTextDocument(files[i]);
                kifContent += `; File: ${vscode.workspace.asRelativePath(files[i])}\n`;
                kifContent += doc.getText() + '\n\n';
            }
        });

        sourceName = 'workspace';
    } else if (selected.label === 'Selection Only') {
        if (!editor || editor.selection.isEmpty) {
            vscode.window.showWarningMessage('No text selected.');
            return;
        }
        kifContent = editor.document.getText(editor.selection);
        sourceName = path.basename(editor.document.fileName, '.kif') + '-selection';
    } else if (selected.label.includes('Knowledge Base from config.xml')) {
        // Double-check KB context
        if (!allowKBOperations) {
            vscode.window.showWarningMessage(
                'KB export requires opening a folder within a configured knowledge base, or disable "suo-kif.enforceKBContext" setting.'
            );
            return;
        }

        // Get KB constituents from config.xml
        kbConfig = await getKBConstituentsFromConfig(kbContext?.kbName);
        if (!kbConfig) return;

        useFullKBExport = true;
        sourceName = kbConfig.kbName;
    } else if (selected.label === 'Custom File Selection') {
        // Double-check KB context
        if (!allowKBOperations) {
            vscode.window.showWarningMessage(
                'Custom file selection requires opening a folder within a configured knowledge base, or disable "suo-kif.enforceKBContext" setting.'
            );
            return;
        }

        // Let user select files, defaulting to KB directory if available
        const defaultUri = kbContext?.kbDir ? vscode.Uri.file(kbContext.kbDir) : undefined;
        const fileSelection = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: true,
            filters: { 'KIF Files': ['kif'] },
            openLabel: 'Select KIF Files',
            defaultUri: defaultUri
        });

        if (!fileSelection || fileSelection.length === 0) return;

        customFiles = fileSelection.map(f => f.fsPath);
        sourceName = 'custom-selection';

        // Read content for JS fallback
        for (const filePath of customFiles) {
            kifContent += `; File: ${path.basename(filePath)}\n`;
            kifContent += fs.readFileSync(filePath, 'utf8') + '\n\n';
        }
    }

    // Convert
    let tptpContent = '';
    let stats = '';
    let generatorInfo = '';

    if (useNativeJS) {
        // Use sigma native converter
        let result;

        if (useFullKBExport && kbConfig) {
            result = await runSigma(kbConfig.constituents, 'EXPORT_KB', '', tptpLang);
        } else if (customFiles) {
            result = await runSigma(customFiles, 'CONVERT', '', tptpLang);
        } else {
            setLanguage(tptpLang);
            const formulas = parseKIFFormulas(kifContent);
            result = convertFormulas(formulas, sourceName, null, false);
        }

        const outputChannel = vscode.window.createOutputChannel("Sigma Compilation 2");
        outputChannel.append("Hi!");
        outputChannel.append(result);

        tptpContent = result.content;
        generatorInfo = '% Generated by: SUO-KIF VSCode Extension (Native Sigma JS Converter)';

        if (useFullKBExport && kbConfig) {
            generatorInfo += `\n% Knowledge Base: ${kbConfig.kbName}`;
            generatorInfo += `\n% Config: ${kbConfig.configPath}`;
            generatorInfo += `\n% Constituents: ${kbConfig.constituents.length} files`;
        }

        stats = `% Axiom count: ${result.axiomCount}\n`;
    } else if (useDocker || sigmaPath) {
        // Use Sigma (Docker or Local)
        let filesToLoad;
        let action;

        if (useFullKBExport && kbConfig) {
            // Use KB constituents from config.xml
            filesToLoad = kbConfig.constituents;
            action = 'EXPORT_KB';
        } else if (customFiles) {
            filesToLoad = customFiles;
            action = 'CONVERT';
        } else {
            // Get context files
            filesToLoad = await collectFilesForContext();
            if (!filesToLoad) return;
            action = 'CONVERT';
        }

        try {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: useDocker ? 'Converting via Sigma Docker...' : 'Converting via local Sigma...',
                cancellable: false
            }, async (progress) => {
                const result = await runSigma(filesToLoad, action, useFullKBExport ? '' : kifContent, tptpLang);
                tptpContent = result.content;

                if (useDocker) {
                    generatorInfo = `% Generated by: SUO-KIF VSCode Extension (Dockerized Sigma - Image: ${dockerImage})`;
                } else {
                    generatorInfo = `% Generated by: SUO-KIF VSCode Extension (Native Sigma - Path: ${sigmaPath})`;
                }

                if (useFullKBExport && kbConfig) {
                    generatorInfo += `\n% Knowledge Base: ${kbConfig.kbName}`;
                    generatorInfo += `\n% Config: ${kbConfig.configPath}`;
                    generatorInfo += `\n% Constituents: ${kbConfig.constituents.length} files`;
                }

                const fofCount = (tptpContent.match(/fof\(/g) || []).length;
                const tffCount = (tptpContent.match(/tff\(/g) || []).length;
                const thfCount = (tptpContent.match(/thf\(/g) || []).length;
                const totalCount = fofCount + tffCount + thfCount;
                stats = `% Axiom count: ${totalCount} (fof: ${fofCount}, tff: ${tffCount}, thf: ${thfCount})\n`;
            });
        } catch (err) {
            vscode.window.showErrorMessage(`Sigma conversion failed: ${err.message}`);
            return;
        }
    } else {
        vscode.window.showErrorMessage('Sigma not configured. Please set "suo-kif.sigmaPath", or enable an alternative sigma runtime');
        return;
    }

    // Open as untitled document
    const tptpDoc = await vscode.workspace.openTextDocument({
        content: `${generatorInfo}\n${stats}\n${tptpContent}`,
        language: 'tptp'
    });

    await vscode.window.showTextDocument(tptpDoc, vscode.ViewColumn.Beside);

    // Show summary
    const axiomCount = (tptpContent.match(/(fof|tff|thf)\(/g) || []).length;
    vscode.window.showInformationMessage(
        `TPTP generated: ${axiomCount} axioms from ${sourceName}. Use File > Save As to save.`
    );
}

async function collectFilesForContext() {
    const config = vscode.workspace.getConfiguration('suo-kif');
    const enforceKBContext = config.get('enforceKBContext') !== false;

    // Check if user is within a configured KB
    const kbContext = isWithinConfiguredKB();

    if (!kbContext && enforceKBContext) {
        vscode.window.showWarningMessage(
            'Context collection requires opening a folder within a configured knowledge base. ' +
            'Please open a folder from your Sigma KBs directory, or disable "suo-kif.enforceKBContext" setting.'
        );
        return null;
    }

    // 1. Ask for Context Mode
    const contextOptions = [
        { label: 'Standalone', description: 'Use only the current workspace files (no external KB)' },
        { label: 'Integrate with External KB', description: 'Load an external KB (e.g. SUMO) and add workspace files' }
    ];

    // If we detected a specific KB, offer to use it directly
    if (kbContext.kbName) {
        contextOptions.unshift({
            label: `Use ${kbContext.kbName} KB`,
            description: `Use the ${kbContext.kbName} knowledge base from config.xml (Recommended)`
        });
    }

    const selectedContext = await vscode.window.showQuickPick(contextOptions, {
        placeHolder: 'Select Knowledge Base Context'
    });

    if (!selectedContext) return null;

    const filesToLoad = [];

    // 2. Handle the selected context mode
    if (selectedContext.label.startsWith('Use ') && selectedContext.label.endsWith(' KB')) {
        // Use KB from config.xml
        const kbConfig = await getKBConstituentsFromConfig(kbContext.kbName);
        if (kbConfig) {
            return kbConfig.constituents;
        }
        return null;
    } else if (selectedContext.label === 'Integrate with External KB') {
        const config = vscode.workspace.getConfiguration('suo-kif');
        let extPath = config.get('externalKBPath');

        if (!extPath || !fs.existsSync(extPath)) {
            const selection = await vscode.window.showOpenDialog({
                canSelectFiles: false,
                canSelectFolders: true,
                canSelectMany: false,
                openLabel: 'Select External KB Directory',
                defaultUri: vscode.Uri.file(kbContext.kbDir)
            });

            if (selection && selection.length > 0) {
                extPath = selection[0].fsPath;
                // Optionally save setting
                config.update('externalKBPath', extPath, vscode.ConfigurationTarget.Global);
            } else {
                return null; // Cancelled
            }
        }

        // Collect all .kif files in external dir
        if (fs.existsSync(extPath)) {
            const extFiles = fs.readdirSync(extPath).filter(f => f.endsWith('.kif'));
            extFiles.forEach(f => filesToLoad.push(path.join(extPath, f)));
        }
    }

    // 3. Add workspace files
    const workspaceFiles = await vscode.workspace.findFiles('**/*.kif');
    workspaceFiles.forEach(f => filesToLoad.push(f.fsPath));

    return filesToLoad;
}

/**
 * Convert a single SUO-KIF expression to TPTP format (for prover queries)
 * Uses the sigma native converter
 */
function convertToTPTP(kifExpr) {
    const tptp = tptpParseSUOKIFString(kifExpr, true);
    if (!tptp) return '';
    return tptp;
}

/**
 * Convert a knowledge base to TPTP format (for prover queries)
 * Uses the sigma native converter
 */
function convertKBToTPTP(kifText) {
    const formulas = parseKIFFormulas(kifText);
    const result = convertFormulas(formulas, 'kb', null, false);

    // Extract just the axiom lines (skip header/footer for prover use)
    const lines = result.content.split('\n').filter(line =>
        line.startsWith('fof(') || line.startsWith('tff(')
    );

    return lines.join('\n');
}

/**
 * Build workspace definitions index
 */
async function buildWorkspaceDefinitions() {
    workspaceDefinitions = {};

    const files = await vscode.workspace.findFiles('**/*.kif');

    for (const file of files) {
        try {
            const doc = await vscode.workspace.openTextDocument(file);
            updateDocumentDefinitions(doc);
        } catch (e) {
            // Ignore errors reading files
        }
    }
}

/**
 * Update definitions for a specific document
 */
function updateDocumentDefinitions(document) {
    const text = document.getText();
    const uri = document.uri.fsPath;

    // Remove old definitions from this file
    for (const sym of Object.keys(workspaceDefinitions)) {
        workspaceDefinitions[sym] = workspaceDefinitions[sym].filter(d => d.file !== uri);
        if (workspaceDefinitions[sym].length === 0) {
            delete workspaceDefinitions[sym];
        }
    }

    // Add new definitions
    for (const rel of DEFINING_RELATIONS) {
        const pattern = new RegExp(
            `\\(\\s*${rel}\\s+([^?\\s\\)][^\\s\\)]*)\\s`,
            'g'
        );

        let match;
        while ((match = pattern.exec(text)) !== null) {
            const symbol = match[1];
            const startOffset = match.index;
            const lineNum = document.positionAt(startOffset).line;

            if (!workspaceDefinitions[symbol]) {
                workspaceDefinitions[symbol] = [];
            }

            workspaceDefinitions[symbol].push({
                file: uri,
                line: lineNum,
                type: rel,
                context: document.lineAt(lineNum).text.trim()
            });
        }
    }
}

/**
 * Parse TPTP file and return document symbols
 * Extracts formula declarations: fof(name, role, formula).
 */
function provideTPTPDocumentSymbols(document) {
    const symbols = [];
    const text = document.getText();

    // Pattern to match TPTP annotated formulas: type(name, role, ...)
    // Handles: thf, tff, tcf, fof, cnf, tpi
    const formulaPattern = /\b(thf|tff|tcf|fof|cnf|tpi)\s*\(\s*([^,\s]+)\s*,\s*([^,\s]+)/g;

    let match;
    while ((match = formulaPattern.exec(text)) !== null) {
        const formulaType = match[1];
        const formulaName = match[2];
        const formulaRole = match[3];

        const startOffset = match.index;
        const startPos = document.positionAt(startOffset);

        // Find the end of this formula (closing paren followed by period)
        let endOffset = findTPTPFormulaEnd(text, startOffset);
        const endPos = document.positionAt(endOffset);

        // Find the range of just the formula name for selection
        const nameStart = text.indexOf(formulaName, startOffset);
        const nameStartPos = document.positionAt(nameStart);
        const nameEndPos = document.positionAt(nameStart + formulaName.length);

        const symbolKind = TPTP_ROLES[formulaRole] || vscode.SymbolKind.Null;

        const symbol = new vscode.DocumentSymbol(
            formulaName,
            `${formulaType} ${formulaRole}`,
            symbolKind,
            new vscode.Range(startPos, endPos),
            new vscode.Range(nameStartPos, nameEndPos)
        );

        symbols.push(symbol);
    }

    // Also extract include directives
    const includePattern = /\binclude\s*\(\s*'([^']+)'/g;
    while ((match = includePattern.exec(text)) !== null) {
        const includePath = match[1];
        const startOffset = match.index;
        const startPos = document.positionAt(startOffset);

        let endOffset = text.indexOf(')', startOffset);
        if (endOffset === -1) endOffset = match.index + match[0].length;
        else endOffset++; // include the closing paren

        // Check for period after closing paren
        if (text[endOffset] === '.') endOffset++;

        const endPos = document.positionAt(endOffset);

        const symbol = new vscode.DocumentSymbol(
            includePath,
            'include',
            vscode.SymbolKind.File,
            new vscode.Range(startPos, endPos),
            new vscode.Range(startPos, endPos)
        );

        symbols.push(symbol);
    }

    return symbols;
}

/**
 * Find the end of a TPTP formula (handles nested parentheses)
 */
function findTPTPFormulaEnd(text, startOffset) {
    let i = startOffset;
    let depth = 0;
    let inString = false;
    let inSingleQuote = false;
    let escaped = false;

    while (i < text.length) {
        const char = text[i];

        if (escaped) {
            escaped = false;
            i++;
            continue;
        }

        if (char === '\\') {
            escaped = true;
            i++;
            continue;
        }

        if (char === '"' && !inSingleQuote) {
            inString = !inString;
            i++;
            continue;
        }

        if (char === "'" && !inString) {
            inSingleQuote = !inSingleQuote;
            i++;
            continue;
        }

        if (inString || inSingleQuote) {
            i++;
            continue;
        }

        if (char === '(') {
            depth++;
        } else if (char === ')') {
            depth--;
            if (depth === 0) {
                // Found the closing paren, look for the period
                i++;
                while (i < text.length && /\s/.test(text[i])) i++;
                if (i < text.length && text[i] === '.') i++;
                return i;
            }
        }

        i++;
    }

    return text.length;
}

module.exports = { activate, deactivate };