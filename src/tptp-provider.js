const vscode = require('vscode');

const TPTP_ROLES = {
    'axiom': vscode.SymbolKind.Constant,
    'hypothesis': vscode.SymbolKind.Variable,
    'definition': vscode.SymbolKind.Class,
    'assumption': vscode.SymbolKind.Variable,
    'lemma': vscode.SymbolKind.Method,
    'theorem': vscode.SymbolKind.Method,
    'corollary': vscode.SymbolKind.Method,
    'conjecture': vscode.SymbolKind.Function,
    'negated_conjecture': vscode.SymbolKind.Function,
    'plain': vscode.SymbolKind.Field,
    'type': vscode.SymbolKind.TypeParameter,
    'interpretation': vscode.SymbolKind.Interface,
    'fi_domain': vscode.SymbolKind.Enum,
    'fi_functors': vscode.SymbolKind.EnumMember,
    'fi_predicates': vscode.SymbolKind.EnumMember,
    'unknown': vscode.SymbolKind.Null
};

function provideTPTPDocumentSymbols(document) {
    const symbols = [];
    const text = document.getText();

    const formulaPattern = /\b(thf|tff|tcf|fof|cnf|tpi)\s*\(\s*([^,\s]+)\s*,\s*([^,\s]+)/g;

    let match;
    while ((match = formulaPattern.exec(text)) !== null) {
        const formulaType = match[1];
        const formulaName = match[2];
        const formulaRole = match[3];

        const startOffset = match.index;
        const startPos = document.positionAt(startOffset);

        let endOffset = findTPTPFormulaEnd(text, startOffset);
        const endPos = document.positionAt(endOffset);

        const nameStart = text.indexOf(formulaName, startOffset);
        const nameStartPos = document.positionAt(nameStart);
        const nameEndPos = document.positionAt(nameStart + formulaName.length);

        const symbolKind = TPTP_ROLES[formulaRole] || vscode.SymbolKind.Null;

        const symbol = new vscode.DocumentSymbol(
            formulaName,
            `${formulaType} ${formulaRole}`,
            symbolKind,
            new vscode.Range(startPos, endPos),
            new vscode.Range(nameStartPos, nameEndPos)
        );

        symbols.push(symbol);
    }

    const includePattern = /\binclude\s*\(\s*'([^']+)'/g;
    while ((match = includePattern.exec(text)) !== null) {
        const includePath = match[1];
        const startOffset = match.index;
        const startPos = document.positionAt(startOffset);

        let endOffset = text.indexOf(')', startOffset);
        if (endOffset === -1) endOffset = match.index + match[0].length;
        else endOffset++; 

        if (text[endOffset] === '.') endOffset++;

        const endPos = document.positionAt(endOffset);

        const symbol = new vscode.DocumentSymbol(
            includePath,
            'include',
            vscode.SymbolKind.File,
            new vscode.Range(startPos, endPos),
            new vscode.Range(startPos, endPos)
        );

        symbols.push(symbol);
    }

    return symbols;
}

function findTPTPFormulaEnd(text, startOffset) {
    let i = startOffset;
    let depth = 0;
    let inString = false;
    let inSingleQuote = false;
    let escaped = false;

    while (i < text.length) {
        const char = text[i];

        if (escaped) {
            escaped = false;
            i++;
            continue;
        }

        if (char === '') {
            escaped = true;
            i++;
            continue;
        }

        if (char === '"' && !inSingleQuote) {
            inString = !inString;
            i++;
            continue;
        }

        if (char === "'" && !inString) {
            inSingleQuote = !inSingleQuote;
            i++;
            continue;
        }

        if (inString || inSingleQuote) {
            i++;
            continue;
        }

        if (char === '(') {
            depth++;
        } else if (char === ')') {
            depth--;
            if (depth === 0) {
                i++;
                while (i < text.length && /\s/.test(text[i])) i++;
                if (i < text.length && text[i] === '.') i++;
                return i;
            }
        }

        i++;
    }

    return text.length;
}

module.exports = {
    TPTP_ROLES,
    provideTPTPDocumentSymbols,
    findTPTPFormulaEnd
};
