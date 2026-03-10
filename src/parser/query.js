const {
    Sentence,
    OperatorSentence,
} = require('./sentence');
const {
    Element,
    ELEMENT_TYPE,
} = require('./element');
/**
 * @typedef {(sect: {
 *  sentence: Sentence,
 *  idx: number,
 *  queryIdx: number,
 *  term: Element,
 *  queryFull: QueryFunction[]
 * }) => number} QueryFunction
 */

/**
 * @type {{[op: string]: QueryFunction}}
 */
const queryOps = {
    _: (_) => 1, // Wildcard — match any single term
    _OP_: ({ sentence, idx }) => idx === 0 && sentence instanceof OperatorSentence ? 1 : -1,
    _SYM_: ({ term }) => term.$TYPE == ELEMENT_TYPE.SYMBOL ? 1 : -1,
    _VAR_: ({ term }) => term.$TYPE == ELEMENT_TYPE.VARIABLE ? 1 : -1,
    _LIT_: ({ term }) => term.$TYPE == ELEMENT_TYPE.LITERAL ? 1 : -1,
    /**
     * Greedy wildcard: consumes terms until the next query function matches.
     * Returns the number of terms consumed (>= 0), or -1 if no match is found.
     * Note: if the next pattern matches at idx+0, $_ returns 0 which is treated
     * as "no match" by the caller — use explicit patterns instead of $_ in that case.
     */
    $_: ({ sentence, idx, queryIdx, queryFull }) => {
        const nextQuery = queryFull[queryIdx + 1];
        // No next query — consume all remaining terms
        if (!nextQuery) return sentence.terms.length - idx;
        // Find the first position at or after idx where the next query matches
        const found = sentence.terms
            .slice(idx)
            .findIndex((term, i) =>
                nextQuery({ sentence, idx: idx + i, queryIdx: queryIdx + 1, queryFull, term }) >= 0
            );
        return found === -1 ? -1 : found;
    }
}

/**
 * @param {string} prop
 */
function compareSym(prop) {
    return ({ term }) => term.$TYPE == ELEMENT_TYPE.SYMBOL && term.name == prop ? 1 : -1;
}

/**
 * Symbol tag used inside _S to distinguish the recursive self-reference `q`
 * from a builder lambda.
 *
 * When the user writes _S((l, q) => ...), `q` is a plain JS function just
 * like a builder lambda `(l) => chain` — both have typeof === 'function'.
 * Without a tag, _S would always treat its argument as a builder and call
 * fn(innerProxy), which for `q` (a QueryFunction expecting a ctx object)
 * would produce nonsense.  Tagging `q` with IS_QUERY_FN lets _S branch:
 *   fn[IS_QUERY_FN] → wrap as a Sentence guard around the recursive call
 *   otherwise        → call as a builder to accumulate the inner query chain
 */
/**
 * Sentinel used as the target of the inner chain proxy created inside _S.
 * When $ or _$ is accessed on a proxy whose target carries this key, the
 * handler returns {query, enforceLen} instead of iterating the (empty/fake)
 * target. This lets _S extract the accumulated query and enforcement mode
 * from a properly-terminated sub-chain (l => l.A.B._$) without needing a
 * real Set of sentences.
 */
const QUERY_TARGET = Symbol('QueryTarget');

const IS_QUERY_FN = Symbol('IsQueryFn');

/**
 * @param {QueryFunction} fn 
 * @param {QueryFunction}
 */
function makeQueryFn(fn) {
    fn[IS_QUERY_FN] = true;
    return fn;
}

/**
 * Resolve the query for a given sentence.
 * Each query function receives the current term and returns the number of
 * terms it consumed (>= param0 = match + advance N, <= 0 = no match).
 * @param {Sentence} sentence
 * @param {QueryFunction[]} queryFull
 * @param {boolean} enforceLen Whether all terms must be consumed ($ vs _$)
 * @return {boolean}
 */
function resolveQuery(sentence, queryFull, enforceLen) {
    let termIdx = 0;
    for (let queryIdx = 0; queryIdx < queryFull.length; queryIdx++) {
        const q = queryFull[queryIdx];
        const term = sentence.terms[termIdx];
        const csr = q({ sentence, queryFull, term, idx: termIdx, queryIdx });
        if (csr < 0) return false;
        termIdx += csr;
    }
    if (enforceLen && termIdx < sentence.terms.length) return false;
    return true;
}

