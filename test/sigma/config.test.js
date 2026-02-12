const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

describe('Sigma Config (src/sigma/config.js)', () => {
    let vscodeMock;
    let fsMock;
    let engineMock;
    let osMock;
    let runtimeMock;
    
    // Configuration stub
    let configStub;

    beforeEach(() => {
        // Setup VSCode Configuration Mock
        configStub = {
            get: sinon.stub()
        };

        vscodeMock = {
            workspace: {
                getConfiguration: sinon.stub().returns(configStub)
            }
        };

        // Setup System Mocks
        fsMock = {
            existsSync: sinon.stub(),
            readFileSync: sinon.stub()
        };

        // Setup Runtime Mock
        runtimeMock = {
            readFile: sinon.stub(),
            existsAtPath: sinon.stub(),
            getEnvironmentVar: sinon.stub(),
            useDocker: false,
            useLocal: true,
            useNativeJS: false,
            configCache: null
        };

        engineMock = {
            getSigmaRuntime: sinon.stub().returns(runtimeMock),
            getSigmaHome: sinon.stub(),
            getSigmaPath: sinon.stub()
        };

        osMock = {
            homedir: sinon.stub().returns('/mock/home')
        };
    });

    describe('Unit Tests', () => {
        let configModule;

        beforeEach(() => {
            // Load module with full mocks
            configModule = proxyquire('../../src/sigma/config', {
                'vscode': vscodeMock,
                'fs': fsMock,
                './engine': engineMock,
                'os': osMock,
                'path': require('path') // Use real path module
            });
        });

        describe('parseConfigXml', () => {
            it('should parse a local config.xml correctly', async () => {
                const xmlContent = `
                    <configuration>
                        <preference name="kbDir" value="/path/to/kbs" />
                        <kb name="SUMO">
                            <constituent filename="Merge.kif" />
                            <constituent filename="Mid-level-ontology.kif" />
                        </kb>
                    </configuration>
                `;
                
                // Mock runtime.readFile to return content
                runtimeMock.readFile.withArgs('/path/to/config.xml').resolves(xmlContent);

                const result = await configModule.parseConfigXml('/path/to/config.xml');

                assert.strictEqual(result.preferences.kbDir, '/path/to/kbs');
                assert.strictEqual(result.knowledgeBases.SUMO.constituents.length, 2);
                assert.strictEqual(result.knowledgeBases.SUMO.constituents[0], 'Merge.kif');
            });

            it('should return null if file read fails', async () => {
                runtimeMock.readFile.resolves(null);
                const result = await configModule.parseConfigXml('/missing/config.xml');
                assert.strictEqual(result, null);
            });
        });

        describe('findConfigXml', () => {
            it('should return explicit config path if set', async () => {
                configStub.get.withArgs('configXmlPath').returns('/custom/config.xml');
                fsMock.existsSync.withArgs('/custom/config.xml').returns(true);

                const result = await configModule.findConfigXml();
                assert.strictEqual(result, '/custom/config.xml');
            });

            it('should return cached config if available', async () => {
                configStub.get.withArgs('configXmlPath').returns('');
                runtimeMock.configCache = '/cached/config.xml';

                const result = await configModule.findConfigXml();
                assert.strictEqual(result, '/cached/config.xml');
            });

            it('should search runtime paths if enabled', async () => {
                configStub.get.withArgs('configXmlPath').returns('');
                
                // Mock environment variables
                runtimeMock.getEnvironmentVar.withArgs('SIGMA_HOME').resolves('/env/sigma');
                
                // Mock existsAtPath
                runtimeMock.existsAtPath.resolves(false);
                runtimeMock.existsAtPath.withArgs('/env/sigma/KBs/config.xml').resolves(true);

                const result = await configModule.findConfigXml();
                assert.strictEqual(result, '/env/sigma/KBs/config.xml');
                assert.strictEqual(runtimeMock.configCache, '/env/sigma/KBs/config.xml');
            });

            it('should return null for NativeJS runtime', async () => {
                configStub.get.withArgs('configXmlPath').returns('');
                runtimeMock.useNativeJS = true;
                
                const result = await configModule.findConfigXml();
                assert.strictEqual(result, null);
            });
        });
    });

    describe('Integration Tests', function () {
        this.timeout(300000); // 5 minutes for Docker operations

        let integrationModule;
        let Docker;
        let docker;
        let container;

        before(async () => {
            try {
                Docker = require('dockerode');
                docker = new Docker();
                await docker.ping();
            } catch (e) {
                throw new Error('Docker is not running on the testing system. Integration tests require Docker.');
            }
        });

        beforeEach(() => {
            // Construct dependency chain with real modules but mocked VSCode
            const realRuntime = proxyquire('../../src/sigma/engine/runtime', {
                'vscode': vscodeMock,
                'fs': require('fs'),
                'dockerode': require('dockerode')
            });

            const realEngine = proxyquire('../../src/sigma/engine/index', {
                'vscode': vscodeMock,
                './runtime': realRuntime,
                './const': require('../../src/sigma/engine/const')
            });

            integrationModule = proxyquire('../../src/sigma/config', {
                'vscode': vscodeMock,
                './engine': realEngine,
                'fs': require('fs'),
                'os': require('os'),
                'path': require('path')
            });
        });

        afterEach(async () => {
            if (container) {
                try {
                    await container.stop();
                    await container.remove();
                } catch (e) {
                    // Ignore cleanup errors
                }
                container = null;
            }
        });

        it('should parse a real local config file', async () => {
            const tmpDir = os.tmpdir();
            const tmpConfig = path.join(tmpDir, `config-local-${Date.now()}.xml`);
            const xmlContent = '<configuration><preference name="localTest" value="passed"/></configuration>';
            
            try {
                fs.writeFileSync(tmpConfig, xmlContent);
                
                // Configure VSCode mock
                configStub.get.withArgs('sigma.runtime').returns('local');
                configStub.get.withArgs('configXmlPath').returns(tmpConfig);

                const result = await integrationModule.parseConfigXml(tmpConfig);
                assert.strictEqual(result.preferences.localTest, 'passed');

                const found = await integrationModule.findConfigXml();
                assert.strictEqual(found, tmpConfig);
            } finally {
                if (fs.existsSync(tmpConfig)) fs.unlinkSync(tmpConfig);
            }
        });
        
        it('should read config from a real Docker container', async () => {
            const imageName = 'apease/sigmakee';
            
            // Pull image
            await new Promise((resolve, reject) => {
                docker.pull(imageName, (err, stream) => {
                    if (err) return reject(err);
                    docker.modem.followProgress(stream, (err, res) => err ? reject(err) : resolve(res));
                });
            });

            // Start container
            container = await docker.createContainer({
                Image: imageName,
                Cmd: ['sh', '-c', 'while true; do sleep 1000; done']
            });
            await container.start();

            // Create config file in container
            const configPath = '/home/sigma/KBs/config.xml';
            const configDir = path.dirname(configPath);
            const xmlContent = '<configuration><preference name="dockerTest" value="passed"/></configuration>';

            const setupCmd = `mkdir -p ${configDir} && echo '${xmlContent}' > ${configPath}`;
            
            const exec = await container.exec({
                Cmd: ['sh', '-c', setupCmd],
                AttachStdout: true,
                AttachStderr: true
            });
            
            const stream = await exec.start({});
            await new Promise((resolve, reject) => {
                stream.on('end', resolve);
                stream.on('error', reject);
                stream.resume();
            });

            // Configure VSCode mock
            configStub.get.withArgs('sigma.runtime').returns('docker');
            configStub.get.withArgs('sigma.dockerImage').returns(imageName);
            configStub.get.withArgs('configXmlPath').returns('');

            // Test findConfigXml
            const found = await integrationModule.findConfigXml();
            assert.strictEqual(found, configPath);

            // Test parseConfigXml
            const result = await integrationModule.parseConfigXml(found);
            assert.strictEqual(result.preferences.dockerTest, 'passed');
        });
    });
});