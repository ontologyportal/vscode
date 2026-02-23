const vscode = require('vscode');
const { LOGIC_OPS, QUANTIFIERS } = require('./const');
const { tokenize, TokenList, ParsingError, NodeType } = require('./parser');

let symbolMetadata = {};

/**
 * Parse a token list into an AST, converting any ParsingError into a VS Code diagnostic.
 * On a parse error the diagnostic is pushed and an empty array is returned, so callers
 * can always treat the return value as a (possibly empty) AST without further error handling.
 * @param {import('./parser').Token[]} tokens - Token array from tokenize()
 * @param {vscode.TextDocument} document - The source document (used for diagnostic positions)
 * @param {vscode.Diagnostic[]} diagnostics - Accumulator array; parse errors are pushed here
 * @returns {import('./parser').ASTNode[]} Parsed top-level AST nodes
 */
function parse(tokens, document, diagnostics) {
    const list = new TokenList(tokens);
    try {
        return list.parse();
    } catch (e) {
        if (e instanceof ParsingError) {
            const pos = new vscode.Position(e.line, e.column);
            diagnostics.push(new vscode.Diagnostic(
                new vscode.Range(pos, pos.translate(0, 1)),
                e.error || e.message,
                vscode.DiagnosticSeverity.Error
            ));
        }
        return [];
    }
}

/**
 * Compute a VS Code Range from an AST node using its stored token offsets.
 * List nodes use their start and end offsets; term nodes use start offset plus value length.
 * @param {import('./parser').ASTNode} node - Any AST node
 * @param {vscode.TextDocument} document - The document the node belongs to
 * @returns {vscode.Range}
 */
function nodeRange(node, document) {
    const start = document.positionAt(node.start.offset);
    if (node.end) {
        return new vscode.Range(start, document.positionAt(node.end.offset));
    }
    const len = node.startToken.value ? node.startToken.value.length : 1;
    return new vscode.Range(start, document.positionAt(node.start.offset + len));
}

/**
 * Walk the AST and collect symbol metadata needed for validation.
 *
 * Collected statement types:
 *   - (subclass X Y) / (subrelation X Y) / (subAttribute X Y)
 *       → marks X as defined in this file; records Y as a direct parent class
 *   - (instance X Y)
 *       → marks X as defined in this file; records Y as a direct type
 *   - (domain <relation> <pos> <type>)
 *       → arity/type constraint for argument <pos> of <relation>
 *   - (range <function> <type>)
 *       → records that <function> has a range declaration
 *   - (documentation <sym> <lang> <doc>)
 *       → human-readable description; preferred language from 'sumo.language' setting
 *
 * @param {import('./parser').ASTNode[]} ast - Top-level AST nodes from parse()
 * @returns {{
 *   [symbol: string]: {
 *     domains:     { [pos: number]: string },
 *     documentation: string,
 *     docLang:     string,
 *     subclassOf:  string[],
 *     instanceOf:  string[],
 *     hasRange:    boolean,
 *     defNode:     import('./parser').ASTNode | null
 *   }
 * }}
 */
