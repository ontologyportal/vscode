'use strict';

/**
 * JSON serialization and deserialization for SymbolTable.
 *
 * serialize(symbolTable) → plain JSON-compatible object
 * deserialize(json, opts?) → fully reconstructed SymbolTable with pre-populated caches
 *
 * The serialized format includes:
 *  - AST nodes for every root sentence (compact representation)
 *  - The deepIndex flag
 *  - Cached Term getter values (with Term references replaced by symbol names)
 *
 * Cached Term values are restored verbatim so that the first property access
 * after deserialization is instant rather than recomputing from scratch.
 * The 'locations' cache entry is skipped because it holds live Sentence objects.
 */

const { NodeType, ASTListNode, ASTTermNode } = require('./parser');
const { TokenType, Token } = require('./tokenizer');
const { SymbolTable } = require('./symbol');
const { Term, TaxonomyEdge } = require('./term');

const SERIAL_VERSION = 1;

/** Maps NodeType → TokenType for reconstructing ASTTermNode tokens. */
const NODE_TO_TOKEN_TYPE = {
    [NodeType.ATOM]:         TokenType.ATOM,
    [NodeType.OPERATOR]:     TokenType.OPERATOR,
    [NodeType.STRING]:       TokenType.STRING,
    [NodeType.NUMBER]:       TokenType.NUMBER,
    [NodeType.VARIABLE]:     TokenType.VARIABLE,
    [NodeType.ROW_VARIABLE]: TokenType.ROW_VARIABLE,
};

// ── AST node serialization ────────────────────────────────────────────────────

/**
 * Serialize a single AST node to a compact plain object.
 * List nodes use key 'L'; term nodes use their NodeType string as the key 'k'.
 * The `file` field is omitted when it matches `defaultFile`.
 *
 * @param {import('./parser').ASTNode} node
 * @param {string} defaultFile
 * @returns {object}
 */
function serializeNode(node, defaultFile) {
    if (node.type === NodeType.LIST) {
        const obj = {
            k: 'L',
            sl: node.startToken.line,
            sc: node.startToken.column,
            so: node.startToken.offset,
            el: node.endToken.line,
            ec: node.endToken.column,
            eo: node.endToken.offset,
            c:  node.children.map(child => serializeNode(child, defaultFile)),
        };
        if (node.file !== defaultFile) obj.f = node.file;
        return obj;
    }
    const obj = {
        k:  node.type,
        v:  node.startToken.value,
        sl: node.startToken.line,
        sc: node.startToken.column,
        so: node.startToken.offset,
    };
    if (node.file !== defaultFile) obj.f = node.file;
    return obj;
}

/**
 * Reconstruct an AST node from its serialized compact form.
 *
 * @param {object} obj
 * @param {string} defaultFile  File name used when `obj.f` is absent
 * @returns {import('./parser').ASTNode}
 */
function deserializeNode(obj, defaultFile) {
    const file = obj.f !== undefined ? obj.f : defaultFile;
    if (obj.k === 'L') {
        const startTok = new Token(TokenType.LPAREN, obj.sl, obj.sc, obj.so, '(', file);
        const node = new ASTListNode(startTok);
        for (const child of obj.c) {
            node.children.push(deserializeNode(child, file));
        }
        const endTok = new Token(TokenType.RPAREN, obj.el, obj.ec, obj.eo, ')', file);
        node.setEnd(endTok);
        return node;
    }
    const tokType = NODE_TO_TOKEN_TYPE[obj.k];
    const token   = new Token(tokType, obj.sl, obj.sc, obj.so, obj.v, file);
    return new ASTTermNode(obj.k, token);
}

// ── Term cache serialization ──────────────────────────────────────────────────

/**
 * Serialize a Term's `_cache` object to a JSON-safe form.
 * Term references are replaced with the Term's symbol name (a string).
 * The `locations` entry is skipped because it contains live Sentence objects.
 *
 * @param {object} cache  The raw `_cache` object from a Term instance
 * @returns {object}
 */
function serializeCache(cache) {
    const out = Object.create(null);
    for (const key of Object.keys(cache)) {
        if (key === 'locations') continue;
        const val = cache[key];

        if (val === null || typeof val !== 'object') {
            // Primitives: boolean, number, string, null
            out[key] = val;
        } else if (key === 'taxonomy') {
            out[key] = {
                incoming: val.incoming.map(e => ({ from: e.from.name, relation: e.relation })),
                outgoing: val.outgoing.map(e => ({ to: e.to.name, relation: e.relation })),
            };
        } else if (key === 'domain' || key === 'domainSubclass') {
            // Term[] | null  →  (string|null)[] | null
            out[key] = val.map(t => (t ? t.name : null));
        } else if (key === 'range' || key === 'rangeSubclass') {
            // Term | null  →  string | null
            out[key] = val ? val.name : null;
        } else if (Array.isArray(val)) {
            // documentation, format, termFormat — arrays of plain {language, text} objects
            out[key] = val;
        }
        // Unknown object shapes are omitted (safe default: will be recomputed).
    }
    return out;
}

