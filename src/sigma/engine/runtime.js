const vscode = require('vscode');

const fs = require('fs');
const path = require('path');
const Docker = require('dockerode');

const { SigmaRuntime } = require("./base");
const { LocalRuntimeRunner } = require("./local");
const { RemoteRuntime } = require("./remote");

let runtimeInstance = null;
let lastRuntimeType = null;

/**
 * Helper to get the currently selected runtime for sigma
 * @returns {SigmaRuntime} The current runtime object
 */
function getSigmaRuntime() {
    // Check config from vscode
    const config = vscode.workspace.getConfiguration('sumo');
    const runtime = config.get('sigma.runtime') || 'local';

    if (runtimeInstance && lastRuntimeType === runtime) {
        return runtimeInstance;
    }

    lastRuntimeType = runtime;
    if (runtime === 'docker') {
        runtimeInstance = new DockerRuntime();
    } else if (runtime === 'daemon') {
        runtimeInstance = new RemoteRuntime();
    } else if (runtime.startsWith('native')) {
        runtimeInstance = new NativeRuntime();
    } else {
        runtimeInstance = new LocalRuntime();
    }
    return runtimeInstance;
}

class LocalRuntime extends SigmaRuntime {
    constructor() {
        super();
        /**
         * The Java interface runner
         * @type {LocalRuntimeRunner}
         * @public
         */
        this.runner = new LocalRuntimeRunner();
    }

    get useLocal() { return true; }

    /**
     * Initialize the runtime
     * @param {vscode.ExtensionContext} context
     * @param {vscode.OutputChannel} outputChannel
     * @return {Promise<void>}
     */
    async initialize(context, outputChannel) {
        if (this.runner.initialized) return;
        await this.runner.initialize(context, {
            stdout: (data) => { outputChannel.append(data) },
            stderr: (data) => { outputChannel.append('[ERROR]' + data) },
            close: () => { outputChannel.appendLine("Sigma shutdown"); outputChannel.clear(); }
        });
    }

    /**
     * Shutdown the runtime
     * @return {Promise<void>}
     */
    async shutdown() {
        if (!this.runner.initialized) return;
        await this.runner.stop();
    }

    async getEnvironmentVar(envVar) {
        return process.env[envVar] || null;
    }

    async existsAtPath(path) {
        try {
            await fs.promises.access(path);
            return true;
        } catch (e) {
            return false;
        }
    }

    async readFile(path) {
        if (await this.existsAtPath(path)) {
            return await fs.promises.readFile(path, 'utf8');
        }
        return null;
    }
    
    async writeFile(path, contents) {
        return await fs.promises.writeFile(path, contents, { encoding: 'utf-8', flag: 'w' });
    }

    getName() {
        return "Local Sigma"
    }

    markDirty(kbName) {
        this.runner.markDirty(kbName);
    }

    async compileKB(context, kbName) {
        await this.runner.reloadDirtyKBs();
        const tempDir = context.storageUri.fsPath;
        const tempFile = path.join(tempDir, `${kbName}-${Date.now()}.tptp`);
        return await this.runner.writeFile(tempFile, kbName);
    }

    async compileFormulas(context, formulas) {
        await this.runner.reloadDirtyKBs();
        const kbName = vscode.workspace.getConfiguration('sumo').get('sigma.knowledgeBase') || 'SUMO';
        const tempDir = context.storageUri.fsPath;
        const tempFile = path.join(tempDir, `formulas-${Date.now()}.tptp`);
        const conjecture = formulas.length > 0 ? formulas[0] : null;
        const filePath = await this.runner.writeFile(tempFile, kbName, conjecture);
        const content = await fs.promises.readFile(filePath, 'utf8');
        return content.split('\n').filter(line =>
            line.trim().startsWith('fof(') || line.trim().startsWith('tff(')
        );
    }

    async tell(kbName, sessionID, statement) {
        await this.runner.reloadDirtyKBs();
        return await this.runner.tell(kbName, sessionID, statement);
    }

    async ask(kbName, sessionID, query, options) {
        await this.runner.reloadDirtyKBs();
        return await this.runner.ask(kbName, sessionID, query, options);
    }

    async reloadKB(kbName) {
        return await this.runner.reloadKB(kbName);
    }
}

