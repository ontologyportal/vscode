/**
 * Tests for src/validation.js (non-bug tests)
 */

'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

const { createVSCodeMock, createMockDocument } = require('./helpers/vscode-mock');
const realParser = require('../src/parser');

// ---------------------------------------------------------------------------
// Helper: load validation module
// ---------------------------------------------------------------------------
function loadValidation(configValues) {
    const vscode = createVSCodeMock(sinon);
    vscode._setConfig(configValues || { 'general.language': 'EnglishLanguage' });

    vscode['@global'] = true;

    const mod = proxyquire('../src/validation', {
        vscode,
        './parser': realParser
    });

    return { mod, vscode };
}

// Convenience: parse KIF text to AST
function parseKIF(text) {
    const { tokens } = realParser.tokenize(text, 'test.kif');
    return new realParser.TokenList(tokens).parse().nodes;
}

// ---------------------------------------------------------------------------
describe('validation.js', function () {

    afterEach(() => sinon.restore());

    // -----------------------------------------------------------------------
    describe('parse()', function () {

        it('returns AST for valid KIF', function () {
            const { mod } = loadValidation();
            const { tokens } = realParser.tokenize('(instance Foo Bar)', 'test.kif');
            const diags = [];
            const ast = mod.parse(tokens, diags);
            expect(ast).to.have.lengthOf(1);
            expect(diags).to.have.lengthOf(0);
        });

        it('pushes a diagnostic and returns [] on parse error', function () {
            const { mod } = loadValidation();
            const { tokens } = realParser.tokenize('(instance Foo', 'test.kif');
            const diags = [];
            const ast = mod.parse(tokens, diags);
            expect(ast).to.deep.equal([]);
            expect(diags).to.have.lengthOf(1);
            expect(diags[0].severity).to.equal(0); // Error
        });
    });

    // validateNode, validateOperand, validateRelationUsage, and validateVariables
    // have been removed from validation.js exports — those checks are now handled
    // internally or via Term.validate() and Formula.validate() in the parser layer.

    // -----------------------------------------------------------------------
    describe('validateFileDependencies()', function () {

        /**
         * Build a combined SymbolTable from multiple files.
         * Each entry: { path: string, text: string }
         */
        function buildSymbolTable(files) {
            let table = new realParser.SymbolTable();
            for (const { path, text } of files) {
                const { tokens } = realParser.tokenize(text, path);
                const { nodes } = new realParser.TokenList(tokens).parse();
                const { symbolTable } = realParser.syntax(nodes, table);
                table = symbolTable;
            }
            return table;
        }

        it('produces no diagnostics when there is no cycle', function () {
            const { mod } = loadValidation();
            // a.kif defines Cat, depends on Mammal from b.kif — no cycle
            const table = buildSymbolTable([
                { path: '/a.kif', text: '(subclass Cat Mammal)' },
                { path: '/b.kif', text: '(subclass Mammal Animal)' }
            ]);
            const doc = createMockDocument('(subclass Cat Mammal)', '/a.kif');
            const diags = [];
            mod.validateFileDependencies(table, doc, diags);
            expect(diags).to.have.lengthOf(0);
        });

        it('warns when two files form a mutual dependency cycle', function () {
            const { mod } = loadValidation();
            // a.kif: Cat depends on Mammal (defined in b.kif)
            // b.kif: Mammal depends on Cat (defined in a.kif) — cycle!
            const table = buildSymbolTable([
                { path: '/a.kif', text: '(subclass Cat Mammal)' },
                { path: '/b.kif', text: '(subclass Mammal Cat)' }
            ]);
            const doc = createMockDocument('(subclass Cat Mammal)', '/a.kif');
            const diags = [];
            mod.validateFileDependencies(table, doc, diags);
            expect(diags).to.have.lengthOf.at.least(1);
            expect(diags[0].message).to.include('Circular file dependency');
            expect(diags[0].message).to.include('a.kif');
            expect(diags[0].message).to.include('b.kif');
        });

        it('warns on all files that participate in a three-file cycle', function () {
            const { mod } = loadValidation();
            // a → b → c → a
            const files = [
                { path: '/a.kif', text: '(subclass A B)' },
                { path: '/b.kif', text: '(subclass B C)' },
                { path: '/c.kif', text: '(subclass C A)' }
            ];
            const table = buildSymbolTable(files);

            for (const { path, text } of files) {
                const doc = createMockDocument(text, path);
                const diags = [];
                mod.validateFileDependencies(table, doc, diags);
                expect(diags).to.have.lengthOf.at.least(1,
                    `Expected cycle warning in ${path}`);
                expect(diags[0].message).to.include('Circular file dependency');
            }
        });

        it('produces no diagnostics when terms in the same file depend on each other', function () {
            const { mod } = loadValidation();
            // Both sentences in the same file — no cross-file edge
            const table = buildSymbolTable([
                { path: '/a.kif', text: '(subclass Cat Mammal)\n(subclass Mammal Animal)' }
            ]);
            const doc = createMockDocument('(subclass Cat Mammal)\n(subclass Mammal Animal)', '/a.kif');
            const diags = [];
            mod.validateFileDependencies(table, doc, diags);
            expect(diags).to.have.lengthOf(0);
        });

        it('produces no diagnostics for a diamond dependency (no cycle)', function () {
            const { mod } = loadValidation();
            // a.kif: Cat depends on Mammal (b.kif) and Organism (c.kif)
            // b.kif: Mammal depends on Animal (d.kif)
            // c.kif: Organism depends on Animal (d.kif)
            // No cycle — shared dependency on d.kif is fine
            const table = buildSymbolTable([
                { path: '/a.kif', text: '(subclass Cat Mammal)\n(subclass Cat Organism)' },
                { path: '/b.kif', text: '(subclass Mammal Animal)' },
                { path: '/c.kif', text: '(subclass Organism Animal)' },
                { path: '/d.kif', text: '(subclass Animal Entity)' }
            ]);
            const doc = createMockDocument('(subclass Cat Mammal)\n(subclass Cat Organism)', '/a.kif');
            const diags = [];
            mod.validateFileDependencies(table, doc, diags);
            expect(diags).to.have.lengthOf(0);
        });
    });
});
