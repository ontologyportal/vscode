const vscode = require('vscode');
const { LOGIC_OPS, QUANTIFIERS } = require('./const');

let symbolMetadata = {};

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
                if (text[i] === '') { i += 2; continue; }
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
            
            if (current >= tokens.length) {
                diagnostics.push(new vscode.Diagnostic(
                    new vscode.Range(document.positionAt(node.start), document.positionAt(node.start + 1)),
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
    const targetLang = vscode.workspace.getConfiguration('sumo').get('language') || 'EnglishLanguage';
    
    const visit = (node) => {
        if (node.type === 'list' && node.children.length >= 4) {
            const head = node.children[0];
            
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
            
            if (head.type === 'atom' && head.value === 'documentation') {
                const symNode = node.children[1];
                const langNode = node.children[2];
                const docNode = node.children[3]; 
                
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

function validateNode(node, diagnostics, metadata) {
    if (!node || node.type !== 'list') return;

    if (node.children.length > 0) {
        const head = node.children[0];
        if (head.type === 'atom') {
            const op = head.value;
            if (LOGIC_OPS.includes(op)) {
                for (let i = 1; i < node.children.length; i++) {
                    validateOperand(node.children[i], diagnostics);
                }
            }

            if (op === 'subclass' || op === 'instance') {
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
        }
    }

    node.children.forEach(child => validateNode(child, diagnostics, metadata));
}

function validateOperand(node, diagnostics) {
    if (node.type === 'atom') {
        if (node.value.startsWith('?') || node.value.startsWith('@')) {
            return;
        }

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
            
            if (LOGIC_OPS.includes(val) || QUANTIFIERS.includes(val) || val === '=') {
                return;
            }

            const firstChar = val.charAt(0);
            
            if (firstChar >= 'a' && firstChar <= 'z') {
                return;
            }
            
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

function validateVariables(ast, diagnostics) {
    const visit = (node, scope = new Set(), quantifierVars = new Set()) => {
        if (node.type === 'list' && node.children.length > 0) {
            const head = node.children[0];

            if (head.type === 'atom' && QUANTIFIERS.includes(head.value)) {
                if (node.children.length >= 2 && node.children[1].type === 'list') {
                    const varList = node.children[1];
                    const newScope = new Set(scope);

                    varList.children.forEach(v => {
                        if (v.type === 'atom' && (v.value.startsWith('?') || v.value.startsWith('@'))) {
                            newScope.add(v.value);
                        }
                    });

                    for (let i = 2; i < node.children.length; i++) {
                        visit(node.children[i], newScope, quantifierVars);
                    }
                    return;
                }
            }

            node.children.forEach(child => visit(child, scope, quantifierVars));
        } else if (node.type === 'atom') {
            const val = node.value;
        }
    };

    ast.forEach(node => visit(node));
}

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

function validateRelationUsage(ast, diagnostics, metadata) {
    const visit = (node) => {
        if (node.type === 'list' && node.children.length > 0) {
            const head = node.children[0];

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

async function checkErrorsCommand() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const document = editor.document;

    const diagnostics = [];
    const text = document.getText();
    const tokens = tokenize(text);
    const ast = parse(tokens, document, diagnostics);
    const metadata = collectMetadata(ast);

    ast.forEach(node => validateNode(node, diagnostics, metadata));
    validateVariables(ast, diagnostics);
    validateArity(ast, diagnostics, metadata);
    validateRelationUsage(ast, diagnostics, metadata);

    const collection = vscode.languages.createDiagnosticCollection('sumo-check');
    collection.set(document.uri, diagnostics);

    if (diagnostics.length === 0) {
        vscode.window.showInformationMessage('No errors found in the current file.');
    } else {
        vscode.window.showWarningMessage(`Found ${diagnostics.length} issue(s). See Problems panel for details.`);
    }
}

function getSymbolMetadata() {
    return symbolMetadata;
}

function setSymbolMetadata(meta) {
    symbolMetadata = meta;
}

module.exports = {
    tokenize,
    parse,
    collectMetadata,
    validateNode,
    validateOperand,
    validateVariables,
    validateArity,
    validateRelationUsage,
    checkErrorsCommand,
    getSymbolMetadata,
    setSymbolMetadata
};
