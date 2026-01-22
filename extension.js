const vscode = require('vscode');

const LOGIC_OPS = ['and', 'or', 'not', '=>', '<=>'];
const QUANTIFIERS = ['forall', 'exists'];

function activate(context) {
    const diagnosticCollection = vscode.languages.createDiagnosticCollection('suo-kif');
    context.subscriptions.push(diagnosticCollection);
    let symbolMetadata = {};

    // Register Search Command
    context.subscriptions.push(vscode.commands.registerCommand('suo-kif.searchSymbol', searchSymbolCommand));

    const validate = (document) => {
        if (document.languageId !== 'suo-kif') return;

        const diagnostics = [];
        const text = document.getText();
        const tokens = tokenize(text);
        const ast = parse(tokens, document, diagnostics);
        symbolMetadata = collectMetadata(ast);

        ast.forEach(node => validateNode(node, diagnostics, symbolMetadata));

        diagnosticCollection.set(document.uri, diagnostics);
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

function deactivate() {}

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
                const docNode = node.children[3]; // (documentation <sym> <lang> <string>)
                
                if (symNode.type === 'atom' && docNode.type === 'atom') {
                    const sym = symNode.value;
                    let doc = docNode.value;
                    if (doc.startsWith('"') && doc.endsWith('"')) {
                        doc = doc.substring(1, doc.length - 1);
                    }
                    
                    if (!metadata[sym]) metadata[sym] = { domains: {}, documentation: '' };
                    metadata[sym].documentation = doc;
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
    const files = await vscode.workspace.findFiles('**/*.kif');
    const matches = [];

    for (const file of files) {
        const doc = await vscode.workspace.openTextDocument(file);
        const text = doc.getText();
        const regex = new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');
        let match;
        while ((match = regex.exec(text)) !== null) {
            const pos = doc.positionAt(match.index);
            matches.push({
                label: `${vscode.workspace.asRelativePath(file)}:${pos.line + 1}`,
                description: doc.lineAt(pos.line).text.trim(),
                uri: file,
                range: new vscode.Range(pos, doc.positionAt(match.index + symbol.length))
            });
        }
    }

    const selected = await vscode.window.showQuickPick(matches, { placeHolder: `Occurrences of '${symbol}'` });
    if (selected) {
        const doc = await vscode.workspace.openTextDocument(selected.uri);
        const editor = await vscode.window.showTextDocument(doc);
        editor.selection = new vscode.Selection(selected.range.start, selected.range.end);
        editor.revealRange(selected.range);
    }
}

module.exports = { activate, deactivate };