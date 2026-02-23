/**
 * SUMO Parser
 * Parses tokenized SUMO into an Abstract Syntax Tree (AST)
 * This is used by the extension to performn symbol lookup
 */

const { TokenType, Token } = require('./tokenizer');

class ParsingError extends Error {
    /**
     * @param {string|undefined} file The file where the error occurred
     * @param {number} line The start offset of the bad string
     * @param {number} column The end offset of the bad string
     * @param {string} error The error string
     * @param {string|undefined} range An optional line to show with the bad string 
     */
    constructor(file, line, column, error, range) {
        super(`[${file ? file + ':' : ''}${line}:${column}]`);
        /** @type {number} */
        this.line = line;
        /** @type {number} */
        this.column = column;
        /** @type {string} */
        this.error = error;
        /** @type {string|undefined} */
        this.range = range;
        /** @type {string|undefined} */
        this.file = file;
    
        this.name = this.constructor.name;
    }
}

const NodeType = {
    LIST: 'list',
    ATOM: 'atom',
    STRING: 'string',
    NUMBER: 'number',
    VARIABLE: 'variable',
    ROW_VARIABLE: 'row_variable'
};

const termNodeTypes = [
    NodeType.ATOM,
    NodeType.STRING,
    NodeType.NUMBER,
    NodeType.VARIABLE,
    NodeType.ROW_VARIABLE
];

/**
 * Track AST Nodes
 */
class ASTNode {
    /**
     * @param {NodeType} type The type of node to create
     * @param {Token} token The token to generate the node from
     */
    constructor(type, token) {
        /** @type {NodeType} */
        this.type = type;
        /**
         * The start token
         * @type {Token}
         */
        this.startToken = token;
        /**
         * Where the node starts
         * @type {{line: number, col: number, offset: number}}
         */
        this.start = { line: token.line, col: token.column, offset: token.offset };
        /** @type {string} */
        this.file = token.file;
    }
}

class ASTListNode extends ASTNode {
    /**
     * @param {NodeType} type The type of node to create
     * @param {Token} token The token to generate the node from
     */
    constructor(token) {
        super(NodeType.LIST, token);
        /** @type {ASTNode[]} */
        this.children = [];
        /**
         * The end token (if null, a single token node)
         * @type {Token|null}
         */
        this.endToken = null;
        /**
         * Where the node ends, set to null initially
         * @type {{line: number, col: number, offset: number}|null}
         */
        this.end = null;
    }

    /**
     * Set the end token
     * @param {Token} token 
     */
    setEnd(token) {
        this.endToken = token;
        this.end = { line: token.line, col: token.column + 1, offset: token.offset + 1 };
    }

    /**
     * Get the head (first element) of a list node
     * @returns {ASTNode|null} Head node or null
     */
    getHead() {
        if (this.children.length > 0) {
            return this.children[0];
        }
        return null;
    }
}

/**
 * A node representing a term in a statement
 */
class ASTTermNode extends ASTNode {
    /**
     * @param {NodeType} type The type of node to create (must be a value Term Node type)
     * @param {Token} token The token to generate the node from
     */
    constructor(type, token) {
        if (!termNodeTypes.includes(type))
            throw new Error("Cannot create ASTTermNode from non-term node");
        super(type, token);
    }
    /**
     * Get the value of an atom/variable node
     * @returns {string} Value or null
     */
    getValue() {
        return this.startToken.value;
    }
}

/**
 * Represent a list of tokens used for parsing
 */
class TokenList {
    /**
     * Constructor for a new token list for parsing
     * @param {Token[]} tokens The tokenized list
     * @param {string} [document] The source document (optional)
     */
    constructor(tokens, document) {
        /** @type {Token[]} token list */
        this.tokens = tokens;
        /** @type {number} point to the current token being parsed */
        this.current = 0;
        /** @type {string|undefined} */
        this.document = document;
    }

    /**
     * Get the current token
     * @returns {Token}
     */
    cursor() {
        return this.tokens[this.current];
    }

    /**
     * Whether the cursor has ended the token list
     * @returns {boolean}
     */
    end() {
        return this.current >= this.tokens.length;
    }