function collectMetadata(ast) {
    const metadata = {};
    const targetLang = vscode.workspace.getConfiguration('sumo').get('general.language') || 'EnglishLanguage';

    /** Ensure an entry exists for a symbol and return it */
    function entry(sym) {
        if (!metadata[sym]) {
            metadata[sym] = {
                domains: {},
                documentation: '',
                docLang: undefined,
                subclassOf: [],
                instanceOf: [],
                hasRange: false,
                defNode: null
            };
        }
        return metadata[sym];
    }

    const visit = (node) => {
        if (node.type === NodeType.LIST && node.children.length >= 2) {
            const head = node.children[0];
            if (head.type !== NodeType.ATOM) {
                if (node.type === NodeType.LIST) node.children.forEach(visit);
                return;
            }
            const op = head.startToken.value;

            // --- Taxonomy-defining statements ---
            // (subclass X Y), (subrelation X Y), (subAttribute X Y)
            if ((op === 'subclass' || op === 'subrelation' || op === 'subAttribute') &&
                node.children.length >= 3) {
                const subjNode = node.children[1];
                const parentNode = node.children[2];
                if (subjNode.type === NodeType.ATOM && parentNode.type === NodeType.ATOM) {
                    const sym = subjNode.startToken.value;
                    const parent = parentNode.startToken.value;
                    const meta = entry(sym);
                    meta.subclassOf.push(parent);
                    if (!meta.defNode) meta.defNode = subjNode; // anchor for diagnostics
                }
            }

            // (instance X Y)
            if (op === 'instance' && node.children.length >= 3) {
                const subjNode = node.children[1];
                const typeNode = node.children[2];
                if (subjNode.type === NodeType.ATOM && typeNode.type === NodeType.ATOM) {
                    const sym = subjNode.startToken.value;
                    const type = typeNode.startToken.value;
                    const meta = entry(sym);
                    meta.instanceOf.push(type);
                    if (!meta.defNode) meta.defNode = subjNode;
                }
            }

            // --- Domain declaration ---
            // (domain <relation> <argPos> <type>)
            if (op === 'domain' && node.children.length >= 4) {
                const relNode  = node.children[1];
                const posNode  = node.children[2];
                const typeNode = node.children[3];
                if (relNode.type === NodeType.ATOM && posNode.type === NodeType.ATOM && typeNode.type === NodeType.ATOM) {
                    const rel = relNode.startToken.value;
                    const pos = parseInt(posNode.startToken.value);
                    const type = typeNode.startToken.value;
                    if (!isNaN(pos)) {
                        const meta = entry(rel);
                        meta.domains[pos] = type;
                    }
                }
            }

            // --- Range declaration ---
            // (range <function> <type>)
            if (op === 'range' && node.children.length >= 3) {
                const fnNode = node.children[1];
                if (fnNode.type === NodeType.ATOM) {
                    entry(fnNode.startToken.value).hasRange = true;
                }
            }

            // --- Documentation ---
            // (documentation <sym> <lang> <string>)
            // The doc argument may be STRING (quoted) or ATOM type.
            if (op === 'documentation' && node.children.length >= 4) {
                const symNode  = node.children[1];
                const langNode = node.children[2];
                const docNode  = node.children[3];
                const isDocNode = t => t.type === NodeType.ATOM || t.type === NodeType.STRING;
                if (symNode.type === NodeType.ATOM && langNode.type === NodeType.ATOM && isDocNode(docNode)) {
                    const sym  = symNode.startToken.value;
                    const lang = langNode.startToken.value;
                    let doc = docNode.startToken.value;
                    if (doc.startsWith('"') && doc.endsWith('"')) {
                        doc = doc.substring(1, doc.length - 1);
                    }
                    const meta = entry(sym);
                    // Prefer the target language; keep first match of any language
                    if (lang === targetLang || !meta.docLang || meta.docLang !== targetLang) {
                        meta.documentation = doc;
                        meta.docLang = lang;
                    }
                }
            }
        }

        if (node.type === NodeType.LIST) {
            node.children.forEach(visit);
        }
    };

    ast.forEach(visit);
    return metadata;
}

// ---------------------------------------------------------------------------
// Taxonomy reachability helpers (used by validateCoverage)
// ---------------------------------------------------------------------------

/**
 * BFS from `sym` following all parent links in `parentGraph`.
 * Returns true if `Entity` is reachable.
 * @param {string} sym
 * @param {{ [child: string]: {name: string, type: string}[] }} parentGraph
 * @returns {boolean}
 */
function canReachEntity(sym, parentGraph) {
    const visited = new Set();
    const queue = [sym];
    while (queue.length > 0) {
        const current = queue.shift();
        if (current === 'Entity') return true;
        if (visited.has(current)) continue;
        visited.add(current);
        for (const p of (parentGraph[current] || [])) {
            queue.push(p.name);
        }
    }
    return false;
}

/**
 * BFS from `sym` following only subclass/subrelation links.
 * Returns true if `ancestor` is reachable through the class hierarchy.
 * @param {string} ancestor
 * @param {string} sym
 * @param {{ [child: string]: {name: string, type: string}[] }} parentGraph
 * @returns {boolean}
 */
function isClassAncestor(ancestor, sym, parentGraph) {
    const visited = new Set();
    const queue = [sym];
    while (queue.length > 0) {
        const current = queue.shift();
        if (current === ancestor) return true;
        if (visited.has(current)) continue;
        visited.add(current);
        for (const p of (parentGraph[current] || [])) {
            if (p.type === 'subclass' || p.type === 'subrelation') {
                queue.push(p.name);
            }
        }
    }
    return false;
}

/**
 * Build a parent graph from the local file metadata when no KB-wide taxonomy is available.
 * @param {ReturnType<collectMetadata>} metadata
 * @returns {{ [child: string]: {name: string, type: string}[] }}
 */
