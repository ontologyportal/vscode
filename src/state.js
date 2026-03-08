/** Central state management module for the current knowledge bases */

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const { findConfigXml, parseConfigXml } = require('./sigma/config');
const {
    Term, SymbolTable, syntax, semantics: rawSemantics, tokenize,
    TokenList, Sentence, OperatorSentence,
} = require('./parser');
const { Formula } = require('./parser/formula');

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
 * Per-KB symbol tables, needed for per-file updates and reanalysis.
 * Each KB gets its own isolated SymbolTable so cross-KB references
 * (e.g. circular dependency detection) are never falsely reported.
 * @type {{[kb: string]: SymbolTable}}
 */
let _symbolTables = {};

/**
 * Per-KB taxonomy cache, keyed first by KB name then by file path.
 * @type {{[kb: string]: {[fsPath: string]: {relations: object[], docs: object[]}}}}
 */
let taxonomyCache = {};

/**
 * Per-KB metadata cache (invalidated on file update or KB switch).
 * @type {{[kb: string]: object}}
 */
let workspaceMetadataCache = {};

/**
 * Global diagnostics collection
 * @type {vscode.DiagnosticCollection}
 */
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
function getDiagnosticCollection() {
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
    delete workspaceMetadataCache[kb]; // force re-computation for the newly active KB
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
 * @param {{[name: string]: Term}} newTerms The new terms to inject
 */
function setTerms(kb, newTerms) {
    if (!(kb in terms)) terms[kb] = {};
    Object.assign(terms[kb], newTerms);
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
 * Get the symbol table for the given KB (or the current KB if omitted).
 * @param {string} [kb]
 * @returns {SymbolTable|undefined}
 */
function getSymbolTable(kb) {
    return _symbolTables[kb ?? currentKB];
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
    return [];
}

/**
 * Parse a token list into an AST, converting any ParsingError into a VS Code diagnostic.
 * @param {import('./parser').Token[]} tokens
 * @param {vscode.Diagnostic[]} diagnostics
 * @returns {import('./parser').ASTNode[]}
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
 * Tokenize a string into a list of tokens, converting any TokenizerErrors into a VS Code diagnostic.
 * @param {{text?: string, file?: string, doc?: vscode.TextDocument}} source
 * @param {vscode.Diagnostic[]} diagnostics
 * @returns {import('./parser').Token[]}
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
 * Wrapper for syntax to correctly capture errors.
 * @param {import('./parser/parser').ASTNode[]} nodes
 * @param {vscode.Diagnostic[]} diagnostics
 * @param {SymbolTable?} existingTable
 * @returns {{ symbolTable: SymbolTable, sentences: import('./parser/sentence').Sentence[] }}
 */
function syntaxWrapper(nodes, diagnostics, existingTable) {
    const { symbolTable, errors, syntax: sentences } = syntax(nodes, existingTable);
    for (const e of errors) {
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
 * @param {import('./parser/symbol').SymbolTable} symbolTable
 * @param {vscode.Diagnostic[]} diagnostics
 * @returns {{ [name: string]: import('./parser/term').Term }}
 */
function semanticsWrapper(symbolTable, diagnostics) {
    const {terms: termMap, errors } = rawSemantics(symbolTable);
    const terms = {};
    for (const [name, sym] of Object.entries(symbolTable.symbols)) {
        const term = termMap.get(sym);
        if (term) terms[name] = term;
    }
    for (const e of errors) {
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
 * Recursively build Formula objects for a sentence and all nested sentences.
 * @param {import('./parser/sentence').Sentence} sentence
 */
function buildFormulaTree(sentence) {
    new Formula(sentence);
    for (const t of sentence.terms) {
        if (t instanceof Sentence) {
            buildFormulaTree(t);
        }
    }
}

/**
 * Build Formula objects for every root sentence in the symbol table.
 * Must be called after semanticsWrapper so that sym.forward is set.
 * @param {SymbolTable} symbolTable
 */
function buildFormulas(symbolTable) {
    for (const s of symbolTable.sentences) {
        buildFormulaTree(s);
    }
}

/**
 * Call Formula.validate() (which cascades into Term.validate()) for every
 * root sentence that belongs to `fsPath`. Converts SemanticErrors to
 * VS Code Error diagnostics.
 * @param {SymbolTable} symbolTable
 * @param {string} fsPath
 * @param {vscode.Diagnostic[]} diagnostics
 */
function validateSemantics(symbolTable, fsPath, diagnostics) {
    for (const sentence of symbolTable.sentences) {
        if (sentence.node?.file !== fsPath) continue;
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
            try {
                const { startLine, startCol, endLine, endCol } = e.getRange();
                range = new vscode.Range(
                    new vscode.Position(startLine, startCol),
                    new vscode.Position(endLine, endCol)
                );
            } catch (_) {
                range = new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 1));
            }
            diagnostics.push(new vscode.Diagnostic(range, e.details || e.message, vscode.DiagnosticSeverity.Error));
        }
    }
}

const TAXONOMY_PREDICATES = new Set(['subclass', 'instance', 'subAttribute', 'subrelation']);

/**
 * Build a taxonomy cache entry by scanning sentences for a specific file.
 * O(sentences_in_file) rather than O(all_terms × all_sentences).
 * @param {SymbolTable} symbolTable
 * @param {string} fsPath  Only include sentences from this file
 * @returns {{ relations: object[], docs: object[] }}
 */
function termsToTaxonomy(symbolTable, fsPath) {
    const relations = [];
    const docs = [];
    for (const sentence of symbolTable.sentences) {
        if (sentence.node.file !== fsPath) continue;
        const terms = sentence.terms;
        if (!terms.length) continue;
        const pred = terms[0]?.name;
        if (!pred) continue;

        if (TAXONOMY_PREDICATES.has(pred) && terms.length >= 3) {
            const child = terms[1]?.name;
            const parent = terms[2]?.name;
            if (child && parent) relations.push({ type: pred, child, parent });
        } else if (pred === 'documentation' && terms.length >= 4) {
            const symbol = terms[1]?.name;
            const lang = terms[2]?.name;
            const raw = terms[3]?.value ?? terms[3]?.name ?? '';
            const text = (raw.startsWith('"') && raw.endsWith('"'))
                ? raw.slice(1, -1) : raw;
            if (symbol && lang) docs.push({ symbol, lang, text });
        }
    }
    return { relations, docs };
}

/**
 * Aggregate all per-file taxonomy caches into a workspace-wide taxonomy.
 * @returns {{ parents: object, children: object, documentation: object }}
 */
function getWorkspaceTaxonomy() {
    const parentGraph = {};
    const childGraph = {};
    const docMap = {};
    const targetLang = vscode.workspace.getConfiguration('sumo').get('general.language') || 'EnglishLanguage';

    for (const fsPath in (taxonomyCache[currentKB] || {})) {
        const { relations, docs } = taxonomyCache[currentKB][fsPath];
        for (const r of relations) {
            if (!parentGraph[r.child]) parentGraph[r.child] = [];
            if (!parentGraph[r.child].some(p => p.name === r.parent && p.type === r.type)) {
                parentGraph[r.child].push({ name: r.parent, type: r.type });
            }
            if (!childGraph[r.parent]) childGraph[r.parent] = [];
            if (!childGraph[r.parent].some(c => c.name === r.child && c.type === r.type)) {
                childGraph[r.parent].push({ name: r.child, type: r.type });
            }
        }
        for (const d of docs) {
            if (!docMap[d.symbol] || d.lang === targetLang || docMap[d.symbol].lang !== targetLang) {
                docMap[d.symbol] = { text: d.text, lang: d.lang };
            }
        }
    }

    const documentation = {};
    for (const [s, d] of Object.entries(docMap)) {
        documentation[s] = d.text;
    }

    return { parents: parentGraph, children: childGraph, documentation };
}

/**
 * Aggregate hover/completion metadata (domains and documentation) across all files.
 * @returns {{ [symbol: string]: { domains: {[pos: number]: string}, documentation: string, docLang: string } }}
 */
function getWorkspaceMetadata() {
    if (workspaceMetadataCache[currentKB]) return workspaceMetadataCache[currentKB];

    const combined = {};
    const targetLang = vscode.workspace.getConfiguration('sumo').get('general.language') || 'EnglishLanguage';
    const kbTable = _symbolTables[currentKB];
    if (!kbTable) return combined;

    for (const [name, sym] of Object.entries(kbTable.symbols)) {
        if (!sym.forward) continue;
        const term = sym.forward;
        combined[name] = { domains: {}, documentation: '', docLang: '' };
        const entry = combined[name];

        try {
            const domain = term.domain;
            if (domain) {
                for (let i = 1; i < domain.length; i++) {
                    if (domain[i]) entry.domains[i] = domain[i].name;
                }
            }
        } catch (_) {
            // Malformed domain statement — skip domain info for this term
        }

        for (const { language, text } of term.documentation) {
            let docText = text;
            if (docText.startsWith('"') && docText.endsWith('"')) {
                docText = docText.substring(1, docText.length - 1);
            }
            if (!entry.documentation || language === targetLang || entry.docLang !== targetLang) {
                entry.documentation = docText;
                entry.docLang = language;
            }
        }
    }

    workspaceMetadataCache[currentKB] = combined;
    return combined;
}

/**
 * Perform full preparsing of the files in all the KBs and their constituents,
 * then compile the definitions from the AST nodes. This method will reconstruct
 * everything, clearing the term cache.
 * @param {{ report: (value: { message?: string }) => void } | undefined} progress
 *   Optional VS Code progress reporter. When provided, reports "n/total" after
 *   each file is processed.
 */
async function buildWorkspaceDefinitions(progress) {
    const kbs = await getKBs();

    clearTerms();
    _symbolTables = {};
    taxonomyCache = {};
    workspaceMetadataCache = {};

    // Pre-collect all files so we can show an accurate total in the progress message.
    const kbFiles = [];
    for (const kb of kbs) {
        const files = await getKBFiles(kb);
        kbFiles.push({ kb, files });
        terms[kb] = {};
        _symbolTables[kb] = new SymbolTable();
    }
    const total = kbFiles.reduce((sum, { files }) => sum + files.length, 0);
    let done = 0;

    for (const { kb, files } of kbFiles) {
        for (const file of files) {
            try {
                const doc = await vscode.workspace.openTextDocument(file);
                updateFileDefinitions(doc, kb);
            } catch (e) {
                vscode.window.showErrorMessage(
                    `Failed to open constituent file in KB ${kb}: ${file.fsPath}`
                );
                console.error(e);
            }
            done++;
            if (progress) progress.report({ message: `${done}/${total} files` });
        }
    }
}

/**
 * Parse a document, run all validation passes, and update the workspace definition index.
 * This is the single entry point for processing a file.
 *
 * @param {vscode.TextDocument} document
 * @param {string | undefined} kb  The knowledge base this document belongs to.
 */
function updateFileDefinitions(document, kb = undefined) {
    const fsPath = document.uri.fsPath;
    const text = document.getText();

    if (diagnosticCollection) diagnosticCollection.delete(document.uri);

    if (!kb) {
        if (!currentKB) {
            return;  // No KB context yet — skip validation until a KB is opened
        }
        kb = currentKB;
    }

    // Ensure a SymbolTable exists for this KB (handles files saved before buildWorkspaceDefinitions)
    if (!_symbolTables[kb]) _symbolTables[kb] = new SymbolTable();

    const diagnostics = [];
    try {
        // Remove stale data from this file before re-parsing
        _symbolTables[kb].removeFile(fsPath);

        const tokens = tokenizeWrapper({ text, path: fsPath }, diagnostics);
        const ast = parseWrapper(tokens, diagnostics);
        const { symbolTable } = syntaxWrapper(ast, diagnostics, _symbolTables[kb]);
        _symbolTables[kb] = symbolTable;

        const fileTerms = semanticsWrapper(_symbolTables[kb], diagnostics);
        setTerms(kb, fileTerms);

        // Build Formula objects and run semantic validation
        buildFormulas(_symbolTables[kb]);
        validateSemantics(_symbolTables[kb], fsPath, diagnostics);

        // Update taxonomy cache and invalidate this KB's metadata cache
        if (!taxonomyCache[kb]) taxonomyCache[kb] = {};
        taxonomyCache[kb][fsPath] = termsToTaxonomy(_symbolTables[kb], fsPath);
        delete workspaceMetadataCache[kb];

        // Run best-practice and dependency warnings (lazy import avoids circular require)
        const { validateBestPractices, validateFileDependencies } = require('./validation');
        validateBestPractices(_symbolTables[kb], document, diagnostics);
        // Pass only this KB's symbol table so cross-KB file edges are never flagged
        validateFileDependencies(_symbolTables[kb], document, diagnostics);
    } catch (e) {
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
    getSymbolTable,
    buildWorkspaceDefinitions,
    updateFileDefinitions,
    getWorkspaceTaxonomy,
    getWorkspaceMetadata,
    tokenize: tokenizeWrapper,
    parse: parseWrapper,
    syntax: syntaxWrapper,
    semantics: semanticsWrapper
};
