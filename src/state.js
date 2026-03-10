/** Central state management module for the current knowledge bases */

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

const { findConfigXml, parseConfigXml } = require('./sigma/config');
const {
    setContext: setCacheContext,
    tryLoadCache,
    trySaveCache
} = require('./parser-cache');
const {
    tokenize,
    parse,
    syntax,
    semantics,
    validateSemantics, 
    validateBestPractices,
    validateFileDependencies
} = require('./validation');
const { Term, SymbolTable } = require('./parser');

// Global state variables

/**
 * Semantic terms produced by syntax() + semantics() for each processed file.
 * Populated by updateFileDefinitions(); consumed by getWorkspaceTaxonomy(),
 * getWorkspaceMetadata(), and any future feature that needs the full model.
 * @type {{
 *   [kb: string]: {
 *     [name: string]: Term
 *   }
 * }}
 */
let terms = {};

/**
 * Per-KB symbol tables, needed for per-file updates and reanalysis.
 * Each KB gets its own isolated SymbolTable so cross-KB references
 * (e.g. circular dependency detection) are never falsely reported.
 * @type {{[kb: string]: SymbolTable}}
 */
let _symbolTables = {};

/**
 * Per-KB metadata cache (invalidated on file update or KB switch).
 * @type {{[kb: string]: object}}
 */
let workspaceMetadataCache = {};

/**
 * Per-KB, per-file diagnostics recorded during the most recent full parse.
 * Stored as plain objects so they can be JSON-serialised by the cache layer.
 * Shape: `{ [kb]: { [fsPath]: PlainDiagnostic[] } }` where PlainDiagnostic is
 * `{ sl, sc, el, ec, msg, sev }`.
 * @type {{[kb: string]: {[fsPath: string]: vscode.Diagnostic[]}}}
 */
let _diagnosticsCache = {};

/**
 * Global diagnostics collection
 * @type {vscode.DiagnosticCollection}
 */
let diagnosticCollection;

/**
 * Forward the VS Code extension context to the parser cache layer so that
 * globalState and globalStorageUri are available for cache read/write.
 * Must be called once, early in the extension's activate() function.
 * @param {vscode.ExtensionContext} context
 */
function setExtensionContext(context) {
    setCacheContext(context);
}

/**
 * Set a global diagnostic collection
 * @param {vscode.DiagnosticCollection} collection
 */
function setDiagnosticCollection(collection) {
    diagnosticCollection = collection;
}

/**
 * Get the global diagnostic collection
 * @returns {vscode.DiagnosticCollection|null}
 */
function getDiagnosticCollection() {
    return diagnosticCollection;
}

/**
 * The current knowledge base
 * @type {string}
 */
let currentKB = null;

/**
 * Set the current KB being browsed
 * @param {string} kb The name of the KB
 */
function setKB(kb) {
    currentKB = kb;
    delete workspaceMetadataCache[kb]; // force re-computation for the newly active KB
}

/**
 * Get the current KB being browsed
 * @returns {string|null} The name of the current KB
 */
function getKB() {
    return currentKB;
}

/**
 * Set the compiled terms
 * @param {string} kb The KB to set the terms for
 * @param {{[name: string]: Term}} newTerms The new terms to inject
 */
function setTerms(kb, newTerms) {
    if (!(kb in terms)) terms[kb] = {};
    Object.assign(terms[kb], newTerms);
}

/**
 * Get the compiled terms mapping
 * @param {string} kb The KB to get the terms for
 * @returns {{[name: string]: Term}} The terms
 */
function getTerms(kb) {
    return terms[kb];
}

/**
 * Clears the terms cache
 * @param {string?} kb The KB to clear the terms for (if null, clear all)
 */
function clearTerms(kb) {
    if (kb) {
        delete terms[kb];
    } else {
        terms = {};
    }
}

/**
 * Get the symbol table for the given KB (or the current KB if omitted).
 * @param {string} [kb]
 * @returns {SymbolTable|undefined}
 */
function getSymbolTable(kb) {
    return _symbolTables[kb ?? currentKB];
}

/**
 * Get all knowledge bases in the current context
 * @returns {Promise<string[]>}
 */
