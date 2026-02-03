/**
 * SUO-KIF Parser
 * Parses tokenized SUO-KIF into an Abstract Syntax Tree (AST)
 * This is used by the extension to performn symbol lookup
 */

const { TokenType } = require('./tokenizer');

const NodeType = {
    LIST: 'list',
    ATOM: 'atom',
    STRING: 'string',
    NUMBER: 'number',
    VARIABLE: 'variable',
    ROW_VARIABLE: 'row_variable'
};

/**
 * Parse tokens into an AST
 * @param {Array} tokens - Array of tokens from tokenizer
 * @param {Object} options - Optional parsing options
 * @returns {Array} Array of AST nodes (top-level expressions)
 */
function parse(tokens, options = {}) {
    let current = 0;
    const diagnostics = options.diagnostics || [];
    const document = options.document;

    function positionAt(offset) {
        if (document && document.positionAt) {
            return document.positionAt(offset);
        }
        return { line: 0, character: offset };
    }

    function createRange(start, end) {
        if (options.createRange) {
            return options.createRange(start, end);
        }
        return { start: positionAt(start), end: positionAt(end) };
    }

    function walk() {
        if (current >= tokens.length) return null;

        const token = tokens[current];

        if (token.type === TokenType.LPAREN) {
            current++;
            const node = {
                type: NodeType.LIST,
                children: [],
                start: token.offset
            };

            while (current < tokens.length && tokens[current].type !== TokenType.RPAREN) {
                const child = walk();
                if (child) node.children.push(child);
            }

            // Check for unclosed parenthesis
            if (current >= tokens.length) {
                if (diagnostics && options.reportError) {
                    options.reportError(
                        createRange(node.start, node.start + 1),
                        'Unclosed parenthesis: Expected \')\''
                    );
                }
            }

            node.end = (current < tokens.length) ? tokens[current].offset + 1 : (options.textLength || node.start + 1);
            if (current < tokens.length) current++;
            node.range = createRange(node.start, node.end);
            return node;
        }

        if (token.type === TokenType.RPAREN) {
            current++;
            return null;
        }

        current++;

        // Determine node type from token type
        let nodeType = NodeType.ATOM;
        if (token.type === TokenType.STRING) nodeType = NodeType.STRING;
        else if (token.type === TokenType.NUMBER) nodeType = NodeType.NUMBER;
        else if (token.type === TokenType.VARIABLE) nodeType = NodeType.VARIABLE;
        else if (token.type === TokenType.ROW_VARIABLE) nodeType = NodeType.ROW_VARIABLE;

        return {
            type: nodeType,
            value: token.value,
            range: createRange(token.offset, token.offset + token.value.length)
        };
    }

    const nodes = [];
    while (current < tokens.length) {
        const node = walk();
        if (node) nodes.push(node);
    }
    return nodes;
}

/**
 * Get the head (first element) of a list node
 * @param {Object} node - AST node
 * @returns {Object|null} Head node or null
 */
function getHead(node) {
    if (node.type === NodeType.LIST && node.children.length > 0) {
        return node.children[0];
    }
    return null;
}

/**
 * Get the value of an atom/variable node
 * @param {Object} node - AST node
 * @returns {string|null} Value or null
 */
function getValue(node) {
    if (node && (node.type === NodeType.ATOM || node.type === NodeType.VARIABLE ||
                 node.type === NodeType.ROW_VARIABLE || node.type === NodeType.STRING ||
                 node.type === NodeType.NUMBER)) {
        return node.value;
    }
    return null;
}

/**
 * Collect all free variables in a formula
 * @param {Object} node - AST node
 * @param {Set} boundVars - Set of currently bound variables
 * @returns {Set} Set of free variable names
 */
function collectFreeVariables(node, boundVars = new Set()) {
    const freeVars = new Set();

    function visit(n, bound) {
        if (!n) return;

        if (n.type === NodeType.VARIABLE || n.type === NodeType.ROW_VARIABLE) {
            if (!bound.has(n.value)) {
                freeVars.add(n.value);
            }
        } else if (n.type === NodeType.LIST && n.children.length > 0) {
            const head = n.children[0];
            const headVal = getValue(head);

            // Handle quantifiers - they bind variables
            if (headVal === 'forall' || headVal === 'exists') {
                if (n.children.length >= 2 && n.children[1].type === NodeType.LIST) {
                    const newBound = new Set(bound);
                    // Add quantified variables to bound set
                    for (const v of n.children[1].children) {
                        if (v.type === NodeType.VARIABLE || v.type === NodeType.ROW_VARIABLE) {
                            newBound.add(v.value);
                        }
                    }
                    // Visit body with extended bound set
                    for (let i = 2; i < n.children.length; i++) {
                        visit(n.children[i], newBound);
                    }
                    return;
                }
            }

            // Visit all children with current bound set
            for (const child of n.children) {
                visit(child, bound);
            }
        }
    }

    visit(node, boundVars);
    return freeVars;
}

module.exports = {
    NodeType,
    parse,
    getHead,
    getValue,
    collectFreeVariables
};
