'use strict';

/**
 * Persistent parser cache for SUMO symbol tables.
 *
 * Stores a serialized SymbolTable (from src/parser/serialization.js) in
 * globalStorageUri so it survives VS Code restarts.  The cache is keyed by
 * a SHA-256 hash of config.xml + every constituent file's content, so any
 * change to the KB (adding/removing/editing files, editing config.xml)
 * automatically produces a different hash and the stale entry is ignored.
 *
 * Public API:
 *   setContext(ctx)                                          – call once in activate()
 *   tryLoadCache(kbName, configPath, filePaths)              – returns { symbolTable, diagnostics } | null
 *   trySaveCache(kbName, configPath, filePaths, st, diags)  – fire-and-forget persist
 */

const vscode = require('vscode');

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const { serialize, deserialize } = require('./parser');

/**
 * @typedef {{ sl: number, sc: number, el: number, ec: number, msg: string, sev: number }} SerializedDiagnostic
 */

// ── State ─────────────────────────────────────────────────────────────────────

/** @type {import('vscode').ExtensionContext | null} */
let _context = null;

/**
 * Provide the VS Code extension context so that globalState and
 * globalStorageUri become available to the cache layer.
 * @param {import('vscode').ExtensionContext} context
 */
function setContext(context) {
    _context = context;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Turn a KB name into a safe filename component (ASCII letters, digits, _ -).
 * @param {string} name
 * @returns {string}
 */
function sanitize(name) {
    return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Return (and create if necessary) the directory under globalStorageUri used
 * for cache files.  Returns null if the context is not yet set.
 * @returns {string | null}
 */
function cacheDir() {
    if (!_context) return null;
    const dir = path.join(_context.globalStorageUri.fsPath, 'parserCache');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

/**
 * Compute a SHA-256 fingerprint of a KB, covering:
 *  1. The raw content of config.xml (so renaming/adding KBs invalidates caches)
 *  2. The sorted list of constituent file paths (so adding/removing files matters)
 *  3. The raw content of every constituent file that exists on disk
 *
 * @param {string}   configPath  Absolute path to config.xml
 * @param {string[]} filePaths   Absolute paths of all constituent files
 * @returns {string}  Hex digest
 */
function computeHash(configPath, filePaths) {
    const h = crypto.createHash('sha256');

    // config.xml content
    try { h.update(fs.readFileSync(configPath)); } catch (_) {}

    // constituent files — sort for determinism across platforms
    for (const p of [...filePaths].sort()) {
        h.update(p);                                     // path itself (catches renames)
        try { h.update(fs.readFileSync(p)); } catch (_) {}  // file content
    }

    return h.digest('hex');
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Attempt to load a pre-built SymbolTable and diagnostics from the persistent cache.
 *
 * The cache is valid only when the stored hash for `kbName` matches the hash
 * of the current config.xml + constituent file contents.  If the cache is
 * absent, malformed, or stale, null is returned and the caller must do a
 * full parse.
 *
 * @param {string}   kbName      Name of the knowledge base
 * @param {string}   configPath  Absolute path to config.xml
 * @param {string[]} filePaths   Absolute paths of all constituent files
 * @returns {{ 
 *   symbolTable: import('./parser/symbol').SymbolTable,
 *   diagnostics: {[fsPath: string]: vscode.Diagnostic[]}
 * } | null}
 *   `diagnostics` is a plain map of `{ [fsPath]: PlainDiagnostic[] }` where each
 *   PlainDiagnostic is `{ sl, sc, el, ec, msg, sev }`.  The caller is responsible
 *   for converting these back to vscode.Diagnostic objects.
 */
function tryLoadCache(kbName, configPath, filePaths) {
    if (!_context) return null;
    const dir = cacheDir();
    if (!dir) return null;

    // Fast check: compare stored hash with current hash before touching the file
    const currentHash = computeHash(configPath, filePaths);
    const storedHash  = _context.globalState.get(`sumo.parserCache.${kbName}`);
    if (storedHash !== currentHash) return null;

    const cacheFile = path.join(dir, `${sanitize(kbName)}.json`);
    if (!fs.existsSync(cacheFile)) return null;

    try {
        const data = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
        // Support both the new wrapped format { st, diag } and the old format
        // (bare SymbolTable JSON with a top-level "version" key) so that stale
        // files from a previous extension version fail gracefully.
        const stJson = data.st ?? data;
        const symbolTable = deserialize(stJson);
        const diagnostics = deserializeKBDiagnostics(data.diag ?? {});
        console.log(`[SUMO] Loaded parser cache for KB "${kbName}" (${Object.keys(symbolTable.symbols).length} symbols)`);
        return { symbolTable, diagnostics };
    } catch (e) {
        // Corrupted cache — fall through to full parse
        console.error(`[SUMO] Discarding corrupt parser cache for KB "${kbName}":`, e.message);
        return null;
    }
}

/**
 * Persist a SymbolTable and its associated diagnostics to disk, then record
 * the content hash in globalState.
 * This is intentionally fire-and-forget: failures are logged but not thrown.
 *
 * The actual I/O runs via setImmediate so the UI can update before the
 * synchronous JSON.stringify blocks the event loop.
 *
 * @param {string}   kbName
 * @param {string}   configPath
 * @param {string[]} filePaths
 * @param {import('./parser/symbol').SymbolTable} symbolTable
 * @param {{[fsPath: string]: import('vscode').Diagnostic[]}} diagnostics
 */
function trySaveCache(kbName, configPath, filePaths, symbolTable, diagnostics = {}) {
    if (!_context) return;
    const dir = cacheDir();
    if (!dir) return;

    // Defer the CPU-heavy work so the UI can update first
    setImmediate(async () => {
        try {
            const data = { st: serialize(symbolTable), diag: serializeKBDiagnostics(diagnostics) };
            const str  = JSON.stringify(data);
            const cacheFile = path.join(dir, `${sanitize(kbName)}.json`);
            fs.writeFileSync(cacheFile, str);

            // Only persist the hash after the file is safely written
            const hash = computeHash(configPath, filePaths);
            await _context.globalState.update(`sumo.parserCache.${kbName}`, hash);
            console.log(`[SUMO] Saved parser cache for KB "${kbName}" (${(str.length / 1024).toFixed(0)} KB)`);
        } catch (e) {
            console.error(`[SUMO] Failed to save parser cache for KB "${kbName}":`, e.message);
        }
    });
}

/**
 * Compact a vscode.Diagnostic to a plain JSON-safe object.
 * @param {import('vscode').Diagnostic} d
 * @returns {SerializedDiagnostic}
 */
function serializeDiagnostic(d) {
    return {
        sl:  d.range.start.line,
        sc:  d.range.start.character,
        el:  d.range.end.line,
        ec:  d.range.end.character,
        msg: d.message,
        sev: d.severity,
    };
}

/**
 * Reconstruct a vscode.Diagnostic from the plain object produced by serializeDiagnostic.
 * @param {SerializedDiagnostic} obj
 * @returns {import('vscode').Diagnostic}
 */
function deserializeDiagnostic(obj) {
    return new vscode.Diagnostic(
        new vscode.Range(
            new vscode.Position(obj.sl, obj.sc),
            new vscode.Position(obj.el, obj.ec)
        ),
        obj.msg,
        obj.sev
    );
}

/**
 * @param {{ [fsPath: string]: vscode.Diagnostic[] }} diagnostics
 * @return {{ [file: string]: SerializedDiagnostic[] }}
 */
function serializeKBDiagnostics(diagnostics) {
    /** @type {{ [file: string]: SerializedDiagnostic[] }} */
    const cachedDiags = {};
    for (const fsPath in diagnostics) {
        cachedDiags[fsPath] = diagnostics[fsPath].map(serializeDiagnostic);
    }
    return cachedDiags;
}

/**
 * @param {{ [file: string]: SerializedDiagnostic[] }} cachedDiags
 * @returns {{[fsPath: string]: vscode.Diagnostic[]}}
 */
function deserializeKBDiagnostics(cachedDiags) {
    /** @type {{[fsPath: string]: vscode.Diagnostic[]}} */
    const diagnostics = {};
    for (const fsPath in cachedDiags) {
        diagnostics[fsPath] = cachedDiags[fsPath].map(deserializeDiagnostic);
    }
    return diagnostics;
}

module.exports = {
    setContext,
    computeHash,
    tryLoadCache,
    trySaveCache,
};
