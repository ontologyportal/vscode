const {NodeType, ASTNode} = require("./parser");
const { SemanticStatement } = require("./semantics");

class SyntaxError extends Error {
    /**
     *
     * @param {ASTNode} node The node where the error occurred
     * @param {string} message The error
     */
    constructor(node, message) {
        const file = node.startToken.file;
        const lineStart = node.startToken.line;
        const colStart = node.startToken.column;

        super(`[${file}:${lineStart}:${colStart}] Syntax Error: ${message}`)
        this.name = this.constructor.name;
        this.file = file;
        this.lineStart = lineStart;
        this.lineEnd = node.endToken ? node.endToken.line : lineStart + 1;
        this.colStart = colStart;
        this.colEnd = node.endToken ? node.endToken.column : colStart + 1;
        this.details = message;
    }
}

const ELEMENT_TYPE = {
    OPERATOR: 1,
    SENTENCE: 2,
    SYMBOL: 3,
    LITERAL: 4,
    VARIABLE: 5,
}

/** Base class for everything in KIF language */
class Element {
    /**
     * Forward reference to the parsed 
     * @type {SemanticStatement}
     */
    forward;

    /** @returns {ELEMENT_TYPE} */
    get $TYPE() {
        throw new Error("Inheritting classes must override $TYPE getter");
    }

    /** Dereference element, individual classes can override
     * @param {Sentence}
     */
    deref(_) { return; }
}

/**
 * An abstract class which extends Element, this represents all
 *  elements which have multiple copies and are referenced in multiple places
 */
class ReferencedElement extends Element {
    /** @returns {NodeType[]} */
    get nodeTypes() {
        throw new Error("A NodeType must be defined by a ReferencedElement");
    };

    /**
     * References to all sentences that use this Element.
     *  When empty, the symbol gets deleted
     * @type {Map<Element, ASTNode[]>}
     */
    references = new Map();

    /** @param {string} name */
    constructor(name) {
        super();
        /** Element name
         * @type {string}
         */
        this.name = name;
    }

    /**
     * Dereference the symbol
     * @param {Element} parent The sentence parent that is calling this 
     */
    deref(parent) {
        // When the symbol is derefed, remove the parent 
        //  from its references
        this.references.delete(parent);
    }

    /**
     * Add a new reference
     * @param {Element} reference 
     * @param {ASTNode} node 
     */
    ref(reference, node) {
        if (!this.nodeTypes.has(node.type)) {
            throw new Error("Cannot parse NodeType for " + this.constructor.name);
        }
        if (this.references.has(reference))
            this.references.get(reference).push(node);
        else
            this.references.set(reference, [node]);
    }
}

/**
 * UnreferencedElements are elements which are not referenced multiple times
 *  and appear as they are in the document
 */
class UnreferencedElement extends Element {
    /** @returns {NodeType[]} */
    get nodeTypes() {
        throw new Error("A NodeType must be defined by a UnreferencedElement");
    };

    /**
     * @param {ASTNode} node The node that this is derived from
     * @param {Element|null} parent Point to the parent element
     */
    constructor(node, parent = null) {
        super();

        if (!this.nodeTypes.has(node.type)) {
            throw new Error("Provided node does not match expected NodeType: " + this.constructor.name);
        }

        /** @type {ASTNode} */
        this.node = node;

        /** @type {Element|null} */
        this.parent = parent;
    }

    /**
     * Remove parent reference, guard against bad dereferences
     * @param {Element|null} parent The parent sentence (null if root)
     */
    deref(parent) {
        if (this.parent !== parent) 
            throw new Error("Unable to dereference the sentence, incorrect parent provided");
        this.parent = null;
    }
}

module.exports = {
    ELEMENT_TYPE,
    Element,
    ReferencedElement,
    UnreferencedElement,
    SyntaxError
}