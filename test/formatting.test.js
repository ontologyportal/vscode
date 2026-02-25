/**
 * Tests for src/formatting.js (non-bug tests)
 */

'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

const { createVSCodeMock, createMockDocument } = require('./helpers/vscode-mock');

// ---------------------------------------------------------------------------
// Helper: load formatting module with mocked vscode and validation
// ---------------------------------------------------------------------------
function loadFormatting(configValues) {
    const vscode = createVSCodeMock(sinon);
    vscode._setConfig(configValues || {});

    // tokenize is re-exported from validation; wrap the real tokenizer to match
    // tokenizeValidation's interface: accepts {text, doc?, path?}, returns Token[]
    const rawTokenize = require('../src/parser/tokenizer').tokenize;
    const mockTokenize = (source) => rawTokenize(source.text || '', source.path).tokens;

    const mod = proxyquire('../src/formatting', {
        vscode,
        './validation': { tokenize: mockTokenize }
    });

    return { mod, vscode };
}

// ---------------------------------------------------------------------------
describe('formatting.js', function () {

    afterEach(() => sinon.restore());

    // -----------------------------------------------------------------------
    describe('formatSExpression - basic formatting', function () {

        it('returns unchanged text when no tokens', function () {
            const { mod } = loadFormatting();
            expect(mod.formatSExpression('')).to.equal('');
        });

        it('formats a simple binary relation onto one line', function () {
            const { mod } = loadFormatting();
            const result = mod.formatSExpression('(instance Foo Bar)');
            expect(result).to.equal('(instance Foo Bar)');
        });

        it('formats a nested expression with default indent (2 spaces)', function () {
            const { mod } = loadFormatting();
            const input = '(and (instance Foo Animal) (instance Foo Object))';
            const result = mod.formatSExpression(input);
            // Each nested expression should be indented by 2 spaces
            expect(result).to.match(/^ {2}\(instance/m);
        });

        it('preserves VARIABLE tokens in a forall quantifier', function () {
            const { mod } = loadFormatting();
            const input = '(forall (?X) (instance ?X Foo))';
            const result = mod.formatSExpression(input);
            expect(result).to.include('forall');
            expect(result).to.include('instance');
            expect(result).to.include('?X');
            expect(result).to.include('Foo');
        });

        it('keeps the quantifier variable list inline with the quantifier keyword', function () {
            const { mod } = loadFormatting();
            // Sigma style: "(forall (?X ?Y) body)" — variable list on same line as forall
            const input = '(forall (?X ?Y) (instance ?X Foo))';
            const result = mod.formatSExpression(input);
            // The variable list must appear on the same line as "forall"
            const forallLine = result.split('\n').find(l => l.includes('forall'));
            expect(forallLine).to.include('(?X ?Y)');
        });

        it('preserves NUMBER tokens', function () {
            const { mod } = loadFormatting();
            const input = '(domain knows 1 Agent)';
            const result = mod.formatSExpression(input);
            expect(result).to.include('domain');
            expect(result).to.include('1');
            expect(result).to.include('Agent');
        });

        it('preserves ROW_VARIABLE tokens', function () {
            const { mod } = loadFormatting();
            const input = '(and (instance ?X Foo) (check ?X @ROW))';
            const result = mod.formatSExpression(input);
            expect(result).to.include('?X');
            expect(result).to.include('@ROW');
        });

        it('preserves STRING tokens and wraps them in quotes', function () {
            const { mod } = loadFormatting();
            const input = '(documentation Foo EnglishLanguage "A human being.")';
            const result = mod.formatSExpression(input);
            expect(result).to.include('documentation');
            expect(result).to.include('"A human being."');
        });

        it('formats nested logical operators with each argument on its own line', function () {
            const { mod } = loadFormatting();
            const input = '(and (instance Foo Animal) (instance Foo Object))';
            const result = mod.formatSExpression(input);
            const lines = result.split('\n');
            // "and" on first line, each nested (instance ...) on its own line
            expect(lines[0]).to.include('and');
            expect(lines.some(l => l.includes('(instance Foo Animal)'))).to.be.true;
            expect(lines.some(l => l.includes('(instance Foo Object)'))).to.be.true;
        });

        it('keeps simple ground facts on one line', function () {
            const { mod } = loadFormatting();
            const result = mod.formatSExpression('(instance Foo Bar)');
            expect(result).to.equal('(instance Foo Bar)');
        });
    });

    // -----------------------------------------------------------------------
    describe('getHeadAtPosition', function () {

        it('returns the operator name for a standard expression', function () {
            const { mod } = loadFormatting();
            const { tokenize } = require('../src/parser/tokenizer');
            const { tokens } = tokenize('(instance Foo Bar)');
            // At index 3 (Bar), head should be 'instance'
            expect(mod.getHeadAtPosition(tokens, 3)).to.equal('instance');
        });

        it('returns null when no enclosing paren', function () {
            const { mod } = loadFormatting();
            const { tokenize } = require('../src/parser/tokenizer');
            const { tokens } = tokenize('foo bar');
            expect(mod.getHeadAtPosition(tokens, 1)).to.be.null;
        });
    });

    // -----------------------------------------------------------------------
    describe('findEnclosingSExpression', function () {

        it('finds the enclosing S-expression at cursor inside a list', function () {
            const { mod } = loadFormatting();
            const text = '(instance Foo Bar)';
            const doc = createMockDocument(text);
            // cursor at position 5 (inside "instance")
            const range = mod.findEnclosingSExpression(doc, doc.positionAt(5));
            expect(range).to.not.be.null;
            expect(doc.getText(range)).to.equal('(instance Foo Bar)');
        });

        it('returns null when cursor is outside any S-expression', function () {
            const { mod } = loadFormatting();
            const text = 'no parens here';
            const doc = createMockDocument(text);
            const range = mod.findEnclosingSExpression(doc, doc.positionAt(3));
            expect(range).to.be.null;
        });

        it('finds outermost paren when cursor is between nested expressions', function () {
            const { mod } = loadFormatting();
            const text = '(=> (instance ?X A) (instance ?X B))';
            const doc = createMockDocument(text);
            const range = mod.findEnclosingSExpression(doc, doc.positionAt(1));
            expect(range).to.not.be.null;
            expect(doc.getText(range)).to.equal(text);
        });
    });

    // -----------------------------------------------------------------------
    describe('formatDocument', function () {

        it('returns an array of TextEdits', function () {
            const { mod } = loadFormatting();
            const text = '(instance   Foo   Bar)';
            const doc = createMockDocument(text);
            const edits = mod.formatDocument(doc);
            expect(edits).to.be.an('array');
        });

        it('produces no edits when the document is already well-formatted', function () {
            const { mod } = loadFormatting();
            const text = '(instance Foo Bar)';
            const doc = createMockDocument(text);
            const edits = mod.formatDocument(doc);
            expect(edits).to.have.lengthOf(0);
        });

        it('handles multiple top-level S-expressions', function () {
            const { mod } = loadFormatting();
            const text = '(instance Foo Bar)\n(instance Baz Qux)';
            const doc = createMockDocument(text);
            const edits = mod.formatDocument(doc);
            expect(edits).to.be.an('array');
        });

        it('skips line comments', function () {
            const { mod } = loadFormatting();
            const text = '; this is a comment\n(instance Foo Bar)';
            const doc = createMockDocument(text);
            const edits = mod.formatDocument(doc);
            expect(edits).to.have.lengthOf(0);
        });
    });

    // -----------------------------------------------------------------------
    describe('formatRange', function () {

        it('returns an edit when range text needs reformatting', function () {
            const { mod } = loadFormatting();
            const text = '(instance  Foo  Bar)';  // extra spaces
            const doc = createMockDocument(text);
            const range = new (require('./helpers/vscode-mock').Range)(
                doc.positionAt(0), doc.positionAt(text.length)
            );
            const edits = mod.formatRange(doc, range);
            expect(edits).to.be.an('array');
            // The formatter normalises multiple spaces → should produce one edit
            expect(edits).to.have.lengthOf(1);
        });

        it('returns empty array when range is already formatted', function () {
            const { mod } = loadFormatting();
            const text = '(instance Foo Bar)';
            const doc = createMockDocument(text);
            const range = new (require('./helpers/vscode-mock').Range)(
                doc.positionAt(0), doc.positionAt(text.length)
            );
            const edits = mod.formatRange(doc, range);
            expect(edits).to.have.lengthOf(0);
        });
    });
});
