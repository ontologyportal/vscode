/**
 * Term and taxonomy graph types for SUMO semantic analysis.
 *
 * Exports:
 *   TaxonomyEdge       — a directed, annotated edge between two Terms
 *   Term               — a semantic term with documentation, format strings,
 *                        taxonomy edges, location tracking, and cached
 *                        classification getters
 *   bumpTaxonomyEpoch  — call whenever a taxonomy edge is added to invalidate
 *                        all Term computed-property caches
 */

const { Sentence } = require('./sentence');
const { Symbol, ValueLiteral } = require('./symbol');
const { CachedSemanticStatement } = require('./cache');

class SemanticError extends Error {
    /**
     * @param {Sentence} sentence The sentence that triggered the error (may be null)
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
        const {column: startCol, line: startLine} = this.sentence.node.startToken;
        const {column: endCol, line: endLine} = this.sentence.node.endToken;
        return {
            startCol, startLine, endCol: endCol + 1, endLine
        }
    }
}

// ---------------------------------------------------------------------------
// TaxonomyEdge
// ---------------------------------------------------------------------------

const TAXONOMY_RELATIONS = new Set(['subclass', 'instance', 'subAttribute', 'subrelation']);
const ARITY_MAPPINGS = {
    "BinaryRelation": 2,
    "TernaryRelation": 3,
    "QuaternaryRelation": 4,
    "QuintaryRelation": 5,
    "VariableArityRelation": -1
}
/**
 * A directed, annotated edge in the taxonomy graph.
 *
 * Created from sentences whose predicate is one of the taxonomy relations.
 * For (subclass Human Animal):
 *   from     = Term('Animal')   (second argument = source)
 *   to       = Term('Human')    (first argument  = destination)
 *   relation = 'subclass'
 */
class TaxonomyEdge {
    /**
     * @param {Term} from Source term (second argument of the relation)
     * @param {Term} to Destination term (first argument of the relation)
     * @param {string} relation One of the taxonomy relation names
     */
    constructor(from, to, relation) {
        /** @type {Term} */
        this.from = from;
        /** @type {Term} */
        this.to = to;
        /** @type {string} */
        this.relation = relation;
    }
}

// ---------------------------------------------------------------------------
// Term
// ---------------------------------------------------------------------------

/**
 * A semantic term built from one Symbol in the SymbolTable.
 *
 * After running semantics(), each Term is populated with documentation,
 * format strings, taxonomy edges, and sentence-location records extracted
 * from the sentences that reference the underlying Symbol.
 */
class Term extends CachedSemanticStatement {
    /**
     * @param {Symbol} symbol The Symbol object from symbol.js
     */
    constructor(symbol) {
        super(symbol.symbolTable);
        /**
         * The source Symbol from the SymbolTable.
         * @type {Symbol}
         */
        this.symbol = symbol;

        // Populate the forward reference
        this.symbol.forward = this;
    }

    /** Convenience accessor for the underlying symbol name.
     * @returns {string} */
    get name() {
        return this.symbol.name;
    }

    /**
     * Documentation strings, one entry per language found in the KB.
     * Each entry is {language: string, text: string}.
     * Populated from (documentation TermName Language "text") sentences.
     * @returns {{language: string, text: string}[]}
     */
    get documentation() {
        return this._getCache("documentation", () => {
            // Query the symbol table
            /** @type {Sentence[]} */
            const sentences = this.symbol.symbolTable.lookup.documentation[this.name]._SYM_._LIT_.$;
            /** @type {{language: string, text: string}[]} */
            const documentation = [];
            for (const sentence of sentences) {
                /** @type {[Symbol, Symbol, Symbol, ValueLiteral]} */
                const terms = sentence.terms;
                const languageTerm = terms[2];
                const docString = terms[3];
                documentation.push({
                    language: languageTerm.name,
                    text: docString.value
                });
            }
            return documentation;
        });
    }

    /**
     * Predicative format strings (used for relations/functions with arguments).
     * Each entry is {language: string, text: string}.
     * Populated from (format Language TermName "text") sentences.
     * @returns {{language: string, text: string}[]}
     */
    get format () {
        return this._getCache("format", () => {
            /** @type {Sentence[]} */
            const sentences = this.symbol.symbolTable.lookup.format._SYM_[this.name]._LIT_.$;
            /** @type {{language: string, text: string}[]}*/
            const format = [];
            for (const sentence of sentences) {
                /** @type {[Symbol, Symbol, Symbol, ValueLiteral]} */
                const terms = sentence.terms;
                const languageTerm = terms[1];
                const fmtString = terms[3];
                format.push({
                    language: languageTerm.name,
                    text: fmtString.value
                });
            }
            return format;
        });
    };

