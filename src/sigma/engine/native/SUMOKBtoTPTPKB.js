/**
 * SUMO Knowledge Base to TPTP converter
 * Ported from SUMOKBtoTPTPKB.java
 *
 * This code is copyright Articulate Software (c) 2003.
 * This software is released under the GNU Public License
 * <http://www.gnu.org/copyleft/gpl.html>.
 */

const { Formula } = require('./Formula.js');
const { tptpParseSUOKIFString, setLang } = require('./SUMOformulaToTPTPformula.js');
const { LP, SPACE, DOC_PREDICATES } = require('./constants.js');
const { emptyString, isNonEmptyString } = require('./utils/StringUtil.js');
const fs = require('fs');
const path = require('path');

// Configuration flags
let removeHOL = true;
let removeNum = true;
let removeStrings = true;
let debug = false;
let lang = 'fof';

// Excluded predicates for filtering
const excludedPredicates = new Set([
    'documentation',
    'domain',
    'format',
    'termFormat',
    'externalImage',
    'relatedExternalConcept',
    'relatedInternalConcept',
    'formerName',
    'abbreviation',
    'conventionalShortName',
    'conventionalLongName'
]);

/**
 * Set debug mode
 * @param {boolean} value
 */
function setDebug(value) {
    debug = value;
}

/**
 * Set language mode
 * @param {string} value - 'fof', 'tff', or 'thf'
 */
function setLanguage(value) {
    lang = value;
    setLang(value);
}

/**
 * Set whether to remove higher-order logic formulas
 * @param {boolean} value
 */
function setRemoveHOL(value) {
    removeHOL = value;
}

/**
 * Set whether to remove numbers
 * @param {boolean} value
 */
function setRemoveNum(value) {
    removeNum = value;
}

/**
 * Set whether to remove strings
 * @param {boolean} value
 */
function setRemoveStrings(value) {
    removeStrings = value;
}

/**
 * Get file extension for language
 * @param {string} l - The language ('fof', 'tff', 'thf')
 * @returns {string} The file extension
 */
function langToExtension(l) {
    if (l === 'fof') {
        return 'tptp';
    }
    return l;
}

/**
 * Get language from file extension
 * @param {string} ext - The file extension
 * @returns {string} The language
 */
function extensionToLang(ext) {
    if (ext === 'tptp') {
        return 'fof';
    }
    return ext;
}

/**
 * Generate TPTP header
 * @param {string} sanitizedKBName - The sanitized KB name
 * @returns {string} The header text
 */
function writeHeader(sanitizedKBName) {
    const lines = [
        '% Articulate Software',
        '% www.ontologyportal.org www.articulatesoftware.com',
        '% This software released under the GNU Public License <http://www.gnu.org/copyleft/gpl.html>.',
        `% This is a translation to TPTP of KB ${sanitizedKBName}`,
        ''
    ];
    return lines.join('\n');
}

/**
 * Check if a formula contains excluded predicates
 * @param {Formula} formula - The formula to check
 * @returns {boolean} true if should be filtered
 */
function filterExcludePredicates(formula) {
    if (formula.isSimpleClause()) {
        const pred = formula.getArgument(0);
        return excludedPredicates.has(pred);
    }
    return false;
}

/**
 * Filter an axiom based on various criteria
 * @param {Formula} form - The original formula
 * @param {string} tptp - The TPTP translation
 * @param {Set<string>} alreadyWritten - Set of already written formulas
 * @returns {{filtered: boolean, reason: string}} Filter result
 */
function filterAxiom(form, tptp, alreadyWritten) {
    // Check for numbers in TPTP output
    if (/.*'[a-z][a-zA-Z0-9_]*\(.*/.test(tptp)) {
        return { filtered: removeNum, reason: 'number: ' + tptp };
    }

    // Check for quoted strings
    if (removeStrings && (tptp.includes("'") || tptp.includes('"'))) {
        return { filtered: true, reason: 'quoted thing' };
    }

    // Check for excluded predicates
    if (filterExcludePredicates(form)) {
        return { filtered: true, reason: 'filtered predicate: ' + form.getArgument(0) };
    }

    // Check if already written
    if (alreadyWritten.has(tptp)) {
        return { filtered: true, reason: 'already written: ' + tptp };
    }

    return { filtered: false, reason: '' };
}

/**
 * Convert an array of formulas to TPTP format
 * @param {string[]} formulas - Array of SUO-KIF formula strings
 * @param {string} kbName - Name of the knowledge base
 * @param {string|null} conjecture - Optional conjecture formula
 * @param {boolean} isQuestion - Whether the conjecture is a question
 * @returns {{content: string, axiomCount: number}} The TPTP content and count
 */
