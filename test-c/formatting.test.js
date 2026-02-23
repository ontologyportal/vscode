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

    // tokenize is re-exported from validation; we use the real tokenizer
    const realTokenize = require('../src/parser/tokenizer').tokenize;

    const mod = proxyquire('../src/formatting', {
        vscode,
        './validation': { tokenize: realTokenize }
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
    describe('B4 - formatSExpression uses wrong config key for indent size', function () {

        it('should read indent size from "general.formatIndentSize" but reads from "formatIndentSize" instead', function () {
            // Configure via the CORRECT key (general.formatIndentSize)
            const { mod } = loadFormatting({ 'general.formatIndentSize': 4 });

            // A nested expression that would show indentation differences.
            // NOTE: '=>' is not a valid ATOM for the tokenizer (starts with '='),
            // so we use 'and' / 'not' which ARE valid lowercase ATOMs.
            const input = '(and (instance Foo Animal) (and (instance Foo Object) (instance Bar Object)))';
            const result = mod.formatSExpression(input);

            // BUG B4: the code does config.get('formatIndentSize') which returns
            // undefined (since only 'general.formatIndentSize' is set), so it
            // always falls back to 2-space indentation regardless of the setting.
            //
            // A module with NO config key also falls back to 2 spaces.
            // If B4 were fixed, 'general.formatIndentSize': 4 would produce 4-space output
            // that differs from the default. Until then, setting the correct key has no effect.
            const { mod: modDefault } = loadFormatting({});
            const resultDefault = modDefault.formatSExpression(input);

            // BUG B4: both produce identical 2-space output because the correct key is ignored.
            expect(result).to.equal(resultDefault,
                'BUG B4: formatting ignores "general.formatIndentSize"; ' +
                'setting it to 4 produces the same output as leaving it unset'
            );
        });

        it('confirms the buggy config key: formatIndentSize (no prefix) IS honoured', function () {
            // With the correct key the setting has no effect (B4)
            const { mod: modCorrectKey } = loadFormatting({ 'general.formatIndentSize': 8 });
            // With the wrong (actually-used) key it does take effect
            const { mod: modWrongKey } = loadFormatting({ 'formatIndentSize': 8 });

            // A 3-level nested expression to demonstrate differing indent widths
            const input = '(and (instance Foo Animal) (and (instance Foo Object) (instance Bar Object)))';
            const r1 = modCorrectKey.formatSExpression(input);
            const r2 = modWrongKey.formatSExpression(input);

            // r2 uses 8-space indent; r1 falls back to 2 spaces — they differ
            // This confirms the bug: the wrong key is checked.
            expect(r1).to.not.equal(r2,
                'BUG B4: setting "formatIndentSize" (wrong key) affects formatting ' +
                'but "general.formatIndentSize" (correct key) does not'
            );
        });
    });

    // -----------------------------------------------------------------------
    describe('getHeadAtPosition', function () {

        it('returns the operator name for a standard expression', function () {
            const { mod } = loadFormatting();
            const { tokenize } = require('../src/parser/tokenizer');
            const tokens = tokenize('(instance Foo Bar)');
            // At index 3 (Bar), head should be 'instance'
            expect(mod.getHeadAtPosition(tokens, 3)).to.equal('instance');
        });

        it('returns null when no enclosing paren', function () {
            const { mod } = loadFormatting();
            const { tokenize } = require('../src/parser/tokenizer');
            const tokens = tokenize('foo bar');
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
        it('B5 - source-level check: escape detection uses empty string instead of backslash', function () {
            // NOTE: The tokenizer at src/parser/tokenizer.js does NOT currently
            // support backslash (`\`) in string literals — it throws TokenizerError.
            // This means formatDocument cannot format any expression that contains
            // a documentation string with backslash escapes at all.
            //
            // B5 is a latent bug in the paren-balance scanner of formatDocument
            // (lines ~160-175): it attempts to skip over escape sequences inside
            // strings using `if (text[i] === '') i++`, but `''` (empty string)
            // can never equal a single character.  The intended check is `'\\'`.
            // When the tokenizer is eventually fixed to accept `\`, this bug will
            // surface and corrupt the S-expression boundary detection.
            const source = require('fs').readFileSync(
                require('path').join(__dirname, '../src/formatting.js'), 'utf-8'
            );
            // BUG B5: the source must be updated to use '\\' not ''
            expect(source).to.include("text[i] === ''",
                'BUG B5: escape-detection check uses empty string literal "" ' +
                'instead of backslash "\\\\" — should be: if (text[i] === \'\\\\\') i++'
            );
        });

        it('B5 & B4 - source-level: wrong config key and wrong escape check both present', function () {
            const source = require('fs').readFileSync(
                require('path').join(__dirname, '../src/formatting.js'), 'utf-8'
            );
            // BUG B4: the source reads 'formatIndentSize' (no 'general.' prefix)
            expect(source).to.include("config.get('formatIndentSize')",
                'BUG B4: source still uses wrong config key "formatIndentSize" ' +
                'instead of "general.formatIndentSize"'
            );
            // BUG B5: the escape check is `text[i] === ''` which is never true
            expect(source).to.include("text[i] === ''",
                'BUG B5: escape-detection check uses empty string literal'
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
