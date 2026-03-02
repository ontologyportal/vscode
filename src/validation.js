const vscode = require('vscode');
const { LOGIC_OPS, QUANTIFIERS } = require('./const');
const { tokenize, TokenList, ParsingError, NodeType } = require('./parser');
const { syntax, Symbol: KIFSymbol, ValueLiteral, FunctionalSentence } = require('./parser/symbol');
const { semantics } = require('./parser/semantics');

let symbolMetadata = {};

/** @type {vscode.DiagnosticCollection|null} */
let _diagnosticCollection = null;

/**
 * Set the shared diagnostic collection used by checkErrorsCommand.
 * Call this from extension.js after creating the collection.
 * @param {vscode.DiagnosticCollection} collection
 */
function setDiagnosticCollection(collection) {
    _diagnosticCollection = collection;
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
 * Run the full syntax + semantic pipeline on an AST and return the terms map.
 * This is the single compilation entry point for validation: call it once per
 * file, then pass the returned terms to the individual validate* functions.
 *
 * @param {import('./parser').ASTNode[]} ast - Top-level AST nodes from parse()
 * @param {vscode.Diagnostic[]} diagnostics - Accumulator array; parse errors are pushed here
 * @returns {{ [name: string]: import('./parser/term').Term }}
 */
function analyse(ast, diagnostics) {
    const { symbols: symbolTable } = syntaxValidation(ast, diagnostics);
    const terms = semanticsValidation(symbolTable, diagnostics);
    return terms;
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
 * BFS from `sym` following subclass, subrelation, and instance links.
 * Returns true if `ancestor` is reachable through the class/instance hierarchy.
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
            if (p.type === 'subclass' || p.type === 'subrelation' || p.type === 'instance') {
                queue.push(p.name);
            }
        }
    }
    return false;
}

/**
 * Build a parent graph from the local terms map when no KB-wide taxonomy is available.
 * @param {{ [name: string]: import('./parser/term').Term }} terms
 * @returns {{ [child: string]: {name: string, type: string}[] }}
 */
