/**
 * SUO-KIF to TPTP Converter
 * Based on sigmakee's SUMOformulaToTPTPformula.java
 */

const { NodeType, collectFreeVariables, getValue } = require('../parser');

/**
 * Error thrown when a formula contains higher-order logic constructs
 * that cannot be expressed in first-order logic (FOF)
 */
class HOLError extends Error {
    constructor(message) {
        super(message);
        this.name = 'HOLError';
    }
}
const {
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
} = require('./mappings');

/**
 * Converter options
 */
const defaultOptions = {
    hideNumbers: true,          // Convert numbers to n__X format
    addPrefixes: true,          // Add s__ prefix to terms
    lang: 'fof',                // Output format: 'fof', 'tff', or 'thf'
    removeHOL: false,           // Skip higher-order logic
    removeStrings: false,       // Skip formulas with strings
    includeSourceComments: true // Include source KIF as comments
};

/**
 * Convert a SUO-KIF variable name to TPTP format
 * @param {string} varName - Variable name (e.g., ?X or @ROW)
 * @returns {string} TPTP variable (e.g., V__X)
 */
function convertVariable(varName) {
    // Remove ? or @ prefix and add V__ prefix
    let name = varName;
    if (name.startsWith('?') || name.startsWith('@')) {
        name = name.substring(1);
    }
    // Replace hyphens with underscores
    name = name.replace(/-/g, '_');
    // TPTP variables must start with uppercase
    return VARIABLE_PREFIX + name.toUpperCase();
}

/**
 * Convert a number to TPTP format
 * @param {string} numStr - Number string
 * @param {Object} options - Converter options
 * @returns {string} TPTP number representation
 */
function convertNumber(numStr, options = {}) {
    if (options.hideNumbers) {
        // Convert number to n__X format
        // Replace decimal point with underscore, handle negative signs
        let converted = numStr.replace(/\./g, '_');
        if (converted.startsWith('-')) {
            converted = 'neg_' + converted.substring(1);
        }
        return NUMBER_PREFIX + converted;
    }
    return numStr;
}

/**
 * Convert a term/symbol to TPTP format
 * @param {string} term - SUO-KIF term
 * @param {boolean} isArgument - Whether the term is used as an argument
 * @param {Object} options - Converter options
 * @returns {string} TPTP term
 */
function convertTerm(term, isArgument = false, options = {}) {
    // Check for boolean constants
    // Only convert to $true/$false when NOT in argument position
    // In argument position, True/False are SUMO individuals, not logical constants
    if (BOOLEAN_CONSTANTS[term] && !isArgument) {
        return BOOLEAN_CONSTANTS[term];
    }

    // Don't prefix logical operators
    if (LOGIC_KEYWORDS.has(term)) {
        if (isArgument) {
            // When a logical keyword is used as an argument, it needs special handling
            return (options.addPrefixes ? TERM_PREFIX : '') + term + TERM_MENTION_SUFFIX;
        }
        return term;
    }

    // Check for comparison operators used as predicates
    if (COMPARISON_OPERATORS[term] && !isArgument) {
        return (options.addPrefixes ? TERM_PREFIX : '') + COMPARISON_OPERATORS[term];
    }

    // Check for math functions
    if (MATH_FUNCTIONS[term]) {
        return (options.addPrefixes ? TERM_PREFIX : '') + MATH_FUNCTIONS[term];
    }

    // Regular term - add prefix and possibly suffix
    let result = term;

    // Add prefix
    if (options.addPrefixes) {
        result = TERM_PREFIX + result;
    }

    // Add mention suffix if used as argument (reification)
    if (isArgument && isRelationName(term)) {
        result += TERM_MENTION_SUFFIX;
    }

    // Sanitize or Quote: if not a valid simple TPTP identifier, wrap in single quotes
    // Valid simple identifier: [a-z][a-zA-Z0-9_]*
    if (!/^[a-z][a-zA-Z0-9_]*$/.test(result)) {
        // Escape single quotes and backslashes
        result = "'" + result.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
    }

    return result;
}

/**
 * Check if a term name looks like a relation (starts with lowercase)
 * @param {string} name - Term name
 * @returns {boolean}
 */
