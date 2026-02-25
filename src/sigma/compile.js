const vscode = require('vscode');
const { getSigmaRuntime } = require('./engine');

/**
 * Compiles the current Knowledge Base to TPTP using Sigma
 * @param { vscode.ExtensionContext } context The vscode extension context
 * @param {string} kbName The name of the knowledge base to compile
 * @returns {Promise<string[]>} The compiled formulas
 */
async function compileKB(context, kbName) {
    const runtime = getSigmaRuntime();
    return runtime.compileKB(context, kbName);
}

/**
 * 
 * @param { vscode.ExtensionContext } context The vscode extension context
 * @param {string[]} formulas The SUO-KIF formulas to compile 
 * @returns {Promise<string[]>} The compiled formulas in appropriate TPTP form
 */
async function compileFormulas(context, formulas) {
    if (!formulas || formulas.length === 0) {
        outputChannel.appendLine("Error: No formulas provided for compilation.");
        return;
    }

    const combinedFormula = `(and ${formulas.join(' ')})`;
    const runtime = getSigmaRuntime();

    return runtime.compileFormulas(context, formulas);
}

module.exports = { compileKB, compileFormulas };