function buildParentGraphFromTerms(terms) {
    const graph = {};
    for (const [name, term] of Object.entries(terms)) {
        if (!graph[name]) graph[name] = [];
        for (const edge of term.taxonomy.incoming) {
            graph[name].push({ name: edge.from.name, type: edge.relation });
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
 * @param {{ [name: string]: import('./parser/term').Term }} terms
 * @param {vscode.TextDocument} document
 */
function validateNode(node, diagnostics, terms, document) {
    if (!node || node.type !== NodeType.LIST) return;

    if (node.children.length > 0) {
        const head = node.children[0];
        if (head.type === NodeType.ATOM || head.type === NodeType.OPERATOR) {
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

    node.children.forEach(child => validateNode(child, diagnostics, terms, document));
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
 * the highest argument position declared in a 'domain' or 'domainSubclass' statement.
 * A row variable (@ROW) in the argument list is treated as filling all remaining
 * argument positions, so no arity warning is emitted when one is present.
 * @param {import('./parser').ASTNode[]} ast
 * @param {vscode.Diagnostic[]} diagnostics
 * @param {{ [name: string]: import('./parser/term').Term }} terms
 * @param {vscode.TextDocument} document
 */
function validateArity(ast, diagnostics, terms, document) {
    const visit = (node) => {
        if (node.type === NodeType.LIST && node.children.length > 0) {
            const head = node.children[0];

            if (head.type === NodeType.ATOM) {
                const term = terms[head.startToken.value];
                if (term) {
                    // Find the highest declared domain position for this relation
                    let maxArg = 0;
                    for (const sentence of term.locations.first ?? []) {
                        const pred = sentence.functionalTerm.name;
                        if (pred !== 'domain' && pred !== 'domainSubclass') continue;
                        const posArg = sentence.terms[1];
                        if (posArg instanceof ValueLiteral) {
                            const pos = parseInt(posArg.value);
                            if (!isNaN(pos) && pos > maxArg) maxArg = pos;
                        }
                    }

                    if (maxArg > 0) {
                        const actualArgs = node.children.length - 1;

                        // A row variable (@ROW) expands to fill all remaining argument slots —
                        // suppress the arity warning when any argument is a row variable.
                        const hasRowVar = node.children.slice(1).some(c => c.type === NodeType.ROW_VARIABLE);

                        if (!hasRowVar && actualArgs < maxArg) {
                            diagnostics.push(new vscode.Diagnostic(
                                nodeRange(node, document),
                                `Relation '${head.startToken.value}' expects at least ${maxArg} arguments, but got ${actualArgs}.`,
                                vscode.DiagnosticSeverity.Warning
                            ));
                        }
                    }
                }
            }

            node.children.forEach(visit);
        }
    };

    ast.forEach(visit);
}

/**
 * Ordered arity-class descriptors, from most specific to least specific.
 * Iterating highest-first ensures we match the most precise arity class
 * when the hierarchy is nested (e.g. QuintaryRelation ⊂ QuaternaryRelation).
 */
const ARITY_CLASSES = [
    { name: 'QuintaryRelation',   arity: 5 },
    { name: 'QuaternaryRelation', arity: 4 },
    { name: 'TernaryRelation',    arity: 3 },
    { name: 'BinaryRelation',     arity: 2 },
    { name: 'UnaryRelation',      arity: 1 },
];

/**
 * Validate that each relation application has exactly the number of arguments
 * implied by its position in the SUMO arity hierarchy:
 *   UnaryRelation=1, BinaryRelation=2, TernaryRelation=3,
 *   QuaternaryRelation=4, QuintaryRelation=5.
 * If the term also inherits from Function, the expected count is reduced by 1
 * (the return-value position is implicit in function-application syntax).
 * VariableArityRelation instances are exempt from the check.
 * Sentences containing a row variable (@ROW) are also exempt.
 *
 * The check fires only when:
 *   - The head name is in the `terms` map
 *   - At least one `instance` edge connects the head to a known Relation subtype
 *   - The specific arity class is resolvable via `parentGraph`
 *
 * @param {import('./parser').ASTNode[]} ast
 * @param {vscode.Diagnostic[]} diagnostics
 * @param {{ [name: string]: import('./parser/term').Term }} terms
 * @param {vscode.TextDocument} document
 * @param {{ parents: {[child: string]: {name: string, type: string}[]} } | undefined} kbTaxonomy
 *   Optional KB-wide taxonomy.  Without it the check falls back to the local
 *   parent graph built from this file's terms (which may miss inherited arities).
 */
function validateRelationArity(ast, diagnostics, terms, document, kbTaxonomy) {
    const parentGraph = kbTaxonomy ? kbTaxonomy.parents : buildParentGraphFromTerms(terms);

    const visit = (node) => {
        if (node.type !== NodeType.LIST || node.children.length === 0) {
            return;
        }

        const head = node.children[0];
        if (head.type !== NodeType.ATOM && head.type !== NodeType.OPERATOR) {
            node.children.forEach(visit);
            return;
        }

        const headName = head.startToken.value;

        // Logical operators and quantifiers are syntax, not relation applications
        if (LOGIC_OPS.includes(headName) || QUANTIFIERS.includes(headName)) {
            node.children.forEach(visit);
            return;
        }

        const term = terms[headName];
        if (term) {
            const instanceOf = term.taxonomy.incoming
                .filter(e => e.relation === 'instance')
                .map(e => e.from.name);

            if (instanceOf.length > 0 && isRelationOrFunction(instanceOf, parentGraph)) {
                // VariableArityRelation instances accept any number of arguments
                const isVariableArity = instanceOf.some(
                    t => isClassAncestor('VariableArityRelation', t, parentGraph)
                );

                if (!isVariableArity) {
                    let expectedArity = null;
                    for (const { name, arity } of ARITY_CLASSES) {
                        if (instanceOf.some(t => isClassAncestor(name, t, parentGraph))) {
                            expectedArity = arity;
                            break;
                        }
                    }

                    if (expectedArity !== null) {
                        // Function application: the return value is implicit,
                        // so callers supply one fewer argument than the arity class implies.
                        if (isFunction(instanceOf, parentGraph)) {
                            expectedArity -= 1;
                        }

                        const actualArgs = node.children.length - 1;
                        const hasRowVar = node.children.slice(1).some(
                            c => c.type === NodeType.ROW_VARIABLE
                        );

                        if (!hasRowVar && actualArgs !== expectedArity) {
                            diagnostics.push(new vscode.Diagnostic(
                                nodeRange(node, document),
                                `'${headName}' expects exactly ${expectedArity} argument(s) but got ${actualArgs}.`,
                                vscode.DiagnosticSeverity.Error
                            ));
                        }
                    }
                }
            }
        }

        node.children.forEach(visit);
    };

    ast.forEach(visit);
}

/**
 * Infer the SUMO type name of an AST argument node.
 *
 * Returns a string type name when determinable, or null to skip the check:
 *   - VARIABLE / ROW_VARIABLE       → null  (cannot type statically)
 *   - numeric/string literal ATOM   → null  (no taxonomy entry)
 *   - named ATOM                    → the atom name itself
 *   - LIST with operator/quantifier → 'Formula'
 *   - LIST with function head       → range of that function (or null)
 *   - LIST with predicate head      → 'Formula'
 *
 * @param {import('./parser').ASTNode} argNode
 * @param {{ [name: string]: import('./parser/term').Term }} terms
 * @param {{ [child: string]: {name: string, type: string}[] }} parentGraph
 * @returns {string|null}
 */
function inferArgType(argNode, terms, parentGraph) {
    if (argNode.type === NodeType.VARIABLE || argNode.type === NodeType.ROW_VARIABLE) {
        return null;
    }

    if (argNode.type === NodeType.ATOM) {
        const val = argNode.startToken.value;
        // Numeric literals and string literals have no taxonomy entry
        if (/^-?\d/.test(val) || val.startsWith('"')) return null;
        return val;
    }

    if (argNode.type === NodeType.LIST) {
        if (argNode.children.length === 0) return null;
        const head = argNode.children[0];
        if (head.type !== NodeType.ATOM && head.type !== NodeType.OPERATOR) return null;
        const headName = head.startToken.value;

        if (LOGIC_OPS.includes(headName) || QUANTIFIERS.includes(headName)) {
            return 'Formula';
        }

        const headTerm = terms[headName];
        if (!headTerm) return 'Formula'; // unknown predicate → treat as a sentence

        const instanceOf = headTerm.taxonomy.incoming
            .filter(e => e.relation === 'instance')
            .map(e => e.from.name);

        if (instanceOf.length > 0 && isFunction(instanceOf, parentGraph)) {
            // Function application: type is the declared range
            const rangeTerm = headTerm.range();
            return rangeTerm ? rangeTerm.name : null;
        }

        // Predicate or operator application → truth-valued sentence
        return 'Formula';
    }

    return null;
}

/**
 * Validate that each argument of a relation/function call is type-compatible
 * with the domain declared for that argument position.
 *
 * For each call `(rel arg1 arg2 ...)` where `rel` has a known domain at
 * position i (`(domain rel i SomeClass)`), the inferred type of argi is
 * checked against SomeClass via the taxonomy hierarchy.
 *
 * Type inference rules (see inferArgType):
 *   - Named atom    → check if it reaches the domain class in the parentGraph
 *   - LIST sentence → 'Formula' (for predicates/operators) or the function's range
 *   - Variable      → skipped (cannot determine type statically)
 *
 * A Warning is emitted (not Error) because type inference is inherently
 * incomplete: missing KB-wide taxonomy or cross-file domain declarations
 * may cause false positives.
 *
 * @param {import('./parser').ASTNode[]} ast
 * @param {vscode.Diagnostic[]} diagnostics
 * @param {{ [name: string]: import('./parser/term').Term }} terms
 * @param {vscode.TextDocument} document
 * @param {{ parents: {[child: string]: {name: string, type: string}[]} } | undefined} kbTaxonomy
 */
function validateDomainTypes(ast, diagnostics, terms, document, kbTaxonomy) {
    const parentGraph = kbTaxonomy ? kbTaxonomy.parents : buildParentGraphFromTerms(terms);

    const visit = (node) => {
        if (node.type !== NodeType.LIST || node.children.length === 0) return;

        const head = node.children[0];
        if (head.type !== NodeType.ATOM && head.type !== NodeType.OPERATOR) {
            node.children.forEach(visit);
            return;
        }

        const headName = head.startToken.value;
        if (LOGIC_OPS.includes(headName) || QUANTIFIERS.includes(headName)) {
            node.children.forEach(visit);
            return;
        }

        const headTerm = terms[headName];
        if (headTerm) {
            for (let i = 1; i < node.children.length; i++) {
                const argNode = node.children[i];
                const domainTerm = headTerm.domain(i); // 1-based
                if (!domainTerm) continue;             // no constraint for this position

                const argType = inferArgType(argNode, terms, parentGraph);
                if (argType === null) continue;        // cannot determine type — skip

                const domainName = domainTerm.name;
                const compatible = argType === domainName
                    || isClassAncestor(domainName, argType, parentGraph);

                if (!compatible) {
                    diagnostics.push(new vscode.Diagnostic(
                        nodeRange(argNode, document),
                        `Argument ${i} of '${headName}' should be of type '${domainName}' but got '${argType}'.`,
                        vscode.DiagnosticSeverity.Warning
                    ));
                }
            }
        }

        node.children.forEach(visit);
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
 * @param {{ [name: string]: import('./parser/term').Term }} terms
 * @param {vscode.TextDocument} document
 * @param {{ parents: {[child: string]: {name: string, type: string}[]} } | undefined} kbTaxonomy
 *   Optional KB-wide taxonomy from navigation.getWorkspaceTaxonomy().
 *   When absent the check falls back to the local parent graph built from this file's terms.
 */
function validateCoverage(ast, diagnostics, terms, document, kbTaxonomy) {
    const parentGraph = kbTaxonomy ? kbTaxonomy.parents : buildParentGraphFromTerms(terms);

    const TAXONOMY_DEFINING = new Set(['subclass', 'instance', 'subrelation', 'subAttribute']);

    for (const [sym, term] of Object.entries(terms)) {
        // Only check symbols defined (as subject) in a taxonomy statement in this file
        let defNode = null;
        outer: for (const fileRefs of term.symbol.references.values()) {
            for (const [sentence, node] of fileRefs) {
                if (sentence instanceof FunctionalSentence) {
                    const pred = sentence.functionalTerm.name;
                    if (TAXONOMY_DEFINING.has(pred) && sentence.terms[0] === term.symbol) {
                        defNode = node;
                        break outer;
                    }
                }
            }
        }
        if (!defNode) continue;

        const defRange = nodeRange(defNode, document);

        // 1. Taxonomy: must reach Entity (skip Entity itself — it is the root)
        if (sym !== 'Entity' && !canReachEntity(sym, parentGraph)) {
            diagnostics.push(new vscode.Diagnostic(
                defRange,
                `'${sym}' has no taxonomy path to Entity.`,
                vscode.DiagnosticSeverity.Error
            ));
        }

        // 2. Documentation in any language
        if (term.documentation.length === 0) {
            diagnostics.push(new vscode.Diagnostic(
                defRange,
                `'${sym}' has no documentation string in any language.`,
                vscode.DiagnosticSeverity.Warning
            ));
        }

        // 3 & 4. Domain/range — only applicable to Relations and Functions
        const instanceOf = term.taxonomy.incoming
            .filter(e => e.relation === 'instance')
            .map(e => e.from.name);

        if (isRelationOrFunction(instanceOf, parentGraph)) {
            const hasDomain = (term.locations.first ?? []).some(s => {
                const pred = s.functionalTerm.name;
                return pred === 'domain' || pred === 'domainSubclass';
            });
            if (!hasDomain) {
                diagnostics.push(new vscode.Diagnostic(
                    defRange,
                    `'${sym}' is a Relation or Function but has no 'domain' statement.`,
                    vscode.DiagnosticSeverity.Warning
                ));
            }
            if (isFunction(instanceOf, parentGraph)) {
                const hasRange = (term.locations.first ?? []).some(s => {
                    const pred = s.functionalTerm.name;
                    return pred === 'range' || pred === 'rangeSubclass';
                });
                if (!hasRange) {
                    diagnostics.push(new vscode.Diagnostic(
                        defRange,
                        `'${sym}' is a Function but has no 'range' statement.`,
                        vscode.DiagnosticSeverity.Warning
                    ));
                }
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

    const tokens = tokenize({doc: document}, diagnostics);
    
    if (_diagnosticCollection) {
        if (diagnostics.length > 0) {
            _diagnosticCollection.set(document.uri, diagnostics);
            vscode.window.showWarningMessage(`Found ${diagnostics.length} issue(s). See Problems panel for details.`);
            return;
        } else {
            _diagnosticCollection.delete(document.uri);
        }
    }

    const ast = parse(tokens, diagnostics);
    const terms = analyse(ast);

    ast.forEach(node => validateNode(node, diagnostics, terms, document));
    validateVariables(ast, diagnostics);
    validateArity(ast, diagnostics, terms, document);
    validateRelationArity(ast, diagnostics, terms, document);
    validateDomainTypes(ast, diagnostics, terms, document);
    validateRelationUsage(ast, diagnostics, document);
    // No kbTaxonomy available here — coverage check is file-local only
    validateCoverage(ast, diagnostics, terms, document);

    // Use the shared collection (set via setDiagnosticCollection) — avoids creating
    // a second "sumo-check" collection alongside the existing "sumo" collection.
    if (_diagnosticCollection) {
        if (diagnostics.length > 0) {
            _diagnosticCollection.set(document.uri, diagnostics);
        } else {
            _diagnosticCollection.delete(document.uri);
        }
    }

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
    tokenize: tokenizeValidation,
    parse,
    syntax: syntaxValidation,
    semantics: semanticsValidation,
    analyse,
    validateNode,
    validateOperand,
    validateVariables,
    validateArity,
    validateRelationArity,
    validateDomainTypes,
    validateRelationUsage,
    validateCoverage,
    checkErrorsCommand,
    setDiagnosticCollection,
    getSymbolMetadata,
    setSymbolMetadata
};
