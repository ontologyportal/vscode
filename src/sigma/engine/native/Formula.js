/**
 * Formula class for SUO-KIF representation
 * Ported from Formula.java
 *
 * This code is copyright Articulate Software (c) 2003.
 * This software is released under the GNU Public License
 * <http://www.gnu.org/copyleft/gpl.html>.
 */

const {
    LP, RP, SPACE,
    UQUANT, EQUANT, AND, OR, XOR, NOT, IF, IFF,
    V_PREF, R_PREF,
    LOGICAL_OPERATORS, FN_SUFF
} = require('./constants.js');
const { emptyString, isQuotedString } = require('./utils/StringUtil.js');

class Formula {
    /**
     * Create a new Formula
     * @param {string} [formulaStr] - The SUO-KIF formula string
     */
    constructor(formulaStr) {
        this.theFormula = formulaStr || '';
    }

    /**
     * Read a formula string
     * @param {string} s - The formula string to read
     */
    read(s) {
        this.theFormula = s || '';
    }

    /**
     * Get the formula string
     * @returns {string} The formula string
     */
    getFormula() {
        return this.theFormula;
    }

    /**
     * Test whether a string is an atom (not a list)
     * @param {string} s - The string to test
     * @returns {boolean} true if s is an atom
     */
    static atom(s) {
        if (emptyString(s)) {
            return false;
        }
        const str = s.trim();
        return isQuotedString(s) || (!str.includes(RP) && !/\s/.test(str));
    }

    /**
     * Test whether this Formula is an atom
     * @returns {boolean} true if this is an atom
     */
    atom() {
        return Formula.atom(this.theFormula);
    }

    /**
     * Test whether a string is a list
     * @param {string} s - The string to test
     * @returns {boolean} true if s is a list
     */
    static listP(s) {
        if (emptyString(s)) {
            return false;
        }
        const str = s.trim();
        return str.startsWith(LP) && str.endsWith(RP);
    }

    /**
     * Test whether this Formula is a list
     * @returns {boolean} true if this is a list
     */
    listP() {
        return Formula.listP(this.theFormula);
    }

    /**
     * Test whether a string is an empty list
     * @param {string} s - The string to test
     * @returns {boolean} true if s is an empty list
     */
    static empty(s) {
        return Formula.listP(s) && /^\(\s*\)$/.test(s);
    }

    /**
     * Test whether this Formula is an empty list
     * @returns {boolean} true if this is an empty list
     */
    empty() {
        return Formula.empty(this.theFormula);
    }

    /**
     * Return the LISP 'car' of the formula - the first element
     * @returns {string|null} The first element, or null if not a list
     */
    car() {
        if (!this.listP()) {
            return null;
        }
        if (this.empty()) {
            return '';
        }

        const input = this.theFormula.trim();
        const quoteChars = ['"', "'"];
        let i = 1;
        const len = input.length;
        const end = len - 1;
        let level = 0;
        let prev = '0';
        let insideQuote = false;
        let quoteCharInForce = '0';
        let result = '';

        while (i < end) {
            const ch = input.charAt(i);
            if (!insideQuote) {
                if (ch === '(') {
                    result += ch;
                    level++;
                } else if (ch === ')') {
                    result += ch;
                    level--;
                    if (level <= 0) {
                        break;
                    }
                } else if (/\s/.test(ch) && level <= 0) {
                    if (result.length > 0) {
                        break;
                    }
                } else if (quoteChars.includes(ch) && prev !== '\\') {
                    result += ch;
                    insideQuote = true;
                    quoteCharInForce = ch;
                } else {
                    result += ch;
                }
            } else if (quoteChars.includes(ch) && ch === quoteCharInForce && prev !== '\\') {
                result += ch;
                insideQuote = false;
                quoteCharInForce = '0';
                if (level <= 0) {
                    break;
                }
            } else {
                result += ch;
            }
            prev = ch;
            i++;
        }

        return result;
    }

