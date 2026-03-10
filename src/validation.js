const vscode = require('vscode');
const {
    tokenize,
    Token,
    TokenList,
    ASTNode,
    syntax,
    semantics,
    SyntaxError,
    SemanticError,
    Formula,
    Sentence,
    OperatorSentence,
    SymbolTable,
    Term
} = require('./parser');

let symbolMetadata = {};

/**
 * VSCode diagnostic collection
 * @type {vscode.DiagnosticCollection}
 */
let _diagnosticCollection; 

/**
 * Set the shared diagnostic collection used by checkErrorsCommand.
 * @param {vscode.DiagnosticCollection} collection
 */
function setDiagnosticCollection(collection) {
    _diagnosticCollection = collection;
}
/**
 * Compute a VS Code Range from an AST node using its stored token offsets.
 * @param {ASTNode} node
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
 * Tokenize a string into a list of tokens, converting any TokenizerErrors into a VS Code diagnostic.
 * @param {{text?: string, file?: string, doc?: vscode.TextDocument}} source
 * @param {vscode.Diagnostic[]} diagnostics
 * @returns {Token[]}
 */
function tokenizeWrapper(source, diagnostics) {
    let { text, doc, path: filePath } = source;
    if (!text && !doc) throw new Error("tokenize must be provided either a text/doc property");
    if (!text) {
        text = doc.getText();
        filePath = doc.uri.fsPath;
    }
    const { tokens, errors } = tokenize(text, filePath);
    for (const e of errors) {
        const pos = new vscode.Position(e.line, e.col);
        diagnostics.push(new vscode.Diagnostic(
            new vscode.Range(pos, pos.translate(0, 1)),
            e.error || e.message,
            vscode.DiagnosticSeverity.Error
        ));
    }
    return tokens;
}

/**
 * Parse a token list into an AST, converting any ParsingError into a VS Code diagnostic.
 * @param {Token[]} tokens
 * @param {vscode.Diagnostic[]} diagnostics
 * @returns {ASTNode[]}
 */
function parseWrapper(tokens, diagnostics) {
    const list = new TokenList(tokens);
    const { nodes, errors } = list.parse();
    for (const e of errors) {
        const startPos = new vscode.Position(e.line, e.column);
        diagnostics.push(new vscode.Diagnostic(
            new vscode.Range(startPos, startPos.translate(0, 1)),
            e.error || e.message,
            vscode.DiagnosticSeverity.Error
        ));
    }
    return nodes;
}

/**
 * Wrapper for syntax to correctly capture errors.
 * @param {ASTNode[]} nodes
 * @param {vscode.Diagnostic[]} diagnostics
 * @param {SymbolTable?} existingTable
 * @returns {{ symbolTable: SymbolTable, sentences: Sentence[] }}
 */
function syntaxWrapper(nodes, diagnostics, existingTable) {
    const { symbolTable, errors, syntax: sentences } = syntax(nodes, existingTable);
    for (const e of errors) {
        if (!(e instanceof SyntaxError)) {
            continue;
        }
        const pos = new vscode.Position(e.lineStart ?? 0, e.colStart ?? 0);
        const endPos = e.lineEnd != null
            ? new vscode.Position(e.lineEnd, e.colEnd ?? 0)
            : pos.translate(0, 1);
        diagnostics.push(new vscode.Diagnostic(
            new vscode.Range(pos, endPos),
            e.details || e.message,
            vscode.DiagnosticSeverity.Error
        ));
    }
    return { symbolTable, sentences };
}

/**
 * Run the semantics pass — builds Term objects on the symbolTable (sym.forward is set).
 * @param {SymbolTable} symbolTable
 * @param {vscode.Diagnostic[]} diagnostics
 * @returns {{ [name: string]: Term }}
 */
function semanticsWrapper(symbolTable, diagnostics) {
    const {terms: termMap, errors } = semantics(symbolTable);
    const terms = {};
    for (const [name, sym] of Object.entries(symbolTable.symbols)) {
        const term = termMap.get(sym);
        if (term) terms[name] = term;
    }
    for (const e of errors) {
        if (!(e instanceof SemanticError)) {
            console.error(e);
            continue;
        }
        const {startLine, startCol, endLine, endCol} = e.getRange();
        const pos = new vscode.Position(startLine, startCol);
        const endPos = new vscode.Position(endLine, endCol);
        diagnostics.push(new vscode.Diagnostic(
            new vscode.Range(pos, endPos),
            e.details || e.message,
            vscode.DiagnosticSeverity.Error
        ));
    }
    return terms;
}

/**
 * Call Formula.validate() (which cascades into Term.validate()) for every
 * root sentence that belongs to `fsPath`. Converts SemanticErrors to
 * VS Code Error diagnostics.
 * @param {SymbolTable} symbolTable
 * @param {{[file: string]: vscode.Diagnostic[]}} diagnostics
 */
function validateSemantics(symbolTable, diagnostics) {
    for (const sentence of symbolTable.sentences) {
        const formula = sentence.forward || new Formula(sentence);
        if (!formula) continue;

        // For non-operator sentences, only validate when the head symbol has
        // at least one taxonomy declaration in this KB.  If it has none, the
        // symbol is completely unknown here (e.g. a SUMO built-in declared in
        // another file) and we cannot distinguish "wrong type" from "not yet
        // declared" — skip rather than emit a false positive.
        if (!(sentence instanceof OperatorSentence)) {
            const headForward = sentence.terms[0]?.forward;
            if (!headForward) continue;
            const { incoming, outgoing } = headForward.taxonomy;
            if (incoming.length === 0 && outgoing.length === 0) continue;
        }

        try {
            formula?.validate();
        } catch (e) {
            let range;
            if (!(e instanceof SemanticError)) {
                console.error(e);
                continue;
            }
            try {
                const { startLine, startCol, endLine, endCol } = e.getRange();
                range = new vscode.Range(
                    new vscode.Position(startLine, startCol),
                    new vscode.Position(endLine, endCol)
                );
            } catch (_) {
                range = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 1));
            }
            if (!(sentence.node.file in diagnostics)) diagnostics[sentence.node.file] = [];
            diagnostics[sentence.node.file].push(new vscode.Diagnostic(range, e.details || e.message, vscode.DiagnosticSeverity.Error));
        }
    }
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
                vscode.DiagnosticSeverity.Hint
            ));
        }

        if (term.isRelation && term.format.length === 0) {
            diagnostics.push(new vscode.Diagnostic(
                defRange,
                `'${term.name}' is a relation but has no format string.`,
                vscode.DiagnosticSeverity.Hint
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

    const tokens = tokenizeWrapper({ doc: document }, diagnostics);

    if (diagnostics.length > 0) {
        if (_diagnosticCollection) {
            _diagnosticCollection.set(document.uri, diagnostics);
            vscode.window.showWarningMessage(`Found ${diagnostics.length} issue(s). See Problems panel for details.`);
        }
        return;
    }

    const ast = parseWrapper(tokens, diagnostics);

    const { symbolTable } = syntaxWrapper(ast, diagnostics);
    semanticsWrapper(symbolTable, diagnostics);
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
    tokenize: tokenizeWrapper,
    parse: parseWrapper,
    syntax: syntaxWrapper,
    semantics: semanticsWrapper,
    validateSemantics,
    validateBestPractices,
    validateFileDependencies,
    checkErrorsCommand,
    getSymbolMetadata,
    setSymbolMetadata,
    setDiagnosticCollection
};
