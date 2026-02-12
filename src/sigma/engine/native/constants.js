/**
 * Constants for SUMO formula processing
 * Ported from Formula.java
 *
 * This code is copyright Articulate Software (c) 2003.
 * This software is released under the GNU Public License
 * <http://www.gnu.org/copyleft/gpl.html>.
 */

// Logical operators
const AND = 'and';
const OR = 'or';
const XOR = 'xor';
const NOT = 'not';
const IF = '=>';
const IFF = '<=>';
const UQUANT = 'forall';
const EQUANT = 'exists';
const EQUAL = 'equal';

// Comparison operators
const GT = 'greaterThan';
const GTET = 'greaterThanOrEqualTo';
const LT = 'lessThan';
const LTET = 'lessThanOrEqualTo';

// Function names
const KAPPAFN = 'KappaFn';
const PLUSFN = 'AdditionFn';
const MINUSFN = 'SubtractionFn';
const TIMESFN = 'MultiplicationFn';
const DIVIDEFN = 'DivisionFn';
const FLOORFN = 'FloorFn';
const ROUNDFN = 'RoundFn';
const CEILINGFN = 'CeilingFn';
const REMAINDERFN = 'RemainderFn';
const SKFN = 'SkFn';

// Prefixes and suffixes
const SK_PREF = 'Sk';
const FN_SUFF = 'Fn';
const V_PREF = '?';
const R_PREF = '@';
const VX = V_PREF + 'X';
const VVAR = V_PREF + 'VAR';
const RVAR = R_PREF + 'ROW';

// Delimiters
const LP = '(';
const RP = ')';
const SPACE = ' ';

// Logical constants
const LOG_TRUE = 'True';
const LOG_FALSE = 'False';

// TPTP translation prefixes/suffixes
const TERM_MENTION_SUFFIX = '__m';
const CLASS_SYMBOL_SUFFIX = '__t';
const TERM_SYMBOL_PREFIX = 's__';
const TERM_VARIABLE_PREFIX = 'V__';

// Logical operators list
const LOGICAL_OPERATORS = [
    UQUANT,
    EQUANT,
    AND,
    OR,
    XOR,
    NOT,
    IF,
    IFF
];

// Comparison operators list
const COMPARISON_OPERATORS = [
    EQUAL,
    GT,
    GTET,
    LT,
    LTET
];

// Inequalities list
const INEQUALITIES = [
    GT,
    GTET,
    LT,
    LTET
];

// Math functions list
const MATH_FUNCTIONS = [
    PLUSFN,
    MINUSFN,
    TIMESFN,
    DIVIDEFN,
    FLOORFN,
    ROUNDFN,
    CEILINGFN,
    REMAINDERFN
];

// Documentation predicates
const DOC_PREDICATES = [
    'documentation',
    'comment',
    'format',
    'termFormat',
    'lexicon',
    'externalImage',
    'synonymousExternalConcept'
];

// Definition predicates
const DEFN_PREDICATES = [
    'instance',
    'subclass',
    'domain',
    'domainSubclass',
    'range',
    'rangeSubclass',
    'subAttribute',
    'subrelation'
];

module.exports = {
    AND,
    OR,
    XOR,
    NOT,
    IF,
    IFF,
    UQUANT,
    EQUANT,
    EQUAL,
    GT,
    GTET,
    LT,
    LTET,
    KAPPAFN,
    PLUSFN,
    MINUSFN,
    TIMESFN,
    DIVIDEFN,
    FLOORFN,
    ROUNDFN,
    CEILINGFN,
    REMAINDERFN,
    SKFN,
    SK_PREF,
    FN_SUFF,
    V_PREF,
    R_PREF,
    VX,
    VVAR,
    RVAR,
    LP,
    RP,
    SPACE,
    LOG_TRUE,
    LOG_FALSE,
    TERM_MENTION_SUFFIX,
    CLASS_SYMBOL_SUFFIX,
    TERM_SYMBOL_PREFIX,
    TERM_VARIABLE_PREFIX,
    LOGICAL_OPERATORS,
    COMPARISON_OPERATORS,
    INEQUALITIES,
    MATH_FUNCTIONS,
    DOC_PREDICATES,
    DEFN_PREDICATES
};
