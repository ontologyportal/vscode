const vscode = require('vscode');

const LOGIC_OPS = ['and', 'or', 'not', '=>', '<=>'];
const QUANTIFIERS = ['forall', 'exists'];
let symbolMetadata = {};

function activate(context) {
    const diagnosticCollection = vscode.languages.createDiagnosticCollection('suo-kif');
    context.subscriptions.push(diagnosticCollection);

    // Register Search Command
    context.subscriptions.push(vscode.commands.registerCommand('suo-kif.searchSymbol', searchSymbolCommand));
    context.subscriptions.push(vscode.commands.registerCommand('suo-kif.showTaxonomy', showTaxonomyCommand));

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

module.exports = { activate, deactivate };