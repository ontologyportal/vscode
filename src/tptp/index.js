/**
 * TPTP Conversion Module
 */

const converter = require('./converter');
const mappings = require('./mappings');

module.exports = {
    // Converter functions
    convertVariable: converter.convertVariable,
    convertNumber: converter.convertNumber,
    convertTerm: converter.convertTerm,
    convertStringLiteral: converter.convertStringLiteral,
    convertNode: converter.convertNode,
    convertFormula: converter.convertFormula,
    convertKnowledgeBase: converter.convertKnowledgeBase,
    convertKIFString: converter.convertKIFString,
    defaultOptions: converter.defaultOptions,

    // Mappings
    mappings: mappings,
    LOGICAL_OPERATORS: mappings.LOGICAL_OPERATORS,
    EXCLUDED_PREDICATES: mappings.EXCLUDED_PREDICATES
};