function isRelationName(name) {
    if (!name || name.length === 0) return false;
    const first = name.charAt(0);
    return first >= 'a' && first <= 'z';
}

/**
 * Convert a string literal to TPTP format
 * @param {string} str - String literal (with quotes)
 * @param {Object} options - Converter options
 * @returns {string} TPTP string representation
 */
function convertStringLiteral(str, options = {}) {
    // Remove quotes and convert to a constant
    let inner = str;
    if (inner.startsWith('"') && inner.endsWith('"')) {
        inner = inner.slice(1, -1);
    }
    // Sanitize for TPTP
    inner = inner.replace(/[^a-zA-Z0-9]/g, '_').substring(0, 50);
    return (options.addPrefixes ? TERM_PREFIX : '') + 'str_' + inner;
}

/**
 * Convert an AST node to TPTP format
 * @param {Object} node - AST node
 * @param {Object} options - Converter options
 * @param {boolean} isArgument - Whether this node is in argument position
 * @returns {string|null} TPTP string or null if should be skipped
 */
function convertNode(node, options = defaultOptions, isArgument = false) {
    if (!node) return null;

    const opts = { ...defaultOptions, ...options };

    // Handle atoms (variables, constants, etc.)
    if (node.type === NodeType.VARIABLE) {
        return convertVariable(node.value);
    }

    if (node.type === NodeType.ROW_VARIABLE) {
        // Row variables are converted the same as regular variables
        return convertVariable(node.value);
    }

    if (node.type === NodeType.NUMBER) {
        return convertNumber(node.value, opts);
    }

    if (node.type === NodeType.STRING) {
        if (opts.removeStrings) return null;
        return convertStringLiteral(node.value, opts);
    }

    if (node.type === NodeType.ATOM || node.type === 'atom') {
        // Check if it's actually a number
        if (/^-?\d+(\.\d+)?(e-?\d+)?$/i.test(node.value)) {
            return convertNumber(node.value, opts);
        }
        return convertTerm(node.value, isArgument, opts);
    }

    // Handle lists (S-expressions)
    if (node.type === NodeType.LIST || node.type === 'list') {
        if (!node.children || node.children.length === 0) {
            return null;
        }

        const head = node.children[0];
        const headVal = getValue(head);

        if (!headVal) return null;

        // Check for excluded predicates
        if (EXCLUDED_PREDICATES.has(headVal)) {
            return null;
        }

        // Handle logical operators
        if (LOGICAL_OPERATORS[headVal]) {
            // If a logical formula is in argument position, it's higher-order logic
            // In FOF, we can't express formulas as terms, so we must skip these
            if (isArgument) {
                // Mark this formula as containing HOL so it can be skipped
                throw new HOLError(`Logical formula in argument position: ${headVal}`);
            }
            return convertLogicalOperator(node, headVal, opts);
        }

        // Handle equality
        if ((headVal === '=' || headVal === 'equal') && !isArgument) {
            return convertEquality(node, opts);
        }

        // Check if this is a relation (predicate) in argument position - higher-order logic
        // Relations start with lowercase, Functions start with uppercase
        // Exception: 'equal' can be converted to s__equal term
        if (isArgument && isRelationName(headVal) && headVal !== 'equal') {
            // This is a relation/predicate being used as an argument (formula as term)
            // In FOF, we can't express predicates as terms without full reification
            // Throw HOLError to skip this formula
            throw new HOLError(`Predicate in argument position: ${headVal}`);
        }

        // Handle regular function application (uppercase head = function returning term)
        return convertApplication(node, opts, isArgument);
    }

    return null;
}

/**
 * Convert a logical operator expression
 */
