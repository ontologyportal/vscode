const vscode = require('vscode');
const { DEFINING_RELATIONS } = require('./const');
const { findConfigXml, parseConfigXml } = require('./sigma/config');
const fs = require('fs');
const path = require('path');
const { NodeType } = require('./parser');
const {
    parse,
    tokenize,
    syntax,
    semantics,
    validateNode,
    validateVariables,
    validateArity,
    validateRelationArity,
    validateDomainTypes,
    validateRelationUsage,
    validateCoverage
} = require('./validation');
const {
    Symbol: KIFSymbol,
    ValueLiteral,
    FunctionalSentence,
} = require('./parser/symbol');

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/** @type {string|null} Currently active knowledge base name */
let currentKB = null;

/** @type {{[kb: string]: {[fsPath: string]: import('./parser').ASTNode[]}}} */
let parsedNodes = {};

/** @type {{[kb: string]: {[symbol: string]: object}}} */
let workspaceDefinitions = {};

/** @type {{[fsPath: string]: {relations: object[], docs: object[]}}} */
let taxonomyCache = {};

/** @type {{[fsPath: string]: {[name: string]: import('./parser/term').Term}}} */
let semanticTermsCache = {};

/** @type {object|null} */
let workspaceMetadataCache = null;

/** @type {import('vscode').DiagnosticCollection|null} */
let diagnosticCollection = null;

/**
 * Set the active knowledge base name.
 * @param {string|null} name
 */
function setKB(name) {
    currentKB = name;
}

/**
 * Get the active knowledge base name.
 * @returns {string|null}
 */
function getKB() {
    return currentKB;
}

/**
 * Set the shared diagnostic collection used by updateFileDefinitions.
 * @param {import('vscode').DiagnosticCollection} collection
 */
