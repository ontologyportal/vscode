const { SemanticStatement } = require("./semantics");
const { VariableSym } = require("./sentence");
const { SemanticError } = require("./term");
/**
 * A class to track Semantically parsed variables, which
 *  are context aware and attempt to validate themselves
 *  based on the context. It represents a, gathering info
 *  from its context, and checking for contradictions
 */
class SemanticVariable extends SemanticStatement {
    /** @type {boolean|null} */
    #_isInstance = null;
    /** @type {boolean|null} */
    #_isClass = null;
    /** @type {boolean|null} */
    #_isFunction = null;
    /** @type {boolean|null} */
    #_isRelation = null;
    /** @type {boolean|null} */
    #_isPredicate = null;
    /** @type {Term[]} */
    ancestors = [];
    
    /**
     * @param {VariableSym} variable 
     */
    constructor(variable) {
        super();
        /** @type {VariableSym} */
        this.variable = variable;

        this.variable.forward = this;
    }

    /** @return {boolean} */
    get isInstance() {
        return this.#_isInstance;
    }

    /** @param {boolean} newValue */
    set isInstance(newValue) {
        if (this.#_isInstance === null) this.#_isInstance = newValue;
        if (this.#_isInstance !== null && newValue !== this.#_isInstance) {
            throw new SemanticError(null, "Variable isInstance is already established");
        }
        // A symbol can either be a class or an instance 
        if (this.isClass === null) this.isClass = !this.#_isInstance;
    }

    /** @return {boolean} */
    get isClass() {
        return this.#_isClass;
    }

    /** @type {boolean} */
    set isClass(newValue) {
        if (this.#_isClass === null) this.#_isClass = newValue;
        if (this.#_isClass !== null && newValue !== this.#_isClass) {
            throw new SemanticError(null, "Variable isClass is already established");
        }
        // A symbol can either be a class or an instance 
        if (this.isInstance === null) this.isInstance = !this.#_isClass;
        // A symbol cannot be a class and a relation
        if (this.isRelation === null && this.isInstance === false) this.isRelation = false;
    }

    /** @return {boolean} */
    get isFunction() {
        return this.#_isFunction;
    }

    /** @type {boolean} */
    set isFunction(newValue) {
        if (this.#_isFunction === null) this.#_isFunction = newValue;
        if (this.#_isFunction !== null && newValue !== this.#_isFunction) {
            throw new SemanticError(null, "Variable isFunction is already established");
        }
        // If a symbol is a function it is a relation
        if (this.isRelation === null && this.#_isFunction === true) this.isRelation = true;
        // If a symbol is a function it is not a predicate
        if (this.isPredicate === null && this.#_isFunction === true) this.isPredicate = false;
        // If a symbol is not a function and it is a relation, then it must be a predicate
        if (this.isPredicate === null && this.#_isFunction === false && this.isRelation === true) this.isPredicate = true;
    }

    /** @return {boolean} */
    get isRelation() {
        return this.#_isRelation;
    }

    /** @type {boolean} */
    set isRelation(newValue) {
        if (this.#_isRelation === null) this.#_isRelation = newValue;
        if (this.#_isRelation !== null && newValue !== this.#_isRelation) {
            throw new SemanticError(null, "Variable isRelation is already established");
        }
        // If a symbol is a relation, it is an instance
        if (this.isInstance === null && this.#_isRelation) this.isInstance = true;
        // If a symbol is not a relation it is not a function
        if (this.isFunction === null && !this.#_isRelation === false) this.isFunction = false;
        // If a symbol is not a relation it is not a predicate
        if (this.isPredicate === null && !this.#_isRelation === false) this.isPredicate = false;
    }

    /** @return {boolean} */
    get isPredicate() {
        return this.#_isPredicate;
    }

    /** @type {boolean} */
    set isPredicate(newValue) {
        if (this.#_isPredicate === null) this.#_isPredicate = newValue;
        if (this.#_isPredicate !== null && newValue !== this.#_isPredicate) {
            throw new SemanticError(null, "Variable isFunction is already established");
        }
        // If a symbol is a predicate it is a relation
        if (this.isRelation === null && this.#_isPredicate === true) this.isRelation = true;
        // If a symbol is a predicate then it is not a function
        if (this.isFunction === null && this.#_isPredicate === true) this.isFunction = false;
        // If a symbol is not a predicate and it is a relation, then it must be a function
        if (this.isFunction === null && this.#_isPredicate === false && this.isRelation === true) this.isFunction = true;
    }

    /** 
     * Similar to the hasAncestor method in Term, based on the established info
     *  about the variable, determine if the variable has a given ancestor term
     * @param {Term} term
     * @returns {boolean}
     */
    hasAncestor(term) {
        // All terms are derived from Entity
        if (term.name === "Entity") return true;
        // Classes and relations are abstract
        if (term.name === "Abstract") {
            if (this.isRelation || this.isClass) return true;
        }
        // Otherwise, just iterate through the known ancestors
        return this.ancestors.some(a => a.hasAncestor(term));
    }

    /**
     * For now, validate true.
     * [TODO] track partitions and other things
     */
}

module.exports = {
    SemanticVariable
};