    /**
     * Nominal format strings (used for standalone term display).
     * Each entry is {language: string, text: string}.
     * Populated from (termFormat Language TermName "text") sentences.
     * @returns {{language: string, text: string}[]}
     */
    get termFormat () {
        return this._getCache("termFormat", () => {
            /** @type {Sentence[]} */
            const sentences = this.symbol.symbolTable.lookup.termFormat._SYM_[this.name]._LIT_.$;
            /** @type {{language: string, text: string}[]}*/
            const termFormat = [];
            for (const sentence of sentences) {
                /** @type {[Symbol, Symbol, Symbol, ValueLiteral]} */
                const terms = sentence.terms;
                const languageTerm = terms[1];
                const fmtString = terms[3];
                termFormat.push({
                    language: languageTerm.name,
                    text: fmtString.value
                })
            }
            return termFormat;
        });
    }

    /**
     * This term's view of the taxonomy graph.
     *
     * incoming – edges that end at this term  (this is the first/destination arg)
     *            e.g. for (subclass Human Animal), Human.taxonomy.incoming has
     *            an edge {from: Animal, to: Human, relation: 'subclass'}
     *
     * outgoing – edges that start at this term (this is the second/source arg)
     *            e.g. for (subclass Human Animal), Animal.taxonomy.outgoing has
     *            the same edge object.
     *
     * @returns {{incoming: TaxonomyEdge[], outgoing: TaxonomyEdge[]}}
     */
    get taxonomy () {
        return this._getCache("taxonomy", () => {
            /** @type {Sentence[]} */
            const incomingSym = this.symbol.symbolTable.lookup._ANY(...TAXONOMY_RELATIONS)[this.name]._SYM_.$;
            const incoming = [...incomingSym].map(sentence => {
                /** @type {[Symbol, Symbol, Symbol]} */
                const terms = sentence.terms;
                const from = terms[2].forward || new Term(terms[2]);
                const relation = terms[0].name;
                return new TaxonomyEdge(from, this, relation);
            });
            /** @type {Sentence[]} */
            const outgoingSym = this.symbol.symbolTable.lookup._ANY(...TAXONOMY_RELATIONS)._SYM_[this.name].$;
            const outgoing = [...outgoingSym].map(sentence => {
                /** @type {[Symbol, Symbol, Symbol]} */
                const terms = sentence.terms;
                const to = terms[1].forward || new Term(terms[1]);
                const relation = terms[0].name;
                return new TaxonomyEdge(this, to, relation);
            })
            return { incoming, outgoing };
        });
    }

    /**
     * Records every sentence in which this term is referenced by position.
     *
     * Ordinal keys ('first', 'second', …) are populated dynamically; each
     * holds every FunctionalSentence in which this term appears at that
     * argument position (sentence.terms[0] = 'first', etc., not counting
     * the predicate / functionalTerm).  Not every key will be present on
     * every Term.
     *
     * antecedent – every ConditionalSentence (=>) whose antecedent
     *              (terms[0]) contains this term anywhere, even in deeply
     *              nested sub-sentences.
     *
     * consequent – every ConditionalSentence (=>) whose consequent
     *              (terms[1]) contains this term anywhere, even in deeply
     *              nested sub-sentences.
     *
     * @returns {{
     *   antecedent: OperatorSentence[],
     *   consequent: OperatorSentence[],
     *   [key: string]: Sentence[]
     * }}
     */
    get locations () {
        return this._getCache("locations", () => {
            /** @type {Sentence[]} */
            const first = this.symbol.symbolTable.lookup._SYM_[this.name]._$;
            const second = this.symbol.symbolTable.lookup._SYM_._[this.name]._$;
            const antecedent = this.symbol.symbolTable.lookup._OP("=>")._S((l, q) => l.$_._ANY(this.name, l2 => l2._S(q))._$)._.$;
            const consequent = this.symbol.symbolTable.lookup._OP("=>")._._S((l, q) => l.$_._ANY(this.name, l2 => l2._S(q))._$).$;
            return {
                first,
                second,
                antecedent,
                consequent
            };
        });
    }

    /**
     * True if the term is declared as an instance of something — i.e. it
     * appears as the first argument of at least one instance sentence.
     * @returns {boolean}
     */
    get isInstance() {
        return this._getCache('isInstance', () => this.taxonomy.incoming.some(e => e.relation === 'instance'));
    }

