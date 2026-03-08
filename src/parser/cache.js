/** A cached semantic statement */

const { SemanticStatement } = require("./semantics");
const { SymbolTable } = require("./symbol");

class CachedSemanticStatement extends SemanticStatement {
    /** @param {SymbolTable} symbolTable */
    constructor (symbolTable) {
        super();
        /** @type {SymbolTable} */
        this.symbolTable = symbolTable;

        // The epoch of the symbol table that this term was created
        this._epoch = null;

        this._cache = Object.create(null); // keyed computed-value store
    }

    /**
     * Returns the cache object for the current taxonomy epoch, clearing it
     * first if the symboltable has been modified since the last access.
     * 
     * @param {string} prop
     * @param {() => any} accessor
     * @returns {any}
     */
    _getCache(prop, accessor) {
        if (this._epoch !== this.symbolTable.epoch) {
            this._cache = Object.create(null);
            this._epoch = this.symbolTable.epoch;
        }
        if (!(prop in this._cache)) {
            this._cache[prop] = accessor();
        }
        return this._cache[prop];
    }
}

module.exports = {
    CachedSemanticStatement
}