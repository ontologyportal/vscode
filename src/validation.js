const vscode = require('vscode');
const { LOGIC_OPS, QUANTIFIERS } = require('./const');
const {
    tokenize,
    parse,
    syntax,
    semantics,
} = require('./state');
const {
    NodeType
} = require('./parser');

let symbolMetadata = {};

/** @type {vscode.DiagnosticCollection|null} */
let _diagnosticCollection = null;

/**
 * Set the shared diagnostic collection used by checkErrorsCommand.
 * @param {vscode.DiagnosticCollection} collection
 */
function setDiagnosticCollection(collection) {
    _diagnosticCollection = collection;
}

/**
 * Compute a VS Code Range from an AST node using its stored token offsets.
 * @param {import('./parser').ASTNode} node
 * @param {vscode.TextDocument} document
 * @returns {vscode.Range}
 */
function nodeRange(node, document) {
    const start = document.positionAt(node.start.offset);
    if (node.end) {
        return new vscode.Range(start, document.positionAt(node.end.offset));
    }
    const len = node.startToken.value ? node.startToken.value.length : 1;
    return new vscode.Range(start, document.positionAt(node.start.offset + len));
}

/**
 * Run the full syntax + semantic pipeline on an AST and return the terms map.
 * @param {import('./parser').ASTNode[]} ast
 * @param {vscode.Diagnostic[]} [diagnostics]
 * @returns {{ [name: string]: import('./parser/term').Term }}
 */
function analyse(ast, diagnostics) {
    const diags = diagnostics || [];
    const { symbolTable } = syntax(ast, diags);
    return semantics(symbolTable, diags);
}

/**
 * Validate a single AST node and recurse into its children.
 * Checks:
 *   - Operands of logical operators are valid logical sentences (not bare atoms)
 *   - The class/type argument of subclass/instance starts with an uppercase letter
 * @param {import('./parser').ASTNode} node
 * @param {vscode.Diagnostic[]} diagnostics
 * @param {object} terms (unused, kept for API compatibility)
 * @param {vscode.TextDocument} document
 */
function validateNode(node, diagnostics, terms, document) {
    if (!node || node.type !== NodeType.LIST) return;

    if (node.children.length > 0) {
        const head = node.children[0];
        if (head.type === NodeType.ATOM || head.type === NodeType.OPERATOR) {
            const op = head.startToken.value;

            if (LOGIC_OPS.includes(op)) {
                for (let i = 1; i < node.children.length; i++) {
                    validateOperand(node.children[i], diagnostics, document);
                }
            }

            if (op === 'subclass' || op === 'instance') {
                // Check first arg (the defined class/instance) and second arg (the parent class)
                for (const idx of [1, 2]) {
                    if (node.children.length > idx) {
                        const arg = node.children[idx];
                        if (arg.type === NodeType.ATOM) {
                            const firstChar = arg.startToken.value.charAt(0);
                            if (firstChar >= 'a' && firstChar <= 'z') {
                                diagnostics.push(new vscode.Diagnostic(
                                    nodeRange(arg, document),
                                    `Class/Type '${arg.startToken.value}' should start with an uppercase letter.`,
                                    vscode.DiagnosticSeverity.Warning
                                ));
                            }
                        }
                    }
                }
            }
        }
    }

    node.children.forEach(child => validateNode(child, diagnostics, terms, document));
}

/**
 * Validate that a node used as an operand of a logical operator is a valid logical sentence.
 * @param {import('./parser').ASTNode} node
 * @param {vscode.Diagnostic[]} diagnostics
 * @param {vscode.TextDocument} document
 */
