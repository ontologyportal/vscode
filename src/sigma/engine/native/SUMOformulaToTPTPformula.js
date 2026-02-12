/**
 * SUMO to TPTP formula converter
 * Ported from SUMOformulaToTPTPformula.java
 *
 * This code is copyright Articulate Software (c) 2003.
 * This software is released under the GNU Public License
 * <http://www.gnu.org/copyleft/gpl.html>.
 */

const { Formula } = require('./Formula.js');
const {
    LP, RP, SPACE,
    UQUANT, EQUANT, AND, OR, XOR, NOT, IF, IFF, EQUAL,
    TERM_SYMBOL_PREFIX, TERM_VARIABLE_PREFIX, TERM_MENTION_SUFFIX,
    FN_SUFF, LOG_TRUE, LOG_FALSE,
    TIMESFN, DIVIDEFN, PLUSFN, MINUSFN,
    LT, LTET, GT, GTET
} = require('./constants.js');
const { emptyString, isNumeric } = require('./utils/StringUtil.js');

// Configuration
let debug = false;
let hideNumbers = true;
let lang = 'fof';

// Global qlist for tracking unquantified variables
let qlist = '';

/**
 * Set debug mode
 * @param {boolean} value
 */
function setDebug(value) {
    debug = value;
}

/**
 * Set hideNumbers mode
 * @param {boolean} value
 */
function setHideNumbers(value) {
    hideNumbers = value;
}

/**
 * Set language mode (fof, tff, thf)
 * @param {string} value
 */
function setLang(value) {
    lang = value;
}

/**
 * Translate a word from SUMO to TPTP format
 * @param {string} st - The token to translate
 * @param {number|string} type - The token type
 * @param {boolean} hasArguments - Whether the token has arguments (is a predicate/function)
 * @returns {string} The translated token
 */
function translateWord(st, type, hasArguments) {
    if (debug) console.log(`translateWord(): input: '${st}', hasArguments: ${hasArguments}`);

    let result = translateWord_1(st, type, hasArguments);

    // Handle special case for $true__m and $false__m
    if (result === '$true' + TERM_MENTION_SUFFIX || result === '$false' + TERM_MENTION_SUFFIX) {
        result = "'" + result + "'";
    }

    // Handle numbers in FOF mode
    if (isNumeric(result) && hideNumbers && lang !== 'tff') {
        if (result.includes('.')) {
            result = result.replace(/\./g, '_');
        }
        if (result.includes('-')) {
            result = result.replace(/-/g, '_');
        }
        result = 'n__' + result;
    }

    // Replace dots and dashes in non-numeric results
    if (!isNumeric(result)) {
        if (result.includes('.')) {
            result = result.replace(/\./g, '_');
        }
        if (result.includes('-')) {
            result = result.replace(/-/g, '_');
        }
    }

    if (debug) console.log(`translateWord(): result: '${result}'`);
    return result;
}

/**
 * Internal translation of SUMO tokens to TPTP
 * @private
 */
