/**
 * This handles extracting and tracking symbols from an AST
 */

const { ASTNode, ASTListNode, NodeType } = require("./parser");

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

class SymbolTable {
    constructor() {
        /**
         * The actual symbol table implementation
         * @type {{[symbol: string]: Symbol}}
         */
        this.symbols = {};
    }

    /**
     * Either add a reference to an existing symbol or create a new one.
     * References are grouped by source file so individual files can be
     * removed and re-added without rebuilding the entire table.
     * @param {ASTNode} node The node to make the symbol from
     * @param {Sentence} reference The containing sentence
     * @returns {Symbol} The symbol
     */
    symbol(node, reference) {
        if (node.type != NodeType.ATOM) {
            throw new SyntaxError(node, "Symbols can only be derived from atoms");
        }
        const name = node.startToken.value;
        const file = node.startToken.file ?? '';

        if (!(name in this.symbols)) {
            this.symbols[name] = new Symbol(name, this);
        }
        const sym = this.symbols[name];
        if (!sym.references.has(file)) {
            sym.references.set(file, []);
        }
        sym.references.get(file).push([reference, node]);
        return sym;
    }

    /**
     * Remove every reference contributed by `file` from all symbols.
     * Symbols that have no remaining references in any file are also
     * removed from the table entirely.
     * @param {string} file The file path to remove
     */
    removeFile(file) {
        for (const [name, sym] of Object.entries(this.symbols)) {
            sym.references.delete(file);
            if (sym.references.size === 0) {
                delete this.symbols[name];
            }
        }
    }
}

/**
 * Track literal values
 */
class ValueLiteral {
    /**
     * @param {ASTNode} node
     */
    constructor(node) {
        /**
         * The value of the literal
         * @type {ASTNode}
         */
        this.node = node;
        if (this.node.type !== NodeType.STRING && this.node.type !== NodeType.NUMBER) {
            throw new SyntaxError(node, "Literal values ust be either a string or number")
        }
    }

    get value() {
        return this.node.startToken.value
    }
}

/**
 * Track symbols (basically every non parenthesis or literal)
 */
class Symbol {
    /**
     * @param {string} name
     * @param {SymbolTable} symbolTable A reference to the symbol table this symbol belongs to
     */
    constructor(name, symbolTable) {
        /**
         * References to all sentences that use this symbol, grouped by source file.
         *
         * Key:   file path (from ASTNode.startToken.file)
         * Value: [Sentence, ASTNode][] in parse order (which is line/column order
         *        since files are parsed top-to-bottom).
         *
         * Grouping by file enables incremental recomputation: when a file changes
         * only that file's entry needs to be removed and re-populated, leaving
         * contributions from all other files intact.
         *
         * To iterate all references regardless of file:
         *   for (const refs of sym.references.values())
         *     for (const [sentence, node] of refs) { ... }
         *
         * @type {Map<string, Array<[Sentence, ASTNode]>>}
         */
        this.references = new Map();
        /**
         * The name of the symbol
         * @type {string}
         */
        this.name = name;
        /**
         * The symbol table this symbol belongs to
         * @type {SymbolTable}
         */
        this.symbolTable = symbolTable;
    }
}

/**
 * A variable symbol, tracked at the scope level
 */
class VariableSym {
    /**
     * The name of the variable
     * @param {string} name
     */
    constructor(name) {
        /**
         * The name of the symbol
         * @type {string}
         */
        this.name = name;
        /** References to all sentences which use this variable (and the node the symbol maps to)
         * @type {Array<[Sentence, ASTNode]>}
         * */
        this.references = [];
    }
}

/**
 * Represents a sentence in the grammar (or multiple symbols encapsulated by parenthesis)
 */
