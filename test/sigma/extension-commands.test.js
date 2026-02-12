/**
 * Tests for extension.js command functions and helpers.
 *
 * All VSCode APIs and external modules are mocked via proxyquire so the
 * tests run in a plain Node/Mocha environment without a VSCode host.
 */

const assert = require('assert');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
const path = require('path');
const os = require('os');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Shared mock factories
// ---------------------------------------------------------------------------

function makeRange(startLine, startChar, endLine, endChar) {
    return {
        start: { line: startLine, character: startChar },
        end: { line: endLine, character: endChar },
        isEmpty: startLine === endLine && startChar === endChar
    };
}

function makePosition(line, character) {
    return { line, character };
}

function makeDocument(text, opts = {}) {
    const lines = text.split('\n');
    return {
        getText: sinon.stub().callsFake((range) => {
            if (!range) return text;
            // Simplified: return a slice based on line offsets
            const startOff = lines.slice(0, range.start.line).join('\n').length + (range.start.line > 0 ? 1 : 0) + range.start.character;
            const endOff = lines.slice(0, range.end.line).join('\n').length + (range.end.line > 0 ? 1 : 0) + range.end.character;
            return text.substring(startOff, endOff);
        }),
        languageId: opts.languageId || 'sumo',
        uri: { fsPath: opts.fsPath || '/mock/file.kif' },
        fileName: opts.fsPath || '/mock/file.kif',
        lineAt: sinon.stub().callsFake((lineNum) => ({
            text: lines[lineNum] || '',
            range: makeRange(lineNum, 0, lineNum, (lines[lineNum] || '').length)
        })),
        getWordRangeAtPosition: sinon.stub().callsFake((pos) => {
            const line = lines[pos.line] || '';
            // Find word boundaries around character
            let start = pos.character;
            let end = pos.character;
            while (start > 0 && /[\w?@]/.test(line[start - 1])) start--;
            while (end < line.length && /[\w?@]/.test(line[end])) end++;
            if (start === end) return null;
            return makeRange(pos.line, start, pos.line, end);
        }),
        offsetAt: sinon.stub().callsFake((pos) => {
            let offset = 0;
            for (let i = 0; i < pos.line; i++) offset += lines[i].length + 1;
            return offset + pos.character;
        }),
        positionAt: sinon.stub().callsFake((offset) => {
            let remaining = offset;
            for (let i = 0; i < lines.length; i++) {
                if (remaining <= lines[i].length) return makePosition(i, remaining);
                remaining -= lines[i].length + 1;
            }
            return makePosition(lines.length - 1, (lines[lines.length - 1] || '').length);
        })
    };
}

/**
 * Build a full vscode mock and a configStore that tests can manipulate.
 */
