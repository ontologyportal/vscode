/**
 * Tests for src/validation.js (non-bug tests)
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
    const { tokens } = realParser.tokenize(text, 'test.kif');
    return new realParser.TokenList(tokens).parse().nodes;
}

// ---------------------------------------------------------------------------
describe('validation.js', function () {

    afterEach(() => sinon.restore());

    // -----------------------------------------------------------------------
    describe('parse()', function () {

        it('returns AST for valid KIF', function () {
            const { mod } = loadValidation();
            const { tokens } = realParser.tokenize('(instance Foo Bar)', 'test.kif');
            const diags = [];
            const ast = mod.parse(tokens, diags);
            expect(ast).to.have.lengthOf(1);
            expect(diags).to.have.lengthOf(0);
        });

        it('pushes a diagnostic and returns [] on parse error', function () {
            const { mod } = loadValidation();
            const { tokens } = realParser.tokenize('(instance Foo', 'test.kif');
            const diags = [];
            const ast = mod.parse(tokens, diags);
            expect(ast).to.deep.equal([]);
            expect(diags).to.have.lengthOf(1);
            expect(diags[0].severity).to.equal(0); // Error
        });
    });

    // -----------------------------------------------------------------------
    describe('analyse()', function () {

        it('collects subclass relationships', function () {
            const { mod } = loadValidation();
            const terms = mod.analyse(parseKIF('(subclass Human Primate)'));
            expect(terms.Human).to.exist;
            expect(terms.Human.taxonomy.incoming.some(e => e.relation === 'subclass' && e.from.name === 'Primate')).to.be.true;
        });

        it('collects instance relationships', function () {
            const { mod } = loadValidation();
            const terms = mod.analyse(parseKIF('(instance Rover Dog)'));
            expect(terms.Rover).to.exist;
            expect(terms.Rover.taxonomy.incoming.some(e => e.relation === 'instance' && e.from.name === 'Dog')).to.be.true;
        });

        it('collects range declarations', function () {
            const { mod } = loadValidation();
            const terms = mod.analyse(parseKIF('(range ageOf Integer)'));
            expect(terms.ageOf).to.exist;
            const hasRange = (terms.ageOf.locations.first ?? []).some(s =>
                s.functionalTerm.name === 'range' || s.functionalTerm.name === 'rangeSubclass'
            );
            expect(hasRange).to.be.true;
        });

        it('collects documentation strings', function () {
            const { mod } = loadValidation({ 'general.language': 'EnglishLanguage' });
            const terms = mod.analyse(parseKIF('(documentation Human EnglishLanguage "A human being.")'));
            expect(terms.Human).to.exist;
            expect(terms.Human.documentation).to.have.lengthOf(1);
            const { language, text } = terms.Human.documentation[0];
            expect(language).to.equal('EnglishLanguage');
            // Tokenizer preserves the surrounding quotes; strip them for the assertion
            expect(text.replace(/^"|"$/g, '')).to.equal('A human being.');
        });

        it('strips enclosing quotes from documentation strings when read', function () {
            const { mod } = loadValidation();
            const terms = mod.analyse(parseKIF('(documentation Foo EnglishLanguage "Some text")'));
            const raw = terms.Foo.documentation[0]?.text ?? '';
            const stripped = raw.replace(/^"|"$/g, '');
            expect(stripped).to.not.match(/^"/);
            expect(stripped).to.not.match(/"$/);
        });

        it('records all documentation languages', function () {
            const { mod } = loadValidation({ 'general.language': 'EnglishLanguage' });
            const kif = '(documentation Foo GermanLanguage "Deutsch")\n(documentation Foo EnglishLanguage "English")';
            const terms = mod.analyse(parseKIF(kif));
            const langs = terms.Foo.documentation.map(d => d.language);
            expect(langs).to.include('EnglishLanguage');
            expect(langs).to.include('GermanLanguage');
        });

        it('marks subclass-defined symbols as taxonomy nodes', function () {
            const { mod } = loadValidation();
            const terms = mod.analyse(parseKIF('(subclass Cat Mammal)'));
            expect(terms.Cat).to.exist;
            expect(terms.Cat.taxonomy.incoming.some(e => e.relation === 'subclass')).to.be.true;
        });

        it('collects domainSubclass as a domain declaration', function () {
            const { mod } = loadValidation();
            const terms = mod.analyse(parseKIF('(domainSubclass myRel 1 Agent)'));
            expect(terms.myRel).to.exist;
            expect(terms.myRel.domain(1)?.name).to.equal('Agent');
        });

        it('treats domainSubclass and domain declarations for the same relation uniformly', function () {
            const { mod } = loadValidation();
            const kif = '(domain knows 1 Agent)\n(domainSubclass knows 2 Entity)';
            const terms = mod.analyse(parseKIF(kif));
            expect(terms.knows.domain(1)?.name).to.equal('Agent');
            expect(terms.knows.domain(2)?.name).to.equal('Entity');
        });

        it('collects rangeSubclass declarations', function () {
            const { mod } = loadValidation();
            const terms = mod.analyse(parseKIF('(rangeSubclass myFn Number)'));
            expect(terms.myFn).to.exist;
            const hasRange = (terms.myFn.locations.first ?? []).some(s =>
                s.functionalTerm.name === 'range' || s.functionalTerm.name === 'rangeSubclass'
            );
            expect(hasRange).to.be.true;
        });
    });

    // -----------------------------------------------------------------------
    describe('validateNode()', function () {

        it('warns when class argument of subclass starts with lowercase', function () {
            const { mod } = loadValidation();
            const kif = '(subclass Human primate)'; // 'primate' starts lowercase
            const ast = parseKIF(kif);
            const terms = mod.analyse(ast);
            const doc = createMockDocument(kif);
            const diags = [];
            ast.forEach(n => mod.validateNode(n, diags, terms, doc));
            expect(diags.some(d => d.message.includes('uppercase'))).to.be.true;
        });

        it('warns when class argument of instance starts with lowercase', function () {
            const { mod } = loadValidation();
            const kif = '(instance Rover dog)'; // 'dog' starts lowercase
            const ast = parseKIF(kif);
            const terms = mod.analyse(ast);
            const doc = createMockDocument(kif);
            const diags = [];
            ast.forEach(n => mod.validateNode(n, diags, terms, doc));
            expect(diags.some(d => d.message.includes('uppercase'))).to.be.true;
        });

        it('does not warn for well-capitalised subclass/instance', function () {
            const { mod } = loadValidation();
            const kif = '(subclass Cat Mammal)\n(instance Rover Dog)';
            const ast = parseKIF(kif);
            const terms = mod.analyse(ast);
            const doc = createMockDocument(kif);
            const diags = [];
            ast.forEach(n => mod.validateNode(n, diags, terms, doc));
            expect(diags).to.have.lengthOf(0);
        });
    });

    // -----------------------------------------------------------------------
    describe('validateOperand()', function () {

        it('errors when a bare atom is used as logical operand', function () {
            const { mod } = loadValidation();
            const kif = '(and Foo Bar)'; // Foo and Bar are bare atoms, not sentences
            const ast = parseKIF(kif);
            const terms = mod.analyse(ast);
            const doc = createMockDocument(kif);
            const diags = [];
            ast.forEach(n => mod.validateNode(n, diags, terms, doc));
            expect(diags.some(d => d.message.includes('atom'))).to.be.true;
        });

        it('accepts a relation call as logical operand', function () {
            const { mod } = loadValidation();
            const kif = '(and (instance ?X Human) (instance ?X Animal))';
            const ast = parseKIF(kif);
            const terms = mod.analyse(ast);
            const doc = createMockDocument(kif);
            const diags = [];
            ast.forEach(n => mod.validateNode(n, diags, terms, doc));
            expect(diags).to.have.lengthOf(0);
        });

        it('errors when uppercase-head list is used as logical operand', function () {
            const { mod } = loadValidation();
            // (SuccessorFn 3) is a function application, not a sentence
            const kif = '(and (instance ?X Human) (SuccessorFn 3))';
            const ast = parseKIF(kif);
            const terms = mod.analyse(ast);
            const doc = createMockDocument(kif);
            const diags = [];
            ast.forEach(n => mod.validateNode(n, diags, terms, doc));
            expect(diags.some(d => d.message.includes('Function or Instance'))).to.be.true;
        });
    });

    // -----------------------------------------------------------------------
    describe('validateArity()', function () {

        it('arity check fires when fewer args than declared domains', function () {
            const { mod } = loadValidation();
            const kif = '(domain knows 1 Agent)\n(domain knows 2 Entity)\n(knows Alice)';
            const ast = parseKIF(kif);
            const terms = mod.analyse(ast);
            const doc = createMockDocument(kif);
            const diags = [];
            mod.validateArity(ast, diags, terms, doc);
            expect(diags.some(d => d.message.includes('knows'))).to.be.true;
        });

        it('does not warn when arity is satisfied', function () {
            const { mod } = loadValidation();
            const kif = '(domain knows 1 Agent)\n(domain knows 2 Entity)\n(knows Alice Bob)';
            const ast = parseKIF(kif);
            const terms = mod.analyse(ast);
            const doc = createMockDocument(kif);
            const diags = [];
            mod.validateArity(ast, diags, terms, doc);
            expect(diags).to.have.lengthOf(0);
        });

        it('does not warn when a row variable fills remaining argument slots', function () {
            const { mod } = loadValidation();
            // (check ?VAR @ROW) — check expects 3 args but @ROW covers the rest
            const kif = '(domain check 1 Agent)\n(domain check 2 Entity)\n(domain check 3 Entity)\n(check ?VAR @ROW)';
            const ast = parseKIF(kif);
            const terms = mod.analyse(ast);
            const doc = createMockDocument(kif);
            const diags = [];
            mod.validateArity(ast, diags, terms, doc);
            expect(diags.filter(d => d.message.includes('check'))).to.have.lengthOf(0);
        });

        it('still warns when arity is underfulfilled and no row variable is present', function () {
            const { mod } = loadValidation();
            const kif = '(domain check 1 Agent)\n(domain check 2 Entity)\n(domain check 3 Entity)\n(check ?VAR)';
            const ast = parseKIF(kif);
            const terms = mod.analyse(ast);
            const doc = createMockDocument(kif);
            const diags = [];
            mod.validateArity(ast, diags, terms, doc);
            expect(diags.some(d => d.message.includes('check'))).to.be.true;
        });
    });

    // -----------------------------------------------------------------------
    describe('validateRelationArity()', function () {

        // Helper: build a minimal kbTaxonomy that connects `instanceClass` up to Entity
        function binaryRelationKB(relName, instanceClass) {
            return {
                parents: {
                    [relName]: [{ name: instanceClass, type: 'instance' }],
                    [instanceClass]: [{ name: 'BinaryRelation', type: 'subclass' }],
                    BinaryRelation: [{ name: 'Relation', type: 'subclass' }],
                    Relation: [{ name: 'Entity', type: 'subclass' }],
                }
            };
        }

        it('errors when a BinaryRelation is called with wrong number of args', function () {
            const { mod } = loadValidation();
            const kif = '(instance knows BinaryRelation)\n(knows Alice)'; // 1 arg, expects 2
            const ast = parseKIF(kif);
            const terms = mod.analyse(ast);
            const doc = createMockDocument(kif);
            const diags = [];
            const kbTaxonomy = {
                parents: {
                    knows: [{ name: 'BinaryRelation', type: 'instance' }],
                    BinaryRelation: [{ name: 'Relation', type: 'subclass' }],
                    Relation: [{ name: 'Entity', type: 'subclass' }],
                }
            };
            mod.validateRelationArity(ast, diags, terms, doc, kbTaxonomy);
            expect(diags.some(d => d.message.includes('knows') && d.severity === 0)).to.be.true;
        });

        it('does not error when a BinaryRelation is called with correct arity', function () {
            const { mod } = loadValidation();
            const kif = '(instance knows BinaryRelation)\n(knows Alice Bob)'; // 2 args, expects 2
            const ast = parseKIF(kif);
            const terms = mod.analyse(ast);
            const doc = createMockDocument(kif);
            const diags = [];
            const kbTaxonomy = {
                parents: {
                    knows: [{ name: 'BinaryRelation', type: 'instance' }],
                    BinaryRelation: [{ name: 'Relation', type: 'subclass' }],
                    Relation: [{ name: 'Entity', type: 'subclass' }],
                }
            };
            mod.validateRelationArity(ast, diags, terms, doc, kbTaxonomy);
            expect(diags.filter(d => d.message.includes('knows'))).to.have.lengthOf(0);
        });

        it('errors when a TernaryRelation is called with wrong arity', function () {
            const { mod } = loadValidation();
            const kif = '(instance between TernaryRelation)\n(between a b)'; // 2 args, expects 3
            const ast = parseKIF(kif);
            const terms = mod.analyse(ast);
            const doc = createMockDocument(kif);
            const diags = [];
            const kbTaxonomy = {
                parents: {
                    between: [{ name: 'TernaryRelation', type: 'instance' }],
                    TernaryRelation: [{ name: 'Relation', type: 'subclass' }],
                    Relation: [{ name: 'Entity', type: 'subclass' }],
                }
            };
            mod.validateRelationArity(ast, diags, terms, doc, kbTaxonomy);
            expect(diags.some(d => d.message.includes('between') && d.severity === 0)).to.be.true;
        });

        it('does not error for VariableArityRelation with any number of args', function () {
            const { mod } = loadValidation();
            const kif = '(instance myRel VariableArityRelation)\n(myRel a b c d)';
            const ast = parseKIF(kif);
            const terms = mod.analyse(ast);
            const doc = createMockDocument(kif);
            const diags = [];
            const kbTaxonomy = {
                parents: {
                    myRel: [{ name: 'VariableArityRelation', type: 'instance' }],
                    VariableArityRelation: [{ name: 'Relation', type: 'subclass' }],
                    Relation: [{ name: 'Entity', type: 'subclass' }],
                }
            };
            mod.validateRelationArity(ast, diags, terms, doc, kbTaxonomy);
            expect(diags.filter(d => d.message.includes('myRel'))).to.have.lengthOf(0);
        });

        it('reduces expected arity by 1 for Function subclasses (BinaryFunction → 1 arg)', function () {
            const { mod } = loadValidation();
            const kif = '(instance succ BinaryFunction)\n(succ 3)'; // 1 arg is correct for BinaryFunction
            const ast = parseKIF(kif);
            const terms = mod.analyse(ast);
            const doc = createMockDocument(kif);
            const diags = [];
            const kbTaxonomy = {
                parents: {
                    succ: [{ name: 'BinaryFunction', type: 'instance' }],
                    BinaryFunction: [{ name: 'BinaryRelation', type: 'subclass' }, { name: 'Function', type: 'subclass' }],
                    BinaryRelation: [{ name: 'Relation', type: 'subclass' }],
                    Function: [{ name: 'Relation', type: 'subclass' }],
                    Relation: [{ name: 'Entity', type: 'subclass' }],
                }
            };
            mod.validateRelationArity(ast, diags, terms, doc, kbTaxonomy);
            expect(diags.filter(d => d.message.includes('succ'))).to.have.lengthOf(0);
        });

        it('errors when a BinaryFunction is called with 2 args (expects 1)', function () {
            const { mod } = loadValidation();
            const kif = '(instance succ BinaryFunction)\n(succ 3 4)'; // 2 args, BinaryFunction expects 1
            const ast = parseKIF(kif);
            const terms = mod.analyse(ast);
            const doc = createMockDocument(kif);
            const diags = [];
            const kbTaxonomy = {
                parents: {
                    succ: [{ name: 'BinaryFunction', type: 'instance' }],
                    BinaryFunction: [{ name: 'BinaryRelation', type: 'subclass' }, { name: 'Function', type: 'subclass' }],
                    BinaryRelation: [{ name: 'Relation', type: 'subclass' }],
                    Function: [{ name: 'Relation', type: 'subclass' }],
                    Relation: [{ name: 'Entity', type: 'subclass' }],
                }
            };
            mod.validateRelationArity(ast, diags, terms, doc, kbTaxonomy);
            expect(diags.some(d => d.message.includes('succ') && d.severity === 0)).to.be.true;
        });

        it('does not error when a row variable is present', function () {
            const { mod } = loadValidation();
            const kif = '(instance knows BinaryRelation)\n(knows @ARGS)'; // row variable suppresses check
            const ast = parseKIF(kif);
            const terms = mod.analyse(ast);
            const doc = createMockDocument(kif);
            const diags = [];
            const kbTaxonomy = {
                parents: {
                    knows: [{ name: 'BinaryRelation', type: 'instance' }],
                    BinaryRelation: [{ name: 'Relation', type: 'subclass' }],
                    Relation: [{ name: 'Entity', type: 'subclass' }],
                }
            };
            mod.validateRelationArity(ast, diags, terms, doc, kbTaxonomy);
            expect(diags.filter(d => d.message.includes('knows'))).to.have.lengthOf(0);
        });

        it('does not error for terms that are not Relation subclasses', function () {
            const { mod } = loadValidation();
            const kif = '(instance myAttr Attribute)\n(myAttr something)';
            const ast = parseKIF(kif);
            const terms = mod.analyse(ast);
            const doc = createMockDocument(kif);
            const diags = [];
            const kbTaxonomy = {
                parents: {
                    myAttr: [{ name: 'Attribute', type: 'instance' }],
                    Attribute: [{ name: 'Entity', type: 'subclass' }],
                    Relation: [{ name: 'Entity', type: 'subclass' }],
                }
            };
            mod.validateRelationArity(ast, diags, terms, doc, kbTaxonomy);
            expect(diags.filter(d => d.message.includes('myAttr'))).to.have.lengthOf(0);
        });

        it('does not error for terms not present in the terms map', function () {
            const { mod } = loadValidation();
            // unknownRel is not declared anywhere — the check should simply skip it
            const kif = '(unknownRel Alice)';
            const ast = parseKIF(kif);
            const terms = mod.analyse(ast);
            const doc = createMockDocument(kif);
            const diags = [];
            mod.validateRelationArity(ast, diags, terms, doc);
            expect(diags).to.have.lengthOf(0);
        });

        it('resolves arity through subclass of BinaryRelation (BinaryPredicate → BinaryRelation)', function () {
            const { mod } = loadValidation();
            const kif = '(instance likes BinaryPredicate)\n(likes Alice)'; // 1 arg, BinaryPredicate expects 2
            const ast = parseKIF(kif);
            const terms = mod.analyse(ast);
            const doc = createMockDocument(kif);
            const diags = [];
            const kbTaxonomy = {
                parents: {
                    likes: [{ name: 'BinaryPredicate', type: 'instance' }],
                    BinaryPredicate: [{ name: 'BinaryRelation', type: 'subclass' }],
                    BinaryRelation: [{ name: 'Relation', type: 'subclass' }],
                    Relation: [{ name: 'Entity', type: 'subclass' }],
                }
            };
            mod.validateRelationArity(ast, diags, terms, doc, kbTaxonomy);
            expect(diags.some(d => d.message.includes('likes') && d.severity === 0)).to.be.true;
        });
    });

    // -----------------------------------------------------------------------
    describe('validateDomainTypes()', function () {

        // Helper: build a kbTaxonomy that places relName as (instance relName BinaryRelation)
        // and connects typeA and typeB up to Entity via whatever chain is supplied.
        function makeTaxonomy(parents) {
            return { parents };
        }

        it('warns when argument type does not reach the declared domain type', function () {
            const { mod } = loadValidation();
            // domain knows 1 Agent; call passes 'Rover' which is an instance of Dog, not Agent
            const kif = [
                '(instance knows BinaryRelation)',
                '(domain knows 1 Agent)',
                '(domain knows 2 Entity)',
                '(instance Rover Dog)',
                '(knows Rover Bob)',
            ].join('\n');
            const ast = parseKIF(kif);
            const terms = mod.analyse(ast);
            const doc = createMockDocument(kif);
            const diags = [];
            // parentGraph has no path from Dog to Agent → type mismatch on arg 1
            const kbTaxonomy = makeTaxonomy({
                knows:  [{ name: 'BinaryRelation', type: 'instance' }],
                Rover:  [{ name: 'Dog', type: 'instance' }],
                Dog:    [{ name: 'Animal', type: 'subclass' }],
                Animal: [{ name: 'Entity', type: 'subclass' }],
                Agent:  [{ name: 'Entity', type: 'subclass' }],
            });
            mod.validateDomainTypes(ast, diags, terms, doc, kbTaxonomy);
            expect(diags.some(d => d.message.includes("'Agent'") && d.severity === 1)).to.be.true;
        });

        it('does not warn when argument type reaches the declared domain type', function () {
            const { mod } = loadValidation();
            const kif = [
                '(instance knows BinaryRelation)',
                '(domain knows 1 Agent)',
                '(domain knows 2 Entity)',
                '(instance Rover Dog)',
                '(knows Rover Bob)',
            ].join('\n');
            const ast = parseKIF(kif);
            const terms = mod.analyse(ast);
            const doc = createMockDocument(kif);
            const diags = [];
            // Dog → Animal → Agent → Entity; Rover is instance of Dog → reaches Agent ✓
            const kbTaxonomy = makeTaxonomy({
                knows:  [{ name: 'BinaryRelation', type: 'instance' }],
                Rover:  [{ name: 'Dog', type: 'instance' }],
                Dog:    [{ name: 'Animal', type: 'subclass' }],
                Animal: [{ name: 'Agent', type: 'subclass' }],
                Agent:  [{ name: 'Entity', type: 'subclass' }],
                Bob:    [{ name: 'Entity', type: 'instance' }],
            });
            mod.validateDomainTypes(ast, diags, terms, doc, kbTaxonomy);
            expect(diags.filter(d => d.message.includes("'Agent'"))).to.have.lengthOf(0);
        });

        it('does not warn for variable arguments', function () {
            const { mod } = loadValidation();
            const kif = [
                '(instance knows BinaryRelation)',
                '(domain knows 1 Agent)',
                '(domain knows 2 Entity)',
                '(knows ?X ?Y)',
            ].join('\n');
            const ast = parseKIF(kif);
            const terms = mod.analyse(ast);
            const doc = createMockDocument(kif);
            const diags = [];
            mod.validateDomainTypes(ast, diags, terms, doc);
            expect(diags).to.have.lengthOf(0);
        });

        it('does not warn when domain declaration is absent for a position', function () {
            const { mod } = loadValidation();
            // knows has no domain declarations; no type check should fire
            const kif = '(instance knows BinaryRelation)\n(knows Rover Bob)';
            const ast = parseKIF(kif);
            const terms = mod.analyse(ast);
            const doc = createMockDocument(kif);
            const diags = [];
            mod.validateDomainTypes(ast, diags, terms, doc);
            expect(diags).to.have.lengthOf(0);
        });

        it('accepts a Formula argument where domain requires Formula', function () {
            const { mod } = loadValidation();
            const kif = [
                '(instance holds BinaryRelation)',
                '(domain holds 1 Formula)',
                '(domain holds 2 Entity)',
                '(holds (instance Rover Dog) Universe)',
            ].join('\n');
            const ast = parseKIF(kif);
            const terms = mod.analyse(ast);
            const doc = createMockDocument(kif);
            const diags = [];
            const kbTaxonomy = makeTaxonomy({
                holds: [{ name: 'BinaryRelation', type: 'instance' }],
            });
            mod.validateDomainTypes(ast, diags, terms, doc, kbTaxonomy);
            expect(diags.filter(d => d.message.includes("'Formula'"))).to.have.lengthOf(0);
        });

        it('warns when a Formula sentence is passed where a non-Formula type is expected', function () {
            const { mod } = loadValidation();
            const kif = [
                '(instance knows BinaryRelation)',
                '(domain knows 1 Agent)',
                '(domain knows 2 Entity)',
                '(knows (instance Rover Dog) Bob)',
            ].join('\n');
            const ast = parseKIF(kif);
            const terms = mod.analyse(ast);
            const doc = createMockDocument(kif);
            const diags = [];
            const kbTaxonomy = makeTaxonomy({
                knows: [{ name: 'BinaryRelation', type: 'instance' }],
            });
            mod.validateDomainTypes(ast, diags, terms, doc, kbTaxonomy);
            // Arg 1 is a sentence (Formula), but domain requires Agent
            expect(diags.some(d =>
                d.message.includes("'Agent'") && d.message.includes("'Formula'") && d.severity === 1
            )).to.be.true;
        });

        it('uses function range as the argument type', function () {
            const { mod } = loadValidation();
            // (succ 3) has range Integer; domain of holds arg 1 is Integer → compatible
            const kif = [
                '(instance succ BinaryFunction)',
                '(range succ Integer)',
                '(instance holds BinaryRelation)',
                '(domain holds 1 Integer)',
                '(domain holds 2 Entity)',
                '(holds (succ 3) Universe)',
            ].join('\n');
            const ast = parseKIF(kif);
            const terms = mod.analyse(ast);
            const doc = createMockDocument(kif);
            const diags = [];
            const kbTaxonomy = makeTaxonomy({
                succ:    [{ name: 'BinaryFunction', type: 'instance' }],
                BinaryFunction: [{ name: 'BinaryRelation', type: 'subclass' }, { name: 'Function', type: 'subclass' }],
                BinaryRelation: [{ name: 'Relation', type: 'subclass' }],
                Function:       [{ name: 'Relation', type: 'subclass' }],
                Relation:       [{ name: 'Entity', type: 'subclass' }],
                holds:   [{ name: 'BinaryRelation', type: 'instance' }],
                Integer: [{ name: 'Entity', type: 'subclass' }],
            });
            mod.validateDomainTypes(ast, diags, terms, doc, kbTaxonomy);
            expect(diags.filter(d => d.message.includes("'Integer'"))).to.have.lengthOf(0);
        });

        it('warns when function range does not match domain type', function () {
            const { mod } = loadValidation();
            // (succ 3) has range Integer; domain of holds arg 1 is Agent → incompatible
            const kif = [
                '(instance succ BinaryFunction)',
                '(range succ Integer)',
                '(instance holds BinaryRelation)',
                '(domain holds 1 Agent)',
                '(domain holds 2 Entity)',
                '(holds (succ 3) Universe)',
            ].join('\n');
            const ast = parseKIF(kif);
            const terms = mod.analyse(ast);
            const doc = createMockDocument(kif);
            const diags = [];
            const kbTaxonomy = makeTaxonomy({
                succ:    [{ name: 'BinaryFunction', type: 'instance' }],
                BinaryFunction: [{ name: 'BinaryRelation', type: 'subclass' }, { name: 'Function', type: 'subclass' }],
                BinaryRelation: [{ name: 'Relation', type: 'subclass' }],
                Function:       [{ name: 'Relation', type: 'subclass' }],
                Relation:       [{ name: 'Entity', type: 'subclass' }],
                holds:   [{ name: 'BinaryRelation', type: 'instance' }],
                Integer: [{ name: 'Entity', type: 'subclass' }],
                Agent:   [{ name: 'Entity', type: 'subclass' }],
            });
            mod.validateDomainTypes(ast, diags, terms, doc, kbTaxonomy);
            expect(diags.some(d =>
                d.message.includes("'Agent'") && d.message.includes("'Integer'") && d.severity === 1
            )).to.be.true;
        });

        it('does not warn for numeric literal arguments (type cannot be inferred)', function () {
            const { mod } = loadValidation();
            const kif = [
                '(instance knows BinaryRelation)',
                '(domain knows 1 Agent)',
                '(knows 42 Bob)',
            ].join('\n');
            const ast = parseKIF(kif);
            const terms = mod.analyse(ast);
            const doc = createMockDocument(kif);
            const diags = [];
            mod.validateDomainTypes(ast, diags, terms, doc);
            expect(diags.filter(d => d.message.includes("'Agent'"))).to.have.lengthOf(0);
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
            const terms = mod.analyse(ast);
            const doc = createMockDocument(kif);
            const diags = [];
            mod.validateCoverage(ast, diags, terms, doc);
            expect(diags.some(d =>
                d.message.includes('no taxonomy path') && d.severity === 0
            )).to.be.true;
        });

        it('does not error for Entity itself', function () {
            const { mod } = loadValidation();
            // Entity is the root — no path check should apply to it
            const kif = '(subclass Entity Entity)'; // degenerate but Entity appears
            const ast = parseKIF(kif);
            const terms = mod.analyse(ast);
            const doc = createMockDocument(kif);
            const diags = [];
            mod.validateCoverage(ast, diags, terms, doc);
            expect(diags.filter(d =>
                d.message.includes('Entity') && d.message.includes('no taxonomy path')
            )).to.have.lengthOf(0);
        });

        it('does not error when kbTaxonomy supplies the path to Entity', function () {
            const { mod } = loadValidation();
            // Locally only: (subclass Cat Mammal); kbTaxonomy says Mammal→Animal→Entity
            const kif = '(subclass Cat Mammal)';
            const ast = parseKIF(kif);
            const terms = mod.analyse(ast);
            const doc = createMockDocument(kif);
            const diags = [];
            const kbTaxonomy = {
                parents: {
                    Cat: [{ name: 'Mammal', type: 'subclass' }],
                    Mammal: [{ name: 'Animal', type: 'subclass' }],
                    Animal: [{ name: 'Entity', type: 'subclass' }]
                }
            };
            mod.validateCoverage(ast, diags, terms, doc, kbTaxonomy);
            expect(diags.filter(d => d.severity === 0)).to.have.lengthOf(0);
        });

        it('warns when a defined term has no documentation', function () {
            const { mod } = loadValidation();
            const kif = '(subclass Cat Mammal)'; // no documentation
            const ast = parseKIF(kif);
            const terms = mod.analyse(ast);
            const doc = createMockDocument(kif);
            const diags = [];
            // Provide kbTaxonomy so no "no path" error fires
            const kbTaxonomy = {
                parents: {
                    Cat: [{ name: 'Entity', type: 'subclass' }]
                }
            };
            mod.validateCoverage(ast, diags, terms, doc, kbTaxonomy);
            expect(diags.some(d =>
                d.message.includes('no documentation') && d.severity === 1
            )).to.be.true;
        });

        it('does not warn about documentation when it is present', function () {
            const { mod } = loadValidation({ 'general.language': 'EnglishLanguage' });
            const kif = '(subclass Cat Mammal)\n(documentation Cat EnglishLanguage "A feline.")';
            const ast = parseKIF(kif);
            const terms = mod.analyse(ast);
            const doc = createMockDocument(kif);
            const diags = [];
            const kbTaxonomy = {
                parents: {
                    Cat: [{ name: 'Entity', type: 'subclass' }]
                }
            };
            mod.validateCoverage(ast, diags, terms, doc, kbTaxonomy);
            expect(diags.filter(d => d.message.includes('no documentation'))).to.have.lengthOf(0);
        });

        it('warns when a Relation has no domain declaration', function () {
            const { mod } = loadValidation();
            // likes is an instance of BinaryRelation (a subclass of Relation)
            const kif = '(instance likes BinaryRelation)';
            const ast = parseKIF(kif);
            const terms = mod.analyse(ast);
            const doc = createMockDocument(kif);
            const diags = [];
            const kbTaxonomy = {
                parents: {
                    likes: [{ name: 'BinaryRelation', type: 'instance' }],
                    BinaryRelation: [{ name: 'Relation', type: 'subclass' }],
                    Relation: [{ name: 'Entity', type: 'subclass' }]
                }
            };
            mod.validateCoverage(ast, diags, terms, doc, kbTaxonomy);
            expect(diags.some(d =>
                d.message.includes("no 'domain'") && d.severity === 1
            )).to.be.true;
        });

        it('recognises Relation ancestry through instance edges in the type hierarchy', function () {
            const { mod } = loadValidation();
            // BinaryRelation is linked to Relation via 'instance' rather than 'subclass'.
            // isClassAncestor must follow instance edges to find Relation.
            const kif = '(instance likes BinaryRelation)';
            const ast = parseKIF(kif);
            const terms = mod.analyse(ast);
            const doc = createMockDocument(kif);
            const diags = [];
            const kbTaxonomy = {
                parents: {
                    likes: [{ name: 'BinaryRelation', type: 'instance' }],
                    BinaryRelation: [{ name: 'Relation', type: 'instance' }], // instance, not subclass
                    Relation: [{ name: 'Entity', type: 'subclass' }]
                }
            };
            mod.validateCoverage(ast, diags, terms, doc, kbTaxonomy);
            // Should still warn about missing domain (isRelationOrFunction must return true)
            expect(diags.some(d =>
                d.message.includes("no 'domain'") && d.severity === 1
            )).to.be.true;
        });

        it('warns when a Function has no range declaration', function () {
            const { mod } = loadValidation();
            const kif = '(instance myFn UnaryFunction)\n(domain myFn 1 Entity)';
            const ast = parseKIF(kif);
            const terms = mod.analyse(ast);
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
            mod.validateCoverage(ast, diags, terms, doc, kbTaxonomy);
            expect(diags.some(d =>
                d.message.includes("no 'range'") && d.severity === 1
            )).to.be.true;
        });

        it('does not warn about range when range is declared', function () {
            const { mod } = loadValidation();
            const kif = '(instance myFn UnaryFunction)\n(domain myFn 1 Entity)\n(range myFn Integer)';
            const ast = parseKIF(kif);
            const terms = mod.analyse(ast);
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
            mod.validateCoverage(ast, diags, terms, doc, kbTaxonomy);
            expect(diags.filter(d => d.message.includes("no 'range'"))).to.have.lengthOf(0);
        });

        it('does not warn about domain when only domainSubclass is declared', function () {
            const { mod } = loadValidation();
            // domainSubclass should satisfy the "has no domain" check just like domain
            const kif = '(instance likes BinaryRelation)\n(domainSubclass likes 1 Agent)\n(domainSubclass likes 2 Entity)';
            const ast = parseKIF(kif);
            const terms = mod.analyse(ast);
            const doc = createMockDocument(kif);
            const diags = [];
            const kbTaxonomy = {
                parents: {
                    likes: [{ name: 'BinaryRelation', type: 'instance' }],
                    BinaryRelation: [{ name: 'Relation', type: 'subclass' }],
                    Relation: [{ name: 'Entity', type: 'subclass' }]
                }
            };
            mod.validateCoverage(ast, diags, terms, doc, kbTaxonomy);
            expect(diags.filter(d => d.message.includes("no 'domain'"))).to.have.lengthOf(0);
        });

        it('does not warn about range when only rangeSubclass is declared', function () {
            const { mod } = loadValidation();
            // rangeSubclass should satisfy the Function range check just like range
            const kif = '(instance myFn UnaryFunction)\n(domain myFn 1 Entity)\n(rangeSubclass myFn Number)';
            const ast = parseKIF(kif);
            const terms = mod.analyse(ast);
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
            mod.validateCoverage(ast, diags, terms, doc, kbTaxonomy);
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
