/** Central state management module for the current knowledge bases */

const vscode = require('vscode');

const { findConfigXml, parseConfigXml } = require('./sigma/config');
const { Term, SymbolTable, syntax, semantics, tokenize } = require('./parser');

// Global state variables

/**
 * Semantic terms produced by syntax() + semantics() for each processed file.
 * Populated by updateFileDefinitions(); consumed by getWorkspaceTaxonomy(),
 * getWorkspaceMetadata(), and any future feature that needs the full model.
 * @type {{
 *   [kb: string]: {
 *     [name: string]: import('./parser/term').Term
 *   }
 * }}
 */
let terms = {};

/**
 * The global symbol table, needed for per-file updates and reanalysis
 * @type {SymbolTable}
 */
let _symbolTable = new SymbolTable();

/**
 * Global diagnostics collection 
 * @type {vscode.DiagnosticCollection}
 * */
let diagnosticCollection;

/**
 * Set a global diagnostic collection
 * @param {vscode.DiagnosticCollection} collection 
 */
function setDiagnosticCollection(collection) {
    diagnosticCollection = collection;
}

/**
 * Get the global diagnostic collection
 * @returns {vscode.DiagnosticCollection|null}
 */
function getDiagnosticCollection(collection) {
    return diagnosticCollection;
}

/**
 * The current knowledge base 
 * @type {string}
 */
let currentKB = null;

/**
 * Set the current KB being browsed
 * @param {string} kb The name of the KB
 */
function setKB(kb) {
    currentKB = kb;
}

/**
 * Get the current KB being browsed
 * @returns {string|null} The name of the current KB
 */
function getKB() {
    return currentKB;
}

/**
 * Set the compiled terms
 * @param {string} kb The KB to set the terms for
 * @param {[name: string]: Term} newTerms The new terms to inject
 */
function setTerms(kb, newTerms) {
    if (!(kb in terms)) terms[kb] = {};
    terms = Object.assign(terms[kb], newTerms);
}

/**
 * Get the compiled terms mapping
 * @param {string} kb The KB to get the terms for
 * @returns {{[name: string]: Term}} The terms
 */
function getTerms(kb) {
    return terms[kb];
}

/**
 * Clears the terms cache
 * @param {string?} kb The KB to clear the terms for (if null, clear all)
 */
function clearTerms(kb) {
    if (kb) {
        delete terms[kb];
    } else {
        terms = {};
    }
}

/**
 * Get all knowledge bases in the current context
 * @returns {Promise<string[]>}
 */
async function getKBs() {
    const configPath = await findConfigXml();
    if (configPath) {
        const parsed = await parseConfigXml(configPath);
        if (parsed) {
            return Object.keys(parsed.knowledgeBases).flat();
        }
    }
    return [];
}

/**
 * Get all the files for a KB
 * @param {undefined | string} kbName Whether to fetch a specific KB's files
 * @returns {Promise<vscode.Uri[]>}
 */
async function getKBFiles(kbName = undefined) {
    if (!kbName) kbName = currentKB;
    if (!kbName) return [];
    const configPath = await findConfigXml();
    if (configPath) {
        const parsed = await parseConfigXml(configPath);
        if (parsed) {
            const kbDir = parsed.preferences.kbDir || path.dirname(configPath);
            const seen = new Set();
            const uris = [];
            if (!(kbName in parsed.knowledgeBases)) {
                throw new Error("Could not find kb");
            }
            const kb = parsed.knowledgeBases[kbName];
            for (const c of kb.constituents) {
                const abs = path.isAbsolute(c) ? c : path.join(kbDir, c);
                if (!seen.has(abs) && fs.existsSync(abs)) {
                    seen.add(abs);
                    uris.push(vscode.Uri.file(abs));
                }
            }
            if (uris.length > 0) return uris;
        }
    }
    return []
}