function buildVscodeMock() {
    const configStore = {};

    const configObj = {
        get: sinon.stub().callsFake((key, defaultVal) => {
            if (key in configStore) return configStore[key];
            return defaultVal !== undefined ? defaultVal : undefined;
        })
    };

    const outputChannel = {
        clear: sinon.stub(),
        appendLine: sinon.stub(),
        show: sinon.stub()
    };

    const vscode = {
        window: {
            activeTextEditor: null,
            showQuickPick: sinon.stub(),
            showInputBox: sinon.stub(),
            showOpenDialog: sinon.stub(),
            showInformationMessage: sinon.stub().resolves(undefined),
            showWarningMessage: sinon.stub().resolves(undefined),
            showErrorMessage: sinon.stub().resolves(undefined),
            showTextDocument: sinon.stub().resolves({
                selection: null,
                revealRange: sinon.stub(),
                edit: sinon.stub().callsFake(async (cb) => {
                    cb({ replace: sinon.stub() });
                    return true;
                })
            }),
            withProgress: sinon.stub().callsFake(async (opts, task) => {
                const progress = { report: sinon.stub() };
                const token = { isCancellationRequested: false, onCancellationRequested: sinon.stub() };
                return task(progress, token);
            }),
            createOutputChannel: sinon.stub().returns(outputChannel),
            createWebviewPanel: sinon.stub().returns({
                webview: { html: '', onDidReceiveMessage: sinon.stub() },
                dispose: sinon.stub()
            }),
            createStatusBarItem: sinon.stub().returns({
                show: sinon.stub(),
                hide: sinon.stub(),
                dispose: sinon.stub(),
                command: null,
                text: '',
                tooltip: '',
                backgroundColor: undefined
            }),
            onDidChangeActiveTextEditor: sinon.stub().returns({ dispose: sinon.stub() })
        },
        workspace: {
            getConfiguration: sinon.stub().returns(configObj),
            findFiles: sinon.stub().resolves([]),
            openTextDocument: sinon.stub(),
            asRelativePath: sinon.stub().callsFake(p => {
                const fp = typeof p === 'string' ? p : (p.fsPath || p.path || String(p));
                return path.basename(fp);
            }),
            updateWorkspaceFolders: sinon.stub(),
            workspaceFolders: [],
            onDidChangeWorkspaceFolders: sinon.stub().returns({ dispose: sinon.stub() }),
            onDidChangeConfiguration: sinon.stub().returns({ dispose: sinon.stub() }),
            onDidOpenTextDocument: sinon.stub().returns({ dispose: sinon.stub() }),
            onDidChangeTextDocument: sinon.stub().returns({ dispose: sinon.stub() }),
            onDidSaveTextDocument: sinon.stub().returns({ dispose: sinon.stub() }),
            textDocuments: []
        },
        commands: {
            registerCommand: sinon.stub().returns({ dispose: sinon.stub() }),
            executeCommand: sinon.stub().resolves()
        },
        languages: {
            createDiagnosticCollection: sinon.stub().returns({
                set: sinon.stub(),
                clear: sinon.stub(),
                dispose: sinon.stub()
            }),
            registerDefinitionProvider: sinon.stub().returns({ dispose: sinon.stub() }),
            registerDocumentFormattingEditProvider: sinon.stub().returns({ dispose: sinon.stub() }),
            registerDocumentRangeFormattingEditProvider: sinon.stub().returns({ dispose: sinon.stub() }),
            registerHoverProvider: sinon.stub().returns({ dispose: sinon.stub() }),
            registerCompletionItemProvider: sinon.stub().returns({ dispose: sinon.stub() }),
            registerSignatureHelpProvider: sinon.stub().returns({ dispose: sinon.stub() }),
            registerDocumentSymbolProvider: sinon.stub().returns({ dispose: sinon.stub() })
        },
        env: {
            openExternal: sinon.stub().resolves(true)
        },
        Uri: {
            file: sinon.stub().callsFake((p) => ({ fsPath: p, path: p, scheme: 'file' })),
            parse: sinon.stub().callsFake((u) => ({ toString: () => u, fsPath: u }))
        },
        Range: function (sl, sc, el, ec) { return makeRange(sl, sc, el, ec); },
        Position: function (l, c) { return makePosition(l, c); },
        Selection: function (start, end) {
            return { start, end, active: start, isEmpty: start === end };
        },
        ViewColumn: { Beside: 2 },
        ProgressLocation: { Notification: 15 },
        TextEditorRevealType: { InCenter: 2 },
        SymbolKind: {
            Constant: 14, Variable: 13, Class: 5, Method: 6,
            Function: 12, Field: 8, TypeParameter: 26,
            Interface: 11, Enum: 10, EnumMember: 22, Null: 21
        },
        ThemeColor: function (id) { return { id }; },
        StatusBarAlignment: { Left: 1, Right: 2 },
        DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
        Diagnostic: function (range, message, severity) {
            return { range, message, severity };
        },
        MarkdownString: function (value) {
            this.value = value || '';
            this.appendCodeblock = function (code, lang) { this.value += code; return this; };
            this.appendMarkdown = function (md) { this.value += md; return this; };
        },
        Hover: function (contents, range) { return { contents, range }; },
        CompletionItem: function (label, kind) { return { label, kind, documentation: null, detail: null }; },
        CompletionItemKind: { Function: 3, Variable: 6, Class: 7, Field: 5 },
        SignatureHelp: function () { this.signatures = []; this.activeSignature = 0; this.activeParameter = 0; },
        SignatureInformation: function (label, doc) { this.label = label; this.documentation = doc; this.parameters = []; },
        ParameterInformation: function (label, doc) { return { label, documentation: doc }; },
        Location: function (uri, range) { return { uri, range }; }
    };

    return { vscode, configStore, configObj, outputChannel };
}

// ---------------------------------------------------------------------------
// Engine / Sigma module mocks
// ---------------------------------------------------------------------------

function buildSigmaMocks() {
    const runtimeMock = {
        useDocker: false,
        useLocal: false,
        useNativeJS: true,
        getEnvironmentVar: sinon.stub().returns(null),
        existsAtPath: sinon.stub().returns(false),
        readFile: sinon.stub().resolves(null),
        configCache: null
    };

    return {
        sigmaIndex: {
            getSigmaRuntime: sinon.stub().returns(runtimeMock),
            getSigmaPath: sinon.stub().returns(null),
            findConfigXml: sinon.stub().returns(null),
            isWithinConfiguredKB: sinon.stub().returns(null),
            getKBConstituentsFromConfig: sinon.stub().resolves(null),
            runSigma: sinon.stub().returns({ content: '', axiomCount: 0 })
        },
        sigmaConfig: {
            findLocalConfigXml: sinon.stub().returns(null),
            parseConfigXmlSync: sinon.stub().returns(null),
            addKBToConfig: sinon.stub()
        },
        nativeEngine: {
            parseKIFFormulas: sinon.stub().returns([]),
            convertFormulas: sinon.stub().returns({ content: '', axiomCount: 0 }),
            tptpParseSUOKIFString: sinon.stub().returns(''),
            setLanguage: sinon.stub()
        },
        runtimeMock
    };
}

/**
 * Load extension.js with all mocks wired up.
 * Returns the module and the mocks object for assertions.
 */
function loadExtension(vscodeMock, sigmaMocks) {
    const ext = proxyquire('../../extension', {
        'vscode': vscodeMock,
        './src/sigma/index': sigmaMocks.sigmaIndex,
        './src/sigma/config': sigmaMocks.sigmaConfig,
        './src/sigma/engine/native/index.js': sigmaMocks.nativeEngine,
        './src/const': require('../../src/const')
    });
    return ext;
}

// =========================================================================
// Tests
// =========================================================================

