
const vscode = require('vscode');

const { getSigmaRuntime } = require('./engine');
const { readKIFFile, parseKIFFormulas, convertFormulas, setLanguage } = require('./engine/native/index.js');
const { compileKB } = require('./compile.js');

/**
 * Run Sigma conversion using the native JS runtime.
 * @param {string[]} filesToLoad - KIF file paths to load
 * @param {string} action - 'EXPORT_KB', 'CONVERT', or 'PROVE'
 * @param {string} targetContent - Inline KIF content (conjecture for PROVE, additional content for CONVERT)
 * @param {string} tptpLang - TPTP language variant (e.g. 'fof', 'tff')
 * @returns {{ content: string, axiomCount: number }}
 */
function runSigmaNative(filesToLoad, action, targetContent = "", tptpLang = "fof") {
    setLanguage(tptpLang);

    let allFormulas = [];

    // Read formulas from all provided files
    for (const file of filesToLoad) {
        const formulas = readKIFFile(file);
        allFormulas = allFormulas.concat(formulas);
    }

    // Determine KB name from first file or default
    const kbName = filesToLoad.length > 0
        ? require('path').basename(filesToLoad[0], '.kif')
        : 'kb';

    if (action === 'EXPORT_KB') {
        return convertFormulas(allFormulas, kbName, null, false);
    }

    if (action === 'CONVERT') {
        // Also parse any inline content
        if (targetContent) {
            const inlineFormulas = parseKIFFormulas(targetContent);
            allFormulas = allFormulas.concat(inlineFormulas);
        }
        return convertFormulas(allFormulas, kbName, null, false);
    }

    if (action === 'PROVE') {
        // targetContent is the conjecture to prove
        const conjecture = targetContent || null;
        return convertFormulas(allFormulas, kbName, conjecture, true);
    }

    throw new Error(`Unknown action: ${action}`);
}

/**
 * Run Sigma conversion, dispatching to the appropriate runtime.
 * @param {string[]} filesToLoad - KIF file paths to load
 * @param {string} action - 'EXPORT_KB', 'CONVERT', or 'PROVE'
 * @param {string} targetContent - Inline KIF content or conjecture
 * @param {string} tptpLang - TPTP language variant
 * @returns {{ content: string, axiomCount: number }}
 */
async function runSigma(filesToLoad, action, targetContent = "", tptpLang = "fof") {
    const runtime = getSigmaRuntime();

    if (runtime.useNativeJS) {
        return runSigmaNative(filesToLoad, action, targetContent, tptpLang);
    }
    else {
        const result = await compileKB();
        
        return result
    }
}

module.exports = {
    runSigma,
    runSigmaNative
};
