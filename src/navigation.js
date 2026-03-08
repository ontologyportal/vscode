const vscode = require('vscode');
const { DEFINING_RELATIONS } = require('./const');
const { findConfigXml, parseConfigXml } = require('./sigma/config');
const fs = require('fs');
const path = require('path');
const { NodeType } = require('./parser');
const { parse, tokenize } = require('./validation');
const {
    buildWorkspaceDefinitions,
    updateFileDefinitions,
    getWorkspaceTaxonomy,
    getWorkspaceMetadata,
    setDiagnosticCollection,
    setKB: stateSetKB,
    getSymbolTable,
} = require('./state');

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/** @type {string|null} Currently active knowledge base name */
let currentKB = null;

/**
 * Set the active knowledge base name.
 * @param {string|null} name
 */
function setKB(name) {
    currentKB = name;
    stateSetKB(name);
}

/**
 * Get the active knowledge base name.
 * @returns {string|null}
 */
function getKB() {
    return currentKB;
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

        let ast;
        try {
            const tokens = tokenize({ text, path: file.fsPath }, diagnostics);
            ast = parse(tokens, diagnostics);
        } catch {
            ast = [];
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
 * Query the current KB's symbol table using the lookup proxy syntax and show
 * results in a QuickPick list, allowing the user to jump to any matching sentence.
 *
 * Query syntax examples:
 *   subclass._SYM_._SYM_.$        — all (subclass X Y) sentences
 *   documentation._SYM_._$        — all documentation sentences
 *   $_. Entity._$                 — sentences containing "Entity" anywhere
 *   _OP_._SYM_._SYM_.$            — all binary operator sentences
 */
async function lookupQueryCommand() {
    const symbolTable = getSymbolTable(currentKB);
    if (!symbolTable) {
        vscode.window.showWarningMessage('No knowledge base is loaded. Open a KB first.');
        return;
    }

    const queryStr = await vscode.window.showInputBox({
        prompt: 'Enter a lookup query (property chain on the lookup proxy)',
        placeHolder: 'e.g.  subclass._SYM_._SYM_.$   or   $_.Entity._$',
        ignoreFocusOut: true,
    });
    if (!queryStr) return;

    let matches;
    try {
        // Evaluate the query string as a property chain on the lookup proxy.
        // Using Function constructor to avoid leaking outer scope variables.
        // eslint-disable-next-line no-new-func
        const evalQuery = new Function('lookup', `return lookup.${queryStr}`);
        const result = evalQuery(symbolTable.lookup);
        if (!(result instanceof Set)) {
            vscode.window.showErrorMessage(
                'Query did not return a result set. Did you forget to terminate with .$ or ._$ ?'
            );
            return;
        }
        matches = result;
    } catch (e) {
        vscode.window.showErrorMessage('Invalid query: ' + e.message);
        return;
    }

    if (matches.size === 0) {
        vscode.window.showInformationMessage('No sentences matched the query.');
        return;
    }

    const items = [];
    for (const sentence of matches) {
        const node = sentence.node;
        if (!node?.startToken) continue;

        const file = node.startToken.file;
        const line = node.startToken.line; // 0-based from tokenizer
        const col  = node.startToken.column ?? 0;

        // Build a preview from the raw KIF text if we can find the file
        let preview = '';
        try {
            const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
            preview = doc.lineAt(line).text.trim();
        } catch {
            // file not open; skip preview
        }

        const relPath = vscode.workspace.asRelativePath(file);
        items.push({
            label: `${relPath}:${line + 1}`,
            description: preview,
            filePath: file,
            line,
            col,
        });
    }

    if (items.length === 0) {
        vscode.window.showInformationMessage('No located sentences matched the query.');
        return;
    }

    // Sort by file path then line number for a consistent order
    items.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.line - b.line);

    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: `${items.length} sentence(s) matched — select to jump`,
        matchOnDescription: true,
    });

    if (selected) {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(selected.filePath));
        const editor = await vscode.window.showTextDocument(doc);
        const pos = new vscode.Position(selected.line, selected.col);
        const range = new vscode.Range(pos, pos);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
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
    setKB,
    getKB,
    setDiagnosticCollection,
    updateFileDefinitions,
    getWorkspaceTaxonomy,
    getWorkspaceMetadata,
    lookupQueryCommand,
};