function convertLogicalOperator(node, op, options) {
    const tptpOp = LOGICAL_OPERATORS[op];

    switch (op) {
        case 'not': {
            if (node.children.length < 2) return null;
            const arg = convertNode(node.children[1], options, false);
            if (!arg) return null;
            return `(${tptpOp} ${arg})`;
        }

        case 'and':
        case 'or': {
            const args = [];
            for (let i = 1; i < node.children.length; i++) {
                const arg = convertNode(node.children[i], options, false);
                if (arg) args.push(arg);
            }
            if (args.length === 0) return op === 'and' ? '$true' : '$false';
            if (args.length === 1) return args[0];
            return '(' + args.join(` ${tptpOp} `) + ')';
        }

        case '=>':
        case '<=>': {
            if (node.children.length < 3) return null;
            const left = convertNode(node.children[1], options, false);
            const right = convertNode(node.children[2], options, false);
            if (!left || !right) return null;
            return `(${left} ${tptpOp} ${right})`;
        }

        case 'forall':
        case 'exists': {
            if (node.children.length < 3) return null;
            const varList = node.children[1];
            if (varList.type !== NodeType.LIST && varList.type !== 'list') return null;

            const vars = varList.children
                .filter(v => v.type === NodeType.VARIABLE || v.type === NodeType.ROW_VARIABLE ||
                            v.type === 'atom' && (v.value.startsWith('?') || v.value.startsWith('@')))
                .map(v => convertVariable(getValue(v) || v.value));

            const body = convertNode(node.children[2], options, false);
            if (!body) return null;

            if (vars.length === 0) return body;
            return `(${tptpOp} [${vars.join(', ')}] : ${body})`;
        }

        default:
            return null;
    }
}

/**
 * Convert an equality expression
 */
function convertEquality(node, options) {
    if (node.children.length < 3) return null;
    const left = convertNode(node.children[1], options, true);
    const right = convertNode(node.children[2], options, true);
    if (!left || !right) return null;
    return `(${left} = ${right})`;
}

/**
 * Convert a function/relation application
 * @param {Object} node - AST node
 * @param {Object} options - Converter options
 * @param {boolean} inArgPosition - Whether this application is in argument position
 */
function convertApplication(node, options, inArgPosition = false) {
    const head = node.children[0];
    const headVal = getValue(head);

    if (!headVal) return null;

    // Check if head is a variable (higher-order logic - variable as predicate)
    const isVariableHead = headVal.startsWith('?') || headVal.startsWith('@');

    if (isVariableHead) {
        // Higher-order logic: variable used as predicate/function
        const predVar = convertVariable(headVal);

        // Convert arguments
        const args = [predVar];
        for (let i = 1; i < node.children.length; i++) {
            const arg = convertNode(node.children[i], options, true);
            if (arg !== null) {
                args.push(arg);
            }
        }

        // Distinguish between predicate application and function application
        // based on whether we're in argument position:
        // - In formula position: s__holds(V__P, args...) - predicate returning $o
        // - In term position: s__apply(V__F, args...) - function returning $i
        const prefix = options.addPrefixes ? 's__' : '';
        const applySymbol = inArgPosition ? 'apply' : 'holds';
        return `${prefix}${applySymbol}(${args.join(', ')})`;
    }

    // Convert the predicate/function name
    const predName = convertTerm(headVal, false, options);

    // Convert arguments
    const args = [];
    for (let i = 1; i < node.children.length; i++) {
        const arg = convertNode(node.children[i], options, true);
        if (arg === null && !options.removeStrings) {
            // Skip if conversion failed
            continue;
        }
        if (arg !== null) {
            args.push(arg);
        }
    }

    if (args.length === 0) {
        // Nullary predicate or propositional constant
        return predName;
    }

    return `${predName}(${args.join(', ')})`;
}

/**
 * Convert a formula, wrapping free variables with universal quantification
 * @param {Object} node - AST node (top-level formula)
 * @param {Object} options - Converter options
 * @returns {string|null} TPTP formula with quantification
 */
function convertFormula(node, options = defaultOptions) {
    const opts = { ...defaultOptions, ...options };

    // Get free variables
    const freeVars = collectFreeVariables(node);
    const freeVarsList = Array.from(freeVars).map(v => convertVariable(v));

    // Convert the formula body
    const body = convertNode(node, opts, false);
    if (!body) return null;

    // Wrap with universal quantification if there are free variables
    if (freeVarsList.length > 0) {
        return `(! [${freeVarsList.join(', ')}] : ${body})`;
    }

    return body;
}

/**
 * Convert a complete knowledge base to TPTP format
 * @param {Array} ast - Array of AST nodes (top-level formulas)
 * @param {Object} options - Converter options
 * @returns {Object} Result with tptp string, stats, and skipped items
 */