function setDiagnosticCollection(collection) {
    diagnosticCollection = collection;
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
 * Get the list of known knowledge base names from the Sigma config.
 * @returns {Promise<string[]>}
 */
async function getKBs() {
    const configPath = await findConfigXml();
    if (!configPath) return [];
    const config = await parseConfigXml(configPath);
    if (!config?.knowledgeBases) return [];
    return Object.keys(config.knowledgeBases);
}

/**
 * Get all the files for a KB.
 * @param {string | undefined} kbName Which KB's files to fetch (defaults to currentKB)
 * @returns {Promise<vscode.Uri[]>}
 */
async function getKBFiles(kbName = undefined) {
    if (!kbName) kbName = currentKB;
    if (!kbName) return [];
    const configPath = await findConfigXml();
    if (!configPath) return [];
    const config = await parseConfigXml(configPath);
    if (!config?.knowledgeBases?.[kbName]) return [];
    const constituents = config.knowledgeBases[kbName].constituents || [];
    return constituents
        .filter(p => fs.existsSync(p))
        .map(p => vscode.Uri.file(p));
}

/**
 * Perform full two-pass parsing of all KBs:
 *   Pass 1 — parse every file and build the KB-wide taxonomy cache.
 *   Pass 2 — re-run full validation on every file so that coverage checks
 *             have access to the complete cross-file taxonomy.
 */
async function buildWorkspaceDefinitions() {
    const kbs = await getKBs();

    // Reset all caches so stale data from removed files does not persist.
    parsedNodes = {};
    workspaceDefinitions = {};
    taxonomyCache = {};
    workspaceMetadataCache = null;
    semanticTermsCache = {};

    const fileDocs = []; // collected for pass 2

    // Pass 1: parse every file and populate the taxonomy cache.
    for (const kb of kbs) {
        const files = await getKBFiles(kb);
        parsedNodes[kb] = {};
        workspaceDefinitions[kb] = {};
        for (const file of files) {
            try {
                const doc = await vscode.workspace.openTextDocument(file);
                fileDocs.push({ doc, kb });

                const diags = [];
                const tokens = tokenize({ text: doc.getText(), path: file.fsPath }, diags);
                const ast = parse(tokens, diags);
                parsedNodes[kb][file.fsPath] = ast;

                if (diags.length === 0) {
                    const { symbols: symbolTable } = syntax(ast, diags);
                    const terms = semantics(symbolTable, diags);
                    semanticTermsCache[file.fsPath] = terms;
                    taxonomyCache[file.fsPath] = termsToTaxonomy(terms);
                }
            } catch (e) {
                // continue with remaining files
            }
        }
    }

    // Pass 2: validate every file against the now-complete taxonomy.
    for (const { doc, kb } of fileDocs) {
        try {
            updateFileDefinitions(doc, kb);
        } catch (e) {
            // continue with remaining files
        }
    }
}

/**
 * Parse a document, run all validation passes, and update the workspace
 * definition index.  Diagnostics are written to the shared collection.
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
            throw new Error("SUMO Knowledge Base is currently undefined");
        }
        kb = currentKB;
    }

    const diagnostics = [];
    try {
        const tokens = tokenize({ text, path: fsPath }, diagnostics);
        const ast = parse(tokens, diagnostics);
        const { symbols: symbolTable } = syntax(ast, diagnostics);
        const terms = semantics(symbolTable, diagnostics);
        if (!parsedNodes[kb]) parsedNodes[kb] = {};
        parsedNodes[kb][fsPath] = ast;

        semanticTermsCache[fsPath] = terms;
        taxonomyCache[fsPath]      = termsToTaxonomy(terms);

        ast.forEach(node => validateNode(node, diagnostics, terms, document));
        validateVariables(ast, diagnostics);
        validateArity(ast, diagnostics, terms, document);
        validateRelationArity(ast, diagnostics, terms, document, getWorkspaceTaxonomy());
        validateDomainTypes(ast, diagnostics, terms, document, getWorkspaceTaxonomy());
        validateRelationUsage(ast, diagnostics, document);
        validateCoverage(ast, diagnostics, terms, document, getWorkspaceTaxonomy());
    } catch (e) {
        const line = e.line !== undefined ? e.line : 0;
        const col  = e.col  !== undefined ? e.col  : (e.column !== undefined ? e.column : 0);
        diagnostics.push(new vscode.Diagnostic(
            new vscode.Range(line, col, line, col),
            `Unexpected error: ${e.message}`,
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

/**
 * Build the taxonomyCache entry format from a semantic terms map.
 * Each outgoing taxonomy edge contributes one relation record.
 * Documentation strings have their outer quotes stripped.
 * @param {{ [name: string]: import('./parser/term').Term }} terms
 * @returns {{ relations: {type: string, child: string, parent: string}[], docs: {symbol: string, lang: string, text: string}[] }}
 */
function termsToTaxonomy(terms) {
    const relations = [];
    const docs = [];
    for (const term of Object.values(terms)) {
        for (const edge of term.taxonomy.outgoing) {
            // edge.from = source (2nd arg), edge.to = destination (1st arg)
            // child = destination (more specific), parent = source (more general)
            relations.push({ type: edge.relation, child: edge.to.name, parent: edge.from.name });
        }
        for (const { language, text } of term.documentation) {
            let docText = text;
            if (docText.startsWith('"') && docText.endsWith('"')) {
                docText = docText.substring(1, docText.length - 1);
            }
            docs.push({ symbol: term.name, lang: language, text: docText });
        }
    }
    return { relations, docs };
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
 * Aggregate hover/completion metadata (domains and documentation) across all files.
 * Built directly from semanticTermsCache — no separate metadata cache needed.
 * Prefers documentation in the target language.
 * @returns {{ [symbol: string]: { domains: {[pos: number]: string}, documentation: string, docLang: string } }}
 */
function getWorkspaceMetadata() {
    if (workspaceMetadataCache) return workspaceMetadataCache;

    const combined = {};
    const targetLang = vscode.workspace.getConfiguration('sumo').get('general.language') || 'EnglishLanguage';

    for (const terms of Object.values(semanticTermsCache)) {
        for (const [sym, term] of Object.entries(terms)) {
            if (!combined[sym]) combined[sym] = { domains: {}, documentation: '', docLang: '' };
            const entry = combined[sym];

            // Merge domains from domain/domainSubclass sentences
            for (const sentence of term.locations.first ?? []) {
                const pred = sentence.functionalTerm.name;
                if (pred !== 'domain' && pred !== 'domainSubclass') continue;
                const posArg  = sentence.terms[1];
                const typeArg = sentence.terms[2];
                if (posArg instanceof ValueLiteral && typeArg instanceof KIFSymbol) {
                    const pos = parseInt(posArg.value);
                    if (!isNaN(pos)) entry.domains[pos] = typeArg.name;
                }
            }

            // Merge documentation, preferring targetLang
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
    }

    workspaceMetadataCache = combined;
    return combined;
}

module.exports = {
    getKBFiles,
    searchSymbolCommand,
    goToDefinitionCommand,
    provideDefinition,
    findDefinitions,
    browseInSigmaCommand,
    buildWorkspaceDefinitions,
    setKB,
    getKB,
    setDiagnosticCollection,
    updateFileDefinitions,
    getWorkspaceTaxonomy,
    getWorkspaceMetadata
};
