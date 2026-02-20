/**
 * Get sigma directories
 */

const vscode = require('vscode');
const { environment } = require('./const');
const { getSigmaRuntime, SigmaRuntime } = require('./runtime');

/**
 * Helper function to grab a config variable or fall back to
 * an environment variable
 * @param {string} configVar The name of the config variable
 * @param {SigmaRuntime} runtime The runtime to get the env from
 * @param {string} envVar The name of the fallback environment variable 
 * @returns {string | null}
 */
function getConfigEnvFallback(configVar, runtime, envVar) {
    const config = vscode.workspace.getConfiguration('sumo');
    const v = config.get(configVar);
    if (v != null && v !== '') return v;
    return runtime.getEnvironmentVar(envVar);
}

/**
 * Helper to get path to sigma source (i.e. SIGMA_SRC)
 * @returns {string | null}
 */
function getSigmaPath() {
    // Check config from vscode
    const runtime = getSigmaRuntime();
    let sigmaPath = getConfigEnvFallback('sigma.srcPath', runtime, environment.source);

    if (!sigmaPath) return null;
    if (runtime.existsAtPath(sigmaPath)) return sigmaPath;
    return null;
}

/**
 * Helper to get the path to sigma home (i.e. SIGMA_HOME)
 * @returns {string | null}
 */
function getSigmaHome() {
    // Check config from vscode
    const runtime = getSigmaRuntime();
    let sigmaPath = getConfigEnvFallback('sigma.homePath', runtime, environment.home);

    if (!sigmaPath) return null;
    if (runtime.existsAtPath(sigmaPath)) return sigmaPath;
    return null;
}

module.exports = {
    getSigmaHome,
    getSigmaPath
}