/**
 * Restore a Term's `_cache` from its serialized form.
 * Symbol name strings are resolved back to live Term objects via `symbolTable`.
 *
 * @param {object}      serialized  Output of serializeCache()
 * @param {Term}        thisTerm    The Term whose cache is being restored
 * @param {SymbolTable} symbolTable The fully reconstructed SymbolTable
 * @returns {object}  A restored _cache object
 */
function deserializeCache(serialized, thisTerm, symbolTable) {
    const cache = Object.create(null);

    /** Resolve a symbol name to its Term, creating one if necessary. */
    function resolveTerm(name) {
        const sym = symbolTable.symbols[name];
        if (!sym) return null;
        return sym.forward;
    }

    for (const key of Object.keys(serialized)) {
        const val = serialized[key];

        if (val === null || typeof val !== 'object') {
            cache[key] = val;
        } else if (key === 'taxonomy') {
            cache[key] = {
                incoming: val.incoming.map(e =>
                    new TaxonomyEdge(resolveTerm(e.from), thisTerm, e.relation)),
                outgoing: val.outgoing.map(e =>
                    new TaxonomyEdge(thisTerm, resolveTerm(e.to), e.relation)),
            };
        } else if (key === 'domain' || key === 'domainSubclass') {
            cache[key] = val.map(name => (name !== null ? resolveTerm(name) : null));
        } else if (key === 'range' || key === 'rangeSubclass') {
            cache[key] = val !== null ? resolveTerm(val) : null;
        } else if (Array.isArray(val)) {
            cache[key] = val;
        } else {
            cache[key] = val;
        }
    }
    return cache;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Serialize a SymbolTable to a JSON-compatible plain object.
 *
 * The result can be passed to `JSON.stringify()` and later restored with
 * `deserialize(JSON.parse(...))`.
 *
 * Serialization includes:
 *  - All root sentences (compact AST representation)
 *  - Whether the deep index was enabled
 *  - Cached Term property values (skipping `locations`)
 *
 * @param {SymbolTable} symbolTable
 * @returns {object}
 */
function serialize(symbolTable) {
    const deepIndex = symbolTable._index2 !== null;

    // Root sentences — each entry carries its source file and the root AST node.
    const sentences = [];
    for (const sentence of symbolTable.sentences) {
        const file = sentence.node.file;
        sentences.push({ f: file, n: serializeNode(sentence.node, file) });
    }

    // Term caches — only symbols that have an attached forward Term with cached data.
    const terms = Object.create(null);
    for (const [name, sym] of Object.entries(symbolTable.symbols)) {
        if (!sym.forward) continue;
        const serialized = serializeCache(sym.forward._cache);
        if (Object.keys(serialized).length > 0) {
            terms[name] = serialized;
        }
    }

    return { version: SERIAL_VERSION, deepIndex, sentences, terms };
}

/**
 * Reconstruct a SymbolTable from a serialized plain object.
 *
 * After deserialization:
 *  - All root sentences are present with correct structure and indexes
 *  - Every symbol has a forward Term pointer
 *  - Cached Term property values are pre-populated (same as after a full
 *    kif() + semantics() + validate-all pass)
 *
 * @param {object}                       json  Output of serialize()
 * @param {{ deepIndex?: boolean }}      [opts] Override the deepIndex flag
 * @returns {SymbolTable}
 */
function deserialize(json, opts = {}) {
    if (json.version !== SERIAL_VERSION) {
        throw new Error(`Unsupported serialization version: ${json.version}`);
    }

    const deepIndex = opts.deepIndex !== undefined ? opts.deepIndex : json.deepIndex;
    const symbolTable = new SymbolTable({ deepIndex });

    // Phase 1: reconstruct sentences.
    // Rebuilding AST nodes and calling symbolTable.sentence() recreates all
    // Symbol objects, indexes, and scope chains exactly as after kif().
    for (const entry of json.sentences) {
        const node = deserializeNode(entry.n, entry.f);
        try {
            symbolTable.sentence(node, null);
        } catch (_) {
            // Malformed entry in a valid serialization is unexpected; skip it.
        }
    }

    // Phase 2: create Terms for all symbols.
    // new Term(sym) sets sym.forward as a side effect.
    for (const sym of Object.values(symbolTable.symbols)) {
        if (!sym.forward) new Term(sym);
    }

    // Phase 3: freeze the epoch reference point.
    // Reading symbolTable.epoch (a) returns the current epoch value and
    // (b) sets cat=true so that any future symbolTable.sentence() call will
    // properly increment the epoch and invalidate caches.
    const currentEpoch = symbolTable.epoch;

    // Phase 4: restore Term caches.
    // Setting term._epoch = currentEpoch ensures _getCache sees the cache as
    // valid until the SymbolTable is next modified.
    for (const [name, serializedCache] of Object.entries(json.terms)) {
        const sym = symbolTable.symbols[name];
        if (!sym || !sym.forward) continue;
        const term = sym.forward;
        term._cache = deserializeCache(serializedCache, term, symbolTable);
        term._epoch = currentEpoch;
    }

    return symbolTable;
}

module.exports = { serialize, deserialize };
