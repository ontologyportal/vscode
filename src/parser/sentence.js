
const {
    NodeType,
    ASTListNode,
    ASTNode
} = require('./parser');
const {
    ReferencedElement,
    UnreferencedElement,
    ELEMENT_TYPE,
    SyntaxError
} = require('./element');
const {
    Operator,
    AndOperator,
    OrOperator,
    NotOperator,
    ConditionalOperator,
    BiconditionalOperator,
    EqualityOperator,
    ForAllOperator,
    ExistsOperator,
} = require('./operator');

/**
 * Create a new scope for variable tracking.
 *
 * Improvements over the original Proxy-based implementation:
 *   - Captures parentScope once at construction time rather than calling
 *     ref.parent?.scope[prop] on every property access (which also crashed
 *     when ref was undefined, as in scoped OperatorSentences).
 *   - Uses Object.create(null) to avoid Object.prototype pollution.
 *   - Removes the unnecessary function-binding branch (scope values are
 *     always VariableSym objects, never functions).
 *   - Removes the unused ownKeys trap.
 *
 * @param {Sentence} ref Reference to the owning sentence
 */
function scope(ref) {
    const own = Object.create(null);
    return new Proxy(own, {
        get(target, prop) {
            if (typeof prop !== 'string') return undefined;
            if (prop in own) return own[prop];
            // Lazily read ref.parent?.scope so that callers can assign the
            // parent's scope after creating child scope (as the tests do).
            // Using full optional chaining on ref so that scope() called
            // without an argument (scoped operators) does not throw.
            return ref.parent?.scope?.[prop];
        },
        set(target, prop, newValue) {
            if (typeof prop === 'string' && !(prop in own)) own[prop] = newValue;
            return true;
        },
    });
}

/**
 * A variable symbol, tracked at the scope level
 */
class VariableSym extends ReferencedElement {
    get $TYPE() {
        return ELEMENT_TYPE.VARIABLE;
    }

    static #TYPES = new Set([NodeType.ROW_VARIABLE, NodeType.VARIABLE]);
    get nodeTypes() { return VariableSym.#TYPES; }
}

/**
 * Represents a sentence in the grammar (or multiple symbols encapsulated by parenthesis)
 */
class Sentence extends UnreferencedElement {
    get $TYPE() {
        return ELEMENT_TYPE.SENTENCE;
    }

