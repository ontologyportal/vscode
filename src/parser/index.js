/**
 * SUMO Parser Module
 */
const {readFileSync} = require("fs");
const {
    TokenType,
    tokenize,
    TokenizerError
} = require('./tokenizer');
const {
    NodeType,
    ASTNode,
    ASTListNode,
    ASTTermNode,
    TokenList,
    ParsingError
} = require('./parser');
const {
    Term,
    TaxonomyEdge,
    SemanticError,
} = require('./term');
const {
    Symbol,
    ValueLiteral,
    SymbolTable,
    syntax
} = require('./symbol');
const {
    SyntaxError
} = require('./element');
const {
    Sentence,
    OperatorSentence,
    VariableSym
} = require('./sentence');
const {
    Operator,
    AndOperator,
    OrOperator,
    NotOperator,
    ConditionalOperator,
    BiconditionalOperator,
    EqualityOperator,
    ForAllOperator,
    ExistsOperator
} = require('./operator');

/**
 * Caller function for processing semantics of a
 * populated symbol table
 * @param {SymbolTable} symbolTable
 * @returns {{terms: Map<Symbol, Term>, errors: SemanticError[]}} An array of terms wrapping symbols
 */
function semantics(symbolTable) {
    const errors = [];
    const terms = new Map();
    // Single pass: construct each Term (which registers symbol.forward as a
    // side-effect) and immediately capture it in the map.  The old code iterated
    // symbols twice — once to build Terms via side-effects, once to read .forward.
    for (const sym of Object.values(symbolTable.symbols)) {
        try {
            const term = new Term(sym);
            terms.set(sym, term);
        } catch (e) {
            errors.push(e);
        }
    }
    return {terms, errors};
}

/** 
 * Conveniance function for producing (or updating) a symbol table
 *  for a KIF file
 * @param {string} contents
 * @param {string} file Name of the source file
 * @param {SymbolTable | undefined} symbolTable
 * @returns {{symbolTable: SymbolTable, errors: Error[]}}
 */
function kif(contents, file = "inline", symbolTable = undefined) {
    let errors;
    const {tokens, errors: tokenErrors} = tokenize(contents, file);
    errors = tokenErrors;
    const {nodes, errors: parseErrors} = (new TokenList(tokens, file)).parse();
    errors = errors.concat(parseErrors);
    const { symbolTable: newSymbolTable, errors: syntaxErrors } = syntax(nodes, symbolTable);
    errors = errors.concat(syntaxErrors);
    return { symbolTable: newSymbolTable, errors };
}

/** 
 * Conveniance function for producing (or updating) a symbol table
 *  for a KIF file
 * @param {string} file
 * @param {SymbolTable | undefined} symbolTable
 * @returns {{symbolTable: SymbolTable, errors: Error[]}}
 */
function kifFile(file, symbolTable = undefined) {
    const contents = readFileSync(file, "utf-8");
    // Bug fix: was calling kif(contents, symbolTable) which passed symbolTable
    // as the `file` argument, and discarded the return value entirely.
    return kif(contents, file, symbolTable);
}

module.exports = {
    TokenType,
    tokenize,
    NodeType,
    ASTNode,
    ASTListNode,
    ASTTermNode,
    TokenList,
    ParsingError,
    TokenizerError,
    Sentence,
    OperatorSentence,
    Symbol,
    VariableSym,
    ValueLiteral,
    SymbolTable,
    SyntaxError,
    syntax,
    Term,
    TaxonomyEdge,
    SemanticError,
    semantics,
    Operator,
    AndOperator,
    OrOperator,
    NotOperator,
    ConditionalOperator,
    BiconditionalOperator,
    EqualityOperator,
    ForAllOperator,
    ExistsOperator, 
    kif,
    kifFile
};
