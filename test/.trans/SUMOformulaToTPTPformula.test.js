/**
 * Tests for SUMOformulaToTPTPformula
 * Ported from SUMOformulaToTPTPformulaTest.java
 */

const { expect } = require('chai');
const {
    Formula,
    tptpParseSUOKIFString,
    generateQList,
    setHideNumbers,
    setLang,
    translateWord
} = require('../../src/sigma/engine/native/index.js');
const SUMOformulaToTPTPformula = require('../../src/sigma/engine/native/index.js');

describe('SUMOformulaToTPTPformula', () => {
    beforeEach(() => {
        setHideNumbers(true);
        setLang('fof');
    });

    function normalizeSpaces(s) {
        return s.replace(/\s+/g, ' ').trim();
    }

    // Extract variable list from quantifier and sort for comparison
    function normalizeVarOrder(s) {
        // Replace variable lists in quantifiers with sorted versions
        return s.replace(/(\[)([^\]]+)(\])/g, (match, open, vars, close) => {
            const sortedVars = vars.split(',').map(v => v.trim()).sort().join(',');
            return open + sortedVars + close;
        });
    }

    function runTest(kif, expected, label) {
        setLang('fof');
        let actual = tptpParseSUOKIFString(kif, false);
        if (actual) {
            actual = actual.replace(/\s\s+/g, ' ');
        }
        // Normalize both to handle variable ordering differences
        expect(normalizeVarOrder(normalizeSpaces(actual))).to.equal(normalizeVarOrder(normalizeSpaces(expected)));
    }

    describe('Basic formula conversion', () => {
        it('string1: implication with instance', () => {
            const kifstring = '(=> (instance ?X P)(instance ?X Q))';
            const expected = '( ( ! [V__X] : ((s__instance(V__X,s__P) => (s__instance(V__X,s__Q))) ) ) )';
            runTest(kifstring, expected, 'string1');
        });

        it('string2: implication with or', () => {
            const kifstring = '(=> (or (instance ?X Q)(instance ?X R))(instance ?X ?T))';
            const expected = '( ( ! [V__T,V__X] : (((s__instance(V__X,s__Q) | s__instance(V__X,s__R)) => (s__instance(V__X,V__T))) ) ) )';
            runTest(kifstring, expected, 'string2');
        });

        it('string3: or with not', () => {
            const kifstring = '(or (not (instance ?X Q))(instance ?X R))';
            const expected = '( ( ! [V__X] : ((~(s__instance(V__X,s__Q)) | s__instance(V__X,s__R)) ) ) )';
            runTest(kifstring, expected, 'string3');
        });

        it('string4: biconditional with and', () => {
            const kifstring = `(<=>
    (instance ?NUMBER NegativeRealNumber)
    (and
        (lessThan ?NUMBER 0)
        (instance ?NUMBER RealNumber)))`;
            const expected = '( ( ! [V__NUMBER] : (((s__instance(V__NUMBER,s__NegativeRealNumber) => (s__lessThan(V__NUMBER,n__0) & s__instance(V__NUMBER,s__RealNumber))) & ((s__lessThan(V__NUMBER,n__0) & s__instance(V__NUMBER,s__RealNumber)) => s__instance(V__NUMBER,s__NegativeRealNumber))) ) ) )';
            runTest(kifstring, expected, 'string4');
        });

        it('string5: biconditional with decimal number', () => {
            const kifstring = `(<=>
    (instance ?NUMBER NegativeRealNumber)
    (and
        (lessThan ?NUMBER 0.001)
        (instance ?NUMBER RealNumber)))`;
            const expected = '( ( ! [V__NUMBER] : (((s__instance(V__NUMBER,s__NegativeRealNumber) => (s__lessThan(V__NUMBER,n__0_001) & s__instance(V__NUMBER,s__RealNumber))) & ((s__lessThan(V__NUMBER,n__0_001) & s__instance(V__NUMBER,s__RealNumber)) => s__instance(V__NUMBER,s__NegativeRealNumber))) ) ) )';
            runTest(kifstring, expected, 'string5');
        });

        it('string6: biconditional with function', () => {
            const kifstring = '(<=> (temporalPart ?POS (WhenFn ?THING)) (time ?THING ?POS))';
            const expected = '( ( ! [V__POS,V__THING] : (((s__temporalPart(V__POS,s__WhenFn(V__THING)) => s__time(V__THING,V__POS)) & (s__time(V__THING,V__POS) => s__temporalPart(V__POS,s__WhenFn(V__THING)))) ) ) )';
            runTest(kifstring, expected, 'string6');
        });

        it('string7: biconditional with exists', () => {
            const kifstring = '(<=> (exists (?BUILD) (and (instance ?BUILD Constructing) (result ?BUILD ?ARTIFACT))) (instance ?ARTIFACT StationaryArtifact))';
            const expected = '( ( ! [V__ARTIFACT] : (((( ? [V__BUILD] : ((s__instance(V__BUILD,s__Constructing) & s__result(V__BUILD,V__ARTIFACT)))) => s__instance(V__ARTIFACT,s__StationaryArtifact)) & (s__instance(V__ARTIFACT,s__StationaryArtifact) => ( ? [V__BUILD] : ((s__instance(V__BUILD,s__Constructing) & s__result(V__BUILD,V__ARTIFACT)))))) ) ) )';
            runTest(kifstring, expected, 'string7');
        });
    });

    describe('Higher-order logic', () => {
        it('hol: complex formula with KappaFn', () => {
            const kifstring = '(=> (and (instance ?GUN Gun) (effectiveRange ?GUN ?LM) ' +
                '(distance ?GUN ?O ?LM1) (instance ?O Organism) (not (exists (?O2) ' +
                '(between ?O ?O2 ?GUN))) (lessThanOrEqualTo ?LM1 ?LM)) ' +
                '(capability (KappaFn ?KILLING (and (instance ?KILLING Killing) ' +
                '(patient ?KILLING ?O))) instrument ?GUN))';
            const expected = '( ( ! [V__LM,V__O,V__KILLING,V__GUN,V__LM1] : (((s__instance(V__GUN,s__Gun) & ' +
                's__effectiveRange(V__GUN,V__LM) & s__distance(V__GUN,V__O,V__LM1) & s__instance(V__O,s__Organism) & ' +
                '~(( ? [V__O2] : (s__between(V__O,V__O2,V__GUN)))) & s__lessThanOrEqualTo(V__LM1,V__LM)) => ' +
                '(s__capability(s__KappaFn(V__KILLING,(s__instance(V__KILLING,s__Killing) & ' +
                's__patient(V__KILLING,V__O))),s__instrument__m,V__GUN))) ) ) )';
            runTest(kifstring, expected, 'hol');
        });
    });

    describe('Embedded relations', () => {
        it('embedded: relation as argument', () => {
            const kifstring = '(instance equal BinaryPredicate)';
            const expected = '( s__instance(s__equal__m,s__BinaryPredicate) )';
            runTest(kifstring, expected, 'embedded');
        });
    });

    describe('Equality', () => {
        it('equality: equal operator', () => {
            const kifstring = '(=> (and (minValue minValue ?ARG ?N) (minValue ?ARGS2) ' +
                '(equal ?VAL (ListOrderFn (List__Fn__1Fn ?ARGS2) ?ARG))) (greaterThan ?VAL ?N))';
            const expected = '( ( ! [V__ARG,V__ARGS2,V__N,V__VAL] : (((s__minValue(s__minValue__m,V__ARG,V__N) & s__minValue(V__ARGS2) & ' +
                '(V__VAL = s__ListOrderFn(s__List__Fn__1Fn(V__ARGS2),V__ARG))) => (s__greaterThan(V__VAL,V__N))) ) ) )';
            runTest(kifstring, expected, 'equality');
        });
    });

    describe('generateQList', () => {
        it('collects single variable', () => {
            const f = new Formula('(<=> (instance ?NUMBER NegativeRealNumber) (and (lessThan ?NUMBER 0) (instance ?NUMBER RealNumber)))');
            generateQList(f);
            expect(SUMOformulaToTPTPformula.qlist).to.equal('V__NUMBER');
        });

        it('collects multiple variables', () => {
            const kifstring = '(=> (and (instance ?GUN Gun) (effectiveRange ?GUN ?LM) ' +
                '(distance ?GUN ?O ?LM1) (instance ?O Organism) (not (exists (?O2) ' +
                '(between ?O ?O2 ?GUN))) (lessThanOrEqualTo ?LM1 ?LM)) ' +
                '(capability (KappaFn ?KILLING (and (instance ?KILLING Killing) ' +
                '(patient ?KILLING ?O))) instrument ?GUN))';
            const f = new Formula(kifstring);
            generateQList(f);
            // The order may vary due to Set iteration, but all variables should be present
            const vars = SUMOformulaToTPTPformula.qlist.split(',');
            expect(vars).to.include('V__LM');
            expect(vars).to.include('V__O');
            expect(vars).to.include('V__KILLING');
            expect(vars).to.include('V__GUN');
            expect(vars).to.include('V__LM1');
            expect(vars.length).to.equal(5);
        });
    });
});

describe('translateWord', () => {
    beforeEach(() => {
        setHideNumbers(true);
        setLang('fof');
    });

    it('translates variables', () => {
        expect(translateWord('?X', '?', false)).to.equal('V__X');
        expect(translateWord('?VAR', '?', false)).to.equal('V__VAR');
    });

    it('translates constants', () => {
        expect(translateWord('True', 'T', false)).to.equal("'$true__m'");
        expect(translateWord('False', 'F', false)).to.equal("'$false__m'");
    });

    it('translates numbers', () => {
        expect(translateWord('42', '4', false)).to.equal('n__42');
        expect(translateWord('0', '0', false)).to.equal('n__0');
        expect(translateWord('3.14', '3', false)).to.equal('n__3_14');
    });

    it('translates terms with symbol prefix', () => {
        expect(translateWord('Entity', 'E', false)).to.equal('s__Entity');
        expect(translateWord('MyClass', 'M', false)).to.equal('s__MyClass');
    });

    it('adds mention suffix for relations as arguments', () => {
        // Lowercase starting terms get mention suffix when not used with arguments
        expect(translateWord('instance', 'i', false)).to.equal('s__instance__m');
        expect(translateWord('subclass', 's', false)).to.equal('s__subclass__m');
    });
});
