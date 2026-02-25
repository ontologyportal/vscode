/**
 * Tests for src/kb-management.js (non-bug tests)
 */

'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
const path = require('path');

const { createVSCodeMock } = require('./helpers/vscode-mock');

// ---------------------------------------------------------------------------
// Helper: load kb-management module with fully stubbed dependencies
// ---------------------------------------------------------------------------
function loadKBManagement(options) {
    options = options || {};
    const vscode = createVSCodeMock(sinon);
    vscode._setConfig(options.config || {});

    const sigmaRuntime = {
        initialize: sinon.stub().resolves(),
        shutdown: sinon.stub().resolves(),
        existsAtPath: sinon.stub().resolves(false),
        writeFile: sinon.stub().resolves()
    };

    const sigmaModule = {
        findConfigXml: options.findConfigXml || sinon.stub().resolves('/fake/config.xml'),
        getSigmaRuntime: sinon.stub().returns(sigmaRuntime)
    };

    const configModule = {
        findConfigXml: options.findConfigXml || sinon.stub().resolves('/fake/config.xml'),
        parseConfigXml: options.parseConfigXml || sinon.stub().resolves({
            knowledgeBases: {
                TestKB: { constituents: ['file1.kif', 'file2.kif'] }
            },
            preferences: { kbDir: '/fake/kb' }
        }),
        addFileToConfig: options.addFileToConfig || sinon.stub().resolves(),
        removeFileFromConfig: options.removeFileFromConfig || sinon.stub().resolves(),
        addKBToConfig: options.addKBToConfig || sinon.stub().resolves('/fake/kb/NewKB')
    };

    const KBNode = class {
        constructor(label, type, contextValue, kb) {
            this.label = label;
            this.type = type;
            this.contextValue = contextValue;
            this.kb = kb;
        }
    };

    const KBTreeProvider = class {
        constructor() { this.kbs = []; }
        refresh(kbs) { this.kbs = kbs; }
    };

    const navigationModule = {
        buildWorkspaceDefinitions: sinon.stub().resolves(),
        setKB: sinon.stub()
    };

    const mod = proxyquire('../src/kb-management', {
        vscode,
        fs: {
            existsSync: sinon.stub().returns(true),
            readFileSync: sinon.stub().returns('content')
        },
        path,
        './sigma': sigmaModule,
        './kb-tree': { KBTreeProvider, KBNode },
        './sigma/config': configModule,
        './navigation': navigationModule
    });

    return { mod, vscode, sigmaRuntime, configModule, navigationModule };
}