    /**
     * True if every taxonomy edge on this term (both incoming and outgoing)
     * is a subclass edge and at least one such edge exists.  Terms that also
     * participate in instance relations do not satisfy this predicate.
     * @returns {boolean}
     */
    get isClass() {
        return this._getCache('isClass', () => this.taxonomy.incoming.length === 0 || this.taxonomy.incoming.every(e => e.relation === 'subclass'));
    }

    /**
     * True if the term is an instance (has an incoming instance edge) and
     * 'Predicate' is reachable by following its incoming taxonomy edges.
     * Covers direct instances of Predicate and instances of any subclass of
     * Predicate (e.g. BinaryPredicate).
     * @returns {boolean}
     */
    get isPredicate() {
        return this._getCache('isPredicate', () => this.isInstance && this.hasAncestor('Predicate'));
    }

    /**
     * True if the term is an instance (has an incoming instance edge) and
     * 'Function' is reachable by following its incoming taxonomy edges.
     * @returns {boolean}
     */
    get isFunction() {
        return this._getCache('isFunction', () => this.isInstance && this.hasAncestor('Function'));
    }

    /**
     * True if the term is a relation (either a Function or a Predicate)
     */
    get isRelation() {
        return this._getCache("isRelation", () => this.isInstance && this.hasAncestor('Relation'));
    }

    /**
     * True if 'Attribute' is reachable by following this term's incoming
     * taxonomy edges, regardless of whether the term is a direct instance of
     * Attribute, a subclass of Attribute, or an instance of a subclass.
     * @returns {boolean}
     */
    get isAttribute() {
        return this._getCache("isAttribute", () => this.isInstance && this.hasAncestor('Attribute'));
    }

    /**
     * Get the domain for a relation term, null indicates that the term 
     *  is not a relation
     * @returns {Term[]|null}
     */
    get domain() {
        return this._getCache("domain", () => {
            if (!this.isRelation) return null;
            /** @type {Sentence[]} */
            const sentences = this.symbol.symbolTable.lookup.domain[this.name]._LIT_._SYM_.$;
            const d = [];
            sentences.forEach(sentence => {
                /** @type {[Symbol, Symbol, ValueLiteral, Symbol]} */
                const terms = sentence.terms;
                const idx = Number(terms[2].value);
                if (isNaN(idx)) {
                    throw new SemanticError(sentence, "domain statement require a numerical literal as its second argument");
                }
                /** @type {Term} */
                const termType = terms[3].forward || new Term(terms[3]);
                if (!termType.isClass) {
                    throw new SemanticError(sentence, "domain requires a class symbol as its third argument");
                }
                d.push({termType, idx});
            });
            if (d.length === 0) return [];
            const maxIdx = d.reduce((m, x) => m > x.idx ? m : x.idx, 0) - 1;
            const domain = new Array(maxIdx);
            d.forEach(dom => {domain[dom.idx - 1] = dom.termType});
            return domain
        });
    }

    /**
     * Like domain, check domainSubclass relation term, which is the same
     *  as domain but instead of instance, it is subclass of the target class 
     * @return {Term[]} 
     */
    get domainSubclass() {
        return this._getCache('domainSubclass', () => {
            if (!this.isRelation) return null;
            /** @type {Sentence[]} */
            const sentences = this.symbol.symbolTable.lookup.domainSubclass[this.name]._LIT_._SYM_.$;
            const d = [];
            sentences.forEach(sentence => {
                /** @type {[Symbol, Symbol, ValueLiteral, Symbol]} */
                const terms = sentence.terms;
                const idx = Number(terms[2].value);
                if (isNaN(idx)) {
                    throw new SemanticError(sentence, "domainSubclass statement require a numerical literal as its second argument");
                }
                /** @type {Term} */
                const termType = terms[3].forward || new Term(terms[3]);
                if (!termType.isClass) {
                    throw new SemanticError(sentence, "domainSubclass requires a class symbol as its third argument");
                }
                d.push({termType, idx});
            });
            if (d.length === 0) return [];
            const maxIdx = d.reduce((m, x) => m > x.idx ? m : x.idx, 0) - 1;
            const domainSubclass = new Array(maxIdx);
            d.forEach(dom => {domainSubclass[dom.idx - 1] = dom.termType});
            return domainSubclass;
        });
    }

