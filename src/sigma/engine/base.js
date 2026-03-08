'use strict';

/**
 * Abstract base class for a Sigma runtime.
 * Kept in its own file to avoid circular dependency between runtime.js and remote.js.
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
     * Initialize the runtime
     * @param {vscode.ExtensionContext} context
     * @param {vscode.OutputChannel} outputChannel
     * @return {Promise<void>}
     */
    async initialize(context, outputChannel) {
        throw new Error("Cannot invoke abstract interface functions");
    }

    /**
     * Shutdown the runtime
     * @return {Promise<void>}
     */
    async shutdown() {
        throw new Error("Cannot invoke abstract interface functions");
    }

    /**
     * Get the config.xml options of the current runtime
     * @param { string } envVar The name of the environment variable
     * @returns { Promise<string | null> } The value of the environment variable
     */
    async getEnvironmentVar(envVar) {
        throw new Error("Cannot invoke abstract interface functions");
    }

    /**
     * Check whether a file exists at a path
     * @param { string } path The path of the file to read
     * @returns { Promise<bool> } True if the file exists, false if not
     */
    async existsAtPath(path) {
        throw new Error("Cannot invoke abstract interface functions");
    }

    /**
     * Get file contents
     * @param { string } path The path of the file to read
     * @returns { Promise<string | null> } Contents of the file, null if cannot be read
     */
    async readFile(path) {
        throw new Error("Cannot invoke abstract interface functions");
    }

    /**
     * Get contents to a file
     * @param { string } path The path of the file to read
     * @param { string } contents The contents to write to the file
     * @returns { Promise<void> }
     */
    async writeFile(path, contents) {
        throw new Error("Cannot invoke abstract interface functions");
    }

    /**
     * Get the name of the current runtime
     * @returns { string }
     */
    getName() {
        throw new Error("Cannot invoke abstract interface functions");
    }

    /**
     * Convert a knowledge base to an output language
     * @param { vscode.ExtensionContext } context The vscode extension context
     * @param { string } kbName The name of the KB to convert
     * @returns { string }
     */
    async compileKB(context, kbName) {
        throw new Error("Cannot invoke abstract interface functions");
    }

    /**
     * Convert a set of formulas to a specific output language
     * @param { vscode.ExtensionContext } context The vscode extension context
     * @param { string[] } formulas The name of the KB to convert
     * @returns { string }
     */
    async compileFormulas(context, formulas) {
        throw new Error("Cannot invoke abstract interface functions");
    }

    /**
     * Assert a statement into a knowledge base
     * @param {string} kbName
     * @param {string} sessionID
     * @param {string} statement
     * @returns {Promise<string[]>}
     */
    async tell(kbName, sessionID, statement) {
        throw new Error("Cannot invoke abstract interface functions");
    }

    /**
     * Query a knowledge base
     * @param {string} kbName
     * @param {string} sessionID
     * @param {string} query
     * @param {object} options
     * @returns {Promise<object>}
     */
    async ask(kbName, sessionID, query, options) {
        throw new Error("Cannot invoke abstract interface functions");
    }

    /**
     * Reload a knowledge base (re-reads constituent files from disk)
     * @param {string} kbName
     * @returns {Promise<void>}
     */
    async reloadKB(kbName) {
        throw new Error("Cannot invoke abstract interface functions");
    }

    /**
     * Mark a knowledge base as needing reload before the next operation.
     * No-op by default; only meaningful for runtimes that support live reload.
     * @param {string} kbName
     */
    markDirty(kbName) {}
}

module.exports = { SigmaRuntime };