describe('Extension Commands (extension.js)', function () {
    let v, configStore, configObj, outputChannel;
    let sigma;
    let ext;
    let context;

    beforeEach(() => {
        ({ vscode: v, configStore, configObj, outputChannel } = buildVscodeMock());
        sigma = buildSigmaMocks();
        ext = loadExtension(v, sigma);

        // Fake extension context
        context = { subscriptions: [] };
    });

    afterEach(() => {
        sinon.restore();
    });

    // -----------------------------------------------------------------------
    // activate()
    // -----------------------------------------------------------------------
    describe('activate()', () => {
        it('should register all 11 commands', () => {
            ext.activate(context);

            const names = v.commands.registerCommand.args.map(a => a[0]);
            assert(names.includes('sumo.searchSymbol'));
            assert(names.includes('sumo.showTaxonomy'));
            assert(names.includes('sumo.formatAxiom'));
            assert(names.includes('sumo.goToDefinition'));
            assert(names.includes('sumo.browseInSigma'));
            assert(names.includes('sumo.checkErrors'));
            assert(names.includes('sumo.queryProver'));
            assert(names.includes('sumo.runProverOnScope'));
            assert(names.includes('sumo.generateTPTP'));
            assert(names.includes('sumo.openKnowledgeBase'));
            assert(names.includes('sumo.createKnowledgeBase'));
        });

        it('should push disposables into context.subscriptions', () => {
            ext.activate(context);
            // 11 commands + diagnosticCollection + statusBarItem + 3 event listeners
            //  + definitionProvider + formattingProvider + rangeFormattingProvider
            assert(context.subscriptions.length >= 11);
        });
    });

    // -----------------------------------------------------------------------
    // Helper to invoke a registered command by name
    // -----------------------------------------------------------------------
    function getCommand(name) {
        ext.activate(context);
        const call = v.commands.registerCommand.args.find(a => a[0] === name);
        if (!call) throw new Error(`Command ${name} not registered`);
        return call[1]; // the handler function
    }

    // -----------------------------------------------------------------------
    // openKnowledgeBaseCommand
    // -----------------------------------------------------------------------
    describe('openKnowledgeBaseCommand', () => {
        it('should show error when config.xml not found', async () => {
            sigma.sigmaConfig.findLocalConfigXml.returns(null);
            const handler = getCommand('sumo.openKnowledgeBase');

            await handler();

            assert(v.window.showErrorMessage.calledOnce);
            assert(v.window.showErrorMessage.firstCall.args[0].includes('config.xml'));
        });

        it('should open settings when user clicks Open Settings', async () => {
            sigma.sigmaConfig.findLocalConfigXml.returns(null);
            v.window.showErrorMessage.resolves('Open Settings');
            const handler = getCommand('sumo.openKnowledgeBase');

            await handler();

            assert(v.commands.executeCommand.calledWith(
                'workbench.action.openSettings', 'sumo.sigma.configXmlPath'
            ));
        });

        it('should show error when config.xml fails to parse', async () => {
            sigma.sigmaConfig.findLocalConfigXml.returns('/mock/config.xml');
            sigma.sigmaConfig.parseConfigXmlSync.returns(null);
            const handler = getCommand('sumo.openKnowledgeBase');

            await handler();

            assert(v.window.showErrorMessage.calledOnce);
            assert(v.window.showErrorMessage.firstCall.args[0].includes('Failed to parse'));
        });

        it('should show warning when no KBs found', async () => {
            sigma.sigmaConfig.findLocalConfigXml.returns('/mock/config.xml');
            sigma.sigmaConfig.parseConfigXmlSync.returns({
                preferences: {},
                knowledgeBases: {}
            });
            const handler = getCommand('sumo.openKnowledgeBase');

            await handler();

            assert(v.window.showWarningMessage.calledOnce);
            assert(v.window.showWarningMessage.firstCall.args[0].includes('No knowledge bases'));
        });

        it('should show quick pick of available KBs', async () => {
            sigma.sigmaConfig.findLocalConfigXml.returns('/mock/KBs/config.xml');
            sigma.sigmaConfig.parseConfigXmlSync.returns({
                preferences: { kbDir: '/mock/KBs' },
                knowledgeBases: {
                    SUMO: { constituents: ['Merge.kif', 'Mid.kif'] },
                    TestKB: { constituents: ['test.kif'] }
                }
            });
            v.window.showQuickPick.resolves({ label: 'SUMO' });
            const handler = getCommand('sumo.openKnowledgeBase');

            await handler();

            assert(v.window.showQuickPick.calledOnce);
            const items = v.window.showQuickPick.firstCall.args[0];
            assert.strictEqual(items.length, 2);
            assert.strictEqual(items[0].label, 'SUMO');
            assert.strictEqual(items[0].description, '2 constituent files');
            assert.strictEqual(items[1].label, 'TestKB');
        });

        it('should open folder in new window on selection', async () => {
            sigma.sigmaConfig.findLocalConfigXml.returns('/mock/KBs/config.xml');
            sigma.sigmaConfig.parseConfigXmlSync.returns({
                preferences: { kbDir: '/mock/KBs' },
                knowledgeBases: { SUMO: { constituents: ['Merge.kif'] } }
            });
            v.window.showQuickPick.resolves({ label: 'SUMO' });
            const handler = getCommand('sumo.openKnowledgeBase');

            await handler();

            assert(v.commands.executeCommand.calledWith('vscode.openFolder'));
            const args = v.commands.executeCommand.args.find(a => a[0] === 'vscode.openFolder');
            assert.strictEqual(args[1].fsPath, '/mock/KBs');
            assert.strictEqual(args[2], true); // newWindow = true
        });

        it('should use dirname of config.xml when kbDir not in preferences', async () => {
            sigma.sigmaConfig.findLocalConfigXml.returns('/some/path/config.xml');
            sigma.sigmaConfig.parseConfigXmlSync.returns({
                preferences: {},
                knowledgeBases: { MyKB: { constituents: ['a.kif'] } }
            });
            v.window.showQuickPick.resolves({ label: 'MyKB' });
            const handler = getCommand('sumo.openKnowledgeBase');

            await handler();

            const args = v.commands.executeCommand.args.find(a => a[0] === 'vscode.openFolder');
            assert.strictEqual(args[1].fsPath, '/some/path');
        });

        it('should do nothing when user cancels quick pick', async () => {
            sigma.sigmaConfig.findLocalConfigXml.returns('/mock/config.xml');
            sigma.sigmaConfig.parseConfigXmlSync.returns({
                preferences: {},
                knowledgeBases: { SUMO: { constituents: ['a.kif'] } }
            });
            v.window.showQuickPick.resolves(undefined);
            const handler = getCommand('sumo.openKnowledgeBase');

            await handler();

            assert(v.commands.executeCommand.neverCalledWith('vscode.openFolder'));
        });
    });

    // -----------------------------------------------------------------------
    // createKnowledgeBaseCommand
    // -----------------------------------------------------------------------
    describe('createKnowledgeBaseCommand', () => {
        it('should show error when config.xml not found', async () => {
            sigma.sigmaConfig.findLocalConfigXml.returns(null);
            const handler = getCommand('sumo.createKnowledgeBase');

            await handler();

            assert(v.window.showErrorMessage.calledOnce);
        });

        it('should do nothing when user cancels name input', async () => {
            sigma.sigmaConfig.findLocalConfigXml.returns('/mock/config.xml');
            v.window.showInputBox.resolves(undefined);
            const handler = getCommand('sumo.createKnowledgeBase');

            await handler();

            assert(sigma.sigmaConfig.addKBToConfig.notCalled);
        });

        it('should do nothing when user cancels folder dialog', async () => {
            sigma.sigmaConfig.findLocalConfigXml.returns('/mock/config.xml');
            v.window.showInputBox.resolves('NewKB');
            v.window.showOpenDialog.resolves(undefined);
            const handler = getCommand('sumo.createKnowledgeBase');

            await handler();

            assert(sigma.sigmaConfig.addKBToConfig.notCalled);
        });

        it('should call addKBToConfig with discovered .kif files', async () => {
            // Create a temp directory with kif files
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-test-'));
            const kif1 = path.join(tmpDir, 'ontology.kif');
            const kif2 = path.join(tmpDir, 'rules.kif');
            fs.writeFileSync(kif1, '(instance Foo Bar)');
            fs.writeFileSync(kif2, '(subclass Baz Qux)');

            try {
                sigma.sigmaConfig.findLocalConfigXml.returns(path.join(tmpDir, 'config.xml'));
                sigma.sigmaConfig.parseConfigXmlSync.returns({
                    preferences: {},
                    knowledgeBases: {}
                });
                v.window.showInputBox.resolves('TestKB');
                v.window.showOpenDialog.resolves([{ fsPath: tmpDir }]);
                const handler = getCommand('sumo.createKnowledgeBase');

                await handler();

                assert(sigma.sigmaConfig.addKBToConfig.calledOnce);
                const args = sigma.sigmaConfig.addKBToConfig.firstCall.args;
                assert.strictEqual(args[0], path.join(tmpDir, 'config.xml'));
                assert.strictEqual(args[1], 'TestKB');
                assert.strictEqual(args[2].length, 2);
            } finally {
                fs.unlinkSync(kif1);
                fs.unlinkSync(kif2);
                fs.rmdirSync(tmpDir);
            }
        });

        it('should show warning when folder has no .kif files', async () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-test-'));
            try {
                sigma.sigmaConfig.findLocalConfigXml.returns(path.join(tmpDir, 'config.xml'));
                sigma.sigmaConfig.parseConfigXmlSync.returns({
                    preferences: {},
                    knowledgeBases: {}
                });
                v.window.showInputBox.resolves('EmptyKB');
                v.window.showOpenDialog.resolves([{ fsPath: tmpDir }]);
                const handler = getCommand('sumo.createKnowledgeBase');

                await handler();

                assert(v.window.showWarningMessage.calledOnce);
                assert(v.window.showWarningMessage.firstCall.args[0].includes('No .kif files'));
            } finally {
                fs.rmdirSync(tmpDir);
            }
        });

        it('should show error when addKBToConfig throws', async () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-test-'));
            fs.writeFileSync(path.join(tmpDir, 'a.kif'), '');
            try {
                sigma.sigmaConfig.findLocalConfigXml.returns(path.join(tmpDir, 'config.xml'));
                sigma.sigmaConfig.parseConfigXmlSync.returns({ preferences: {}, knowledgeBases: {} });
                v.window.showInputBox.resolves('BadKB');
                v.window.showOpenDialog.resolves([{ fsPath: tmpDir }]);
                sigma.sigmaConfig.addKBToConfig.throws(new Error('write failed'));
                const handler = getCommand('sumo.createKnowledgeBase');

                await handler();

                assert(v.window.showErrorMessage.calledOnce);
                assert(v.window.showErrorMessage.firstCall.args[0].includes('write failed'));
            } finally {
                fs.unlinkSync(path.join(tmpDir, 'a.kif'));
                fs.rmdirSync(tmpDir);
            }
        });

        it('should offer to open KB after creation', async () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-test-'));
            fs.writeFileSync(path.join(tmpDir, 'a.kif'), '');
            try {
                sigma.sigmaConfig.findLocalConfigXml.returns(path.join(tmpDir, 'config.xml'));
                sigma.sigmaConfig.parseConfigXmlSync.returns({ preferences: {}, knowledgeBases: {} });
                v.window.showInputBox.resolves('NewKB');
                v.window.showOpenDialog.resolves([{ fsPath: tmpDir }]);
                v.window.showInformationMessage.resolves('Open KB');
                const handler = getCommand('sumo.createKnowledgeBase');

                await handler();

                assert(v.workspace.updateWorkspaceFolders.calledOnce);
            } finally {
                fs.unlinkSync(path.join(tmpDir, 'a.kif'));
                fs.rmdirSync(tmpDir);
            }
        });
    });

    // -----------------------------------------------------------------------
    // browseInSigmaCommand
    // -----------------------------------------------------------------------
    describe('browseInSigmaCommand', () => {
        it('should do nothing when no editor is active', async () => {
            v.window.activeTextEditor = null;
            const handler = getCommand('sumo.browseInSigma');

            await handler();

            assert(v.env.openExternal.notCalled);
        });

        it('should warn when no word is under cursor', async () => {
            const doc = makeDocument('   ');
            doc.getWordRangeAtPosition.returns(null);
            v.window.activeTextEditor = {
                document: doc,
                selection: { active: makePosition(0, 1) }
            };
            const handler = getCommand('sumo.browseInSigma');

            await handler();

            assert(v.window.showWarningMessage.calledOnce);
            assert(v.window.showWarningMessage.firstCall.args[0].includes('cursor on a term'));
        });

        it('should warn when cursor is on a variable', async () => {
            const doc = makeDocument('?X');
            v.window.activeTextEditor = {
                document: doc,
                selection: { active: makePosition(0, 0) }
            };
            const handler = getCommand('sumo.browseInSigma');

            await handler();

            assert(v.window.showWarningMessage.calledOnce);
            assert(v.window.showWarningMessage.firstCall.args[0].includes('variables'));
        });

        it('should open Sigma browser with correct URL', async () => {
            const doc = makeDocument('(instance Human Animal)');
            v.window.activeTextEditor = {
                document: doc,
                selection: { active: makePosition(0, 11) } // cursor on "Human"
            };
            configStore['sigmaUrl'] = 'http://localhost:8080/sigma/Browse.jsp';
            configStore['knowledgeBase'] = 'SUMO';
            configStore['language'] = 'EnglishLanguage';
            const handler = getCommand('sumo.browseInSigma');

            await handler();

            assert(v.env.openExternal.calledOnce);
            const url = v.Uri.parse.firstCall.args[0];
            assert(url.includes('term=Human'));
            assert(url.includes('kb=SUMO'));
        });
    });

    // -----------------------------------------------------------------------
    // formatAxiomCommand
    // -----------------------------------------------------------------------
    describe('formatAxiomCommand', () => {
        it('should do nothing when no editor is active', async () => {
            v.window.activeTextEditor = null;
            const handler = getCommand('sumo.formatAxiom');

            await handler();

            // No error thrown, no interaction
            assert(v.window.showWarningMessage.notCalled);
        });
    });

    // -----------------------------------------------------------------------
    // checkErrorsCommand
    // -----------------------------------------------------------------------
    describe('checkErrorsCommand', () => {
        it('should do nothing when no editor is active', async () => {
            v.window.activeTextEditor = null;
            const handler = getCommand('sumo.checkErrors');

            await handler();

            assert(v.window.showInformationMessage.notCalled);
        });

        it('should report no errors for valid KIF', async () => {
            const doc = makeDocument('(instance Human Animal)');
            v.window.activeTextEditor = { document: doc };
            const handler = getCommand('sumo.checkErrors');

            await handler();

            assert(v.window.showInformationMessage.calledOnce);
            assert(v.window.showInformationMessage.firstCall.args[0].includes('No errors'));
        });
    });

    // -----------------------------------------------------------------------
    // goToDefinitionCommand
    // -----------------------------------------------------------------------
    describe('goToDefinitionCommand', () => {
        it('should do nothing when no editor is active', async () => {
            v.window.activeTextEditor = null;
            const handler = getCommand('sumo.goToDefinition');

            await handler();

            assert(v.window.showInformationMessage.notCalled);
        });

        it('should do nothing when no word under cursor', async () => {
            const doc = makeDocument('   ');
            doc.getWordRangeAtPosition.returns(null);
            v.window.activeTextEditor = {
                document: doc,
                selection: { active: makePosition(0, 1) }
            };
            const handler = getCommand('sumo.goToDefinition');

            await handler();

            assert(v.window.showInformationMessage.notCalled);
            assert(v.window.showQuickPick.notCalled);
        });
    });

    // -----------------------------------------------------------------------
    // searchSymbolCommand
    // -----------------------------------------------------------------------
    describe('searchSymbolCommand', () => {
        it('should do nothing when no editor is active', async () => {
            v.window.activeTextEditor = null;
            const handler = getCommand('sumo.searchSymbol');

            await handler();

            assert(v.window.showQuickPick.notCalled);
        });

        it('should do nothing when no word under cursor', async () => {
            const doc = makeDocument('   ');
            doc.getWordRangeAtPosition.returns(null);
            v.window.activeTextEditor = {
                document: doc,
                selection: { active: makePosition(0, 1) }
            };
            const handler = getCommand('sumo.searchSymbol');

            await handler();

            assert(v.window.showQuickPick.notCalled);
        });
    });

    // -----------------------------------------------------------------------
    // queryProverCommand
    // -----------------------------------------------------------------------
    describe('queryProverCommand', () => {
        it('should do nothing when no editor is active', async () => {
            v.window.activeTextEditor = null;
            const handler = getCommand('sumo.queryProver');

            await handler();

            assert(v.window.showErrorMessage.notCalled);
        });

        it('should show error when prover path not configured', async () => {
            const doc = makeDocument('(instance Human Animal)');
            v.window.activeTextEditor = {
                document: doc,
                selection: makeRange(0, 0, 0, 23)
            };
            configStore['proverPath'] = undefined;
            const handler = getCommand('sumo.queryProver');

            await handler();

            assert(v.window.showErrorMessage.calledOnce);
            assert(v.window.showErrorMessage.firstCall.args[0].includes('prover path'));
        });

        it('should show error when prover executable not found', async () => {
            const doc = makeDocument('(instance Human Animal)');
            v.window.activeTextEditor = {
                document: doc,
                selection: makeRange(0, 0, 0, 23)
            };
            configStore['proverPath'] = '/nonexistent/prover';
            const handler = getCommand('sumo.queryProver');

            await handler();

            assert(v.window.showErrorMessage.calledOnce);
            assert(v.window.showErrorMessage.firstCall.args[0].includes('not found'));
        });
    });

    // -----------------------------------------------------------------------
    // runProverOnScopeCommand
    // -----------------------------------------------------------------------
    describe('runProverOnScopeCommand', () => {
        it('should do nothing when no editor is active', async () => {
            v.window.activeTextEditor = null;
            const handler = getCommand('sumo.runProverOnScope');

            await handler();

            assert(v.window.showQuickPick.notCalled);
        });

        it('should show error when prover path not configured', async () => {
            const doc = makeDocument('(instance Human Animal)');
            v.window.activeTextEditor = { document: doc, selection: makeRange(0, 0, 0, 0) };
            configStore['proverPath'] = undefined;
            const handler = getCommand('sumo.runProverOnScope');

            await handler();

            assert(v.window.showErrorMessage.calledOnce);
            assert(v.window.showErrorMessage.firstCall.args[0].includes('prover path'));
        });

        it('should show error when prover not found on disk', async () => {
            const doc = makeDocument('(instance Human Animal)');
            v.window.activeTextEditor = { document: doc, selection: makeRange(0, 0, 0, 0) };
            configStore['proverPath'] = '/does/not/exist';
            const handler = getCommand('sumo.runProverOnScope');

            await handler();

            assert(v.window.showErrorMessage.calledOnce);
            assert(v.window.showErrorMessage.firstCall.args[0].includes('not found'));
        });
    });

    // -----------------------------------------------------------------------
    // generateTPTPCommand
    // -----------------------------------------------------------------------
    describe('generateTPTPCommand', () => {
        it('should warn when no KIF file is open and no KB operations allowed', async () => {
            v.window.activeTextEditor = null;
            sigma.sigmaIndex.isWithinConfiguredKB.returns(null);
            const handler = getCommand('sumo.generateTPTP');

            await handler();

            assert(v.window.showWarningMessage.calledOnce);
            assert(v.window.showWarningMessage.firstCall.args[0].includes('No KIF file'));
        });

        it('should offer Current File and Selection when a .kif file is open', async () => {
            const doc = makeDocument('(instance Human Animal)', { languageId: 'sumo' });
            v.window.activeTextEditor = { document: doc, selection: makeRange(0, 0, 0, 0) };
            sigma.sigmaIndex.isWithinConfiguredKB.returns(null);
            configStore['enforceKBContext'] = true;
            // User cancels the quick pick
            v.window.showQuickPick.resolves(undefined);
            const handler = getCommand('sumo.generateTPTP');

            await handler();

            assert(v.window.showQuickPick.calledOnce);
            const items = v.window.showQuickPick.firstCall.args[0];
            const labels = items.map(i => i.label);
            assert(labels.includes('Current File'));
            assert(labels.includes('Selection Only'));
        });

        it('should include workspace/KB options when KB context is present', async () => {
            const doc = makeDocument('(instance Human Animal)', { languageId: 'sumo' });
            v.window.activeTextEditor = { document: doc, selection: makeRange(0, 0, 0, 0) };
            sigma.sigmaIndex.isWithinConfiguredKB.returns({
                kbName: 'SUMO',
                kbDir: '/mock/KBs',
                configPath: '/mock/KBs/config.xml',
                parsed: {}
            });
            sigma.runtimeMock.useNativeJS = true;
            v.window.showQuickPick.resolves(undefined);
            const handler = getCommand('sumo.generateTPTP');

            await handler();

            const items = v.window.showQuickPick.firstCall.args[0];
            const labels = items.map(i => i.label);
            assert(labels.includes('Entire Workspace'));
            assert(labels.includes('Knowledge Base from config.xml'));
            assert(labels.includes('Custom File Selection'));
        });

        it('should convert current file using native JS and open result', async () => {
            const kifText = '(instance Human Animal)';
            const doc = makeDocument(kifText, { languageId: 'sumo', fsPath: '/mock/test.kif' });
            v.window.activeTextEditor = { document: doc, selection: makeRange(0, 0, 0, 0) };
            sigma.sigmaIndex.isWithinConfiguredKB.returns(null);
            sigma.sigmaIndex.getSigmaRuntime.returns({ useDocker: false, useNativeJS: true, useLocal: false });
            sigma.nativeEngine.parseKIFFormulas.returns(['(instance Human Animal)']);
            sigma.nativeEngine.convertFormulas.returns({
                content: 'fof(kb_test_1,axiom,(s__instance(s__Human,s__Animal))).',
                axiomCount: 1
            });

            v.window.showQuickPick.resolves({ label: 'Current File' });
            v.workspace.openTextDocument.resolves(doc);
            const handler = getCommand('sumo.generateTPTP');

            await handler();

            assert(sigma.nativeEngine.parseKIFFormulas.calledOnce);
            assert(sigma.nativeEngine.convertFormulas.calledOnce);
            // Should open document
            assert(v.workspace.openTextDocument.called);
            assert(v.window.showInformationMessage.calledOnce);
            assert(v.window.showInformationMessage.firstCall.args[0].includes('TPTP generated'));
        });

        it('should show error when Sigma is not configured and not using native', async () => {
            const doc = makeDocument('(instance Human Animal)', { languageId: 'sumo' });
            v.window.activeTextEditor = { document: doc, selection: makeRange(0, 0, 0, 0) };
            sigma.sigmaIndex.isWithinConfiguredKB.returns(null);
            sigma.sigmaIndex.getSigmaRuntime.returns({ useDocker: false, useNativeJS: false, useLocal: false });
            sigma.sigmaIndex.getSigmaPath.returns(null);

            v.window.showQuickPick.resolves({ label: 'Current File' });
            const handler = getCommand('sumo.generateTPTP');

            await handler();

            assert(v.window.showErrorMessage.calledOnce);
            assert(v.window.showErrorMessage.firstCall.args[0].includes('Sigma not configured'));
        });
    });

    // -----------------------------------------------------------------------
    // showTaxonomyCommand
    // -----------------------------------------------------------------------
    describe('showTaxonomyCommand', () => {
        it('should do nothing when no editor is active and no argument given', async () => {
            v.window.activeTextEditor = null;
            const handler = getCommand('sumo.showTaxonomy');

            await handler();

            assert(v.window.createWebviewPanel.notCalled);
        });
    });
});