    /**
     * Shortcut domain validation
     * @param {Term} term
     * @param {number} idx
     * @returns {boolean}
     */
    validateDomain(term, idx) {
        // Validate this term first
        if (!this.validate()) return false;
        const domain = this.domain;
        const d = domain[Math.min(idx, domain.length - 1)];

        if (d) {
            if (!term.isInstance) return false;
            return term.hasAncestor(d.name);
        }

        const domainSubclass = this.domainSubclass;
        const ds = domainSubclass[Math.min(idx, domainSubclass.length - 1)];

        if (ds) {
            if (!term.isClass) return false;
            return term.hasAncestor(ds.name);
        }

        console.log(
            this.name,
            this.domain.length,
            this.domain.map(d => d?.name),
            this.domainSubclass.length,
            this.domainSubclass.map(d => d?.name));

        return false;
    }

    /**
     * Get the range for a relation term, null indicates that the term 
     *  is not a relation.
     * @returns {Term|null}
     */
    get range() {
        return this._getCache("range", () => {
            if (!this.isRelation)
                return null;
            /** @type {Sentence[]} */
            const sentences = this.symbol.symbolTable.lookup.range[this.name]._SYM_.$;
            const sentence = [...sentences].at(-1);
            if (!sentence) return null;
            const rangeTerm = sentence.terms[2].forward || new Term(sentence.terms[2]);
            if (!rangeTerm.isClass) {
                throw new SemanticError(sentence, "range requires a class symbol as its second argument");
            }
            return rangeTerm;
        });
    }


    /**
     * Like range, check rangeSubclass relation term, which is the same
     *  as range but instead of instance, it is subclass of the target class 
     * @return {Term}
     */
    get rangeSubclass() {
        return this._getCache("rangeSubclass", () => {
            if (!this.isRelation)
                return null;
            /** @type {Sentence[]} */
            const sentences = this.symbol.symbolTable.lookup.rangeSubclass[this.name]._SYM_.$;
            const sentence = [...sentences].at(-1);
            if (!sentence) return null;
            const rangeTerm = sentence.terms[2].forward || new Term(sentence.terms[2]);
            if (!rangeTerm.isClass) {
                throw new SemanticError(sentence, "rangeSubclass requires a class symbol as its second argument");
            }
            return rangeTerm;
        });
    }


    /**
     * Shortcut used range validation, returns either a Term or InstanceOf(Term)
     *  for which this term's range is
     * @returns {Term|null}
     */
    validRange() {
        // Validate this term first
        if (!this.validate()) return null;
        const range = this.range;
        if (range) {
            return new InstanceOf(range);
        }
        const rangeSubclass = this.rangeSubclass;
        if (rangeSubclass) {
            return rangeSubclass;
        }

        return null;
    }

    /**
     * Gets the arity of a relation term, null indicates that the term
     *  is not a relation, -1 indicates that the term can accept an 
     *  arbitrary number of arguments
     * @returns {number|null}
     */
    get arity() {
        return this._getCache("arity", () => {
            if (!this.isRelation)
                return null;
            const arity = Object.entries(ARITY_MAPPINGS).find(([superClass, _]) => {
                if (this.hasAncestor(superClass))
                    return true;
            });
            if (!arity) {
                // For error verbosity, we now locate the instance
                //  or subrelation for this term so we can highlight it
                /** @type {Sentence[]} */
                const sentences = this.symbol.symbolTable.lookup
                    ._ANY("subrelation", "instance")[this.name]._.$;
                throw new SemanticError(sentences[0], "A declared instance of a relation is missing inheritance from a specific arity stating class (i.e. BinaryRelation)")
            }
            if (this.isFunction && arity[1] > 0)
                return arity[1] - 1;
            return arity[1];
        });
    }


    /**
     * Returns true if a term named `name` is reachable from `term` by following
     * any incoming taxonomy edges (instance, subclass, subAttribute, subrelation).
     * Traversal is cycle-safe via the `visited` set.
     *
     * Top-level calls (no `visited` argument) are memoized in the epoch cache so
     * that repeated calls for the same ancestor name within the same epoch — which
     * happen constantly across isClass / isInstance / isPredicate / isFunction /
     * isRelation / isAttribute / arity — only traverse the taxonomy graph once.
     *
     * @param {string} name Name of the ancestor to search for
     * @param {Set<Term>} [visited] Cycle guard; omit on the initial call
     * @returns {boolean}
     */
    hasAncestor(name, visited) {
        if (this.name === name) return true;
        // Cache top-level (non-recursive) calls only.  Recursive calls pass a
        // visited Set so we can distinguish them and skip the cache lookup.
        if (!visited) {
            return this._getCache(`ancestor:${name}`, () => this.hasAncestor(name, new Set()));
        }
        if (visited.has(this)) return false;
        visited.add(this);
        for (const edge of this.taxonomy.incoming) {
            if (edge.from.name === name) return true;
            if (edge.from.hasAncestor(name, visited)) return true;
        }
        return false;
    }

