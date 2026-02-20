const vscode = require('vscode');
const { tokenize } = require('./validation');

let symbolMetadata = {};

function setSymbolMetadata(meta) {
    symbolMetadata = meta;
}

function provideHover(document, position, token) {
    const range = document.getWordRangeAtPosition(position);
    if (!range) return;
    const word = document.getText(range);
    const meta = symbolMetadata[word];
    if (meta && meta.documentation) {
        const md = new vscode.MarkdownString();
        md.appendMarkdown(meta.documentation);
        return new vscode.Hover(md);
    }
}

function provideCompletionItems(document, position, token, context) {
    const items = [];
    for (const [key, val] of Object.entries(symbolMetadata)) {
        const item = new vscode.CompletionItem(key, vscode.CompletionItemKind.Function);
        if (val.documentation) {
            item.documentation = new vscode.MarkdownString(val.documentation);
        }
        if (val.domains) {
            const types = Object.entries(val.domains).map(([p, t]) => `Arg ${p}: ${t}`).join(', ');
            item.detail = types;
        }
        items.push(item);
    }
    return items;
}

function provideSignatureHelp(document, position, token) {
    const text = document.getText();
    const offset = document.offsetAt(position);
    
    let balance = 0;
    let start = -1;
    for (let i = offset - 1; i >= 0; i--) {
        if (text[i] === ')') balance++;
        else if (text[i] === '(') {
            if (balance > 0) balance--;
            else {
                start = i;
                break;
            }
        }
    }
    
    if (start === -1) return null;
    
    const rangeText = text.substring(start, offset);
    const tokens = tokenize(rangeText);
    
    if (tokens.length < 2) return null;
    if (tokens[0].type !== 'LPAREN') return null;
    if (tokens[1].type !== 'ATOM') return null;
    
    const op = tokens[1].value;
    const meta = symbolMetadata[op];
    if (!meta) return null;
    
    let siblingCount = 0;
    let currentTokenIndex = 2; 
    
    while (currentTokenIndex < tokens.length) {
        const t = tokens[currentTokenIndex];
        siblingCount++;
        
        if (t.type === 'LPAREN') {
            let bal = 1;
            currentTokenIndex++;
            while (currentTokenIndex < tokens.length && bal > 0) {
                if (tokens[currentTokenIndex].type === 'LPAREN') bal++;
                else if (tokens[currentTokenIndex].type === 'RPAREN') bal--;
                currentTokenIndex++;
            }
        } else {
            currentTokenIndex++;
        }
    }
    
    let paramIndex = 0;
    if (/\s$/.test(rangeText)) {
        paramIndex = siblingCount;
    } else {
        paramIndex = Math.max(0, siblingCount - 1);
    }
    
    const sigHelp = new vscode.SignatureHelp();
    
    const domainIndices = Object.keys(meta.domains || {}).map(k => parseInt(k));
    const maxDomain = domainIndices.length > 0 ? Math.max(...domainIndices) : 0;
    const count = Math.max(maxDomain, paramIndex + 1);
    
    let label = `(${op}`;
    const params = [];
    
    for (let i = 1; i <= count; i++) {
        const type = (meta.domains && meta.domains[i]) ? meta.domains[i] : 'Term';
        const pLabel = ` ?arg${i}: ${type}`;
        label += pLabel;
        const paramDoc = new vscode.MarkdownString(`**Type**: `);
        paramDoc.appendCodeblock(type, 'sumo');
        params.push(new vscode.ParameterInformation(pLabel, paramDoc));
    }
    label += ')';
    
    const sig = new vscode.SignatureInformation(label, new vscode.MarkdownString(meta.documentation || ''));
    sig.parameters = params;
    
    sigHelp.signatures = [sig];
    sigHelp.activeSignature = 0;
    sigHelp.activeParameter = paramIndex;
    
    return sigHelp;
}

module.exports = {
    setSymbolMetadata,
    provideHover,
    provideCompletionItems,
    provideSignatureHelp
};