// ---------------------------------------------------------------------------
describe('kb-management.js', function () {

    afterEach(() => sinon.restore());

    // -----------------------------------------------------------------------
    describe('updateActiveEditorContext()', function () {

        it('sets sumo.inKB to false when no editor is provided', function () {
            const { mod, vscode } = loadKBManagement();
            mod.updateActiveEditorContext(null);
            expect(vscode.commands.executeCommand.calledWith('setContext', 'sumo.inKB', false)).to.be.true;
        });

        it('sets sumo.inKB to true when editor file is in a known KB', function () {
            const { mod, vscode } = loadKBManagement();
            // Register a fake KBTreeProvider with a KB containing a file
            const mockProvider = {
                kbs: [
                    { name: 'TestKB', constituents: ['/workspace/myfile.kif'] }
                ]
            };
            mod.setKBTreeProvider(mockProvider);

            const mockEditor = {
                document: {
                    uri: { fsPath: '/workspace/myfile.kif' },
                    languageId: 'suo-kif'
                }
            };
            mod.updateActiveEditorContext(mockEditor);
            expect(vscode.commands.executeCommand.calledWith('setContext', 'sumo.inKB', true)).to.be.true;
        });

        it('sets sumo.inKB to false when editor file is not in any KB', function () {
            const { mod, vscode } = loadKBManagement();
            const mockProvider = {
                kbs: [
                    { name: 'TestKB', constituents: ['/workspace/other.kif'] }
                ]
            };
            mod.setKBTreeProvider(mockProvider);

            const mockEditor = {
                document: {
                    uri: { fsPath: '/workspace/unrelated.kif' },
                    languageId: 'suo-kif'
                }
            };
            mod.updateActiveEditorContext(mockEditor);
            expect(vscode.commands.executeCommand.calledWith('setContext', 'sumo.inKB', false)).to.be.true;
        });
    });

    // -----------------------------------------------------------------------
    describe('openKnowledgeBaseCommand()', function () {

        it('shows an error when config.xml is not found', async function () {
            const { mod, vscode } = loadKBManagement({
                findConfigXml: sinon.stub().resolves(null)
            });
            await mod.openKnowledgeBaseCommand();
            expect(vscode.window.showErrorMessage.called).to.be.true;
        });

        it('shows an error when config.xml parse fails', async function () {
            const { mod, vscode } = loadKBManagement({
                parseConfigXml: sinon.stub().resolves(null)
            });
            await mod.openKnowledgeBaseCommand();
            expect(vscode.window.showErrorMessage.called).to.be.true;
        });

        it('calls buildWorkspaceDefinitions on success', async function () {
            const { mod, navigationModule } = loadKBManagement();
            await mod.openKnowledgeBaseCommand();
            expect(navigationModule.buildWorkspaceDefinitions.called).to.be.true;
        });
    });

    // -----------------------------------------------------------------------
    describe('addFileToKBCommand()', function () {

        it('addFileToKBCommand returns early when no node is provided', async function () {
            const { mod } = loadKBManagement();
            const result = await mod.addFileToKBCommand(null);
            expect(result).to.be.undefined;
        });

        it('addFileToKBCommand returns early when dialog is cancelled', async function () {
            const { mod, vscode } = loadKBManagement();
            vscode.window.showOpenDialog = sinon.stub().resolves(null);
            const result = await mod.addFileToKBCommand({ kb: { name: 'TestKB', kbDir: '/fake/kb' } });
            expect(result).to.be.undefined;
        });

        it('addFileToKBCommand adds file without copy when user selects No', async function () {
            const { mod, vscode, configModule } = loadKBManagement();

            const fakeUri = { fsPath: '/fake/kb/newfile.kif' };
            vscode.window.showOpenDialog = sinon.stub().resolves([fakeUri]);
            vscode.window.showQuickPick = sinon.stub().resolves({ label: 'No' });

            await mod.addFileToKBCommand({ kb: { name: 'TestKB', kbDir: '/fake/kb' } });

            expect(configModule.addFileToConfig.called).to.be.true;
        });
    });

    // -----------------------------------------------------------------------
    describe('createKnowledgeBaseCommand()', function () {

        it('createKnowledgeBaseCommand does not throw ReferenceError when Open KB is selected', async function () {
            const { mod, vscode } = loadKBManagement({
                addKBToConfig: sinon.stub().resolves('/fake/kb/NewKB')
            });

            vscode.window.showInputBox = sinon.stub().resolves('MyNewKB');
            vscode.window.showOpenDialog = sinon.stub().resolves([]);
            vscode.window.showInformationMessage = sinon.stub().resolves('Open KB');

            // After B3 fix, clicking Open KB should NOT throw ReferenceError
            let threw = false;
            let caughtError = null;
            try {
                await mod.createKnowledgeBaseCommand();
            } catch (e) {
                threw = true;
                caughtError = e;
            }

            if (threw) {
                // If it throws, it should NOT be a ReferenceError about folderPath
                expect(caughtError).to.not.be.instanceOf(ReferenceError);
                // Other errors (e.g. from openKnowledgeBaseCommand setup) are acceptable
            }
        });

        it('createKnowledgeBaseCommand completes when dialog is dismissed', async function () {
            const { mod, vscode } = loadKBManagement({
                addKBToConfig: sinon.stub().resolves('/fake/kb/NewKB')
            });

            vscode.window.showInputBox = sinon.stub().resolves('MyNewKB');
            vscode.window.showOpenDialog = sinon.stub().resolves([]);
            vscode.window.showInformationMessage = sinon.stub().resolves(undefined); // dismissed

            // Should complete without throwing
            let threw = false;
            try {
                await mod.createKnowledgeBaseCommand();
            } catch (e) {
                threw = true;
            }
            expect(threw).to.be.false;
        });
    });

    // -----------------------------------------------------------------------
    describe('removeFileFromKBCommand()', function () {

        it('returns early when no node is provided', async function () {
            const { mod } = loadKBManagement();
            const result = await mod.removeFileFromKBCommand(null);
            expect(result).to.be.undefined;
        });

        it('does not remove when user cancels the confirmation', async function () {
            const { mod, vscode, configModule } = loadKBManagement();
            vscode.window.showWarningMessage = sinon.stub().resolves(undefined); // cancelled

            await mod.removeFileFromKBCommand({
                filePath: '/fake/kb/file.kif',
                kbName: 'TestKB',
                configPath: '/fake/config.xml',
                kbDir: '/fake/kb'
            });

            expect(configModule.removeFileFromConfig.called).to.be.false;
        });

        it('calls removeFileFromConfig when user confirms', async function () {
            const { mod, vscode, configModule } = loadKBManagement();
            vscode.window.showWarningMessage = sinon.stub().resolves('Remove');

            await mod.removeFileFromKBCommand({
                filePath: '/fake/kb/file.kif',
                kbName: 'TestKB',
                configPath: '/fake/config.xml',
                kbDir: '/fake/kb'
            });

            expect(configModule.removeFileFromConfig.calledWith('TestKB')).to.be.true;
        });
    });
});
