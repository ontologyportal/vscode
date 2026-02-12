const assert = require('assert');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
const { EventEmitter } = require('events');

describe('Sigma Runtime (src/sigma/engine/runtime.js)', () => {
    let vscodeMock;
    let fsMock;
    let dockerodeMock;
    let dockerInstanceMock;
    let containerMock;
    let configStub;
    let runtimeModule;

    beforeEach(() => {
        // VSCode Mock
        configStub = {
            get: sinon.stub()
        };
        vscodeMock = {
            workspace: {
                getConfiguration: sinon.stub().returns(configStub)
            }
        };

        // FS Mock
        fsMock = {
            promises: {
                access: sinon.stub(),
                readFile: sinon.stub()
            }
        };

        // Dockerode Mock
        containerMock = {
            exec: sinon.stub(),
            modem: {
                demuxStream: sinon.stub()
            }
        };

        dockerInstanceMock = {
            listContainers: sinon.stub(),
            getContainer: sinon.stub().returns(containerMock)
        };

        dockerodeMock = sinon.stub().returns(dockerInstanceMock);

        // Load module with mocks
        // Note: proxyquire returns a fresh instance, resetting module-level variables like 'runtimeInstance'
        runtimeModule = proxyquire('../../src/sigma/engine/runtime', {
            'vscode': vscodeMock,
            'fs': fsMock,
            'dockerode': dockerodeMock
        });
    });

    describe('getSigmaRuntime', () => {
        it('should return LocalRuntime by default', () => {
            configStub.get.withArgs('sigma.runtime').returns(undefined);
            const runtime = runtimeModule.getSigmaRuntime();
            assert.strictEqual(runtime.useLocal, true);
            assert.strictEqual(runtime.useDocker, false);
            assert.strictEqual(runtime.useNativeJS, false);
        });

        it('should return DockerRuntime when configured', () => {
            configStub.get.withArgs('sigma.runtime').returns('docker');
            const runtime = runtimeModule.getSigmaRuntime();
            assert.strictEqual(runtime.useDocker, true);
        });

        it('should return NativeRuntime when configured', () => {
            configStub.get.withArgs('sigma.runtime').returns('native');
            const runtime = runtimeModule.getSigmaRuntime();
            assert.strictEqual(runtime.useNativeJS, true);
        });

        it('should return singleton instance if runtime type has not changed', () => {
            configStub.get.withArgs('sigma.runtime').returns('local');
            const runtime1 = runtimeModule.getSigmaRuntime();
            const runtime2 = runtimeModule.getSigmaRuntime();
            assert.strictEqual(runtime1, runtime2);
        });
    });

    describe('LocalRuntime', () => {
        let runtime;
        beforeEach(() => {
            configStub.get.withArgs('sigma.runtime').returns('local');
            runtime = runtimeModule.getSigmaRuntime();
        });

        it('getEnvironmentVar should return process env value', async () => {
            process.env.TEST_SIGMA_VAR = 'test_value';
            const val = await runtime.getEnvironmentVar('TEST_SIGMA_VAR');
            assert.strictEqual(val, 'test_value');
            delete process.env.TEST_SIGMA_VAR;
        });

        it('existsAtPath should return true if file exists', async () => {
            fsMock.promises.access.resolves();
            const exists = await runtime.existsAtPath('/path/to/file');
            assert.strictEqual(exists, true);
        });

        it('existsAtPath should return false if file does not exist', async () => {
            fsMock.promises.access.rejects(new Error('ENOENT'));
            const exists = await runtime.existsAtPath('/path/to/file');
            assert.strictEqual(exists, false);
        });

        it('readFile should return content if file exists', async () => {
            fsMock.promises.access.resolves();
            fsMock.promises.readFile.resolves('file content');
            const content = await runtime.readFile('/path/to/file');
            assert.strictEqual(content, 'file content');
        });
    });

    describe('DockerRuntime', () => {
        let runtime;
        beforeEach(() => {
            configStub.get.withArgs('sigma.runtime').returns('docker');
            runtime = runtimeModule.getSigmaRuntime();
        });

        it('getContainerId should return ID of running container', async () => {
            dockerInstanceMock.listContainers.resolves([{ Id: 'container_123', Status: 'running' }]);
            const id = await runtime.getContainerId();
            assert.strictEqual(id, 'container_123');
        });

        it('getContainerId should return null if no container found', async () => {
            dockerInstanceMock.listContainers.resolves([]);
            const id = await runtime.getContainerId();
            assert.strictEqual(id, null);
        });

        describe('Command Execution', () => {
            beforeEach(() => {
                // Ensure container is found
                dockerInstanceMock.listContainers.resolves([{ Id: '123', Status: 'running' }]);
            });

            const mockExec = (output, exitCode = 0) => {
                const execMock = {
                    start: sinon.stub().resolves(new EventEmitter()),
                    inspect: sinon.stub().resolves({ ExitCode: exitCode })
                };
                containerMock.exec.resolves(execMock);
                
                // Simulate stream output
                execMock.start.callsFake(async () => {
                    const stream = new EventEmitter();
                    setTimeout(() => {
                        // Simulate demux writing to stdout (2nd arg)
                        if (containerMock.modem.demuxStream.called) {
                            const stdoutWriter = containerMock.modem.demuxStream.firstCall.args[1].write;
                            if (output) stdoutWriter(Buffer.from(output));
                        }
                        stream.emit('end');
                    }, 1);
                    return stream;
                });
            };

            it('getEnvironmentVar should execute printenv', async () => {
                mockExec('env_value\n');
                const val = await runtime.getEnvironmentVar('MY_VAR');
                
                assert.strictEqual(val, 'env_value');
                assert.strictEqual(containerMock.exec.called, true);
                const cmd = containerMock.exec.firstCall.args[0].Cmd;
                assert.deepStrictEqual(cmd, ['printenv', 'MY_VAR']);
            });

            it('existsAtPath should return true on exit code 0', async () => {
                mockExec('', 0);
                const exists = await runtime.existsAtPath('/some/path');
                assert.strictEqual(exists, true);
            });

            it('existsAtPath should return false on non-zero exit code', async () => {
                mockExec('', 1);
                const exists = await runtime.existsAtPath('/some/path');
                assert.strictEqual(exists, false);
            });
        });
    });
});