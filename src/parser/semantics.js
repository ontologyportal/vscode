/**
 * Semantic analysis for SUMO knowledge bases.
 *
 * Takes a SymbolTable produced by symbol.js and interprets the sentence
 * references attached to each Symbol to build high-level Term objects with
 * documentation, format strings, and a taxonomy graph.
 *
 * SUMO predicate conventions used here:
 *   (documentation  TermName Language "text")
 *   (termFormat     Language TermName "text")
 *   (format         Language TermName "text")
 *   (subclass       Destination Source)
 *   (instance       Destination Source)
 *   (subAttribute   Destination Source)
 *   (subrelation    Destination Source)
 *
 * Taxonomy edge direction: for all four taxonomy relations the first argument
 * is the DESTINATION and the second argument is the SOURCE.  So for
 * (subclass Human Animal) there is an edge FROM Animal TO Human, annotated
 * with 'subclass'.  In other words Animal.taxonomy.outgoing contains the
 * edge, and Human.taxonomy.incoming contains the same edge object.
 */

const {
    Symbol,
    VariableSym,
    ValueLiteral,
    Sentence,
    FunctionalSentence,
    ConditionalSentence,
    SymbolTable,
} = require('./symbol');

const { Term, TaxonomyEdge, bumpTaxonomyEpoch } = require('./term');

/** Relations that contribute edges to the taxonomy graph */
const TAXONOMY_RELATIONS = new Set(['subclass', 'instance', 'subAttribute', 'subrelation']);

/** Ordinal names for argument positions (0-based index → key name) */
const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth',
                  'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];

/**
 * Convert a 0-based argument index to its ordinal key name.
 * @param {number} n
 * @returns {string}
 */
function ordinal(n) {
    return ORDINALS[n] ?? `arg${n + 1}`;
}

/**
 * Recursively collect every Term reachable from a syntax-tree node into `out`.
 * Descends into nested Sentences; includes predicate symbols of FunctionalSentences.
 * @param {Symbol|VariableSym|ValueLiteral|Sentence} node
 * @param {{[name: string]: Term}} terms
 * @param {Set<Term>} out
 */
function collectAllSymbols(node, terms, out) {
    if (node instanceof Symbol) {
        const t = terms[node.name];
        if (t) out.add(t);
    } else if (node instanceof FunctionalSentence) {
        if (node.functionalTerm instanceof Symbol) {
            const t = terms[node.functionalTerm.name];
            if (t) out.add(t);
        }
        for (const child of node.terms) {
            collectAllSymbols(child, terms, out);
        }
    } else if (node instanceof Sentence) {
        for (const child of node.terms) {
            collectAllSymbols(child, terms, out);
        }
    }
    // VariableSym and ValueLiteral contribute no tracked terms
}

// ---------------------------------------------------------------------------
// Public classes
// ---------------------------------------------------------------------------

class SemanticError extends Error {
    /**
     * @param {FunctionalSentence} sentence The sentence that triggered the error (may be null)
     * @param {string} message Human-readable description
     */
    constructor(sentence, message) {
        super(`Semantic Error: ${message}`);
        this.name = 'SemanticError';
        this.sentence = sentence;
        this.details = message;
    }

    /**
     * Get the document range for the error
     * @return {{startLine: number, startCol: number, endLine: number, endCol: number}}
     */
    getRange() {
        const {column: startCol, line: startLine} = this.sentence.childNodes.at(0).startToken;
        const {column: endCol, line: endLine} = this.sentence.childNodes.at(-1).startToken;
        return {
            startCol, startLine, endCol, endLine
        }
    }
}

// ---------------------------------------------------------------------------
// Per-predicate processors
// ---------------------------------------------------------------------------

/**
 * Handle (documentation TermName Language "text")
 * @param {FunctionalSentence} sentence
 * @param {{[name: string]: Term}} terms
 * @param {SemanticError[]} errors
 */