    /**
     * Return the LISP 'cdr' of the formula - the rest after the first element
     * @returns {string|null} The rest of the list, or null if not a list
     */
    cdr() {
        if (!this.listP()) {
            return null;
        }
        if (this.empty()) {
            return this.theFormula;
        }

        const input = this.theFormula.trim();
        const quoteChars = ['"', "'"];
        let i = 1;
        const len = input.length;
        const end = len - 1;
        let level = 0;
        let prev = '0';
        let insideQuote = false;
        let quoteCharInForce = '0';
        let carCount = 0;

        while (i < end) {
            const ch = input.charAt(i);
            if (!insideQuote) {
                if (ch === '(') {
                    carCount++;
                    level++;
                } else if (ch === ')') {
                    carCount++;
                    level--;
                    if (level <= 0) {
                        break;
                    }
                } else if (/\s/.test(ch) && level <= 0) {
                    if (carCount > 0) {
                        break;
                    }
                } else if (quoteChars.includes(ch) && prev !== '\\') {
                    carCount++;
                    insideQuote = true;
                    quoteCharInForce = ch;
                } else {
                    carCount++;
                }
            } else if (quoteChars.includes(ch) && ch === quoteCharInForce && prev !== '\\') {
                carCount++;
                insideQuote = false;
                quoteCharInForce = '0';
                if (level <= 0) {
                    break;
                }
            } else {
                carCount++;
            }
            prev = ch;
            i++;
        }

        if (carCount > 0) {
            const j = i + 1;
            if (j < end) {
                return LP + input.substring(j, end).trim() + RP;
            } else {
                return LP + RP;
            }
        }
        return null;
    }

    /**
     * Return the car as a Formula
     * @returns {Formula|null} The first element as a Formula
     */
    carAsFormula() {
        const carStr = this.car();
        if (carStr !== null) {
            return new Formula(carStr);
        }
        return null;
    }

    /**
     * Return the cdr as a Formula
     * @returns {Formula|null} The rest as a Formula
     */
    cdrAsFormula() {
        const cdrStr = this.cdr();
        if (cdrStr !== null && Formula.listP(cdrStr)) {
            return new Formula(cdrStr);
        }
        return null;
    }

    /**
     * Get an argument at a specific position (0-indexed)
     * @param {number} index - The argument index (0 is the predicate)
     * @returns {string|null} The argument at the position
     */
    getArgument(index) {
        if (!this.listP()) {
            return null;
        }
        let f = new Formula(this.theFormula);
        for (let i = 0; i < index; i++) {
            const cdrStr = f.cdr();
            if (cdrStr === null || Formula.empty(cdrStr)) {
                return null;
            }
            f = new Formula(cdrStr);
        }
        return f.car();
    }

    /**
     * Get a string argument at a specific position
     * @param {number} index - The argument index
     * @returns {string} The argument string or empty string
     */
    getStringArgument(index) {
        const arg = this.getArgument(index);
        return arg !== null ? arg : '';
    }

    /**
     * Return all arguments starting from the given index
     * @param {number} start - The starting index
     * @returns {string[]|null} Array of argument strings
     */
    complexArgumentsToArrayListString(start) {
        let index = start;
        const result = [];
        let arg = this.getStringArgument(index);
        while (!emptyString(arg)) {
            result.push(arg);
            index++;
            arg = this.getStringArgument(index);
        }
        if (index === start) {
            return null;
        }
        return result;
    }

    /**
     * Return all arguments starting from index 0
     * @param {number} start - Starting index (for compatibility)
     * @returns {string[]|null} Array of argument strings
     */
    argumentsToArrayListString(start) {
        return this.complexArgumentsToArrayListString(start);
    }

    /**
     * Get the list length (number of elements)
     * @returns {number} The number of elements
     */
    listLength() {
        if (!this.listP()) {
            return 0;
        }
        let count = 0;
        let f = new Formula(this.theFormula);
        while (!f.empty()) {
            const carStr = f.car();
            if (carStr === null) break;
            count++;
            const cdrStr = f.cdr();
            if (cdrStr === null || Formula.empty(cdrStr)) break;
            f = new Formula(cdrStr);
        }
        return count;
    }

    /**
     * Check if a term is a variable
     * @param {string} term - The term to check
     * @returns {boolean} true if the term is a variable
     */
    static isVariable(term) {
        if (emptyString(term)) {
            return false;
        }
        return term.startsWith(V_PREF) || term.startsWith(R_PREF);
    }

    /**
     * Check if a term is a logical operator
     * @param {string} term - The term to check
     * @returns {boolean} true if the term is a logical operator
     */
    static isLogicalOperator(term) {
        return LOGICAL_OPERATORS.includes(term);
    }

