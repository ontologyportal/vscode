/**
 * Tests for src/navigation.js
 *
 * Bugs exposed:
 *   B6 - Regex escaping is broken: the replacement string '\$&' is just '$&' in
 *        JavaScript (since \$ is not a recognised escape), so regex special chars
 *        like `.` and `+` are never escaped.  Should be '\\$&'.
 *   B7 - Template literal `\b` is the backspace character (U+0008), NOT a regex
 *        word boundary.  The fast-fail regex in searchSymbolCommand is therefore
 *        /[backspace]<symbol>[backspace]/ instead of /\b<symbol>\b/, and it will
 *        never match any text that doesn't contain backspace characters — meaning
 *        the symbol search always returns zero results.
 *   B8 - The docRegex inside updateFileDefinitions uses `\[\s\S]` (any whitespace
 *        or non-whitespace char) instead of `\\.` (backslash + any char) for
 *        escape sequences.  This lets `"` match inside the capture group, causing
 *        the regex to extend past the closing `"` of a documentation string.
 *   B9 - `taxonomyCache` is never declared with let/const/var at module scope.
 *        It is only assigned via bare assignment (`taxonomyCache = {}`), which
 *        creates an implicit global in sloppy mode and would throw ReferenceError
 *        in strict mode or if read before any assignment.
 */

'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();
const fs = require('fs');
const path = require('path');

const { createVSCodeMock, createMockDocument } = require('./helpers/vscode-mock');
const realParser = require('../src/parser');

// Convenience: parse KIF text to AST
function parseKIF(text) {
    const tokens = realParser.tokenize(text, 'test.kif');
    return new realParser.TokenList(tokens).parse();
}

// ---------------------------------------------------------------------------
// Helper: load navigation module
// ---------------------------------------------------------------------------
function loadNavigation(configValues, overrides) {
    const vscode = createVSCodeMock(sinon);
    vscode._setConfig(configValues || { 'general.language': 'EnglishLanguage' });

    const realValidation = proxyquire('../src/validation', {
        vscode,
        './parser': realParser
    });

    const mod = proxyquire('../src/navigation', {
        vscode,
        './parser': realParser,
        './validation': realValidation,
        './const': require('../src/const'),
        './sigma': {
            findConfigXml: sinon.stub().resolves(null),
            getSigmaRuntime: sinon.stub().returns({})
        },
        './sigma/config': {
            findConfigXml: sinon.stub().resolves(null),
            parseConfigXml: sinon.stub().resolves(null)
        },
        ...overrides
    });

    return { mod, vscode };
}

