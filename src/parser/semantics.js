/**
 * Simple interface for forward reference from the symbol
 *  to represent a semantically parsed statement
 */
class SemanticStatement {
    /**
     * Validate a semantic statement
     * @returns {boolean}
     */
    validate() { return true; }
}

module.exports = {
    SemanticStatement
}