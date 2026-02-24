const vscode = require('vscode');
const { QUANTIFIERS, LOGIC_OPS } = require('./const');
const { tokenize } = require('./validation');

async function formatAxiomCommand() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const document = editor.document;
    let range = editor.selection;

    if (range.isEmpty) {
        range = findEnclosingSExpression(document, editor.selection.active);
        if (!range) {
            vscode.window.showWarningMessage('Please select an axiom to format or place cursor inside an S-expression.');
            return;
        }
    }

    const text = document.getText(range);
    const formatted = formatSExpression(text);

    if (formatted !== text) {
        await editor.edit(editBuilder => {
            editBuilder.replace(range, formatted);
        });
    }
}

function findEnclosingSExpression(document, position) {
    const text = document.getText();
    const offset = document.offsetAt(position);

    let start = -1;
    let balance = 0;

    for (let i = offset; i >= 0; i--) {
        if (text[i] === ')') balance++;
        else if (text[i] === '(') {
            if (balance === 0) {
                start = i;
                break;
            }
            balance--;
        }
    }

    if (start === -1) return null;

    balance = 1;
    for (let i = start + 1; i < text.length; i++) {
        if (text[i] === '(') balance++;
        else if (text[i] === ')') {
            balance--;
            if (balance === 0) {
                return new vscode.Range(
                    document.positionAt(start),
                    document.positionAt(i + 1)
                );
            }
        }
    }

    return null;
}

function formatSExpression(text) {
    const config = vscode.workspace.getConfiguration('sumo');
    const indentSize = config.get('general.formatIndentSize') || 2;

    const tokens = tokenize({text}, []);
    if (tokens.length === 0) return text;

    let result = '';
    let indent = 0;
    let prevToken = null;
    let parenStack = [];

    for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        const nextToken = tokens[i + 1];

        if (token.type === 'LPAREN') {
            if (prevToken && prevToken.type !== 'LPAREN') {
                result += '\n' + ' '.repeat(indent * indentSize);
            }
            result += '(';
            parenStack.push({ indent, type: 'normal' });
            indent++;

            if (nextToken && (nextToken.type === 'ATOM' || nextToken.type === 'OPERATOR') && QUANTIFIERS.includes(nextToken.value)) {
                parenStack[parenStack.length - 1].type = 'quantifier';
            }
        } else if (token.type === 'RPAREN') {
            indent = Math.max(0, indent - 1);
            if (parenStack.length > 0) parenStack.pop();
            result += ')';
        } else if (token.type === 'ATOM' || token.type === 'OPERATOR') {
            if (prevToken) {
                if (prevToken.type === 'LPAREN') {
                    result += token.value;
                } else if (prevToken.type === 'ATOM' || prevToken.type === 'OPERATOR' || prevToken.type === 'RPAREN') {
                    const currentParen = parenStack[parenStack.length - 1];
                    const parentParen = parenStack[parenStack.length - 2];

                    if (parentParen && parentParen.type === 'quantifier' && currentParen) {
                        result += ' ' + token.value;
                    } else if (LOGIC_OPS.includes(getHeadAtPosition(tokens, i)) ||
                               QUANTIFIERS.includes(getHeadAtPosition(tokens, i))) {
                        result += '\n' + ' '.repeat(indent * indentSize) + token.value;
                    } else {
                        result += ' ' + token.value;
                    }
                }
            } else {
                result += token.value;
            }
        }

        prevToken = token;
    }

    return result.trim();
}

function getHeadAtPosition(tokens, currentIndex) {
    let balance = 0;
    for (let i = currentIndex - 1; i >= 0; i--) {
        if (tokens[i].type === 'RPAREN') balance++;
        else if (tokens[i].type === 'LPAREN') {
            if (balance === 0) {
                if (i + 1 < tokens.length && (tokens[i + 1].type === 'ATOM' || tokens[i + 1].type === 'OPERATOR')) {
                    return tokens[i + 1].value;
                }
                return null;
            }
            balance--;
        }
    }
    return null;
}

function formatDocument(document) {
    const text = document.getText();
    const edits = [];

    let i = 0;
    while (i < text.length) {
        while (i < text.length && /\s/.test(text[i])) i++;
        if (i >= text.length) break;

        if (text[i] === ';') {
            while (i < text.length && text[i] !== '\n') i++;
            continue;
        }

        if (text[i] === '(') {
            const start = i;
            let balance = 1;
            i++;
            while (i < text.length && balance > 0) {
                if (text[i] === '(') balance++;
                else if (text[i] === ')') balance--;
                else if (text[i] === '"') {
                    i++;
                    while (i < text.length && text[i] !== '"') {
                        if (text[i] === '\\') i++;
                        i++;
                    }
                } else if (text[i] === ';') {
                    while (i < text.length && text[i] !== '\n') i++;
                    continue;
                }
                i++;
            }
            const end = i;
            const expr = text.substring(start, end);
            const formatted = formatSExpression(expr);

            if (formatted !== expr) {
                edits.push(vscode.TextEdit.replace(
                    new vscode.Range(document.positionAt(start), document.positionAt(end)),
                    formatted
                ));
            }
        } else {
            i++;
        }
    }

    return edits;
}

function formatRange(document, range) {
    const text = document.getText(range);
    const formatted = formatSExpression(text);

    if (formatted !== text) {
        return [vscode.TextEdit.replace(range, formatted)];
    }
    return [];
}

module.exports = {
    formatAxiomCommand,
    findEnclosingSExpression,
    formatSExpression,
    getHeadAtPosition,
    formatDocument,
    formatRange
};