function buildLocalParentGraph(metadata) {
    const graph = {};
    for (const [sym, meta] of Object.entries(metadata)) {
        if (!graph[sym]) graph[sym] = [];
        for (const parent of (meta.subclassOf || [])) {
            graph[sym].push({ name: parent, type: 'subclass' });
        }
        for (const cls of (meta.instanceOf || [])) {
            graph[sym].push({ name: cls, type: 'instance' });
        }
    }
    return graph;
}

/**
 * True if any of the given direct types has `Relation` as an ancestor in the class hierarchy.
 * @param {string[]} instanceOf
 * @param {{ [child: string]: {name: string, type: string}[] }} parentGraph
 */
function isRelationOrFunction(instanceOf, parentGraph) {
    return instanceOf.some(t => isClassAncestor('Relation', t, parentGraph));
}

/**
 * True if any of the given direct types has `Function` as an ancestor in the class hierarchy.
 * @param {string[]} instanceOf
 * @param {{ [child: string]: {name: string, type: string}[] }} parentGraph
 */
function isFunction(instanceOf, parentGraph) {
    return instanceOf.some(t => isClassAncestor('Function', t, parentGraph));
}

/**
 * Validate a single AST node and recurse into its children.
 * Checks:
 *   - Operands of logical operators are valid logical sentences (not bare atoms)
 *   - The class/type argument of subclass/instance starts with an uppercase letter
 * @param {import('./parser').ASTNode} node
 * @param {vscode.Diagnostic[]} diagnostics
 * @param {ReturnType<collectMetadata>} metadata
 * @param {vscode.TextDocument} document
 */
function validateNode(node, diagnostics, metadata, document) {
    if (!node || node.type !== NodeType.LIST) return;

    if (node.children.length > 0) {
        const head = node.children[0];
        if (head.type === NodeType.ATOM) {
            const op = head.startToken.value;

            // Each argument to a logical operator must be a sentence, not a bare atom
            if (LOGIC_OPS.includes(op)) {
                for (let i = 1; i < node.children.length; i++) {
                    validateOperand(node.children[i], diagnostics, document);
                }
            }

            // The type/class argument of subclass/instance should be uppercase
            if (op === 'subclass' || op === 'instance') {
                if (node.children.length > 2) {
                    const classArg = node.children[2];
                    if (classArg.type === NodeType.ATOM) {
                        const firstChar = classArg.startToken.value.charAt(0);
                        if (firstChar >= 'a' && firstChar <= 'z') {
                            diagnostics.push(new vscode.Diagnostic(
                                nodeRange(classArg, document),
                                `Class/Type '${classArg.startToken.value}' should start with an uppercase letter.`,
                                vscode.DiagnosticSeverity.Warning
                            ));
                        }
                    }
                }
            }
        }
    }

    node.children.forEach(child => validateNode(child, diagnostics, metadata, document));
}

/**
 * Validate that a node used as an operand of a logical operator is a valid logical sentence.
 * Variables and row variables are always accepted. Bare atoms are rejected.
 * List operands are checked to ensure the head is a relation (lowercase) or operator,
 * not a Function/Instance (uppercase head).
 * @param {import('./parser').ASTNode} node - The operand node to validate
 * @param {vscode.Diagnostic[]} diagnostics
 * @param {vscode.TextDocument} document
 */
function validateOperand(node, diagnostics, document) {
    if (node.type !== NodeType.LIST) {
        // Variables and row variables are valid logical operands
        if (node.type === NodeType.VARIABLE || node.type === NodeType.ROW_VARIABLE) {
            return;
        }
        diagnostics.push(new vscode.Diagnostic(
            nodeRange(node, document),
            'Operand must be a logical sentence or relation, not an atom.',
            vscode.DiagnosticSeverity.Error
        ));
        return;
    }

    if (node.children.length === 0) return;
    const head = node.children[0];

    if (head.type === NodeType.ATOM) {
        const val = head.startToken.value;

        // Logical operators, quantifiers, and equality are always valid sentence heads
        if (LOGIC_OPS.includes(val) || QUANTIFIERS.includes(val) || val === '=') {
            return;
        }

        const firstChar = val.charAt(0);

        // Lowercase head → relation application, valid as a sentence
        if (firstChar >= 'a' && firstChar <= 'z') {
            return;
        }

        // Uppercase head → likely a Function or Instance, not a sentence
        if (firstChar >= 'A' && firstChar <= 'Z') {
            diagnostics.push(new vscode.Diagnostic(
                nodeRange(node, document),
                `Invalid operand: '${val}' appears to be a Function or Instance (starts with Uppercase). Expected a Relation or Logical Sentence.`,
                vscode.DiagnosticSeverity.Error
            ));
        }
    }
}

