const {
    ReferencedElement,
    ELEMENT_TYPE
} = require('./element');

const {
    NodeType
} = require('./parser');

/**
 * Create a class for an operator in a Sentence
 */
class Operator extends ReferencedElement {
    get $TYPE() {
        return ELEMENT_TYPE.OPERATOR;
    }

    static #TYPES = new Set([NodeType.OPERATOR]);
    get nodeTypes() { return Operator.#TYPES; }

    /**
     * @param {string} name
     * @param {number} arity
     */
    constructor(name, arity = Infinity, scoped = false) {
        super(name);
        /** @type {number} */
        this.arity = arity;
        /** @type {boolean} */
        this.scoped = scoped;
    }
}

const AndOperator = new Operator("and");
const OrOperator = new Operator("or");
const NotOperator = new Operator("not", 1);
const ConditionalOperator = new Operator("=>", 2);
const BiconditionalOperator = new Operator("<=>", 2);
const ExistsOperator = new Operator("exists", 2, true);
const ForAllOperator = new Operator("forall", 2, true);
const EqualityOperator = new Operator("equal", 2);

module.exports = {
    Operator,
    AndOperator,
    OrOperator,
    NotOperator,
    ConditionalOperator,
    BiconditionalOperator,
    EqualityOperator,
    ForAllOperator,
    ExistsOperator
};