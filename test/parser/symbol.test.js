/**
 * Tests for SUMO Symbol Analysis (symbol.js)
 */

const { expect } = require('chai');
const { syntax } = require('../../src/parser/symbol');
const { tokenize } = require('../../src/parser/tokenizer');
const { TokenList } = require('../../src/parser/parser');

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

describe('Symbol Analysis', function() {

    // -------------------------------------------------------------------------
    describe('SyntaxError', function() {
        it('should appear as Error instances in the errors array', function() {
            const { errors } = parse('()');
            expect(errors).to.have.lengthOf(1);
            expect(errors[0]).to.be.instanceof(Error);
            expect(errors[0].name).to.equal('SyntaxError');
        });

        it('should carry file, lineStart, colStart, lineEnd, colEnd', function() {
            const { errors } = parse('()');
            const err = errors[0];
            expect(err.file).to.equal('test.kif');
            expect(err.lineStart).to.be.a('number');
            expect(err.colStart).to.be.a('number');
            expect(err.lineEnd).to.be.a('number');
            expect(err.colEnd).to.be.a('number');
        });

        it('should carry a human-readable details string', function() {
            const { errors } = parse('()');
            expect(errors[0].details).to.be.a('string').and.not.empty;
        });

        it('should format the message with file and "Syntax Error"', function() {
            const { errors } = parse('()');
            expect(errors[0].message).to.include('test.kif');
            expect(errors[0].message).to.include('Syntax Error');
        });
    });

    // -------------------------------------------------------------------------
    describe('syntax() return shape', function() {
        it('should return an object with syntax, errors, and symbolTable', function() {
            const result = parse('(instance ?X Human)');
            expect(result).to.have.all.keys('syntax', 'errors', 'symbolTable');
        });

        it('should return empty arrays for empty input', function() {
            const { syntax: sentences, errors } = parse('');
            expect(sentences).to.be.an('array').that.is.empty;
            expect(errors).to.be.an('array').that.is.empty;
        });

        it('should return a symbolTable with a symbols map', function() {
            const { symbolTable } = parse('(instance ?X Human)');
            expect(symbolTable.symbols).to.be.an('object');
        });
    });

    // -------------------------------------------------------------------------
    describe('functional sentences', function() {
        it('should parse a simple functional sentence without errors', function() {
            const { syntax: sentences, errors } = parse('(instance ?X Human)');
            expect(errors).to.be.empty;
            expect(sentences).to.have.lengthOf(1);
        });

        it('should expose the head symbol as functionalTerm', function() {
            const { syntax: sentences } = parse('(instance ?X Human)');
            expect(sentences[0].functionalTerm).to.not.be.null;
            expect(sentences[0].functionalTerm.name).to.equal('instance');
        });

        it('should place arguments (not the head) into terms', function() {
            const { syntax: sentences } = parse('(instance ?X Human)');
            // terms = [VariableSym(?X), Symbol(Human)]; head is stored separately
            expect(sentences[0].terms).to.have.lengthOf(2);
        });

        it('should parse a nullary call (head with no arguments)', function() {
            const { syntax: sentences, errors } = parse('(foo)');
            expect(errors).to.be.empty;
            expect(sentences[0].functionalTerm.name).to.equal('foo');
            expect(sentences[0].terms).to.have.lengthOf(0);
        });

        it('should parse nested functional sentences', function() {
            const { syntax: sentences, errors } = parse('(instance (FunctionFn ?X) Human)');
            expect(errors).to.be.empty;
            // outer terms: [(FunctionFn ?X) sentence, Symbol(Human)]
            expect(sentences[0].terms).to.have.lengthOf(2);
        });

        it('should set parent to null for top-level sentences', function() {
            const { syntax: sentences } = parse('(instance ?X Human)');
            expect(sentences[0].parent).to.be.null;
        });

        it('should preserve a reference to the originating AST node', function() {
            const { syntax: sentences } = parse('(instance ?X Human)');
            expect(sentences[0].node).to.not.be.null;
        });
    });

    // -------------------------------------------------------------------------
    describe('operator sentences', function() {
        describe('and', function() {
            it('should parse (and A B) with two child terms', function() {
                const { syntax: sentences, errors } = parse(
                    '(and (instance ?X Human) (instance ?X Animal))'
                );
                expect(errors).to.be.empty;
                expect(sentences[0].terms).to.have.lengthOf(2);
            });

            it('should allow more than two children (variadic)', function() {
                const { syntax: sentences, errors } = parse(
                    '(and (instance ?X Human) (instance ?X Animal) (instance ?X Mammal))'
                );
                expect(errors).to.be.empty;
                expect(sentences[0].terms).to.have.lengthOf(3);
            });
        });

        describe('or', function() {
            it('should parse (or A B) with two child terms', function() {
                const { syntax: sentences, errors } = parse(
                    '(or (instance ?X Human) (instance ?X Animal))'
                );
                expect(errors).to.be.empty;
                expect(sentences[0].terms).to.have.lengthOf(2);
            });

            it('should allow more than two children (variadic)', function() {
                const { syntax: sentences, errors } = parse(
                    '(or (instance ?X A) (instance ?X B) (instance ?X C))'
                );
                expect(errors).to.be.empty;
                expect(sentences[0].terms).to.have.lengthOf(3);
            });
        });

        describe('not', function() {
            it('should parse (not A) with one child term', function() {
                const { syntax: sentences, errors } = parse('(not (instance ?X Human))');
                expect(errors).to.be.empty;
                expect(sentences[0].terms).to.have.lengthOf(1);
            });

            it('should error when not has more than one argument', function() {
                const { errors } = parse(
                    '(not (instance ?X Human) (instance ?X Animal))'
                );
                expect(errors).to.have.lengthOf(1);
            });
        });

        describe('=>', function() {
            it('should parse (=> antecedent consequent)', function() {
                const { syntax: sentences, errors } = parse(
                    '(=> (instance ?X Human) (instance ?X Animal))'
                );
                expect(errors).to.be.empty;
                expect(sentences[0].terms).to.have.lengthOf(2);
            });

            it('should error with more than two arguments', function() {
                const { errors } = parse(
                    '(=> (instance ?X A) (instance ?X B) (instance ?X C))'
                );
                expect(errors).to.have.lengthOf(1);
            });
        });

        describe('<=>', function() {
            it('should parse (<=> left right)', function() {
                const { syntax: sentences, errors } = parse(
                    '(<=> (instance ?X Human) (instance ?X Animal))'
                );
                expect(errors).to.be.empty;
                expect(sentences[0].terms).to.have.lengthOf(2);
            });

            it('should error with more than two arguments', function() {
                const { errors } = parse(
                    '(<=> (instance ?X A) (instance ?X B) (instance ?X C))'
                );
                expect(errors).to.have.lengthOf(1);
            });
        });

        describe('equal', function() {
            it('should parse (equal left right)', function() {
                const { syntax: sentences, errors } = parse('(equal ?X ?Y)');
                expect(errors).to.be.empty;
                expect(sentences[0].terms).to.have.lengthOf(2);
            });

            it('should error with more than two arguments', function() {
                const { errors } = parse('(equal ?X ?Y ?Z)');
                expect(errors).to.have.lengthOf(1);
            });
        });
    });

    // -------------------------------------------------------------------------
    describe('quantifier sentences', function() {
        describe('forall', function() {
            it('should parse (forall (?X) body) without errors', function() {
                const { syntax: sentences, errors } = parse(
                    '(forall (?X) (instance ?X Human))'
                );
                expect(errors).to.be.empty;
                expect(sentences).to.have.lengthOf(1);
            });

            it('should accept multiple variables in the variable list', function() {
                const { syntax: sentences, errors } = parse(
                    '(forall (?X ?Y) (equal ?X ?Y))'
                );
                expect(errors).to.be.empty;
                expect(sentences).to.have.lengthOf(1);
            });

            it('should error when variable list contains a non-variable', function() {
                const { errors } = parse(
                    '(forall (?X Human) (instance ?X Human))'
                );
                expect(errors).to.have.lengthOf(1);
            });

            it('should create a new scope containing the bound variables', function() {
                const { syntax: sentences } = parse(
                    '(forall (?X) (instance ?X Human))'
                );
                expect(sentences[0].scope).to.have.property('?X');
            });

            it('should error when given more than two arguments', function() {
                const { errors } = parse(
                    '(forall (?X) (instance ?X Human) (instance ?X Animal))'
                );
                expect(errors).to.have.lengthOf(1);
            });
        });

        describe('exists', function() {
            it('should parse (exists (?X) body) without errors', function() {
                const { syntax: sentences, errors } = parse(
                    '(exists (?X) (instance ?X Human))'
                );
                expect(errors).to.be.empty;
                expect(sentences).to.have.lengthOf(1);
            });

            it('should error when variable list contains a non-variable', function() {
                const { errors } = parse(
                    '(exists (?X Human) (instance ?X Human))'
                );
                expect(errors).to.have.lengthOf(1);
            });

            it('should create a new scope containing the bound variables', function() {
                const { syntax: sentences } = parse(
                    '(exists (?X) (instance ?X Human))'
                );
                expect(sentences[0].scope).to.have.property('?X');
            });
        });

        it('should handle nested quantifiers with independent scopes', function() {
            const { syntax: sentences, errors } = parse(
                '(forall (?X) (exists (?Y) (instance ?X ?Y)))'
            );
            expect(errors).to.be.empty;
            // Outer forall has ?X; the exists is a nested sentence
            expect(sentences[0].scope).to.have.property('?X');
        });
    });

    // -------------------------------------------------------------------------
    describe('symbol table', function() {
        it('should register atom symbols', function() {
            const { symbolTable } = parse('(instance ?X Human)');
            expect(symbolTable.symbols).to.have.property('instance');
            expect(symbolTable.symbols).to.have.property('Human');
        });

        it('should not register variables', function() {
            const { symbolTable } = parse('(instance ?X Human)');
            expect(symbolTable.symbols).to.not.have.property('?X');
        });

        it('should not register row variables', function() {
            const { symbolTable } = parse('(instance @ROW Human)');
            expect(symbolTable.symbols).to.not.have.property('@ROW');
        });

        it('should not register logical operators', function() {
            const { symbolTable } = parse(
                '(and (instance ?X Human) (instance ?X Animal))'
            );
            expect(symbolTable.symbols).to.not.have.property('and');
        });

        it('references is a Map keyed by file', function() {
            const { symbolTable } = parse('(instance ?X Human)');
            expect(symbolTable.symbols['Human'].references).to.be.instanceof(Map);
            expect(symbolTable.symbols['Human'].references.has('test.kif')).to.be.true;
        });

        it('should deduplicate a symbol used in multiple sentences', function() {
            const { symbolTable } = parse(
                '(instance ?X Human)(instance ?Y Human)'
            );
            // "Human" appears twice — one file, two entries in that file's array
            expect(Object.keys(symbolTable.symbols)).to.include('Human');
            const allRefs = [...symbolTable.symbols['Human'].references.values()].flat();
            expect(allRefs).to.have.lengthOf(2);
        });

        it('should record the correct reference count for a single use', function() {
            const { symbolTable } = parse('(instance ?X Human)');
            const allRefs = [...symbolTable.symbols['instance'].references.values()].flat();
            expect(allRefs).to.have.lengthOf(1);
        });

        it('should accumulate symbols when given an existing symbol table', function() {
            const first = parse('(instance ?X Human)');
            const second = parse('(instance ?Y Animal)', first.symbolTable);

            // Symbols from the first parse are still present
            expect(second.symbolTable.symbols).to.have.property('Human');
            // Symbols from the second parse have been added
            expect(second.symbolTable.symbols).to.have.property('Animal');
            // "instance" was used in both; should now have two references total
            const allRefs = [...second.symbolTable.symbols['instance'].references.values()].flat();
            expect(allRefs).to.have.lengthOf(2);
        });

        it('references within a file are in parse (line/column) order', function() {
            const { symbolTable } = parse(
                '(instance ?X Human)(subclass Human Animal)'
            );
            const refs = symbolTable.symbols['Human'].references.get('test.kif');
            expect(refs).to.have.lengthOf(2);
            const [, node0] = refs[0];
            const [, node1] = refs[1];
            const line0 = node0.startToken.line;
            const col0  = node0.startToken.column;
            const line1 = node1.startToken.line;
            const col1  = node1.startToken.column;
            expect(line0 < line1 || (line0 === line1 && col0 <= col1)).to.be.true;
        });

        it('removeFile strips all references from the given file', function() {
            const first  = parse('(instance ?X Human)', undefined);
            const second = parse('(subclass Human Animal)', first.symbolTable);
            const table  = second.symbolTable;

            expect(table.symbols).to.have.property('Human');
            table.removeFile('test.kif');
            // "Human" only existed in test.kif — it should be gone entirely
            expect(table.symbols).to.not.have.property('Human');
        });

        it('removeFile keeps symbols that still have references in other files', function() {
            // Parse the same symbol from two "files" by using distinct file names
            const { tokens: t1 } = require('../../src/parser/tokenizer').tokenize(
                '(instance ?X Human)', 'file-a.kif'
            );
            const { tokens: t2 } = require('../../src/parser/tokenizer').tokenize(
                '(subclass Human Animal)', 'file-b.kif'
            );
            const { TokenList } = require('../../src/parser/parser');
            const { syntax: syn } = require('../../src/parser/symbol');

            const nodes1 = new TokenList(t1).parse().nodes;
            const nodes2 = new TokenList(t2).parse().nodes;

            const { symbolTable } = syn(nodes1);
            syn(nodes2, symbolTable);

            // Human has refs in both files
            expect(symbolTable.symbols['Human'].references.size).to.equal(2);

            symbolTable.removeFile('file-a.kif');

            // Human still exists because file-b.kif still references it
            expect(symbolTable.symbols).to.have.property('Human');
            expect(symbolTable.symbols['Human'].references.size).to.equal(1);
        });
    });

    // -------------------------------------------------------------------------
    describe('variable scoping', function() {
        it('should resolve the same variable name to the same object within a scope', function() {
            const { syntax: sentences } = parse(
                '(and (instance ?X Human) (instance ?X Animal))'
            );
            // Both inner sentences share the parent `and` scope
            const inner1 = sentences[0].terms[0]; // FunctionalSentence for (instance ?X Human)
            const inner2 = sentences[0].terms[1]; // FunctionalSentence for (instance ?X Animal)
            // First argument of each is ?X — both should be the exact same VariableSym
            expect(inner1.terms[0]).to.equal(inner2.terms[0]);
        });

        it('should give each top-level quantifier its own scope object', function() {
            const { syntax: sentences, errors } = parse(
                '(forall (?X) (instance ?X Human))(forall (?X) (instance ?X Animal))'
            );
            expect(errors).to.be.empty;
            expect(sentences[0].scope).to.not.equal(sentences[1].scope);
        });

        it('should track row variables in the scope', function() {
            const { syntax: sentences, errors } = parse('(instance @ROW Human)');
            expect(errors).to.be.empty;
            expect(sentences[0].scope).to.have.property('@ROW');
        });

        it('should propagate parent scope into child sentences', function() {
            const { syntax: sentences } = parse(
                '(forall (?X) (instance ?X Human))'
            );
            // The body sentence is the second term of forall; its scope inherits ?X
            const body = sentences[0].terms[1]; // (instance ?X Human)
            expect(body.scope).to.have.property('?X');
        });
    });

    // -------------------------------------------------------------------------
    describe('error handling', function() {
        it('should error on an empty sentence ()', function() {
            const { errors } = parse('()');
            expect(errors).to.have.lengthOf(1);
        });

        it('should continue parsing valid sentences after an error', function() {
            const { syntax: sentences, errors } = parse('()(instance ?X Human)');
            expect(errors).to.have.lengthOf(1);
            expect(sentences).to.have.lengthOf(1);
        });

        it('should error on a bare atom at the outermost level', function() {
            const { errors } = parse('foo');
            expect(errors).to.have.lengthOf(1);
        });

        it('should collect multiple independent errors', function() {
            const { errors } = parse('()()(instance ?X Human)');
            expect(errors).to.have.lengthOf(2);
        });
    });

    // -------------------------------------------------------------------------
    describe('multiple top-level sentences', function() {
        it('should parse multiple sentences in one pass', function() {
            const { syntax: sentences, errors } = parse(
                '(instance ?X Human)(subclass Human Animal)'
            );
            expect(errors).to.be.empty;
            expect(sentences).to.have.lengthOf(2);
        });

        it('should give each top-level sentence a null parent', function() {
            const { syntax: sentences } = parse(
                '(instance ?X Human)(subclass Human Animal)'
            );
            expect(sentences[0].parent).to.be.null;
            expect(sentences[1].parent).to.be.null;
        });
    });
});
