const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire');

describe('VSCode Extension Activation and Commands', () => {
    let vscode;
    let extension;
    let registeredCommands = new Map();
    let navigationMock, validationMock, proverMock, generateTPTPMock, kbManagementMock, taxonomyMock;

    beforeEach(() => {
        registeredCommands = new Map();

        navigationMock = {
            searchSymbolCommand: sinon.stub(),
            goToDefinitionCommand: sinon.stub(),
            provideDefinition: sinon.stub(),
            updateDocumentDefinitions: sinon.stub(),
            getKB: sinon.stub().returns('SUMO'),
            setDiagnosticCollection: sinon.stub(),
            browseInSigmaCommand: sinon.stub(),
            buildWorkspaceDefinitions: sinon.stub().resolves(),
            updateFileDefinitions: sinon.stub(),
            setKB: sinon.stub()
        };
        validationMock = {
            checkErrorsCommand: sinon.stub(),
            tokenize: sinon.stub(),
            parse: sinon.stub(),
            collectMetadata: sinon.stub(),
            validateNode: sinon.stub(),
            validateVariables: sinon.stub()
        };
        proverMock = {
            queryProverCommand: sinon.stub(),
            runProverOnScopeCommand: sinon.stub()
        };
        generateTPTPMock = {
            generateTPTPCommand: sinon.stub()
        };
        kbManagementMock = {
            setKBTreeProvider: sinon.stub(),
            openKnowledgeBaseCommand: sinon.stub(),
            addFileToKBCommand: sinon.stub(),
            removeFileFromKBCommand: sinon.stub(),
            createKnowledgeBaseCommand: sinon.stub(),
            updateActiveEditorContext: sinon.stub()
        };
        taxonomyMock = {
            showTaxonomyCommand: sinon.stub()
        };

        const registerCommandSpy = (id, callback) => {
            registeredCommands.set(id, callback);
            return { dispose: () => {} };
        };

        // Mock vscode API
        vscode = {
            languages: {
                createDiagnosticCollection: sinon.stub().returns({
                    set: sinon.stub(),
                    delete: sinon.stub(),
                    clear: sinon.stub()
                }),
                registerDefinitionProvider: sinon.stub(),
                registerDocumentFormattingEditProvider: sinon.stub(),
                registerDocumentRangeFormattingEditProvider: sinon.stub(),
                registerHoverProvider: sinon.stub(),
                registerCompletionItemProvider: sinon.stub(),
                registerDocumentSymbolProvider: sinon.stub(),
                registerSignatureHelpProvider: sinon.stub()
            },
            window: {
                registerTreeDataProvider: sinon.stub(),
                onDidChangeActiveTextEditor: sinon.stub(),
                createStatusBarItem: sinon.stub().returns({
                    show: sinon.stub(),
                    hide: sinon.stub(),
                    text: '',
                    tooltip: '',
                    command: ''
                }),
                activeTextEditor: undefined,
                showInformationMessage: sinon.stub().resolves(),
                showWarningMessage: sinon.stub().resolves(),
                showErrorMessage: sinon.stub().resolves()
            },
            commands: {
                registerCommand: registerCommandSpy,
                executeCommand: sinon.stub().callsFake((id, ...args) => {
                    if (registeredCommands.has(id)) {
                        return registeredCommands.get(id)(...args);
                    }
                })
            },
            workspace: {
                onDidChangeConfiguration: sinon.stub(),
                onDidOpenTextDocument: sinon.stub(),
                onDidChangeTextDocument: sinon.stub(),
                onDidSaveTextDocument: sinon.stub(),
                onDidChangeWorkspaceFolders: sinon.stub(),
                textDocuments: [],
                getConfiguration: sinon.stub().returns({
                    get: sinon.stub().returns(undefined)
                })
            },
            StatusBarAlignment: { Right: 1 },
            TreeItemCollapsibleState: { Expanded: 1, None: 0 },
            ThemeIcon: sinon.stub(),
            EventEmitter: class {
                constructor() { this.event = sinon.stub(); }
                fire() {}
            },
            Position: class { constructor(l, c) { this.line = l; this.character = c; } },
            Range: class { constructor(s, e) { this.start = s; this.end = e; } },
            DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
            Diagnostic: class { constructor(r, m, s) { this.range = r; this.message = m; this.severity = s; } },
            Uri: {
                file: (p) => ({ fsPath: p, scheme: 'file' }),
                parse: (p) => ({ fsPath: p, scheme: 'http' })
            },
            extensions: {
                getExtension: sinon.stub().returns({
                    extensionContext: { storageUri: { fsPath: '/tmp' } }
                })
            }
        };

        proxyquire.noCallThru();
        // Load extension with mocked vscode and its internal dependencies
        extension = proxyquire('../extension', {
            'vscode': vscode,
            './src/sigma': {
                getSigmaRuntime: sinon.stub().returns({
                    initialize: sinon.stub().resolves(),
                    shutdown: sinon.stub().resolves()
                }),
                findConfigXml: sinon.stub().resolves('/mock/config.xml'),
                isWithinConfiguredKB: sinon.stub().returns(true)
            },
            './src/kb-tree': {
                KBTreeProvider: class {
                    constructor() {}
                }
            },
            './src/navigation': navigationMock,
            './src/taxonomy': taxonomyMock,
            './src/formatting': {
                formatAxiomCommand: sinon.stub(),
                formatDocument: sinon.stub(),
                formatRange: sinon.stub()
            },
            './src/validation': validationMock,
            './src/prover': proverMock,
            './src/generate-tptp': generateTPTPMock,
            './src/kb-management': kbManagementMock,
            './src/providers': {
                provideHover: sinon.stub(),
                provideCompletionItems: sinon.stub(),
                provideSignatureHelp: sinon.stub()
            },
            './src/tptp-provider': {
                provideTPTPDocumentSymbols: sinon.stub()
            }
        });
    });

    it('should register all expected commands on activation', async () => {
        const context = {
            subscriptions: [],
            extensionPath: '/mock/path'
        };

        await extension.activate(context);

        const expectedCommands = [
            'sumo.searchSymbol',
            'sumo.showTaxonomy',
            'sumo.formatAxiom',
            'sumo.goToDefinition',
            'sumo.browseInSigma',
            'sumo.checkErrors',
            'sumo.queryProver',
            'sumo.runProverOnScope',
            'sumo.generateTPTP',
            'sumo.openKnowledgeBase',
            'sumo.createKnowledgeBase',
            'sumo.kbExplorer.refresh',
            'sumo.kbExplorer.addFile',
            'sumo.kbExplorer.removeFile'
        ];

        expectedCommands.forEach(cmd => {
            expect(registeredCommands.has(cmd), `Command ${cmd} not registered`).to.be.true;
        });
    });

    describe('Command Invocation', () => {
        let context;
        beforeEach(async () => {
            context = {
                subscriptions: [],
                extensionPath: '/mock/path'
            };
            await extension.activate(context);
        });

        it('sumo.checkErrors should call validation checkErrorsCommand', async () => {
            const cmd = registeredCommands.get('sumo.checkErrors');
            await cmd();
            expect(validationMock.checkErrorsCommand.calledOnce).to.be.true;
        });

        it('sumo.queryProver should call prover queryProverCommand', async () => {
            const cmd = registeredCommands.get('sumo.queryProver');
            await cmd();
            expect(proverMock.queryProverCommand.calledOnce).to.be.true;
        });

        it('sumo.showTaxonomy should call taxonomy showTaxonomyCommand', async () => {
            const cmd = registeredCommands.get('sumo.showTaxonomy');
            await cmd('Entity');
            expect(taxonomyMock.showTaxonomyCommand.calledOnce).to.be.true;
            expect(taxonomyMock.showTaxonomyCommand.calledWith(context, 'Entity')).to.be.true;
        });

        it('sumo.generateTPTP should call generateTPTPCommand', async () => {
            const cmd = registeredCommands.get('sumo.generateTPTP');
            await cmd();
            expect(generateTPTPMock.generateTPTPCommand.calledOnce).to.be.true;
            expect(generateTPTPMock.generateTPTPCommand.calledWith(context)).to.be.true;
        });

        it('sumo.openKnowledgeBase should call kbManagement openKnowledgeBaseCommand', async () => {
            const cmd = registeredCommands.get('sumo.openKnowledgeBase');
            await cmd();
            expect(kbManagementMock.openKnowledgeBaseCommand.calledOnce).to.be.true;
        });

        it('sumo.browseInSigma should call navigation browseInSigmaCommand', async () => {
            const cmd = registeredCommands.get('sumo.browseInSigma');
            await cmd();
            expect(navigationMock.browseInSigmaCommand.calledOnce).to.be.true;
        });
    });
});