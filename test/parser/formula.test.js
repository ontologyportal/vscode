'use strict';

/**
 * Tests for Formula (formula.js) and Term.validate() (term.js).
 */

const { expect } = require('chai');
const { Formula } = require('../../src/parser/formula');
const { Term, SemanticError } = require('../../src/parser/term');
const { semantics } = require('../../src/parser');
const { syntax } = require('../../src/parser/symbol');
const { Sentence, OperatorSentence } = require('../../src/parser/sentence');
const { tokenize } = require('../../src/parser/tokenizer');
const { TokenList } = require('../../src/parser/parser');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseKIF(text, symbolTable = undefined) {
    const { tokens } = tokenize(text, 'test.kif');
    const { nodes } = new TokenList(tokens).parse();
    return syntax(nodes, symbolTable);
}

/**
 * Build a SymbolTable from one or more KIF strings, run semantics to
 * populate forward references, then create Formula wrappers for every
 * sentence (root and nested) so that s.forward is always a Formula.
 */
function kb(...kifStrings) {
    let result;
    for (const kif of kifStrings) {
        result = parseKIF(kif, result?.symbolTable);
    }
    semantics(result.symbolTable);
    buildAllFormulas(result.symbolTable);
    return result.symbolTable;
}

function buildAllFormulas(symbolTable) {
    for (const s of symbolTable.sentences) {
        buildFormulaTree(s);
    }
}

function buildFormulaTree(sentence) {
    new Formula(sentence);
    for (const t of sentence.terms) {
        if (t instanceof Sentence) {
            buildFormulaTree(t);
        }
    }
}

/** Return the Term for a named symbol (semantics must have run). */
function term(st, name) {
    const sym = st.symbols[name];
    if (!sym) throw new Error(`Symbol '${name}' not found`);
    return sym.forward || new Term(sym);
}

/** Return the Formula for the root sentence whose predicate/operator matches name. */
function formula(st, name) {
    for (const s of st.sentences) {
        let match = false;
        if (s instanceof OperatorSentence) {
            match = s.op.name === name;
        } else if (s.terms[0]?.name === name) {
            match = true;
        }
        if (match) return s.forward instanceof Formula ? s.forward : new Formula(s);
    }
    throw new Error(`No root sentence with predicate/operator '${name}'`);
}

// ---------------------------------------------------------------------------
// Minimal SUMO-like backbone used across multiple test groups.
//
// Declares the arity/relation/function hierarchy down to concrete instances.
// ---------------------------------------------------------------------------
const BACKBONE_KIF = [
    '(subclass Relation Entity)',
    '(subclass BinaryRelation Relation)',
    '(subclass Predicate Relation)',
    '(subclass BinaryPredicate Predicate)',
    '(subclass BinaryPredicate BinaryRelation)',
    '(subclass Function Relation)',
    '(subclass BinaryFunction Function)',
    '(subclass BinaryFunction BinaryRelation)',
    '(subclass Human Entity)',
    '(subclass Animal Entity)',
    '(instance loves BinaryPredicate)',
    '(domain loves 1 Human)',
    '(domain loves 2 Human)',
    '(instance Father BinaryFunction)',
    '(domain Father 1 Human)',
    '(range Father Human)',
];