/**
 * Validate variable scoping inside quantified expressions.
 * Walks the AST tracking which variables are in scope per quantifier block
 * (forall / exists). Currently records bound variables but emits no diagnostics —
 * this is a scaffold for future free-variable checking.
 * @param {import('./parser').ASTNode[]} ast
 * @param {vscode.Diagnostic[]} diagnostics
 */
function validateVariables(ast, diagnostics) {
    const visit = (node, scope = new Set(), quantifierVars = new Set()) => {
        if (node.type === NodeType.LIST && node.children.length > 0) {
            const head = node.children[0];

            // On a quantifier, extend scope with the bound variable list then recurse into body
            if (head.type === NodeType.ATOM && QUANTIFIERS.includes(head.startToken.value)) {
                if (node.children.length >= 2 && node.children[1].type === NodeType.LIST) {
                    const varList = node.children[1];
                    const newScope = new Set(scope);

                    varList.children.forEach(v => {
                        if (v.type === NodeType.VARIABLE || v.type === NodeType.ROW_VARIABLE) {
                            newScope.add(v.startToken.value);
                        }
                    });

                    for (let i = 2; i < node.children.length; i++) {
                        visit(node.children[i], newScope, quantifierVars);
                    }
                    return;
                }
            }

            node.children.forEach(child => visit(child, scope, quantifierVars));
        }
    };

    ast.forEach(node => visit(node));
}

/**
 * Validate that each relation is called with at least as many arguments as
 * the highest argument position declared in a 'domain' statement.
 * Requires metadata collected by collectMetadata().
 * @param {import('./parser').ASTNode[]} ast
 * @param {vscode.Diagnostic[]} diagnostics
 * @param {ReturnType<collectMetadata>} metadata
 * @param {vscode.TextDocument} document
 */
function validateArity(ast, diagnostics, metadata, document) {
    const visit = (node) => {
        if (node.type === NodeType.LIST && node.children.length > 0) {
            const head = node.children[0];

            if (head.type === NodeType.ATOM && metadata[head.startToken.value] && metadata[head.startToken.value].domains) {
                const domains = metadata[head.startToken.value].domains;
                const maxArg = Math.max(...Object.keys(domains).map(k => parseInt(k)));
                const actualArgs = node.children.length - 1;

                if (actualArgs < maxArg) {
                    diagnostics.push(new vscode.Diagnostic(
                        nodeRange(node, document),
                        `Relation '${head.startToken.value}' expects at least ${maxArg} arguments, but got ${actualArgs}.`,
                        vscode.DiagnosticSeverity.Warning
                    ));
                }
            }

            node.children.forEach(visit);
        }
    };

    ast.forEach(visit);
}

/**
 * Validate that every relation call has at least one argument.
 * A list with a single atom child and no further arguments is flagged as a
 * zero-argument relation application, which is almost always a mistake.
 * @param {import('./parser').ASTNode[]} ast
 * @param {vscode.Diagnostic[]} diagnostics
 * @param {vscode.TextDocument} document
 */
function validateRelationUsage(ast, diagnostics, document) {
    const visit = (node) => {
        if (node.type === NodeType.LIST && node.children.length > 0) {
            const head = node.children[0];

            if (node.children.length === 1 && head.type === NodeType.ATOM && !LOGIC_OPS.includes(head.startToken.value)) {
                diagnostics.push(new vscode.Diagnostic(
                    nodeRange(node, document),
                    `Relation '${head.startToken.value}' has no arguments.`,
                    vscode.DiagnosticSeverity.Warning
                ));
            }

            node.children.forEach(visit);
        }
    };

    ast.forEach(visit);
}

