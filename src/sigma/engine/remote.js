/**
 * RemoteRuntime — a SigmaRuntime implementation that forwards all operations
 * to a running sigma-daemon over HTTP.
 *
 * Configure via VS Code settings:
 *   sumo.sigma.runtime   = "daemon"
 *   sumo.sigma.daemonUrl = "http://localhost:9999"   (default)
 */

'use strict';

const http  = require('http');
const https = require('https');
const { URL } = require('url');

const { SigmaRuntime } = require('./base');

class RemoteRuntime extends SigmaRuntime {

    constructor() {
        super();
        this._dirtyKBs = new Set();
    }

    // -----------------------------------------------------------------------
    // Internal helpers
    // -----------------------------------------------------------------------

    _daemonUrl() {
        try {
            const vscode = require('vscode');
            const cfg = vscode.workspace.getConfiguration('sumo');
            return cfg.get('sigma.daemonUrl') || 'http://localhost:9999';
        } catch (_) {
            return 'http://localhost:9999';
        }
    }

    /**
     * Perform a GET request to the daemon.
     * @param {string} urlPath
     * @returns {Promise<object>}
     */
    _get(urlPath) {
        return this._request('GET', urlPath, null);
    }

    /**
     * Perform a POST request with a JSON body to the daemon.
     * @param {string} urlPath
     * @param {object} body
     * @returns {Promise<object>}
     */
    _post(urlPath, body) {
        return this._request('POST', urlPath, body);
    }

    _request(method, urlPath, body) {
        return new Promise((resolve, reject) => {
            const base    = this._daemonUrl();
            const parsed  = new URL(urlPath, base);
            const isHttps = parsed.protocol === 'https:';
            const mod     = isHttps ? https : http;
            const payload = body ? JSON.stringify(body) : null;

            const options = {
                hostname: parsed.hostname,
                port:     parseInt(parsed.port || (isHttps ? '443' : '80'), 10),
                path:     parsed.pathname,
                method,
                headers: {
                    'Accept': 'application/json',
                    ...(payload ? {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(payload),
                    } : {}),
                },
            };

            const req = mod.request(options, res => {
                let data = '';
                res.setEncoding('utf8');
                res.on('data', chunk => { data += chunk; });
                res.on('end', () => {
                    try {
                        const obj = JSON.parse(data);
                        if (res.statusCode >= 400) {
                            reject(new Error(obj.error || `Daemon returned HTTP ${res.statusCode}`));
                        } else {
                            resolve(obj);
                        }
                    } catch (e) {
                        reject(new Error(`Invalid JSON from daemon: ${data.slice(0, 200)}`));
                    }
                });
            });

            req.on('error', err => {
                if (err.code === 'ECONNREFUSED') {
                    reject(new Error(
                        'Sigma daemon is not running. ' +
                        'Start it with: node src/sigma/daemon.js'
                    ));
                } else {
                    reject(err);
                }
            });

            if (payload) req.write(payload);
            req.end();
        });
    }

    // -----------------------------------------------------------------------
    // Dirty-KB flush
    // -----------------------------------------------------------------------

    async _flushDirty() {
        if (this._dirtyKBs.size === 0) return;
        const pending = [...this._dirtyKBs];
        this._dirtyKBs.clear();
        for (const kb of pending) {
            await this._post('/reload', { kb });
        }
    }

    // -----------------------------------------------------------------------
    // SigmaRuntime interface
    // -----------------------------------------------------------------------

    getName() {
        return 'remote';
    }

    /**
     * Verify the daemon is reachable. Throws a helpful error if not.
     */
    async initialize(_context, _outputChannel) {
        await this._get('/status');
    }

    /** No-op — daemon manages its own lifecycle. */
    async shutdown() {}

    async getEnvironmentVar(envVar) {
        // The daemon runs on the same host, so environment variables are accessible locally.
        return process.env[envVar] || null;
    }

    async existsAtPath(filePath) {
        const fs = require('fs');
        try {
            await fs.promises.access(filePath);
            return true;
        } catch (_) {
            return false;
        }
    }

    async readFile(filePath) {
        const fs = require('fs');
        try {
            return await fs.promises.readFile(filePath, 'utf8');
        } catch (_) {
            return null;
        }
    }

    async writeFile(filePath, contents) {
        const fs = require('fs');
        await fs.promises.writeFile(filePath, contents, { encoding: 'utf-8', flag: 'w' });
    }

    markDirty(kbName) {
        this._dirtyKBs.add(kbName);
    }

    async tell(kbName, sessionID, statement) {
        await this._flushDirty();
        const result = await this._post('/tell', { kb: kbName, sessionId: sessionID, statement });
        return result.errors || [];
    }

    async ask(kbName, sessionID, query, options) {
        await this._flushDirty();
        return await this._post('/ask', { kb: kbName, sessionId: sessionID, query, options });
    }

    async reloadKB(kbName) {
        this._dirtyKBs.delete(kbName);
        await this._post('/reload', { kb: kbName });
    }

    async compileKB(_context, _kbName) {
        throw new Error('compileKB is not supported for the daemon runtime');
    }

    async compileFormulas(_context, _formulas) {
        throw new Error('compileFormulas is not supported for the daemon runtime');
    }
}

module.exports = { RemoteRuntime };
