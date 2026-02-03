/**
 * TPTP Conversion Module
 */

vscode = require('vscode');

const converter = require('./converter');
const mappings = require('./mappings');

// Some constants and extension mappings for TPTP

const TPTP_ROLES = {
    'axiom': vscode.SymbolKind.Constant,
    'hypothesis': vscode.SymbolKind.Variable,
    'definition': vscode.SymbolKind.Class,
    'assumption': vscode.SymbolKind.Variable,
    'lemma': vscode.SymbolKind.Method,
    'theorem': vscode.SymbolKind.Method,
    'corollary': vscode.SymbolKind.Method,
    'conjecture': vscode.SymbolKind.Function,
    'negated_conjecture': vscode.SymbolKind.Function,
    'plain': vscode.SymbolKind.Field,
    'type': vscode.SymbolKind.TypeParameter,
    'interpretation': vscode.SymbolKind.Interface,
    'fi_domain': vscode.SymbolKind.Enum,
    'fi_functors': vscode.SymbolKind.EnumMember,
    'fi_predicates': vscode.SymbolKind.EnumMember,
    'unknown': vscode.SymbolKind.Null
};

const TPTP_FORMULA_TYPES = ['thf', 'tff', 'tcf', 'fof', 'cnf', 'tpi'];

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
    EXCLUDED_PREDICATES: mappings.EXCLUDED_PREDICATES,

    // Constants
    TPTP_FORMULA_TYPES,
    TPTP_ROLES
};
