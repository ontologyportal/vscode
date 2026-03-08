'use strict';

/**
 * Integration tests for updateFileDefinitions / buildWorkspaceDefinitions.
 *
 * These tests verify that every error-reporting stage in the pipeline
 * produces the expected VS Code Diagnostic objects:
 *
 *   Stage 1 – Tokenizer errors    (tokenizeWrapper)
 *   Stage 2 – Parse errors        (parseWrapper)
 *   Stage 3 – Syntax errors       (syntaxWrapper)
 *   Stage 4 – Best-practice warnings (validateBestPractices)
 *   Stage 5 – Circular dependency warnings (validateFileDependencies)
 *
 * In addition, Term.validate() and Formula.validate() are tested directly
 * (they are not currently called in the pipeline, so those are unit-level
 * tests rather than pipeline integration tests).
 */

const { expect } = require('chai');
const sinon      = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

const realParser = require('../../src/parser');
const { Term, SemanticError } = require('../../src/parser/term');
const { Formula }             = require('../../src/parser/formula');
const { syntax }              = require('../../src/parser/symbol');
const { tokenize }            = require('../../src/parser/tokenizer');
const { TokenList }           = require('../../src/parser/parser');
const {
    createVSCodeMock,
    createMockDocument,
    DiagnosticSeverity
} = require('../helpers/vscode-mock');

// ---------------------------------------------------------------------------
// Helpers shared by pipeline tests
// ---------------------------------------------------------------------------

/**
 * Build a fresh proxyquire'd state module with a mocked VS Code, a mock
 * filesystem that accepts paths in `docMap`, and a mock parseConfigXml that
 * returns `configResult`.
 *
 * @param {sinon.SinonStub} parseConfigStub  resolves with a Sigma config object
 * @param {Map<string, object>} docMap        path → mock TextDocument
 * @returns {{ state, vscodeMock, collection }}
 */
function setupState(parseConfigStub, docMap) {
    const vscodeMock = createVSCodeMock(sinon);
    vscodeMock['@global'] = true;

    vscodeMock._setConfig({ 'general.language': 'EnglishLanguage' });

    const realFs = require('fs');
    const mockFs = Object.assign({}, realFs, {
        existsSync: (p) => docMap.has(p) || realFs.existsSync(p)
    });

    vscodeMock.workspace.openTextDocument = sinon.stub().callsFake(uri => {
        const p = uri.fsPath || (typeof uri === 'string' ? uri : null);
        const doc = docMap.get(p);
        if (doc) return Promise.resolve(doc);
        return Promise.reject(new Error('unknown file: ' + p));
    });

    const realValidation = proxyquire('../../src/validation', {
        vscode:    vscodeMock,
        './parser': realParser
    });

    const state = proxyquire('../../src/state', {
        vscode:                vscodeMock,
        fs:                    mockFs,
        './parser':            realParser,
        './parser/formula':    require('../../src/parser/formula'),
        './parser/sentence':   require('../../src/parser/sentence'),
        './validation':        realValidation,
        './sigma/config': {
            findConfigXml:  sinon.stub().resolves('/test/config.xml'),
            parseConfigXml: parseConfigStub
        }
    });

    const collection = vscodeMock.languages.createDiagnosticCollection('sumo');
    state.setDiagnosticCollection(collection);
    return { state, vscodeMock, collection };
}

/** Simple config stub returning a single KB with the given file paths. */
function singleKBConfig(kbName, filePaths) {
    return sinon.stub().resolves({
        preferences: { kbDir: '/test' },
        knowledgeBases: { [kbName]: { constituents: filePaths } }
    });
}

/** Get all diagnostics stored for a given path in the mock collection. */
function getDiags(collection, fsPath) {
    return collection.get(fsPath) || [];
}

// ---------------------------------------------------------------------------
// Helpers for direct Term / Formula tests
// ---------------------------------------------------------------------------