// ===========================================================================
// Sigma engine/index.js  (getConfigEnvFallback bug)
// ===========================================================================
describe('Sigma Engine (src/sigma/engine/index.js)', () => {
    let vscodeMock, configObj, configStore;
    let runtimeMock;
    let engineModule;

    beforeEach(() => {
        configStore = {};
        configObj = {
            get: sinon.stub().callsFake((key, defaultVal) => {
                if (key in configStore) return configStore[key];
                return defaultVal !== undefined ? defaultVal : undefined;
            })
        };
        vscodeMock = {
            workspace: {
                getConfiguration: sinon.stub().returns(configObj)
            }
        };

        runtimeMock = {
            useDocker: false,
            useLocal: true,
            useNativeJS: false,
            getEnvironmentVar: sinon.stub().returns(null),
            existsAtPath: sinon.stub().returns(true),
            configCache: null
        };

        const runtimeModule = {
            getSigmaRuntime: sinon.stub().returns(runtimeMock),
            SigmaRuntime: class {}
        };

        engineModule = proxyquire('../../src/sigma/engine/index', {
            'vscode': vscodeMock,
            './const': { environment: { source: 'SIGMA_SRC', home: 'SIGMA_HOME', git: 'ONTOLOGYPORTAL_GIT' } },
            './runtime': runtimeModule
        });
    });

    afterEach(() => sinon.restore());

    describe('getConfigEnvFallback (via getSigmaPath)', () => {
        it('should return config value for dotted key without crashing', () => {
            configStore['sigma.srcPath'] = '/my/sigma/src';
            const result = engineModule.getSigmaPath();
            assert.strictEqual(result, '/my/sigma/src');
        });

        it('should fall back to environment variable when config is empty', () => {
            runtimeMock.getEnvironmentVar.returns('/env/sigma');
            const result = engineModule.getSigmaPath();
            assert.strictEqual(result, '/env/sigma');
        });

        it('should return null when neither config nor env is set', () => {
            runtimeMock.existsAtPath.returns(false);
            const result = engineModule.getSigmaPath();
            assert.strictEqual(result, null);
        });

        it('should return null when path does not exist on disk', () => {
            configStore['sigma.srcPath'] = '/nonexistent';
            runtimeMock.existsAtPath.withArgs('/nonexistent').returns(false);
            const result = engineModule.getSigmaPath();
            assert.strictEqual(result, null);
        });

        it('should skip empty string config values', () => {
            configStore['sigma.srcPath'] = '';
            runtimeMock.getEnvironmentVar.returns('/fallback');
            const result = engineModule.getSigmaPath();
            assert.strictEqual(result, '/fallback');
        });
    });

    describe('getSigmaHome', () => {
        it('should return config value for sigma.homePath', () => {
            configStore['sigma.homePath'] = '/my/sigma/home';
            const result = engineModule.getSigmaHome();
            assert.strictEqual(result, '/my/sigma/home');
        });

        it('should fall back to SIGMA_HOME env var', () => {
            runtimeMock.getEnvironmentVar.withArgs('SIGMA_HOME').returns('/env/home');
            const result = engineModule.getSigmaHome();
            assert.strictEqual(result, '/env/home');
        });
    });
});

