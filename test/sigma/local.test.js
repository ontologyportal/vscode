'use strict';

/**
 * Tests for src/sigma/engine/local.js — LocalRuntimeRunner
 *
 * Strategy
 * --------
 * We use the REAL js4j JVMView / JavaClass / JavaObject proxy machinery so
 * that the tests exercise the same gateway proxy-traversal paths as the live
 * code.  Only the underlying client methods (callMethod, callConstructor) and
 * the gateway-level helpers (newArray, getField, setField) are sinon stubs.
 *
 * Each test targets one specific step inside writeFile and emits a precise
 * failure message, making it easy to pinpoint where the function breaks.
 */

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire');

// Use real js4j proxy machinery — same code path as production.
const {
    JVMView,
    createJavaObject,
    ProxyPool,
    Js4JJavaError,
} = require('js4j');

// Load the module under test.
// Stub only the things that need a real VS Code host or a Java process.
// js4j itself is intentionally NOT stubbed here.
// '@noCallThru': true prevents proxyquire from trying to resolve the real
// 'vscode' module (which only exists inside a VS Code extension host).
const { LocalRuntimeRunner } = proxyquire('../../src/sigma/engine/local', {
    glob:   { '@noCallThru': true, globSync: () => [] },
    vscode: { '@noCallThru': true, workspace: { getConfiguration: () => ({ get: () => null }) } },
    // 'js4j' is NOT overridden — real module is used
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const STATIC_PREFIX = 'z:';   // from js4j/src/protocol.js — used in callMethod target IDs

// Target IDs used for all mock Java objects returned by callMethod /
// callConstructor.  Anything meaningful can go here — we just need them to be
// unique and recognisable in assertion messages.
const IDS = {
    mgr:       'o:KBmanager.mgr',
    skbtptpkb: 'o:SUMOKBtoTPTPKB',
    kb:        'o:KB',
    pw:        'o:PrintWriter',
    formula:   'o:Formula',
};

// ---------------------------------------------------------------------------
// Test rig
// ---------------------------------------------------------------------------

/**
 * Build a fully-wired, pre-initialised LocalRuntimeRunner with a mock gateway.
 *
 * opts allows individual steps to be overridden for error-path tests:
 *   opts.getKBResult      — override what mgr.getKB() returns (default: mockKb)
 *   opts.writeFileResult  — override what skbtptpkb.writeFile() returns
 *   opts.printWriterError — make PrintWriter(fileName) throw this
 *   opts.skbtptpkbError   — make SUMOKBtoTPTPKB() throw this
 *   opts.toPrologResult   — override conjecture Formula.toProlog() return
 *   opts.closeError       — make pw.close() throw this
 */
function buildTestRig(opts = {}) {
    const proxyPool = new ProxyPool();

    // --- Mock client ---------------------------------------------------------
    // callMethod / callConstructor are the two network-touching operations that
    // the JavaClass / JavaObject proxies ultimately delegate to.
    const callMethod     = sinon.stub();
    const callConstructor = sinon.stub();

    const client = {
        _proxyPool: proxyPool,
        callMethod,
        callConstructor,
    };

    // --- Mock Java objects ---------------------------------------------------
    // Use real createJavaObject so that e.g. mgr.getKB(x) goes through the
    // proxy and calls callMethod(IDS.mgr, 'getKB', [x]) — exactly as in prod.
    const mockMgr       = createJavaObject(IDS.mgr,       client);
    const mockSkbtptpkb = createJavaObject(IDS.skbtptpkb, client);
    const mockKb        = createJavaObject(IDS.kb,        client);
    const mockPw        = createJavaObject(IDS.pw,        client);
    const mockFormula   = createJavaObject(IDS.formula,   client);

    // --- Wire up callMethod --------------------------------------------------
    callMethod.callsFake(async (targetId, method, args) => {
        // KBmanager.getMgr() — called twice in writeFile
        if (targetId === STATIC_PREFIX + 'com.articulate.sigma.KBmanager' && method === 'getMgr') {
            return mockMgr;
        }
        // mgr.getKB(kbName)
        if (targetId === IDS.mgr && method === 'getKB') {
            return 'getKBResult' in opts ? opts.getKBResult : mockKb;
        }
        // skbtptpkb.writeFile(fileName, conjecture, isQuestion, pw)
        if (targetId === IDS.skbtptpkb && method === 'writeFile') {
            if ('writeFileResult' in opts) return opts.writeFileResult;
            return '/out/sumo.tptp';
        }
        // pw.close() — flushes and closes the underlying stream
        if (targetId === IDS.pw && method === 'close') {
            if (opts.closeError) throw opts.closeError;
            return null;
        }
        // Formula.toProlog() — used in conjecture validation
        if (method === 'toProlog') {
            return opts.toPrologResult !== undefined ? opts.toPrologResult : true;
        }

        throw new Error(
            `[buildTestRig] Unexpected callMethod(${targetId}, ${method}, [${args.map(String)}])\n` +
            'Add a handler in buildTestRig or override the relevant opt.'
        );
    });

    // --- Wire up callConstructor ---------------------------------------------
    callConstructor.callsFake(async (classFqn, args) => {
        if (classFqn === 'com.articulate.sigma.trans.SUMOKBtoTPTPKB') {
            if (opts.skbtptpkbError) throw opts.skbtptpkbError;
            return mockSkbtptpkb;
        }
        if (classFqn === 'java.io.PrintWriter') {
            if (opts.printWriterError) throw opts.printWriterError;
            return mockPw;
        }
        if (classFqn === 'com.articulate.sigma.Formula') {
            return mockFormula;
        }

        throw new Error(
            `[buildTestRig] Unexpected callConstructor(${classFqn})\n` +
            'Add a handler in buildTestRig or override the relevant opt.'
        );
    });

    // --- Mock gateway --------------------------------------------------------
    // setField lives on the JavaGateway object (not the client).
    const gateway = {
        jvm:      new JVMView(client),
        setField: sinon.stub().resolves(),
    };

    // --- Pre-initialised runner ----------------------------------------------
    const runner = new LocalRuntimeRunner();
    runner.initialized = true;
    runner.gateway     = gateway;

    return {
        runner, gateway, client, callMethod, callConstructor,
        mockMgr, mockSkbtptpkb, mockKb, mockPw, mockFormula,
    };
}

// Helper: find a callMethod call by target and method name
function findCall(stub, targetId, method) {
    return stub.getCalls().find(c => c.args[0] === targetId && c.args[1] === method) || null;
}

// Helper: run writeFile and return the thrown error (fails the test if nothing throws)
async function catchFrom(runner, ...args) {
    try {
        await runner.writeFile(...args);
        throw new Error('Expected writeFile to throw but it did not');
    } catch (e) {
        return e;
    }
}

// ---------------------------------------------------------------------------
describe('LocalRuntimeRunner', function () {
    afterEach(() => sinon.restore());

    // -----------------------------------------------------------------------
    describe('writeFile() — pre-condition', function () {

        it('throws immediately when not initialized', async function () {
            const { runner } = buildTestRig();
            runner.initialized = false;
            const err = await catchFrom(runner, '/out/sumo.tptp', 'SUMO');
            expect(err.message).to.include('initialized',
                'writeFile must throw before touching the gateway when not initialized');
        });
    });

    // -----------------------------------------------------------------------
    describe('writeFile() — KB lookup (getMgr / getKB)', function () {

        it('calls KBmanager.getMgr() to obtain the manager object', async function () {
            const { runner, callMethod } = buildTestRig();
            await runner.writeFile('/out/sumo.tptp', 'SUMO');

            const call = findCall(callMethod, `${STATIC_PREFIX}com.articulate.sigma.KBmanager`, 'getMgr');
            expect(call, 'callMethod(z:KBmanager, getMgr) should have been invoked').to.exist;
        });

        it('calls mgr.getKB() with the KB name provided to writeFile', async function () {
            const { runner, callMethod } = buildTestRig();
            await runner.writeFile('/out/sumo.tptp', 'MY_KB');

            const call = findCall(callMethod, IDS.mgr, 'getKB');
            expect(call, 'callMethod(mgr, getKB) should have been invoked').to.exist;
            expect(call.args[2][0]).to.equal('MY_KB',
                'getKB() must be called with the kbName argument passed to writeFile()');
        });

        it('throws with "Unknown KB" when getKB returns null', async function () {
            const { runner } = buildTestRig({ getKBResult: null });
            const err = await catchFrom(runner, '/out/sumo.tptp', 'NoSuchKB');
            expect(err.message).to.include('Unknown KB',
                'writeFile should throw "Unknown KB: ..." when getKB returns null');
            expect(err.message).to.include('NoSuchKB');
        });

        it('throws with "Unknown KB" when getKB returns undefined', async function () {
            const { runner } = buildTestRig({ getKBResult: undefined });
            const err = await catchFrom(runner, '/out/sumo.tptp', 'MissingKB');
            expect(err.message).to.include('Unknown KB');
        });
    });

    // -----------------------------------------------------------------------
    describe('writeFile() — SUMOKBtoTPTPKB construction', function () {

        it('constructs com.articulate.sigma.trans.SUMOKBtoTPTPKB with no arguments', async function () {
            const { runner, callConstructor } = buildTestRig();
            await runner.writeFile('/out/sumo.tptp', 'SUMO');

            const call = callConstructor.getCalls().find(
                c => c.args[0] === 'com.articulate.sigma.trans.SUMOKBtoTPTPKB'
            );
            expect(call, 'callConstructor(SUMOKBtoTPTPKB) should have been invoked').to.exist;
            expect(call.args[1]).to.deep.equal([],
                'SUMOKBtoTPTPKB constructor should be called with no arguments');
        });

        it('sets the "kb" field on the SUMOKBtoTPTPKB instance to the resolved KB object', async function () {
            const { runner, gateway, mockSkbtptpkb, mockKb } = buildTestRig();
            await runner.writeFile('/out/sumo.tptp', 'SUMO');

            expect(gateway.setField.calledOnce).to.be.true;
            const [obj, field, value] = gateway.setField.firstCall.args;
            expect(obj).to.equal(mockSkbtptpkb,
                'setField first arg must be the SUMOKBtoTPTPKB instance');
            expect(field).to.equal('kb',
                'setField field name must be "kb"');
            expect(value).to.equal(mockKb,
                'setField value must be the KB object returned by getKB()');
        });
    });

    // -----------------------------------------------------------------------
    describe('writeFile() — PrintWriter construction', function () {

        it('constructs java.io.PrintWriter(fileName) directly', async function () {
            const { runner, callConstructor } = buildTestRig();
            await runner.writeFile('/out/sumo.tptp', 'SUMO');

            const call = callConstructor.getCalls()
                .find(c => c.args[0] === 'java.io.PrintWriter');
            expect(call, 'callConstructor(java.io.PrintWriter) should be invoked').to.exist;
            expect(call.args[1]).to.deep.equal(['/out/sumo.tptp'],
                'PrintWriter must be constructed directly from the fileName string');
        });

        it('wraps PrintWriter construction errors with a descriptive message', async function () {
            const { runner } = buildTestRig({ printWriterError: new Error('Permission denied') });
            const err = await catchFrom(runner, '/out/sumo.tptp', 'SUMO');
            expect(err.message).to.include('/out/sumo.tptp');
            expect(err.message).to.match(/Error opening/i);
        });

        it('surfaces the Java exception message (not the raw protocol payload) from Js4JJavaError', async function () {
            const javaErr = new Js4JJavaError('java.io.IOException', 'ro5', {
                getMessage: async () => 'No such file or directory',
                _targetId: 'o:throwable',
            });
            const { runner } = buildTestRig({ printWriterError: javaErr });
            const err = await catchFrom(runner, '/out/sumo.tptp', 'SUMO');

            expect(err.message).to.include('/out/sumo.tptp',
                'Wrapped error must include the output filename');
            expect(err.message).to.include('No such file or directory',
                'Wrapped error must include the human-readable Java exception message');
            expect(err.message).to.not.include('ro5',
                'Wrapped error must NOT contain the raw protocol payload');
        });
    });

    // -----------------------------------------------------------------------
    describe('writeFile() — closing the PrintWriter', function () {

        it('calls pw.close() after skbtptpkb.writeFile returns', async function () {
            const { runner, callMethod } = buildTestRig();
            await runner.writeFile('/out/sumo.tptp', 'SUMO');

            const closeCall  = findCall(callMethod, IDS.pw, 'close');
            const writeCall  = findCall(callMethod, IDS.skbtptpkb, 'writeFile');
            expect(closeCall, 'pw.close() must be called to flush the buffer to disk').to.exist;

            // close must come after the writeFile call
            const closedAfterWrite = closeCall.callId > writeCall.callId;
            expect(closedAfterWrite, 'pw.close() must be called after skbtptpkb.writeFile()').to.be.true;
        });

        it('calls pw.close() even when skbtptpkb.writeFile returns null', async function () {
            const { runner, callMethod } = buildTestRig({ writeFileResult: null });
            await catchFrom(runner, '/out/sumo.tptp', 'SUMO');

            const closeCall = findCall(callMethod, IDS.pw, 'close');
            expect(closeCall, 'pw.close() must be called even on a failed writeFile to avoid leaking the file handle').to.exist;
        });
    });

    // -----------------------------------------------------------------------
    describe('writeFile() — skbtptpkb.writeFile() call', function () {

        it('calls skbtptpkb.writeFile(fileName, null, isQuestion, pw) when no conjecture', async function () {
            const { runner, callMethod, mockPw } = buildTestRig();
            await runner.writeFile('/out/sumo.tptp', 'SUMO', null, false);

            const call = findCall(callMethod, IDS.skbtptpkb, 'writeFile');
            expect(call, 'callMethod(skbtptpkb, writeFile) should be invoked').to.exist;

            const [fileName, conjecture, isQuestion, pw] = call.args[2];
            expect(fileName).to.equal('/out/sumo.tptp',
                'First arg to skbtptpkb.writeFile must be the output fileName');
            expect(conjecture).to.be.null;
            expect(isQuestion).to.equal(false,
                'isQuestion must be false when not specified');
            expect(pw).to.equal(mockPw,
                'Fourth arg must be the PrintWriter constructed from the BufferedWriter');
        });

        it('passes isQuestion=true through to skbtptpkb.writeFile', async function () {
            const { runner, callMethod } = buildTestRig();
            await runner.writeFile('/out/sumo.tptp', 'SUMO', null, true);

            const call = findCall(callMethod, IDS.skbtptpkb, 'writeFile');
            expect(call.args[2][2]).to.equal(true,
                'isQuestion=true must be forwarded to skbtptpkb.writeFile');
        });

        it('throws "Failed to generated TPTP" when skbtptpkb.writeFile returns null', async function () {
            const { runner } = buildTestRig({ writeFileResult: null });
            const err = await catchFrom(runner, '/out/sumo.tptp', 'SUMO');
            expect(err.message).to.include('Failed to generated TPTP',
                'Null return from skbtptpkb.writeFile should produce the TPTP-generation error');
        });

        it('throws "Failed to generated TPTP" when skbtptpkb.writeFile returns undefined', async function () {
            const { runner } = buildTestRig({ writeFileResult: undefined });
            const err = await catchFrom(runner, '/out/sumo.tptp', 'SUMO');
            expect(err.message).to.include('Failed to generated TPTP');
        });

        it('returns the fileName on success', async function () {
            const { runner } = buildTestRig();
            const result = await runner.writeFile('/out/sumo.tptp', 'SUMO');
            expect(result).to.equal('/out/sumo.tptp',
                'writeFile should return the fileName argument unchanged on success');
        });
    });

    // -----------------------------------------------------------------------
    describe('writeFile() — conjecture formula', function () {

        it('constructs a com.articulate.sigma.Formula from the conjecture string', async function () {
            const { runner, callConstructor } = buildTestRig();
            await runner.writeFile('/out/sumo.tptp', 'SUMO', '(instance Foo Bar)', false);

            const call = callConstructor.getCalls()
                .find(c => c.args[0] === 'com.articulate.sigma.Formula');
            expect(call, 'callConstructor(Formula) should be invoked when conjecture is provided').to.exist;
            expect(call.args[1][0]).to.equal('(instance Foo Bar)',
                'Formula constructor must receive the conjecture string');
        });

        it('passes the Formula object as the second argument to skbtptpkb.writeFile', async function () {
            const { runner, callMethod, mockFormula } = buildTestRig();
            await runner.writeFile('/out/sumo.tptp', 'SUMO', '(instance Foo Bar)', false);

            const call = findCall(callMethod, IDS.skbtptpkb, 'writeFile');
            expect(call.args[2][1]).to.equal(mockFormula,
                'The Formula object must be passed as the conjecture argument to skbtptpkb.writeFile');
        });

        it('validates the formula by calling toProlog() on it', async function () {
            const { runner, callMethod } = buildTestRig();
            await runner.writeFile('/out/sumo.tptp', 'SUMO', '(instance Foo Bar)', false);

            const call = findCall(callMethod, IDS.formula, 'toProlog');
            expect(call, 'toProlog() should be called on the Formula to validate it').to.exist;
        });

        it('throws "Bad conjecture formula" when toProlog() returns null', async function () {
            const { runner } = buildTestRig({ toPrologResult: null });
            const err = await catchFrom(runner, '/out/sumo.tptp', 'SUMO', '(bad formula)', false);
            expect(err.message).to.equal('Bad conjecture formula',
                'writeFile must reject a conjecture whose toProlog() returns falsy');
        });

        it('throws "Bad conjecture formula" when toProlog() returns empty string', async function () {
            const { runner } = buildTestRig({ toPrologResult: '' });
            const err = await catchFrom(runner, '/out/sumo.tptp', 'SUMO', '(bad)', false);
            expect(err.message).to.equal('Bad conjecture formula');
        });
    });

    // -----------------------------------------------------------------------
    describe('stop()', function () {

        it('does nothing when not initialized', async function () {
            const runner = new LocalRuntimeRunner();
            const kill = sinon.stub().resolves();
            runner.killProcessCallback = kill;
            await runner.stop();
            expect(kill.called).to.be.false;
        });

        it('calls killProcessCallback and resets all state when initialized', async function () {
            const runner = new LocalRuntimeRunner();
            runner.initialized = true;
            runner.gateway    = {};
            runner.executor   = {};
            const kill = sinon.stub().resolves();
            runner.killProcessCallback = kill;

            await runner.stop();

            expect(kill.calledOnce).to.be.true;
            expect(runner.initialized).to.be.false;
            expect(runner.gateway).to.be.null;
            expect(runner.executor).to.be.null;
            expect(runner.killProcessCallback).to.be.null;
        });
    });

    // -----------------------------------------------------------------------
    describe('tell()', function () {

        it('throws when not initialized', async function () {
            const runner = new LocalRuntimeRunner();
            let threw = null;
            try { await runner.tell('SUMO', '(instance Foo Bar)'); }
            catch (e) { threw = e; }
            expect(threw).to.exist;
            expect(threw.message).to.include('initialized');
        });

        it('throws "Unknown KB" when getKB returns null', async function () {
            const { runner } = buildTestRig({ getKBResult: null });
            let threw = null;
            try { await runner.tell('BadKB', '(instance Foo Bar)'); }
            catch (e) { threw = e; }
            expect(threw).to.exist;
            expect(threw.message).to.include('Unknown KB');
        });
    });

    // -----------------------------------------------------------------------
    describe('ask()', function () {

        it('throws when not initialized', async function () {
            const runner = new LocalRuntimeRunner();
            let threw = null;
            try { await runner.ask('SUMO', '(instance ?X Human)'); }
            catch (e) { threw = e; }
            expect(threw).to.exist;
            expect(threw.message).to.include('initialized');
        });

        it('throws "Unknown KB" when getKB returns null', async function () {
            const { runner } = buildTestRig({ getKBResult: null });
            let threw = null;
            try { await runner.ask('BadKB', '(instance ?X Human)'); }
            catch (e) { threw = e; }
            expect(threw).to.exist;
            expect(threw.message).to.include('Unknown KB');
        });

        it('throws "Unsupported engine" for unknown engine names', async function () {
            const { runner } = buildTestRig();
            let threw = null;
            try { await runner.ask('SUMO', '(instance ?X Human)', { engine: 'prolog' }); }
            catch (e) { threw = e; }
            expect(threw).to.exist;
            expect(threw.message).to.include('Unsupported engine');
        });
    });
});