function parseKIF(text, symbolTable) {
    const { tokens } = tokenize(text, 'test.kif');
    const { nodes } = new TokenList(tokens).parse();
    return syntax(nodes, symbolTable);
}

/**
 * Parse one or more KIF strings, accumulating into one SymbolTable.
 */
function kb(...kifStrings) {
    let result;
    for (const kif of kifStrings) {
        result = parseKIF(kif, result?.symbolTable);
    }
    return result.symbolTable;
}

/**
 * Get (or create) a Term for the named symbol.
 */
function term(symbolTable, name) {
    const sym = symbolTable.symbols[name];
    if (!sym) throw new Error(`Symbol '${name}' not found`);
    return sym.forward || new Term(sym);
}

/** Run semantics and return all sentences as an array. */
function buildSentences(symbolTable) {
    realParser.semantics(symbolTable);
    return [...symbolTable.sentences];
}

// ---------------------------------------------------------------------------
// Pipeline integration tests
// ---------------------------------------------------------------------------

describe('updateFileDefinitions — pipeline error reporting', function () {

    afterEach(() => sinon.restore());

    // -----------------------------------------------------------------------
    describe('Stage 1: Tokenizer errors', function () {

        it('emits an Error diagnostic for a malformed variable name (?123)', function () {
            // '?123' — variable must start with a letter after '?'
            const kif    = '(instance ?123 Foo)';
            const fsPath = '/test/tok_err.kif';
            const docMap = new Map([[fsPath, createMockDocument(kif, fsPath)]]);
            const { state, collection } = setupState(sinon.stub().resolves(null), docMap);

            state.setKB('TestKB');
            state.updateFileDefinitions(docMap.get(fsPath), 'TestKB');

            const diags = getDiags(collection, fsPath);
            expect(diags.some(d =>
                d.severity === DiagnosticSeverity.Error &&
                /variable.*letter/i.test(d.message)
            )).to.be.true;
        });

        it('emits an Error diagnostic for a malformed row-variable name (@123)', function () {
            const kif    = '(instance @123 Foo)';
            const fsPath = '/test/tok_err2.kif';
            const docMap = new Map([[fsPath, createMockDocument(kif, fsPath)]]);
            const { state, collection } = setupState(sinon.stub().resolves(null), docMap);

            state.setKB('TestKB');
            state.updateFileDefinitions(docMap.get(fsPath), 'TestKB');

            const diags = getDiags(collection, fsPath);
            expect(diags.some(d =>
                d.severity === DiagnosticSeverity.Error &&
                /row variable.*letter/i.test(d.message)
            )).to.be.true;
        });
    });

    // -----------------------------------------------------------------------
    describe('Stage 2: Parse errors', function () {

        it('emits an Error diagnostic for an unclosed parenthesis', function () {
            const kif    = '(instance Foo';
            const fsPath = '/test/parse_err.kif';
            const docMap = new Map([[fsPath, createMockDocument(kif, fsPath)]]);
            const { state, collection } = setupState(sinon.stub().resolves(null), docMap);

            state.setKB('TestKB');
            state.updateFileDefinitions(docMap.get(fsPath), 'TestKB');

            const diags = getDiags(collection, fsPath);
            expect(diags.some(d =>
                d.severity === DiagnosticSeverity.Error &&
                /unclosed/i.test(d.message)
            )).to.be.true;
        });
    });

    // -----------------------------------------------------------------------
    describe('Stage 3: Syntax errors', function () {

        it('emits an Error diagnostic for an empty sentence ()', function () {
            const kif    = '()';
            const fsPath = '/test/syntax_err.kif';
            const docMap = new Map([[fsPath, createMockDocument(kif, fsPath)]]);
            const { state, collection } = setupState(sinon.stub().resolves(null), docMap);

            state.setKB('TestKB');
            state.updateFileDefinitions(docMap.get(fsPath), 'TestKB');

            const diags = getDiags(collection, fsPath);
            expect(diags.some(d =>
                d.severity === DiagnosticSeverity.Error &&
                /empty.*KIF/i.test(d.message)
            )).to.be.true;
        });
    });

    // -----------------------------------------------------------------------
    describe('Stage 4: validateBestPractices warnings', function () {

        const baseKif = '(subclass Foo Entity)';
        const fsPath  = '/test/best_practice.kif';

        it('emits a Warning when a defined symbol has no documentation string', function () {
            const docMap = new Map([[fsPath, createMockDocument(baseKif, fsPath)]]);
            const { state, collection } = setupState(sinon.stub().resolves(null), docMap);

            state.setKB('TestKB');
            state.updateFileDefinitions(docMap.get(fsPath), 'TestKB');

            const diags = getDiags(collection, fsPath);
            expect(diags.some(d =>
                d.severity === DiagnosticSeverity.Warning &&
                /no documentation/i.test(d.message)
            )).to.be.true;
        });

        it('emits an Information diagnostic when a defined symbol has no termFormat string', function () {
            const docMap = new Map([[fsPath, createMockDocument(baseKif, fsPath)]]);
            const { state, collection } = setupState(sinon.stub().resolves(null), docMap);

            state.setKB('TestKB');
            state.updateFileDefinitions(docMap.get(fsPath), 'TestKB');

            const diags = getDiags(collection, fsPath);
            expect(diags.some(d =>
                d.severity === DiagnosticSeverity.Information &&
                /termFormat/i.test(d.message)
            )).to.be.true;
        });

        it('emits an Information diagnostic when a Relation has no format string', function () {
            // myRel is an instance of Foo, which is a subclass of Relation — so myRel
            // isRelation=true. Best-practice check: missing format string → Information.
            const kif = [
                '(subclass Foo Relation)',
                '(subclass Relation Entity)',
                '(instance myRel Foo)',
            ].join('\n');
            const relPath = '/test/bp_relation.kif';
            const docMap  = new Map([[relPath, createMockDocument(kif, relPath)]]);
            const { state, collection } = setupState(sinon.stub().resolves(null), docMap);

            state.setKB('TestKB');
            state.updateFileDefinitions(docMap.get(relPath), 'TestKB');

            const diags = getDiags(collection, relPath);
            expect(diags.some(d =>
                d.severity === DiagnosticSeverity.Information &&
                /no format string/i.test(d.message)
            )).to.be.true;
        });
    });

    // -----------------------------------------------------------------------
    describe('Stage 5: validateFileDependencies — circular dependency', function () {

        it('emits a Warning when two files form a mutual subclass cycle', async function () {
            const pathA = '/test/cycle_a.kif';
            const pathB = '/test/cycle_b.kif';

            // File A defines Foo and references Bar (defined in B)
            const kifA = '(subclass Foo Bar)';
            // File B defines Bar and references Foo (defined in A)
            const kifB = '(subclass Bar Foo)';

            const docMap = new Map([
                [pathA, createMockDocument(kifA, pathA)],
                [pathB, createMockDocument(kifB, pathB)],
            ]);

            const { state, collection } = setupState(
                singleKBConfig('TestKB', [pathA, pathB]),
                docMap
            );

            await state.buildWorkspaceDefinitions();

            const allDiags = [
                ...getDiags(collection, pathA),
                ...getDiags(collection, pathB),
            ];

            expect(allDiags.some(d =>
                d.severity === DiagnosticSeverity.Warning &&
                /circular|cycle/i.test(d.message)
            )).to.be.true;
        });
    });
});