function convertKnowledgeBase(ast, options = {}) {
    const opts = { ...defaultOptions, ...options };
    const lines = [];
    const skipped = [];
    let axiomNum = 0;

    const sourceName = opts.sourceName || 'kb';
    const timestamp = new Date().toISOString();

    // Generate header
    const header = `% TPTP Translation of SUO-KIF Knowledge Base
% Source: ${sourceName}
% Generated: ${timestamp}
% Generator: SUO-KIF VSCode Extension
% Format: ${opts.lang.toUpperCase()}
%
% Prefixes used:
%   ${TERM_PREFIX} - Term/predicate prefix
%   ${VARIABLE_PREFIX} - Variable prefix
%   ${NUMBER_PREFIX} - Number prefix (when hideNumbers=true)
%   ${TERM_MENTION_SUFFIX} - Relation mention suffix
%
% ============================================================

`;

    for (let i = 0; i < ast.length; i++) {
        const node = ast[i];

        try {
            // Check if it's an excluded predicate
            if (node.type === NodeType.LIST || node.type === 'list') {
                const head = node.children[0];
                const headVal = getValue(head);
                if (headVal && EXCLUDED_PREDICATES.has(headVal)) {
                    continue; // Skip silently
                }
            }

            const tptp = convertFormula(node, opts);

            if (tptp) {
                // Generate axiom name
                let axiomName = generateAxiomName(node, ++axiomNum);

                // Add source comment if requested
                if (opts.includeSourceComments) {
                    // lines.push(`% Source: ${nodeToString(node).substring(0, 100)}`);
                }

                lines.push(`${opts.lang}(${axiomName}, axiom, ${tptp}).`);
            }
        } catch (e) {
            skipped.push({
                index: i,
                error: e.message,
                node: node
            });
        }
    }

    // Generate statistics
    const stats = `% ============================================================
% Statistics:
%   Total axioms generated: ${lines.length}
%   Expressions skipped: ${skipped.length}
% ============================================================

`;

    // Generate footer with skipped items
    let footer = '';
    if (skipped.length > 0) {
        footer = '\n% ============================================================\n';
        footer += '% Skipped expressions:\n';
        for (const s of skipped) {
            footer += `%   Index ${s.index}: ${s.error}\n`;
        }
        footer += '% ============================================================\n';
    }

    return {
        tptp: header + stats + lines.join('\n') + footer,
        axiomCount: lines.length,
        skippedCount: skipped.length,
        skipped: skipped
    };
}

/**
 * Generate an axiom name based on the formula structure
 */
function generateAxiomName(node, num) {
    let prefix = 'axiom';

    if (node.type === NodeType.LIST || node.type === 'list') {
        const head = node.children[0];
        const headVal = getValue(head);

        if (headVal === 'subclass' && node.children.length >= 2) {
            const child = node.children[1];
            const childVal = getValue(child);
            if (childVal) {
                prefix = 'subclass_' + childVal.toLowerCase().replace(/[^a-z0-9]/g, '_');
            }
        } else if (headVal === 'instance' && node.children.length >= 2) {
            const inst = node.children[1];
            const instVal = getValue(inst);
            if (instVal) {
                prefix = 'instance_' + instVal.toLowerCase().replace(/[^a-z0-9]/g, '_');
            }
        } else if (headVal === '=>') {
            prefix = 'rule';
        } else if (headVal === '<=>') {
            prefix = 'equivalence';
        } else if (headVal === 'forall' || headVal === 'exists') {
            prefix = 'quantified';
        }
    }

    return `${prefix}_${num}`;
}

/**
 * Convert a single formula string to TPTP (convenience function)
 * @param {string} kifString - SUO-KIF formula string
 * @param {Object} options - Converter options
 * @returns {string|null} TPTP formula
 */
function convertKIFString(kifString, options = {}) {
    const { tokenize } = require('../parser/tokenizer');
    const { parse } = require('../parser/parser');

    const tokens = tokenize(kifString);
    const ast = parse(tokens);

    if (ast.length === 0) return null;

    return convertFormula(ast[0], options);
}

module.exports = {
    convertVariable,
    convertNumber,
    convertTerm,
    convertStringLiteral,
    convertNode,
    convertFormula,
    convertKnowledgeBase,
    convertKIFString,
    defaultOptions
};