async function getKBs() {
    const configPath = await findConfigXml();
    if (configPath) {
        const parsed = await parseConfigXml(configPath);
        if (parsed) {
            return Object.keys(parsed.knowledgeBases).flat();
        }
    }
    return [];
}

/**
 * Get all the files for a KB
 * @param {undefined | string} kbName Whether to fetch a specific KB's files
 * @returns {Promise<vscode.Uri[]>}
 */
async function getKBFiles(kbName = undefined) {
    if (!kbName) kbName = currentKB;
    if (!kbName) return [];
    const configPath = await findConfigXml();
    if (configPath) {
        const parsed = await parseConfigXml(configPath);
        if (parsed) {
            const kbDir = parsed.preferences.kbDir || path.dirname(configPath);
            const seen = new Set();
            const uris = [];
            if (!(kbName in parsed.knowledgeBases)) {
                throw new Error("Could not find kb");
            }
            const kb = parsed.knowledgeBases[kbName];
            for (const c of kb.constituents) {
                const abs = path.isAbsolute(c) ? c : path.join(kbDir, c);
                if (!seen.has(abs) && fs.existsSync(abs)) {
                    seen.add(abs);
                    uris.push(vscode.Uri.file(abs));
                }
            }
            if (uris.length > 0) return uris;
        }
    }
    return [];
}

/**
 * Aggregate hover/completion metadata (domains and documentation) across all files.
 * @returns {{ [symbol: string]: { domains: {[pos: number]: string}, documentation: string, docLang: string } }}
 */
function getWorkspaceMetadata() {
    if (workspaceMetadataCache[currentKB]) return workspaceMetadataCache[currentKB];

    const combined = {};
    const targetLang = vscode.workspace.getConfiguration('sumo').get('general.language') || 'EnglishLanguage';
    const kbTable = _symbolTables[currentKB];
    if (!kbTable) return combined;

    for (const [name, sym] of Object.entries(kbTable.symbols)) {
        if (!sym.forward) continue;
        const term = sym.forward;
        combined[name] = { domains: {}, documentation: '', docLang: '' };
        const entry = combined[name];

        try {
            const domain = term.domain;
            if (domain) {
                for (let i = 0; i < domain.length; i++) {
                    if (domain[i]) entry.domains[i] = domain[i].name;
                }
            }
        } catch (_) {
            // Malformed domain statement — skip domain info for this term
        }

        for (const { language, text } of term.documentation) {
            let docText = text;
            if (docText.startsWith('"') && docText.endsWith('"')) {
                docText = docText.substring(1, docText.length - 1);
            }
            if (!entry.documentation || language === targetLang || entry.docLang !== targetLang) {
                entry.documentation = docText;
                entry.docLang = language;
            }
        }
    }

    workspaceMetadataCache[currentKB] = combined;
    return combined;
}

/**
 * Perform full preparsing of the files in all the KBs and their constituents,
 * then compile the definitions from the AST nodes. This method will reconstruct
 * everything, clearing the term cache.
 *
 * When a valid parser cache exists for a KB (the stored hash of config.xml +
 * constituent file contents matches the current state), the serialized
 * SymbolTable is loaded from disk instead of re-parsing.  After a cache miss
 * the freshly built SymbolTable is persisted for the next session.
 *
 * @param {{ report: (value: { message?: string }) => void } | undefined} progress
 *   Optional VS Code progress reporter. When provided, reports "n/total" after
 *   each file is processed.
 * @param {boolean} reset Whether to reset the workspace first
 * @param {{kb: string, file: vscode.Uri}[] | null} select Whether to only build specific 
 *  KB/files. Pass null for everything. Pass { kb: STRING, file: NULL } for all files 
 *  in a KB
 * @param {boolean} noCache Whether to ignore cached state
 */
