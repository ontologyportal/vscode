/**
 * Tests for SUMO Parser
 */

const { expect } = require('chai');
const {
    NodeType, ASTNode, ASTListNode, ASTTermNode, TokenList, ParsingError
} = require('../../src/parser/parser');
const { tokenize, TokenType } = require('../../src/parser/tokenizer');

describe('Parser', function() {
    describe('NodeType', function() {
        it('should have all expected node types', function() {
            expect(NodeType.LIST).to.equal('list');
            expect(NodeType.ATOM).to.equal('atom');
            expect(NodeType.STRING).to.equal('string');
            expect(NodeType.NUMBER).to.equal('number');
            expect(NodeType.VARIABLE).to.equal('variable');
            expect(NodeType.ROW_VARIABLE).to.equal('row_variable');
        });
    });

    describe('ParsingError', function() {
        it('should create error with all properties', function() {
            const error = new ParsingError('test.kif', 10, 5, 'Test error', 'some range');
            expect(error.file).to.equal('test.kif');
            expect(error.line).to.equal(10);
            expect(error.column).to.equal(5);
            expect(error.error).to.equal('Test error');
            expect(error.range).to.equal('some range');
            expect(error.name).to.equal('ParsingError');
        });

        it('should create error without file', function() {
            const error = new ParsingError(undefined, 1, 1, 'Test error');
            expect(error.file).to.be.undefined;
            expect(error.message).to.include('1:1');
        });

        it('should include file in message when provided', function() {
            const error = new ParsingError('test.kif', 1, 1, 'Test error');
            expect(error.message).to.include('test.kif');
        });

        it('should be instanceof Error', function() {
            expect(new ParsingError('f', 0, 0, 'e')).to.be.instanceof(Error);
        });
    });

    describe('ASTNode', function() {
        it('should create node from token', function() {
            const tokens = tokenize('foo', 'test.kif');
            const node = new ASTNode(NodeType.ATOM, tokens[0]);
            expect(node.type).to.equal(NodeType.ATOM);
            expect(node.startToken).to.equal(tokens[0]);
            expect(node.start.line).to.equal(0);
            expect(node.start.col).to.equal(0);
            expect(node.file).to.equal('test.kif');
        });
    });

    describe('ASTListNode', function() {
        it('should create list node', function() {
            const tokens = tokenize('(foo)', 'test.kif');
            const node = new ASTListNode(tokens[0]);
            expect(node.type).to.equal(NodeType.LIST);
            expect(node.children).to.be.an('array').that.is.empty;
            expect(node.endToken).to.be.null;
            expect(node.end).to.be.null;
        });

        it('should set end token and position correctly', function() {
            const tokens = tokenize('(foo)', 'test.kif');
            const node = new ASTListNode(tokens[0]);
            node.setEnd(tokens[2]); // RPAREN token
            expect(node.endToken).to.equal(tokens[2]);
            expect(node.end).to.not.be.null;
            expect(node.end.offset).to.be.a('number').and.not.NaN;
        });

        it('should return head of list', function() {
            const tokens = tokenize('(foo bar)', 'test.kif');
            const node = new ASTListNode(tokens[0]);
            const childNode = new ASTNode(NodeType.ATOM, tokens[1]);
            node.children.push(childNode);
            expect(node.getHead()).to.equal(childNode);
        });

        it('should return null for empty list head', function() {
            const tokens = tokenize('()', 'test.kif');
            const node = new ASTListNode(tokens[0]);
            expect(node.getHead()).to.be.null;
        });
    });

    describe('ASTTermNode', function() {
        it('should create term node with valid type', function() {
            const tokens = tokenize('foo', 'test.kif');
            const node = new ASTTermNode(NodeType.ATOM, tokens[0]);
            expect(node.type).to.equal(NodeType.ATOM);
        });

        it('should throw for non-term node type', function() {
            const tokens = tokenize('foo', 'test.kif');
            expect(() => new ASTTermNode(NodeType.LIST, tokens[0])).to.throw('non-term node');
        });

        it('should return value via getValue()', function() {
            const tokens = tokenize('testValue', 'test.kif');
            const node = new ASTTermNode(NodeType.ATOM, tokens[0]);
            expect(node.getValue()).to.equal('testValue');
        });
    });

    describe('TokenList', function() {
        describe('constructor', function() {
            it('should initialize with tokens and cursor at 0', function() {
                const tokens = tokenize('foo bar', 'test.kif');
                const list = new TokenList(tokens);
                expect(list.tokens).to.equal(tokens);
                expect(list.current).to.equal(0);
            });

            it('should accept optional document parameter', function() {
                const tokens = tokenize('foo', 'test.kif');
                const list = new TokenList(tokens, 'source text');
                expect(list.document).to.equal('source text');
            });

            it('should leave document undefined when not provided', function() {
                const tokens = tokenize('foo', 'test.kif');
                const list = new TokenList(tokens);
                expect(list.document).to.be.undefined;
            });
        });

        describe('cursor()', function() {
            it('should return current token', function() {
                const tokens = tokenize('foo bar', 'test.kif');
                const list = new TokenList(tokens);
                expect(list.cursor()).to.equal(tokens[0]);
            });
        });

        describe('end()', function() {
            it('should return true when at end of tokens', function() {
                const tokens = tokenize('foo', 'test.kif');
                const list = new TokenList(tokens);
                list.current = tokens.length;
                expect(list.end()).to.be.true;
            });

            it('should return false when not at end', function() {
                const tokens = tokenize('foo bar', 'test.kif');
                const list = new TokenList(tokens);
                expect(list.end()).to.be.false;
            });
        });

        describe('walk()', function() {
            it('should throw when called on empty token list', function() {
                const list = new TokenList([]);
                expect(() => list.walk()).to.throw('Called walk on an empty token list');
            });
        });
    });

    describe('Parsing Integration', function() {
        describe('parse simple expressions', function() {
            it('should parse a single atom', function() {
                const tokens = tokenize('foo', 'test.kif');
                const list = new TokenList(tokens);
                const nodes = list.parse();
                expect(nodes).to.have.lengthOf(1);
                expect(nodes[0].type).to.equal(NodeType.ATOM);
            });

            it('should parse an empty list', function() {
                const tokens = tokenize('()', 'test.kif');
                const list = new TokenList(tokens);
                const nodes = list.parse();
                expect(nodes).to.have.lengthOf(1);
                expect(nodes[0].type).to.equal(NodeType.LIST);
                expect(nodes[0].children).to.have.lengthOf(0);
            });

            it('should parse a simple list', function() {
                const tokens = tokenize('(foo bar)', 'test.kif');
                const list = new TokenList(tokens);
                const nodes = list.parse();
                expect(nodes).to.have.lengthOf(1);
                expect(nodes[0].type).to.equal(NodeType.LIST);
                expect(nodes[0].children).to.have.lengthOf(2);
            });

            it('should parse nested lists', function() {
                const tokens = tokenize('(foo (bar baz))', 'test.kif');
                const list = new TokenList(tokens);
                const nodes = list.parse();
                expect(nodes).to.have.lengthOf(1);
                expect(nodes[0].type).to.equal(NodeType.LIST);
                expect(nodes[0].children).to.have.lengthOf(2);
                expect(nodes[0].children[1].type).to.equal(NodeType.LIST);
            });

            it('should parse multiple top-level expressions', function() {
                const tokens = tokenize('(foo)(bar)', 'test.kif');
                const list = new TokenList(tokens);
                const nodes = list.parse();
                expect(nodes).to.have.lengthOf(2);
            });
        });

        describe('error handling', function() {
            it('should throw ParsingError on unclosed parenthesis', function() {
                const tokens = tokenize('(foo bar', 'test.kif');
                const list = new TokenList(tokens);
                expect(() => list.parse()).to.throw(ParsingError);
            });

            it('should throw ParsingError on dangling right parenthesis', function() {
                const tokens = tokenize(')', 'test.kif');
                const list = new TokenList(tokens);
                expect(() => list.parse()).to.throw(ParsingError);
            });
        });
    });
});