    validate() {
        return this._getCache("validate", () => {
            // Some validations occur in the above properties, so this won't 
            //  directly check everything
            // Rule 1: All terms must be related to Entity through its taxonomy
            if (!this.hasAncestor("Entity")) {
                // For the purpose of showing the error, find A sentence that 
                //  it appears in
                /** @type {Sentence | undefined} */
                const sentence = this.symbol.references.keys().next().value;
                if (!sentence) throw new Error("Missing an sentences");
                throw new SemanticError(sentence, `Symbol ${this.name} must have a valid derivation to Entity`);
            }
            // Rule 2: The domain type must be defined for all continuous
            //  values and domainSubclass and domain cannot overlap on the 
            //  same index
            if (this.isRelation) {
                const a = this.domain;
                const b = this.domainSubclass;
                const length = Math.max(a.length, b.length);
                
                const domain = Array.from({ length }, (_, i) => {
                    const aVal = i < a.length ? a[i] : null;
                    const bVal = i < b.length ? b[i] : null;
    
                    if (aVal != null && bVal != null) {
                        const [sentence, ..._] = this.symbolTable.lookup.domain[this.name]._L(i + 1)._.$;
                        throw new SemanticError(
                            sentence,
                            `Term '${this.name}' has both a domain and domainSubclass defined for argument ${i + 1}`
                        );
                    } else if (aVal == null && bVal == null) {
                        const [sentence, ..._] = this.symbolTable.lookup.subclass[this.name]._.$;
                        throw new SemanticError(
                            sentence,
                            `Missing domain/domainSubclass statement for ${i} argument for term ${this.name}`
                        );
                    }
    
                    return aVal === null ? bVal : aVal;
                });
                // Rule 3: The arity must be greater than or equal to the 
                //  number of domain terms
                if (this.arity > 0 && this.arity < domain.filter(Boolean).length) {
                    const [sentence, ..._] = this.symbolTable.lookup.subclass[this.name]._.$;
                    throw new SemanticError(sentence, `Expected term '${this.name}' arity ${this.arity} is less than the number of domain terms`);
                }
                // Rule 4: If the term is a function, make sure that range is set
                if (this.isFunction) {
                    if (!(this.range || this.rangeSubclass)) {
                        const [sentence, ..._] = this.symbolTable.lookup.subclass[this.name]._.$;
                        throw new SemanticError(sentence, `Term '${this.name}' is defined as a Function, but no range relation is made for the term`);
                    } else if (this.range !== null && this.rangeSubclass !== null) {
                        const [sentence, ..._] = this.symbolTable.lookup.range[this.name]._.$;
                        throw new SemanticError(sentence, `Term '${this.name}' cannot have both a range and rangeSubclass defined`);
                    }
                    // Rule 5: If the term is a function it should start with a uppercase
                    if (this.name.charAt(0).toUpperCase() !== this.name.charAt(0)) {
                        const [sentence, ..._] = this.symbolTable.lookup.range[this.name]._.$;
                        throw new SemanticError(sentence, `Term '${this.name}' is a function, but it should start with an uppercase letter`);
                    }
                } else if (this.isPredicate) {
                    // Rule 5: If the term is a predicate it should start with a lowercase
                    if (this.name.charAt(0).toLowerCase() !== this.name.charAt(0)) {
                        const [sentence, ..._] = this.symbolTable.lookup.range[this.name]._.$;
                        throw new SemanticError(sentence, `Term '${this.name}' is a predicate, but it should start with a lowercase letter`);
                    }
                }
            }
            return true;
        });
    }
}

/**
 * Helper class to declare an object is an instance of another Term
 */
class InstanceOf extends Term {
    /**
     * @param {Term} term
     */
    constructor (term) {
        if (term.isInstance) {
            throw new Error("Cannot instantiate a instance: InstanceOf(" + term.name + ")");
        }
        super(term.symbol);
        /** @type {Term} */
        this.root = term;
    }

    get isInstance() {
        return true;
    }

    get isClass() {
        return false;
    }

    get isRelation() {
        return this.root.hasAncestor("Relation");
    }

    get isFunction() {
        return this.root.hasAncestor("Function");
    }

    get isPredicate() {
        return this.root.hasAncestor("Predicate");
    }

    /**
     * Wrapper for root hasAncestor
     *
     * @param {string} name Name of the ancestor to search for
     * @returns {boolean}
     */
    hasAncestor(term) {
        return this.root.hasAncestor(term);
    }
}

module.exports = {
    TaxonomyEdge,
    Term,
    SemanticError
};