/**
 * Build the accessor proxy `l` passed to function arguments of _ANY().
 * Each property resolves to a single-step QueryFunction:
 *   l._OP_          → queryOps._OP_
 *   l._SYM_         → queryOps._SYM_   (and other primitives in queryOps)
 *   l._L("text")    → QueryFunction matching that literal value
 *   l._OP("=>")     → QueryFunction matching that specific operator
 *   l._ANY(...)     → QueryFunction that ORs alternatives (nestable)
 *   l.someName      → compareSym("someName")
 * @returns {QueryFunction|(...args) => QueryFunction}
 */
// Forward reference — _accessor is assigned once after buildAccessor() is defined
// so that internal callers (_ANY, _S) reuse the singleton instead of creating a
// fresh Proxy on every query step.
let _accessor;
function buildAccessor() {
    return new Proxy({}, {
        get(_, p) {
            if (p in queryOps) return queryOps[p];
            if (p === '_L') return (value) =>
                (ctx) => ctx.term.$TYPE == ELEMENT_TYPE.LITERAL && ctx.term.value == value ? 1 : -1;
            if (p === '_OP') return (opName) =>
                (ctx) => ctx.idx === 0 && ctx.sentence instanceof OperatorSentence && ctx.sentence.op.name === opName ? 1 : -1;
            if (p === '_ANY') return (...items) => {
                const fns = items.map(item =>
                    // Reuse the singleton accessor instead of allocating a new Proxy
                    typeof item === 'function' ? item(_accessor) : compareSym(item)
                );
                return (ctx) => fns.some(fn => fn(ctx) >= 0) ? 1 : -1;
            };
            if (p === '_S') return (...args) => {
                // _S() -- no args -- match any term that is a Sentence
                if (args.length === 0) {
                    return makeQueryFn((ctx) => ctx.term.$TYPE === ELEMENT_TYPE.SENTENCE ? 1 : -1);
                }
                // Get the first argument, a callback function which allows the user
                //  to pass another query to be executed inside the sentence. It takes 
                //  up to two arguments, the first being a new lookup proxy, and the 
                //  second is a reference to the query performed on said lookup proxy,
                //  allowing for recurssive queries
                const [fn] = args;
                // check if the callback is tagged, meaning that it is from the 
                //  recurssive reference. If not set, it is a query that the 
                //  user passed, i.e. _S((L, Q) => L._S(Q)), the outer _S queryFn
                //  is not tagged, but the inner one is
                if (fn[IS_QUERY_FN]) {
                    // Make a new tagged fn and return it
                    return makeQueryFn((ctx) => {
                        if (ctx.term.$TYPE !== ELEMENT_TYPE.SENTENCE) return -1;
                        return fn(ctx) >= 0 ? 1 : -1;
                    });
                }
                // _S(builderFn) — fn is (l) => chain or (l, q) => chain.
                // Create a stable forward reference (q) the builder can close over for recursion,
                // then build the inner query chain and resolve selfFn once queries are known.
                let selfFn; // The self reference
                const self = makeQueryFn((ctx) => selfFn(ctx));
                // The inner chain proxy uses a QUERY_TARGET sentinel as its target so that
                // accessing .$ or ._$ on it returns {query, enforceLen} instead of trying
                // to iterate an empty set. lookupProxy is captured lazily.
                const innerTarget = { [QUERY_TARGET]: true };
                const innerProxy = new Proxy(innerTarget, { ...lookupProxy, query: [[]] });
                // fn.length is the number of arguments in fn
                // execute the subquery
                const result = fn.length >= 2 ? fn(innerProxy, self) : fn(innerProxy);
                // Terminated sub-chain (._$ or .$): result is {query, enforceLen}
                // Unterminated sub-chain (legacy): result is still a proxy, throw an error
                const queries = result.query;
                if (queries === undefined) {
                    throw new Error("Unterminated inner query, nested queries must be terminate with either a .$ or ._$");
                }
                // Whether the inner query enforces length
                const enforceLen = result.enforceLen ?? false;
                // Set selfFn to execute this over again
                selfFn = makeQueryFn((ctx) => {
                    if (ctx.term.$TYPE !== ELEMENT_TYPE.SENTENCE) return -1;
                    return queries.some(q => resolveQuery(ctx.term, q, enforceLen)) ? 1 : -1;
                });
                return selfFn;
            };
            if (/^_\d+$/g.test(p)) {
                // Returns ops[][] — multiple alternative wildcard sequences of lengths 0..N
                let length = parseInt(p.slice(1));
                if (isNaN(length)) throw new Error("Cannot parse number in: " + p);
                ++length;
                return Array.from({ length }, (_, i) => Array.from({ length: i }, () => queryOps._));
            }
            return compareSym(p);
        }
    });
}

