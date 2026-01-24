/**
 * TPTP Conversion Mappings
 * Based on sigmakee's SUMOformulaToTPTPformula.java
 */

// Logical operator mappings (SUO-KIF -> TPTP)
const LOGICAL_OPERATORS = {
    'forall': '!',
    'exists': '?',
    'not': '~',
    'and': '&',
    'or': '|',
    'xor': '<~>',
    '=>': '=>',
    '<=>': '<=>'
};

// Comparison operator mappings
const COMPARISON_OPERATORS = {
    '<=': 'lesseq',
    '<': 'less',
    '>': 'greater',
    '>=': 'greatereq',
    'lessThan': 'lessThan',
    'greaterThan': 'greaterThan',
    'lessThanOrEqualTo': 'lessThanOrEqualTo',
    'greaterThanOrEqualTo': 'greaterThanOrEqualTo'
};

// Mathematical function mappings
const MATH_FUNCTIONS = {
    'MultiplicationFn': 'product',
    'DivisionFn': 'quotient',
    'AdditionFn': 'sum',
    'SubtractionFn': 'difference',
    'TimesFn': 'product',
    'DivideFn': 'quotient',
    'PlusFn': 'sum',
    'MinusFn': 'difference'
};

// Boolean constants
const BOOLEAN_CONSTANTS = {
    'True': '$true',
    'False': '$false'
};

// Predicates to exclude from TPTP output
const EXCLUDED_PREDICATES = new Set([
    'documentation',
    'domain',
    'domainSubclass',
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

// Logical operators that should not be prefixed
const LOGIC_KEYWORDS = new Set([
    'and', 'or', 'not', '=>', '<=>', 'forall', 'exists', '='
]);

// Prefix for terms/symbols
const TERM_PREFIX = 's__';

// Suffix for relation mentions (when relation is used as argument)
const TERM_MENTION_SUFFIX = '__m';

// Prefix for variables
const VARIABLE_PREFIX = 'V__';

// Prefix for numbers (when hiding numbers)
const NUMBER_PREFIX = 'n__';

module.exports = {
    LOGICAL_OPERATORS,
    COMPARISON_OPERATORS,
    MATH_FUNCTIONS,
    BOOLEAN_CONSTANTS,
    EXCLUDED_PREDICATES,
    LOGIC_KEYWORDS,
    TERM_PREFIX,
    TERM_MENTION_SUFFIX,
    VARIABLE_PREFIX,
    NUMBER_PREFIX
};