// ---------------------------------------------------------------------------
describe('Formula', function () {

    // -----------------------------------------------------------------------
    describe('logical', function () {

        it('is true for any OperatorSentence (and, or, not, =>, <=>)', function () {
            const st = kb('(and (not (p A)) (or (q B) (r C)))');
            // The root (and ...) sentence is an OperatorSentence
            expect(formula(st, 'and').logical).to.be.true;
        });

        it('is true for a sentence whose head is a declared predicate', function () {
            const st = kb(...BACKBONE_KIF, '(loves Alice Bob)');
            // loves is a BinaryPredicate → isPredicate = true
            expect(formula(st, 'loves').logical).to.be.true;
        });

        it('is false for a sentence whose head is a declared function', function () {
            const st = kb(...BACKBONE_KIF, '(Father Alice)');
            // Father is a BinaryFunction → isFunction = true, isPredicate = false
            expect(formula(st, 'Father').logical).to.be.false;
        });

        it('is false for a sentence whose head has no declared taxonomy', function () {
            const st = kb('(unknownPred A B)');
            // unknownPred has no instance edge → isPredicate = false
            expect(formula(st, 'unknownPred').logical).to.be.false;
        });
    });

    // -----------------------------------------------------------------------
    describe('range', function () {

        it('returns null for an OperatorSentence (head is not a Symbol)', function () {
            const st = kb('(and (not (p A)) (q B))');
            expect(formula(st, 'and').range).to.be.null;
        });

        it('returns null for a predicate sentence (not a function)', function () {
            const st = kb(...BACKBONE_KIF, '(loves Alice Bob)');
            // loves is a predicate, not a function → isFunction = false
            expect(formula(st, 'loves').range).to.be.null;
        });

        it('returns null for a sentence with no declared taxonomy on the head', function () {
            const st = kb('(unknownPred A B)');
            expect(formula(st, 'unknownPred').range).to.be.null;
        });

        it('returns a Term for a function-application sentence', function () {
            const st = kb(...BACKBONE_KIF, '(Father Alice)');
            // Father is BinaryFunction with (range Father Human) → validRange() returns InstanceOf(Human)
            const r = formula(st, 'Father').range;
            expect(r).to.not.be.null;
            expect(r).to.be.instanceof(Term);
        });
    });

    // -----------------------------------------------------------------------
    describe('validate() — Rule 1: operator args must be logical', function () {

        it('does not throw when all args to "and" are OperatorSentences', function () {
            const st = kb('(and (not (p A)) (or (q B) (r C)))');
            expect(() => formula(st, 'and').validate()).to.not.throw();
        });

        it('does not throw when all args to "not" are OperatorSentences', function () {
            const st = kb('(not (and (p A) (q B)))');
            expect(() => formula(st, 'not').validate()).to.not.throw();
        });

        it('does not throw for (equal A B) — equality is exempt from the logical check', function () {
            // KIF equality uses the keyword 'equal', not '='
            // EqualityOperator.name === 'equal'
            const st = kb('(equal A B)');
            expect(() => formula(st, 'equal').validate()).to.not.throw();
        });

        it('does not throw for (forall (?X) body) where body is an OperatorSentence', function () {
            const st = kb('(forall (?X) (not (p ?X)))');
            expect(() => formula(st, 'forall').validate()).to.not.throw();
        });

        it('throws SemanticError when a non-logical sentence is passed as an arg to "and"', function () {
            // Father is a BinaryFunction → its formula is non-logical
            const st = kb(...BACKBONE_KIF, '(and (loves Alice Bob) (Father Alice))');
            // loves sentence inner args all logical; Father sentence is non-logical
            expect(() => formula(st, 'and').validate()).to.throw(SemanticError);
        });

        it('throws SemanticError when a Symbol (atom) is used directly as an arg to "or"', function () {
            // (or SomeAtom (p A)) — SomeAtom is a Symbol, its forward is a Term, Term has no .logical → falsy
            const st = kb('(or SomeAtom (p A))');
            expect(() => formula(st, 'or').validate()).to.throw(SemanticError);
        });
    });

    // -----------------------------------------------------------------------
    describe('validate() — Rule 2: non-operator sentence must start with a relation', function () {

        it('throws SemanticError when the head symbol has no declared taxonomy', function () {
            const st = kb('(undeclaredPred A B)');
            // undeclaredPred has no instance edge → isRelation = false
            expect(() => formula(st, 'undeclaredPred').validate()).to.throw(SemanticError);
        });

        it('throws SemanticError when the head is a class (subclass only, not a relation)', function () {
            const st = kb('(subclass Human Animal)', '(Human Socrates)');
            // Human is a class (only subclass edges, not an instance of Relation)
            expect(() => formula(st, 'Human').validate()).to.throw(SemanticError);
        });

        it('does not throw for a sentence whose head is a declared predicate', function () {
            // loves is a BinaryPredicate → isRelation = true
            // We only test Rule 2 here; Term.validate() for a predicate with full setup passes too
            const st = kb(...BACKBONE_KIF);
            // Build an (instance loves BinaryPredicate) backbone with no actual loves call —
            // just confirm isRelation is true so Rule 2 wouldn't fire
            expect(term(st, 'loves').isRelation).to.be.true;
        });
    });
});

