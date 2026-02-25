const vscode = require('vscode');
const { DEFINING_RELATIONS } = require('./const');
const { findConfigXml, parseConfigXml } = require('./sigma/config');
const fs = require('fs');
const path = require('path');
const { TokenList, ASTNode, NodeType } = require('./parser');
const {
    parse,
    tokenize,
    collectMetadata,
    validateNode,
    validateVariables,
    validateArity,
    validateRelationUsage,
    validateCoverage
} = require('./validation');

/**
 * A full, preparsed, AST of the KB, organized by KB and constituent file
 * @type {{[kb: string]: { [constituent: string]: ASTNode[]}}}
 */
let parsedNodes = {};

/** @type {{[kb: string]: { [sym: string]: {file, line, type, context}[]}}} */
let workspaceDefinitions = {}; // symbol -> [{file, line, type, context}]

/** @type {{[fsPath: string]: any}} */
let fileMetadataCache = {};

/** @type {{[fsPath: string]: {relations: any[], docs: any[]}}} */
let taxonomyCache = {};

/** @type {any} */
let workspaceMetadataCache = null;

/** @type {vscode.DiagnosticCollection} */
let diagnosticCollection;

function setDiagnosticCollection(collection) {
    diagnosticCollection = collection;
}

/** @type {string} */
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

    const files = await getKBFiles();
    const matches = [];
    let diagnostics = [];

    for (const file of files) {
        const doc = await vscode.workspace.openTextDocument(file);
        const text = doc.getText();

        const escapedSymbol = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const fastRegex = new RegExp(`\\b${escapedSymbol}\\b`);
        if (!fastRegex.test(text)) continue;

        // Use cached AST from the last updateFileDefinitions call if available,
        // otherwise parse fresh to avoid referencing a stale or missing local parse function.
        let ast = currentKB ? parsedNodes[currentKB]?.[file.fsPath] : null;
        if (!ast) {
            try {
                const tokens = tokenize({ text, path: file.fsPath}, diagnostics);
                ast = parse(tokens, diagnostics);
            } catch {
                ast = [];
            }
        }

        const visit = (node, indexInParent) => {
            if (node.type === NodeType.ATOM) {
                if (node.startToken.value === symbol) {
                    if (filterPos === null || (indexInParent !== undefined && indexInParent + 1 === filterPos)) {
                        const pos = doc.positionAt(node.start.offset);
                        const endPos = doc.positionAt(node.start.offset + symbol.length);
                        const nodeRange = new vscode.Range(pos, endPos);
                        matches.push({
                            label: `${vscode.workspace.asRelativePath(file)}:${pos.line + 1}`,
                            description: doc.lineAt(pos.line).text.trim(),
                            uri: file,
                            range: nodeRange
                        });
                    }
                }
            } else if (node.type === NodeType.LIST) {
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

/**
 * Jump to the definition of a term
 * @returns
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

async function provideDefinition(document, position) {
    const wordRange = document.getWordRangeAtPosition(position);
    if (!wordRange) return null;

    const symbol = document.getText(wordRange);
    const definitions = await findDefinitions(symbol);

    return definitions.map(def => new vscode.Location(def.uri, def.range));
}

async function findDefinitions(symbol) {
    const definitions = [];
    const files = await getKBFiles();

    if (symbol.startsWith('?') || symbol.startsWith('@')) {
        return definitions;
    }

    for (const file of files) {
        const doc = await vscode.workspace.openTextDocument(file);
        const text = doc.getText();

        if (!text.includes(symbol)) continue;

        for (const rel of DEFINING_RELATIONS) {
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

        const subclassPattern = new RegExp(
            `\\(\\s*subclass\\s+(${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})\\s+([^\\s)]+)`,
            'g'
        );
        let match;
        while ((match = subclassPattern.exec(text)) !== null) {
            const startOffset = match.index;
            const symbolStart = text.indexOf(symbol, startOffset + 10);
            const lineNum = doc.positionAt(symbolStart).line;
            const line = doc.lineAt(lineNum).text;

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

    definitions.sort((a, b) => {
        const priority = ['instance', 'subclass', 'subrelation', 'domain', 'documentation'];
        return priority.indexOf(a.type) - priority.indexOf(b.type);
    });

    return definitions;
}

/**
 * Open the current term in the Sigma instance pointed to in the settings
 * @returns {void}
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

    if (symbol.startsWith('?') || symbol.startsWith('@')) {
        vscode.window.showWarningMessage('Cannot browse variables in Sigma.');
        return;
    }

    const config = vscode.workspace.getConfiguration('sumo');
    const sigmaUrl = config.get('sigma.url') || 'http://sigma.ontologyportal.org:8080/sigma/Browse.jsp';
    const kb = currentKB || 'SUMO';
    const lang = config.get('general.language') || 'EnglishLanguage';

    const url = `${sigmaUrl}?kb=${encodeURIComponent(kb)}&lang=${encodeURIComponent(lang)}&flang=SUO-KIF&term=${encodeURIComponent(symbol)}`;

    vscode.env.openExternal(vscode.Uri.parse(url));
}

/**
 * Extract and cache the taxonomy relations (subclass/instance/etc.) and
 * documentation entries for a single document using regex, without parsing
 * or validating.  This is the first-pass step in buildWorkspaceDefinitions
 * so that the complete KB-wide taxonomy is available before any file is
 * validated.
 * @param {vscode.TextDocument} document
 */
function buildTaxonomyEntry(document) {
    const fsPath = document.uri.fsPath;
    const text = document.getText();

    const relations = [];
    const regex = /\(\s*(subclass|subrelation|instance|subAttribute)\s+([^?\s\)][^\s\)]*)\s+([^?\s\)][^\s\)]*)/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
        relations.push({ type: match[1], child: match[2], parent: match[3] });
    }

    const docs = [];
    const docRegex = /\(\s*documentation\s+([^\s\)]+)\s+([^\s\)]+)\s+"((?:[^"\\]|\\.)*)"/g;
    let docMatch;
    while ((docMatch = docRegex.exec(text)) !== null) {
        let docStr = docMatch[3];
        docStr = docStr.replace(/"/g, '"');
        docs.push({ symbol: docMatch[1], lang: docMatch[2], text: docStr });
    }

    taxonomyCache[fsPath] = { relations, docs };
}

