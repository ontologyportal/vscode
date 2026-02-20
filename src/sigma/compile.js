const vscode = require('vscode');
const { getSigmaRuntime } = require('./engine');

/**
 * Compiles the current Knowledge Base to TPTP using Sigma
 * @param { vscode.ExtensionContext } context The vscode extension context
 * @param {string} kbName The name of the knowledge base to compile
 * @returns {string[]} The compiled formulas
 */
async function compileKB(context, kbName) {
    const outputChannel = vscode.window.createOutputChannel("Sigma Compilation");
    outputChannel.show();

    const runtime = getSigmaRuntime();
    outputChannel.appendLine(`Starting compilation for KB: ${kbName}`);
    outputChannel.appendLine(`Runtime: ${runtime.getName()}`);

    return runtime.compileKB(context, kbName);
}

/**
 * 
 * @param { vscode.ExtensionContext } context The vscode extension context
 * @param {string[]} formulas The SUO-KIF formulas to compile 
 * @returns {string[]} The compiled formulas in appropriate TPTP form
 */
async function compileFormulas(context, formulas) {
    const outputChannel = vscode.window.createOutputChannel("Sigma Compilation");
    outputChannel.show();

    if (!formulas || formulas.length === 0) {
        outputChannel.appendLine("Error: No formulas provided for compilation.");
        return;
    }

    const combinedFormula = `(and ${formulas.join(' ')})`;
    const runtime = getSigmaRuntime();
    outputChannel.appendLine(`Compiling combined formula: ${combinedFormula}`);
    outputChannel.appendLine(`Runtime: ${runtime.getName()}`);

    runtime.compileFormulas(context, formulas);
}

module.exports = { compileKB, compileFormulas };