const vscode = require('vscode');

const fs = require('fs');
const Docker = require('dockerode');

let runtimeInstance = null;
let lastRuntimeType = null;

/**
 * Helper to get the currently selected runtime for sigma
 */
function getSigmaRuntime() {
    // Check config from vscode
    const config = vscode.workspace.getConfiguration('suo-kif');
    const runtime = config.get('sigma.runtime') || 'local';
    
    if (runtimeInstance && lastRuntimeType === runtime) {
        return runtimeInstance;
    }

    lastRuntimeType = runtime;
    if (runtime === 'docker') {
        runtimeInstance = new DockerRuntime();
    } else if (runtime.startsWith('native')) {
        runtimeInstance = new NativeRuntime();
    } else {
        runtimeInstance = new LocalRuntime();
    }
    return runtimeInstance;
}

/**
 * Abstract base class for a runtime
 * @class SigmaRuntime
 */
class SigmaRuntime {
    constructor() {
        if (this.constructor === SigmaRuntime) {
            throw new Error("Cannot instantiate abstract class SigmaRuntime");
        }
    }

    get useDocker() { return false; }
    get useLocal() { return false; }
    get useNativeJS() { return false; }

    /**
     * Get the config.xml options of the current runtime
     * @param { string } envVar The name of the environment variable
     * @returns { string | null } The value of the environment variable
     */
    async getEnvironmentVar(envVar) {
        throw new Error("Cannot invoke abstract interface functions");
    }

    /**
     * Check whether a file exists at a path
     * @param { string } path The path of the file to read
     * @returns { bool } True if the file exists, false if not
     */
    async existsAtPath(path) {
        throw new Error("Cannot invoke abstract interface functions");
    }

    /**
     * Get file contents
     * @param { string } path The path of the file to read
     * @returns { string | null } Contents of the file, null if cannot be read
     */
    async readFile(path) {
        throw new Error("Cannot invoke abstract interface functions");
    }
}

class LocalRuntime extends SigmaRuntime {
    get useLocal() { return true; }

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
            const config = vscode.workspace.getConfiguration('suo-kif');
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
}

module.exports = {
    getSigmaRuntime,
    SigmaRuntime,
    LocalRuntime,
    DockerRuntime,
    NativeRuntime
}