const { expect } = require('chai');
const { syntax } = require('../../src/parser/symbol');
const { tokenize } = require('../../src/parser/tokenizer');
const { TokenList } = require('../../src/parser/parser');
const { lookupProxy } = require('../../src/parser/query');
const { Sentence } = require('../../src/parser/sentence');

/**
 * Run the full tokenize → parse → syntax pipeline on a KIF string.
 * @param {string} text
 * @param {object} [symbolTable] Optional pre-existing symbol table to accumulate into
 */
function parse(text, symbolTable = undefined) {
    const { tokens } = tokenize(text, 'test.kif');
    const list = new TokenList(tokens);
    const { nodes } = list.parse();
    return syntax(nodes, symbolTable);
}

/**
 * Parse one or more KIF strings, accumulating into one SymbolTable.
 * @param {...string} kifStrings
 */
function kb(...kifStrings) {
    let result;
    for (const kif of kifStrings) {
        result = parse(kif, result?.symbolTable);
    }
    return result.symbolTable;
}

/**
 * @param {Sentence[]} sentences 
 */
function getSyms(sentences) {
    /** @param {Element} el */
    function s(el) {
        if (el instanceof Sentence)
            return `(${el.terms.map(s).join(" ")})`
        return el.name;
    }
    return sentences.map(s);
}

