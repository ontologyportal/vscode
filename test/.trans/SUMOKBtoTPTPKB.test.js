/**
 * Tests for SUMOKBtoTPTPKB
 */

const { expect } = require('chai');
const {
    Formula,
    convertFormulas,
    writeHeader,
    filterAxiom,
    filterExcludePredicates,
    parseKIFFormulas,
    langToExtension,
    extensionToLang,
    excludedPredicates
} = require('../../src/sigma/engine/native/index.js');

describe('SUMOKBtoTPTPKB', () => {
    describe('writeHeader()', () => {
        it('generates correct header', () => {
            const header = writeHeader('TestKB');
            expect(header).to.include('% Articulate Software');
            expect(header).to.include('www.ontologyportal.org');
            expect(header).to.include('TestKB');
        });
    });

    describe('langToExtension()', () => {
        it('converts fof to tptp', () => {
            expect(langToExtension('fof')).to.equal('tptp');
        });

        it('keeps other extensions', () => {
            expect(langToExtension('tff')).to.equal('tff');
            expect(langToExtension('thf')).to.equal('thf');
        });
    });

    describe('extensionToLang()', () => {
        it('converts tptp to fof', () => {
            expect(extensionToLang('tptp')).to.equal('fof');
        });

        it('keeps other languages', () => {
            expect(extensionToLang('tff')).to.equal('tff');
            expect(extensionToLang('thf')).to.equal('thf');
        });
    });

    describe('filterExcludePredicates()', () => {
        it('filters documentation predicates', () => {
            const f = new Formula('(documentation Entity "An entity is something")');
            expect(filterExcludePredicates(f)).to.equal(true);
        });

        it('filters format predicates', () => {
            const f = new Formula('(format en Entity "entity")');
            expect(filterExcludePredicates(f)).to.equal(true);
        });

        it('does not filter regular predicates', () => {
            const f = new Formula('(instance Entity Class)');
            expect(filterExcludePredicates(f)).to.equal(false);
        });

        it('does not filter logical formulas', () => {
            const f = new Formula('(=> (instance ?X Entity) (exists (?Y) (related ?X ?Y)))');
            expect(filterExcludePredicates(f)).to.equal(false);
        });
    });

    describe('filterAxiom()', () => {
        it('filters already written formulas', () => {
            const f = new Formula('(instance Foo Bar)');
            const tptp = '( s__instance(s__Foo,s__Bar) )';
            const alreadyWritten = new Set([tptp]);
            const result = filterAxiom(f, tptp, alreadyWritten);
            expect(result.filtered).to.equal(true);
            expect(result.reason).to.include('already written');
        });

        it('allows new formulas', () => {
            const f = new Formula('(instance Foo Bar)');
            const tptp = '( s__instance(s__Foo,s__Bar) )';
            const alreadyWritten = new Set();
            const result = filterAxiom(f, tptp, alreadyWritten);
            expect(result.filtered).to.equal(false);
        });
    });

    describe('parseKIFFormulas()', () => {
        it('parses single formula', () => {
            const content = '(instance Foo Bar)';
            const formulas = parseKIFFormulas(content);
            expect(formulas).to.deep.equal(['(instance Foo Bar)']);
        });

        it('parses multiple formulas', () => {
            const content = `
(instance Foo Bar)
(subclass Bar Baz)
`;
            const formulas = parseKIFFormulas(content);
            expect(formulas.length).to.equal(2);
            expect(formulas[0]).to.equal('(instance Foo Bar)');
            expect(formulas[1]).to.equal('(subclass Bar Baz)');
        });

        it('handles nested formulas', () => {
            const content = '(=> (instance ?X Foo) (exists (?Y) (related ?X ?Y)))';
            const formulas = parseKIFFormulas(content);
            expect(formulas.length).to.equal(1);
            expect(formulas[0]).to.equal('(=> (instance ?X Foo) (exists (?Y) (related ?X ?Y)))');
        });

        it('skips comments', () => {
            const content = `
; This is a comment
(instance Foo Bar)
; Another comment
(subclass Bar Baz)
`;
            const formulas = parseKIFFormulas(content);
            expect(formulas.length).to.equal(2);
        });

        it('handles quoted strings', () => {
            const content = '(documentation Entity EnglishLanguage "A description")';
            const formulas = parseKIFFormulas(content);
            expect(formulas.length).to.equal(1);
            expect(formulas[0]).to.equal('(documentation Entity EnglishLanguage "A description")');
        });
    });

    describe('convertFormulas()', () => {
        it('converts simple formulas', () => {
            const formulas = [
                '(instance Foo Bar)'
            ];
            const result = convertFormulas(formulas, 'TestKB');
            expect(result.content).to.include('fof(kb_TestKB_1,axiom,');
            expect(result.axiomCount).to.equal(1);
        });

        it('converts multiple formulas', () => {
            const formulas = [
                '(instance Foo Bar)',
                '(subclass Bar Baz)'
            ];
            const result = convertFormulas(formulas, 'TestKB');
            expect(result.content).to.include('kb_TestKB_1');
            expect(result.content).to.include('kb_TestKB_2');
            expect(result.axiomCount).to.equal(2);
        });

        it('skips documentation formulas', () => {
            const formulas = [
                '(documentation Entity EnglishLanguage "A thing")',
                '(instance Foo Bar)'
            ];
            const result = convertFormulas(formulas, 'TestKB');
            expect(result.axiomCount).to.equal(1);
        });

        it('adds conjecture when provided', () => {
            const formulas = ['(instance Foo Bar)'];
            const conjecture = '(instance ?X Bar)';
            const result = convertFormulas(formulas, 'TestKB', conjecture, false);
            expect(result.content).to.include('conjecture');
            expect(result.content).to.include('prove_from_TestKB');
        });

        it('adds question when isQuestion is true', () => {
            const formulas = ['(instance Foo Bar)'];
            const conjecture = '(instance ?X Bar)';
            const result = convertFormulas(formulas, 'TestKB', conjecture, true);
            expect(result.content).to.include('question');
        });

        it('sanitizes KB name', () => {
            const formulas = ['(instance Foo Bar)'];
            const result = convertFormulas(formulas, 'Test KB-v1.0');
            expect(result.content).to.include('Test_KB_v1_0');
        });
    });

    describe('excludedPredicates', () => {
        it('contains expected predicates', () => {
            expect(excludedPredicates.has('documentation')).to.equal(true);
            expect(excludedPredicates.has('format')).to.equal(true);
            expect(excludedPredicates.has('termFormat')).to.equal(true);
            expect(excludedPredicates.has('externalImage')).to.equal(true);
        });

        it('does not contain regular predicates', () => {
            expect(excludedPredicates.has('instance')).to.equal(false);
            expect(excludedPredicates.has('subclass')).to.equal(false);
        });
    });
});
