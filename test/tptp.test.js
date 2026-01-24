/**
 * TPTP Conversion Tests
 * Based on sigmakee's SUMOformulaToTPTPformulaTest.java
 */

const assert = require('assert');
const { tokenize } = require('../src/parser/tokenizer');
const { parse, collectFreeVariables } = require('../src/parser/parser');
const {
    convertVariable,
    convertNumber,
    convertTerm,
    convertFormula,
    convertKnowledgeBase,
    defaultOptions
} = require('../src/tptp/converter');

// Test helper to convert a KIF string to TPTP
function kifToTPTP(kifString, options = {}) {
    const tokens = tokenize(kifString);
    const ast = parse(tokens);
    if (ast.length === 0) return null;
    return convertFormula(ast[0], { ...defaultOptions, ...options });
}

// Test helper to parse KIF
function parseKIF(kifString) {
    const tokens = tokenize(kifString);
    return parse(tokens);
}

// Helper to normalize TPTP output for comparison
// Removes extra spaces and normalizes formatting
function normalize(tptp) {
    if (!tptp) return null;
    return tptp
        .replace(/\s+/g, ' ')           // Collapse whitespace
        .replace(/\s*,\s*/g, ',')       // Remove spaces around commas
        .replace(/\s*\(\s*/g, '(')      // Remove spaces around parens
        .replace(/\s*\)\s*/g, ')')      // Remove spaces around parens
        .replace(/\(\s+/g, '(')         // Clean up after paren
        .replace(/\s+\)/g, ')')         // Clean up before paren
        .replace(/\[\s+/g, '[')         // Clean up brackets
        .replace(/\s+\]/g, ']')         // Clean up brackets
        .trim();
}

// ============================================================
// Test Suites
// ============================================================

describe('Variable Conversion', () => {
    it('should convert ?X to V__X', () => {
        assert.strictEqual(convertVariable('?X'), 'V__X');
    });

    it('should convert ?variable to V__VARIABLE', () => {
        assert.strictEqual(convertVariable('?variable'), 'V__VARIABLE');
    });

    it('should convert @ROW to V__ROW', () => {
        assert.strictEqual(convertVariable('@ROW'), 'V__ROW');
    });

    it('should replace hyphens with underscores', () => {
        assert.strictEqual(convertVariable('?my-var'), 'V__MY_VAR');
    });

    it('should handle mixed case variables', () => {
        assert.strictEqual(convertVariable('?myVariable'), 'V__MYVARIABLE');
    });
});

describe('Number Conversion', () => {
    it('should convert 0 with hideNumbers=true', () => {
        assert.strictEqual(convertNumber('0', { hideNumbers: true }), 'n__0');
    });

    it('should convert positive integer with hideNumbers=true', () => {
        assert.strictEqual(convertNumber('42', { hideNumbers: true }), 'n__42');
    });

    it('should convert decimal 0.001 with hideNumbers=true', () => {
        assert.strictEqual(convertNumber('0.001', { hideNumbers: true }), 'n__0_001');
    });

    it('should convert decimal 3.14 with hideNumbers=true', () => {
        assert.strictEqual(convertNumber('3.14', { hideNumbers: true }), 'n__3_14');
    });

    it('should convert negative numbers with hideNumbers=true', () => {
        assert.strictEqual(convertNumber('-5', { hideNumbers: true }), 'n__neg_5');
    });

    it('should pass through with hideNumbers=false', () => {
        assert.strictEqual(convertNumber('42', { hideNumbers: false }), '42');
        assert.strictEqual(convertNumber('3.14', { hideNumbers: false }), '3.14');
    });
});

