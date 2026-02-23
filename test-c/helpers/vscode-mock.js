/**
 * Minimal VS Code API mock for use with proxyquire in unit tests.
 *
 * Usage:
 *   const sinon = require('sinon');
 *   const { createVSCodeMock, createMockDocument } = require('./helpers/vscode-mock');
 *   const vscode = createVSCodeMock(sinon);
 *   // pass as stubs: proxyquire('../../src/foo', { vscode })
 */

// ---------------------------------------------------------------------------
// Value classes (do not need sinon)
// ---------------------------------------------------------------------------

class Position {
    constructor(line, character) {
        this.line = line;
        this.character = character;
    }
    translate(lineDelta, characterDelta) {
        return new Position(this.line + (lineDelta || 0), this.character + (characterDelta || 0));
    }
    isEqual(other) {
        return this.line === other.line && this.character === other.character;
    }
    isBefore(other) {
        return this.line < other.line || (this.line === other.line && this.character < other.character);
    }
}

class Range {
    constructor(startOrLine, startCharOrEnd, endLine, endChar) {
        if (startOrLine instanceof Position) {
            this.start = startOrLine;
            this.end = startCharOrEnd;
        } else {
            this.start = new Position(startOrLine, startCharOrEnd);
            this.end = new Position(endLine, endChar);
        }
    }
    get isEmpty() {
        return this.start.line === this.end.line && this.start.character === this.end.character;
    }
    contains(pos) {
        return !pos.isBefore(this.start) && (pos.isBefore(this.end) || pos.isEqual(this.end));
    }
}

class Diagnostic {
    constructor(range, message, severity) {
        this.range = range;
        this.message = message;
        this.severity = severity !== undefined ? severity : DiagnosticSeverity.Error;
    }
}

const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 };

class MarkdownString {
    constructor(value) {
        this.value = value || '';
    }
    appendMarkdown(str) {
        this.value += str;
        return this;
    }
    appendCodeblock(code, lang) {
        this.value += `\n\`\`\`${lang || ''}\n${code}\n\`\`\`\n`;
        return this;
    }
}

class CompletionItem {
    constructor(label, kind) {
        this.label = label;
        this.kind = kind;
    }
}

const CompletionItemKind = { Function: 2, Class: 5, Variable: 5, Module: 8 };

class SignatureHelp {
    constructor() {
        this.signatures = [];
        this.activeSignature = 0;
        this.activeParameter = 0;
    }
}

class SignatureInformation {
    constructor(label, documentation) {
        this.label = label;
        this.documentation = documentation;
        this.parameters = [];
    }
}

class ParameterInformation {
    constructor(label, documentation) {
        this.label = label;
        this.documentation = documentation;
    }
}

class Hover {
    constructor(contents, range) {
        this.contents = contents;
        this.range = range;
    }
}

class Location {
    constructor(uri, range) {
        this.uri = uri;
        this.range = range;
    }
}

class Selection extends Range {
    constructor(start, end) {
        super(start, end);
        this.anchor = start;
        this.active = end;
    }
}

class Uri {
    constructor(fsPath) {
        this.fsPath = fsPath;
        this.scheme = 'file';
        this.path = fsPath;
    }
    toString() { return `file://${this.fsPath}`; }
    static file(p) { return new Uri(p); }
    static parse(str) { return new Uri(str); }
}

class TextEdit {
    constructor(range, newText) {
        this.range = range;
        this.newText = newText;
    }
    static replace(range, newText) { return new TextEdit(range, newText); }
}

// ---------------------------------------------------------------------------
// Factory: creates the full vscode mock object.
// Pass sinon to get spy/stub versions of event and command functions.
// ---------------------------------------------------------------------------

