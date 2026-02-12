/**
 * Tests for Formula class
 */

const { expect } = require('chai');
const { Formula }  = require('../../src/sigma/engine/native/index.js');

describe('Formula', () => {
    describe('atom()', () => {
        it('recognizes simple atoms', () => {
            expect(Formula.atom('foo')).to.equal(true);
            expect(Formula.atom('instance')).to.equal(true);
            expect(Formula.atom('?X')).to.equal(true);
        });

        it('recognizes quoted strings as atoms', () => {
            expect(Formula.atom('"hello world"')).to.equal(true);
            expect(Formula.atom("'test'")).to.equal(true);
        });

        it('rejects lists as atoms', () => {
            expect(Formula.atom('(foo bar)')).to.equal(false);
            expect(Formula.atom('(instance ?X Class)')).to.equal(false);
        });

        it('handles empty and null', () => {
            expect(Formula.atom('')).to.equal(false);
            expect(Formula.atom(null)).to.equal(false);
            expect(Formula.atom(undefined)).to.equal(false);
        });
    });

    describe('listP()', () => {
        it('recognizes lists', () => {
            expect(Formula.listP('(foo bar)')).to.equal(true);
            expect(Formula.listP('(instance ?X Class)')).to.equal(true);
            expect(Formula.listP('()')).to.equal(true);
        });

        it('rejects non-lists', () => {
            expect(Formula.listP('foo')).to.equal(false);
            expect(Formula.listP('?X')).to.equal(false);
        });
    });

    describe('empty()', () => {
        it('recognizes empty lists', () => {
            expect(Formula.empty('()')).to.equal(true);
            expect(Formula.empty('(  )')).to.equal(true);
        });

        it('rejects non-empty lists', () => {
            expect(Formula.empty('(foo)')).to.equal(false);
            expect(Formula.empty('(foo bar)')).to.equal(false);
        });
    });

    describe('car()', () => {
        it('returns first element of list', () => {
            const f = new Formula('(foo bar baz)');
            expect(f.car()).to.equal('foo');
        });

        it('returns first element when it is a list', () => {
            const f = new Formula('((nested list) bar)');
            expect(f.car()).to.equal('(nested list)');
        });

        it('handles complex formulas', () => {
            const f = new Formula('(instance ?X Class)');
            expect(f.car()).to.equal('instance');
        });

        it('returns empty string for empty list', () => {
            const f = new Formula('()');
            expect(f.car()).to.equal('');
        });

        it('returns null for atoms', () => {
            const f = new Formula('foo');
            expect(f.car()).to.equal(null);
        });
    });

    describe('cdr()', () => {
        it('returns rest of list', () => {
            const f = new Formula('(foo bar baz)');
            expect(f.cdr()).to.equal('(bar baz)');
        });

        it('returns single element list when two elements', () => {
            const f = new Formula('(foo bar)');
            expect(f.cdr()).to.equal('(bar)');
        });

        it('returns empty list when one element', () => {
            const f = new Formula('(foo)');
            expect(f.cdr()).to.equal('()');
        });

        it('handles nested lists', () => {
            const f = new Formula('(foo (nested list) bar)');
            expect(f.cdr()).to.equal('((nested list) bar)');
        });
    });

    describe('getArgument()', () => {
        it('gets argument at index', () => {
            const f = new Formula('(instance ?X Class)');
            expect(f.getArgument(0)).to.equal('instance');
            expect(f.getArgument(1)).to.equal('?X');
            expect(f.getArgument(2)).to.equal('Class');
        });

        it('returns null for out of bounds', () => {
            const f = new Formula('(instance ?X)');
            expect(f.getArgument(5)).to.equal(null);
        });
    });

    describe('complexArgumentsToArrayListString()', () => {
        it('returns arguments starting from index', () => {
            const f = new Formula('(instance ?X Class)');
            const args = f.complexArgumentsToArrayListString(1);
            expect(args).to.deep.equal(['?X', 'Class']);
        });

        it('handles nested formulas', () => {
            const f = new Formula('(=> (instance ?X P) (instance ?X Q))');
            const args = f.complexArgumentsToArrayListString(1);
            expect(args).to.deep.equal(['(instance ?X P)', '(instance ?X Q)']);
        });
    });

    describe('listLength()', () => {
        it('counts elements in list', () => {
            const f = new Formula('(instance ?X Class)');
            expect(f.listLength()).to.equal(3);
        });

        it('handles empty list', () => {
            const f = new Formula('()');
            expect(f.listLength()).to.equal(0);
        });

        it('handles single element', () => {
            const f = new Formula('(foo)');
            expect(f.listLength()).to.equal(1);
        });
    });

    describe('isVariable()', () => {
        it('recognizes question mark variables', () => {
            expect(Formula.isVariable('?X')).to.equal(true);
            expect(Formula.isVariable('?VAR')).to.equal(true);
        });

        it('recognizes row variables', () => {
            expect(Formula.isVariable('@ROW')).to.equal(true);
        });

        it('rejects non-variables', () => {
            expect(Formula.isVariable('foo')).to.equal(false);
            expect(Formula.isVariable('X')).to.equal(false);
        });
    });

    describe('isLogicalOperator()', () => {
        it('recognizes logical operators', () => {
            expect(Formula.isLogicalOperator('and')).to.equal(true);
            expect(Formula.isLogicalOperator('or')).to.equal(true);
            expect(Formula.isLogicalOperator('not')).to.equal(true);
            expect(Formula.isLogicalOperator('=>')).to.equal(true);
            expect(Formula.isLogicalOperator('<=>')).to.equal(true);
            expect(Formula.isLogicalOperator('forall')).to.equal(true);
            expect(Formula.isLogicalOperator('exists')).to.equal(true);
        });

        it('rejects non-operators', () => {
            expect(Formula.isLogicalOperator('instance')).to.equal(false);
            expect(Formula.isLogicalOperator('foo')).to.equal(false);
        });
    });

    describe('collectAllVariables()', () => {
        it('collects all variables', () => {
            const f = new Formula('(instance ?X Class)');
            const vars = f.collectAllVariables();
            expect(vars.has('?X')).to.equal(true);
            expect(vars.size).to.equal(1);
        });

        it('collects multiple variables', () => {
            const f = new Formula('(=> (instance ?X P) (instance ?Y Q))');
            const vars = f.collectAllVariables();
            expect(vars.has('?X')).to.equal(true);
            expect(vars.has('?Y')).to.equal(true);
            expect(vars.size).to.equal(2);
        });
    });

    describe('collectQuantifiedVariables()', () => {
        it('collects variables in quantifier scope', () => {
            const f = new Formula('(forall (?X) (instance ?X Class))');
            const vars = f.collectQuantifiedVariables();
            expect(vars.has('?X')).to.equal(true);
        });

        it('handles nested quantifiers', () => {
            const f = new Formula('(forall (?X) (exists (?Y) (related ?X ?Y)))');
            const vars = f.collectQuantifiedVariables();
            expect(vars.has('?X')).to.equal(true);
            expect(vars.has('?Y')).to.equal(true);
        });
    });

    describe('collectUnquantifiedVariables()', () => {
        it('collects free variables', () => {
            const f = new Formula('(=> (instance ?X P) (instance ?X Q))');
            const vars = f.collectUnquantifiedVariables();
            expect(vars.has('?X')).to.equal(true);
        });

        it('excludes quantified variables', () => {
            const f = new Formula('(forall (?X) (instance ?X Class))');
            const vars = f.collectUnquantifiedVariables();
            expect(vars.has('?X')).to.equal(false);
        });

        it('handles mixed quantified and free', () => {
            const f = new Formula('(=> (forall (?X) (instance ?X P)) (instance ?Y Q))');
            const vars = f.collectUnquantifiedVariables();
            expect(vars.has('?X')).to.equal(false);
            expect(vars.has('?Y')).to.equal(true);
        });
    });

    describe('isInequality()', () => {
        it('recognizes inequality operators', () => {
            expect(Formula.isInequality('greaterThan')).to.equal(true);
            expect(Formula.isInequality('lessThan')).to.equal(true);
            expect(Formula.isInequality('greaterThanOrEqualTo')).to.equal(true);
            expect(Formula.isInequality('lessThanOrEqualTo')).to.equal(true);
        });

        it('rejects non-inequalities', () => {
            expect(Formula.isInequality('equal')).to.equal(false);
            expect(Formula.isInequality('instance')).to.equal(false);
        });
    });
});