describe('Term Conversion', () => {
    it('should add s__ prefix to terms', () => {
        assert.strictEqual(convertTerm('Person', false, { addPrefixes: true }), 's__Person');
    });

    it('should convert True to $true', () => {
        assert.strictEqual(convertTerm('True', false, { addPrefixes: true }), '$true');
    });

    it('should convert False to $false', () => {
        assert.strictEqual(convertTerm('False', false, { addPrefixes: true }), '$false');
    });

    it('should add __m suffix for relations used as arguments', () => {
        const result = convertTerm('subclass', true, { addPrefixes: true });
        assert.strictEqual(result, 's__subclass__m');
    });

    it('should add __m suffix for equal used as argument', () => {
        const result = convertTerm('equal', true, { addPrefixes: true });
        assert.strictEqual(result, 's__equal__m');
    });

    it('should not add __m suffix for classes used as arguments', () => {
        const result = convertTerm('Person', true, { addPrefixes: true });
        assert.strictEqual(result, 's__Person');
    });

    it('should handle terms with hyphens', () => {
        const result = convertTerm('my-term', false, { addPrefixes: true });
        assert.strictEqual(result, "'s__my-term'");
    });
});

describe('Free Variable Collection', () => {
    it('should find free variables in simple formula', () => {
        const ast = parseKIF('(instance ?X Person)');
        const freeVars = collectFreeVariables(ast[0]);
        assert.strictEqual(freeVars.size, 1);
        assert.ok(freeVars.has('?X'));
    });

    it('should find multiple free variables', () => {
        const ast = parseKIF('(=> (instance ?X ?T) (attribute ?X ?A))');
        const freeVars = collectFreeVariables(ast[0]);
        assert.strictEqual(freeVars.size, 3);
        assert.ok(freeVars.has('?X'));
        assert.ok(freeVars.has('?T'));
        assert.ok(freeVars.has('?A'));
    });

    it('should not include bound variables from forall', () => {
        const ast = parseKIF('(forall (?X) (instance ?X Person))');
        const freeVars = collectFreeVariables(ast[0]);
        assert.strictEqual(freeVars.size, 0);
    });

    it('should not include bound variables from exists', () => {
        const ast = parseKIF('(exists (?X) (instance ?X Person))');
        const freeVars = collectFreeVariables(ast[0]);
        assert.strictEqual(freeVars.size, 0);
    });

    it('should find free variables outside quantifier scope', () => {
        const ast = parseKIF('(=> (instance ?Y Class) (forall (?X) (subclass ?X ?Y)))');
        const freeVars = collectFreeVariables(ast[0]);
        assert.strictEqual(freeVars.size, 1);
        assert.ok(freeVars.has('?Y'));
    });

    it('should handle nested quantifiers correctly', () => {
        const ast = parseKIF('(forall (?X) (exists (?Y) (and (related ?X ?Y) (instance ?Z Class))))');
        const freeVars = collectFreeVariables(ast[0]);
        assert.strictEqual(freeVars.size, 1);
        assert.ok(freeVars.has('?Z'));
    });
});

// ============================================================
// Sigmakee Test Cases - SUMOformulaToTPTPformulaTest.java
// ============================================================

