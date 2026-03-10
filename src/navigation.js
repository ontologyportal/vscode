const vscode = require('vscode');
const { DEFINING_RELATIONS } = require('./const');
const { Term, Sentence } = require('./parser');
const {
    getWorkspaceMetadata,
    setDiagnosticCollection,
    getKB,
    getSymbolTable,
} = require('./state');

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/**
 * Find all occurrences of a symbol
 * @returns 
 */
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
        { label: 'First', description: 'First Argument' },
        { label: 'Second', description: 'Second Argument' },
        { label: 'Third', description: 'Third Argument' },
        { label: 'Fourth', description: 'Fourth Argument' },
        { label: 'Antecendent', description: 'Antecedent of a conditional statement'},
        { label: 'Consequent', description: 'Consequent of a conditional statement'},
    ];

    const selectedOption = await vscode.window.showQuickPick(positionOptions, {
        placeHolder: `Filter '${symbol}' by position in expression?`
    });

    if (!selectedOption) return;

    const symbolTable = getSymbolTable();
    if (!symbolTable) {
        vscode.window.showErrorMessage(`No symbol table was found, try manually restarting the extension`);
    }
    const target = symbolTable.symbols[symbol];
    /** @type {Term} */
    const term = target.forward;
    
    /** @type {Sentence[]} */
    let matches;
    if (selectedOption.label === "All") {
        matches = Array.from(Object.values(term.locations))
    } else {
        matches = term.locations[selectedOption.label.toLowerCase()]
    }

    if (matches.length === 0) {
        vscode.window.showInformationMessage(`No occurrences of '${symbol}' found${filterPos ? ' at position ' + filterPos : ''}.`);
        return;
    }

    const selected = await vscode.window.showQuickPick(matches.map(m => {
        const token = m.node.startToken;
        const endToken = m.node.startToken;
        return { 
            label: `${vscode.workspace.asRelativePath(token.file)}:${token.line}`,
            description: m.node.toString(),
            uri: token.file,
            range: new vscode.Range(
                new vscode.Position(token.line, token.col),
                new vscode.Position(endToken.line, endToken.col)
            )
        }
    }), { placeHolder: `Occurrences of '${symbol}'` });
    if (selected) {
        const doc = await vscode.workspace.openTextDocument(selected.uri);
        const editor = await vscode.window.showTextDocument(doc);
        editor.selection = new vscode.Selection(selected.range.start, selected.range.end);
        editor.revealRange(selected.range);
    }
}

function provideDefinition(document, position) {
    const wordRange = document.getWordRangeAtPosition(position);
    if (!wordRange) return null;

    const symbol = document.getText(wordRange);
    const definitions = findDefinitions(symbol);

    return definitions.map(def => new vscode.Location(vscode.Uri.parse(`file://${def.uri}`), def.range));
}

/** 
 * Find the defining relations of the symbol
 * @param {string} symbol The symbol to look for
 * @returns {{
 *   uri: string,
 *   range: vscode.Range,
 *   type: string,
 *   context: string
 * }[]}
 */
function findDefinitions(symbol) {
    /**
     * @type {{
     *   uri: string,
     *   range: vscode.Range,
     *   type: string,
     *   context: string
     * }[]}
     */
    const definitions = [];
    const symbolTable = getSymbolTable();
    if (!symbolTable) {
        vscode.window.showErrorMessage(`No symbol table was found, try manually restarting the extension`);
        return;
    }

    for (const relationship of DEFINING_RELATIONS) {
        const sentences = symbolTable.lookup[relationship][symbol]._$;
        sentences.forEach((m) => {
            const token = m.node.startToken;
            const endToken = m.node.startToken;
            const def = { 
                type: relationship,
                context: m.node.toString(),
                uri: token.file,
                range: new vscode.Range(
                    new vscode.Position(token.line, token.col),
                    new vscode.Position(endToken.line, endToken.col)
                )
            };
            definitions.push(def);
        })
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
    const kb = getKB() || 'SUMO';
    const lang = config.get('general.language') || 'EnglishLanguage';

    const url = `${sigmaUrl}?kb=${encodeURIComponent(kb)}&lang=${encodeURIComponent(lang)}&flang=SUO-KIF&term=${encodeURIComponent(symbol)}`;

    vscode.env.openExternal(vscode.Uri.parse(url));
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
    const symbolTable = getSymbolTable(getKB());
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
    searchSymbolCommand,
    provideDefinition,
    findDefinitions,
    browseInSigmaCommand,
    setDiagnosticCollection,
    getWorkspaceMetadata,
    lookupQueryCommand,
};