function createVSCodeMock(sinon) {
    // Default config: returns undefined for any key unless tests override it
    let configValues = {};

    const configStub = {
        get: (key) => configValues[key]
    };

    const mock = {
        // Value classes
        Position,
        Range,
        Diagnostic,
        DiagnosticSeverity,
        MarkdownString,
        CompletionItem,
        CompletionItemKind,
        SignatureHelp,
        SignatureInformation,
        ParameterInformation,
        Hover,
        Location,
        Selection,
        Uri,
        TextEdit,

        // Enums
        TextEditorRevealType: { InCenter: 2 },
        StatusBarAlignment: { Right: 2 },
        ProgressLocation: { Notification: 15 },

        // workspace
        workspace: {
            getConfiguration: sinon.stub().returns(configStub),
            openTextDocument: sinon.stub().resolves(null),
            asRelativePath: sinon.stub().callsFake(uri => {
                const p = (typeof uri === 'string') ? uri : (uri.fsPath || uri.path);
                return p;
            }),
            onDidChangeWorkspaceFolders: sinon.stub().returns({ dispose: () => {} }),
            onDidOpenTextDocument: sinon.stub().returns({ dispose: () => {} }),
            onDidChangeTextDocument: sinon.stub().returns({ dispose: () => {} }),
            onDidSaveTextDocument: sinon.stub().returns({ dispose: () => {} }),
            onDidChangeConfiguration: sinon.stub().returns({ dispose: () => {} }),
            updateWorkspaceFolders: sinon.stub().returns(true),
            textDocuments: [],
            workspaceFolders: null
        },

        // window
        window: {
            activeTextEditor: null,
            showInformationMessage: sinon.stub().resolves(undefined),
            showWarningMessage: sinon.stub().resolves(undefined),
            showErrorMessage: sinon.stub().resolves(undefined),
            showQuickPick: sinon.stub().resolves(undefined),
            showInputBox: sinon.stub().resolves(undefined),
            showOpenDialog: sinon.stub().resolves(undefined),
            showTextDocument: sinon.stub().resolves({
                selection: null,
                revealRange: sinon.stub()
            }),
            createStatusBarItem: sinon.stub().returns({
                show: sinon.stub(),
                hide: sinon.stub(),
                dispose: sinon.stub(),
                text: '',
                tooltip: '',
                command: null,
                backgroundColor: undefined
            }),
            withProgress: sinon.stub().callsFake(async (opts, task) => {
                return task({ report: sinon.stub() });
            }),
            onDidChangeActiveTextEditor: sinon.stub().returns({ dispose: () => {} }),
            registerTreeDataProvider: sinon.stub().returns({ dispose: () => {} })
        },

        // languages
        languages: {
            createDiagnosticCollection: sinon.stub().callsFake((name) => {
                const diagnostics = new Map();
                return {
                    name,
                    set: sinon.stub().callsFake((uri, diags) => diagnostics.set(uri.fsPath || uri, diags)),
                    delete: sinon.stub().callsFake((uri) => diagnostics.delete(uri.fsPath || uri)),
                    clear: sinon.stub().callsFake(() => diagnostics.clear()),
                    has: (uri) => diagnostics.has(uri.fsPath || uri),
                    get: (uri) => diagnostics.get(uri.fsPath || uri),
                    dispose: sinon.stub()
                };
            }),
            registerDefinitionProvider: sinon.stub().returns({ dispose: () => {} }),
            registerDocumentFormattingEditProvider: sinon.stub().returns({ dispose: () => {} }),
            registerDocumentRangeFormattingEditProvider: sinon.stub().returns({ dispose: () => {} }),
            registerHoverProvider: sinon.stub().returns({ dispose: () => {} }),
            registerCompletionItemProvider: sinon.stub().returns({ dispose: () => {} }),
            registerSignatureHelpProvider: sinon.stub().returns({ dispose: () => {} }),
            registerDocumentSymbolProvider: sinon.stub().returns({ dispose: () => {} })
        },

        // commands
        commands: {
            registerCommand: sinon.stub().returns({ dispose: () => {} }),
            executeCommand: sinon.stub().resolves(undefined)
        },

        // env
        env: {
            openExternal: sinon.stub().resolves(true)
        }
    };

    /**
     * Override specific config values for the current test.
     * Call mock._setConfig({ 'general.formatIndentSize': 4 }) to override.
     */
    mock._setConfig = (values) => {
        configValues = { ...values };
    };

    /**
     * Reset all stubs and config values.
     */
    mock._reset = () => {
        configValues = {};
        sinon.reset();
    };

    return mock;
}

// ---------------------------------------------------------------------------
// createMockDocument
// ---------------------------------------------------------------------------

/**
 * Create a minimal VS Code TextDocument mock from a plain text string.
 * @param {string} text  Full document text
 * @param {string} [fsPath='/test/mock.kif']  URI path reported for the document
 * @param {string} [languageId='suo-kif']
 * @returns {object}  Mock document with getText, positionAt, offsetAt, lineAt, uri, etc.
 */
function createMockDocument(text, fsPath, languageId) {
    fsPath = fsPath || '/test/mock.kif';
    languageId = languageId || 'suo-kif';

    // Build a line-start index for efficient positionAt / offsetAt
    const lineStarts = [0];
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '\n') lineStarts.push(i + 1);
    }

    function positionAt(offset) {
        offset = Math.max(0, Math.min(offset, text.length));
        let lo = 0, hi = lineStarts.length - 1;
        while (lo < hi) {
            const mid = Math.floor((lo + hi + 1) / 2);
            if (lineStarts[mid] <= offset) lo = mid;
            else hi = mid - 1;
        }
        return new Position(lo, offset - lineStarts[lo]);
    }

    function offsetAt(position) {
        const line = Math.max(0, Math.min(position.line, lineStarts.length - 1));
        const lineStart = lineStarts[line];
        const lineEnd = line + 1 < lineStarts.length ? lineStarts[line + 1] - 1 : text.length;
        const col = Math.max(0, Math.min(position.character, lineEnd - lineStart));
        return lineStart + col;
    }

    function lineAt(lineOrPos) {
        const lineNum = typeof lineOrPos === 'number' ? lineOrPos : lineOrPos.line;
        const start = lineStarts[lineNum] || 0;
        const end = lineNum + 1 < lineStarts.length ? lineStarts[lineNum + 1] - 1 : text.length;
        return { text: text.substring(start, end), lineNumber: lineNum };
    }

    function getText(rangeArg) {
        if (!rangeArg) return text;
        const start = offsetAt(rangeArg.start);
        const end = offsetAt(rangeArg.end);
        return text.substring(start, end);
    }

    function getWordRangeAtPosition(position) {
        const offset = offsetAt(position);
        // Find start and end of word (letters, digits, special SUMO chars like ?, @, =, <, >, -)
        const wordChars = /[\w?@=<>\-!+*\/^&|~#.]/;
        let start = offset;
        while (start > 0 && wordChars.test(text[start - 1])) start--;
        let end = offset;
        while (end < text.length && wordChars.test(text[end])) end++;
        if (start === end) return undefined;
        return new Range(positionAt(start), positionAt(end));
    }

    return {
        getText,
        positionAt,
        offsetAt,
        lineAt,
        getWordRangeAtPosition,
        uri: new Uri(fsPath),
        fileName: fsPath,
        languageId,
        lineCount: lineStarts.length,
        isDirty: false,
        isUntitled: false
    };
}

module.exports = { createVSCodeMock, createMockDocument, Position, Range, Diagnostic, DiagnosticSeverity };