/**
 * Validate term coverage for every symbol explicitly defined in the current file.
 * A symbol is considered "defined here" when it appears as the subject of a
 * subclass / instance / subrelation / subAttribute statement in the file.
 *
 * Four checks are performed for each such symbol:
 *
 *   1. **Taxonomy** (Error) — every term except `Entity` must have a path back to
 *      `Entity` through the parent graph.  When `kbTaxonomy` is supplied this is a
 *      full KB-wide check; without it only parents visible in the current file are
 *      considered (the check may produce false positives in that case).
 *
 *   2. **Documentation** (Warning) — the symbol must have at least one
 *      `documentation` statement in any language anywhere in the collected metadata.
 *
 *   3. **Domain** (Warning) — if the symbol is an instance of a `Relation` or
 *      `Function` subtype, it must have at least one `domain` statement.
 *
 *   4. **Range** (Warning) — if the symbol is an instance of a `Function` subtype,
 *      it must have a `range` statement.
 *
 * @param {import('./parser').ASTNode[]} ast
 * @param {vscode.Diagnostic[]} diagnostics
 * @param {ReturnType<collectMetadata>} metadata
 * @param {vscode.TextDocument} document
 * @param {{ parents: {[child: string]: {name: string, type: string}[]} } | undefined} kbTaxonomy
 *   Optional KB-wide taxonomy from navigation.getWorkspaceTaxonomy().
 *   When absent the check falls back to the local parent graph built from this file's metadata.
 */
function validateCoverage(ast, diagnostics, metadata, document, kbTaxonomy) {
    const parentGraph = kbTaxonomy ? kbTaxonomy.parents : buildLocalParentGraph(metadata);

    for (const [sym, meta] of Object.entries(metadata)) {
        // Only check symbols that have a taxonomy-defining statement in this file
        if (!meta.defNode) continue;

        const defRange = nodeRange(meta.defNode, document);

        // 1. Taxonomy: must reach Entity (skip Entity itself — it is the root)
        if (sym !== 'Entity' && !canReachEntity(sym, parentGraph)) {
            diagnostics.push(new vscode.Diagnostic(
                defRange,
                `'${sym}' has no taxonomy path to Entity.`,
                vscode.DiagnosticSeverity.Error
            ));
        }

        // 2. Documentation in any language
        if (!meta.documentation) {
            diagnostics.push(new vscode.Diagnostic(
                defRange,
                `'${sym}' has no documentation string in any language.`,
                vscode.DiagnosticSeverity.Warning
            ));
        }

        // 3 & 4. Domain/range — only applicable to Relations and Functions
        const instanceOf = meta.instanceOf || [];
        if (isRelationOrFunction(instanceOf, parentGraph)) {
            if (Object.keys(meta.domains).length === 0) {
                diagnostics.push(new vscode.Diagnostic(
                    defRange,
                    `'${sym}' is a Relation or Function but has no 'domain' statement.`,
                    vscode.DiagnosticSeverity.Warning
                ));
            }
            if (isFunction(instanceOf, parentGraph) && !meta.hasRange) {
                diagnostics.push(new vscode.Diagnostic(
                    defRange,
                    `'${sym}' is a Function but has no 'range' statement.`,
                    vscode.DiagnosticSeverity.Warning
                ));
            }
        }
    }
}

/**
 * VS Code command that runs all validation passes on the active editor document
 * and populates the Problems panel with any issues found.
 */
async function checkErrorsCommand() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const document = editor.document;

    const diagnostics = [];
    const text = document.getText();
    const tokens = tokenize(text, document.fileName);
    const ast = parse(tokens, document, diagnostics);
    const metadata = collectMetadata(ast);

    ast.forEach(node => validateNode(node, diagnostics, metadata, document));
    validateVariables(ast, diagnostics);
    validateArity(ast, diagnostics, metadata, document);
    validateRelationUsage(ast, diagnostics, document);
    // No kbTaxonomy available here — coverage check is file-local only
    validateCoverage(ast, diagnostics, metadata, document);

    const collection = vscode.languages.createDiagnosticCollection('sumo-check');
    collection.set(document.uri, diagnostics);

    if (diagnostics.length === 0) {
        vscode.window.showInformationMessage('No errors found in the current file.');
    } else {
        vscode.window.showWarningMessage(`Found ${diagnostics.length} issue(s). See Problems panel for details.`);
    }
}

/** @returns {{ [symbol: string]: { domains: object, documentation: string } }} */
function getSymbolMetadata() {
    return symbolMetadata;
}

/** @param {{ [symbol: string]: { domains: object, documentation: string } }} meta */
function setSymbolMetadata(meta) {
    symbolMetadata = meta;
}

module.exports = {
    tokenize,
    parse,
    collectMetadata,
    validateNode,
    validateOperand,
    validateVariables,
    validateArity,
    validateRelationUsage,
    validateCoverage,
    checkErrorsCommand,
    getSymbolMetadata,
    setSymbolMetadata
};