async function buildWorkspaceDefinitions(progress, reset = true, select = null, noCache = false) {
    // Resolve config path once; needed for hash computation.
    const configPath = await findConfigXml();
    const kbs = await getKBs();

    /** @type { Map<string, vscode.Uri[] } */
    const selectedFiles = select == null ? 
        null 
        : select.reduce(
            (map, { kb, file }) => map.set(kb, [...(map.get(kb) ?? []), file]),
            new Map()
        );

    if (reset) {
        // Reset everything
        clearTerms();
        _symbolTables = {};
        workspaceMetadataCache = {};
        _diagnosticsCache = {};
    }

    // Pre-collect all files so we can show an accurate total in the progress message.
    const kbFiles = [];
    for (const kb of kbs) {
        let files = await getKBFiles(kb);
        if (selectedFiles) {
            if (!selectedFiles.has(kb)) continue;
            if (selectedFiles.get(kb)) {
                files = files.filter(f => selectedFiles.get(kb).find(s => s.fsPath === f.fsPath));
            }
        }
        kbFiles.push({ kb, files });
        terms[kb] = {};
        if (!(kb in _diagnosticsCache)) // Only add if it does not exist
            _diagnosticsCache[kb] = {};
    }
    const total = kbFiles.reduce((sum, { files }) => sum + files.length, 0);
    let done = 0;

    for (const { kb, files } of kbFiles) {
        const filePaths = files.map(u => u.fsPath);

        // Try restoring from cache
        // Get whether the user decided to disable caching
        const cacheDisabled = vscode.workspace.getConfiguration('sumo').get('sigma.disableKBCache', false);
        // Try getting the cache. Will fail if it does not exist or if the current file hashes DO NOT match
        //  the file hash associated with the cache entry
        const cacheResult = (!noCache && !cacheDisabled && configPath) ? tryLoadCache(kb, configPath, filePaths) : null;
        if (cacheResult) {
            // Restore the cache
            const { symbolTable: cached, diagnostics: cachedDiags } = cacheResult;
            _symbolTables[kb] = cached;

            // Rebuild the flat name → Term map from the restored SymbolTable.
            terms[kb] = {};
            for (const [name, sym] of Object.entries(cached.symbols)) {
                if (sym.forward) terms[kb][name] = sym.forward;
            }

            // Restore diagnostics: clear existing entries for all KB files,
            // then re-populate from the cached plain objects.
            _diagnosticsCache[kb] = {};
            for (const file of files) {
                if (diagnosticCollection) diagnosticCollection.delete(vscode.Uri.file(file.fsPath));
            }
            for (const [fsPath, diags] of Object.entries(cachedDiags)) {
                _diagnosticsCache[kb][fsPath] = diags;
                if (diags.length > 0 && diagnosticCollection) {
                    diagnosticCollection.set(
                        vscode.Uri.file(fsPath),
                        diags
                    );
                }
            }

            done += files.length;
            if (progress) progress.report({ message: `${done}/${total} files (cached)` });
        } else {
            // Cache was not found / restored, redo the parsing and error checking
            _symbolTables[kb] = new SymbolTable({ deepIndex: true });
            for (const file of files) {
                try {
                    // Clear the diagnositcs for the KB file
                    _diagnosticsCache[kb][file.fsPath] = []
                    // open text document and update those definitions
                    const doc = await vscode.workspace.openTextDocument(file);
                    // update the file definitions
                    updateFileDefinitions(doc, kb, _diagnosticsCache[kb][file.fsPath]);
                } catch (e) {
                    vscode.window.showErrorMessage(
                        `Failed to open constituent file in KB ${kb}: ${file.fsPath}`
                    );
                    console.error(e);
                }
                done++;
                if (progress) progress.report({ message: `${done}/${total} files` });
            }
        }

        if (progress) progress.report({ message: `Validating KB: ${kb}` });

        // The KB wide validation is handled separate from the parsed diagnostics
        /** @type {{[file: string]: vscode.Diagnostic[]}} */
        const validationDiagnostics = {};
        // Run second pass validation that has to be performed on a complete symbolTable
        // Build Formula objects and run semantic validation
        validateSemantics(_symbolTables[kb], validationDiagnostics);
        for (const file of files) {
            if (!(file.fsPath in validationDiagnostics)) validationDiagnostics[file.fsPath] = [];
            // Run best-practice and dependency warnings (lazy import avoids circular require)
            const doc = await vscode.workspace.openTextDocument(file);
            validateBestPractices(_symbolTables[kb], doc, validationDiagnostics[file.fsPath]);
            // Pass only this KB's symbol table so cross-KB file edges are never flagged
            validateFileDependencies(_symbolTables[kb], doc, validationDiagnostics[file.fsPath]);

            // Push the diagnostics
            if (diagnosticCollection) {
                diagnosticCollection.delete(doc.uri);
                diagnosticCollection.set(
                    doc.uri,
                    (_diagnosticsCache[kb][file.fsPath] || []).concat(validationDiagnostics[file.fsPath])
                );
            }
        }

        // Persist the freshly built SymbolTable and diagnostics for next session.
        if (!cacheDisabled && configPath) {
            trySaveCache(kb, configPath, filePaths, _symbolTables[kb], _diagnosticsCache[kb] ?? {});
        }
    }
}

