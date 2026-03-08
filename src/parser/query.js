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

module.exports = {
    lookupProxy,
}