    /**
     * Check if a term is a quantifier
     * @param {string} term - The term to check
     * @returns {boolean} true if the term is a quantifier
     */
    static isQuantifier(term) {
        return term === UQUANT || term === EQUANT;
    }

    /**
     * Collect all variables in the formula
     * @returns {Set<string>} Set of all variable names
     */
    collectAllVariables() {
        const resultSet = new Set();

        if (emptyString(this.theFormula)) {
            return resultSet;
        }
        if (this.empty()) {
            return resultSet;
        }
        if (this.atom()) {
            if (Formula.isVariable(this.theFormula)) {
                resultSet.add(this.theFormula);
            }
            return resultSet;
        }

        let f = new Formula(this.theFormula);
        while (!f.empty() && f.theFormula) {
            const carStr = f.car();
            if (carStr === null) break;
            const carFormula = new Formula(carStr);
            for (const v of carFormula.collectAllVariables()) {
                resultSet.add(v);
            }
            const cdrStr = f.cdr();
            if (cdrStr === null) break;
            f = new Formula(cdrStr);
        }

        return resultSet;
    }

    /**
     * Collect quantified variables
     * @returns {Set<string>} Set of quantified variable names
     */
    collectQuantifiedVariables() {
        const resultSet = new Set();

        if (emptyString(this.theFormula) || this.empty() || this.atom()) {
            return resultSet;
        }

        const car = this.car();
        const fcar = new Formula(car);

        if (Formula.atom(car) && Formula.isQuantifier(car)) {
            const remainder = this.cdrAsFormula();
            if (remainder) {
                const varlistStr = remainder.car();
                if (varlistStr) {
                    const varlist = new Formula(varlistStr);
                    for (const v of varlist.collectAllVariables()) {
                        resultSet.add(v);
                    }
                }
                const rest = remainder.cdrAsFormula();
                if (rest) {
                    for (const v of rest.collectQuantifiedVariables()) {
                        resultSet.add(v);
                    }
                }
            }
        } else {
            if (fcar.listP()) {
                for (const v of fcar.collectQuantifiedVariables()) {
                    resultSet.add(v);
                }
            }
            const cdrF = this.cdrAsFormula();
            if (cdrF) {
                for (const v of cdrF.collectQuantifiedVariables()) {
                    resultSet.add(v);
                }
            }
        }

        return resultSet;
    }

    /**
     * Collect unquantified (free) variables
     * @returns {Set<string>} Set of unquantified variable names
     */
    collectUnquantifiedVariables() {
        const allVars = this.collectAllVariables();
        const quantifiedVars = this.collectQuantifiedVariables();
        const result = new Set();
        for (const v of allVars) {
            if (!quantifiedVars.has(v)) {
                result.add(v);
            }
        }
        return result;
    }

    /**
     * Check if a term is an inequality operator
     * @param {string} term - The term to check
     * @returns {boolean} true if the term is an inequality
     */
    static isInequality(term) {
        const inequalities = ['greaterThan', 'greaterThanOrEqualTo', 'lessThan', 'lessThanOrEqualTo'];
        return inequalities.includes(term);
    }

    /**
     * Check if this formula is a simple clause (atom or simple predicate)
     * @returns {boolean} true if simple clause
     */
    isSimpleClause() {
        if (this.atom()) {
            return true;
        }
        if (this.empty()) {
            return false;
        }
        const pred = this.car();
        if (Formula.isLogicalOperator(pred)) {
            return false;
        }
        // Check if all arguments are atoms
        const args = this.complexArgumentsToArrayListString(1);
        if (!args) {
            return true;
        }
        for (const arg of args) {
            if (Formula.listP(arg) && !Formula.empty(arg)) {
                const argF = new Formula(arg);
                const argCar = argF.car();
                // Functions (ending in Fn) are okay
                if (!argCar.endsWith(FN_SUFF)) {
                    return false;
                }
            }
        }
        return true;
    }

    /**
     * Format the formula for display
     * @returns {string} Formatted formula string
     */
    format() {
        return this.theFormula;
    }

    /**
     * String representation
     * @returns {string} The formula string
     */
    toString() {
        return this.theFormula;
    }
}

module.exports = { Formula };