// ===========================================================================
// Config.js new functions
// ===========================================================================
describe('Config KB Management Functions (src/sigma/config.js)', () => {
    let vscodeMock, configStore, configObj;

    beforeEach(() => {
        configStore = {};
        configObj = {
            get: sinon.stub().callsFake((key) => configStore[key] || undefined)
        };
        vscodeMock = {
            workspace: { getConfiguration: sinon.stub().returns(configObj) }
        };
    });

    afterEach(() => sinon.restore());

    describe('findLocalConfigXml', () => {
        it('should return explicit configXmlPath setting if file exists', () => {
            const tmpFile = path.join(os.tmpdir(), `config-test-${Date.now()}.xml`);
            fs.writeFileSync(tmpFile, '<configuration></configuration>');
            try {
                configStore['sigma.configXmlPath'] = tmpFile;
                const mod = proxyquire('../../src/sigma/config', {
                    'vscode': vscodeMock,
                    './engine': {
                        getSigmaRuntime: () => ({ useLocal: true, useNativeJS: false, configCache: null, readFile: async () => null, existsAtPath: async () => false, getEnvironmentVar: async () => null }),
                        getSigmaHome: () => null,
                        getSigmaPath: () => null
                    }
                });
                const result = mod.findLocalConfigXml();
                assert.strictEqual(result, tmpFile);
            } finally {
                fs.unlinkSync(tmpFile);
            }
        });

        it('should return null when no config.xml found anywhere', () => {
            // Mock fs.existsSync to always return false so no real file is found
            const fsMock = {
                existsSync: sinon.stub().returns(false),
                readFileSync: fs.readFileSync,
                writeFileSync: fs.writeFileSync
            };
            const mod = proxyquire('../../src/sigma/config', {
                'vscode': vscodeMock,
                'fs': fsMock,
                './engine': {
                    getSigmaRuntime: () => ({ useLocal: true, useNativeJS: false, configCache: null, readFile: async () => null, existsAtPath: async () => false, getEnvironmentVar: async () => null }),
                    getSigmaHome: () => null,
                    getSigmaPath: () => null
                }
            });
            const result = mod.findLocalConfigXml();
            assert.strictEqual(result, null);
        });
    });

    describe('parseConfigXmlSync', () => {
        it('should parse preferences and KBs from XML file', () => {
            const tmpFile = path.join(os.tmpdir(), `config-sync-${Date.now()}.xml`);
            const xml = `<configuration>
                <preference name="kbDir" value="/kb" />
                <kb name="SUMO">
                    <constituent filename="Merge.kif" />
                    <constituent filename="Mid.kif" />
                </kb>
            </configuration>`;
            fs.writeFileSync(tmpFile, xml);
            try {
                const mod = proxyquire('../../src/sigma/config', {
                    'vscode': vscodeMock,
                    './engine': {
                        getSigmaRuntime: () => ({ useLocal: true, readFile: async () => null, existsAtPath: async () => false, getEnvironmentVar: async () => null }),
                        getSigmaHome: () => null,
                        getSigmaPath: () => null
                    }
                });
                const result = mod.parseConfigXmlSync(tmpFile);
                assert.strictEqual(result.preferences.kbDir, '/kb');
                assert.strictEqual(result.knowledgeBases.SUMO.constituents.length, 2);
                assert.strictEqual(result.knowledgeBases.SUMO.constituents[0], 'Merge.kif');
            } finally {
                fs.unlinkSync(tmpFile);
            }
        });

        it('should return null for nonexistent file', () => {
            const mod = proxyquire('../../src/sigma/config', {
                'vscode': vscodeMock,
                './engine': {
                    getSigmaRuntime: () => ({ useLocal: true, readFile: async () => null, existsAtPath: async () => false, getEnvironmentVar: async () => null }),
                    getSigmaHome: () => null,
                    getSigmaPath: () => null
                }
            });
            const result = mod.parseConfigXmlSync('/nonexistent/config.xml');
            assert.strictEqual(result, null);
        });
    });

    describe('addKBToConfig', () => {
        it('should insert a new KB entry before </configuration>', () => {
            const tmpFile = path.join(os.tmpdir(), `config-add-${Date.now()}.xml`);
            fs.writeFileSync(tmpFile, '<configuration>\n  <preference name="kbDir" value="/kb" />\n</configuration>');
            try {
                const mod = proxyquire('../../src/sigma/config', {
                    'vscode': vscodeMock,
                    './engine': {
                        getSigmaRuntime: () => ({ useLocal: true, readFile: async () => null, existsAtPath: async () => false, getEnvironmentVar: async () => null }),
                        getSigmaHome: () => null,
                        getSigmaPath: () => null
                    }
                });
                mod.addKBToConfig(tmpFile, 'NewKB', ['file1.kif', 'file2.kif']);
                const content = fs.readFileSync(tmpFile, 'utf-8');
                assert(content.includes('<kb name="NewKB">'));
                assert(content.includes('<constituent filename="file1.kif" />'));
                assert(content.includes('<constituent filename="file2.kif" />'));
                assert(content.includes('</configuration>'));
                // KB entry should be before closing tag
                assert(content.indexOf('<kb name="NewKB">') < content.indexOf('</configuration>'));
            } finally {
                fs.unlinkSync(tmpFile);
            }
        });

        it('should throw when </configuration> tag is missing', () => {
            const tmpFile = path.join(os.tmpdir(), `config-bad-${Date.now()}.xml`);
            fs.writeFileSync(tmpFile, '<configuration><preference name="x" value="y" />');
            try {
                const mod = proxyquire('../../src/sigma/config', {
                    'vscode': vscodeMock,
                    './engine': {
                        getSigmaRuntime: () => ({ useLocal: true, readFile: async () => null, existsAtPath: async () => false, getEnvironmentVar: async () => null }),
                        getSigmaHome: () => null,
                        getSigmaPath: () => null
                    }
                });
                assert.throws(() => {
                    mod.addKBToConfig(tmpFile, 'KB', ['a.kif']);
                }, /missing <\/configuration>/);
            } finally {
                fs.unlinkSync(tmpFile);
            }
        });
    });
});
