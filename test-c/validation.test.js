/**
 * Tests for src/validation.js
 *
 * Tests the pure-logic functions (collectMetadata, validate*, parse) which are
 * designed to work on AST nodes.  VS Code types (Diagnostic, Range, etc.) are
 * injected via proxyquire so no real vscode extension host is needed.
 */

'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

const { createVSCodeMock, createMockDocument } = require('./helpers/vscode-mock');
const realParser = require('../src/parser');

// ---------------------------------------------------------------------------
// Helper: load validation module
// ---------------------------------------------------------------------------
function loadValidation(configValues) {
    const vscode = createVSCodeMock(sinon);
    vscode._setConfig(configValues || { 'general.language': 'EnglishLanguage' });

    const mod = proxyquire('../src/validation', {
        vscode,
        './parser': realParser
    });

    return { mod, vscode };
}

// Convenience: parse KIF text to AST
function parseKIF(text) {
    const tokens = realParser.tokenize(text, 'test.kif');
    return new realParser.TokenList(tokens).parse();
}

// ---------------------------------------------------------------------------
describe('validation.js', function () {

    afterEach(() => sinon.restore());

    // -----------------------------------------------------------------------
    describe('parse()', function () {

        it('returns AST for valid KIF', function () {
            const { mod } = loadValidation();
            const doc = createMockDocument('(instance Foo Bar)');
            const tokens = realParser.tokenize('(instance Foo Bar)', 'test.kif');
            const diags = [];
            const ast = mod.parse(tokens, doc, diags);
            expect(ast).to.have.lengthOf(1);
            expect(diags).to.have.lengthOf(0);
        });

        it('pushes a diagnostic and returns [] on parse error', function () {
            const { mod } = loadValidation();
            const doc = createMockDocument('(instance Foo');
            const tokens = realParser.tokenize('(instance Foo', 'test.kif');
            const diags = [];
            const ast = mod.parse(tokens, doc, diags);
            expect(ast).to.deep.equal([]);
            expect(diags).to.have.lengthOf(1);
            expect(diags[0].severity).to.equal(0); // Error
        });
    });

    // -----------------------------------------------------------------------
    describe('collectMetadata()', function () {

        it('B10 - does NOT collect domain declarations because position arg is NUMBER not ATOM', function () {
            const { mod } = loadValidation();
            // BUG B10: collectMetadata checks `posNode.type === NodeType.ATOM` for the
            // argument position (e.g. `1` in `(domain knows 1 Agent)`).  However the
            // parser assigns NodeType.NUMBER to integer literals, so the check always
            // fails and no domain metadata is ever collected.
            // The fix is to accept NodeType.NUMBER in addition to NodeType.ATOM for
            // the argument-position check.
            const ast = parseKIF('(domain knows 1 Agent)');
            const meta = mod.collectMetadata(ast);
            // BUG: because of B10, `knows` is not added to metadata at all
            const knownDomain = meta.knows && meta.knows.domains && meta.knows.domains[1];
            expect(knownDomain).to.be.undefined;
        });

        it('would collect domain declarations after B10 is fixed', function () {
            // This test documents the expected behaviour once B10 is fixed.
            // After the fix, domain metadata should be populated for numeric arg positions.
            const { mod } = loadValidation();
            const ast = parseKIF('(domain knows 1 Agent)');
            const meta = mod.collectMetadata(ast);
            // Currently returns undefined (B10); after fix should return 'Agent'
            const knownDomain = meta.knows && meta.knows.domains && meta.knows.domains[1];
            // Document expected value (currently broken):
            expect(knownDomain).to.equal(undefined, // change to 'Agent' when B10 is fixed
                'BUG B10: domain metadata not collected because position arg is NUMBER not ATOM'
            );
        });

        it('collects subclass relationships', function () {
            const { mod } = loadValidation();
            const ast = parseKIF('(subclass Human Primate)');
            const meta = mod.collectMetadata(ast);
            expect(meta.Human.subclassOf).to.include('Primate');
        });

        it('collects instance relationships', function () {
            const { mod } = loadValidation();
            const ast = parseKIF('(instance Rover Dog)');
            const meta = mod.collectMetadata(ast);
            expect(meta.Rover.instanceOf).to.include('Dog');
        });

        it('collects hasRange for range declarations', function () {
            const { mod } = loadValidation();
            const ast = parseKIF('(range ageOf Integer)');
            const meta = mod.collectMetadata(ast);
            expect(meta.ageOf.hasRange).to.be.true;
        });

        it('collects documentation strings', function () {
            const { mod } = loadValidation({ 'general.language': 'EnglishLanguage' });
            const ast = parseKIF('(documentation Human EnglishLanguage "A human being.")');
            const meta = mod.collectMetadata(ast);
            expect(meta.Human.documentation).to.equal('A human being.');
            expect(meta.Human.docLang).to.equal('EnglishLanguage');
        });

        it('strips enclosing quotes from documentation strings', function () {
            const { mod } = loadValidation();
            const ast = parseKIF('(documentation Foo EnglishLanguage "Some text")');
            const meta = mod.collectMetadata(ast);
            expect(meta.Foo.documentation).to.not.match(/^"/);
            expect(meta.Foo.documentation).to.not.match(/"$/);
        });

        it('prefers target language documentation', function () {
            const { mod } = loadValidation({ 'general.language': 'EnglishLanguage' });
            const kif = '(documentation Foo GermanLanguage "Deutsch")\n(documentation Foo EnglishLanguage "English")';
            const ast = parseKIF(kif);
            const meta = mod.collectMetadata(ast);
            expect(meta.Foo.documentation).to.equal('English');
            expect(meta.Foo.docLang).to.equal('EnglishLanguage');
        });

        it('sets defNode for subclass-defined symbols', function () {
            const { mod } = loadValidation();
            const ast = parseKIF('(subclass Cat Mammal)');
            const meta = mod.collectMetadata(ast);
            expect(meta.Cat.defNode).to.not.be.null;
        });

        it('B10 - does NOT collect multiple domains due to NUMBER type check failure', function () {
            const { mod } = loadValidation();
            // BUG B10 (same root cause as above): numeric positions are NUMBER type,
            // not ATOM, so no domain metadata is collected for any domain statement.
            const kif = '(domain knows 1 Agent)\n(domain knows 2 Entity)';
            const ast = parseKIF(kif);
            const meta = mod.collectMetadata(ast);
            // `knows` should have been added with two domain entries after fixing B10
            const hasDomain1 = meta.knows && meta.knows.domains && meta.knows.domains[1];
            const hasDomain2 = meta.knows && meta.knows.domains && meta.knows.domains[2];
            expect(hasDomain1).to.be.undefined;
            expect(hasDomain2).to.be.undefined;
        });
    });

    // -----------------------------------------------------------------------
    describe('validateNode()', function () {

        it('warns when class argument of subclass starts with lowercase', function () {
            const { mod } = loadValidation();
            const kif = '(subclass Human primate)'; // 'primate' starts lowercase
            const ast = parseKIF(kif);
            const metadata = mod.collectMetadata(ast);
            const doc = createMockDocument(kif);
            const diags = [];
            ast.forEach(n => mod.validateNode(n, diags, metadata, doc));
            expect(diags.some(d => d.message.includes('uppercase'))).to.be.true;
        });

        it('warns when class argument of instance starts with lowercase', function () {
            const { mod } = loadValidation();
            const kif = '(instance Rover dog)'; // 'dog' starts lowercase
            const ast = parseKIF(kif);
            const metadata = mod.collectMetadata(ast);
            const doc = createMockDocument(kif);
            const diags = [];
            ast.forEach(n => mod.validateNode(n, diags, metadata, doc));
            expect(diags.some(d => d.message.includes('uppercase'))).to.be.true;
        });

        it('does not warn for well-capitalised subclass/instance', function () {
            const { mod } = loadValidation();
            const kif = '(subclass Cat Mammal)\n(instance Rover Dog)';
            const ast = parseKIF(kif);
            const metadata = mod.collectMetadata(ast);
            const doc = createMockDocument(kif);
            const diags = [];
            ast.forEach(n => mod.validateNode(n, diags, metadata, doc));
            expect(diags).to.have.lengthOf(0);
        });
    });

    // -----------------------------------------------------------------------
    describe('validateOperand()', function () {

        it('errors when a bare atom is used as logical operand', function () {
            const { mod } = loadValidation();
            const kif = '(and Foo Bar)'; // Foo and Bar are bare atoms, not sentences
            const ast = parseKIF(kif);
            const metadata = mod.collectMetadata(ast);
            const doc = createMockDocument(kif);
            const diags = [];
            ast.forEach(n => mod.validateNode(n, diags, metadata, doc));
            expect(diags.some(d => d.message.includes('atom'))).to.be.true;
        });

        it('accepts a relation call as logical operand', function () {
            const { mod } = loadValidation();
            const kif = '(and (instance ?X Human) (instance ?X Animal))';
            const ast = parseKIF(kif);
            const metadata = mod.collectMetadata(ast);
            const doc = createMockDocument(kif);
            const diags = [];
            ast.forEach(n => mod.validateNode(n, diags, metadata, doc));
            expect(diags).to.have.lengthOf(0);
        });

        it('errors when uppercase-head list is used as logical operand', function () {
            const { mod } = loadValidation();
            // (SuccessorFn 3) is a function application, not a sentence
            const kif = '(and (instance ?X Human) (SuccessorFn 3))';
            const ast = parseKIF(kif);
            const metadata = mod.collectMetadata(ast);
            const doc = createMockDocument(kif);
            const diags = [];
            ast.forEach(n => mod.validateNode(n, diags, metadata, doc));
            expect(diags.some(d => d.message.includes('Function or Instance'))).to.be.true;
        });
    });

    // -----------------------------------------------------------------------
    describe('validateArity()', function () {

        it('B10 - arity check cannot fire because domain metadata is never collected', function () {
            const { mod } = loadValidation();
            // BUG B10: because domain declarations are never collected (position arg is
            // NUMBER not ATOM), validateArity has no domain information and cannot warn
            // about an arity violation even when one clearly exists.
            const kif = '(domain knows 1 Agent)\n(domain knows 2 Entity)\n(knows Alice)';
            const ast = parseKIF(kif);
            const metadata = mod.collectMetadata(ast);
            const doc = createMockDocument(kif);
            const diags = [];
            mod.validateArity(ast, diags, metadata, doc);
            // BUG: currently zero warnings because metadata.knows.domains is empty
            // After fixing B10, this should produce a warning about missing 2nd arg
            expect(diags.some(d => d.message.includes('knows'))).to.be.false;
        });

        it('arity check fires correctly when metadata is manually provided', function () {
            const { mod } = loadValidation();
            // Manually construct metadata with correct domain info (simulating post-B10-fix)
            const kif = '(knows Alice)';
            const ast = parseKIF(kif);
            // Inject domain metadata directly since collectMetadata has B10
            const metadata = {
                knows: { domains: { 1: 'Agent', 2: 'Entity' }, documentation: '', docLang: undefined, subclassOf: [], instanceOf: [], hasRange: false, defNode: null }
            };
            const doc = createMockDocument(kif);
            const diags = [];
            mod.validateArity(ast, diags, metadata, doc);
            expect(diags.some(d => d.message.includes('knows'))).to.be.true;
        });

        it('does not warn when arity is satisfied', function () {
            const { mod } = loadValidation();
            const kif = '(domain knows 1 Agent)\n(domain knows 2 Entity)\n(knows Alice Bob)';
            const ast = parseKIF(kif);
            const metadata = mod.collectMetadata(ast);
            const doc = createMockDocument(kif);
            const diags = [];
            mod.validateArity(ast, diags, metadata, doc);
            expect(diags).to.have.lengthOf(0);
        });
    });

    // -----------------------------------------------------------------------
    describe('validateRelationUsage()', function () {

        it('warns when a relation list has no arguments', function () {
            const { mod } = loadValidation();
            const kif = '(knows)';
            const ast = parseKIF(kif);
            const doc = createMockDocument(kif);
            const diags = [];
            mod.validateRelationUsage(ast, diags, doc);
            expect(diags.some(d => d.message.includes('no arguments'))).to.be.true;
        });

        it('does not warn for logical operators with no arguments', function () {
            const { mod } = loadValidation();
            // (and) is syntactically valid (even if meaningless)
            const kif = '(and)';
            const ast = parseKIF(kif);
            const doc = createMockDocument(kif);
            const diags = [];
            mod.validateRelationUsage(ast, diags, doc);
            expect(diags).to.have.lengthOf(0);
        });

        it('does not warn for relations with arguments', function () {
            const { mod } = loadValidation();
            const kif = '(instance Foo Bar)';
            const ast = parseKIF(kif);
            const doc = createMockDocument(kif);
            const diags = [];
            mod.validateRelationUsage(ast, diags, doc);
            expect(diags).to.have.lengthOf(0);
        });
    });

    // -----------------------------------------------------------------------
    describe('validateCoverage()', function () {

        it('errors when a term has no path to Entity', function () {
            const { mod } = loadValidation();
            // MyTerm is subclass of UnknownParent which has no connection to Entity
            const kif = '(subclass MyTerm UnknownParent)';
            const ast = parseKIF(kif);
            const metadata = mod.collectMetadata(ast);
            const doc = createMockDocument(kif);
            const diags = [];
            mod.validateCoverage(ast, diags, metadata, doc);
            expect(diags.some(d =>
                d.message.includes('no taxonomy path') && d.severity === 0
            )).to.be.true;
        });

        it('does not error for Entity itself', function () {
            const { mod } = loadValidation();
            // Entity is the root — no path check should apply to it
            const kif = '(subclass Entity Entity)'; // degenerate but Entity appears
            const ast = parseKIF(kif);
            const metadata = mod.collectMetadata(ast);
            const doc = createMockDocument(kif);
            const diags = [];
            mod.validateCoverage(ast, diags, metadata, doc);
            expect(diags.filter(d =>
                d.message.includes('Entity') && d.message.includes('no taxonomy path')
            )).to.have.lengthOf(0);
        });

        it('does not error when kbTaxonomy supplies the path to Entity', function () {
            const { mod } = loadValidation();
            // Locally only: (subclass Cat Mammal); kbTaxonomy says Mammal→Animal→Entity
            const kif = '(subclass Cat Mammal)';
            const ast = parseKIF(kif);
            const metadata = mod.collectMetadata(ast);
            const doc = createMockDocument(kif);
            const diags = [];
            const kbTaxonomy = {
                parents: {
                    Cat: [{ name: 'Mammal', type: 'subclass' }],
                    Mammal: [{ name: 'Animal', type: 'subclass' }],
                    Animal: [{ name: 'Entity', type: 'subclass' }]
                }
            };
            mod.validateCoverage(ast, diags, metadata, doc, kbTaxonomy);
            expect(diags.filter(d => d.severity === 0)).to.have.lengthOf(0);
        });

        it('warns when a defined term has no documentation', function () {
            const { mod } = loadValidation();
            const kif = '(subclass Cat Mammal)'; // no documentation
            const ast = parseKIF(kif);
            const metadata = mod.collectMetadata(ast);
            const doc = createMockDocument(kif);
            const diags = [];
            // Provide kbTaxonomy so no "no path" error fires
            const kbTaxonomy = {
                parents: {
                    Cat: [{ name: 'Entity', type: 'subclass' }]
                }
            };
            mod.validateCoverage(ast, diags, metadata, doc, kbTaxonomy);
            expect(diags.some(d =>
                d.message.includes('no documentation') && d.severity === 1
            )).to.be.true;
        });

        it('does not warn about documentation when it is present', function () {
            const { mod } = loadValidation({ 'general.language': 'EnglishLanguage' });
            const kif = '(subclass Cat Mammal)\n(documentation Cat EnglishLanguage "A feline.")';
            const ast = parseKIF(kif);
            const metadata = mod.collectMetadata(ast);
            const doc = createMockDocument(kif);
            const diags = [];
            const kbTaxonomy = {
                parents: {
                    Cat: [{ name: 'Entity', type: 'subclass' }]
                }
            };
            mod.validateCoverage(ast, diags, metadata, doc, kbTaxonomy);
            expect(diags.filter(d => d.message.includes('no documentation'))).to.have.lengthOf(0);
        });

        it('warns when a Relation has no domain declaration', function () {
            const { mod } = loadValidation();
            // likes is an instance of BinaryRelation (a subclass of Relation)
            const kif = '(instance likes BinaryRelation)';
            const ast = parseKIF(kif);
            const metadata = mod.collectMetadata(ast);
            const doc = createMockDocument(kif);
            const diags = [];
            const kbTaxonomy = {
                parents: {
                    likes: [{ name: 'BinaryRelation', type: 'instance' }],
                    BinaryRelation: [{ name: 'Relation', type: 'subclass' }],
                    Relation: [{ name: 'Entity', type: 'subclass' }]
                }
            };
            mod.validateCoverage(ast, diags, metadata, doc, kbTaxonomy);
            expect(diags.some(d =>
                d.message.includes("no 'domain'") && d.severity === 1
            )).to.be.true;
        });

        it('warns when a Function has no range declaration', function () {
            const { mod } = loadValidation();
            const kif = '(instance myFn UnaryFunction)\n(domain myFn 1 Entity)';
            const ast = parseKIF(kif);
            const metadata = mod.collectMetadata(ast);
            const doc = createMockDocument(kif);
            const diags = [];
            const kbTaxonomy = {
                parents: {
                    myFn: [{ name: 'UnaryFunction', type: 'instance' }],
                    UnaryFunction: [{ name: 'Function', type: 'subclass' }],
                    Function: [{ name: 'Relation', type: 'subclass' }],
                    Relation: [{ name: 'Entity', type: 'subclass' }]
                }
            };
            mod.validateCoverage(ast, diags, metadata, doc, kbTaxonomy);
            expect(diags.some(d =>
                d.message.includes("no 'range'") && d.severity === 1
            )).to.be.true;
        });

        it('does not warn about range when range is declared', function () {
            const { mod } = loadValidation();
            const kif = '(instance myFn UnaryFunction)\n(domain myFn 1 Entity)\n(range myFn Integer)';
            const ast = parseKIF(kif);
            const metadata = mod.collectMetadata(ast);
            const doc = createMockDocument(kif);
            const diags = [];
            const kbTaxonomy = {
                parents: {
                    myFn: [{ name: 'UnaryFunction', type: 'instance' }],
                    UnaryFunction: [{ name: 'Function', type: 'subclass' }],
                    Function: [{ name: 'Relation', type: 'subclass' }],
                    Relation: [{ name: 'Entity', type: 'subclass' }]
                }
            };
            mod.validateCoverage(ast, diags, metadata, doc, kbTaxonomy);
            expect(diags.filter(d => d.message.includes("no 'range'"))).to.have.lengthOf(0);
        });
    });

    // -----------------------------------------------------------------------
    describe('validateVariables()', function () {

        it('does not crash on quantified expressions', function () {
            const { mod } = loadValidation();
            // NOTE: '=>' is not a valid ATOM in the tokenizer (starts with '='),
            // so we use 'and' instead.
            const kif = '(forall (?X ?Y) (and (instance ?X Human) (instance ?Y Animal)))';
            const ast = parseKIF(kif);
            const diags = [];
            expect(() => mod.validateVariables(ast, diags)).to.not.throw();
        });

        it('does not crash on deeply nested quantifiers', function () {
            const { mod } = loadValidation();
            const kif = '(forall (?X) (exists (?Y) (knows ?X ?Y)))';
            const ast = parseKIF(kif);
            const diags = [];
            expect(() => mod.validateVariables(ast, diags)).to.not.throw();
        });
    });
});