describe('Sigmakee Test Cases - Basic', () => {

    // string1: Simple implication
    it('string1: should convert simple implication with variables', () => {
        const kif = '(=> (instance ?X P) (instance ?X Q))';
        const result = kifToTPTP(kif);
        const normalized = normalize(result);

        // Expected: "( ( ! [V__X] : ((s__instance(V__X,s__P) => s__instance(V__X,s__Q)) ) ) )"
        assert.ok(normalized.includes('!'), 'Should have universal quantifier');
        assert.ok(normalized.includes('[V__X]'), 'Should have V__X in quantifier');
        assert.ok(normalized.includes('s__instance(V__X,s__P)'), 'Should have s__instance(V__X,s__P)');
        assert.ok(normalized.includes('=>'), 'Should have implication');
        assert.ok(normalized.includes('s__instance(V__X,s__Q)'), 'Should have s__instance(V__X,s__Q)');
    });

    // string2: Disjunction with multiple variables
    it('string2: should convert disjunction with multiple variables', () => {
        const kif = '(=> (or (instance ?X Q) (instance ?X R)) (instance ?X ?T))';
        const result = kifToTPTP(kif);
        const normalized = normalize(result);

        // Expected: "( ( ! [V__T,V__X] : (((s__instance(V__X,s__Q) | s__instance(V__X,s__R)) => s__instance(V__X,V__T)) ) ) )"
        assert.ok(normalized.includes('!'), 'Should have universal quantifier');
        assert.ok(normalized.includes('V__X'), 'Should have V__X');
        assert.ok(normalized.includes('V__T'), 'Should have V__T');
        assert.ok(normalized.includes('|'), 'Should have disjunction operator');
        assert.ok(normalized.includes('=>'), 'Should have implication');
    });

    // string3: Negation
    it('string3: should convert negation', () => {
        const kif = '(or (not (instance ?X Q)) (instance ?X R))';
        const result = kifToTPTP(kif);
        const normalized = normalize(result);

        // Expected: "( ( ! [V__X] : ((~(s__instance(V__X,s__Q)) | s__instance(V__X,s__R)) ) ) )"
        assert.ok(normalized.includes('~'), 'Should have negation operator');
        assert.ok(normalized.includes('|'), 'Should have disjunction');
        assert.ok(normalized.includes('s__instance(V__X,s__Q)'), 'Should have negated instance');
        assert.ok(normalized.includes('s__instance(V__X,s__R)'), 'Should have second instance');
    });

    // string4: Biconditional with numeric constant
    it('string4: should convert biconditional with number 0', () => {
        const kif = `(<=>
            (instance ?NUMBER NegativeRealNumber)
            (and
                (lessThan ?NUMBER 0)
                (instance ?NUMBER RealNumber)))`;
        const result = kifToTPTP(kif);
        const normalized = normalize(result);

        // Expected to have biconditional, number conversion, and conjunction
        assert.ok(normalized.includes('<=>'), 'Should have biconditional');
        assert.ok(normalized.includes('n__0'), 'Should have n__0 for number 0');
        assert.ok(normalized.includes('&'), 'Should have conjunction');
        assert.ok(normalized.includes('s__NegativeRealNumber'), 'Should have NegativeRealNumber');
        assert.ok(normalized.includes('s__RealNumber'), 'Should have RealNumber');
    });

    // string5: Decimal number
    it('string5: should convert decimal numbers (0.001)', () => {
        const kif = `(<=>
            (instance ?NUMBER NegativeRealNumber)
            (and
                (lessThan ?NUMBER 0.001)
                (instance ?NUMBER RealNumber)))`;
        const result = kifToTPTP(kif);
        const normalized = normalize(result);

        // Expected: number 0.001 converted to n__0_001
        assert.ok(normalized.includes('n__0_001'), 'Should have n__0_001 for 0.001');
    });

    // string6: Function application
    it('string6: should convert function application (WhenFn)', () => {
        const kif = '(<=> (temporalPart ?POS (WhenFn ?THING)) (time ?THING ?POS))';
        const result = kifToTPTP(kif);
        const normalized = normalize(result);

        // Expected: "( ( ! [V__POS,V__THING] : (((s__temporalPart(V__POS,s__WhenFn(V__THING)) => s__time(V__THING,V__POS)) & (s__time(V__THING,V__POS) => s__temporalPart(V__POS,s__WhenFn(V__THING)))) ) ) )"
        assert.ok(normalized.includes('s__WhenFn(V__THING)'), 'Should have function application');
        assert.ok(normalized.includes('V__THING'), 'Should have V__THING variable');
        assert.ok(normalized.includes('V__POS'), 'Should have V__POS variable');
        assert.ok(normalized.includes('s__temporalPart'), 'Should have temporalPart predicate');
        assert.ok(normalized.includes('s__time'), 'Should have time predicate');
    });
});

