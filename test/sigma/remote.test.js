'use strict';

/**
 * Tests for src/sigma/engine/remote.js — RemoteRuntime
 *
 * Strategy
 * --------
 * We spin up a real Node http.Server in each test and point RemoteRuntime at
 * it by overriding _daemonUrl().  This exercises the full HTTP request/response
 * path without touching a real daemon or JVM.
 */

const http    = require('http');
const { expect } = require('chai');
const sinon   = require('sinon');
const proxyquire = require('proxyquire');

// Load RemoteRuntime with its dependencies stubbed for non-VS Code environments.
//
// remote.js → runtime.js → remote.js (circular) and runtime.js → vscode/dockerode.
// Break the cycle by providing a minimal SigmaRuntime stub directly instead of
// loading the full runtime.js chain.
class SigmaRuntimeStub {
    constructor() {
        if (new.target === SigmaRuntimeStub) {
            throw new Error('Cannot instantiate abstract class SigmaRuntime');
        }
    }
    markDirty(_kbName) {}
}

const { RemoteRuntime } = proxyquire('../../src/sigma/engine/remote', {
    './base': { '@noCallThru': true, SigmaRuntime: SigmaRuntimeStub },
    // vscode is required lazily inside _daemonUrl(); sinon stubs it per-test
    // via _daemonUrl() override, so the actual require never fires in these tests.
    vscode: {
        '@noCallThru': true,
        workspace: { getConfiguration: () => ({ get: () => null }) },
    },
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Start a one-shot HTTP server that serves a fixed response, then returns the
 * port it is listening on.
 *
 * @param {Function} handler  (req, res) => void
 * @returns {Promise<{ port: number, server: http.Server }>}
 */
function startMockServer(handler) {
    return new Promise((resolve, reject) => {
        const server = http.createServer(handler);
        server.listen(0, '127.0.0.1', () => {
            resolve({ port: server.address().port, server });
        });
        server.on('error', reject);
    });
}

function sendJson(res, statusCode, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(statusCode, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        let data = '';
        req.setEncoding('utf8');
        req.on('data', chunk => { data += chunk; });
        req.on('end', () => {
            try { resolve(JSON.parse(data || '{}')); }
            catch (e) { reject(e); }
        });
        req.on('error', reject);
    });
}

/**
 * Build a RemoteRuntime whose _daemonUrl() returns the given URL.
 */
function buildRemote(url) {
    const rt = new RemoteRuntime();
    sinon.stub(rt, '_daemonUrl').returns(url);
    return rt;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RemoteRuntime', function () {

    let server;
    afterEach(function (done) {
        sinon.restore();
        if (server) { server.close(() => { server = null; done(); }); }
        else done();
    });

    // -----------------------------------------------------------------------
    describe('getName()', function () {
        it('returns "remote"', function () {
            const rt = new RemoteRuntime();
            expect(rt.getName()).to.equal('remote');
        });
    });

    // -----------------------------------------------------------------------
    describe('initialize()', function () {

        it('resolves when the daemon responds 200 to GET /status', async function () {
            ({ server } = await startMockServer((req, res) => {
                expect(req.method).to.equal('GET');
                expect(req.url).to.equal('/status');
                sendJson(res, 200, { ok: true, kbs: [] });
            }));
            const rt = buildRemote(`http://127.0.0.1:${server.address().port}`);
            await rt.initialize();   // should not throw
        });

        it('throws a helpful message when connection is refused', async function () {
            // Use a port that nothing is listening on.
            const rt = buildRemote('http://127.0.0.1:1');
            let threw = null;
            try { await rt.initialize(); }
            catch (e) { threw = e; }
            expect(threw).to.exist;
            expect(threw.message).to.include('not running');
            expect(threw.message).to.include('src/sigma/daemon.js');
        });

        it('throws when the daemon responds with an error status', async function () {
            ({ server } = await startMockServer((req, res) => {
                sendJson(res, 500, { error: 'internal failure' });
            }));
            const rt = buildRemote(`http://127.0.0.1:${server.address().port}`);
            let threw = null;
            try { await rt.initialize(); }
            catch (e) { threw = e; }
            expect(threw).to.exist;
            expect(threw.message).to.include('internal failure');
        });
    });

    // -----------------------------------------------------------------------
    describe('shutdown()', function () {
        it('is a no-op and resolves without error', async function () {
            const rt = new RemoteRuntime();
            await rt.shutdown();  // should not throw
        });
    });

    // -----------------------------------------------------------------------
    describe('ask()', function () {

        it('POSTs to /ask and returns the parsed result', async function () {
            const mockResult = { status: 'Theorem', answers: ['Human'], proof: [] };
            let receivedBody;

            ({ server } = await startMockServer(async (req, res) => {
                receivedBody = await readBody(req);
                sendJson(res, 200, mockResult);
            }));

            const rt = buildRemote(`http://127.0.0.1:${server.address().port}`);
            const result = await rt.ask('SUMO', 's1', '(instance ?X Human)', { timeout: 60 });

            expect(result).to.deep.equal(mockResult);
            expect(receivedBody.kb).to.equal('SUMO');
            expect(receivedBody.sessionId).to.equal('s1');
            expect(receivedBody.query).to.equal('(instance ?X Human)');
            expect(receivedBody.options).to.deep.equal({ timeout: 60 });
        });

        it('flushes dirty KBs before asking', async function () {
            const requests = [];
            ({ server } = await startMockServer(async (req, res) => {
                requests.push({ method: req.method, url: req.url });
                await readBody(req);
                if (req.url === '/reload') sendJson(res, 200, { ok: true });
                else sendJson(res, 200, { status: 'Theorem', answers: [], proof: [] });
            }));

            const rt = buildRemote(`http://127.0.0.1:${server.address().port}`);
            rt.markDirty('SUMO');
            await rt.ask('SUMO', '', '(instance ?X Human)');

            expect(requests[0].url).to.equal('/reload');
            expect(requests[1].url).to.equal('/ask');
        });

        it('clears dirty set after flushing', async function () {
            const reloadCalls = [];
            ({ server } = await startMockServer(async (req, res) => {
                await readBody(req);
                if (req.url === '/reload') {
                    reloadCalls.push(true);
                    sendJson(res, 200, { ok: true });
                } else {
                    sendJson(res, 200, { status: 'Theorem', answers: [], proof: [] });
                }
            }));

            const rt = buildRemote(`http://127.0.0.1:${server.address().port}`);
            rt.markDirty('SUMO');

            await rt.ask('SUMO', '', '(instance ?X Human)');  // flushes once
            await rt.ask('SUMO', '', '(instance ?X Human)');  // dirty set already clear

            expect(reloadCalls).to.have.length(1);
        });

        it('throws when the daemon returns an error', async function () {
            ({ server } = await startMockServer(async (req, res) => {
                await readBody(req);
                sendJson(res, 500, { error: 'JVM exploded' });
            }));
            const rt = buildRemote(`http://127.0.0.1:${server.address().port}`);
            let threw = null;
            try { await rt.ask('SUMO', '', '(instance ?X Human)'); }
            catch (e) { threw = e; }
            expect(threw).to.exist;
            expect(threw.message).to.include('JVM exploded');
        });
    });

    // -----------------------------------------------------------------------
    describe('tell()', function () {

        it('POSTs to /tell and returns the errors array', async function () {
            let receivedBody;
            ({ server } = await startMockServer(async (req, res) => {
                receivedBody = await readBody(req);
                sendJson(res, 200, { errors: [] });
            }));
            const rt = buildRemote(`http://127.0.0.1:${server.address().port}`);
            const errors = await rt.tell('SUMO', 's1', '(instance Fluffy Cat)');

            expect(errors).to.deep.equal([]);
            expect(receivedBody.kb).to.equal('SUMO');
            expect(receivedBody.sessionId).to.equal('s1');
            expect(receivedBody.statement).to.equal('(instance Fluffy Cat)');
        });

        it('returns non-empty errors from the daemon', async function () {
            ({ server } = await startMockServer(async (req, res) => {
                await readBody(req);
                sendJson(res, 200, { errors: ['Syntax error'] });
            }));
            const rt = buildRemote(`http://127.0.0.1:${server.address().port}`);
            const errors = await rt.tell('SUMO', '', '(bad');
            expect(errors).to.deep.equal(['Syntax error']);
        });
    });

    // -----------------------------------------------------------------------
    describe('reloadKB()', function () {

        it('POSTs to /reload with the kb name', async function () {
            let receivedBody;
            ({ server } = await startMockServer(async (req, res) => {
                receivedBody = await readBody(req);
                sendJson(res, 200, { ok: true });
            }));
            const rt = buildRemote(`http://127.0.0.1:${server.address().port}`);
            await rt.reloadKB('SUMO');
            expect(receivedBody.kb).to.equal('SUMO');
        });

        it('removes the kb from the dirty set so it is not double-reloaded', async function () {
            const reloadCalls = [];
            ({ server } = await startMockServer(async (req, res) => {
                const body = await readBody(req);
                reloadCalls.push(body.kb);
                sendJson(res, 200, { ok: true });
            }));
            const rt = buildRemote(`http://127.0.0.1:${server.address().port}`);
            rt.markDirty('SUMO');
            await rt.reloadKB('SUMO');
            // Calling _flushDirty should now be a no-op for SUMO
            await rt._flushDirty();
            expect(reloadCalls).to.have.length(1);
        });
    });

    // -----------------------------------------------------------------------
    describe('markDirty() / _flushDirty()', function () {

        it('accumulates multiple dirty KBs and flushes each once', async function () {
            const reloaded = [];
            ({ server } = await startMockServer(async (req, res) => {
                const body = await readBody(req);
                reloaded.push(body.kb);
                sendJson(res, 200, { ok: true });
            }));
            const rt = buildRemote(`http://127.0.0.1:${server.address().port}`);
            rt.markDirty('SUMO');
            rt.markDirty('MyCorp');
            rt.markDirty('SUMO');  // duplicate — should flush only once
            await rt._flushDirty();
            expect(reloaded).to.have.length(2);
            expect(reloaded).to.include('SUMO');
            expect(reloaded).to.include('MyCorp');
        });

        it('is a no-op when the dirty set is empty', async function () {
            let requestCount = 0;
            ({ server } = await startMockServer((req, res) => {
                requestCount++;
                sendJson(res, 200, { ok: true });
            }));
            const rt = buildRemote(`http://127.0.0.1:${server.address().port}`);
            await rt._flushDirty();
            expect(requestCount).to.equal(0);
        });
    });

    // -----------------------------------------------------------------------
    describe('unsupported operations', function () {

        it('compileKB() throws "not supported"', async function () {
            const rt = new RemoteRuntime();
            let threw = null;
            try { await rt.compileKB({}, 'SUMO'); }
            catch (e) { threw = e; }
            expect(threw).to.exist;
            expect(threw.message).to.include('not supported');
        });

        it('compileFormulas() throws "not supported"', async function () {
            const rt = new RemoteRuntime();
            let threw = null;
            try { await rt.compileFormulas({}, []); }
            catch (e) { threw = e; }
            expect(threw).to.exist;
            expect(threw.message).to.include('not supported');
        });
    });
});
