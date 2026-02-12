/**
 * SUMO to TPTP Converter
 *
 * This module provides functionality to convert SUMO formulas
 * (as used in SUMO - Suggested Upper Merged Ontology) to TPTP format
 * (as used by automated theorem provers).
 *
 * This code is copyright Articulate Software (c) 2003.
 * This software is released under the GNU Public License
 * <http://www.gnu.org/copyleft/gpl.html>.
 */

// Core classes
const { Formula } = require('./Formula.js');

// Formula converter
const SUMOformulaToTPTPformula = require('./SUMOformulaToTPTPformula.js');

// KB converter
const SUMOKBtoTPTPKB = require('./SUMOKBtoTPTPKB.js');

// Constants
const constants = require('./constants.js');

// Utilities
const StringUtil = require('./utils/StringUtil.js');

module.exports = {
    // Core classes
    Formula,

    // Formula converter
    tptpParseSUOKIFString: SUMOformulaToTPTPformula.tptpParseSUOKIFString,
    translateWord: SUMOformulaToTPTPformula.translateWord,
    processRecurse: SUMOformulaToTPTPformula.processRecurse,
    processLogOp: SUMOformulaToTPTPformula.processLogOp,
    processEquals: SUMOformulaToTPTPformula.processEquals,
    generateQList: SUMOformulaToTPTPformula.generateQList,
    process: SUMOformulaToTPTPformula.process,
    setFormulaDebug: SUMOformulaToTPTPformula.setDebug,
    setHideNumbers: SUMOformulaToTPTPformula.setHideNumbers,
    setLang: SUMOformulaToTPTPformula.setLang,
    get qlist() { return SUMOformulaToTPTPformula.qlist; },

    // KB converter
    convertFormulas: SUMOKBtoTPTPKB.convertFormulas,
    writeFile: SUMOKBtoTPTPKB.writeFile,
    writeHeader: SUMOKBtoTPTPKB.writeHeader,
    filterAxiom: SUMOKBtoTPTPKB.filterAxiom,
    filterExcludePredicates: SUMOKBtoTPTPKB.filterExcludePredicates,
    readKIFFile: SUMOKBtoTPTPKB.readKIFFile,
    parseKIFFormulas: SUMOKBtoTPTPKB.parseKIFFormulas,
    langToExtension: SUMOKBtoTPTPKB.langToExtension,
    extensionToLang: SUMOKBtoTPTPKB.extensionToLang,
    setKBDebug: SUMOKBtoTPTPKB.setDebug,
    setLanguage: SUMOKBtoTPTPKB.setLanguage,
    setRemoveHOL: SUMOKBtoTPTPKB.setRemoveHOL,
    setRemoveNum: SUMOKBtoTPTPKB.setRemoveNum,
    setRemoveStrings: SUMOKBtoTPTPKB.setRemoveStrings,
    excludedPredicates: SUMOKBtoTPTPKB.excludedPredicates,

    // Constants
    ...constants,

    // Utilities
    ...StringUtil
};
