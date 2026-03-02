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

const { Symbol, ValueLiteral } = require('./symbol');

// ---------------------------------------------------------------------------
// Epoch counter — cache invalidation
// ---------------------------------------------------------------------------

/**
 * Monotonically increasing counter bumped whenever a taxonomy edge is added.
 * Term caches store the epoch at which they were last populated and clear
 * themselves when this value has moved on.
 */
let _taxonomyEpoch = 0;

/**
 * Increment the taxonomy epoch, invalidating every Term's computed-value
 * cache.  Call this whenever an edge is added to the taxonomy graph.
 */
function bumpTaxonomyEpoch() {
    _taxonomyEpoch++;
}

// ---------------------------------------------------------------------------
// TaxonomyEdge
// ---------------------------------------------------------------------------

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
// Taxonomy helper
// ---------------------------------------------------------------------------

/**
 * Returns true if a term named `name` is reachable from `term` by following
 * any incoming taxonomy edges (instance, subclass, subAttribute, subrelation).
 * Traversal is cycle-safe via the `visited` set.
 *
 * @param {Term} term Starting term
 * @param {string} name Name of the ancestor to search for
 * @param {Set<Term>} [visited] Cycle guard; omit on the initial call
 * @returns {boolean}
 */
function hasAncestor(term, name, visited = new Set()) {
    if (visited.has(term)) return false;
    visited.add(term);
    for (const edge of term.taxonomy.incoming) {
        if (edge.from.name === name) return true;
        if (hasAncestor(edge.from, name, visited)) return true;
    }
    return false;
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
class Term {
    /**
     * @param {Symbol} symbol The Symbol object from symbol.js
     */
    constructor(symbol) {
        /**
         * The source Symbol from the SymbolTable.
         * @type {Symbol}
         */
        this.symbol = symbol;

        /**
         * Documentation strings, one entry per language found in the KB.
         * Each entry is {language: string, text: string}.
         * Populated from (documentation TermName Language "text") sentences.
         * @type {{language: string, text: string}[]}
         */
        this.documentation = [];

        /**
         * Predicative format strings (used for relations/functions with arguments).
         * Each entry is {language: string, text: string}.
         * Populated from (format Language TermName "text") sentences.
         * @type {{language: string, text: string}[]}
         */
        this.format = [];

        /**
         * Nominal format strings (used for standalone term display).
         * Each entry is {language: string, text: string}.
         * Populated from (termFormat Language TermName "text") sentences.
         * @type {{language: string, text: string}[]}
         */
        this.termFormat = [];

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
         * @type {{incoming: TaxonomyEdge[], outgoing: TaxonomyEdge[]}}
         */
        this.taxonomy = {
            incoming: [],
            outgoing: []
        };

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
         * @type {{
         *   antecedent: import('./symbol').ConditionalSentence[],
         *   consequent: import('./symbol').ConditionalSentence[],
         *   [key: string]: import('./symbol').FunctionalSentence[] | import('./symbol').ConditionalSentence[]
         * }}
         */
        this.locations = {
            antecedent: [],
            consequent: [],
        };

        this._cache = Object.create(null); // keyed computed-value store
        this._epoch = -1;                  // epoch of last cache fill
        this._terms = null;                // injected by semantics(); needed by domain()/range()
    }

    /**
     * Returns the cache object for the current taxonomy epoch, clearing it
     * first if any taxonomy edge has been added since the last access.
     * @returns {Object}
     */
    _getCache() {
        if (this._epoch !== _taxonomyEpoch) {
            this._cache = Object.create(null);
            this._epoch = _taxonomyEpoch;
        }
        return this._cache;
    }

    /** Convenience accessor for the underlying symbol name.
     * @returns {string} */
    get name() {
        return this.symbol.name;
    }

    /**
     * True if the term is declared as an instance of something — i.e. it
     * appears as the first argument of at least one instance sentence.
     * @returns {boolean}
     */
    get isInstance() {
        const c = this._getCache();
        if (!('isInstance' in c))
            c.isInstance = this.taxonomy.incoming.some(e => e.relation === 'instance');
        return c.isInstance;
    }

    /**
     * True if every taxonomy edge on this term (both incoming and outgoing)
     * is a subclass edge and at least one such edge exists.  Terms that also
     * participate in instance relations do not satisfy this predicate.
     * @returns {boolean}
     */
    get isClass() {
        const c = this._getCache();
        if (!('isClass' in c)) {
            const all = [...this.taxonomy.incoming, ...this.taxonomy.outgoing];
            c.isClass = all.length > 0 && all.every(e => e.relation === 'subclass');
        }
        return c.isClass;
    }

    /**
     * True if the term is an instance (has an incoming instance edge) and
     * 'Predicate' is reachable by following its incoming taxonomy edges.
     * Covers direct instances of Predicate and instances of any subclass of
     * Predicate (e.g. BinaryPredicate).
     * @returns {boolean}
     */
    get isPredicate() {
        const c = this._getCache();
        if (!('isPredicate' in c))
            c.isPredicate = this.isInstance && hasAncestor(this, 'Predicate');
        return c.isPredicate;
    }

    /**
     * True if the term is an instance (has an incoming instance edge) and
     * 'Function' is reachable by following its incoming taxonomy edges.
     * @returns {boolean}
     */
    get isFunction() {
        const c = this._getCache();
        if (!('isFunction' in c))
            c.isFunction = this.isInstance && hasAncestor(this, 'Function');
        return c.isFunction;
    }

    /**
     * True if 'Attribute' is reachable by following this term's incoming
     * taxonomy edges, regardless of whether the term is a direct instance of
     * Attribute, a subclass of Attribute, or an instance of a subclass.
     * @returns {boolean}
     */
    get isAttribute() {
        const c = this._getCache();
        if (!('isAttribute' in c))
            c.isAttribute = hasAncestor(this, 'Attribute');
        return c.isAttribute;
    }

    /**
     * Returns the Term declared as the domain class for argument position
     * `idx` of this relation, or null if no such declaration exists.
     *
     * Looks for a sentence of the form `(domain TERM idx CLASS)` in which
     * this term appears as the first argument.
     *
     * @param {number} idx 1-based argument position (as used in SUMO domain sentences)
     * @returns {Term|null}
     */
    domain(idx) {
        const c = this._getCache();
        const key = `domain:${idx}`;
        if (!(key in c)) {
            c[key] = null;
            for (const sentence of this.locations.first ?? []) {
                const pred = sentence.functionalTerm.name;
                if (pred !== 'domain' && pred !== 'domainSubclass') continue;
                const idxArg    = sentence.terms[1];
                const domainArg = sentence.terms[2];
                if (idxArg instanceof ValueLiteral &&
                        Number(idxArg.value) === idx &&
                        domainArg instanceof Symbol) {
                    c[key] = this._terms?.[domainArg.name] ?? null;
                    break;
                }
            }
        }
        return c[key];
    }

    /**
     * Returns the Term declared as the range class of this relation, or null
     * if no such declaration exists.
     *
     * Looks for a sentence of the form `(range TERM CLASS)` in which this
     * term appears as the first argument.
     *
     * @returns {Term|null}
     */
    range() {
        const c = this._getCache();
        if (!('range' in c)) {
            c.range = null;
            for (const sentence of this.locations.first ?? []) {
                if (sentence.functionalTerm.name !== 'range') continue;
                const rangeArg = sentence.terms[1];
                if (rangeArg instanceof Symbol) {
                    c.range = this._terms?.[rangeArg.name] ?? null;
                    break;
                }
            }
        }
        return c.range;
    }
}

module.exports = {
    TaxonomyEdge,
    Term,
    bumpTaxonomyEpoch,
};