class Sentence {
    /**
     * @param {ASTListNode} node
     * @param {Sentence|null} parent
     */
    constructor (node, parent = null) {
        // fix: removed invalid `super()` call — Sentence has no base class
        /**
         * The terms of the sentence
         * @type {(Symbol|VariableSym|Sentence)[]}
         */
        this.terms = [];
        /**
         * The original node
         * @type {ASTListNode}
         */
        this.node = node;
        /**
         * Track variable scoping
         * @type {{[symbol: string]: VariableSym}}
         */
        this.scope = parent?.scope || {};
        /**
         * Track parent sentence, null indicates root
         * @type {Sentence|null}
         */
        this.parent = parent;
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
     * Process node and its children
     * @param {SymbolTable} symbolTable
     */
    processTerms(symbolTable) { // fix: renamed from `terms` to avoid collision with `this.terms` property
        for (const node of this.childNodes) {
            this.addTerm(node, symbolTable);
        }
    }

    /**
     * Add a new term to the sentence, error if the term exceeds the max arity
     * @param {ASTNode} node The node that it came from
     * @param {SymbolTable} symbolTable
     */
    addTerm(node, symbolTable) {
        const newTerm = term(node, this, symbolTable);
        this.terms.push(newTerm);
        if (this.terms.length > this.arity) {
            throw new SyntaxError(node, `Addition of the term exceeds the arity of the sentence`)
        }
    }
}

/**
 * Represents a sentence where the first term is assumed to be the functional term
 */
class FunctionalSentence extends Sentence  {
    /**
     * @param {ASTListNode} node
     * @param {Sentence|null} parent
     */
    constructor(node, parent = null) {
        super(node, parent);
        /**
         * The functional term (i.e. first term)
         * @type {Symbol}
         */
        this.functionalTerm = null;
    }

    /**
     * Override addTerm so that the first term does not affect arity
     * @param {ASTNode} node The node that it came from
     * @param {SymbolTable} symbolTable
     */
    addTerm(node, symbolTable) {
        // fix: was `this.terms.length === 0`, which never advanced because the functional term
        // is stored in `this.functionalTerm` rather than pushed to `this.terms`, causing every
        // subsequent term to also be treated as the head and overwrite it.
        if (this.functionalTerm === null) {
            const newTerm = term(node, this, symbolTable);
            if (newTerm instanceof Sentence) {
                throw new SyntaxError(node, "Invalid first term, cannot be a sentence")
            }
            this.functionalTerm = newTerm;
        } else {
            super.addTerm(node, symbolTable);
        }
    }
}

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
        // fix: each case now returns directly, removing fall-through and the undeclared `sentence` variable
        switch (node.children[0].startToken.value) {
            case "and":    return new AndSentence(node, parent);
            case "or":     return new OrSentence(node, parent);
            case "not":    return new NotSentence(node, parent);
            case "equal":  return new EqualitySentence(node, parent);
            case "=>":     return new ConditionalSentence(node, parent);
            case "<=>":    return new BiconditionalSentence(node, parent);
            case "forall": return new ForAllSentence(node, parent);
            case "exists": return new ExistsSentence(node, parent);
            default:
                throw new SyntaxError(node, `Unknown operator: ${node.children[0].startToken.value}`);
        }
    }

    /**
     * Child nodes from base ASTNode
     * @returns {ASTNode[]}
     */
    get childNodes() {
        // Skip the first node because it's the operator
        return this.node.children.slice(1);
    }
}

// fix: extend OperatorSentence (not Sentence) so the childNodes override is inherited
class BinaryOperatorSentence extends OperatorSentence {
    get arity() {
        return 2;
    }
}

class AndSentence extends OperatorSentence {};
class OrSentence extends OperatorSentence {};
class NotSentence extends OperatorSentence {
    get arity() {
        return 1;
    }
};
class ConditionalSentence extends BinaryOperatorSentence {};
class BiconditionalSentence extends BinaryOperatorSentence {};
class EqualitySentence extends BinaryOperatorSentence {};

class QuantifierOperatorSentence extends BinaryOperatorSentence {
    /**
     * @param {ASTListNode} node
     * @param {Sentence|null} parent
     */
    constructor (node, parent = null) {
        super(node, parent);
        // Since forall and exists can introduce a new scope of variables,
        //  create a new scope, copying everything from the parent scope
        this.scope = {...this.scope};
    }

    /**
     * Override addTerm to enforce first sentence is a sentence comprised only of variables
     * @param {ASTNode} node The node that it came from
     * @param {SymbolTable} symbolTable
     */
    addTerm(node, symbolTable) { // fix: corrected parameter order to match base class signature
        super.addTerm(node, symbolTable);
        if (this.terms.length === 1) {
            const firstTerm = this.terms[0]; // fix: renamed to avoid shadowing the `term` function
            if (!(firstTerm instanceof Sentence) || !(firstTerm.terms.every(t => t instanceof VariableSym))) {
                throw new SyntaxError(node, "Invalid first term, must be a sentence comprised only of variables");
            }
        } else if (!(this.terms.every(t => t instanceof Sentence))) {
            throw new SyntaxError(node, "Quantifiers must be comprised of sentences");
        }
    }
}