function validateOperand(node, diagnostics, document) {
    if (node.type !== NodeType.LIST) {
        if (node.type === NodeType.VARIABLE || node.type === NodeType.ROW_VARIABLE) {
            return;
        }
        diagnostics.push(new vscode.Diagnostic(
            nodeRange(node, document),
            'Operand must be a logical sentence or relation, not an atom.',
            vscode.DiagnosticSeverity.Error
        ));
        return;
    }

    if (node.children.length === 0) return;
    const head = node.children[0];

    if (head.type === NodeType.ATOM) {
        const val = head.startToken.value;

        if (LOGIC_OPS.includes(val) || QUANTIFIERS.includes(val) || val === '=') {
            return;
        }

        const firstChar = val.charAt(0);

        if (firstChar >= 'a' && firstChar <= 'z') {
            return;
        }

        if (firstChar >= 'A' && firstChar <= 'Z') {
            diagnostics.push(new vscode.Diagnostic(
                nodeRange(node, document),
                `Invalid operand: '${val}' appears to be a Function or Instance (starts with Uppercase). Expected a Relation or Logical Sentence.`,
                vscode.DiagnosticSeverity.Error
            ));
        }
    }
}

/**
 * Validate variable scoping inside quantified expressions.
 * @param {import('./parser').ASTNode[]} ast
 * @param {vscode.Diagnostic[]} diagnostics
 */
function validateVariables(ast, diagnostics) {
    const visit = (node, scope = new Set()) => {
        if (node.type === NodeType.LIST && node.children.length > 0) {
            const head = node.children[0];

            if (head.type === NodeType.ATOM && QUANTIFIERS.includes(head.startToken.value)) {
                if (node.children.length >= 2 && node.children[1].type === NodeType.LIST) {
                    const varList = node.children[1];
                    const newScope = new Set(scope);

                    varList.children.forEach(v => {
                        if (v.type === NodeType.VARIABLE || v.type === NodeType.ROW_VARIABLE) {
                            newScope.add(v.startToken.value);
                        }
                    });

                    for (let i = 2; i < node.children.length; i++) {
                        visit(node.children[i], newScope);
                    }
                    return;
                }
            }

            node.children.forEach(child => visit(child, scope));
        }
    };

    ast.forEach(node => visit(node));
}

/**
 * Validate that every relation call has at least one argument.
 * @param {import('./parser').ASTNode[]} ast
 * @param {vscode.Diagnostic[]} diagnostics
 * @param {vscode.TextDocument} document
 */
function validateRelationUsage(ast, diagnostics, document) {
    const visit = (node) => {
        if (node.type === NodeType.LIST && node.children.length > 0) {
            const head = node.children[0];

            if (node.children.length === 1 && head.type === NodeType.ATOM && !LOGIC_OPS.includes(head.startToken.value)) {
                diagnostics.push(new vscode.Diagnostic(
                    nodeRange(node, document),
                    `Relation '${head.startToken.value}' has no arguments.`,
                    vscode.DiagnosticSeverity.Warning
                ));
            }

            node.children.forEach(visit);
        }
    };

    ast.forEach(visit);
}

/**
 * Check best-practice conventions for every symbol defined in this file:
 *   - Warning if no documentation string
 *   - Information if no termFormat string
 *   - Information if it is a Relation with no format string
 *
 * A symbol is "defined here" when it appears as the subject of a
 * subclass / instance / subrelation / subAttribute sentence in this file.
 * Requires semantics to have been run (sym.forward set) before calling.
 *
 * @param {import('./parser/symbol').SymbolTable} symbolTable
 * @param {vscode.TextDocument} document
 * @param {vscode.Diagnostic[]} diagnostics
 */
function validateBestPractices(symbolTable, document, diagnostics) {
    const fsPath = document.uri.fsPath;
    const TAXONOMY_DEFINING = new Set(['subclass', 'instance', 'subrelation', 'subAttribute']);
    const checked = new Set();

    for (const sentence of symbolTable.sentences) {
        if (sentence.node.file !== fsPath) continue;
        if (sentence.terms.length < 2) continue;

        const pred = sentence.terms[0]?.name;
        if (!pred || !TAXONOMY_DEFINING.has(pred)) continue;

        const subjectSym = sentence.terms[1];
        if (!subjectSym?.forward) continue;

        const term = subjectSym.forward;
        if (checked.has(term.name)) continue;
        checked.add(term.name);

        const defRange = nodeRange(sentence.node, document);

        if (term.documentation.length === 0) {
            diagnostics.push(new vscode.Diagnostic(
                defRange,
                `'${term.name}' has no documentation string.`,
                vscode.DiagnosticSeverity.Warning
            ));
        }

        if (term.termFormat.length === 0) {
            diagnostics.push(new vscode.Diagnostic(
                defRange,
                `'${term.name}' has no termFormat string.`,
                vscode.DiagnosticSeverity.Information
            ));
        }

        if (term.isRelation && term.format.length === 0) {
            diagnostics.push(new vscode.Diagnostic(
                defRange,
                `'${term.name}' is a relation but has no format string.`,
                vscode.DiagnosticSeverity.Information
            ));
        }
    }
}