function processDocumentation(sentence, terms, errors) {
    if (sentence.terms.length < 3) {
        errors.push(new SemanticError(sentence,
            `documentation expects 3 arguments, got ${sentence.terms.length}`));
        return;
    }

    const [termArg, langArg, textArg] = sentence.terms;

    if (!(termArg instanceof Symbol)) {
        errors.push(new SemanticError(sentence,
            'documentation: first argument must be a symbol (the term being documented)'));
        return;
    }
    if (!(langArg instanceof Symbol)) {
        errors.push(new SemanticError(sentence,
            'documentation: second argument must be a symbol (the language)'));
        return;
    }
    if (!(textArg instanceof ValueLiteral)) {
        errors.push(new SemanticError(sentence,
            'documentation: third argument must be a string literal'));
        return;
    }

    const term = terms[termArg.name];
    if (!term) return;

    term.documentation.push({ language: langArg.name, text: textArg.value });
}

/**
 * Handle (format Language TermName "text")
 * @param {FunctionalSentence} sentence
 * @param {{[name: string]: Term}} terms
 * @param {SemanticError[]} errors
 */
function processFormat(sentence, terms, errors) {
    if (sentence.terms.length < 3) {
        errors.push(new SemanticError(sentence,
            `format expects 3 arguments, got ${sentence.terms.length}`));
        return;
    }

    const [langArg, termArg, textArg] = sentence.terms;

    if (!(langArg instanceof Symbol)) {
        errors.push(new SemanticError(sentence,
            'format: first argument must be a symbol (the language)'));
        return;
    }
    if (!(termArg instanceof Symbol)) {
        errors.push(new SemanticError(sentence,
            'format: second argument must be a symbol (the term)'));
        return;
    }
    if (!(textArg instanceof ValueLiteral)) {
        errors.push(new SemanticError(sentence,
            'format: third argument must be a string literal'));
        return;
    }

    const term = terms[termArg.name];
    if (!term) return;

    term.format.push({ language: langArg.name, text: textArg.value });
}

/**
 * Handle (termFormat Language TermName "text")
 * Same argument order as format.
 * @param {FunctionalSentence} sentence
 * @param {{[name: string]: Term}} terms
 * @param {SemanticError[]} errors
 */
function processTermFormat(sentence, terms, errors) {
    if (sentence.terms.length < 3) {
        errors.push(new SemanticError(sentence,
            `termFormat expects 3 arguments, got ${sentence.terms.length}`));
        return;
    }

    const [langArg, termArg, textArg] = sentence.terms;

    if (!(langArg instanceof Symbol)) {
        errors.push(new SemanticError(sentence,
            'termFormat: first argument must be a symbol (the language)'));
        return;
    }
    if (!(termArg instanceof Symbol)) {
        errors.push(new SemanticError(sentence,
            'termFormat: second argument must be a symbol (the term)'));
        return;
    }
    if (!(textArg instanceof ValueLiteral)) {
        errors.push(new SemanticError(sentence,
            'termFormat: third argument must be a string literal'));
        return;
    }

    const term = terms[termArg.name];
    if (!term) return;

    term.termFormat.push({ language: langArg.name, text: textArg.value });
}

/**
 * Handle (subclass|instance|subAttribute|subrelation Destination Source)
 *
 * Only creates an edge when BOTH arguments are concrete Symbols (not variables
 * or literals), because variable-bearing sentences are universally-quantified
 * rules, not ground taxonomy facts.
 *
 * @param {FunctionalSentence} sentence
 * @param {string} relation The taxonomy relation name
 * @param {{[name: string]: Term}} terms
 * @param {SemanticError[]} errors
 */