// ---------------------------------------------------------------------------
describe('Term.validate()', function () {

    // -----------------------------------------------------------------------
    describe('Rule 1 — term must have a path to Entity', function () {

        it('returns true for a class term that directly subclasses Entity', function () {
            const st = kb('(subclass Human Entity)');
            semantics(st); // ensure forward refs set
            expect(term(st, 'Human').validate()).to.be.true;
        });

        it('returns true for a class term that reaches Entity transitively', function () {
            const st = kb(
                '(subclass Human Animal)',
                '(subclass Animal Entity)'
            );
            expect(term(st, 'Human').validate()).to.be.true;
        });

        it('throws SemanticError for a term with no path to Entity', function () {
            const st = kb('(subclass Human Animal)');
            // Animal has no outgoing edges → Human cannot reach Entity
            expect(() => term(st, 'Human').validate()).to.throw(SemanticError);
        });

        it('throws SemanticError even for a deep chain that never reaches Entity', function () {
            const st = kb(
                '(subclass Human Animal)',
                '(subclass Animal LivingThing)',
                '(subclass LivingThing Physical)'
            );
            expect(() => term(st, 'Human').validate()).to.throw(SemanticError);
        });
    });

    // -----------------------------------------------------------------------
    describe('Rule 4 — Function must have a range declaration', function () {

        it('throws SemanticError for a function with no range or rangeSubclass', function () {
            const st = kb(
                '(subclass Relation Entity)',
                '(subclass BinaryRelation Relation)',
                '(subclass Function Relation)',
                '(subclass BinaryFunction Function)',
                '(subclass BinaryFunction BinaryRelation)',
                '(subclass Human Entity)',
                '(instance Father BinaryFunction)',
                '(domain Father 1 Human)'
                // No (range Father ...) or (rangeSubclass Father ...)
            );
            expect(() => term(st, 'Father').validate()).to.throw(SemanticError);
        });

        it('returns true for a function with a range declaration', function () {
            const st = kb(...BACKBONE_KIF);
            expect(term(st, 'Father').validate()).to.be.true;
        });

        it('returns true for a function with a rangeSubclass declaration', function () {
            const st = kb(
                '(subclass Relation Entity)',
                '(subclass BinaryRelation Relation)',
                '(subclass Function Relation)',
                '(subclass BinaryFunction Function)',
                '(subclass BinaryFunction BinaryRelation)',
                '(subclass Human Entity)',
                '(instance Father BinaryFunction)',
                '(domain Father 1 Human)',
                '(rangeSubclass Father Human)' // rangeSubclass instead of range
            );
            expect(term(st, 'Father').validate()).to.be.true;
        });

        it('throws SemanticError when both range and rangeSubclass are declared', function () {
            const st = kb(
                '(subclass Relation Entity)',
                '(subclass BinaryRelation Relation)',
                '(subclass Function Relation)',
                '(subclass BinaryFunction Function)',
                '(subclass BinaryFunction BinaryRelation)',
                '(subclass Human Entity)',
                '(instance Father BinaryFunction)',
                '(domain Father 1 Human)',
                '(range Father Human)',
                '(rangeSubclass Father Human)'
            );
            expect(() => term(st, 'Father').validate()).to.throw(SemanticError);
        });
    });

    // -----------------------------------------------------------------------
    describe('Rule 5 — naming conventions', function () {

        it('throws SemanticError for a function whose name starts with lowercase', function () {
            const st = kb(
                '(subclass Relation Entity)',
                '(subclass BinaryRelation Relation)',
                '(subclass Function Relation)',
                '(subclass BinaryFunction Function)',
                '(subclass BinaryFunction BinaryRelation)',
                '(subclass Human Entity)',
                '(instance fatherFn BinaryFunction)',  // lowercase start → invalid
                '(domain fatherFn 1 Human)',
                '(range fatherFn Human)'
            );
            expect(() => term(st, 'fatherFn').validate()).to.throw(SemanticError);
        });

        it('returns true for a predicate whose name starts with lowercase', function () {
            const st = kb(...BACKBONE_KIF);
            // 'loves' starts lowercase — valid for a predicate
            expect(term(st, 'loves').validate()).to.be.true;
        });

        it('throws SemanticError for a predicate whose name starts with uppercase', function () {
            const st = kb(
                '(subclass Relation Entity)',
                '(subclass BinaryRelation Relation)',
                '(subclass Predicate Relation)',
                '(subclass BinaryPredicate Predicate)',
                '(subclass BinaryPredicate BinaryRelation)',
                '(subclass Human Entity)',
                '(instance Loves BinaryPredicate)',  // Uppercase start → invalid
                '(domain Loves 1 Human)',
                '(domain Loves 2 Human)'
            );
            expect(() => term(st, 'Loves').validate()).to.throw(SemanticError);
        });
    });

    // -----------------------------------------------------------------------
    describe('domain getter edge cases', function () {

        it('returns empty array for a relation with no domain declarations', function () {
            const st = kb(
                '(subclass Relation Entity)',
                '(instance myRel Relation)'
            );
            // isRelation is true but no domain sentences → should return []
            expect(term(st, 'myRel').domain).to.deep.equal([]);
        });

        it('populates domain at 0-based indices', function () {
            const st = kb(...BACKBONE_KIF);
            const d = term(st, 'loves').domain;
            expect(d[0]).to.be.instanceof(Term);
            expect(d[0].name).to.equal('Human');
            expect(d[1]).to.be.instanceof(Term);
            expect(d[1].name).to.equal('Human');
        });
    });

    // -----------------------------------------------------------------------
    describe('arity getter — function adjustment', function () {

        it('reduces arity by 1 for a BinaryFunction (returns 1)', function () {
            const st = kb(...BACKBONE_KIF);
            // Father is BinaryFunction → BinaryRelation arity=2, adjusted to 1 for functions
            expect(term(st, 'Father').arity).to.equal(1);
        });

        it('does not reduce arity for a predicate', function () {
            const st = kb(...BACKBONE_KIF);
            // loves is BinaryPredicate → BinaryRelation arity=2, no adjustment
            expect(term(st, 'loves').arity).to.equal(2);
        });
    });
});