    /**
     * Walk the token list
     * @returns {ASTNode} The ASTNode created from the token
     */
    walk() {
        // If you've finished the token list, finish with null
        if (this.end()) {
            throw Error("Called walk on an empty token list");
        }

        // Get the current token
        const token = this.cursor();

        // If you hit the left parenthsis, create a new node with the next token
        if (token.type === TokenType.LPAREN) {
            this.current++;
            const node = new ASTListNode(token);

            while (!this.end() && this.cursor().type !== TokenType.RPAREN) {
                // Go until the next right parenthesis, walk should consume the appropriate right parenthesis
                const child = this.walk();
                if (child) node.children.push(child);
            }

            // Check for unclosed parenthesis
            if (this.end()) {
                throw new ParsingError(
                    node.startToken.file,
                    node.start.line,
                    node.start.col,
                    'Unclosed parenthesis'
                );
            }

            // Get the end of the node
            node.setEnd(this.cursor());
            // Consume the )
            this.current++;
            return node;
        }

        // This should never be hit as matching parenthesis should be consumed by the LPAREN check
        if (token.type === TokenType.RPAREN) {
            // Throw error
            throw new ParsingError(
                token.file,
                token.line,
                token.column,
                'Dangling right parenthesis'
            );
        }

        // Determine node type from token type
        let nodeType = NodeType.ATOM;
        if (token.type === TokenType.STRING) nodeType = NodeType.STRING;
        else if (token.type === TokenType.NUMBER) nodeType = NodeType.NUMBER;
        else if (token.type === TokenType.VARIABLE) nodeType = NodeType.VARIABLE;
        else if (token.type === TokenType.ROW_VARIABLE) nodeType = NodeType.ROW_VARIABLE;

        this.current++; // Iterate the pointer

        return new ASTTermNode(
            nodeType,
            token
        );
    }

    /**
     * Parse tokens into an AST
     * @returns {ASTNode[]} Array of AST nodes (top-level expressions)
     */
    parse(restart = true) {
        if (restart) this.current = 0;
        /** @type {ASTNode[]} */
        const nodes = [];
        while (this.current < this.tokens.length) {
            const node = this.walk();
            if (node) nodes.push(node);
        }
        return nodes;
    }
}

// /**
//  * Collect all free variables in a formula
//  * @param {ASTNode} node - AST node
//  * @param {Set} boundVars - Set of currently bound variables
//  * @returns {Set} Set of free variable names
//  */
// function collectFreeVariables(node, boundVars = new Set()) {
//     const freeVars = new Set();

//     /**
//      * 
//      * @param {ASTNode} n The node 
//      * @param {Set<Token>} bound The bound variables 
//      * @returns 
//      */
//     function visit(n, bound) {
//         if (!n) return;

//         if (n.type === NodeType.VARIABLE || n.type === NodeType.ROW_VARIABLE) {
//             if (!bound.has(n.token)) {
//                 freeVars.add(n.token);
//             }
//         } else if (n.type === NodeType.LIST && n.children.length > 0) {
//             /** @type {ASTListNode} */
//             const listNode = n;
//             const head = listNode.getHead();
//             if (head.type !== NodeType.LIST) {

//             }
//             const headVal = getValue(head);

//             // Handle quantifiers - they bind variables
//             if (headVal === 'forall' || headVal === 'exists') {
//                 if (n.children.length >= 2 && n.children[1].type === NodeType.LIST) {
//                     const newBound = new Set(bound);
//                     // Add quantified variables to bound set
//                     for (const v of n.children[1].children) {
//                         if (v.type === NodeType.VARIABLE || v.type === NodeType.ROW_VARIABLE) {
//                             newBound.add(v.value);
//                         }
//                     }
//                     // Visit body with extended bound set
//                     for (let i = 2; i < n.children.length; i++) {
//                         visit(n.children[i], newBound);
//                     }
//                     return;
//                 }
//             }

//             // Visit all children with current bound set
//             for (const child of n.children) {
//                 visit(child, bound);
//             }
//         }
//     }

//     visit(node, boundVars);
//     return freeVars;
// }

module.exports = {
    NodeType,
    ASTNode,
    ASTListNode,
    ASTTermNode,
    TokenList,
    ParsingError,
    // collectFreeVariables
};