class DockerRuntime extends SigmaRuntime {
    constructor() {
        super();
        this.docker = new Docker();
        this.configCache = null;
        this._containerId = null;
    }

    get useDocker() { return true; }

    async getContainerId() {
        if (this._containerId) return this._containerId;
        try {
            const config = vscode.workspace.getConfiguration('sumo');
            const image = config.get('sigma.dockerImage') || 'apease/sigmakee';
            const containers = await this.docker.listContainers({
                filters: { ancestor: [image], status: ['running'] }
            });
            if (containers.length > 0) {
                this._containerId = containers[0].Id;
                return this._containerId;
            }
        } catch (e) {
            console.error("Error finding docker container:", e);
        }
        return null;
    }

    async _execCmd(cmd) {
        const cid = await this.getContainerId();
        if (!cid) return null;
        
        try {
            const container = this.docker.getContainer(cid);
            const exec = await container.exec({
                Cmd: cmd,
                AttachStdout: true,
                AttachStderr: true
            });
            
            const stream = await exec.start({});
            let output = '';
            
            return new Promise((resolve, reject) => {
                container.modem.demuxStream(stream, {
                    write: chunk => output += chunk.toString('utf8')
                }, {
                    write: chunk => {} 
                });
                
                stream.on('end', async () => {
                    try {
                        const data = await exec.inspect();
                        resolve({ exitCode: data.ExitCode, output: output.trim() });
                    } catch(e) { reject(e); }
                });
                stream.on('error', reject);
            });
        } catch (e) {
            return null;
        }
    }

    async getEnvironmentVar(envVar) {
        const res = await this._execCmd(['printenv', envVar]);
        return (res && res.exitCode === 0) ? res.output : null;
    }

    async existsAtPath(path) {
        const res = await this._execCmd(['test', '-f', path]);
        return (res && res.exitCode === 0);
    }

    async readFile(path) {
        const res = await this._execCmd(['cat', path]);
        return (res && res.exitCode === 0) ? res.output : null;
    }

    getName() {
        return "Dockerized Sigma"
    }

    async compileKB(context, kbName) {
        throw new Error("Generating KBs is currently not implemented for dockerized sigma")
    }

    async compileFormulas(context, formulas) {
        throw new Error("Compiling formulas is currently not implemented for dockerized sigma")
    }

    async tell(kbName, sessionID, statement) {
        throw new Error("Tell functionality is currently not implemented for dockerized sigma")
    }

    async ask(kbName, sessionID, query, options) {
        throw new Error("Ask functionality is currently not implemented for dockerized sigma")
    }

    async reloadKB(kbName) {
        throw new Error("Reload functionality is currently not implemented for dockerized sigma")
    }
}

class NativeRuntime extends SigmaRuntime {
    get useNativeJS() { return true; }
    
    async getEnvironmentVar(envVar) {
        throw new Error("Cannot utilize this function with a native runtime");
    }
    async existsAtPath(path) {
        throw new Error("Cannot utilize this function with a native runtime");
    }
    async readFile(path) {
        throw new Error("Cannot utilize this function with a native runtime");
    }

    getName() {
        return "Javascript implemented Sigma"
    }

    async compileKB(context, kbName) {
        throw new Error("Generating KBs is currently not implemented for the native JS implementation")
    }

    async compileFormulas(context, formulas) {
        const { convertFormulas, setLang, setHideNumbers } = require('./native/index.js');
        setLang('fof');
        setHideNumbers(true);
        const result = convertFormulas(formulas, 'workspace');
        return result.content.split('\n').filter(line => 
            line.trim().startsWith('fof(') || line.trim().startsWith('tff(')
        );
    }

    async tell(kbName, sessionID, statement) {
        throw new Error("Tell functionality is currently not implemented for the native JS implementation")
    }

    async ask(kbName, sessionID, query, options) {
        throw new Error("Ask functionality is currently not implemented for the native JS implementation")
    }

    async reloadKB(kbName) {
        throw new Error("Reload functionality is currently not implemented for the native JS implementation")
    }
}

module.exports = {
    getSigmaRuntime,
    SigmaRuntime,
    LocalRuntime,
    DockerRuntime,
    NativeRuntime,
    RemoteRuntime
}