/**
 * Parse a token list into an AST, converting any ParsingError into a VS Code diagnostic.
 * On a parse error the diagnostic is pushed and an empty array is returned, so callers
 * can always treat the return value as a (possibly empty) AST without further error handling.
 * @param {import('./parser').Token[]} tokens - Token array from tokenize()
 * @param {vscode.Diagnostic[]} diagnostics - Accumulator array; parse errors are pushed here
 * @returns {import('./parser').ASTNode[]} Parsed top-level AST nodes
 */
function parseWrapper(tokens, diagnostics) {
    const list = new TokenList(tokens);
    const { nodes, errors } = list.parse();
    for (const e of errors) {
        const startPos = new vscode.Position(e.line, e.column);
        let endPos = startPos.translate(0, 1);
        diagnostics.push(new vscode.Diagnostic(
            new vscode.Range(startPos, endPos),
            e.error || e.message,
            vscode.DiagnosticSeverity.Error
        ));
    }
    return nodes;
}

/**
 * Tokenize a string into a list of tokens, converting any TokenizerErrors into a VS Code diagnostic.
 * On a tokenize error the diagnostic is pushed and the token array is returned, so callers
 * can always treat the return value as a list of tokens without further error handling.
 * @param {{text?: string, file?: string, doc?: vscode.TextDocument}} source - The source document (used for diagnostic positions)
 * @param {vscode.Diagnostic[]} diagnostics - Accumulator array; parse errors are pushed here
 * @returns {import('./parser').Token[]} Parsed top-level AST nodes
 */
