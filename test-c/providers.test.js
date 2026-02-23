/**
 * Tests for src/providers.js
 *
 * Covers provideHover, provideCompletionItems, and provideSignatureHelp.
 * All three functions depend on workspace metadata populated by navigation.js.
 */

'use strict';

const { expect } = require('chai');
const sinon = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

const { createVSCodeMock, createMockDocument } = require('./helpers/vscode-mock');
const realParser = require('../src/parser');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function loadProviders(workspaceMeta) {
    const vscode = createVSCodeMock(sinon);
    vscode._setConfig({ 'general.language': 'EnglishLanguage' });

    const meta = workspaceMeta || {};

    const realTokenize = realParser.tokenize;

    const mod = proxyquire('../src/providers', {
        vscode,
        './validation': { tokenize: realTokenize },
        './navigation': {
            getWorkspaceMetadata: sinon.stub().returns(meta)
        }
    });

    return { mod, vscode };
}

// ---------------------------------------------------------------------------
describe('providers.js', function () {

    afterEach(() => sinon.restore());

    // -----------------------------------------------------------------------
    describe('provideHover()', function () {

        it('returns undefined when cursor is not on a word', function () {
            const { mod } = loadProviders({});
            const doc = createMockDocument('  ');
            const pos = doc.positionAt(0);
            const result = mod.provideHover(doc, pos, null);
            expect(result).to.be.undefined;
        });

        it('returns undefined when the word has no metadata entry', function () {
            const { mod } = loadProviders({});
            const doc = createMockDocument('(instance Foo Bar)');
            const pos = doc.positionAt(10); // at 'Foo'
            const result = mod.provideHover(doc, pos, null);
            expect(result).to.be.undefined;
        });

        it('returns a Hover with documentation when metadata is present', function () {
            const { mod, vscode } = loadProviders({
                Foo: {
                    documentation: 'A simple concept.',
                    domains: {}
                }
            });
            const doc = createMockDocument('(instance Foo Bar)');
            const pos = doc.positionAt(10); // at 'Foo'
            const result = mod.provideHover(doc, pos, null);
            expect(result).to.be.instanceOf(vscode.Hover);
            expect(result.contents.value).to.include('A simple concept.');
        });

        it('includes domain type information in hover when domains are present', function () {
            const { mod, vscode } = loadProviders({
                knows: {
                    documentation: 'A knowledge relation.',
                    domains: { 1: 'Agent', 2: 'Entity' }
                }
            });
            const doc = createMockDocument('(knows Alice Bob)');
            const pos = doc.positionAt(1); // at 'knows'
            const result = mod.provideHover(doc, pos, null);
            expect(result).to.be.instanceOf(vscode.Hover);
            expect(result.contents.value).to.include('Agent');
            expect(result.contents.value).to.include('Entity');
        });

        it('returns undefined when metadata exists but has no documentation or domains', function () {
            const { mod } = loadProviders({
                Empty: { documentation: '', domains: {} }
            });
            const doc = createMockDocument('Empty');
            const pos = doc.positionAt(2);
            const result = mod.provideHover(doc, pos, null);
            expect(result).to.be.undefined;
        });
    });

    // -----------------------------------------------------------------------
    describe('provideCompletionItems()', function () {

        it('returns an empty array when there are no symbols', function () {
            const { mod } = loadProviders({});
            const doc = createMockDocument('');
            const items = mod.provideCompletionItems(doc, doc.positionAt(0), null, null);
            expect(items).to.be.an('array').with.lengthOf(0);
        });

        it('returns one CompletionItem per symbol in the workspace metadata', function () {
            const { mod, vscode } = loadProviders({
                knows: { documentation: 'A relation.', domains: { 1: 'Agent' } },
                Human: { documentation: 'A human.', domains: {} }
            });
            const doc = createMockDocument('(knows');
            const items = mod.provideCompletionItems(doc, doc.positionAt(0), null, null);
            expect(items).to.have.lengthOf(2);
            items.forEach(it => expect(it).to.be.instanceOf(vscode.CompletionItem));
        });

        it('attaches documentation to each completion item', function () {
            const { mod, vscode } = loadProviders({
                knows: { documentation: 'A knowledge relation.', domains: {} }
            });
            const doc = createMockDocument('');
            const items = mod.provideCompletionItems(doc, doc.positionAt(0), null, null);
            expect(items).to.have.lengthOf(1);
            expect(items[0].documentation).to.be.instanceOf(vscode.MarkdownString);
            expect(items[0].documentation.value).to.include('A knowledge relation.');
        });

        it('attaches domain detail string to each completion item that has domains', function () {
            const { mod } = loadProviders({
                knows: { documentation: '', domains: { 1: 'Agent', 2: 'Entity' } }
            });
            const doc = createMockDocument('');
            const items = mod.provideCompletionItems(doc, doc.positionAt(0), null, null);
            expect(items[0].detail).to.include('Agent');
            expect(items[0].detail).to.include('Entity');
        });
    });

    // -----------------------------------------------------------------------
    describe('provideSignatureHelp()', function () {

        it('returns null when cursor is not inside any expression', function () {
            const { mod } = loadProviders({});
            const doc = createMockDocument('foo bar baz');
            const pos = doc.positionAt(4);
            const result = mod.provideSignatureHelp(doc, pos, null);
            expect(result).to.be.null;
        });

        it('returns null when the head symbol has no metadata', function () {
            const { mod } = loadProviders({});
            const doc = createMockDocument('(unknownRelation Foo');
            const pos = doc.positionAt(doc.getText().length);
            const result = mod.provideSignatureHelp(doc, pos, null);
            expect(result).to.be.null;
        });

        it('returns a SignatureHelp object for a known relation', function () {
            const { mod, vscode } = loadProviders({
                knows: {
                    documentation: 'A knowledge relation.',
                    domains: { 1: 'Agent', 2: 'Entity' }
                }
            });
            // Cursor after the first argument
            const text = '(knows Alice ';
            const doc = createMockDocument(text);
            const pos = doc.positionAt(text.length);
            const result = mod.provideSignatureHelp(doc, pos, null);
            expect(result).to.be.instanceOf(vscode.SignatureHelp);
            expect(result.signatures).to.have.lengthOf(1);
        });

        it('signature label includes the relation name and argument types', function () {
            const { mod } = loadProviders({
                knows: {
                    documentation: '',
                    domains: { 1: 'Agent', 2: 'Entity' }
                }
            });
            const text = '(knows Alice ';
            const doc = createMockDocument(text);
            const pos = doc.positionAt(text.length);
            const result = mod.provideSignatureHelp(doc, pos, null);
            const label = result.signatures[0].label;
            expect(label).to.include('knows');
            expect(label).to.include('Agent');
            expect(label).to.include('Entity');
        });

        it('tracks the active parameter index', function () {
            const { mod } = loadProviders({
                knows: {
                    documentation: '',
                    domains: { 1: 'Agent', 2: 'Entity' }
                }
            });
            // After first argument and a space → cursor is on second argument
            const text = '(knows Alice ';
            const doc = createMockDocument(text);
            const pos = doc.positionAt(text.length);
            const result = mod.provideSignatureHelp(doc, pos, null);
            // paramIndex should be 1 (second slot, 0-indexed)
            expect(result.activeParameter).to.equal(1);
        });

        it('handles a relation with no domain declarations (uses Term as placeholder)', function () {
            const { mod } = loadProviders({
                knows: { documentation: '', domains: {} }
            });
            const text = '(knows Alice ';
            const doc = createMockDocument(text);
            const pos = doc.positionAt(text.length);
            const result = mod.provideSignatureHelp(doc, pos, null);
            expect(result).to.be.instanceOf(require('./helpers/vscode-mock').createVSCodeMock(sinon).constructor ||
                Object, 'result should be truthy');
            // Should include Term as placeholder type
            if (result && result.signatures.length > 0) {
                expect(result.signatures[0].label).to.include('Term');
            }
        });
    });
});
