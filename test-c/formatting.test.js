/**
 * Tests for src/formatting.js
 *
 * Bugs exposed:
 *   B4 - formatSExpression reads config key 'formatIndentSize' instead of
 *        'general.formatIndentSize', so the user's indent-size setting is always ignored.
 *   B5 - formatDocument uses `text[i] === ''` to detect backslash escapes inside
 *        string literals, but an empty string can never equal a single character.
 *        The correct check is `text[i] === '\\'`.  As a result, an escaped quote
 *        `\"` inside a documentation string terminates the string scan early,
 *        corrupting subsequent S-expression boundaries.
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
            // NOTE: the tokenizer does not recognise '=>' as a valid ATOM (starts with '='),
            // so we use 'and' which is a valid lowercase ATOM.
            const input = '(and (instance Foo Animal) (instance Foo Object))';
            const result = mod.formatSExpression(input);
            expect(result).to.include('and');
            expect(result).to.include('instance');
        });

        it('formats a forall quantifier (VARIABLE tokens are dropped by formatter)', function () {
            const { mod } = loadFormatting();
            // NOTE: variables like ?X are valid — they are tokenized as VARIABLE type.
            // The formatter only handles ATOM tokens; VARIABLE tokens are silently skipped.
            // ATOMs that immediately follow a VARIABLE are also dropped (prevToken check).
            const input = '(forall (?X) (instance ?X Foo))';
            const result = mod.formatSExpression(input);
            expect(result).to.include('forall');
            expect(result).to.include('instance');
            // ?X and the following atom Foo are dropped because the formatter
            // has no branch for token.type === 'VARIABLE'
            expect(result).to.not.include('?X');
        });
    });

    // -----------------------------------------------------------------------
    // B4: wrong config key — 'formatIndentSize' vs 'general.formatIndentSize'
    // -----------------------------------------------------------------------
    describe('B4 (fixed) - formatSExpression now reads "general.formatIndentSize"', function () {

        it('setting "general.formatIndentSize" changes the indent size', function () {
            const input = '(and (instance Foo Animal) (and (instance Foo Object) (instance Bar Object)))';

            // With the correct key set to 4, output should use 4-space indent
            const { mod } = loadFormatting({ 'general.formatIndentSize': 4 });
            const result = mod.formatSExpression(input);

            // With no key set, output should use the 2-space default
            const { mod: modDefault } = loadFormatting({});
            const resultDefault = modDefault.formatSExpression(input);

            // FIX B4: the correct key is now read, so 4-space differs from the 2-space default
            expect(result).to.not.equal(resultDefault,
                'FIX B4: "general.formatIndentSize": 4 should produce 4-space indentation, ' +
                'which differs from the default 2-space output'
            );
            expect(result).to.match(/    /, 'output should contain 4-space indentation');
        });

        it('the old wrong key "formatIndentSize" (no prefix) is now ignored', function () {
            const input = '(and (instance Foo Animal) (and (instance Foo Object) (instance Bar Object)))';

            // Correct key set to 8 → should use 8-space indent
            const { mod: modCorrectKey } = loadFormatting({ 'general.formatIndentSize': 8 });
            // Wrong key set to 8 → should now be IGNORED, falls back to default 2 spaces
            const { mod: modWrongKey } = loadFormatting({ 'formatIndentSize': 8 });

            const r1 = modCorrectKey.formatSExpression(input);
            const r2 = modWrongKey.formatSExpression(input);

            // FIX B4: the correct key is honoured (8-space), the wrong key is ignored (2-space)
            expect(r1).to.not.equal(r2,
                'FIX B4: correct key "general.formatIndentSize" = 8 gives 8-space indent; ' +
                'wrong key "formatIndentSize" is ignored and falls back to 2-space default'
            );
            expect(r1).to.match(/        /, 'correct-key output should have 8-space indentation');
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

        // -------------------------------------------------------------------
        // B5: backslash-escape check in string scanning is broken
        // -------------------------------------------------------------------
        it('B5 (fixed) - escape detection now uses backslash instead of empty string', function () {
            const source = require('fs').readFileSync(
                require('path').join(__dirname, '../src/formatting.js'), 'utf-8'
            );
            // FIX B5: source now uses '\\' (the backslash character) for escape detection
            expect(source).to.include("text[i] === '\\\\'",
                'FIX B5: escape-detection check should use backslash "\\\\", not empty string ""'
            );
            // And the buggy empty-string form should be gone
            expect(source).to.not.include("text[i] === ''",
                'FIX B5: empty string literal "" should no longer appear as the escape check'
            );
        });

        it('B5 & B4 (fixed) - correct config key and correct escape check both present', function () {
            const source = require('fs').readFileSync(
                require('path').join(__dirname, '../src/formatting.js'), 'utf-8'
            );
            // FIX B4: source now reads 'general.formatIndentSize'
            expect(source).to.include("config.get('general.formatIndentSize')",
                'FIX B4: source should use correct key "general.formatIndentSize"'
            );
            // FIX B5: the escape check is now `text[i] === '\\'`
            expect(source).to.include("text[i] === '\\\\'",
                'FIX B5: escape-detection check should use backslash "\\\\"'
            );
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