describe("lookupProxy", function() {
    let symbolTable;
    afterEach(function () {
        symbolTable = undefined;
    });

    it("should return all sentences containing only one term with the query _", function() {
        symbolTable = kb(
            "(A)",
            "(A B C)",
            "(W)",
            "(rel X Y)",
            "(or B C)",
            "(FuncFn A)",
        );
        const results = symbolTable.lookup._.$;
        expect(results).to.have.length(2);
        expect([...results].map(r => r.terms[0].name)).to.have.members(["A", "W"]);
    });

    it("should return all sentences containing A somwhere in the sentence", function() {
        symbolTable = kb(
            "(A)",
            "(A B C)",
            "(W)",
            "(rel X Y)",
            "(or B C)",
            "(B B B B A)",
            "(FuncFn A)",
        );
        const results = symbolTable.lookup.$_.A._$;
        expect(getSyms([...results])).to.have.members([
            "(A)",
            "(A B C)",
            "(B B B B A)",
            "(FuncFn A)",
        ]);
    });

    it("should return all sentences containing A after an operator", function() {
        symbolTable = kb(
            "(not A)",
            "(A B C)",
            "(W)",
            "(rel X Y)",
            "(or B C)",
            "(and A B B B A)",
            "(FuncFn A)",
            "(exists (?A ?B) A)",
        );
        const results = symbolTable.lookup._OP_.$_.A._$;
        expect(getSyms([...results])).to.have.members([
            "(not A)",
            "(and A B B B A)",
            "(exists (?A ?B) A)",
        ]);
    });

    it("should return all sentences containing A after an operator", function() {
        symbolTable = kb(
            "(not A)",
            "(A B C)",
            "(W)",
            "(rel X Y)",
            "(or B C)",
            "(and A B B B A)",
            "(FuncFn A)",
            "(exists (?A ?B) A)",
        );
        const results = symbolTable.lookup._OP_.$_.A._$;
        expect(getSyms([...results])).to.have.members([
            "(not A)",
            "(and A B B B A)",
            "(exists (?A ?B) A)",
        ]);
    });

    describe('exact match ($)', function() {
        it('should return a Set', function() {
            const st = kb('(instance ?X Human)');
            const result = st.lookup.instance._._.$;
            expect(result).to.be.instanceof(Set);
        });

        it('should match a sentence by its predicate name', function() {
            const st = kb('(instance ?X Human)(subclass Human Animal)');
            const result = st.lookup.instance._._.$;
            expect(result.size).to.equal(1);
            const [s] = result;
            expect(s.terms[0].name).to.equal('instance');
        });

        it('should match subclass sentences', function() {
            const st = kb('(instance ?X Human)(subclass Human Animal)');
            expect(st.lookup.subclass._._.$).to.have.property('size', 1);
        });

        it('should return empty set when no sentence matches', function() {
            const st = kb('(instance ?X Human)');
            expect(st.lookup.subclass._._.$).to.have.property('size', 0);
        });

        it('should match multiple sentences with the same predicate', function() {
            const st = kb(
                '(instance ?X Human)',
                '(instance ?Y Animal)'
            );
            expect(st.lookup.instance._._.$).to.have.property('size', 2);
        });

        it('should not match a sentence with a different term count', function() {
            // (documentation T L "text") has 4 terms; exact query with 3 should miss it
            const st = kb('(documentation Human EnglishLanguage "text")');
            expect(st.lookup.documentation._._.$).to.have.property('size', 0);
        });

        it('should match a 4-term sentence exactly', function() {
            const st = kb('(documentation Human EnglishLanguage "text")');
            const result = st.lookup.documentation._._._.$;
            expect(result.size).to.equal(1);
        });
    });

    // --- at-least match (_$) ---
    describe('at-least match (_$)', function() {
        it('should match sentences with the queried terms plus more', function() {
            const st = kb('(documentation Human EnglishLanguage "text")');
            // Query covers 3 terms; sentence has 4 — _$ accepts the extra
            const result = st.lookup.documentation._._._$;
            expect(result.size).to.equal(1);
        });

        it('should match both short and long sentences', function() {
            const st = kb(
                '(instance ?X Human)',          // 3 terms
                '(documentation Human EnglishLanguage "text")' // 4 terms
            );
            // Any sentence whose first term is a symbol, with at least 1 more
            const result = st.lookup._SYM_._$;
            expect(result.size).to.equal(2);
        });
    });

    // --- _SYM_ wildcard ---
    describe('_SYM_ wildcard', function() {
        it('should match any term that is a Symbol', function() {
            const st = kb('(instance ?X Human)(subclass Human Animal)');
            // (subclass Human Animal): all three terms are symbols
            const result = st.lookup._SYM_._SYM_._SYM_.$;
            expect(result.size).to.equal(1);
            const [s] = result;
            expect(s.terms[0].name).to.equal('subclass');
        });

        it('should not match a term that is a variable', function() {
            const st = kb('(instance ?X Human)');
            // terms[1] is VariableSym(?X) — not a symbol
            const result = st.lookup._SYM_._SYM_._SYM_.$;
            expect(result.size).to.equal(0);
        });
    });

    // --- _VAR_ wildcard ---
    describe('_VAR_ wildcard', function() {
        it('should match a variable term', function() {
            const st = kb('(instance ?X Human)');
            const result = st.lookup._SYM_._VAR_._SYM_.$;
            expect(result.size).to.equal(1);
        });

        it('should not match when a symbol is expected to be a variable', function() {
            const st = kb('(subclass Human Animal)');
            const result = st.lookup._SYM_._VAR_._SYM_.$;
            expect(result.size).to.equal(0);
        });
    });

    // --- _LIT_ wildcard ---
    describe('_LIT_ wildcard', function() {
        it('should match a literal term', function() {
            const st = kb('(documentation Human EnglishLanguage "text")');
            const result = st.lookup._SYM_._SYM_._SYM_._LIT_.$;
            expect(result.size).to.equal(1);
        });

        it('should not match a symbol where a literal is expected', function() {
            const st = kb('(instance ?X Human)');
            const result = st.lookup._SYM_._LIT_._SYM_.$;
            expect(result.size).to.equal(0);
        });
    });

    // --- _L(value) function ---
    describe('_L(value) literal filter', function() {
        it('should match the specific literal value', function() {
            const st = kb('(documentation Human EnglishLanguage "hello")');
            const result = st.lookup.documentation._._._L('hello').$;
            expect(result.size).to.equal(1);
        });

        it('should not match a different literal value', function() {
            const st = kb('(documentation Human EnglishLanguage "hello")');
            const result = st.lookup.documentation._._._L('world').$;
            expect(result.size).to.equal(0);
        });
    });

    // --- _OP_ wildcard ---
    describe('_OP_ wildcard', function() {
        it('should match the operator term of an operator sentence', function() {
            const st = kb('(and (instance ?X Human) (instance ?X Animal))');
            // terms[0] is Operator(and)
            const result = st.lookup._OP_._._.$;
            expect(result.size).to.equal(1);
        });

        it('should not match a plain functional sentence', function() {
            const st = kb('(instance ?X Human)');
            const result = st.lookup._OP_._._.$;
            expect(result.size).to.equal(0);
        });
    });

    // --- _ANY(iterable) ---
    describe('_ANY(iterable)', function() {
        it('should match any symbol in a Set', function() {
            const st = kb(
                '(instance ?X Human)',
                '(subclass Human Animal)',
                '(documentation Human EnglishLanguage "text")'
            );
            const result = st.lookup._ANY('instance', 'subclass')._._.$;
            expect(result.size).to.equal(2);
        });

        it('should match any symbol in an Array', function() {
            const st = kb(
                '(instance ?X Human)',
                '(subclass Human Animal)'
            );
            const result = st.lookup._ANY('instance', 'subclass')._._.$;
            expect(result.size).to.equal(2);
        });

        it('should not match a symbol outside the iterable', function() {
            const st = kb('(documentation Human EnglishLanguage "text")');
            const result = st.lookup._ANY('instance', 'subclass')._._.$;
            expect(result.size).to.equal(0);
        });

        // --- function args ---
        it('should accept a function arg that returns a QueryFunction via l', function() {
            // _ANY('documentation', l => l._OP_) matches either the symbol
            // 'documentation' or any operator at position 0
            const st = kb(
                '(documentation Human EnglishLanguage "text")',
                '(and A B)'
            );
            const result = st.lookup._ANY('documentation', l => l._OP_)._$;
            expect(result.size).to.equal(2);
        });

        it('function arg via l should match a named symbol just like a string arg', function() {
            const st = kb(
                '(instance ?X Human)',
                '(subclass Human Animal)'
            );
            // l => l.instance resolves to compareSym('instance')
            const result = st.lookup._ANY(l => l.instance, 'subclass')._._.$;
            expect(result.size).to.equal(2);
        });

        it('function arg should not match unrelated terms', function() {
            const st = kb('(documentation Human EnglishLanguage "text")');
            // _OP_ only matches operators — 'documentation' is a plain symbol
            const result = st.lookup._ANY(l => l._OP_)._SYM_._SYM_._LIT_.$;
            expect(result.size).to.equal(0);
        });

        it('nested _ANY via l should resolve correctly', function() {
            // _ANY(l => l._ANY('instance', 'subclass')) behaves the same as _ANY('instance', 'subclass')
            const st = kb(
                '(instance ?X Human)',
                '(subclass Human Animal)',
                '(documentation Human EnglishLanguage "text")'
            );
            const result = st.lookup._ANY(l => l._ANY('instance', 'subclass'))._._.$;
            expect(result.size).to.equal(2);
        });

        it('l._L() should match a specific literal inside _ANY', function() {
            const st = kb(
                '(documentation Human EnglishLanguage "text")',
                '(documentation Human GermanLanguage "other")'
            );
            // match sentences where terms[3] is the literal "text"
            const result = st.lookup.documentation._SYM_._SYM_._ANY(l => l._L("text")).$;
            expect(result.size).to.equal(1);
        });

        it('l._OP() should match a specific operator inside _ANY', function() {
            const st = kb(
                '(=> Human Animal)',
                '(and A B)'
            );
            const result = st.lookup._ANY(l => l._OP("=>"))._$;
            expect(result.size).to.equal(1);
        });
    });

    // --- _S(fn) sentence matcher ---
    describe('_S sentence matcher', function() {
        it('_S should return a function', function() {
            // (forall (?X) (instance ?X Human)) has Sentence terms at positions 1 and 2
            const st = kb('(forall (?X) (instance ?X Human))');
            expect(st.lookup._OP_._S).to.be.a("function");
        });
        
        it('_S() with no args should match any Sentence term', function() {
            // (forall (?X) (instance ?X Human)) has Sentence terms at positions 1 and 2
            const st = kb('(forall (?X) (instance ?X Human))');
            const result = st.lookup._OP_._S()._$;
            expect(result.size).to.equal(1);
        });

        it('_S() should not match a Symbol term', function() {
            const st = kb('(instance Human Animal)');
            // terms[1] = Human (Symbol) — not a Sentence
            const result = st.lookup._SYM_._S()._$;
            expect(result.size).to.equal(0);
        });

        it('_S(l => ...) should match a Sentence term whose contents satisfy the query', function() {
            // (forall (?X) (instance ?X Human))
            // terms[2] = (instance ?X Human): _SYM_._VAR_._SYM_ matches it
            const st = kb('(forall (?X) (instance ?X Human))');
            const result = st.lookup._OP_._._S(l => l._SYM_._VAR_._SYM_._$).$;
            expect(result.size).to.equal(1);
        });

        it('_S(l => ...) should not match when the sub-sentence fails the inner query', function() {
            // (forall (?X) (instance ?X Human)) — terms[1] = (?X), a single-variable sentence
            // _SYM_._VAR_._SYM_ requires 3 terms starting with a symbol — (?X) has 1 term
            const st = kb('(forall (?X) (instance ?X Human))');
            const result = st.lookup._OP_._S(l => l._SYM_._VAR_._SYM_._$)._$;
            // terms[1] = (?X) — fails the inner query (only 1 var term, no leading symbol)
            expect(result.size).to.equal(0);
        });

        it('_S(l => ...) accessible via l inside _ANY', function() {
            // Matches root sentences where terms[1] is either "leaf" or a Sentence starting with "branch"
            const st = kb(
                '(root leaf)',          // terms[1] = leaf — matches "leaf"
                '(root (branch x))',    // terms[1] = (branch x) Sentence — _S matches
                '(root other)'          // terms[1] = other — no match
            );
            const result = st.lookup.root._ANY('leaf', l => l._S(l2 => l2.branch._._$)).$;
            expect(result.size).to.equal(2);
        });

        it('_S((l, q) => ...) should support recursive matching via the q self-reference', function() {
            // Recursive query: match a root sentence (wrapper X) where X is a
            // Sentence of the form (a Y) and Y is either "target" OR a Sentence
            // recursively matching the same (a ...) shape.
            //
            // (wrapper (a target))        — inner (a target): Y=target ✓ direct
            // (wrapper (a (a target)))     — inner (a (a target)): Y=(a target),
            //                               recursive check on (a target) ✓
            // (wrapper other)             — terms[1]=other is a Symbol, not Sentence ✗
            const st = kb(
                '(wrapper (a target))',
                '(wrapper (a (a target)))',
                '(wrapper other)'
            );
            const result = st.lookup.wrapper._S((l, q) => l.a._ANY(l2 => l2._S(q), 'target')._$)._$;
            expect(result.size).to.equal(2);
        });

        it('_S() can be used to support nested recurssive lookup', function () {
            const st = kb(
                '(=> A (rel A (rel (rel A Target) A)))',
                '(=> A (rel A (rel (rel A Bad) A)))',
            );
            function testFunc(l, r) {
                return l.$_._ANY(
                    "Target", 
                    l2 => l2._S(r)
                )._$
            }
            const result = st.lookup._OP("=>")._._S(
                testFunc
            )._$;
            expect(result.size).to.equal(1);
        })
    });

    // --- _N numeric wildcard ---
    describe('_N numeric wildcard', function() {
        it('_0 matches the term at exactly the current position', function() {
            // _0 generates 0 to 0 wildcard alternatives (only the 0-wildcard query)
            const st = kb('(instance ?X Human)');
            // lookup._0.instance matches 'instance' at position 0
            const result = st.lookup._0.instance._._.$;
            expect(result.size).to.equal(1);
        });

        it('_1 matches the term at position 0 or 1', function() {
            const st = kb(
                '(predicate instance ?X Human)',  // 'instance' at term[1]
                '(instance ?X Human)'             // 'instance' at term[0]
            );
            // _1 tries queries: [instance,_,_,_] and [_,instance,_,_]... length-enforced
            // For an exact $ match with _1: generates [instance,...] and [_,instance,...]
            // (predicate instance ?X Human) has 4 terms; (instance ?X Human) has 3
            // Both sentences will match one of the alternatives
            const result = st.lookup._1.instance._._.$;
            expect(result.size).to.equal(2);
        });
    });

    // --- $_.term._$ anywhere search ---
    describe('$_.term._$ anywhere search', function() {
        it('should match a sentence where the term is the predicate (position 0)', function() {
            // $_ now returns 0 when the next pattern matches at idx+0, and resolveQuery
            // treats 0 as success (consuming 0 terms), so position 0 is found correctly.
            const st = kb('(foo A B)');
            const result = st.lookup.$_.foo._$;
            expect(result.size).to.equal(1);
        });

        it('should match a sentence where the term is in the middle (position > 0)', function() {
            const st = kb('(instance foo Animal)');
            const result = st.lookup.$_.foo._$;
            expect(result.size).to.equal(1);
        });

        it('should match a sentence where the term is at the last position', function() {
            const st = kb('(instance Human foo)');
            const result = st.lookup.$_.foo._$;
            expect(result.size).to.equal(1);
        });

        it('should match multiple sentences that all contain the term', function() {
            const st = kb(
                '(instance foo Animal)',
                '(subclass foo Entity)',
                '(other bar baz)'
            );
            const result = st.lookup.$_.foo._$;
            expect(result.size).to.equal(2);
        });

        it('should not match sentences that do not contain the term', function() {
            const st = kb('(instance Human Animal)', '(subclass Dog Animal)');
            const result = st.lookup.$_.foo._$;
            expect(result.size).to.equal(0);
        });
    });

    // --- $query meta accessor ---
    describe('$query meta accessor', function() {
        it('should return the accumulated query array', function() {
            const st = kb('(instance ?X Human)');
            const q = st.lookup.instance._.$query;
            expect(q).to.be.an('array');
            expect(q).to.have.lengthOf(1);   // one query variant
            expect(q[0]).to.have.lengthOf(2); // two query functions: instance + _
        });
    });

});