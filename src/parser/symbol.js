/**
 * This handles extracting and tracking symbols from an AST
 */

const {
    ASTNode,
    ASTListNode,
    NodeType
} = require("./parser");

const {
    SyntaxError,
    ReferencedElement,
    UnreferencedElement,
    ELEMENT_TYPE
} = require('./element');

const {
    Sentence,
    OperatorSentence,
    VariableSym
} = require('./sentence');

const {
    lookupProxy
} = require('./query');

/**
 * Define the symbol table
 */
class SymbolTable {
    /**
     * Track the epoch so that caches can be
     *  updated if the symbol table changes
     * @type {number}
     */
    #epoch = 0;
    /**
     * The actual symbol table implementation
     * @type {{[symbol: string]: Symbol}}
     */
    symbols = {};
    /**
     * All sentences that the symbols here 
     * are involved int
     * @type {Set<Sentence>}
     */
    sentences = new Set();
    /**
     * A proxy to handle queries to the symbol table
     * @type {Proxy}
     */
    lookup = new Proxy(this.sentences, lookupProxy);
    /**
     * Did someone open the box and look at the cat?
     * Only increment epoch if someone has looked
     * @type {boolean}
     */
    cat = false;

    get epoch() {
        this.cat = true;
        return this.#epoch;
    }

    set epoch(value) {
        if (this.cat) {
            this.cat = false;
            this.#epoch = value;
        }
    }

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
    static new(nodes, symbolTable = undefined) {
        const errors = [];
        const sentences = [];
        symbolTable = symbolTable || new SymbolTable();
        for (const node of nodes) {
            if (!(node instanceof ASTListNode)) {
                errors.push(new SyntaxError(node, "Expected a sentence for an outermost term, found a symbol"));
                continue;
            }
            try {
                sentences.push(symbolTable.sentence(node, null));
            } catch (e) {
                errors.push(e);
            }
        }
        return { syntax: sentences, errors, symbolTable };
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
        // Grab the token name
        const name = node.startToken.value;
        // If the token is not in the symboltable, add it
        if (!(name in this.symbols))
            this.symbols[name] = new Symbol(name, this);
        // Grab the token
        /** @type {Symbol} */
        const sym = this.symbols[name];
        // Add the referenced file to the symbol
        sym.ref(reference, node);
        // Increment the epoch
        this.epoch = this.#epoch + 1;
        return sym;
    }

    /**
     * Remove a symbol from the symboltable, if there are still 
     *  references to the symbol, throw an error (unless force 
     *  is set to true)
     * @param {Symbol} symbol The symbol to delete
     * @param {boolean} force Whether to force removal even if there
     *  are outstanding references
     */
    delete(symbol, force = false) {
        if (symbol.references.size > 0 && !force) {
            throw new Error("Error, cannot delete symbol with references");
        }
        if (symbol.name in this.symbols) {
            delete this.symbols[symbol.name];
            // Increment the epoch
            this.epoch = this.#epoch + 1;
        }
    }

    /**
     * Process a new node list as a sentence in the 
     *  context of the current symboltable
     * @param {ASTNode} node The node to parse
     * @param {Sentence | null} parent The parent node to this one
     * @return {Sentence} The new sentence
     */
    sentence(node, parent = null) {
        if (node.type != NodeType.LIST || !(node instanceof ASTListNode)) {
            throw new SyntaxError(node, "Sentences must be derived from a list node");
        }
        if (node.children.length === 0) {
            throw new SyntaxError(node, "Empty sentence is not valid KIF");
        }
        let newSentence;
        if (node.children[0]?.type === NodeType.OPERATOR) {
            newSentence = OperatorSentence.new(node, parent);
        }
        else {
            newSentence = new Sentence(node, parent);
        }
        for (const child of newSentence.childNodes) {
            let childTerm;
            switch (child.type) {
                case NodeType.ATOM :
                    childTerm = this.symbol(child, newSentence);
                    break;
                case NodeType.LIST :
                    childTerm = this.sentence(child, newSentence);
                    break;
                case NodeType.STRING :
                case NodeType.NUMBER :
                    childTerm = new ValueLiteral(child, newSentence);
                    break;
                case NodeType.ROW_VARIABLE :
                case NodeType.VARIABLE :
                    childTerm = newSentence.inScope(child);
                    break;
                case NodeType.OPERATOR :
                    throw new SyntaxError(child, "Operator appears outside of first sentence term");
            }
            // Now add the new term to the sentence
            newSentence.addTerm(child, childTerm);
        }
        // Only add the sentence to the symboltable if its a root
        if (!newSentence.parent)
            this.sentences.add(newSentence);
    
        // increment the epoch 
        this.epoch = this.#epoch + 1;

        return newSentence;
    }

    /**
     * Remove every reference contributed by `file` from all symbols.
     * Symbols that have no remaining references in any file are also
     * removed from the table entirely.
     * @param {string} file The file path to remove
     */
    removeFile(file) {
        // Iterate through all the sentences and throw out the ones with
        //  that file
        // The deref function will take care of handling the attached
        //  symbols
        this.sentences.forEach(s => {
            if (s.node.file === file) {
                s.deref(null); // root sentences have parent === null
                this.sentences.delete(s);
                // Increment the epoch
                this.epoch = this.#epoch + 1;
            }
        });
    }
}

/**
 * Parse a list of AST nodes into a symbol table.
 * Convenience wrapper around SymbolTable.new.
 * @param {import('./parser').ASTNode[]} nodes
 * @param {SymbolTable} [symbolTable]
 * @returns {{ syntax: Sentence[], errors: import('./element').SyntaxError[], symbolTable: SymbolTable }}
 */
function syntax(nodes, symbolTable) {
    return SymbolTable.new(nodes, symbolTable);
}

/**
 * Track literal values
 */
class ValueLiteral extends UnreferencedElement {
    /** @returns {ELEMENT_TYPE} */
    get $TYPE() {
        return ELEMENT_TYPE.LITERAL;
    }

    static #TYPES = new Set([NodeType.STRING, NodeType.NUMBER]);
    get nodeTypes() { return ValueLiteral.#TYPES; }

    get value() {
        return this.node.startToken.value
    }
}

/**
 * Track symbols (basically every non parenthesis or literal)
 */
class Symbol extends ReferencedElement {
    get $TYPE() {
        return ELEMENT_TYPE.SYMBOL;
    }

    static #TYPES = new Set([NodeType.ATOM]);
    get nodeTypes() { return Symbol.#TYPES; }

    /**
     * @param {string} name
     * @param {SymbolTable} symbolTable A reference to the symbol table this symbol belongs to
     */
    constructor(name, symbolTable) {
        super(name);
        /**
         * The symbol table this symbol belongs to
         * @type {SymbolTable}
         */
        this.symbolTable = symbolTable;
    }

    /**
     * Dereference the symbol
     * @param {Element} parent The sentence parent that is calling this 
     */
    deref(parent) {
        super.deref(parent);
        // If the symbol has no more references, remove the symbol
        //  from the symboltable
        if (this.references.size === 0)
            this.symbolTable.delete(this);
    }
}

module.exports = {
    Symbol,
    ValueLiteral,
    SymbolTable,
    syntax,
}