/**
 * Check for circular file-level taxonomy dependencies and warn on the sentences
 * in `document` that create a dependency edge into a cycle.
 *
 * A file F depends on file G when F contains a taxonomy sentence
 * (subclass/instance/subrelation/subAttribute) whose *parent* symbol is defined
 * (i.e. appears as the subject of a taxonomy sentence) in G.
 *
 * Only direct-parent edges are considered; transitivity is handled by the graph.
 *
 * @param {import('./parser/symbol').SymbolTable} symbolTable  The global symbol table
 * @param {vscode.TextDocument} document  The file being validated
 * @param {vscode.Diagnostic[]} diagnostics
 */
function validateFileDependencies(symbolTable, document, diagnostics) {
    const TAXONOMY = new Set(['subclass', 'instance', 'subrelation', 'subAttribute']);
    const fsPath = document.uri.fsPath;

    // Pass 1 — build symbol → Set<file> for every taxonomy-defined subject
    /** @type {Map<string, Set<string>>} */
    const symbolDefFiles = new Map();
    for (const sentence of symbolTable.sentences) {
        const pred = sentence.terms[0]?.name;
        if (!pred || !TAXONOMY.has(pred) || sentence.terms.length < 2) continue;
        const subject = sentence.terms[1]?.name;
        if (!subject || !sentence.node?.file) continue;
        if (!symbolDefFiles.has(subject)) symbolDefFiles.set(subject, new Set());
        symbolDefFiles.get(subject).add(sentence.node.file);
    }

    // Pass 2 — build file dependency graph
    // fileDeps[F] = Map<G, Sentence> — F depends on G, with a representative sentence from F
    /** @type {Map<string, Map<string, import('./parser/sentence').Sentence>>} */
    const fileDeps = new Map();
    for (const sentence of symbolTable.sentences) {
        const pred = sentence.terms[0]?.name;
        if (!pred || !TAXONOMY.has(pred) || sentence.terms.length < 3) continue;
        const parent = sentence.terms[2]?.name;
        const fromFile = sentence.node?.file;
        if (!parent || !fromFile) continue;

        for (const toFile of (symbolDefFiles.get(parent) || [])) {
            if (toFile === fromFile) continue;
            if (!fileDeps.has(fromFile)) fileDeps.set(fromFile, new Map());
            // Keep the first sentence seen for this edge (used for diagnostics)
            if (!fileDeps.get(fromFile).has(toFile)) {
                fileDeps.get(fromFile).set(toFile, sentence);
            }
        }
    }

    // Pass 3 — DFS cycle detection; collect all cycle paths as arrays of file names
    const WHITE = 0, GRAY = 1, BLACK = 2;
    /** @type {Map<string, number>} */
    const color = new Map();
    /** @type {string[][]} */
    const cycles = [];

    function dfs(node, stack) {
        color.set(node, GRAY);
        stack.push(node);
        for (const dep of (fileDeps.get(node)?.keys() || [])) {
            if (color.get(dep) === GRAY) {
                const idx = stack.indexOf(dep);
                cycles.push(stack.slice(idx).concat(dep)); // dep → ... → dep
            } else if (!color.has(dep) || color.get(dep) === WHITE) {
                dfs(dep, stack);
            }
        }
        stack.pop();
        color.set(node, BLACK);
    }

    for (const file of fileDeps.keys()) {
        if (!color.has(file) || color.get(file) === WHITE) dfs(file, []);
    }

    if (cycles.length === 0) return;

    // Pass 4 — emit diagnostics for sentences in the current file that are part of a cycle
    // Build the set of outgoing edges from fsPath that appear in any cycle
    /** @type {Map<string, string[]>} */  // toFile → shortest cycle path containing it
    const cyclicEdges = new Map();
    for (const cycle of cycles) {
        for (let i = 0; i < cycle.length - 1; i++) {
            if (cycle[i] === fsPath) {
                cyclicEdges.set(cycle[i + 1], cycle);
            }
        }
    }

    if (cyclicEdges.size === 0) return;

    const path = require('path');
    const reported = new Set();

    for (const sentence of symbolTable.sentences) {
        if (sentence.node?.file !== fsPath) continue;
        const pred = sentence.terms[0]?.name;
        if (!pred || !TAXONOMY.has(pred) || sentence.terms.length < 3) continue;
        const parent = sentence.terms[2]?.name;
        if (!parent) continue;

        for (const toFile of (symbolDefFiles.get(parent) || [])) {
            if (!cyclicEdges.has(toFile)) continue;
            const key = `${sentence.node.offset}:${toFile}`;
            if (reported.has(key)) continue;
            reported.add(key);

            const cycle = cyclicEdges.get(toFile);
            const cycleStr = cycle.map(f => path.basename(f)).join(' → ');
            const start = document.positionAt(sentence.node.start.offset);
            const end = sentence.node.end
                ? document.positionAt(sentence.node.end.offset)
                : start.translate(0, 1);
            diagnostics.push(new vscode.Diagnostic(
                new vscode.Range(start, end),
                `Circular file dependency: ${cycleStr}`,
                vscode.DiagnosticSeverity.Warning
            ));
        }
    }
}