    static #TYPES = new Set([NodeType.LIST]);
    get nodeTypes() { return Sentence.#TYPES; }

    /**
     * The terms of the sentence
     * @type {Element[]}
     */
    terms = [];

    /**
     * @param {ASTListNode} node
     * @param {Sentence|null} parent
     */
    constructor(node, parent = null) {
        super(node, parent);
        /**
         * Track variable scoping
         * @type {{[symbol: string]: VariableSym}}
         */
        this.scope = parent?.scope || scope(this);
    }

    /**
     * The max number of terms in the sentence
     * @returns {number}
     */
    get arity() {
        return Infinity;
    }

    /**
     * Child nodes from base ASTNode
     * @returns {ASTNode[]}
     */
    get childNodes() {
        return this.node.children;
    }

    /**
     * Get the total number of nodes, irrespective of sentence type
     * @returns {number}
     */
    get length() {
        return this.node.children.length;
    }

    /**
     * Add a variable to the sentence scope
     * @param {ASTNode} node 
     */
    inScope(node) {
        if (node.type != NodeType.VARIABLE && node.type != NodeType.ROW_VARIABLE) {
            throw new SyntaxError(node, "Variable term must be either a variable or row variable");
        }
        const name = node.startToken.value;
        // Check if variable is in scope, create if not
        /** @type {VariableSym} */
        let sym = new VariableSym(node.startToken.value);
        this.scope[node.startToken.value] = sym;
        this.scope[node.startToken.value].ref(this, node);
        return this.scope[node.startToken.value];
    }   

    /**
     * Add a new term to the sentence, error if the term exceeds the max arity
     * @param {ASTNode} node The node that it came from
     * @param {Element} newTerm The new term
     */
    addTerm(node, newTerm) {
        if (this.terms.length == 0 && newTerm instanceof Sentence) {
            throw new SyntaxError(node, "Invalid first term, cannot be a sentence")
        }
        this.terms.push(newTerm);
        if (this.terms.length > this.arity) {
            throw new SyntaxError(node, `Addition of the term exceeds the arity of the sentence`)
        }
    }

    /**
     * Dereference all references to this Sentence 
     * This method should be called before removing a Sentence
     * from a scope
     * @param {Sentence|null} parent The parent sentence (null if root)
     */
    deref(parent) {
        super.deref(parent);
        // Call deref on all the terms below it
        this.terms.forEach(t => t.deref(this));
    }
}

const _operatorMapping = {
    "and": AndOperator,
    "or": OrOperator,
    "not": NotOperator,
    "equal": EqualityOperator,
    "forall": ForAllOperator,
    "exists": ExistsOperator,
    "=>": ConditionalOperator,
    "<=>": BiconditionalOperator
};

/**
 * A special type of sentence where the first term is an operator
 */
class OperatorSentence extends Sentence {
    /**
     * Create a new OperatorSentence based on the operator
     * @param {ASTListNode} node
     * @param {Sentence|null} parent
     * @returns {OperatorSentence}
     */
    static new(node, parent) {
        const operator = node.children[0].startToken.value; 
        if (!(operator in _operatorMapping)) {
            throw new SyntaxError(node, `Unknown operator: ${node.children[0].startToken.value}`);
        }
        const op = _operatorMapping[operator];
        return new OperatorSentence(op, node, parent);
    }

    /**
     * The terms of the sentence
     * @type {[Operator, ...Sentence[]]}
     */
    terms = [];

    /**
     * @param {Operator} operator
     * @param {ASTListNode} node
     * @param {Sentence} parent
     */
    constructor(operator, node, parent) {
        super(node, parent);
        /** @type {Operator} */
        this.op = operator;
        this.op.ref(this, node.children[0]);
        this.terms.push(operator); // operator lives at terms[0] so lookup can see it
        // Pre-slice once so the childNodes getter doesn't allocate on every call.
        this._childNodes = node.children.slice(1);

        if (this.op.scoped) {
            // If the operator introduces a new scope, create a new scope
            this.scope = scope(this);
        }
    }

    get arity() {
        return this.op.arity;
    }

    /**
     * Child nodes from base ASTNode
     * @returns {ASTNode[]}
     */
    get childNodes() {
        return this._childNodes;
    }
    
    /**
     * Override addTerm to skip the Sentence.addTerm first-term restriction
     *  (operator sentences legitimately start with a Sentence), enforce arity,
     *  and for scoped operators validate the variable-list first argument.
     *  terms[0] is always the Operator; argCount = terms.length - 1.
     * @param {ASTNode} node The node that it came from
     * @param {Element} term
     */
    addTerm(node, term) {
        this.terms.push(term);
        const argCount = this.terms.length - 1; // exclude the operator at terms[0]
        if (argCount > this.arity) {
            this.terms.pop();
            throw new SyntaxError(node, `Addition of the term exceeds the arity of the sentence`);
        }

        if (!this.op.scoped) return;

        if (argCount === 1) {
            const firstTerm = this.terms[1]; // terms[0] is the operator
            if (!(firstTerm instanceof Sentence) || !firstTerm.terms.every(t => t instanceof VariableSym)) {
                throw new SyntaxError(node, "Invalid first term, must be a sentence comprised only of variables");
            }
        }
        //  else if (!this.terms.slice(1).every(t => t instanceof Sentence)) {
        //     this.terms.pop(this.terms.findIndex(t => !(t instanceof Sentence)));
        //     throw new SyntaxError(node, "Quantifiers must be comprised of sentences");
        // }
    }
}

module.exports = {
    Sentence,
    OperatorSentence,
    VariableSym,
    scope,
};