function processTaxonomy(sentence, relation, terms, errors) {
    if (sentence.terms.length < 2) {
        errors.push(new SemanticError(sentence,
            `${relation} expects at least 2 arguments, got ${sentence.terms.length}`));
        return;
    }

    const destArg   = sentence.terms[0]; // first  argument = destination
    const sourceArg = sentence.terms[1]; // second argument = source

    // Skip universally-quantified statements — variables are not concrete terms
    if (!(destArg instanceof Symbol) || !(sourceArg instanceof Symbol)) return;

    const destTerm   = terms[destArg.name];
    const sourceTerm = terms[sourceArg.name];

    // Both ends must be tracked Terms
    if (!destTerm || !sourceTerm) return;

    const edge = new TaxonomyEdge(sourceTerm, destTerm, relation);
    bumpTaxonomyEpoch();                       // invalidate all Term caches
    sourceTerm.taxonomy.outgoing.push(edge);
    destTerm.taxonomy.incoming.push(edge);
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Build a semantic model from a SymbolTable.
 *
 * Iterates all sentences referenced by every Symbol, identifies sentences
 * whose predicate is a known semantic keyword, and populates Term objects
 * accordingly.  Each unique sentence is visited only once regardless of how
 * many symbols reference it.
 *
 * @param {SymbolTable} symbolTable A SymbolTable instance from symbol.js
 * @returns {{
 *   terms:  {[name: string]: Term},
 *   errors: SemanticError[]
 * }}
 */
function semantics(symbolTable) {
    const terms  = {};
    const errors = [];

    // Step 1 — Create a Term shell for every symbol in the table
    for (const [name, sym] of Object.entries(symbolTable.symbols)) {
        terms[name] = new Term(sym);
    }

    // Step 1b — Wire each Term's back-reference to the full terms map so that
    //            domain() and range() can resolve Symbol arguments to Terms.
    for (const t of Object.values(terms)) {
        t._terms = terms;
    }

    // Step 2 — Walk every unique sentence referenced by any symbol and
    //           dispatch to the appropriate processor
    const visited = new Set();
    const visitedConditionals = new Set();

    for (const sym of Object.values(symbolTable.symbols)) {
        for (const fileRefs of sym.references.values()) {
            for (const [sentence] of fileRefs) {
                if (visited.has(sentence)) continue;
                visited.add(sentence);

                // --- Argument position tracking ---
                // For each argument of a FunctionalSentence, record the sentence
                // under the ordinal key matching that argument's position.
                if (sentence instanceof FunctionalSentence) {
                    for (let i = 0; i < sentence.terms.length; i++) {
                        const arg = sentence.terms[i];
                        if (arg instanceof Symbol) {
                            const t = terms[arg.name];
                            if (t) {
                                const key = ordinal(i);
                                if (!t.locations[key]) t.locations[key] = [];
                                t.locations[key].push(sentence);
                            }
                        }
                    }
                }

                // --- Antecedent / consequent tracking ---
                // Walk the parent chain to find every enclosing ConditionalSentence
                // (handles nesting at any depth).  Each conditional is processed
                // exactly once: we collect all symbols in its two branches and
                // append it to those terms' antecedent / consequent arrays.
                let ancestor = sentence.parent;
                while (ancestor !== null) {
                    if (ancestor instanceof ConditionalSentence
                            && !visitedConditionals.has(ancestor)) {
                        visitedConditionals.add(ancestor);
                        const antecedentTerms = new Set();
                        const consequentTerms = new Set();
                        if (ancestor.terms[0] !== undefined)
                            collectAllSymbols(ancestor.terms[0], terms, antecedentTerms);
                        if (ancestor.terms[1] !== undefined)
                            collectAllSymbols(ancestor.terms[1], terms, consequentTerms);
                        for (const t of antecedentTerms) t.locations.antecedent.push(ancestor);
                        for (const t of consequentTerms) t.locations.consequent.push(ancestor);
                    }
                    ancestor = ancestor.parent;
                }

                // --- Predicate dispatch ---
                if (!(sentence instanceof FunctionalSentence)) continue;

                const predicate = sentence.functionalTerm.name;

                try {
                    if (predicate === 'documentation') {
                        processDocumentation(sentence, terms, errors);
                    } else if (predicate === 'format') {
                        processFormat(sentence, terms, errors);
                    } else if (predicate === 'termFormat') {
                        processTermFormat(sentence, terms, errors);
                    } else if (TAXONOMY_RELATIONS.has(predicate)) {
                        processTaxonomy(sentence, predicate, terms, errors);
                    }
                } catch (e) {
                    errors.push(
                        e instanceof SemanticError
                            ? e
                            : new SemanticError(sentence, e.message)
                    );
                }
            }
        }
    }

    return { terms, errors };
}

module.exports = {
    semantics,
    Term,
    TaxonomyEdge,
    SemanticError,
};
