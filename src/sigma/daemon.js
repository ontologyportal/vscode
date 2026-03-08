/**
 * Sigma Daemon — standalone long-lived process that hosts a single JVM
 * and exposes it over a simple HTTP REST interface.
 *
 * Usage:
 *   node src/sigma/daemon.js [--port 9999] [--runtime local]
 *
 * VS Code windows connect to this daemon by setting:
 *   sumo.sigma.runtime   = "daemon"
 *   sumo.sigma.daemonUrl = "http://localhost:9999"
 */

'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

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
            catch (e) { reject(new Error('Invalid JSON body')); }
        });
        req.on('error', reject);
    });
}

// ---------------------------------------------------------------------------
// HTTP server factory
//
// Accepts any object that exposes: ask, tell, reloadKB, reloadDirtyKBs,
// and gateway.jvm (for /status).  This lets tests inject a mock runner
// and lets future daemon backends swap out LocalRuntimeRunner for something
// else without touching the routing logic.
// ---------------------------------------------------------------------------

/**
 * Create the daemon HTTP server backed by the provided runner.
 *
 * @param {object} runner  Any object with ask/tell/reloadKB/reloadDirtyKBs/gateway
 * @returns {http.Server}
 */
function createDaemonServer(runner) {

    async function handleStatus(req, res) {
        const KBmanager = await runner.gateway.jvm.com.articulate.sigma.KBmanager;
        const mgr = await KBmanager.getMgr();
        const kbNames = await mgr.getKBnames();
        const kbs = kbNames ? await kbNames.toArray() : [];
        sendJson(res, 200, { ok: true, kbs });
    }

    async function handleAsk(req, res) {
        const { kb, sessionId, query, options } = await readBody(req);
        if (!kb || !query) {
            sendJson(res, 400, { error: 'kb and query are required' });
            return;
        }
        await runner.reloadDirtyKBs();
        const result = await runner.ask(kb, sessionId || '', query, options || {});
        sendJson(res, 200, result);
    }

    async function handleTell(req, res) {
        const { kb, sessionId, statement } = await readBody(req);
        if (!kb || !statement) {
            sendJson(res, 400, { error: 'kb and statement are required' });
            return;
        }
        await runner.reloadDirtyKBs();
        const errors = await runner.tell(kb, sessionId || '', statement);
        sendJson(res, 200, { errors: errors || [] });
    }

    async function handleReload(req, res) {
        const { kb } = await readBody(req);
        if (!kb) {
            sendJson(res, 400, { error: 'kb is required' });
            return;
        }
        await runner.reloadKB(kb);
        sendJson(res, 200, { ok: true });
    }

    return http.createServer(async (req, res) => {
        const url    = req.url.split('?')[0];
        const method = req.method;

        try {
            if (method === 'GET'  && url === '/status') return await handleStatus(req, res);
            if (method === 'POST' && url === '/ask')    return await handleAsk(req, res);
            if (method === 'POST' && url === '/tell')   return await handleTell(req, res);
            if (method === 'POST' && url === '/reload') return await handleReload(req, res);
            sendJson(res, 404, { error: `No route for ${method} ${url}` });
        } catch (e) {
            console.error('[daemon] Request error:', e);
            sendJson(res, 500, { error: e.message });
        }
    });
}

// ---------------------------------------------------------------------------
// PID file helpers
// ---------------------------------------------------------------------------

function writePidFile(pidFile, port) {
    try {
        fs.writeFileSync(pidFile, JSON.stringify({ pid: process.pid, port }), 'utf8');
    } catch (e) {
        console.error(`[daemon] Warning: could not write PID file: ${e.message}`);
    }
}

function removePidFile(pidFile) {
    try {
        if (fs.existsSync(pidFile)) fs.unlinkSync(pidFile);
    } catch (_) {}
}

// ---------------------------------------------------------------------------
// Runner factory — resolve --runtime flag to a concrete runner object.
// Extend this when adding new daemon-compatible backends.
// ---------------------------------------------------------------------------

/**
 * @param {string} runtimeName  e.g. 'local'
 * @param {object} context      Mock VS Code extension context (extensionPath, storageUri)
 * @returns {{ runner, init }}  runner = the runner object; init = async init function
 */
function resolveRunner(runtimeName, context) {
    if (runtimeName === 'local' || !runtimeName) {
        const { LocalRuntimeRunner } = require('./engine/local');
        const runner = new LocalRuntimeRunner();
        return {
            runner,
            init: (console) => runner.initialize(context, console),
            stop: ()        => runner.stop(),
        };
    }
    throw new Error(`Unknown daemon runtime: "${runtimeName}". Supported values: local`);
}

// ---------------------------------------------------------------------------
// Entry point (only runs when executed directly, not when required by tests)
// ---------------------------------------------------------------------------

if (require.main === module) {
    const args = process.argv.slice(2);
    let port        = 9999;
    let runtimeName = 'local';

    for (let i = 0; i < args.length; i++) {
        if ((args[i] === '--port' || args[i] === '-p') && args[i + 1]) {
            port = parseInt(args[i + 1], 10);
            i++;
        }
        if (args[i] === '--runtime' && args[i + 1]) {
            runtimeName = args[i + 1];
            i++;
        }
    }

    const sigmaHome = process.env['SIGMA_HOME'] || os.tmpdir();
    const pidFile   = path.join(sigmaHome, '.sigma-daemon.json');

    // Mock VS Code extension context — daemon.js lives at src/sigma/daemon.js,
    // so the extension root (containing lib/) is two directories up.
    const mockContext = {
        extensionPath: path.resolve(__dirname, '../..'),
        storageUri: { fsPath: os.tmpdir() },
    };

    const { runner, init, stop } = resolveRunner(runtimeName, mockContext);
    const server = createDaemonServer(runner);

    async function shutdown(signal) {
        console.log(`\n[daemon] Received ${signal}, shutting down…`);
        server.close();
        try { await stop(); } catch (_) {}
        removePidFile(pidFile);
        process.exit(0);
    }

    process.on('SIGINT',  () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    (async () => {
        console.log(`[daemon] Initializing Sigma JVM (runtime: ${runtimeName})…`);
        try {
            await init({
                stdout: data => process.stdout.write(data),
                stderr: data => process.stderr.write('[ERROR] ' + data),
                close:  ()   => console.log('[daemon] Sigma JVM closed'),
            });
        } catch (e) {
            console.error('[daemon] Failed to initialize Sigma:', e.message);
            process.exit(1);
        }

        server.listen(port, '127.0.0.1', () => {
            writePidFile(pidFile, port);
            console.log(`[daemon] Sigma daemon ready on http://127.0.0.1:${port}`);
            console.log(`[daemon] PID file written to ${pidFile}`);
        });
    })();
}

module.exports = { createDaemonServer };