// Singleton: one accessor proxy for the entire module lifetime.
// lookupProxy.get() called this per property access before; now it's free.
_accessor = buildAccessor();

/**
 * A proxy to enable sentence querying. Wraps a Set<Sentence>,
 *  query it using lookup.A.B.C.$ which would match any sentence
 *  (A B C).
 *
 * Use "$_" to match any number of terms until the next term is found
 *
 * Use "_" for wildcard (i.e. lookup._.B.C.$ as a wildcard
 *  would matches anything with three arguments where the last
 *  two args are symbols B and C)
 *
 * Use "_L(literal)" to search for literal values
 *
 * Use _X to consume up to and including X number of wildcards,
 *  (i.e. lookup._2.A.$ would match any sentence where A appears in the
 *  first (X = 0) second (X = 1) or third slot (X = 2) and the sentence
 *  does not exceed three terms).
 *
 * Use "_OP_" to match any operator (and, exists, =>, etc.)
 *
 * Use "_SYM_" to match any symbol (i.e. not an operator or variable)
 *
 * Use "_VAR_" to match any variable
 *
 * Use "_LIT_" to match any literal (string or number)
 *
 * [TODO] Use _S() to match any sentence, providing a function argument will
 *  match sentences which match that query (i.e. _S(l => l._.A._) will
 *  match the sentence _.A._). Alternatively, an argument which takes
 *  two arguments will receive a reference to the the query itself,
 *  allowing for recurssive queries 
 *  (i.e. _S((l, q) => l._._ANY(_S(q), "test")._)) will look for 
 *  the symbol "test" recurssively in sub-sentences 
 *
 * Use "_$" to close the query and match all terms with AT LEAST as
 *  many terms were queried (i.e. lookup._._$ would query all sentences
 *  with at least one term)
 *
 * Use "$" to close the query and match all terms with EXACTLY as many
 *  terms were queried (i.e. lookup._.$ would match all sentences with
 *  exactly 1 term)
 *
 *
 * To run the search "any sentence which includes the term A" use:
 *  lookup.$_.A._$
 * @type {{
 *  query: (QueryFunction)[][],
 *  stack: (target: Set<Sentence>, ops: (QueryFunction)[][]) => Proxy,
 * }}
 */
let lookupProxy = {
    query: [[]], // Keep track of the current query
    /**
     * When true, native Set properties (forEach, size, has, …) are forwarded
     * to the underlying Set instead of being treated as query steps. This lets
     * debuggers and test-assertion libraries inspect the proxy, but means any
     * KIF symbol that shares a name with a Set method will be unreachable.
     * Disabled by default so that queries always take precedence.
     */
    debug: false,
    /**
     *
     * @param {Set<Sentence>} target
     * @param {[QueryFunction[]]} ops
     * @returns {Proxy}
     */
    stack(target, ops) {
        // Fast path for the common case: one existing query branch, one new op.
        // Avoids the map/flat intermediate arrays that the general case produces.
        let query;
        if (this.query.length === 1 && ops.length === 1) {
            query = [this.query[0].concat(ops[0])];
        } else {
            query = this.query.flatMap(q => ops.map(o => q.concat(o)));
        }

        return new Proxy(
            target,
            { ...lookupProxy, query, debug: this.debug }
        );
    },
    /**
     * @param {Set<Sentence>} target
     * @param {string} prop
     * @returns {Proxy|Set<Sentence>}
     */
    get(target, prop) {
        // Always pass through JS Symbol keys — they can never be KIF symbols
        if (typeof prop !== 'string') return target[prop];
        // In debug mode, forward native Set properties so that debuggers and
        // test-assertion libraries can inspect the proxy without triggering
        // query logic. Disabled by default to avoid shadowing KIF symbols.
        if (this.debug && prop in target) {
            const val = Reflect.get(target, prop);
            return typeof val === 'function' ? val.bind(target) : val;
        }
        // Proxy-only: query meta and execution
        if (prop == "$query") return this.query;
        if (prop == "$" || prop == "_$") {
            const enforceLen = prop === "$";
            // Inner _S chain proxy: capture the query instead of executing it
            if (QUERY_TARGET in target) return { query: this.query, enforceLen };
            const output = new Set();
            for (const sentence of target) {
                for (const query of this.query) {
                    if (resolveQuery(sentence, query, enforceLen)) {
                        output.add(sentence);
                        break;
                    }
                }
            }
            return output;
        }
        // All step resolution is delegated to the singleton accessor.
        const step = _accessor[prop];
        // _N numeric wildcard returns ops[][] (multiple alternative sequences)
        if (Array.isArray(step)) return this.stack(target, step);
        // Factory ops (_L, _OP, _ANY) return a function that produces a QueryFunction
        if (prop === '_L' || prop === '_OP' || prop === '_ANY' || prop === '_S') {
            return (...args) => this.stack(target, [[step(...args)]]);
        }
        // Direct QueryFunction (primitive ops from queryOps or a named symbol)
        return this.stack(target, [[step]]);
    }
}

