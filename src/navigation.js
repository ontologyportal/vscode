const vscode = require('vscode');
const { DEFINING_RELATIONS } = require('./const');
const { tokenize, parse } = require('./validation');
const { findConfigXml, parseConfigXml } = require('./sigma/config');
const fs = require('fs');
const path = require('path');

/** @type {{[kb: string]: { [sym: string]: {file, line, type, context}[]}}} */
let workspaceDefinitions = {}; // symbol -> [{file, line, type, context}]

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

    for (const file of files) {
        const doc = await vscode.workspace.openTextDocument(file);
        const text = doc.getText();
        
        const escapedSymbol = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\$&');
        const fastRegex = new RegExp(`\b${escapedSymbol}\b`);
        if (!fastRegex.test(text)) continue;

        const tokens = tokenize(text);
        const ast = parse(tokens, doc, []); 

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
                `\(\s*${rel}\s+(${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\$&')})\s`,
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
            `\(\s*subclass\s+(${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\$&')})\s+([^\s\)]+)`,
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

async function buildWorkspaceDefinitions() {
    workspaceDefinitions = {};

    const kbs = await getKBs();
    for (const kb of kbs) {
        const files = await getKBFiles(kb);
    
        for (const file of files) {
            try {
                const doc = await vscode.workspace.openTextDocument(file);
                updateDocumentDefinitions(doc, kb);
            } catch (e) {
            }
        }
    }
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
            `\(\s*${rel}\s+([^?\s\)][^\s\)]*)\s`,
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
    getKB
};