function convertFormulas(formulas, kbName, conjecture = null, isQuestion = false) {
    const sanitizedKBName = kbName.replace(/\W/g, '_');
    const alreadyWritten = new Set();
    const lines = [];
    let axiomIndex = 1;

    // Write header
    lines.push(writeHeader(sanitizedKBName));

    // Process each formula
    for (const formulaStr of formulas) {
        const f = new Formula(formulaStr);

        // Skip documentation predicates
        if (formulaStr.startsWith('(documentation')) {
            continue;
        }

        // Add comment with original formula
        lines.push(`% f: ${f.format()}`);

        try {
            const tptp = tptpParseSUOKIFString(formulaStr, false);

            if (isNonEmptyString(tptp)) {
                const filterResult = filterAxiom(f, tptp, alreadyWritten);

                if (!filterResult.filtered) {
                    const name = `kb_${sanitizedKBName}_${axiomIndex}`;
                    lines.push(`${lang}${LP}${name},axiom,(${tptp})).`);
                    alreadyWritten.add(tptp);
                    axiomIndex++;
                } else {
                    lines.push(`% ${filterResult.reason}`);
                }
            } else {
                lines.push('% empty result from translation');
            }
        } catch (e) {
            lines.push(`% Error translating formula: ${e.message}`);
            if (debug) {
                console.error('Error translating formula:', formulaStr, e);
            }
        }
    }

    // Add conjecture if provided
    if (conjecture) {
        try {
            const tptp = tptpParseSUOKIFString(conjecture, true);
            if (isNonEmptyString(tptp)) {
                const type = isQuestion ? 'question' : 'conjecture';
                lines.push(`${lang}(prove_from_${sanitizedKBName},${type},(${tptp})).`);
            }
        } catch (e) {
            lines.push(`% Error translating conjecture: ${e.message}`);
        }
    }

    return {
        content: lines.join('\n'),
        axiomCount: axiomIndex - 1
    };
}

/**
 * Write formulas to a TPTP file
 * @param {string} fileName - The output file path
 * @param {string[]} formulas - Array of SUO-KIF formula strings
 * @param {string} kbName - Name of the knowledge base
 * @param {string|null} conjecture - Optional conjecture formula
 * @param {boolean} isQuestion - Whether the conjecture is a question
 * @returns {string} The file path written
 */
function writeFile(fileName, formulas, kbName, conjecture = null, isQuestion = false) {
    const result = convertFormulas(formulas, kbName, conjecture, isQuestion);

    fs.writeFileSync(fileName, result.content, 'utf8');

    if (debug) {
        console.log(`Wrote ${result.axiomCount} axioms to ${fileName}`);
    }

    return fileName;
}

/**
 * Read formulas from a KIF file
 * Simple parser that extracts top-level S-expressions
 * @param {string} filePath - Path to the KIF file
 * @returns {string[]} Array of formula strings
 */
function readKIFFile(filePath) {
    const content = fs.readFileSync(filePath, 'utf8');
    return parseKIFFormulas(content);
}

/**
 * Parse KIF content into formulas
 * @param {string} content - The KIF content
 * @returns {string[]} Array of formula strings
 */
function parseKIFFormulas(content) {
    const formulas = [];
    let i = 0;
    const len = content.length;

    while (i < len) {
        // Skip whitespace and comments
        while (i < len && /\s/.test(content.charAt(i))) {
            i++;
        }

        // Skip comments
        if (i < len && content.charAt(i) === ';') {
            while (i < len && content.charAt(i) !== '\n') {
                i++;
            }
            continue;
        }

        // Parse formula
        if (i < len && content.charAt(i) === '(') {
            const start = i;
            let level = 0;
            let inQuote = false;
            let quoteChar = '';

            while (i < len) {
                const ch = content.charAt(i);
                const prev = i > 0 ? content.charAt(i - 1) : '';

                if (!inQuote) {
                    if (ch === '"' || ch === "'") {
                        inQuote = true;
                        quoteChar = ch;
                    } else if (ch === '(') {
                        level++;
                    } else if (ch === ')') {
                        level--;
                        if (level === 0) {
                            i++;
                            break;
                        }
                    }
                } else {
                    if (ch === quoteChar && prev !== '\\') {
                        inQuote = false;
                    }
                }
                i++;
            }

            const formula = content.substring(start, i).trim();
            if (formula) {
                formulas.push(formula);
            }
        } else {
            i++;
        }
    }

    return formulas;
}

module.exports = {
    convertFormulas,
    writeFile,
    writeHeader,
    filterAxiom,
    filterExcludePredicates,
    readKIFFile,
    parseKIFFormulas,
    langToExtension,
    extensionToLang,
    setDebug,
    setLanguage,
    setRemoveHOL,
    setRemoveNum,
    setRemoveStrings,
    excludedPredicates
};
