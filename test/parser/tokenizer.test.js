/**
 * Tests for SUMO Tokenizer
 */

const { expect } = require('chai');
const { tokenize, TokenType, Token, TokenizerError } = require('../../src/parser/tokenizer');

describe('Tokenizer', function() {
    describe('tokenize()', function() {
        describe('basic tokens', function() {
            it('should tokenize left parenthesis', function() {
                const { tokens } = tokenize('(', 'test.kif');
                expect(tokens).to.have.lengthOf(1);
                expect(tokens[0].type).to.equal(TokenType.LPAREN);
                expect(tokens[0].value).to.equal('(');
            });

            it('should tokenize right parenthesis', function() {
                const { tokens } = tokenize(')', 'test.kif');
                expect(tokens).to.have.lengthOf(1);
                expect(tokens[0].type).to.equal(TokenType.RPAREN);
                expect(tokens[0].value).to.equal(')');
            });

            it('should tokenize matching parentheses', function() {
                const { tokens } = tokenize('()', 'test.kif');
                expect(tokens).to.have.lengthOf(2);
                expect(tokens[0].type).to.equal(TokenType.LPAREN);
                expect(tokens[1].type).to.equal(TokenType.RPAREN);
            });
        });

        describe('atoms', function() {
            it('should tokenize a simple atom', function() {
                const { tokens } = tokenize('foo', 'test.kif');
                expect(tokens).to.have.lengthOf(1);
                expect(tokens[0].type).to.equal(TokenType.ATOM);
                expect(tokens[0].value).to.equal('foo');
            });

            it('should tokenize an atom with uppercase letters', function() {
                const { tokens } = tokenize('FooBar', 'test.kif');
                expect(tokens).to.have.lengthOf(1);
                expect(tokens[0].type).to.equal(TokenType.ATOM);
                expect(tokens[0].value).to.equal('FooBar');
            });

            it('should tokenize an atom with hyphens', function() {
                const { tokens } = tokenize('foo-bar', 'test.kif');
                expect(tokens).to.have.lengthOf(1);
                expect(tokens[0].type).to.equal(TokenType.ATOM);
                expect(tokens[0].value).to.equal('foo-bar');
            });

            it('should tokenize an atom with underscores', function() {
                const { tokens } = tokenize('foo_bar', 'test.kif');
                expect(tokens).to.have.lengthOf(1);
                expect(tokens[0].type).to.equal(TokenType.ATOM);
                expect(tokens[0].value).to.equal('foo_bar');
            });
        });

        describe('numbers', function() {
            it('should tokenize positive integers', function() {
                const { tokens } = tokenize('42', 'test.kif');
                expect(tokens).to.have.lengthOf(1);
                expect(tokens[0].type).to.equal(TokenType.NUMBER);
                expect(tokens[0].value).to.equal('42');
            });

            it('should tokenize negative integers', function() {
                const { tokens } = tokenize('-42', 'test.kif');
                expect(tokens).to.have.lengthOf(1);
                expect(tokens[0].type).to.equal(TokenType.NUMBER);
                expect(tokens[0].value).to.equal('-42');
            });

            it('should tokenize decimal numbers', function() {
                const { tokens } = tokenize('3.14', 'test.kif');
                expect(tokens).to.have.lengthOf(1);
                expect(tokens[0].type).to.equal(TokenType.NUMBER);
                expect(tokens[0].value).to.equal('3.14');
            });

            it('should tokenize negative decimal numbers', function() {
                const { tokens } = tokenize('-3.14', 'test.kif');
                expect(tokens).to.have.lengthOf(1);
                expect(tokens[0].type).to.equal(TokenType.NUMBER);
                expect(tokens[0].value).to.equal('-3.14');
            });

            it('should tokenize numbers with exponents', function() {
                const { tokens } = tokenize('1e10', 'test.kif');
                expect(tokens).to.have.lengthOf(1);
                expect(tokens[0].type).to.equal(TokenType.NUMBER);
                expect(tokens[0].value).to.equal('1e10');
            });

            it('should tokenize numbers with negative exponents', function() {
                const { tokens } = tokenize('1e-10', 'test.kif');
                expect(tokens).to.have.lengthOf(1);
                expect(tokens[0].type).to.equal(TokenType.NUMBER);
                expect(tokens[0].value).to.equal('1e-10');
            });
        });

        describe('variables', function() {
            it('should tokenize a simple variable', function() {
                const { tokens } = tokenize('?x', 'test.kif');
                expect(tokens).to.have.lengthOf(1);
                expect(tokens[0].type).to.equal(TokenType.VARIABLE);
                expect(tokens[0].value).to.equal('?x');
            });

            it('should tokenize a variable with uppercase', function() {
                const { tokens } = tokenize('?Foo', 'test.kif');
                expect(tokens).to.have.lengthOf(1);
                expect(tokens[0].type).to.equal(TokenType.VARIABLE);
                expect(tokens[0].value).to.equal('?Foo');
            });

            it('should tokenize a row variable', function() {
                const { tokens } = tokenize('@ROW', 'test.kif');
                expect(tokens).to.have.lengthOf(1);
                expect(tokens[0].type).to.equal(TokenType.ROW_VARIABLE);
                expect(tokens[0].value).to.equal('@ROW');
            });
        });

        describe('strings', function() {
            it('should tokenize a simple string', function() {
                const { tokens } = tokenize('"hello"', 'test.kif');
                expect(tokens).to.have.lengthOf(1);
                expect(tokens[0].type).to.equal(TokenType.STRING);
                expect(tokens[0].value).to.equal('hello');
            });

            it('should tokenize a string with spaces', function() {
                const { tokens } = tokenize('"hello world"', 'test.kif');
                expect(tokens).to.have.lengthOf(1);
                expect(tokens[0].type).to.equal(TokenType.STRING);
                expect(tokens[0].value).to.equal('hello world');
            });
        });

        describe('comments', function() {
            it('should skip single-line comments', function() {
                const { tokens } = tokenize('; this is a comment', 'test.kif');
                expect(tokens).to.be.an('array').that.is.empty;
            });

            it('should tokenize code after comment line', function() {
                const { tokens } = tokenize('; comment\nfoo', 'test.kif');
                expect(tokens).to.have.lengthOf(1);
                expect(tokens[0].value).to.equal('foo');
                expect(tokens[0].type).to.equal(TokenType.ATOM);
            });
        });

        describe('whitespace handling', function() {
            it('should skip leading whitespace', function() {
                const { tokens } = tokenize('   foo', 'test.kif');
                expect(tokens).to.have.lengthOf(1);
                expect(tokens[0].type).to.equal(TokenType.ATOM);
            });

            it('should skip trailing whitespace', function() {
                const { tokens } = tokenize('foo   ', 'test.kif');
                expect(tokens).to.have.lengthOf(1);
                expect(tokens[0].type).to.equal(TokenType.ATOM);
            });

            it('should handle multiple tokens separated by whitespace', function() {
                const { tokens } = tokenize('foo bar baz', 'test.kif');
                expect(tokens).to.have.lengthOf(3);
                expect(tokens[0].value).to.equal('foo');
                expect(tokens[1].value).to.equal('bar');
                expect(tokens[2].value).to.equal('baz');
            });

            it('should handle tabs', function() {
                const { tokens } = tokenize('foo\tbar', 'test.kif');
                expect(tokens).to.have.lengthOf(2);
            });

            it('should handle newlines', function() {
                const { tokens } = tokenize('foo\nbar', 'test.kif');
                expect(tokens).to.have.lengthOf(2);
            });
        });

        describe('complex expressions', function() {
            it('should tokenize a simple S-expression', function() {
                const { tokens } = tokenize('(foo bar)', 'test.kif');
                expect(tokens).to.have.lengthOf(4);
                expect(tokens[0].type).to.equal(TokenType.LPAREN);
                expect(tokens[1].type).to.equal(TokenType.ATOM);
                expect(tokens[1].value).to.equal('foo');
                expect(tokens[2].type).to.equal(TokenType.ATOM);
                expect(tokens[2].value).to.equal('bar');
                expect(tokens[3].type).to.equal(TokenType.RPAREN);
            });

            it('should tokenize nested S-expressions', function() {
                const { tokens } = tokenize('(foo (bar baz))', 'test.kif');
                expect(tokens).to.have.lengthOf(7);
                expect(tokens[0].type).to.equal(TokenType.LPAREN);
                expect(tokens[1].value).to.equal('foo');
                expect(tokens[2].type).to.equal(TokenType.LPAREN);
                expect(tokens[3].value).to.equal('bar');
                expect(tokens[4].value).to.equal('baz');
                expect(tokens[5].type).to.equal(TokenType.RPAREN);
                expect(tokens[6].type).to.equal(TokenType.RPAREN);
            });

            it('should tokenize SUMO-style formula', function() {
                const { tokens } = tokenize('(instance ?X Human)', 'test.kif');
                expect(tokens).to.have.lengthOf(5);
                expect(tokens[0].type).to.equal(TokenType.LPAREN);
                expect(tokens[1].type).to.equal(TokenType.ATOM);
                expect(tokens[1].value).to.equal('instance');
                expect(tokens[2].type).to.equal(TokenType.VARIABLE);
                expect(tokens[2].value).to.equal('?X');
                expect(tokens[3].type).to.equal(TokenType.ATOM);
                expect(tokens[3].value).to.equal('Human');
                expect(tokens[4].type).to.equal(TokenType.RPAREN);
            });

            it('should tokenize formula with string', function() {
                const { tokens } = tokenize('(documentation Human "A human being")', 'test.kif');
                expect(tokens.length).to.be.greaterThan(3);
                const stringToken = tokens.find(t => t.type === TokenType.STRING);
                expect(stringToken).to.exist;
            });
        });

        describe('token position tracking', function() {
            it('should track line numbers correctly', function() {
                const { tokens } = tokenize('foo\nbar', 'test.kif');
                expect(tokens[0].line).to.equal(0);
                expect(tokens[1].line).to.equal(1);
            });

            it('should track column numbers correctly', function() {
                const { tokens } = tokenize('foo bar', 'test.kif');
                expect(tokens[0].column).to.equal(0);
                expect(tokens[1].column).to.equal(4);
            });

            it('should track file name', function() {
                const { tokens } = tokenize('foo', 'myfile.kif');
                expect(tokens[0].file).to.equal('myfile.kif');
            });
        });

        describe('error handling', function() {
            it('should collect TokenizerError for symbol starting with a digit', function() {
                const { errors } = tokenize('1abc', 'test.kif');
                expect(errors).to.have.lengthOf.at.least(1);
                expect(errors[0]).to.be.instanceof(TokenizerError);
            });

            it('should include correct file in TokenizerError', function() {
                const { errors } = tokenize('1abc', 'myfile.kif');
                expect(errors[0]).to.be.instanceof(TokenizerError);
                expect(errors[0].file).to.equal('myfile.kif');
            });

            it('should include position in TokenizerError message', function() {
                const { errors } = tokenize('1abc', 'test.kif');
                expect(errors[0].message).to.include('test.kif');
            });
        });
    });

    describe('Token class', function() {
        it('should create a token with all properties', function() {
            const token = new Token(TokenType.ATOM, 1, 5, 10, 'test', 'file.kif');
            expect(token.type).to.equal(TokenType.ATOM);
            expect(token.line).to.equal(1);
            expect(token.column).to.equal(5);
            expect(token.offset).to.equal(10);
            expect(token.value).to.equal('test');
            expect(token.file).to.equal('file.kif');
        });
    });

    describe('TokenizerError class', function() {
        it('should create error with all properties', function() {
            const err = new TokenizerError(5, 3, 'bad char', 'test.kif');
            expect(err.line).to.equal(5);
            expect(err.col).to.equal(3);
            expect(err.error).to.equal('bad char');
            expect(err.file).to.equal('test.kif');
            expect(err.name).to.equal('TokenizerError');
        });

        it('should include position in message', function() {
            const err = new TokenizerError(5, 3, 'bad char', 'test.kif');
            expect(err.message).to.include('test.kif');
            expect(err.message).to.include('5');
            expect(err.message).to.include('3');
        });

        it('should be instanceof Error', function() {
            const err = new TokenizerError(0, 0, 'err', 'f');
            expect(err).to.be.instanceof(Error);
        });
    });
});