// Shared empty Set used when an index lookup finds no bucket.
// Frozen so no one accidentally mutates it.
const EMPTY_SET = Object.freeze(new Set());

/**
 * A single-term wildcard QueryFunction used as the leading step in
 * index-optimised proxies.  When the head term has already been filtered by
 * the index, this consumes it so that subsequent user steps align to terms[1],
 * terms[2], etc. — exactly what compareSym would have done, minus the filter.
 * @type {QueryFunction}
 */
const SKIP_HEAD = (_ctx) => 1;

/**
 * Create the initial lookup proxy for a SymbolTable.
 *
 * Supports two indexing levels controlled by the `index2` parameter:
 *
 *   Level 1 — head-predicate index (always active):
 *     `lookup.subclass` → proxy over only the ~800 subclass sentences
 *     instead of scanning all 5,000+.
 *
 *   Level 2 — argument-position index (when index2 is non-null):
 *     After a level-1 lookup, the returned proxy tracks which predicates
 *     were selected and intercepts the *next* named-symbol step too.
 *     `lookup.subclass.Human` → proxy over the 1-3 sentences where
 *     terms[1] === "Human", instead of scanning all 800 subclass sentences.
 *     `lookup._ANY(tRels)._SYM_.Animal` → proxy over the 1-3 sentences
 *     where terms[2] === "Animal" across all taxonomy relations.
 *
 *   Queries whose first step is a wildcard (_SYM_, $_, _OP, _L, _S, …)
 *   fall through to the standard lookupProxy and scan all sentences.
 *
 * @param {Set<import('./sentence').Sentence>} sentences  The full sentence set
 * @param {Map<string, Set<import('./sentence').Sentence>>} index
 *   Head-symbol name → Set of root sentences with that predicate.
 * @param {Map<string, {a1: Map<string,Set>, a2: Map<string,Set>}>|null} index2
 *   Deep argument index: predicate → { a1: terms[1]→Set, a2: terms[2]→Set }.
 *   Pass null to disable level-2 indexing.
 * @returns {Proxy}
 */
