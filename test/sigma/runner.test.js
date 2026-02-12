const assert = require('assert');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

describe('Sigma Runner (src/sigma/runner.js)', () => {
    let engineMock;
    let nativeMock;
    let runnerModule;
    let runtimeMock;

    beforeEach(() => {
        // Runtime Mock
        runtimeMock = {
            useDocker: false,
            useLocal: false,
            useNativeJS: false
        };

        // Engine Mock
        engineMock = {
            getSigmaRuntime: sinon.stub().returns(runtimeMock)
        };

        // Native Module Mock
        nativeMock = {
            readKIFFile: sinon.stub(),
            parseKIFFormulas: sinon.stub(),
            convertFormulas: sinon.stub(),
            setLanguage: sinon.stub()
        };

        // Load module with mocks
        runnerModule = proxyquire('../../src/sigma/runner', {
            './engine': engineMock,
            './engine/native/index.js': nativeMock
        });
    });

    describe('runSigma with native runtime', () => {
        beforeEach(() => {
            runtimeMock.useNativeJS = true;
        });

        it('should handle CONVERT action - reads files and returns TPTP content', () => {
            nativeMock.readKIFFile
                .withArgs('/path/to/file1.kif').returns(['(instance Foo Bar)'])
                .withArgs('/path/to/file2.kif').returns(['(subclass Bar Baz)']);
            nativeMock.convertFormulas.returns({ content: 'fof(ax1, axiom, s_instance(s_Foo, s_Bar)).', axiomCount: 2 });

            const result = runnerModule.runSigma(
                ['/path/to/file1.kif', '/path/to/file2.kif'],
                'CONVERT'
            );

            assert(nativeMock.setLanguage.calledWith('fof'));
            assert(nativeMock.readKIFFile.calledTwice);
            assert(nativeMock.convertFormulas.calledOnce);

            const convertArgs = nativeMock.convertFormulas.firstCall.args;
            assert.deepStrictEqual(convertArgs[0], ['(instance Foo Bar)', '(subclass Bar Baz)']);
            assert.strictEqual(convertArgs[2], null); // no conjecture
            assert.strictEqual(convertArgs[3], false); // not a question

            assert.strictEqual(result.content, 'fof(ax1, axiom, s_instance(s_Foo, s_Bar)).');
            assert.strictEqual(result.axiomCount, 2);
        });

        it('should handle CONVERT action with inline target content', () => {
            nativeMock.readKIFFile.withArgs('/path/to/file.kif').returns(['(instance Foo Bar)']);
            nativeMock.parseKIFFormulas.returns(['(subclass Baz Qux)']);
            nativeMock.convertFormulas.returns({ content: 'fof(ax1, axiom, test).', axiomCount: 2 });

            const result = runnerModule.runSigma(
                ['/path/to/file.kif'],
                'CONVERT',
                '(subclass Baz Qux)'
            );

            assert(nativeMock.parseKIFFormulas.calledWith('(subclass Baz Qux)'));
            const convertArgs = nativeMock.convertFormulas.firstCall.args;
            assert.deepStrictEqual(convertArgs[0], ['(instance Foo Bar)', '(subclass Baz Qux)']);
        });

        it('should handle EXPORT_KB action - reads all constituent files', () => {
            nativeMock.readKIFFile
                .withArgs('/kb/Merge.kif').returns(['(instance A B)', '(subclass C D)'])
                .withArgs('/kb/Mid.kif').returns(['(instance E F)']);
            nativeMock.convertFormulas.returns({ content: 'fof(...).', axiomCount: 3 });

            const result = runnerModule.runSigma(
                ['/kb/Merge.kif', '/kb/Mid.kif'],
                'EXPORT_KB'
            );

            assert(nativeMock.readKIFFile.calledTwice);
            const convertArgs = nativeMock.convertFormulas.firstCall.args;
            assert.deepStrictEqual(convertArgs[0], ['(instance A B)', '(subclass C D)', '(instance E F)']);
            assert.strictEqual(convertArgs[1], 'Merge'); // kbName from first file
            assert.strictEqual(convertArgs[2], null); // no conjecture
            assert.strictEqual(convertArgs[3], false); // not a question
        });

        it('should handle PROVE action - reads files and adds target as conjecture', () => {
            nativeMock.readKIFFile.withArgs('/path/to/file.kif').returns(['(instance Foo Bar)']);
            nativeMock.convertFormulas.returns({ content: 'fof(ax1, axiom, ...). fof(query, conjecture, ...)', axiomCount: 1 });

            const result = runnerModule.runSigma(
                ['/path/to/file.kif'],
                'PROVE',
                '(instance ?X Bar)'
            );

            const convertArgs = nativeMock.convertFormulas.firstCall.args;
            assert.deepStrictEqual(convertArgs[0], ['(instance Foo Bar)']);
            assert.strictEqual(convertArgs[2], '(instance ?X Bar)'); // conjecture
            assert.strictEqual(convertArgs[3], true); // isQuestion
        });

        it('should set language from tptpLang parameter', () => {
            nativeMock.readKIFFile.returns([]);
            nativeMock.convertFormulas.returns({ content: '', axiomCount: 0 });

            runnerModule.runSigma([], 'CONVERT', '', 'tff');

            assert(nativeMock.setLanguage.calledWith('tff'));
        });

        it('should throw on unknown action', () => {
            nativeMock.readKIFFile.returns([]);

            assert.throws(
                () => runnerModule.runSigma([], 'INVALID_ACTION'),
                /Unknown action: INVALID_ACTION/
            );
        });
    });

    describe('runSigma without runtime configured', () => {
        it('should throw error when no runtime is configured', () => {
            assert.throws(
                () => runnerModule.runSigma([], 'CONVERT'),
                /No Sigma runtime configured/
            );
        });

        it('should throw descriptive error for Docker runtime', () => {
            runtimeMock.useDocker = true;
            assert.throws(
                () => runnerModule.runSigma([], 'CONVERT'),
                /Docker runner is not implemented/
            );
        });

        it('should throw descriptive error for Local runtime', () => {
            runtimeMock.useLocal = true;
            assert.throws(
                () => runnerModule.runSigma([], 'CONVERT'),
                /Local runner is not implemented/
            );
        });
    });

    describe('runSigmaNative', () => {
        it('should be exported and callable directly', () => {
            nativeMock.readKIFFile.returns([]);
            nativeMock.convertFormulas.returns({ content: '', axiomCount: 0 });

            const result = runnerModule.runSigmaNative([], 'EXPORT_KB');

            assert.strictEqual(result.axiomCount, 0);
        });
    });
});