/**
 * Parse a document, run all validation passes, and update the workspace definition index.
 * This is the single entry point for processing a file.
 *
 * @param {vscode.TextDocument} document
 * @param {string | undefined | null} kb  The knowledge base this document belongs to. If undefined, 
 *  default to the current KB. If NULL, parse document without semantics (i.e. just check syntax)
 * @param {vscode.Diagnostic[]} diagnostics
 */
function updateFileDefinitions(document, kb = undefined, diagnostics = []) {
    const fsPath = document.uri.fsPath;
    const text = document.getText();

    if (kb === undefined) {
        if (!currentKB)
            kb = null;  // No KB context yet — skip validation until a KB is opened
        else kb = currentKB;
    }

    let st;
    if (kb) {
        // Ensure a SymbolTable exists for this KB (handles files saved before buildWorkspaceDefinitions)
        if (!_symbolTables[kb]) _symbolTables[kb] = new SymbolTable({deepIndex: true});
        st = _symbolTables[kb];
    } else {
        st = new SymbolTable({deepIndex: true});
    }

    try {
        const tokens = tokenize({ text, path: fsPath }, diagnostics);
        const ast = parse(tokens, diagnostics);

        // Remove stale data from this file before re-parsing
        st.removeFile(fsPath);
        const { symbolTable } = syntax(ast, diagnostics, st);
        if (kb) {
            // Only perform next level validation if the file is a part of a larger KB
            _symbolTables[kb] = symbolTable;
    
            const fileTerms = semantics(_symbolTables[kb], diagnostics);
            setTerms(kb, fileTerms);
    
            // Update taxonomy cache and invalidate this KB's metadata cache
            delete workspaceMetadataCache[kb];
        }
    } catch (e) {
        // Catch any uncaught errors
        console.error(e);
        vscode.window.showWarningMessage(`An error occured while parsing the KB for file: ${fsPath}`);
    }
}

/**
 * Handle a file change/open properly. If its not in a KB, handle it as a independent
 *  file, with no contextual semantic analysis. If it is in a KB, handle appropriately
 * @param {vscode.TextDocument} document
 * @param {boolean} fresh Whether to update existing definitions, set true for things 
 *  like file open
 */
async function handleFileChange(document, fresh = false) {
    const kbs = await getKBs();
    const applicableKBs = [];
    for (const kb of kbs) {
        let files = await getKBFiles(kb);
        if (files.find(f => f.fsPath === document.uri.fsPath)) {
            applicableKBs.push(kb);
        }
    }
    // If this file is not in any KB, perform a syntax deep check
    if (applicableKBs.length === 0) {
        const diagnostics = [];
        updateFileDefinitions(document, null, diagnostics);
        // Publish the diagnostics
        if (diagnosticCollection) {
            diagnosticCollection.set(document.uri, diagnostics);
        }
        return;
    }

    // Otherwise, if the fresh is true, just return, its already parsed
    if (fresh) return;

    // Otherwise, perform a single file, full KB update
    await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Running Sigma Translation...`,
            cancellable: false
        }, async (progress) => {
            await buildWorkspaceDefinitions(
                progress, 
                false, 
                applicableKBs.map(kb => ({kb, file: document.uri})),
                true // no cache because we know that this is in response to a file modification
            );
        });
}

module.exports = {
    setExtensionContext,
    setDiagnosticCollection,
    getDiagnosticCollection,
    setKB,
    getKB,
    getKBs,
    getKBFiles,
    setTerms,
    getTerms,
    clearTerms,
    getSymbolTable,
    buildWorkspaceDefinitions,
    getWorkspaceMetadata,
    handleFileChange
};