function tokenizeWrapper(source, diagnostics) {
    let {text, doc, path} = source;
    if (!text && !doc) throw new Error("tokenize must be provided either a text/doc property");
    if (!text) {
        text = doc.getText();
        path = doc.uri.path
    }
    const {tokens, errors} = tokenize(text, path);
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
 * Wrapper for syntax and semantics to correctly capture errors
 * @param {import('./parser/parser').ASTNode[]} nodes ASTNodes from the parse step
 * @param {vscode.Diagnostic[]} diagnostics - Accumulator array; parse errors are pushed here
 * @param {SymbolTable?} symbolTable - AThe symbol table
 * @returns {{
 *   sentences: import('./parser/symbol').Sentence[],
 *   symbols: import('./parser/symbol').SymbolTable
 * }} Both the parsed sentences and symbol table
 */
function syntaxWrapper(nodes, diagnostics, symbolTable) {
    const { symbolTable, errors, syntax: sentences } = syntax(nodes, symbolTable);
    for (const e of errors) {
        const pos = new vscode.Position(e.lineStart, e.colStart);
        const endPos = e.lineEnd ? pos.translate(0, 1) : new vscode.Position(e.lineEnd, e.colEnd);
        diagnostics.push(new vscode.Diagnostic(
            new vscode.Range(pos, endPos),
            e.details || e.message,
            vscode.DiagnosticSeverity.Error
        ));
    }
    return { symbols: symbolTable, sentences };
}

/** 
 * Wrapper for semantics to correctly capture errors
 * @param {import('./parser/symbol').Sentence[]} sentences An array of sentences from syntax step
 * @param {import('./parser/symbol').SymbolTable} symbolTable The symbol table generated from the syntax step
 * @param {vscode.Diagnostic[]} diagnostics - Accumulator array; parse errors are pushed here
 * @returns {{ [name: string]: import('./parser/semantics').Term }} The terms parsed
 */
function semanticsWrapper(symbolTable, diagnostics) {
    const { terms, errors } = semantics(symbolTable);
    for (const e of errors) {
        const { startCol, startLine, endCol, endLine } = e.getRange();
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
 * Perform full preparsing of the files in all the KBs and their constituents,
 * then compile the definitions from the AST nodes.
 *
 * Uses the logic in parser/ to construct a full list of terms. This method
 *  will reconstruct everything clearing the term cache 
 */
async function buildWorkspaceDefinitions() {
    // Get all knowledge bases
    const kbs = await getKBs();

    // Reset all caches so stale data from removed files does not persist.
    clearTerms();
    _symbolTable = new SymbolTable();

    // Run parsing against all KBs and all files in all KBs
    for (const kb of kbs) {
        const files = await getKBFiles(kb);
        terms[kb] = {};
        for (const file of files) {
            try {
                const doc = await vscode.workspace.openTextDocument(file);
                // Update that file
                updateFileDefinitions(doc, kb);
            } catch (e) {
                vscode.window.showErrorMessage(
                    `Failed to open constituent file in KB ${kb}: ${file.fsPath}`
                );
                console.error(e);
            }
        }
    }
}

/**
 * Parse a document, run all validation passes, and update the workspace definition index.
 * This is the single entry point for processing a file — it replaces the separate
 * tokenize/parse calls that previously existed alongside validation.js.
 *
 * Diagnostics from both parsing (ParsingError, TokenizerError) and validation
 * (logic structure, arity, variable scoping) are collected in one pass and
 * written to the diagnostic collection together.
 *
 * @param {vscode.TextDocument} document
 * @param {string | undefined} kb  The knowledge base this document belongs to.
 *   If omitted, the function attempts to infer it from the current state.
 */
function updateFileDefinitions(document, kb = undefined) {
    const fsPath = document.uri.fsPath;
    const text = document.getText();

    // Clear the diagnotics for that particular file
    if (diagnosticCollection) diagnosticCollection.delete(document.uri);

    if (!kb) {
        if (!currentKB) {
            throw new Error("SUMO Knowledge Base is currently undefined");
        }
        kb = currentKB;
    }
    // The full pipeline runs here and the results are cached at the module level.
    // Other consumers (getWorkspaceTaxonomy, getWorkspaceMetadata, the taxonomy
    // view, etc.) read from those caches without re-running the compiler.

    // Array to hold errors to show to the user
    const diagnostics = [];
    try {
        // Generate tokens
        const tokens = tokenizeWrapper({text, path: fsPath}, diagnostics);
        const ast = parseWrapper(tokens, diagnostics);
        const { sentences, symbolTable } = syntaxWrapper(ast, diagnostics, _symbolTable);
        _symbolTable = symbolTable;
        const terms = semanticsWrapper(_symbolTable, diagnostics)
        setTerms(kb, terms);

        // --- Run validation passes directly against the terms ---
        ast.forEach(node => validateNode(node, diagnostics, terms, document));
        validateVariables(ast, diagnostics);
        validateArity(ast, diagnostics, terms, document);
        validateRelationArity(ast, diagnostics, terms, document, getWorkspaceTaxonomy());
        validateDomainTypes(ast, diagnostics, terms, document, getWorkspaceTaxonomy());
        validateRelationUsage(ast, diagnostics, document);
        validateCoverage(ast, diagnostics, terms, document, getWorkspaceTaxonomy());
    } catch (e) {
        // Unexpected error
        // Add a best-effort diagnostic and log for debugging.
        // console.error(`Error processing ${fsPath}:`, e);
        const line = e.line !== undefined ? e.line : 0;
        const col = e.col !== undefined ? e.col : (e.column !== undefined ? e.column : 0);
        diagnostics.push(new vscode.Diagnostic(
            new vscode.Range(line, col, line, col),
            e.message || 'Unknown error',
            vscode.DiagnosticSeverity.Error
        ));
    }

    if (diagnosticCollection) {
        if (diagnostics.length > 0) {
            diagnosticCollection.set(document.uri, diagnostics);
        } else {
            diagnosticCollection.delete(document.uri);
        }
    }
    workspaceMetadataCache = null;
}

module.exports = {
    setDiagnosticCollection,
    getDiagnosticCollection,
    setKB,
    getKB,
    getKBs,
    getKBFiles,
    setTerms,
    getTerms,
    clearTerms,
    buildWorkspaceDefinitions
};