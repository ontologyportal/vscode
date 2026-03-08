'use strict';

/**
 * Tests for src/sigma/daemon.js — createDaemonServer()
 *
 * Strategy
 * --------
 * We inject a mock runner (plain JS object with sinon stubs) and spin up the
 * HTTP server on a random port.  Each test sends real HTTP requests and asserts
 * on both the response body and the runner calls.  No JVM is involved.
 */

const http    = require('http');
const { expect } = require('chai');
const sinon   = require('sinon');

const { createDaemonServer } = require('../../src/sigma/daemon');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Send an HTTP request and return { statusCode, body } (body parsed as JSON).
 */
function request(port, method, path, payload) {
    return new Promise((resolve, reject) => {
        const body = payload ? JSON.stringify(payload) : null;
        const options = {
            hostname: '127.0.0.1',
            port,
            path,
            method,
            headers: {
                'Content-Type': 'application/json',
                ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
            },
        };
        const req = http.request(options, res => {
            let data = '';
            res.setEncoding('utf8');
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try { resolve({ statusCode: res.statusCode, body: JSON.parse(data) }); }
                catch (e) { resolve({ statusCode: res.statusCode, body: data }); }
            });
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

function get(port, path) { return request(port, 'GET', path, null); }
function post(port, path, payload) { return request(port, 'POST', path, payload); }

/**
 * Build a mock runner matching the interface expected by createDaemonServer.
 * Every method is a sinon stub with sensible defaults.
 */
function buildMockRunner(overrides = {}) {
    const kbNamesArray = { toArray: sinon.stub().resolves(['SUMO', 'MyCorp']) };
    const mockMgr      = { getKBnames: sinon.stub().resolves(kbNamesArray) };
    const KBmanager    = { getMgr: sinon.stub().resolves(mockMgr) };

    const runner = {
        gateway: {
            jvm: {
                com: { articulate: { sigma: { KBmanager } } }
            }
        },
        reloadDirtyKBs: sinon.stub().resolves(),
        ask:    sinon.stub().resolves({ status: 'Theorem', answers: ['Human'], proof: [] }),
        tell:   sinon.stub().resolves([]),
        reloadKB: sinon.stub().resolves(),
        ...overrides,
    };
    return { runner, KBmanager, mockMgr, kbNamesArray };
}

/**
 * Start the server on a random OS-assigned port and return { server, port }.
 * The caller is responsible for closing the server after the test.
 */
function startServer(runner) {
    return new Promise((resolve, reject) => {
        const server = createDaemonServer(runner);
        server.listen(0, '127.0.0.1', () => {
            resolve({ server, port: server.address().port });
        });
        server.on('error', reject);
    });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createDaemonServer()', function () {
    let server;
    let port;
    let runner;

    beforeEach(async function () {
        ({ runner } = buildMockRunner());
        ({ server, port } = await startServer(runner));
    });

    afterEach(function (done) {
        sinon.restore();
        server.close(done);
    });

    // -----------------------------------------------------------------------
    describe('GET /status', function () {

        it('responds 200 with ok=true and a kbs array', async function () {
            const { statusCode, body } = await get(port, '/status');
            expect(statusCode).to.equal(200);
            expect(body.ok).to.be.true;
            expect(body.kbs).to.deep.equal(['SUMO', 'MyCorp']);
        });

        it('calls gateway.jvm.com.articulate.sigma.KBmanager.getMgr()', async function () {
            await get(port, '/status');
            expect(runner.gateway.jvm.com.articulate.sigma.KBmanager.getMgr.calledOnce).to.be.true;
        });
    });

    // -----------------------------------------------------------------------
    describe('POST /ask', function () {

        it('responds 200 with ask result on valid request', async function () {
            const { statusCode, body } = await post(port, '/ask', {
                kb: 'SUMO', sessionId: 's1', query: '(instance ?X Human)',
            });
            expect(statusCode).to.equal(200);
            expect(body.status).to.equal('Theorem');
            expect(body.answers).to.deep.equal(['Human']);
        });

        it('calls runner.reloadDirtyKBs() before runner.ask()', async function () {
            let reloadCalledFirst = false;
            runner.reloadDirtyKBs = sinon.stub().callsFake(() => {
                reloadCalledFirst = !runner.ask.called;
                return Promise.resolve();
            });
            await post(port, '/ask', { kb: 'SUMO', query: '(instance ?X Human)' });
            expect(reloadCalledFirst).to.be.true;
        });

        it('calls runner.ask() with kb, sessionId, query, and options', async function () {
            await post(port, '/ask', {
                kb: 'SUMO', sessionId: 's1', query: '(instance ?X Human)',
                options: { timeout: 60 },
            });
            expect(runner.ask.calledOnce).to.be.true;
            const [kb, sessionId, query, options] = runner.ask.firstCall.args;
            expect(kb).to.equal('SUMO');
            expect(sessionId).to.equal('s1');
            expect(query).to.equal('(instance ?X Human)');
            expect(options).to.deep.equal({ timeout: 60 });
        });

        it('defaults sessionId to empty string when not provided', async function () {
            await post(port, '/ask', { kb: 'SUMO', query: '(instance ?X Human)' });
            expect(runner.ask.firstCall.args[1]).to.equal('');
        });

        it('defaults options to {} when not provided', async function () {
            await post(port, '/ask', { kb: 'SUMO', query: '(instance ?X Human)' });
            expect(runner.ask.firstCall.args[3]).to.deep.equal({});
        });

        it('responds 400 when kb is missing', async function () {
            const { statusCode, body } = await post(port, '/ask', { query: '(instance ?X Human)' });
            expect(statusCode).to.equal(400);
            expect(body.error).to.be.a('string');
            expect(runner.ask.called).to.be.false;
        });

        it('responds 400 when query is missing', async function () {
            const { statusCode, body } = await post(port, '/ask', { kb: 'SUMO' });
            expect(statusCode).to.equal(400);
            expect(body.error).to.be.a('string');
        });

        it('responds 500 when runner.ask() throws', async function () {
            runner.ask = sinon.stub().rejects(new Error('JVM exploded'));
            const { statusCode, body } = await post(port, '/ask', {
                kb: 'SUMO', query: '(instance ?X Human)',
            });
            expect(statusCode).to.equal(500);
            expect(body.error).to.include('JVM exploded');
        });
    });

    // -----------------------------------------------------------------------
    describe('POST /tell', function () {

        it('responds 200 with empty errors array on success', async function () {
            const { statusCode, body } = await post(port, '/tell', {
                kb: 'SUMO', sessionId: 's1', statement: '(instance Fluffy Cat)',
            });
            expect(statusCode).to.equal(200);
            expect(body.errors).to.deep.equal([]);
        });

        it('calls runner.reloadDirtyKBs() before runner.tell()', async function () {
            let reloadCalledFirst = false;
            runner.reloadDirtyKBs = sinon.stub().callsFake(() => {
                reloadCalledFirst = !runner.tell.called;
                return Promise.resolve();
            });
            await post(port, '/tell', { kb: 'SUMO', statement: '(instance Fluffy Cat)' });
            expect(reloadCalledFirst).to.be.true;
        });

        it('calls runner.tell() with kb, sessionId, and statement', async function () {
            await post(port, '/tell', {
                kb: 'SUMO', sessionId: 's2', statement: '(instance Fluffy Cat)',
            });
            expect(runner.tell.calledOnce).to.be.true;
            const [kb, sessionId, statement] = runner.tell.firstCall.args;
            expect(kb).to.equal('SUMO');
            expect(sessionId).to.equal('s2');
            expect(statement).to.equal('(instance Fluffy Cat)');
        });

        it('returns errors array when tell returns non-empty', async function () {
            runner.tell = sinon.stub().resolves(['Syntax error on line 1']);
            const { body } = await post(port, '/tell', { kb: 'SUMO', statement: '(bad' });
            expect(body.errors).to.deep.equal(['Syntax error on line 1']);
        });

        it('responds 400 when kb is missing', async function () {
            const { statusCode } = await post(port, '/tell', { statement: '(instance Fluffy Cat)' });
            expect(statusCode).to.equal(400);
            expect(runner.tell.called).to.be.false;
        });

        it('responds 400 when statement is missing', async function () {
            const { statusCode } = await post(port, '/tell', { kb: 'SUMO' });
            expect(statusCode).to.equal(400);
        });
    });

    // -----------------------------------------------------------------------
    describe('POST /reload', function () {

        it('responds 200 with ok=true on success', async function () {
            const { statusCode, body } = await post(port, '/reload', { kb: 'SUMO' });
            expect(statusCode).to.equal(200);
            expect(body.ok).to.be.true;
        });

        it('calls runner.reloadKB() with the kb name', async function () {
            await post(port, '/reload', { kb: 'SUMO' });
            expect(runner.reloadKB.calledOnce).to.be.true;
            expect(runner.reloadKB.firstCall.args[0]).to.equal('SUMO');
        });

        it('responds 400 when kb is missing', async function () {
            const { statusCode } = await post(port, '/reload', {});
            expect(statusCode).to.equal(400);
            expect(runner.reloadKB.called).to.be.false;
        });
    });

    // -----------------------------------------------------------------------
    describe('unknown routes', function () {

        it('responds 404 for an unknown path', async function () {
            const { statusCode } = await get(port, '/nonexistent');
            expect(statusCode).to.equal(404);
        });

        it('responds 404 for a known path with the wrong method', async function () {
            const { statusCode } = await post(port, '/status', {});
            expect(statusCode).to.equal(404);
        });
    });
});