// ---------------------------------------------------------------------------
// Direct Term.validate() tests
//
// Term.validate() is NOT called in the pipeline; these tests exercise the
// validation logic directly via the Term API.
// ---------------------------------------------------------------------------

describe('Term.validate() — semantic validation rules', function () {

    // -----------------------------------------------------------------------
    // Rule 1: Entity ancestry

    it('throws when a symbol has no derivation to Entity', function () {
        const st = kb(
            '(instance foo Unrelated)',
            '(subclass Unrelated IslandClass)'
        );
        realParser.semantics(st);
        const t = term(st, 'foo');
        expect(() => t.validate()).to.throw(SemanticError, /derivation to Entity/i);
    });

    // -----------------------------------------------------------------------
    // domain getter errors

    it('domain: throws when the position index is a non-numeric string literal', function () {
        // Use a string literal "notANumber" so it passes _LIT_ lookup but fails
        // the Number() coercion check inside the getter.
        const st = kb(
            '(subclass ArgClass Entity)',
            '(instance myRel BinaryRelation)',
            '(subclass BinaryRelation Relation)',
            '(subclass Relation Entity)',
            '(domain myRel "notANumber" ArgClass)'
        );
        realParser.semantics(st);
        const t = term(st, 'myRel');
        expect(() => t.domain).to.throw(SemanticError, /numerical literal/i);
    });

    it('domain: throws when the type argument is not a class (is an instance)', function () {
        const st = kb(
            '(instance ArgInstance Entity)',   // instance, not class
            '(instance myRel BinaryRelation)',
            '(subclass BinaryRelation Relation)',
            '(subclass Relation Entity)',
            '(domain myRel 1 ArgInstance)'
        );
        realParser.semantics(st);
        const t = term(st, 'myRel');
        expect(() => t.domain).to.throw(SemanticError, /class symbol/i);
    });

    // -----------------------------------------------------------------------
    // domainSubclass getter errors

    it('domainSubclass: throws when the position index is a non-numeric string literal', function () {
        const st = kb(
            '(subclass ArgClass Entity)',
            '(instance myRel BinaryRelation)',
            '(subclass BinaryRelation Relation)',
            '(subclass Relation Entity)',
            '(domainSubclass myRel "notANumber" ArgClass)'
        );
        realParser.semantics(st);
        const t = term(st, 'myRel');
        expect(() => t.domainSubclass).to.throw(SemanticError, /numerical literal/i);
    });

    it('domainSubclass: throws when the type argument is not a class', function () {
        const st = kb(
            '(instance ArgInstance Entity)',
            '(instance myRel BinaryRelation)',
            '(subclass BinaryRelation Relation)',
            '(subclass Relation Entity)',
            '(domainSubclass myRel 1 ArgInstance)'
        );
        realParser.semantics(st);
        const t = term(st, 'myRel');
        expect(() => t.domainSubclass).to.throw(SemanticError, /class symbol/i);
    });

    // -----------------------------------------------------------------------
    // range getter errors

    it('range: throws when the range type is not a class', function () {
        const st = kb(
            '(instance RangeInstance Entity)',
            '(instance myFn BinaryFunction)',
            '(subclass BinaryFunction Function)',
            '(subclass BinaryFunction BinaryRelation)',
            '(subclass BinaryRelation Relation)',
            '(subclass Function Relation)',
            '(subclass Relation Entity)',
            '(range myFn RangeInstance)'
        );
        realParser.semantics(st);
        const t = term(st, 'myFn');
        expect(() => t.range).to.throw(SemanticError, /class symbol/i);
    });

    // -----------------------------------------------------------------------
    // rangeSubclass getter errors

    it('rangeSubclass: throws when the rangeSubclass type is not a class', function () {
        const st = kb(
            '(instance RangeInstance Entity)',
            '(instance myFn BinaryFunction)',
            '(subclass BinaryFunction Function)',
            '(subclass BinaryFunction BinaryRelation)',
            '(subclass BinaryRelation Relation)',
            '(subclass Function Relation)',
            '(subclass Relation Entity)',
            '(rangeSubclass myFn RangeInstance)'
        );
        realParser.semantics(st);
        const t = term(st, 'myFn');
        expect(() => t.rangeSubclass).to.throw(SemanticError, /class symbol/i);
    });

    // -----------------------------------------------------------------------
    // validate() Rule 2: domain + domainSubclass cannot both exist on same index

    it('validate: throws when domain and domainSubclass overlap on the same index', function () {
        const st = kb(
            '(subclass ArgClass Entity)',
            '(instance myRel BinaryRelation)',
            '(subclass BinaryRelation Relation)',
            '(subclass Relation Entity)',
            '(domain myRel 1 ArgClass)',
            '(domainSubclass myRel 1 ArgClass)'
        );
        realParser.semantics(st);
        const t = term(st, 'myRel');
        expect(() => t.validate()).to.throw(SemanticError, /domain and domainSubclass/i);
    });

    // -----------------------------------------------------------------------
    // validate() Rule 3: arity must be >= domain count

    it('validate: throws when arity is less than the number of domain terms', function () {
        // TernaryRelation has arity 3; four domain positions → arity < domain count
        const st = kb(
            '(subclass ArgClass Entity)',
            '(subclass TernaryRelation Relation)',
            '(subclass Relation Entity)',
            '(instance myPred TernaryRelation)',
            '(domain myPred 1 ArgClass)',
            '(domain myPred 2 ArgClass)',
            '(domain myPred 3 ArgClass)',
            '(domain myPred 4 ArgClass)'
        );
        realParser.semantics(st);
        const t = term(st, 'myPred');
        expect(() => t.validate()).to.throw(SemanticError, /arity.*less than/i);
    });

    // -----------------------------------------------------------------------
    // arity getter error: relation has no arity-class ancestor

    it('arity: throws when a relation has no arity-class ancestor', function () {
        const st = kb(
            '(instance myRel Relation)',
            '(subclass Relation Entity)'
        );
        realParser.semantics(st);
        const t = term(st, 'myRel');
        expect(() => t.arity).to.throw(SemanticError, /missing.*arity|arity.*class/i);
    });

    // -----------------------------------------------------------------------
    // validate() Rule 4: Function must have a range

    it('validate: throws when a Function has no range statement', function () {
        const st = kb(
            '(subclass ArgClass Entity)',
            '(subclass BinaryFunction Function)',
            '(subclass BinaryFunction BinaryRelation)',
            '(subclass BinaryRelation Relation)',
            '(subclass Function Relation)',
            '(subclass Relation Entity)',
            '(instance MyFn BinaryFunction)',
            '(domain MyFn 1 ArgClass)'
        );
        realParser.semantics(st);
        const t = term(st, 'MyFn');
        expect(() => t.validate()).to.throw(SemanticError, /no range/i);
    });

    // validate() Rule 4b: Function cannot have both range and rangeSubclass

    it('validate: throws when a Function has both range and rangeSubclass', function () {
        const st = kb(
            '(subclass ArgClass Entity)',
            '(subclass BinaryFunction Function)',
            '(subclass BinaryFunction BinaryRelation)',
            '(subclass BinaryRelation Relation)',
            '(subclass Function Relation)',
            '(subclass Relation Entity)',
            '(instance MyFn BinaryFunction)',
            '(domain MyFn 1 ArgClass)',
            '(range MyFn ArgClass)',
            '(rangeSubclass MyFn ArgClass)'
        );
        realParser.semantics(st);
        const t = term(st, 'MyFn');
        expect(() => t.validate()).to.throw(SemanticError, /range and rangeSubclass/i);
    });

    // -----------------------------------------------------------------------
    // validate() Rule 5: naming conventions

    it('validate: throws when a Function name starts with a lowercase letter', function () {
        const st = kb(
            '(subclass ArgClass Entity)',
            '(subclass BinaryFunction Function)',
            '(subclass BinaryFunction BinaryRelation)',
            '(subclass BinaryRelation Relation)',
            '(subclass Function Relation)',
            '(subclass Relation Entity)',
            '(instance myFn BinaryFunction)',  // lowercase 'm'
            '(domain myFn 1 ArgClass)',
            '(range myFn ArgClass)'
        );
        realParser.semantics(st);
        const t = term(st, 'myFn');
        expect(() => t.validate()).to.throw(SemanticError, /uppercase/i);
    });

    it('validate: throws when a Predicate name starts with an uppercase letter', function () {
        const st = kb(
            '(subclass ArgClass Entity)',
            '(subclass BinaryPredicate Predicate)',
            '(subclass BinaryPredicate BinaryRelation)',
            '(subclass Predicate Relation)',
            '(subclass BinaryRelation Relation)',
            '(subclass Relation Entity)',
            '(instance MyPred BinaryPredicate)',  // uppercase 'M'
            '(domain MyPred 1 ArgClass)',
            '(domain MyPred 2 ArgClass)'
        );
        realParser.semantics(st);
        const t = term(st, 'MyPred');
        expect(() => t.validate()).to.throw(SemanticError, /lowercase/i);
    });
});