/**
 * VS Code command that runs all validation passes on the active editor document
 * and populates the Problems panel with any issues found.
 */
async function checkErrorsCommand() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const document = editor.document;
    const diagnostics = [];

    const tokens = tokenize({ doc: document }, diagnostics);

    if (diagnostics.length > 0) {
        if (_diagnosticCollection) {
            _diagnosticCollection.set(document.uri, diagnostics);
            vscode.window.showWarningMessage(`Found ${diagnostics.length} issue(s). See Problems panel for details.`);
        }
        return;
    }

    const ast = parse(tokens, diagnostics);
    ast.forEach(node => validateNode(node, diagnostics, {}, document));
    validateVariables(ast, diagnostics);
    validateRelationUsage(ast, diagnostics, document);

    const { symbols: symbolTable } = syntax(ast, diagnostics);
    semantics(symbolTable, diagnostics);
    validateBestPractices(symbolTable, document, diagnostics);
    validateFileDependencies(symbolTable, document, diagnostics);

    if (_diagnosticCollection) {
        if (diagnostics.length > 0) {
            _diagnosticCollection.set(document.uri, diagnostics);
        } else {
            _diagnosticCollection.delete(document.uri);
        }
    }

    if (diagnostics.length === 0) {
        vscode.window.showInformationMessage('No errors found in the current file.');
    } else {
        vscode.window.showWarningMessage(`Found ${diagnostics.length} issue(s). See Problems panel for details.`);
    }
}

/** @returns {{ [symbol: string]: { domains: object, documentation: string } }} */
function getSymbolMetadata() {
    return symbolMetadata;
}

/** @param {{ [symbol: string]: { domains: object, documentation: string } }} meta */
function setSymbolMetadata(meta) {
    symbolMetadata = meta;
}

module.exports = {
    tokenize,
    parse,
    syntax,
    semantics,
    validateNode,
    validateOperand,
    validateVariables,
    validateRelationUsage,
    validateBestPractices,
    validateFileDependencies,
    checkErrorsCommand,
    setDiagnosticCollection,
    getSymbolMetadata,
    setSymbolMetadata
};