describe('Sigmakee Test Cases - Quantifiers', () => {

    // string7: Existential quantification
    it('string7: should convert existential quantification', () => {
        const kif = '(<=> (exists (?BUILD) (and (instance ?BUILD Constructing) (result ?BUILD ?ARTIFACT))) (instance ?ARTIFACT StationaryArtifact))';
        const result = kifToTPTP(kif);
        const normalized = normalize(result);

        // Should have existential quantifier
        assert.ok(normalized.includes('?'), 'Should have existential quantifier (?)');
        assert.ok(normalized.includes('V__BUILD'), 'Should have bound variable V__BUILD');
        assert.ok(normalized.includes('V__ARTIFACT'), 'Should have free variable V__ARTIFACT');
        assert.ok(normalized.includes('s__Constructing'), 'Should have Constructing');
        assert.ok(normalized.includes('s__StationaryArtifact'), 'Should have StationaryArtifact');
    });

    // Nested quantifiers
    it('should convert nested quantifiers (forall + exists)', () => {
        const kif = '(forall (?X) (exists (?Y) (related ?X ?Y)))';
        const result = kifToTPTP(kif);
        const normalized = normalize(result);

        assert.ok(normalized.includes('!'), 'Should have universal quantifier');
        assert.ok(normalized.includes('?'), 'Should have existential quantifier');
        assert.ok(normalized.includes('[V__X]'), 'Should have V__X');
        assert.ok(normalized.includes('[V__Y]'), 'Should have V__Y');
        assert.ok(normalized.includes('s__related'), 'Should have related predicate');
    });

    // Multiple bound variables
    it('should handle multiple bound variables in forall', () => {
        const kif = '(forall (?X ?Y) (=> (related ?X ?Y) (related ?Y ?X)))';
        const result = kifToTPTP(kif);
        const normalized = normalize(result);

        assert.ok(normalized.includes('V__X'), 'Should have V__X');
        assert.ok(normalized.includes('V__Y'), 'Should have V__Y');
        // Variables should be in the same quantifier list
        assert.ok(normalized.includes('[V__X,V__Y]') || normalized.includes('[V__Y,V__X]'),
            'Should have both variables in quantifier list');
    });
});

describe('Sigmakee Test Cases - Embedded Relations', () => {

    // embedded: Relation used as argument
    it('embedded: should handle relation used as argument', () => {
        const kif = '(instance equal BinaryPredicate)';
        const result = kifToTPTP(kif);
        const normalized = normalize(result);

        // Expected: "( s__instance(s__equal__m,s__BinaryPredicate) )"
        // When 'equal' (a relation) is used as an argument, it gets __m suffix
        assert.ok(normalized.includes('s__equal__m'), 'Should have s__equal__m (relation as argument)');
        assert.ok(normalized.includes('s__BinaryPredicate'), 'Should have s__BinaryPredicate');
    });

    it('should handle subclass relation as argument', () => {
        const kif = '(instance subclass TransitiveRelation)';
        const result = kifToTPTP(kif);
        const normalized = normalize(result);

        assert.ok(normalized.includes('s__subclass__m'), 'Should have s__subclass__m (relation as argument)');
        assert.ok(normalized.includes('s__TransitiveRelation'), 'Should have s__TransitiveRelation');
    });

    it('should not add __m to class names used as arguments', () => {
        const kif = '(instance John Person)';
        const result = kifToTPTP(kif);
        const normalized = normalize(result);

        assert.ok(normalized.includes('s__John'), 'Should have s__John without __m');
        assert.ok(!normalized.includes('s__John__m'), 'Should NOT have s__John__m');
        assert.ok(normalized.includes('s__Person'), 'Should have s__Person');
    });
});