/**
 * Perform full preparsing of the files in all the KBs and their constituents,
 * then compile the definitions from the AST nodes.
 *
 * Uses a two-pass approach so that entity-root / coverage checks always see
 * the complete KB-wide taxonomy:
 *
 *   Pass 1 — taxonomy-only: extract subclass/instance/etc. relations and
 *             documentation strings from every constituent file via regex.
 *             No parsing or validation happens yet.
 *
 *   Pass 2 — full process: call updateFileDefinitions for every file.
 *             getWorkspaceTaxonomy() now returns the complete taxonomy, so
 *             coverage checks are not affected by file processing order.
 */
async function buildWorkspaceDefinitions() {
    const kbs = await getKBs();

    // Reset all caches — including fileMetadataCache so that metadata from
    // files removed from a KB does not persist in getWorkspaceMetadata().
    parsedNodes = {};
    workspaceDefinitions = {};
    taxonomyCache = {};
    fileMetadataCache = {};
    workspaceMetadataCache = null;

    const fileDocs = []; // collected for pass 2

    // Pass 1: build taxonomy for ALL files before any validation runs.
    for (const kb of kbs) {
        const files = await getKBFiles(kb);
        parsedNodes[kb] = {};
        workspaceDefinitions[kb] = {};
        for (const file of files) {
            if (diagnosticCollection) diagnosticCollection.delete(file);
            try {
                const doc = await vscode.workspace.openTextDocument(file);
                buildTaxonomyEntry(doc);
                fileDocs.push({ doc, kb });
            } catch (e) {
                // console.error(`Error opening ${file.fsPath}:`, e);
            }
        }
    }

    // Pass 2: parse and validate every file against the now-complete taxonomy.
    for (const { doc, kb } of fileDocs) {
        try {
            updateFileDefinitions(doc, kb);
        } catch (e) {
            // console.error(`Error processing ${doc.uri.fsPath}:`, e);
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
 *   If omitted, the function attempts to infer it from parsedNodes.
 */
function updateFileDefinitions(document, kb = undefined) {
    const fsPath = document.uri.fsPath;
    const text = document.getText();

    if (!kb) {
        if (currentKB && parsedNodes[currentKB]) kb = currentKB;
        else {
             for (const k in parsedNodes) {
                 if (parsedNodes[k][fsPath] !== undefined) {
                     kb = k;
                     break;
                 }
             }
        }
    }
    if (!kb) return;

    if (!parsedNodes[kb]) parsedNodes[kb] = {};
    if (!workspaceDefinitions[kb]) workspaceDefinitions[kb] = {};

    // --- Taxonomy cache (relations and docs for the tree view) ---
    // Built BEFORE validation so that getWorkspaceTaxonomy() includes this file's
    // own edges when validateCoverage runs.  Extracted via regex rather than the
    // AST so this works even when the file has parse errors.
    const relations = [];
    const docs = [];
    const regex = /\(\s*(subclass|subrelation|instance|subAttribute)\s+([^?\s\)][^\s\)]*)\s+([^?\s\)][^\s\)]*)/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
        relations.push({ type: match[1], child: match[2], parent: match[3] });
    }
    const docRegex = /\(\s*documentation\s+([^\s\)]+)\s+([^\s\)]+)\s+"((?:[^"\\]|\\.)*)"/g;
    let docMatch;
    while ((docMatch = docRegex.exec(text)) !== null) {
        let docStr = docMatch[3];
        docStr = docStr.replace(/"/g, '"');
        docs.push({ symbol: docMatch[1], lang: docMatch[2], text: docStr });
    }
    taxonomyCache[fsPath] = { relations, docs };

    // --- Parse and validate in one pass ---
    const diagnostics = [];
    try {
        // tokenize() from validation.js wraps the tokenize provided by parser and
        // converts any ParsingErrors into a diagnostic, only returning the list of tokens
        const tokens = tokenize({text, path: fsPath}, diagnostics);

        // parse() from validation.js wraps TokenList and converts any ParsingError
        // into a diagnostic, returning [] on failure rather than throwing.
        const ast = parse(tokens, diagnostics);
        parsedNodes[kb][fsPath] = ast;

        if (ast.length > 0) {
            // Collect domain/documentation metadata needed for arity checking
            const metadata = collectMetadata(ast);
            fileMetadataCache[fsPath] = metadata;

            // Run all validation passes, accumulating into the same diagnostics array
            ast.forEach(node => validateNode(node, diagnostics, metadata, document));
            validateVariables(ast, diagnostics);
            validateArity(ast, diagnostics, metadata, document);
            validateRelationUsage(ast, diagnostics, document);
            // Pass the KB-wide taxonomy so coverage checks can trace parent chains
            // across files, not just within the current file.
            validateCoverage(ast, diagnostics, metadata, document, getWorkspaceTaxonomy());
        }
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

    updateDocumentDefinitions(document, kb);
}

function getWorkspaceTaxonomy() {
    const parentGraph = {};
    const childGraph = {};
    const docMap = {};
    const targetLang = vscode.workspace.getConfiguration('sumo').get('general.language') || 'EnglishLanguage';

    for (const fsPath in taxonomyCache) {
        const { relations, docs } = taxonomyCache[fsPath];
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
 * Aggregate metadata (domains and documentation) from across all files in the workspace.
 * Prefers documentation in the target language.
 * @returns {{ [symbol: string]: { domains: {[pos: number]: string}, documentation: string, docLang: string } }}
 */
function getWorkspaceMetadata() {
    if (workspaceMetadataCache) return workspaceMetadataCache;
    
    const combined = {};
    const targetLang = vscode.workspace.getConfiguration('sumo').get('general.language') || 'EnglishLanguage';

    for (const fsPath in fileMetadataCache) {
        const metadata = fileMetadataCache[fsPath];
        for (const [sym, data] of Object.entries(metadata)) {
            if (!combined[sym]) {
                combined[sym] = { domains: {}, documentation: '', docLang: '' };
            }

            // Merge domains: union of all domain declarations found
            if (data.domains) {
                Object.assign(combined[sym].domains, data.domains);
            }

            // Merge documentation: prefer target language
            if (data.documentation) {
                const existing = combined[sym];
                if (!existing.documentation || data.docLang === targetLang || existing.docLang !== targetLang) {
                    existing.documentation = data.documentation;
                    existing.docLang = data.docLang;
                }
            }
        }
    }
    workspaceMetadataCache = combined;
    return combined;
}

/**
 * populate the relationships for symbols in a document in a kb
 * @param {vscode.TextDocument} document
 * @param {undefined | string} kb
 */
function updateDocumentDefinitions(document, kb = undefined) {
    if (!kb) kb = currentKB;
    if (!kb) return;
    const text = document.getText();
    const uri = document.uri.fsPath;

    for (const sym of Object.keys(workspaceDefinitions[kb])) {
        workspaceDefinitions[kb][sym] = workspaceDefinitions[kb][sym].filter(d => d.file !== uri);
        if (workspaceDefinitions[kb][sym].length === 0) {
            delete workspaceDefinitions[kb][sym];
        }
    }

    for (const rel of DEFINING_RELATIONS) {
        const pattern = new RegExp(
            `\\(\\s*${rel}\\s+([^?\\s)][^\\s)]*)\\s`,
            'g'
        );

        let match;
        while ((match = pattern.exec(text)) !== null) {
            const symbol = match[1];
            const startOffset = match.index;
            const lineNum = document.positionAt(startOffset).line;

            if (!workspaceDefinitions[kb][symbol]) {
                workspaceDefinitions[kb][symbol] = [];
            }

            workspaceDefinitions[kb][symbol].push({
                file: uri,
                line: lineNum,
                type: rel,
                context: document.lineAt(lineNum).text.trim()
            });
        }
    }
}

module.exports = {
    getKBFiles,
    searchSymbolCommand,
    goToDefinitionCommand,
    provideDefinition,
    findDefinitions,
    browseInSigmaCommand,
    buildWorkspaceDefinitions,
    updateDocumentDefinitions,
    setKB,
    getKB,
    setDiagnosticCollection,
    updateFileDefinitions,
    getWorkspaceTaxonomy,
    getWorkspaceMetadata
};
