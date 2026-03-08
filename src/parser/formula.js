const { Sentence, OperatorSentence, VariableSym } = require('./sentence');
const { Term, SemanticError } = require('./term');
const { Symbol } = require('./symbol');
const { SemanticStatement } = require('./semantics');
const {
    EqualityOperator,
    ForAllOperator,
    ExistsOperator
} = require('./operator');
const { SemanticVariable } = require('./variable');

const QUANTIFIERS = [ForAllOperator, ExistsOperator];

/**
 * Formulas are analogs to Sentences like Terms are 
 * analogs to Symbols. This class is utilized to perform 
 * Formula level validation mainly as there is not too much
 * cross reference needed for formulas (other than value) 
 */
class Formula extends SemanticStatement {
    /**
     * @param {Sentence} sentence
     */
    constructor(sentence) {
        super();
        /** @type {Sentence} */
        this.sentence = sentence;
        // Set forward statement
        this.sentence.forward = this;
    }

    /** 
     * Get whether the formula is a logical statement
     * @returns {boolean}
     */
    get logical() {
        if (this.sentence instanceof OperatorSentence)
            return true;
        const firstSym = this.sentence.terms[0];
        if (!firstSym || firstSym instanceof Sentence)
            return false;
        /** @type {Term} */
        const firstTerm = firstSym.forward || (firstSym instanceof Symbol) ? new Term(firstSym) : new SemanticVariable(firstSym);
        return firstTerm.isPredicate;
    }

    /** 
     * Get the formula range if not a logical statement,
     *  return null if no range
     * @returns {Term|null}
     */
    get range() {
        const firstSym = this.sentence.terms[0];
        if (!firstSym || !(firstSym instanceof Symbol))
            return null;
        /** @type {Term} */
        const firstTerm = firstSym.forward || new Term(firstSym);
        if (!firstTerm.isFunction)
            return null;
        return firstTerm.validRange();
    }

    get relation() {
        const firstSym = this.sentence.terms[0];
        const relation = firstSym.forward 
            || (firstSym instanceof Symbol) ? 
                  new Term(firstSym) 
                : new SemanticVariable(firstSym);
        return relation;
    }

    get args() {
        return this.sentence
            .terms
            .slice(1)
            .map(a => {
                return a.forward || (a instanceof Symbol) ?
                    new Term(a) : new SemanticVariable(a)
            });
    }

    /**
     * Validate a formula
     * @returns {boolean}
     */
    validate() {
        // Rule 1: If the sentence starts with an non-equals
        //  operator then its terms must be either operator 
        //  sentences or predicate sentences (can assume all 
        //  the Sentences) - this is actually hard and fast
        if (this.sentence instanceof OperatorSentence) {
            /** @type {Sentence[]} */
            let args;
            if (this.sentence.terms[0] != EqualityOperator) {
                if (QUANTIFIERS.includes(this.sentence.terms[0]))
                    args = this.sentence.terms.slice(2);
                else
                    args = this.sentence.terms.slice(1);
                if ((args.some(s => !s.forward.logical))) {
                    throw new SemanticError(this.sentence, "Operators must have either operator or predicate sentences as their arguments");
                }
            }
            return true;
        }
        const relation = this.relation;
        // Rule 2: The sentence must start with a relation
        //  (if not an operator)
        if (!relation.isRelation) {
            throw new SemanticError(this.sentence, "Sentences must start with a relation (function or predicate)");
        } // By this point we know that the sentence starts with a relation
        // Validate the first term in the sentence
        /** @type {Term} */
        if (!relation.validate()) return false;
        // Now we know that the term is valid (domain and arity match)
        // Rule 3: The sentence's arguments (terms after the first)
        //  must match the domain of the term (if the term has a domain)
        const arity = relation.arity;
        if (arity) {
            /** @type {SemanticStatement[]} */
            const args = this.args;
            // Match arity
            if (arity > 0 && arity !== args.length) {
                throw new SemanticError(this.sentence, `Sentence arity mismatch, term '${relation.name}' expects ${arity} args but only ${args.length} are provided`);
            }
            // Validate each argument
            if (args.some(a => !a.validate())) return false;
            // Each arg validates now, check that the argument matchs the expected domain
            //  the last domain statement applies to the all the ending arguments
            const badDomain = args.findIndex((a, idx) => {
                if (a instanceof Term)
                    return relation.validateDomain(a, idx);
                else if (a instanceof Formula)
                    return relation.validateDomain(a.range, idx);
                else if (a instanceof SemanticVariable)
                    return relation.domain[idx] ? a.isInstance !== false : a.isClass !== false
                else return false;
            });
            if (badDomain >= 0) {
                throw new SemanticError(this.sentence, `Term '${relation.name}' has the domain ${relation.domain[badDomain].name} for argument #${badDomain + 1} (${args[badDomain].name})`);
            }
        }
    }
}

module.exports = {
    Formula
}