describe('Sigmakee Test Cases - Equality', () => {

    // equality: Equal predicate conversion
    it('equality: should convert equal to = operator', () => {
        const kif = '(=> (and (minValue minValue ?ARG ?N) (minValue ?ARGS2) (equal ?VAL (ListOrderFn (List__Fn__1Fn ?ARGS2) ?ARG))) (greaterThan ?VAL ?N))';
        const result = kifToTPTP(kif);
        const normalized = normalize(result);

        // Expected: equal converts to = operator, minValue used as argument gets __m
        assert.ok(normalized.includes('s__minValue__m'), 'Should have s__minValue__m (relation as argument)');
        assert.ok(normalized.includes('='), 'Should have equality operator');
        assert.ok(normalized.includes('s__ListOrderFn'), 'Should have ListOrderFn');
        assert.ok(normalized.includes('s__List__Fn__1Fn'), 'Should have List__Fn__1Fn');
    });

    it('should convert simple equality', () => {
        const kif = '(= ?X ?Y)';
        const result = kifToTPTP(kif);
        const normalized = normalize(result);

        assert.ok(normalized.includes('V__X'), 'Should have V__X');
        assert.ok(normalized.includes('V__Y'), 'Should have V__Y');
        assert.ok(normalized.includes('='), 'Should have equality operator');
    });

    it('should convert equality with function application', () => {
        const kif = '(= (PlusFn ?X ?Y) (PlusFn ?Y ?X))';
        const result = kifToTPTP(kif);
        const normalized = normalize(result);

        assert.ok(normalized.includes('='), 'Should have equality');
        assert.ok(normalized.includes('s__PlusFn') || normalized.includes('s__sum'), 'Should have function');
    });

    it('should convert equal in argument position to term s__equal', () => {
        const kif = '(holdsDuring ?T (equal ?A ?B))';
        const result = kifToTPTP(kif);
        const normalized = normalize(result);
        
        assert.ok(normalized.includes('s__holdsDuring'), 'Should have s__holdsDuring');
        assert.ok(normalized.includes('s__equal('), 'Should have s__equal term');
        assert.ok(!normalized.includes('= V__B'), 'Should NOT have = operator');
    });
});

describe('Sigmakee Test Cases - Complex Formulas', () => {

    // hol: Complex higher-order logic formula
    // This formula contains KappaFn with a nested logical formula (and ...) as argument
    // which is higher-order logic that cannot be expressed in FOF, so it throws HOLError
    it('hol: should throw HOLError for formula with nested logical formula in argument', () => {
        const kif = `(=> (and (instance ?GUN Gun) (effectiveRange ?GUN ?LM)
            (distance ?GUN ?O ?LM1) (instance ?O Organism) (not (exists (?O2)
            (between ?O ?O2 ?GUN))) (lessThanOrEqualTo ?LM1 ?LM))
            (capability (KappaFn ?KILLING (and (instance ?KILLING Killing)
            (patient ?KILLING ?O))) instrument ?GUN))`;

        // This formula contains (and ...) inside KappaFn which is HOL
        // The converter should throw HOLError
        assert.throws(() => {
            kifToTPTP(kif);
        }, /HOLError|Logical formula in argument position/);
    });

    it('should convert complex nested formula with Gun/Shooting', () => {
        const kif = `(=>
            (and
                (instance ?GUN Gun)
                (effectiveRange ?GUN ?LM))
            (capability ?GUN instrument Shooting))`;
        const result = kifToTPTP(kif);
        const normalized = normalize(result);

        assert.ok(normalized.includes('=>'), 'Should have implication');
        assert.ok(normalized.includes('&'), 'Should have conjunction');
        assert.ok(normalized.includes('s__Gun'), 'Should have Gun');
        assert.ok(normalized.includes('s__Shooting'), 'Should have Shooting');
        assert.ok(normalized.includes('s__capability'), 'Should have capability');
    });
});

