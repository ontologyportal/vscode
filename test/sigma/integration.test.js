/**
 * Integration tests for SUMO to TPTP conversion
 */

const { expect } = require('chai');
const {
    Formula,
    tptpParseSUOKIFString,
    setLang,
    setHideNumbers,
    convertFormulas,
    parseKIFFormulas
} = require('../../src/sigma/engine/native/index.js');

describe('Integration Tests', () => {
    beforeEach(() => {
        setLang('fof');
        setHideNumbers(true);
    });

    describe('End-to-end formula conversion', () => {
        it('converts a complete ontology fragment', () => {
            const kifContent = `
; Simple ontology fragment
(instance Entity Class)
(subclass Physical Entity)
(subclass Object Physical)
(=> (instance ?X Object) (instance ?X Physical))
(=> (and (instance ?X Physical) (located ?X ?Y)) (instance ?Y Region))
`;
            const formulas = parseKIFFormulas(kifContent);
            expect(formulas.length).to.equal(5);

            const result = convertFormulas(formulas, 'TestOntology');
            expect(result.axiomCount).to.equal(5);
            expect(result.content).to.include('s__instance');
            expect(result.content).to.include('s__subclass');
            expect(result.content).to.include('=>');
        });

        it('preserves variable scoping in quantified formulas', () => {
            const kifstring = '(forall (?X ?Y) (=> (and (instance ?X Human) (parent ?X ?Y)) (instance ?Y Human)))';
            const tptp = tptpParseSUOKIFString(kifstring, false);

            // Should have the inner forall quantifier
            expect(tptp).to.include('! [V__X, V__Y]');
            expect(tptp).to.include('s__instance');
            expect(tptp).to.include('s__parent');
        });

        it('handles nested existential quantifiers', () => {
            const kifstring = '(=> (instance ?X Human) (exists (?Y) (parent ?X ?Y)))';
            const tptp = tptpParseSUOKIFString(kifstring, false);

            expect(tptp).to.include('! [V__X]'); // Universal for free variable
            expect(tptp).to.include('? [V__Y]'); // Existential for bound variable
        });

        it('handles complex logical expressions', () => {
            const kifstring = '(=> (or (instance ?X A) (instance ?X B)) (and (property ?X P) (not (property ?X Q))))';
            const tptp = tptpParseSUOKIFString(kifstring, false);

            expect(tptp).to.include('|');   // or
            expect(tptp).to.include('&');   // and
            expect(tptp).to.include('~');   // not
            expect(tptp).to.include('=>');  // implication
        });

        it('handles function terms', () => {
            const kifstring = '(instance (PlusFn 2 3) Number)';
            const tptp = tptpParseSUOKIFString(kifstring, false);

            expect(tptp).to.include('s__PlusFn');
            expect(tptp).to.include('n__2');
            expect(tptp).to.include('n__3');
        });

        it('handles equality correctly', () => {
            const kifstring = '(=> (equal ?X ?Y) (equal ?Y ?X))';
            const tptp = tptpParseSUOKIFString(kifstring, false);

            expect(tptp).to.include('=');
            expect(tptp).to.include('V__X');
            expect(tptp).to.include('V__Y');
        });
    });

    describe('Batch conversion', () => {
        it('generates valid TPTP file structure', () => {
            const formulas = [
                '(instance Human Animal)',
                '(subclass Human Mammal)',
                '(=> (instance ?X Human) (instance ?X Animal))'
            ];

            const result = convertFormulas(formulas, 'HumanKB');

            // Check header
            expect(result.content).to.include('% Articulate Software');
            expect(result.content).to.include('HumanKB');

            // Check axiom format
            expect(result.content).to.match(/fof\(kb_HumanKB_\d+,axiom,/);

            // Check proper termination
            const lines = result.content.split('\n').filter(l => l.startsWith('fof('));
            for (const line of lines) {
                expect(line).to.match(/\)\.\s*$/);
            }
        });

        it('handles conjecture queries', () => {
            const formulas = [
                '(instance Human Animal)',
                '(=> (instance ?X Human) (instance ?X Animal))'
            ];
            const conjecture = '(instance John Animal)';

            const result = convertFormulas(formulas, 'TestKB', conjecture, false);

            expect(result.content).to.include('conjecture');
            expect(result.content).to.include('prove_from_TestKB');
        });
    });

    describe('Edge cases', () => {
        it('handles empty formula list', () => {
            const result = convertFormulas([], 'EmptyKB');
            expect(result.axiomCount).to.equal(0);
            expect(result.content).to.include('% Articulate Software');
        });

        it('handles formulas with special characters in names', () => {
            const kifstring = '(instance List__Fn__1 Function)';
            const tptp = tptpParseSUOKIFString(kifstring, false);
            expect(tptp).to.include('s__List__Fn__1');
        });

        it('handles deeply nested formulas', () => {
            const kifstring = '(=> (and (or (instance ?X A) (instance ?X B)) (not (and (property ?X P) (property ?X Q)))) (exists (?Y) (related ?X ?Y)))';
            const tptp = tptpParseSUOKIFString(kifstring, false);

            // Should parse without error and contain expected elements
            expect(tptp).to.include('V__X');
            expect(tptp).to.include('V__Y');
            expect(tptp).to.include('? [V__Y]');
        });

        it('handles multiple quantifiers', () => {
            const kifstring = '(forall (?X) (exists (?Y) (forall (?Z) (related ?X ?Y ?Z))))';
            const tptp = tptpParseSUOKIFString(kifstring, false);

            expect(tptp).to.include('! [V__X]');
            expect(tptp).to.include('? [V__Y]');
            expect(tptp).to.include('! [V__Z]');
        });
    });

    describe('Consistency with Java implementation', () => {
        // These tests verify the output matches the Java implementation

        it('simple implication matches Java output', () => {
            const kifstring = '(=> (instance ?X P)(instance ?X Q))';
            const expected = '( ( ! [V__X] : ((s__instance(V__X,s__P) => (s__instance(V__X,s__Q))) ) ) )';
            const actual = tptpParseSUOKIFString(kifstring, false).replace(/\s+/g, ' ');
            expect(actual).to.equal(expected.replace(/\s+/g, ' '));
        });

        it('embedded relation matches Java output', () => {
            const kifstring = '(instance equal BinaryPredicate)';
            const expected = '( s__instance(s__equal__m,s__BinaryPredicate) )';
            const actual = tptpParseSUOKIFString(kifstring, false).replace(/\s+/g, ' ');
            expect(actual).to.equal(expected.replace(/\s+/g, ' '));
        });
    });
});
