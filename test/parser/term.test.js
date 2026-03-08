/**
 * Tests for Term and TaxonomyEdge (term.js)
 */

const { expect } = require('chai');
const { Term, TaxonomyEdge, SemanticError } = require('../../src/parser/term');
const { syntax } = require('../../src/parser/symbol');
const { tokenize } = require('../../src/parser/tokenizer');
const { TokenList } = require('../../src/parser/parser');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parse(text, symbolTable = undefined) {
    const { tokens } = tokenize(text, 'test.kif');
    const { nodes } = new TokenList(tokens).parse();
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
 * Get or create a Term for the named symbol in the given SymbolTable.
 */
function term(symbolTable, name) {
    const sym = symbolTable.symbols[name];
    if (!sym) throw new Error(`Symbol '${name}' not found in symbol table`);
    return new Term(sym);
}

// ---------------------------------------------------------------------------

describe('Term', function() {
    // -----------------------------------------------------------------------
    describe('constructor / name', function() {
        it('should store the symbol and expose its name', function() {
            const st = kb('(instance Human Animal)');
            const t = term(st, 'Human');
            expect(t.name).to.equal('Human');
            expect(t.symbol).to.equal(st.symbols['Human']);
        });

        it('should register itself as the forward reference to the symbol', function() {
            const st = kb('(instance Human Animal)');
            const sym = st.symbols['Human'];
            const t = new Term(sym);
            expect(sym.forward).to.equal(t);
        });

        it('should start with a null epoch and empty cache', function() {
            const st = kb('(instance Human Animal)');
            const t = term(st, 'Human');
            // After first property access the cache is populated — test that
            // the Term starts clean by checking _epoch is null before any access.
            const fresh = new Term(st.symbols['Animal']);
            expect(fresh._epoch).to.equal(null);
        });
    });

    // -----------------------------------------------------------------------
    describe('documentation', function() {
        it('should return empty array when no documentation sentence exists', function() {
            const st = kb('(instance Human Animal)');
            const t = term(st, 'Human');
            expect(t.documentation).to.deep.equal([]);
        });

        it('should return one entry for a single documentation sentence', function() {
            const st = kb('(documentation Human EnglishLanguage "A human being")');
            const t = term(st, 'Human');
            expect(t.documentation).to.deep.equal([
                { language: 'EnglishLanguage', text: 'A human being' }
            ]);
        });

        it('should return multiple entries for multiple languages', function() {
            const st = kb(
                '(documentation Human EnglishLanguage "A human being")',
                '(documentation Human GermanLanguage "Ein Mensch")'
            );
            const t = term(st, 'Human');
            expect(t.documentation).to.have.lengthOf(2);
            const langs = t.documentation.map(d => d.language);
            expect(langs).to.include('EnglishLanguage');
            expect(langs).to.include('GermanLanguage');
        });

        it('should cache the result (same array reference on repeated calls)', function() {
            const st = kb('(documentation Human EnglishLanguage "A human being")');
            const t = term(st, 'Human');
            expect(t.documentation).to.equal(t.documentation);
        });
    });

    // -----------------------------------------------------------------------
    describe('format', function() {
        it('should return empty array when no format sentence exists', function() {
            const st = kb('(instance Human Animal)');
            const t = term(st, 'instance');
            expect(t.format).to.deep.equal([]);
        });

        it('should return a format entry', function() {
            const st = kb('(format EnglishLanguage instance "%1 is an instance of %2")');
            const t = term(st, 'instance');
            expect(t.format).to.deep.equal([
                { language: 'EnglishLanguage', text: '%1 is an instance of %2' }
            ]);
        });

        it('should return multiple entries for multiple languages', function() {
            const st = kb(
                '(format EnglishLanguage loves "%1 loves %2")',
                '(format GermanLanguage loves "%1 liebt %2")'
            );
            const t = term(st, 'loves');
            expect(t.format).to.have.lengthOf(2);
        });

        it('should cache the result', function() {
            const st = kb('(format EnglishLanguage instance "%1 is an instance of %2")');
            const t = term(st, 'instance');
            expect(t.format).to.equal(t.format);
        });
    });

    // -----------------------------------------------------------------------
    describe('termFormat', function() {
        it('should return empty array when no termFormat sentence exists', function() {
            const st = kb('(instance Human Animal)');
            const t = term(st, 'Human');
            expect(t.termFormat).to.deep.equal([]);
        });

        it('should return a termFormat entry', function() {
            const st = kb('(termFormat EnglishLanguage Human "human")');
            const t = term(st, 'Human');
            expect(t.termFormat).to.deep.equal([
                { language: 'EnglishLanguage', text: 'human' }
            ]);
        });

        it('should cache the result', function() {
            const st = kb('(termFormat EnglishLanguage Human "human")');
            const t = term(st, 'Human');
            expect(t.termFormat).to.equal(t.termFormat);
        });
    });

    // -----------------------------------------------------------------------
    describe('taxonomy', function() {
        it('should return empty incoming and outgoing for an unreferenced term', function() {
            const st = kb('(instance Human Animal)');
            // 'instance' predicate has no taxonomy edges
            const t = term(st, 'instance');
            expect(t.taxonomy.incoming).to.deep.equal([]);
            expect(t.taxonomy.outgoing).to.deep.equal([]);
        });

        it('should populate incoming edge for the first arg of a subclass sentence', function() {
            // (subclass Human Animal) → Human is the destination (incoming), Animal is the source (outgoing)
            const st = kb('(subclass Human Animal)');
            const humanTerm = term(st, 'Human');
            const { incoming } = humanTerm.taxonomy;
            expect(incoming).to.have.lengthOf(1);
            expect(incoming[0]).to.be.instanceof(TaxonomyEdge);
            expect(incoming[0].relation).to.equal('subclass');
            expect(incoming[0].to.name).to.equal('Human');
            expect(incoming[0].from.name).to.equal('Animal');
        });

        it('should populate outgoing edge for the second arg of a subclass sentence', function() {
            const st = kb('(subclass Human Animal)');
            const animalTerm = term(st, 'Animal');
            const { outgoing } = animalTerm.taxonomy;
            expect(outgoing).to.have.lengthOf(1);
            expect(outgoing[0].relation).to.equal('subclass');
            expect(outgoing[0].to.name).to.equal('Human');
            expect(outgoing[0].from.name).to.equal('Animal');
        });

        it('should recognise all four taxonomy relations', function() {
            const st = kb(
                '(subclass Human Animal)',
                '(instance Socrates Human)',
                '(subAttribute Foo Bar)',
                '(subrelation loves relates)'
            );
            expect(term(st, 'Human').taxonomy.incoming).to.have.lengthOf(1);
            expect(term(st, 'Socrates').taxonomy.incoming).to.have.lengthOf(1);
            expect(term(st, 'Foo').taxonomy.incoming).to.have.lengthOf(1);
            expect(term(st, 'loves').taxonomy.incoming).to.have.lengthOf(1);
        });

        it('should accumulate multiple incoming edges', function() {
            const st = kb(
                '(subclass Dog Animal)',
                '(subclass Cat Animal)'
            );
            const animalTerm = term(st, 'Animal');
            expect(animalTerm.taxonomy.outgoing).to.have.lengthOf(2);
        });

        it('should cache the result', function() {
            const st = kb('(subclass Human Animal)');
            const t = term(st, 'Human');
            expect(t.taxonomy).to.equal(t.taxonomy);
        });
    });

    // -----------------------------------------------------------------------
    describe('isInstance', function() {
        it('should be true when the term has an incoming instance edge', function() {
            const st = kb('(instance Socrates Human)');
            expect(term(st, 'Socrates').isInstance).to.be.true;
        });

        it('should be false when the term only has subclass edges', function() {
            const st = kb('(subclass Human Animal)');
            expect(term(st, 'Human').isInstance).to.be.false;
        });

        it('should be false when the term has no taxonomy edges at all', function() {
            const st = kb('(instance Human Animal)');
            expect(term(st, 'instance').isInstance).to.be.false;
        });
    });

    // -----------------------------------------------------------------------
    describe('isClass', function() {
        it('should be true when every incoming edge is a subclass edge', function() {
            const st = kb('(subclass Human Animal)');
            expect(term(st, 'Human').isClass).to.be.true;
        });

        it('should be false when the term has an incoming instance edge', function() {
            const st = kb('(instance Socrates Human)');
            expect(term(st, 'Socrates').isClass).to.be.false;
        });

        it('should be true when the term has no incoming edges', function() {
            const st = kb('(subclass Human Animal)');
            expect(term(st, 'Animal').isClass).to.be.true;
        });

        it('should be false when a term mixes instance and subclass edges', function() {
            // A term is simultaneously subclassed AND instanced — not purely a class
            const st = kb(
                '(subclass Foo Bar)',
                '(instance Foo Baz)'
            );
            expect(term(st, 'Foo').isClass).to.be.false;
        });
    });

    // -----------------------------------------------------------------------
    describe('hasAncestor', function() {
        it('should return true for a direct parent', function() {
            const st = kb('(subclass Human Animal)');
            expect(term(st, 'Human').hasAncestor('Animal')).to.be.true;
        });

        it('should return true for a transitive ancestor', function() {
            const st = kb(
                '(subclass Human Animal)',
                '(subclass Animal LivingThing)'
            );
            expect(term(st, 'Human').hasAncestor('LivingThing')).to.be.true;
        });

        it('should return false when name is not in the ancestry', function() {
            const st = kb('(subclass Human Animal)');
            expect(term(st, 'Human').hasAncestor('Mineral')).to.be.false;
        });

        it('should be cycle-safe (no infinite loop, correct reachability)', function() {
            // (subclass A B) and (subclass B A) creates a cycle.
            // A is reachable from A via the path A→B→A, so hasAncestor('A') is true.
            // The visited-set prevents infinite recursion; the function still terminates.
            const st = kb(
                '(subclass A B)',
                '(subclass B A)'
            );
            // Terminates without stack-overflow
            expect(() => term(st, 'A').hasAncestor('A')).to.not.throw();
            // A IS reachable from A via B
            expect(term(st, 'A').hasAncestor('A')).to.be.true;
            expect(term(st, 'A').hasAncestor('B')).to.be.true;
        });

        it('should follow instance edges as well as subclass edges', function() {
            const st = kb(
                '(instance loves BinaryPredicate)',
                '(subclass BinaryPredicate Predicate)'
            );
            // loves → BinaryPredicate (via instance), BinaryPredicate → Predicate (via subclass)
            expect(term(st, 'loves').hasAncestor('BinaryPredicate')).to.be.true;
            expect(term(st, 'loves').hasAncestor('Predicate')).to.be.true;
        });

        it('should return true if querying the same term against itself', function() {
            const st = kb(
                '(instance loves BinaryPredicate)',
                '(subclass BinaryPredicate Predicate)'
            );
            // loves → BinaryPredicate (via instance), BinaryPredicate → Predicate (via subclass)
            expect(term(st, 'loves').hasAncestor('loves')).to.be.true;
        });

        it('should work for multiple inheritance', function() {
            const st = kb(
                '(instance loves BinaryPredicate)',
                '(subclass BinaryPredicate Predicate)',
                '(subclass BinaryPredicate InheritablePredicate)',
                '(subclass InheritablePredicate InheritableRelation)',
                '(subclass InheritableRelation Relation)',
                '(subclass Predicate Relation)',
                '(subclass Predicate Abstract)',
                '(subclass Abstract Entity)',
            );
            // loves → BinaryPredicate (via instance), BinaryPredicate → Predicate (via subclass)
            expect(term(st, 'loves').hasAncestor('Entity')).to.be.true;
            expect(term(st, 'loves').hasAncestor('BinaryPredicate')).to.be.true;
            expect(term(st, 'loves').hasAncestor('InheritablePredicate')).to.be.true;
            expect(term(st, 'loves').hasAncestor('InheritableRelation')).to.be.true;
            expect(term(st, 'loves').hasAncestor('Relation')).to.be.true;
        });
    });

    // -----------------------------------------------------------------------
    describe('isRelation / isPredicate / isFunction / isAttribute', function() {
        // Build a minimal KB that mirrors the SUMO arity hierarchy
        let st;
        beforeEach(function() {
            st = kb(
                // taxonomy backbone
                '(subclass BinaryPredicate Predicate)',
                '(subclass Predicate Relation)',
                '(subclass BinaryFunction Function)',
                '(subclass Function Relation)',
                // attribute
                '(instance redness Attribute)',
                // predicate instance
                '(instance loves BinaryPredicate)',
                // function instance
                '(instance father BinaryFunction)',
                // bare relation (not predicate/function)
                '(instance relates Relation)'
            );
        });

        it('isPredicate should be true for a BinaryPredicate instance', function() {
            expect(term(st, 'loves').isPredicate).to.be.true;
        });

        it('isPredicate should be false for a Function instance', function() {
            expect(term(st, 'father').isPredicate).to.be.false;
        });

        it('isFunction should be true for a BinaryFunction instance', function() {
            expect(term(st, 'father').isFunction).to.be.true;
        });

        it('isFunction should be false for a Predicate instance', function() {
            expect(term(st, 'loves').isFunction).to.be.false;
        });

        it('isRelation should be true for both predicates and functions', function() {
            expect(term(st, 'loves').isRelation).to.be.true;
            expect(term(st, 'father').isRelation).to.be.true;
            expect(term(st, 'relates').isRelation).to.be.true;
        });

        it('isRelation should be false for a non-relation term', function() {
            expect(term(st, 'Predicate').isRelation).to.be.false;
        });

        it('isAttribute should be true for an Attribute instance', function() {
            expect(term(st, 'redness').isAttribute).to.be.true;
        });

        it('isAttribute should be false for a non-Attribute term', function() {
            expect(term(st, 'loves').isAttribute).to.be.false;
        });
    });

    // -----------------------------------------------------------------------
    describe('range', function() {
        let st;
        beforeEach(function() {
            st = kb(
                '(subclass Human Entity)',
                '(subclass UnaryFunction Function)',
                '(subclass Function Relation)',
                '(instance Father UnaryFunction)',
                '(range Father Human)'
            );
        });

        it('should return the range class name for a relation', function() {
            expect(term(st, 'Father').range).to.equal(st.symbols["Human"].forward);
        });

        it('should return null for a non-relation term', function() {
            const st2 = kb('(subclass Human Animal)');
            expect(term(st2, 'Human').range).to.equal(null);
        });

        it('should return the last range declaration when multiple exist', function() {
            const st2 = kb(
                '(subclass Human Entity)',
                '(subclass Person Entity)',
                '(subclass UnaryFunction Function)',
                '(subclass Function Relation)',
                '(instance Father UnaryFunction)',
                '(range Father Human)',
                '(range Father Person)'
            );
            // `at(-1)` picks the last sentence — implementation-defined, just check it returns one
            const FatherTerm = term(st2, 'Father');
            expect(FatherTerm.range).to.equal(st2.symbols["Person"].forward);
        });

        it('should cache the result', function() {
            expect(term(st, 'Father').range).to.equal(term(st, 'Father').range);
        });
    });

    // -----------------------------------------------------------------------
    describe('domain', function() {
        let st;
        beforeEach(function() {
            st = kb(
                '(subclass Human Entity)',
                '(subclass Dog Entity)',
                '(subclass BinaryPredicate Predicate)',
                '(subclass Predicate Relation)',
                '(instance loves BinaryPredicate)',
                '(domain loves 1 Human)',
                '(domain loves 2 Dog)'
            );
        });

        it('should return null for a non-relation term', function() {
            const st2 = kb('(subclass Human Animal)');
            expect(term(st2, 'Human').domain).to.equal(null);
        });

        it('should populate domain at the correct indices', function() {
            const d = term(st, 'loves').domain;
            expect(d).to.be.an('array');
            expect(d[0]).to.be.instanceof(Term);
            expect(d[0].name).to.equal('Human');
            expect(d[1]).to.be.instanceof(Term);
            expect(d[1].name).to.equal('Dog');
        });

        it('should cache the result', function() {
            const t = term(st, 'loves');
            expect(t.domain).to.equal(t.domain);
        });
    });

    // -----------------------------------------------------------------------
    describe('arity', function() {
        it('should return null for a non-relation term', function() {
            const st = kb('(subclass Human Animal)');
            expect(term(st, 'Human').arity).to.equal(null);
        });

        it('should return 2 for a BinaryRelation instance', function() {
            const st = kb(
                '(subclass BinaryRelation Relation)',
                '(instance loves BinaryRelation)'
            );
            expect(term(st, 'loves').arity).to.equal(2);
        });

        it('should return 3 for a TernaryRelation instance', function() {
            const st = kb(
                '(subclass TernaryRelation Relation)',
                '(instance between TernaryRelation)'
            );
            expect(term(st, 'between').arity).to.equal(3);
        });

        it('should return -1 for a VariableArityRelation instance', function() {
            const st = kb(
                '(subclass VariableArityRelation Relation)',
                '(instance listFn VariableArityRelation)'
            );
            expect(term(st, 'listFn').arity).to.equal(-1);
        });

        it('should resolve arity via transitive ancestry', function() {
            // BinaryPredicate is a subclass of BinaryRelation
            const st = kb(
                '(subclass BinaryPredicate BinaryRelation)',
                '(subclass BinaryRelation Relation)',
                '(instance loves BinaryPredicate)'
            );
            expect(term(st, 'loves').arity).to.equal(2);
        });

        it('should throw SemanticError for a relation with no arity class', function() {
            const st = kb(
                '(subclass Relation Entity)',
                '(instance loves Relation)'
            );
            expect(() => term(st, 'loves').arity).to.throw(SemanticError);
        });

        it('should cache the result', function() {
            const st = kb(
                '(subclass BinaryRelation Relation)',
                '(instance loves BinaryRelation)'
            );
            const t = term(st, 'loves');
            expect(t.arity).to.equal(t.arity);
        });
    });

    // -----------------------------------------------------------------------
    describe('locations', function() {
        it('first — should find sentences where this term is the first argument', function() {
            const st = kb('(instance Human Animal)');
            const t = term(st, 'Human');
            const { first } = t.locations;
            expect(first).to.be.instanceof(Set);
            expect(first.size).to.equal(1);
            const [s] = first;
            expect(s.terms[1].name).to.equal('Human');
        });

        it('second — should find sentences where this term is the second argument', function() {
            const st = kb('(instance Human Animal)');
            const t = term(st, 'Animal');
            const { second } = t.locations;
            expect(second).to.be.instanceof(Set);
            expect(second.size).to.equal(1);
            const [s] = second;
            expect(s.terms[2].name).to.equal('Animal');
        });

        it('first should not include sentences where the term appears only as second arg', function() {
            const st = kb(
                '(subclass Human Animal)',  // Human at first, Animal at second
                '(instance Socrates Human)' // Human at second
            );
            const t = term(st, 'Human');
            // first: Human is terms[1] — only in (subclass Human Animal)
            expect(t.locations.first.size).to.equal(1);
        });

        it('antecedent — should find => sentences where this term appears in the antecedent', function() {
            // (=> (instance Human Animal) (other thing)) — Human is inside the antecedent sentence
            const st = kb('(=> (instance Human Animal) (other thing))');
            const t = term(st, 'Human');
            expect(t.locations.antecedent).to.be.instanceof(Set);
            expect(t.locations.antecedent.size).to.equal(1);
        });

        it('antecedent — should not match when the term is only in the consequent', function() {
            const st = kb('(=> (other thing) (instance Human Animal))');
            const t = term(st, 'Human');
            expect(t.locations.antecedent.size).to.equal(0);
        });

        it('antecedent — should match when the term is deeply nested in the antecedent', function() {
            // (=> (and (instance Human Animal) (other B)) (consequent))
            // Human is nested inside (and ...) which is the antecedent
            const st = kb('(=> (and (instance Human Animal) (other B)) (consequent))');
            const t = term(st, 'Human');
            expect(t.locations.antecedent.size).to.equal(1);
        });

        it('consequent — should find => sentences where this term appears in the consequent', function() {
            // (=> (other thing) (instance Human Animal)) — Human is inside the consequent
            const st = kb('(=> (other thing) (instance Human Animal))');
            const t = term(st, 'Human');
            expect(t.locations.consequent).to.be.instanceof(Set);
            expect(t.locations.consequent.size).to.equal(1);
        });

        it('consequent — should not match when the term is only in the antecedent', function() {
            const st = kb('(=> (instance Human Animal) (other thing))');
            const t = term(st, 'Human');
            expect(t.locations.consequent.size).to.equal(0);
        });

        it('consequent — should match when the term is deeply nested in the consequent', function() {
            const st = kb('(=> (antecedent) (and (instance Human Animal) (other B)))');
            const t = term(st, 'Human');
            expect(t.locations.consequent.size).to.equal(1);
        });

        it('should cache locations result', function() {
            const st = kb('(instance Human Animal)');
            const t = term(st, 'Human');
            expect(t.locations).to.equal(t.locations);
        });
    });

    // -----------------------------------------------------------------------
    describe('cache invalidation', function() {
        it('should rebuild the cache after the symbol table epoch changes', function() {
            // Accessing epoch "opens the box", subsequent writes bump it
            const st = kb('(documentation Human EnglishLanguage "First")');
            const t = term(st, 'Human');

            // Prime the cache
            const first = t.documentation;
            expect(first).to.have.lengthOf(1);

            // Add a new sentence to bump the epoch
            parse('(documentation Human GermanLanguage "Zweite")', st);

            // Cache must be rebuilt on next access
            const second = t.documentation;
            expect(second).to.have.lengthOf(2);
            // References differ — cache was invalidated
            expect(second).to.not.equal(first);
        });
    });
});