function translateWord_1(st, type, hasArguments) {
    if (debug) console.log(`translateWord_1(): st: ${st}, hasArguments: ${hasArguments}`);

    const kifOps = [UQUANT, EQUANT, NOT, AND, OR, XOR, IF, IFF, EQUAL];
    const tptpOps = ['! ', '? ', '~ ', ' & ', ' | ', ' <~> ', ' => ', ' <=> ', ' = '];

    const kifPredicates = ['<=', '<', '>', '>=', LTET, LT, GT, GTET];
    const tptpPredicates = ['lesseq', 'less', 'greater', 'greatereq',
                            'lesseq', 'less', 'greater', 'greatereq'];

    const kifConstants = [LOG_TRUE, LOG_FALSE];
    const tptpConstants = ['$true', '$false'];

    const kifFunctions = [TIMESFN, DIVIDEFN, PLUSFN, MINUSFN];
    const tptpFunctions = ['product', 'quotient', 'sum', 'difference'];

    const kifRelations = [...kifPredicates, ...kifFunctions];

    // Determine mention suffix
    let mentionSuffix = TERM_MENTION_SUFFIX;

    // Handle quoted strings (type 34 is '"')
    if (type === 34 || type === '"') {
        return st.replace(/[\n\t\r\f]/g, SPACE).replace(/'/g, '');
    }

    // Handle variables
    const ch0 = st.length > 0 ? st.charAt(0) : 'x';
    const ch1 = st.length > 1 ? st.charAt(1) : 'x';

    if (ch0 === '?' || ch0 === '@') {
        return TERM_VARIABLE_PREFIX + st.substring(1).replace(/-/g, '_');
    }

    // Translate special constants
    let translateIndex = kifConstants.indexOf(st);
    if (translateIndex !== -1) {
        return tptpConstants[translateIndex] + (hasArguments ? '' : mentionSuffix);
    }

    // Translate operators (only when used with arguments)
    translateIndex = kifOps.indexOf(st);
    if (translateIndex !== -1 && hasArguments) {
        return tptpOps[translateIndex];
    }

    // Handle numbers
    const isNumber = /^-?\d/.test(st);
    if (isNumber) {
        return st;
    }

    let term = st;

    // Handle terms without arguments (add mention suffix for relations)
    if (!hasArguments) {
        if (!Formula.isInequality(term)) {
            // Add mention suffix for relation-like terms
            if ((!term.endsWith(mentionSuffix) && /^[a-z]/.test(ch0)) ||
                term.endsWith(FN_SUFF) ||
                isKnownRelation(term)) {
                term += mentionSuffix;
            }
        } else {
            return TERM_SYMBOL_PREFIX + st.substring(1).replace(/-/g, '_');
        }
    }

    // Return with symbol prefix
    if (kifOps.includes(term) && hasArguments) {
        return term;
    } else {
        return TERM_SYMBOL_PREFIX + term;
    }
}

/**
 * Heuristic to check if a term is likely a relation
 * In the full Java implementation, this checks against the KB
 * @param {string} term - The term to check
 * @returns {boolean} true if likely a relation
 */
function isKnownRelation(term) {
    // Heuristic: starts with lowercase, or ends with specific suffixes
    if (term.length === 0) return false;
    const ch = term.charAt(0);
    // Common relation patterns
    if (/^[a-z]/.test(ch)) return true;
    if (term.endsWith(FN_SUFF)) return true;
    return false;
}

/**
 * Process a quantifier expression
 * @param {Formula} f - The full formula
 * @param {Formula} car - The car (operator)
 * @param {string} op - The operator string
 * @param {string[]} args - The arguments
 * @returns {string} The TPTP representation
 */
function processQuant(f, car, op, args) {
    if (debug) console.log('processQuant(): quantifier');

    if (args.length < 2) {
        console.error(`Error in processQuant(): wrong number of arguments to ${op} in ${f}`);
        return '';
    }

    if (args[0] !== null) {
        const varlist = new Formula(args[0]);
        const vars = varlist.argumentsToArrayListString(0);
        let varStr = '';

        for (const v of vars) {
            const oneVar = translateWord(v, v.charAt(0), false);
            varStr += oneVar + ', ';
        }

        let opStr = ' ! ';
        if (op === 'exists') {
            opStr = ' ? ';
        }

        const innerFormula = processRecurse(new Formula(args[1]));
        return LP + opStr + '[' + varStr.substring(0, varStr.length - 2) + '] : (' +
               innerFormula + '))';
    } else {
        console.error(`Error in processQuant(): null arguments to ${op} in ${f}`);
        return '';
    }
}

/**
 * Process conjunction/disjunction
 * @param {Formula} f - The full formula
 * @param {Formula} car - The car (operator)
 * @param {string[]} args - The arguments
 * @returns {string} The TPTP representation
 */
function processConjDisj(f, car, args) {
    const op = car.getFormula();

    if (args.length < 2) {
        console.error(`Error in processConjDisj(): wrong number of arguments to ${op} in ${f}`);
        return '';
    }

    let tptpOp = '&';
    if (op === OR) tptpOp = '|';
    if (op === XOR) tptpOp = '<~>';

    let result = LP + processRecurse(new Formula(args[0]));
    for (let i = 1; i < args.length; i++) {
        result += SPACE + tptpOp + SPACE + processRecurse(new Formula(args[i]));
    }
    result += RP;

    return result;
}

/**
 * Process logical operators
 * @param {Formula} f - The full formula
 * @param {Formula} car - The car (operator)
 * @param {string[]} args - The arguments
 * @returns {string} The TPTP representation
 */
function processLogOp(f, car, args) {
    const op = car.getFormula();
    if (debug) console.log(`processLogOp(): op: ${op}, args: ${args}`);

    if (op === AND) {
        return processConjDisj(f, car, args);
    }

    if (op === IF) {
        if (args.length < 2) {
            console.error(`Error in processLogOp(): wrong number of arguments to ${op} in ${f}`);
            return '';
        }
        // Standard TPTP style (non-EProver)
        return LP + processRecurse(new Formula(args[0])) + ' => ' +
               '(' + processRecurse(new Formula(args[1])) + ')' + RP;
    }

    if (op === IFF) {
        if (args.length < 2) {
            console.error(`Error in processLogOp(): wrong number of arguments to ${op} in ${f}`);
            return '';
        }
        // Expand biconditional as (A => B) & (B => A)
        const a = processRecurse(new Formula(args[0]));
        const b = processRecurse(new Formula(args[1]));
        return '((' + a + ' => ' + b + ') & (' + b + ' => ' + a + '))';
    }

    if (op === OR) {
        return processConjDisj(f, car, args);
    }

    if (op === XOR) {
        return processConjDisj(f, car, args);
    }

    if (op === NOT) {
        if (args.length !== 1) {
            console.error(`Error in processLogOp(): wrong number of arguments to ${op} in ${f}`);
            return '';
        }
        return '~(' + processRecurse(new Formula(args[0])) + RP;
    }

    if (op === UQUANT || op === EQUANT) {
        return processQuant(f, car, op, args);
    }

    console.error(`Error in processLogOp(): bad logical operator ${op} in ${f}`);
    return '';
}

/**
 * Process equality
 * @param {Formula} f - The full formula
 * @param {Formula} car - The car (operator)
 * @param {string[]} args - The arguments
 * @returns {string} The TPTP representation
 */
function processEquals(f, car, args) {
    const op = car.getFormula();

    if (args.length !== 2) {
        console.error(`Error in processEquals(): wrong number of arguments to ${op} in ${f}`);
        return '';
    }

    if (op.startsWith(EQUAL)) {
        return LP + processRecurse(new Formula(args[0])) + ' = ' +
               processRecurse(new Formula(args[1])) + RP;
    }

    console.error(`Error in processEquals(): bad comparison operator ${op} in ${f}`);
    return '';
}

/**
 * Recursively process a formula
 * @param {Formula} f - The formula to process
 * @returns {string} The TPTP representation
 */
function processRecurse(f) {
    if (debug) console.log(`processRecurse(): ${f}`);

    if (f === null) {
        return '';
    }

    if (f.atom()) {
        const formula = f.getFormula();
        let ttype = formula.charAt(0);
        if (/\d/.test(ttype)) {
            ttype = -2; // TT_NUMBER equivalent
        }
        return translateWord(formula, ttype, false);
    }

    const car = f.carAsFormula();
    const args = f.complexArgumentsToArrayListString(1);

    if (car.listP()) {
        console.error(`Error in processRecurse(): formula ${f}`);
        return '';
    }

    const carStr = car.getFormula();

    if (Formula.isLogicalOperator(carStr)) {
        return processLogOp(f, car, args);
    } else if (carStr === EQUAL) {
        return processEquals(f, car, args);
    } else {
        // Regular predicate or function
        if (debug) console.log(`processRecurse(): not math or comparison op: ${car}`);

        let argStr = '';
        for (const s of args) {
            if (carStr === 'instance') {
                // Special handling for instance predicate
                if (Formula.atom(s)) {
                    const formula = f.getFormula();
                    let ttype = formula.charAt(0);
                    if (/\d/.test(ttype)) {
                        ttype = -2;
                    }
                    argStr += translateWord(s, ttype, false) + ',';
                } else {
                    argStr += processRecurse(new Formula(s)) + ',';
                }
            } else {
                argStr += processRecurse(new Formula(s)) + ',';
            }
        }

        const result = translateWord(carStr, -3, true) + LP +
                       argStr.substring(0, argStr.length - 1) + RP;
        return result;
    }
}

/**
 * Generate the quantifier list for unquantified variables
 * @param {Formula} f - The formula to analyze
 */
function generateQList(f) {
    const uqVars = f.collectUnquantifiedVariables();
    let result = '';
    const varArray = Array.from(uqVars);
    const sizeUqVars = varArray.length;
    let count = 0;

    for (const s of varArray) {
        const oneVar = translateWord(s, s.charAt(0), false);
        result += oneVar;
        if (count < sizeUqVars - 1 && sizeUqVars > 1) {
            result += ',';
        }
        count++;
    }

    qlist = result;
    if (debug) console.log(`generateQList(): qlist: ${qlist}`);
}

/**
 * Process a formula and return TPTP
 * @param {Formula} f - The formula to process
 * @param {boolean} query - Whether this is a query (existential) or axiom (universal)
 * @returns {string} The TPTP representation
 */
function process(f, query) {
    if (f === null) {
        if (debug) console.error('Error in process(): null formula');
        return '';
    }

    if (f.atom()) {
        return translateWord(f.getFormula(), f.getFormula().charAt(0), false);
    }

    if (f.listP()) {
        let result = processRecurse(f);
        if (debug) console.log(`process(): result 1: ${result}`);

        generateQList(f);
        if (debug) console.log(`process(): qlist: ${qlist}`);

        if (qlist.length > 1) {
            let quantification = '! [';
            if (query) {
                quantification = '? [';
            }
            result = '( ' + quantification + qlist + '] : (' + result + ' ) )';
        }

        if (debug) console.log(`process(): result 2: ${result}`);
        return result;
    }

    return f.getFormula();
}

/**
 * Parse a SUMO string to TPTP format
 * Main entry point for formula conversion
 * @param {string} suoString - The SUMO formula string
 * @param {boolean} query - Whether this is a query (existential quantification for free vars)
 * @returns {string} The TPTP representation wrapped in parentheses
 */
function tptpParseSUOKIFString(suoString, query) {
    if (debug) console.log(`tptpParseSUOKIFString(): string: ${suoString}, query: ${query}, lang: ${lang}`);

    // For FOF, use the process function directly
    if (lang === 'fof') {
        return '( ' + process(new Formula(suoString), query) + ' )';
    }

    // Default to FOF processing
    return '( ' + process(new Formula(suoString), query) + ' )';
}

module.exports = {
    translateWord,
    processRecurse,
    processLogOp,
    processEquals,
    generateQList,
    process,
    tptpParseSUOKIFString,
    setDebug,
    setHideNumbers,
    setLang,
    get qlist() { return qlist; },
    get debug() { return debug; },
    get hideNumbers() { return hideNumbers; },
    get lang() { return lang; }
};