describe('Knowledge Base Conversion', () => {
    it('should convert multiple formulas', () => {
        const kif = `
            (instance John Person)
            (subclass Student Person)
            (=> (instance ?X Student) (instance ?X Person))
        `;
        const tokens = tokenize(kif);
        const ast = parse(tokens);
        const result = convertKnowledgeBase(ast, { sourceName: 'test' });

        assert.ok(result.axiomCount >= 3, 'Should convert all formulas');
        assert.ok(result.tptp.includes('fof('), 'Should have FOF format');
    });

    it('should skip documentation predicates', () => {
        const kif = `
            (instance John Person)
            (documentation Person EnglishLanguage "A human being")
        `;
        const tokens = tokenize(kif);
        const ast = parse(tokens);
        const result = convertKnowledgeBase(ast);

        assert.strictEqual(result.axiomCount, 1, 'Should skip documentation');
    });

    it('should skip domain predicates', () => {
        const kif = `
            (instance John Person)
            (domain instance 1 Entity)
            (domain instance 2 SetOrClass)
        `;
        const tokens = tokenize(kif);
        const ast = parse(tokens);
        const result = convertKnowledgeBase(ast);

        assert.strictEqual(result.axiomCount, 1, 'Should skip domain declarations');
    });

    it('should generate meaningful axiom names', () => {
        const kif = `
            (subclass Student Person)
            (instance John Person)
            (=> (p ?X) (q ?X))
        `;
        const tokens = tokenize(kif);
        const ast = parse(tokens);
        const result = convertKnowledgeBase(ast);

        assert.ok(result.tptp.includes('subclass_student'), 'Should have subclass axiom name');
        assert.ok(result.tptp.includes('instance_john'), 'Should have instance axiom name');
        assert.ok(result.tptp.includes('rule_'), 'Should have rule axiom name');
    });

    it('should generate TPTP header with metadata', () => {
        const kif = '(instance John Person)';
        const tokens = tokenize(kif);
        const ast = parse(tokens);
        const result = convertKnowledgeBase(ast, { sourceName: 'test-kb' });

        assert.ok(result.tptp.includes('% TPTP Translation'), 'Should have header');
        assert.ok(result.tptp.includes('test-kb'), 'Should include source name');
        assert.ok(result.tptp.includes('s__'), 'Should document prefix');
    });
});

describe('Edge Cases', () => {
    it('should handle empty conjunction (and)', () => {
        const kif = '(and)';
        const result = kifToTPTP(kif);
        assert.strictEqual(result, '$true', 'Empty conjunction should be $true');
    });

    it('should handle empty disjunction (or)', () => {
        const kif = '(or)';
        const result = kifToTPTP(kif);
        assert.strictEqual(result, '$false', 'Empty disjunction should be $false');
    });

    it('should handle single-element conjunction', () => {
        const kif = '(and (instance ?X Person))';
        const result = kifToTPTP(kif);
        const normalized = normalize(result);

        // Should simplify to just the element
        assert.ok(!normalized.includes('&'), 'Should not have conjunction operator for single element');
        assert.ok(normalized.includes('s__instance'), 'Should have the predicate');
    });

    it('should handle single-element disjunction', () => {
        const kif = '(or (instance ?X Person))';
        const result = kifToTPTP(kif);
        const normalized = normalize(result);

        assert.ok(!normalized.includes('|'), 'Should not have disjunction operator for single element');
        assert.ok(normalized.includes('s__instance'), 'Should have the predicate');
    });

    it('should handle strings with removeStrings=false', () => {
        const kif = '(name John "John Smith")';
        const result = kifToTPTP(kif, { removeStrings: false });
        assert.ok(result.includes('str_'), 'Should have string constant');
    });

    it('should handle deeply nested formulas', () => {
        const kif = '(=> (and (or (p ?X) (q ?X)) (not (r ?X))) (s ?X))';
        const result = kifToTPTP(kif);
        const normalized = normalize(result);

        assert.ok(normalized.includes('|'), 'Should have disjunction');
        assert.ok(normalized.includes('&'), 'Should have conjunction');
        assert.ok(normalized.includes('~'), 'Should have negation');
        assert.ok(normalized.includes('=>'), 'Should have implication');
    });

    it('should handle multiple consecutive quantifiers', () => {
        const kif = '(forall (?X) (forall (?Y) (forall (?Z) (rel ?X ?Y ?Z))))';
        const result = kifToTPTP(kif);
        const normalized = normalize(result);

        assert.ok(normalized.includes('V__X'), 'Should have V__X');
        assert.ok(normalized.includes('V__Y'), 'Should have V__Y');
        assert.ok(normalized.includes('V__Z'), 'Should have V__Z');
    });

    it('should handle formula with no free variables', () => {
        const kif = '(forall (?X) (instance ?X Entity))';
        const result = kifToTPTP(kif);
        const normalized = normalize(result);

        // Should not add outer universal quantifier since all vars are bound
        assert.ok(normalized.includes('![V__X]') || normalized.includes('! [V__X]'),
            'Should have explicit universal quantifier');
    });
});