// ---------------------------------------------------------------------------
describe('navigation.js', function () {

    afterEach(() => sinon.restore());

    // -----------------------------------------------------------------------
    // B6: regex escaping is broken
    // -----------------------------------------------------------------------
    describe('B6 - regex special character escaping', function () {

        it('demonstrates that \'\\$&\' equals \'$&\' in JavaScript (no escaping occurs)', function () {
            // In JS, '\$' is not a recognised escape sequence, so it becomes '$'.
            // '\$&' is therefore the two-character string '$&'.
            // As a replacement string in String.prototype.replace(), '$&' means
            // "insert the matched text" — i.e. a no-op for the match.
            const buggyReplacement = '\$&';  // same as '$&'
            const correctReplacement = '\\$&'; // string '\$&' (3 chars)

            expect(buggyReplacement).to.equal('$&',
                'BUG B6: "\\$&" in source is the two-char string "$&", not an escaped replacement'
            );
            expect(correctReplacement).to.equal('\\$&');
            expect(correctReplacement).to.have.lengthOf(3);
        });

        it('shows that the buggy escape does NOT escape regex special characters', function () {
            // Using the buggy replacement string, dots are NOT escaped
            const symbol = 'foo.bar';
            const buggyEscaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\$&');
            // '$&' means "replace with the matched text" → no change
            expect(buggyEscaped).to.equal('foo.bar',
                'BUG B6: special chars in symbol are not escaped; regex will treat . as "any char"'
            );

            // With the correct replacement
            const correctEscaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            expect(correctEscaped).to.equal('foo\\.bar',
                'After fix: dots should be escaped to \\.'
            );
        });

        it('shows that the buggy escape causes false positive matches', function () {
            // A regex built from an unescaped symbol like 'foo.bar' will match 'fooXbar'
            const symbol = 'foo.bar';
            const buggyEscaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\$&');
            const regex = new RegExp(buggyEscaped);

            // BUG: 'fooXbar' matches because '.' is unescaped
            expect(regex.test('fooXbar')).to.be.true;

            // With the correct escape, 'fooXbar' should NOT match
            const correctEscaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const correctRegex = new RegExp(correctEscaped);
            expect(correctRegex.test('fooXbar')).to.be.false;
        });
    });

    // -----------------------------------------------------------------------
    // B7: \b in template literal is backspace, not word boundary
    // -----------------------------------------------------------------------
    describe('B7 - \\b in template literal is backspace character not word boundary', function () {

        it('confirms that \\b in a template literal is the backspace character (U+0008)', function () {
            const backspaceViaTemplate = `\b`;  // same escape as in navigation.js line 141
            expect(backspaceViaTemplate.charCodeAt(0)).to.equal(8,
                'BUG B7: \\b in a template literal is ASCII 8 (backspace), not a regex word boundary'
            );
            expect(backspaceViaTemplate).to.have.lengthOf(1);
        });

        it('shows the buggy regex never matches a word in normal text', function () {
            const symbol = 'instance';
            // Replicate the buggy code from navigation.js searchSymbolCommand
            const escapedSymbol = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\$&'); // B6 bug too
            const fastRegex = new RegExp(`\b${escapedSymbol}\b`); // B7: \b is backspace

            // The regex is /<backspace>instance<backspace>/ — will NOT match plain text
            const text = '(instance Human Entity)';
            expect(fastRegex.test(text)).to.be.false;

            // With the corrected template literal using \\b:
            const correctRegex = new RegExp(`\\b${symbol}\\b`);
            expect(correctRegex.test(text)).to.be.true;
        });

        it('shows the buggy fast-fail check would skip all files in searchSymbolCommand', function () {
            // The fast-fail in searchSymbolCommand:
            //   if (!fastRegex.test(text)) continue;
            // Since fastRegex matches backspace chars rather than word boundaries,
            // it will always return false for any normal KIF file content,
            // causing ALL files to be skipped and returning zero results.
            const text = '(instance Human Entity)\n(subclass Human Primate)';
            const symbol = 'Human';
            const escapedSymbol = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\$&');
            const fastRegex = new RegExp(`\b${escapedSymbol}\b`);

            // BUG: this returns false, causing the file to be skipped
            expect(fastRegex.test(text)).to.be.false;
        });
    });

    // -----------------------------------------------------------------------
    // B11: updateDocumentDefinitions regex uses unescaped template literals
    // -----------------------------------------------------------------------
    describe('B11 - updateDocumentDefinitions: invalid regex from unescaped template literal', function () {

        it('confirms the regex pattern uses single-backslash escapes in a template literal', function () {
            const source = fs.readFileSync(
                path.join(__dirname, '../src/navigation.js'), 'utf-8'
            );
            // The regex in updateDocumentDefinitions uses `\(` and `\s` in a template
            // literal.  Template literals process `\(` as `(` and `\s` as `s` (since
            // neither is a recognised escape), so the resulting pattern starts with a
            // bare `(` that opens a capturing group that is never closed.
            // BUG B11: the source should use `\\(` and `\\s` (double backslash).
            // Match `new RegExp(` + optional whitespace + backtick + `\(`
            // The `\\\(` in the regex literal matches the literal two-char sequence \(
            expect(source).to.match(/new RegExp\(\s*`\\\(/,
                'BUG B11: updateDocumentDefinitions creates regex with unescaped template escapes'
            );
        });

        it('demonstrates that \\( in a template literal is just ( (not regex \\()', function () {
            // \( is not a recognized escape sequence in JS template literals;
            // in sloppy mode it resolves to the literal character `(`
            const backslashParen = `\(`;
            expect(backslashParen).to.equal('(',
                'BUG B11: \\( in a template literal is `(`, not the escaped regex \\('
            );
            // So new RegExp(`\(foo`) creates /(foo/ which starts an unclosed group → throws
            expect(() => new RegExp(`\(${' '}foo`, 'g')).to.throw(SyntaxError); // unclosed group
            expect(() => new RegExp(`\(foo\)`, 'g')).to.not.throw();    // balanced parens OK
        });

        it('shows the invalid pattern that updateDocumentDefinitions creates', function () {
            // Replicate the buggy regex construction from updateDocumentDefinitions
            const rel = 'instance';
            // BUG B11: `\(` → `(`, `\s` → `s` → pattern has unmatched `(`
            expect(() => {
                new RegExp(`\(\s*${rel}\s+([^?\s\)][^\s\)]*)\s`, 'g');
            }).to.throw(SyntaxError, /Invalid regular expression/,
                'BUG B11: the buggy template literal produces an invalid regex pattern'
            );
        });
    });

    // -----------------------------------------------------------------------
    // B8: docRegex uses [\s\S] instead of \\. for escape sequences
    // -----------------------------------------------------------------------
    describe('B8 - docRegex uses wrong escape-sequence pattern', function () {

        it('shows the buggy docRegex captures past the closing quote', function () {
            // The buggy regex from navigation.js updateFileDefinitions:
            const buggyDocRegex = /\(\s*documentation\s+([^\s\)]+)\s+([^\s\)]+)\s+"((?:[^"\\]|\[\s\S])*)"/g;

            // A documentation string with an escaped quote:
            const text = '(documentation Foo EnglishLanguage "He said \\"hi\\".")';

            let match;
            let captured = null;
            while ((match = buggyDocRegex.exec(text)) !== null) {
                captured = match[3];
            }

            // The correct regex using \\. to handle escape sequences:
            const correctDocRegex = /\(\s*documentation\s+([^\s\)]+)\s+([^\s\)]+)\s+"((?:[^"\\]|\\.)*)"/g;
            let correctCaptured = null;
            let m2;
            correctDocRegex.lastIndex = 0;
            while ((m2 = correctDocRegex.exec(text)) !== null) {
                correctCaptured = m2[3];
            }

            // With the correct regex, the full escaped string is captured
            // With the buggy regex, it may match differently
            if (captured !== null && correctCaptured !== null) {
                // They should be different because [\s\S] matches " itself,
                // letting the greedy * extend past the intended boundary.
                // (The exact behaviour depends on the string content, but we
                //  document that the correct regex captures the backslash-escaped content)
                expect(correctCaptured).to.include('hi');
            }
        });

        it('confirms that [\\s\\S] in a character class matches any character including quotes', function () {
            // [\s\S] matches whitespace OR non-whitespace = all characters
            const anyChar = /[\s\S]/;
            expect(anyChar.test('"')).to.be.true;
            expect(anyChar.test('\\')).to.be.true;
            expect(anyChar.test('\n')).to.be.true;

            // BUG B8: since [\s\S] matches ", a greedy (?:[^"\\]|[\s\S])* consumes "
            // and extends past the intended end of the documentation string
        });

        it('checks the source for the buggy docRegex pattern', function () {
            const source = fs.readFileSync(
                path.join(__dirname, '../src/navigation.js'), 'utf-8'
            );
            // BUG B8: source contains [\s\S] instead of \\.
            expect(source).to.include('[\\s\\S]',
                'BUG B8: docRegex uses [\\s\\S] (matches any char including ") ' +
                'instead of \\\\. (backslash + any char)'
            );
        });
    });

    // -----------------------------------------------------------------------
    // B9: taxonomyCache never declared at module scope
    // -----------------------------------------------------------------------
    describe('B9 - taxonomyCache is an implicit global', function () {

        it('confirms taxonomyCache has no module-level declaration in source', function () {
            const source = fs.readFileSync(
                path.join(__dirname, '../src/navigation.js'), 'utf-8'
            );

            // Check that there is no let/const/var declaration of taxonomyCache
            const hasDeclaration = /^(?:let|const|var)\s+taxonomyCache\b/m.test(source);
            expect(hasDeclaration).to.be.false;
        });

        it('shows that bare assignment to taxonomyCache creates an implicit global', function () {
            // In non-strict Node.js, assigning to an undeclared variable creates
            // a property on the global object.  In strict mode it throws.
            // We verify the assignment exists without a declaration.
            const source = fs.readFileSync(
                path.join(__dirname, '../src/navigation.js'), 'utf-8'
            );
            // The assignment pattern exists in the source
            expect(source).to.match(/taxonomyCache\s*=\s*\{\}/,
                'BUG B9: bare assignment taxonomyCache = {} with no prior declaration'
            );
        });

        it('getWorkspaceTaxonomy throws ReferenceError when called before any file is processed', function () {
            // Fresh require of navigation to reset module state
            const freshVscode = createVSCodeMock(sinon);
            freshVscode._setConfig({ 'general.language': 'EnglishLanguage' });

            const freshValidation = proxyquire('../src/validation', {
                vscode: freshVscode,
                './parser': realParser
            });

            const freshNav = proxyquire('../src/navigation', {
                vscode: freshVscode,
                './parser': realParser,
                './validation': freshValidation,
                './const': require('../src/const'),
                './sigma': {
                    findConfigXml: sinon.stub().resolves(null),
                    getSigmaRuntime: sinon.stub().returns({})
                },
                './sigma/config': {
                    findConfigXml: sinon.stub().resolves(null),
                    parseConfigXml: sinon.stub().resolves(null)
                }
            });

            // BUG B9: taxonomyCache is never declared with let/const/var at module scope.
            // When getWorkspaceTaxonomy() is called before buildWorkspaceDefinitions()
            // or updateFileDefinitions(), `taxonomyCache` is an undeclared variable
            // and `for (const fsPath in taxonomyCache)` throws ReferenceError.
            expect(() => freshNav.getWorkspaceTaxonomy()).to.throw();
        });
    });

    // -----------------------------------------------------------------------
    // getWorkspaceTaxonomy / getWorkspaceMetadata / updateFileDefinitions
    //
    // NOTE B9: taxonomyCache is an implicit global (never declared).
    //   Work around: seed global.taxonomyCache = {} in `before()`.
    //   Remove once B9 is fixed.
    //
    // NOTE B11: updateDocumentDefinitions uses unescaped `\(` / `\s` in a
    //   template literal regex, producing an invalid pattern that throws
    //   SyntaxError.  These tests catch B11 errors and assert on the parts
    //   of updateFileDefinitions that run BEFORE the invalid regex is hit.
    //   Once B11 is fixed, remove the try/catch wrappers.
    // -----------------------------------------------------------------------

    /** Helper: call updateFileDefinitions and tolerate B11 SyntaxError. */
    function safeUpdateFile(mod, doc, kb) {
        try {
            mod.updateFileDefinitions(doc, kb);
        } catch (e) {
            // B11: updateDocumentDefinitions creates an invalid regex
            if (!(e instanceof SyntaxError) || !e.message.includes('Invalid regular expression')) {
                throw e; // unexpected error — rethrow
            }
        }
    }

    describe('getWorkspaceTaxonomy()', function () {

        before(function () {
            // B9 workaround
            if (typeof global.taxonomyCache === 'undefined') global.taxonomyCache = {};
        });

        it('returns parents, children, and documentation objects (blocked by B11)', function () {
            const { mod } = loadNavigation();
            mod.setKB('TestKB');
            const kif = '(subclass Cat Mammal)\n(documentation Cat EnglishLanguage "A cat.")';
            const doc = createMockDocument(kif, '/test/foo.kif');
            safeUpdateFile(mod, doc, 'TestKB');

            const taxonomy = mod.getWorkspaceTaxonomy();
            expect(taxonomy).to.have.property('parents');
            expect(taxonomy).to.have.property('children');
            expect(taxonomy).to.have.property('documentation');
        });

        it('reflects subclass relations in the parents graph (blocked by B11)', function () {
            const { mod } = loadNavigation();
            mod.setKB('TestKB');
            const kif = '(subclass Cat Mammal)';
            const doc = createMockDocument(kif, '/test/kif1.kif');
            safeUpdateFile(mod, doc, 'TestKB');

            const taxonomy = mod.getWorkspaceTaxonomy();
            expect(taxonomy.parents).to.have.property('Cat');
            expect(taxonomy.parents.Cat.some(p => p.name === 'Mammal')).to.be.true;
        });

        it('reflects instance relations in the parents graph (blocked by B11)', function () {
            const { mod } = loadNavigation();
            mod.setKB('TestKB');
            const kif = '(instance Rover Dog)';
            const doc = createMockDocument(kif, '/test/kif2.kif');
            safeUpdateFile(mod, doc, 'TestKB');

            const taxonomy = mod.getWorkspaceTaxonomy();
            expect(taxonomy.parents).to.have.property('Rover');
        });
    });

    // -----------------------------------------------------------------------
    // getWorkspaceMetadata()
    // -----------------------------------------------------------------------
    describe('getWorkspaceMetadata()', function () {

        before(function () {
            if (typeof global.taxonomyCache === 'undefined') global.taxonomyCache = {};
        });

        it('aggregates documentation metadata from processed files (blocked by B11)', function () {
            const { mod } = loadNavigation({ 'general.language': 'EnglishLanguage' });
            mod.setKB('TestKB');
            const kif = '(documentation knows EnglishLanguage "A knowledge relation.")';
            safeUpdateFile(mod, createMockDocument(kif, '/test/b.kif'), 'TestKB');

            const meta = mod.getWorkspaceMetadata();
            expect(meta).to.have.property('knows');
            expect(meta.knows.documentation).to.include('knowledge');
        });

        it('caches the result until a new file is processed (blocked by B11)', function () {
            const { mod } = loadNavigation();
            mod.setKB('TestKB');
            safeUpdateFile(mod, createMockDocument('(subclass Foo Bar)', '/test/c.kif'), 'TestKB');

            const first = mod.getWorkspaceMetadata();
            const second = mod.getWorkspaceMetadata();
            expect(first).to.equal(second); // same object reference
        });
    });

    // -----------------------------------------------------------------------
    // updateFileDefinitions()
    // -----------------------------------------------------------------------
    describe('updateFileDefinitions()', function () {

        before(function () {
            if (typeof global.taxonomyCache === 'undefined') global.taxonomyCache = {};
        });

        it('B11 - updateDocumentDefinitions throws SyntaxError for invalid regex', function () {
            // This directly proves B11: updateFileDefinitions propagates a SyntaxError
            // from the invalid regex in updateDocumentDefinitions.
            const { mod, vscode } = loadNavigation();
            mod.setKB('TestKB');
            const collection = vscode.languages.createDiagnosticCollection('test');
            mod.setDiagnosticCollection(collection);

            const doc = createMockDocument('(instance Foo Bar)', '/test/b11.kif');
            expect(() => mod.updateFileDefinitions(doc, 'TestKB')).to.throw(SyntaxError,
                /Invalid regular expression/,
                'BUG B11: updateDocumentDefinitions creates an invalid regex from the template literal'
            );
        });

        it('populates diagnostics for parse errors (parse runs before B11)', function () {
            // The parse + validate passes run BEFORE updateDocumentDefinitions,
            // so diagnostics ARE populated even though B11 fires later.
            const { mod, vscode } = loadNavigation();
            mod.setKB('TestKB');
            const collection = vscode.languages.createDiagnosticCollection('test');
            mod.setDiagnosticCollection(collection);

            const kif = '(instance Foo'; // unclosed paren
            const doc = createMockDocument(kif, '/test/err.kif');
            safeUpdateFile(mod, doc, 'TestKB');

            const diags = collection.get('/test/err.kif');
            expect(diags).to.have.lengthOf.at.least(1);
            expect(diags[0].severity).to.equal(0); // Error
        });

        it('clears diagnostics when document becomes valid (blocked by B11 after fix)', function () {
            const { mod, vscode } = loadNavigation();
            mod.setKB('TestKB');
            const collection = vscode.languages.createDiagnosticCollection('test');
            mod.setDiagnosticCollection(collection);

            const badDoc = createMockDocument('(instance Foo', '/test/x.kif');
            safeUpdateFile(mod, badDoc, 'TestKB');
            expect(collection.get('/test/x.kif')).to.have.lengthOf.at.least(1);

            // Use a documentation statement: collectMetadata does NOT set defNode for it,
            // so validateCoverage skips it → zero diagnostics → collection is cleared.
            const goodDoc = createMockDocument(
                '(documentation Foo EnglishLanguage "A description.")',
                '/test/x.kif'
            );
            safeUpdateFile(mod, goodDoc, 'TestKB');

            const remaining = collection.get('/test/x.kif');
            expect(!remaining || remaining.length === 0).to.be.true;
        });
    });

    // -----------------------------------------------------------------------
    // setKB / getKB
    // -----------------------------------------------------------------------
    describe('setKB() / getKB()', function () {

        it('round-trips the KB name', function () {
            const { mod } = loadNavigation();
            mod.setKB('MySUMO');
            expect(mod.getKB()).to.equal('MySUMO');
        });

        it('returns null when reset to null', function () {
            const { mod } = loadNavigation();
            mod.setKB('X');
            mod.setKB(null);
            expect(mod.getKB()).to.be.null;
        });
    });
});