class ForAllSentence extends QuantifierOperatorSentence {};
class ExistsSentence extends QuantifierOperatorSentence {};

/**
 * Parse a list of nodes into a valid syntax tree
 * @param {ASTNode[]} nodes A list of ASTNodes
 * @param {SymbolTable|undefined} symbolTable Optional symbol table, otherwise a new one will be used
 * @returns {{
 *  errors: SyntaxError[],
 *  syntax: Sentence[],
 *  symbolTable: {[symbol: string]: Symbol}
 * }} A list of syntactically validated sentences
 */
function syntax(nodes, symbolTable = undefined) {
    const errors = [];
    const sentences = [];
    symbolTable = symbolTable || new SymbolTable();
    for (const node of nodes) {
        if (!(node instanceof ASTListNode)) {
            errors.push(new SyntaxError(node, "Expected a sentence for an outermost term, found a symbol"));
            continue;
        }
        try {
            sentences.push(sentence(node, null, symbolTable));
        } catch (e) {
            errors.push(e);
        }
    }
    return { syntax: sentences, errors, symbolTable };
}

/**
 * A generic method to handle parsing a term, decides whether to call sentence or symbol
 * @param {ASTNode} node
 * @param {Sentence} parent The parent sentence
 * @param {SymbolTable} symbolTable
 * @returns {Sentence | Symbol | VariableSym | ValueLiteral}
 */
function term(node, parent, symbolTable) {
    if (node.type == NodeType.LIST) {
        return sentence(node, parent, symbolTable);
    } else if (node.type == NodeType.VARIABLE || node.type == NodeType.ROW_VARIABLE) {
        return variable(node, parent, symbolTable); // fix: pass parent
    } else if (node.type == NodeType.ATOM) {
        return symbol(node, parent, symbolTable); // fix: pass parent
    } else {
        return new ValueLiteral(node);
    }
}

/**
 * Convert a list node to a Sentence
 * @param {ASTListNode} node The list node to convert to a Sentence
 * @param {Sentence|null} parent The parent sentence
 * @param {SymbolTable} symbolTable Symbol table
 * @returns {Sentence} The sentence
 */
function sentence(node, parent, symbolTable) {
    if (node.children.length === 0) { // fix: guard against empty list nodes
        throw new SyntaxError(node, "Empty sentence");
    }
    let s;
    if (node.children[0].type !== NodeType.OPERATOR) {
        s = new FunctionalSentence(node, parent);
    } else {
        s = OperatorSentence.new(node, parent); // fix: capture the returned sentence
    }
    s.processTerms(symbolTable); // fix: renamed method
    return s;
}

/**
 * Convert a node to a Symbol
 * @param {ASTNode} node The node to convert to a Symbol
 * @param {Sentence} parent The parent sentence
 * @param {SymbolTable} symbolTable Symbol table
 * @returns {Symbol} The new symbol
 */
function symbol(node, parent, symbolTable) {
    if (node.type != NodeType.ATOM) {
        throw new SyntaxError(node, "Symbols can only be derived from atoms"); // fix: add `new`
    }
    // Check to see if the symbol exists in the symbol table
    return symbolTable.symbol(node, parent);
}

/**
 * Convert a node to a VariableSym
 * @param {ASTNode} node The node to convert to a VariableSym
 * @param {Sentence} parent The parent sentence
 * @param {SymbolTable} _symbolTable Symbol table
 * @returns {VariableSym} The new variable
 */
function variable(node, parent, _symbolTable) {
    if (node.type != NodeType.VARIABLE && node.type != NodeType.ROW_VARIABLE) {
        throw new SyntaxError(node, "Variables must be derived from variable tokens"); // fix: add `new`
    }
    // Check if variable is in scope, create if not
    if (node.startToken.value in parent.scope) {
        const sym = parent.scope[node.startToken.value];
        sym.references.push([parent, node]);
        return sym;
    } else {
        const sym = new VariableSym(node.startToken.value);
        parent.scope[node.startToken.value] = sym;
        sym.references.push([parent, node]);
        return sym;
    }
}

module.exports = {
    syntax,
    SymbolTable,
    Symbol,
    VariableSym,
    ValueLiteral,
    Sentence,
    FunctionalSentence,
    OperatorSentence,
    BinaryOperatorSentence,
    QuantifierOperatorSentence,
    AndSentence,
    OrSentence,
    NotSentence,
    ConditionalSentence,
    BiconditionalSentence,
    EqualitySentence,
    ForAllSentence,
    ExistsSentence,
    SyntaxError,
}