function createIndexedLookup(sentences, index, index2) {
    // ── shared query prefixes ────────────────────────────────────────────────
    // SKIP_HEAD × N means "N head/arg positions already filtered by the index;
    // skip them so subsequent user steps address the correct term slot."
    const SKIPPED_1 = [[SKIP_HEAD]];           // after level-1 lookup
    const SKIPPED_2 = [[SKIP_HEAD, SKIP_HEAD]]; // after level-2 lookup

    // ── level-2 aware handler ────────────────────────────────────────────────
    // Used for proxies that emerged from a level-1 (or _ANY) lookup and
    // therefore know which predicates their sentences came from.  This handler
    // intercepts named-symbol steps and uses index2 to narrow the bucket
    // further.  It also overrides stack() to propagate the predicate context
    // through wildcard steps (so lookup._ANY(rels)._SYM_.name still works).
    const predicateHandler = {
        ...lookupProxy,
        /** @type {string[]|null} Which predicates are represented in this proxy */
        predicates: null,

        /**
         * Override stack() so that the `predicates` context survives wildcard
         * steps (e.g. ._SYM_) between the level-1 and level-2 lookups.
         */
        stack(target, ops) {
            let query;
            if (this.query.length === 1 && ops.length === 1) {
                query = [this.query[0].concat(ops[0])];
            } else {
                query = this.query.flatMap(q => ops.map(o => q.concat(o)));
            }
            // Preserve predicates in the next proxy so level-2 can still fire.
            return new Proxy(target, {
                ...predicateHandler,
                predicates: this.predicates,
                query,
                debug: this.debug,
            });
        },

        get(target, prop) {
            if (typeof prop !== 'string') return target[prop];
            if (prop === '$query') return this.query;
            if (prop === '$' || prop === '_$') {
                return lookupProxy.get.call(this, target, prop);
            }

            // ── level-2 lookup ───────────────────────────────────────────────
            // Fire when: index2 is enabled, we know the predicates, the prop is
            // a plain symbol name, and the query depth tells us which argument
            // slot to look in (depth 1 → terms[1], depth 2 → terms[2]).
            if (index2 && this.predicates && prop[0] !== '_' && prop[0] !== '$') {
                // query[0].length === depth of steps accumulated so far.
                // depth 1: just SKIP_HEAD → next slot is terms[1] → use a1
                // depth 2: SKIP_HEAD + one more step → next slot is terms[2] → use a2
                const depth = this.query.length === 1 ? this.query[0].length : -1;
                const slot = depth === 1 ? 'a1' : depth === 2 ? 'a2' : null;

                if (slot) {
                    const merged = new Set();
                    for (const pred of this.predicates) {
                        const sub = index2.get(pred)?.[slot]?.get(prop);
                        if (sub) for (const s of sub) merged.add(s);
                    }
                    // Append one more SKIP_HEAD to account for the slot we just
                    // consumed via the index, then return a plain lookupProxy proxy
                    // (predicates no longer needed; the bucket is already tiny).
                    const nextQuery = [this.query[0].concat([SKIP_HEAD])];
                    return new Proxy(merged, { ...lookupProxy, query: nextQuery });
                }
            }

            // Fall through to standard behaviour (step is a wildcard, depth
            // is beyond what we index, or index2 is disabled).
            return lookupProxy.get.call(this, target, prop);
        },
    };

    // ── root (level-1) handler ───────────────────────────────────────────────
    // Intercepts the very first step of every lookup.
    const rootHandler = {
        ...lookupProxy,
        get(target, prop) {
            if (typeof prop !== 'string') return target[prop];
            if (prop === '$query') return this.query;
            if (prop === '$' || prop === '_$') {
                return lookupProxy.get.call(this, target, prop);
            }

            // ── _ANY ─────────────────────────────────────────────────────────
            if (prop === '_ANY') {
                return (...args) => {
                    if (args.length > 0 && args.every(a => typeof a === 'string')) {
                        // Union level-1 buckets for all named predicates.
                        const merged = new Set();
                        for (const name of args) {
                            const bucket = index.get(name);
                            if (bucket) for (const s of bucket) merged.add(s);
                        }
                        // Return a predicate-aware proxy so level-2 can fire
                        // on the next named-symbol step.
                        return new Proxy(merged, {
                            ...predicateHandler,
                            predicates: args,
                            query: SKIPPED_1,
                        });
                    }
                    // Non-string args (builder fns for _S, etc.) — standard path.
                    return this.stack(target, [[_accessor._ANY(...args)]]);
                };
            }

            // ── plain symbol name ─────────────────────────────────────────────
            // Level-1 lookup: swap the full sentence set for the predicate bucket.
            if (prop[0] !== '_' && prop[0] !== '$') {
                const bucket = index.get(prop) ?? EMPTY_SET;
                return new Proxy(bucket, {
                    ...predicateHandler,
                    predicates: [prop],
                    query: SKIPPED_1,
                });
            }

            // ── everything else ───────────────────────────────────────────────
            return lookupProxy.get.call(this, target, prop);
        },
    };

    return new Proxy(sentences, rootHandler);
}

module.exports = {
    lookupProxy,
    createIndexedLookup,
}
