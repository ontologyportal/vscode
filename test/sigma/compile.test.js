const assert = require('assert');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
const { EventEmitter } = require('events');

describe('Sigma Compilation (src/sigma/compile.js)', () => {
    let vscodeMock;
    let childProcessMock;
    let engineMock;
    let indexMock;
    let fsMock;
    let outputChannelMock;
    let compileModule;
    let runtimeMock;

    beforeEach(() => {
        // Output Channel Mock
        outputChannelMock = {
            show: sinon.stub(),
            appendLine: sinon.stub(),
            append: sinon.stub()
        };

        // VSCode Mock
        vscodeMock = {
            window: {
                createOutputChannel: sinon.stub().returns(outputChannelMock)
            },
            workspace: {
                getConfiguration: sinon.stub(),
                workspaceFolders: [{ uri: { fsPath: '/workspace' } }]
            }
        };

        // Child Process Mock
        childProcessMock = {
            spawn: sinon.stub()
        };

        // Runtime Mock
        runtimeMock = {
            useDocker: false,
            useLocal: false,
            useNativeJS: false,
            docker: null
        };

        // Engine Mock
        engineMock = {
            getSigmaRuntime: sinon.stub().returns(runtimeMock),
            getSigmaPath: sinon.stub().returns('/sigma/path')
        };

        // Index Mock
        indexMock = {
            isWithinConfiguredKB: sinon.stub(),
            getKBConstituentsFromConfig: sinon.stub()
        };

        // FS Mock
        fsMock = {
            readFileSync: sinon.stub(),
            writeFileSync: sinon.stub()
        };

        // Load module
        compileModule = proxyquire('../../src/sigma/compile', {
            'vscode': vscodeMock,
            'child_process': childProcessMock,
            './engine': engineMock,
            './index': indexMock,
            'fs': fsMock
        });
    });

    describe('compileKB', () => {
        it('should error if not in a configured KB', async () => {
            indexMock.isWithinConfiguredKB.returns(null);
            await compileModule.compileKB();
            assert(outputChannelMock.appendLine.calledWithMatch(/Error: Current workspace is not a configured Knowledge Base/));
        });

        it('should use Local runtime', async () => {
            indexMock.isWithinConfiguredKB.returns({ kbName: 'SUMO' });
            runtimeMock.useLocal = true;
            
            const procMock = new EventEmitter();
            procMock.stdout = new EventEmitter();
            procMock.stderr = new EventEmitter();
            childProcessMock.spawn.returns(procMock);

            await compileModule.compileKB();

            assert(childProcessMock.spawn.calledOnce);
            const args = childProcessMock.spawn.firstCall.args;
            assert.strictEqual(args[0], 'java');
            assert(args[1].some(arg => arg.includes('SUMOKBtoTPTPKB')));
        });

        it('should error if SIGMA_SRC/CP missing in Local runtime', async () => {
            indexMock.isWithinConfiguredKB.returns({ kbName: 'SUMO' });
            runtimeMock.useLocal = true;
            engineMock.getSigmaPath.returns(null);
            
            const originalSrc = process.env.SIGMA_SRC;
            const originalCp = process.env.SIGMA_CP;
            delete process.env.SIGMA_SRC;
            delete process.env.SIGMA_CP;

            try {
                await compileModule.compileKB();
                assert(outputChannelMock.appendLine.calledWithMatch(/Error: SIGMA_SRC or SIGMA_CP environment variable not set/));
                assert(childProcessMock.spawn.notCalled);
            } finally {
                if (originalSrc) process.env.SIGMA_SRC = originalSrc;
                if (originalCp) process.env.SIGMA_CP = originalCp;
            }
        });

        it('should use Docker runtime', async () => {
            indexMock.isWithinConfiguredKB.returns({ kbName: 'SUMO' });
            runtimeMock.useDocker = true;
            runtimeMock.docker = {
                run: sinon.stub().yields(null, { StatusCode: 0 })
            };
            
            vscodeMock.workspace.getConfiguration.returns({
                get: sinon.stub().returns('my/image')
            });

            await compileModule.compileKB();

            assert(runtimeMock.docker.run.calledOnce);
            const args = runtimeMock.docker.run.firstCall.args;
            assert.strictEqual(args[0], 'my/image');
            assert(args[1][2].includes('SUMOKBtoTPTPKB'));
        });
    });

    describe('compileFormulas', () => {
        it('should error if no formulas provided', async () => {
            await compileModule.compileFormulas([]);
            assert(outputChannelMock.appendLine.calledWithMatch(/Error: No formulas provided/));
        });

        it('should compile formulas using Local runtime', async () => {
            runtimeMock.useLocal = true;
            const formulas = ['(instance Foo Bar)', '(subclass Bar Baz)'];
            
            const procMock = new EventEmitter();
            procMock.stdout = new EventEmitter();
            procMock.stderr = new EventEmitter();
            childProcessMock.spawn.returns(procMock);

            await compileModule.compileFormulas(formulas);

            assert(childProcessMock.spawn.calledOnce);
            const args = childProcessMock.spawn.firstCall.args;
            assert(args[1].some(arg => arg.includes('SUMOformulaToTPTPformula')));
            
            // Check formula construction
            const gIndex = args[1].indexOf('-g');
            assert(gIndex !== -1);
            const formulaArg = args[1][gIndex + 1];
            assert(formulaArg.includes('(and (instance Foo Bar) (subclass Bar Baz))'));
        });

        it('should compile formulas using Docker runtime', async () => {
            runtimeMock.useDocker = true;
            runtimeMock.docker = {
                run: sinon.stub().yields(null, { StatusCode: 0 })
            };
            vscodeMock.workspace.getConfiguration.returns({
                get: sinon.stub().returns('my/image')
            });

            const formulas = ['(instance Foo Bar)'];
            await compileModule.compileFormulas(formulas);

            assert(runtimeMock.docker.run.calledOnce);
            const cmd = runtimeMock.docker.run.firstCall.args[1][2];
            assert(cmd.includes('SUMOformulaToTPTPformula'));
            assert(cmd.includes('(and (instance Foo Bar))'));
        });
    });
});