describe('Logical Operator Edge Cases', () => {
    it('should handle double negation', () => {
        const kif = '(not (not (instance ?X Person)))';
        const result = kifToTPTP(kif);
        const normalized = normalize(result);

        assert.ok((normalized.match(/~/g) || []).length >= 2, 'Should have two negations');
    });

    it('should handle implication chain', () => {
        const kif = '(=> (p ?X) (=> (q ?X) (r ?X)))';
        const result = kifToTPTP(kif);
        const normalized = normalize(result);

        assert.ok((normalized.match(/=>/g) || []).length >= 2, 'Should have nested implications');
    });

    it('should handle xor operator', () => {
        // XOR is not directly in the current implementation, but let's check disjunction
        const kif = '(or (and (p ?X) (not (q ?X))) (and (not (p ?X)) (q ?X)))';
        const result = kifToTPTP(kif);
        const normalized = normalize(result);

        assert.ok(normalized.includes('|'), 'Should have disjunction');
        assert.ok(normalized.includes('&'), 'Should have conjunction');
        assert.ok(normalized.includes('~'), 'Should have negation');
    });
});

describe('Sigmakee testGenerateQList equivalent', () => {
    it('should generate correct variable list for NegativeRealNumber formula', () => {
        const kif = '(<=> (instance ?NUMBER NegativeRealNumber) (and (lessThan ?NUMBER 0) (instance ?NUMBER RealNumber)))';
        const ast = parseKIF(kif);
        const freeVars = collectFreeVariables(ast[0]);

        assert.strictEqual(freeVars.size, 1, 'Should have 1 free variable');
        assert.ok(freeVars.has('?NUMBER'), 'Should have ?NUMBER');
    });

    it('should generate correct variable list for Gun/KappaFn formula', () => {
        const kif = `(=> (and (instance ?GUN Gun) (effectiveRange ?GUN ?LM)
            (distance ?GUN ?O ?LM1) (instance ?O Organism) (not (exists (?O2)
            (between ?O ?O2 ?GUN))) (lessThanOrEqualTo ?LM1 ?LM))
            (capability (KappaFn ?KILLING (and (instance ?KILLING Killing)
            (patient ?KILLING ?O))) instrument ?GUN))`;
        const ast = parseKIF(kif);
        const freeVars = collectFreeVariables(ast[0]);

        // Expected free variables: ?LM, ?O, ?KILLING, ?GUN, ?LM1
        // ?O2 is bound by exists
        assert.strictEqual(freeVars.size, 5, 'Should have 5 free variables');
        assert.ok(freeVars.has('?GUN'), 'Should have ?GUN');
        assert.ok(freeVars.has('?LM'), 'Should have ?LM');
        assert.ok(freeVars.has('?LM1'), 'Should have ?LM1');
        assert.ok(freeVars.has('?O'), 'Should have ?O');
        assert.ok(freeVars.has('?KILLING'), 'Should have ?KILLING');
        assert.ok(!freeVars.has('?O2'), 'Should NOT have ?O2 (bound variable)');
    });
});

// Run tests if this file is executed directly
if (require.main === module) {
    console.log('Running TPTP Conversion Tests\n');
    console.log('To run with mocha: npm test\n');
    console.log('Or: npx mocha test/tptp.test.js\n');

    // Basic sanity checks
    try {
        assert.strictEqual(convertVariable('?X'), 'V__X');
        assert.strictEqual(convertNumber('42', { hideNumbers: true }), 'n__42');
        assert.strictEqual(convertNumber('0.001', { hideNumbers: true }), 'n__0_001');

        const simpleResult = kifToTPTP('(instance John Person)');
        assert.ok(simpleResult.includes('s__instance'));
        assert.ok(simpleResult.includes('s__John'));
        assert.ok(simpleResult.includes('s__Person'));

        console.log('Basic sanity checks passed!');
        console.log('Run full test suite with: npm test');
    } catch (e) {
        console.error('Test failed:', e.message);
        process.exit(1);
    }
}