// ---------------------------------------------------------------------------
// Direct Formula.validate() tests
// ---------------------------------------------------------------------------

describe('Formula.validate() — semantic validation rules', function () {

    // -----------------------------------------------------------------------
    // Rule 1: Operator arguments must be logical sentences (not plain symbols)

    it('throws when a logical operator receives a non-logical (class) argument', function () {
        // (and Foo Bar) — Foo and Bar are classes, not predicate sentences.
        // Formula.validate() walks args and calls s.forward.logical — Term.logical
        // is undefined (falsy), so the check fires.
        const st = kb(
            '(subclass Foo Entity)',
            '(subclass Bar Entity)',
            '(and Foo Bar)'
        );
        realParser.semantics(st);
        const sentences = [...st.sentences];
        sentences.forEach(s => { if (!s.forward) new Formula(s); });
        const lastFormula = sentences[sentences.length - 1].forward;

        expect(() => lastFormula.validate())
            .to.throw(SemanticError, /operator.*predicate/i);
    });

    // -----------------------------------------------------------------------
    // Rule 2: A non-operator sentence must start with a relation

    it('throws when a sentence starts with something that is not a relation', function () {
        // (NotARelation Foo Bar) — NotARelation is a class, not a Predicate/Function.
        const st = kb(
            '(subclass NotARelation Entity)',
            '(subclass Foo Entity)',
            '(subclass Bar Entity)',
            '(NotARelation Foo Bar)'
        );
        realParser.semantics(st);
        const sentences = [...st.sentences];
        sentences.forEach(s => { if (!s.forward) new Formula(s); });
        const lastFormula = sentences[sentences.length - 1].forward;

        expect(() => lastFormula.validate())
            .to.throw(SemanticError, /relation/i);
    });

    // -----------------------------------------------------------------------
    // Rule 3: Arity mismatch

    it('throws when a sentence provides the wrong number of arguments', function () {
        // myPred is a BinaryPredicate (arity 2), called with 3 arguments.
        const st = kb(
            '(subclass ArgClass Entity)',
            '(subclass BinaryPredicate Predicate)',
            '(subclass BinaryPredicate BinaryRelation)',
            '(subclass Predicate Relation)',
            '(subclass BinaryRelation Relation)',
            '(subclass Relation Entity)',
            '(instance myPred BinaryPredicate)',
            '(domain myPred 1 ArgClass)',
            '(domain myPred 2 ArgClass)',
            '(instance arg1 ArgClass)',
            '(instance arg2 ArgClass)',
            '(instance arg3 ArgClass)',
            '(myPred arg1 arg2 arg3)'   // arity=2 but 3 args
        );
        realParser.semantics(st);
        const sentences = [...st.sentences];
        sentences.forEach(s => { if (!s.forward) new Formula(s); });
        const lastFormula = sentences[sentences.length - 1].forward;

        expect(() => lastFormula.validate())
            .to.throw(SemanticError, /arity mismatch/i);
    });
});
