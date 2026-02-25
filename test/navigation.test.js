/**
 * Tests for src/navigation.js (non-bug tests)
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
    const { tokens } = realParser.tokenize(text, 'test.kif');
    return new realParser.TokenList(tokens).parse().nodes;
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

/**
 * Build a navigation module wired up for buildWorkspaceDefinitions tests.
 * Mocks fs.existsSync so getKBFiles accepts paths that don't exist on disk.
 */
function setupNavForBuild(parseConfigStub, docMap) {
    const vscodeMock = createVSCodeMock(sinon);
    vscodeMock._setConfig({ 'general.language': 'EnglishLanguage' });

    // Accept all paths in docMap as "existing" files
    const realFs = require('fs');
    const mockFs = Object.assign({}, realFs, {
        existsSync: (p) => docMap.has(p) || realFs.existsSync(p)
    });

    vscodeMock.workspace.openTextDocument = sinon.stub().callsFake(uri => {
        const p = uri.fsPath || (typeof uri === 'string' ? uri : null);
        const doc = docMap.get(p);
        if (doc) return Promise.resolve(doc);
        return Promise.reject(new Error('unknown file: ' + p));
    });

    const realValidation = proxyquire('../src/validation', {
        vscode: vscodeMock,
        './parser': realParser
    });

    const mod = proxyquire('../src/navigation', {
        vscode: vscodeMock,
        fs: mockFs,
        './parser': realParser,
        './validation': realValidation,
        './const': require('../src/const'),
        './sigma': {
            findConfigXml: sinon.stub().resolves('/test/config.xml'),
            getSigmaRuntime: sinon.stub().returns({})
        },
        './sigma/config': {
            findConfigXml: sinon.stub().resolves('/test/config.xml'),
            parseConfigXml: parseConfigStub
        }
    });

    const collection = vscodeMock.languages.createDiagnosticCollection('sumo');
    mod.setDiagnosticCollection(collection);
    return { mod, vscodeMock, collection };
}

// ---------------------------------------------------------------------------
describe('navigation.js', function () {

    afterEach(() => sinon.restore());

    // -----------------------------------------------------------------------
    describe('getWorkspaceTaxonomy()', function () {

        it('returns parents, children, and documentation objects', function () {
            const { mod } = loadNavigation();
            mod.setKB('TestKB');
            const kif = '(subclass Cat Mammal)\n(documentation Cat EnglishLanguage "A cat.")';
            const doc = createMockDocument(kif, '/test/foo.kif');
            mod.updateFileDefinitions(doc, 'TestKB');

            const taxonomy = mod.getWorkspaceTaxonomy();
            expect(taxonomy).to.have.property('parents');
            expect(taxonomy).to.have.property('children');
            expect(taxonomy).to.have.property('documentation');
        });

        it('reflects subclass relations in the parents graph', function () {
            const { mod } = loadNavigation();
            mod.setKB('TestKB');
            const kif = '(subclass Cat Mammal)';
            const doc = createMockDocument(kif, '/test/kif1.kif');
            mod.updateFileDefinitions(doc, 'TestKB');

            const taxonomy = mod.getWorkspaceTaxonomy();
            expect(taxonomy.parents).to.have.property('Cat');
            expect(taxonomy.parents.Cat.some(p => p.name === 'Mammal')).to.be.true;
        });

        it('reflects instance relations in the parents graph', function () {
            const { mod } = loadNavigation();
            mod.setKB('TestKB');
            const kif = '(instance Rover Dog)';
            const doc = createMockDocument(kif, '/test/kif2.kif');
            mod.updateFileDefinitions(doc, 'TestKB');

            const taxonomy = mod.getWorkspaceTaxonomy();
            expect(taxonomy.parents).to.have.property('Rover');
        });
    });

    // -----------------------------------------------------------------------
    describe('getWorkspaceMetadata()', function () {

        it('aggregates documentation metadata from processed files', function () {
            const { mod } = loadNavigation({ 'general.language': 'EnglishLanguage' });
            mod.setKB('TestKB');
            const kif = '(documentation knows EnglishLanguage "A knowledge relation.")';
            mod.updateFileDefinitions(createMockDocument(kif, '/test/b.kif'), 'TestKB');

            const meta = mod.getWorkspaceMetadata();
            expect(meta).to.have.property('knows');
            expect(meta.knows.documentation).to.include('knowledge');
        });

        it('caches the result until a new file is processed', function () {
            const { mod } = loadNavigation();
            mod.setKB('TestKB');
            mod.updateFileDefinitions(createMockDocument('(subclass Foo Bar)', '/test/c.kif'), 'TestKB');

            const first = mod.getWorkspaceMetadata();
            const second = mod.getWorkspaceMetadata();
            expect(first).to.equal(second); // same object reference
        });
    });

    // -----------------------------------------------------------------------
    describe('updateFileDefinitions()', function () {

        it('populates diagnostics for parse errors', function () {
            const { mod, vscode } = loadNavigation();
            mod.setKB('TestKB');
            const collection = vscode.languages.createDiagnosticCollection('test');
            mod.setDiagnosticCollection(collection);

            const kif = '(instance Foo'; // unclosed paren
            const doc = createMockDocument(kif, '/test/err.kif');
            mod.updateFileDefinitions(doc, 'TestKB');

            const diags = collection.get('/test/err.kif');
            expect(diags).to.have.lengthOf.at.least(1);
            expect(diags[0].severity).to.equal(0); // Error
        });

        it('clears diagnostics when document becomes valid', function () {
            const { mod, vscode } = loadNavigation();
            mod.setKB('TestKB');
            const collection = vscode.languages.createDiagnosticCollection('test');
            mod.setDiagnosticCollection(collection);

            const badDoc = createMockDocument('(instance Foo', '/test/x.kif');
            mod.updateFileDefinitions(badDoc, 'TestKB');
            expect(collection.get('/test/x.kif')).to.have.lengthOf.at.least(1);

            // Use a documentation statement: collectMetadata does NOT set defNode for it,
            // so validateCoverage skips it → zero diagnostics → collection is cleared.
            const goodDoc = createMockDocument(
                '(documentation Foo EnglishLanguage "A description.")',
                '/test/x.kif'
            );
            mod.updateFileDefinitions(goodDoc, 'TestKB');

            const remaining = collection.get('/test/x.kif');
            expect(!remaining || remaining.length === 0).to.be.true;
        });
    });

    // -----------------------------------------------------------------------
    describe('Entity root check with Merge.kif', function () {

        it('builds a taxonomy that can reach Entity from core SUMO terms', function () {
            const { mod, vscode } = loadNavigation();
            mod.setKB('SUMO');
            const collection = vscode.languages.createDiagnosticCollection('sumo');
            mod.setDiagnosticCollection(collection);

            const kifText = require('fs').readFileSync(
                path.join(__dirname, 'Merge.kif'), 'utf-8'
            );
            const doc = createMockDocument(kifText, '/test/Merge.kif');
            mod.updateFileDefinitions(doc, 'SUMO');

            const taxonomy = mod.getWorkspaceTaxonomy();
            const parents = taxonomy.parents;

            // Core SUMO terms that must reach Entity via subclass/instance/subrelation
            const mustReach = ['BinaryPredicate', 'Predicate', 'Relation', 'Abstract', 'Physical'];
            function canReach(sym) {
                const visited = new Set();
                const queue = [sym];
                while (queue.length) {
                    const cur = queue.shift();
                    if (cur === 'Entity') return true;
                    if (visited.has(cur)) continue;
                    visited.add(cur);
                    for (const p of (parents[cur] || [])) queue.push(p.name);
                }
                return false;
            }

            for (const term of mustReach) {
                expect(canReach(term)).to.be.true;
            }
        });

        it('produces no false-positive "no taxonomy path to Entity" errors for Merge.kif terms', function () {
            const { mod, vscode } = loadNavigation();
            mod.setKB('SUMO');
            const collection = vscode.languages.createDiagnosticCollection('sumo');
            mod.setDiagnosticCollection(collection);

            const kifText = require('fs').readFileSync(
                path.join(__dirname, 'Merge.kif'), 'utf-8'
            );
            const doc = createMockDocument(kifText, '/test/Merge.kif');
            mod.updateFileDefinitions(doc, 'SUMO');

            const diags = collection.get('/test/Merge.kif') || [];
            const pathErrors = diags.filter(d => d.message.includes('no taxonomy path to Entity'));
            expect(pathErrors).to.have.lengthOf(0,
                'no false-positive "no taxonomy path" errors for Merge.kif: ' +
                pathErrors.map(d => d.message).join('; ')
            );
        });
    });

    // -----------------------------------------------------------------------
    describe('buildWorkspaceDefinitions() - two-pass taxonomy ordering', function () {

        it('validates file1 against taxonomy from file2 (two-pass avoids ordering false positives)', async function () {
            // file1.kif: (subclass Cat Mammal)          — Cat's parent is in file2
            // file2.kif: (subclass Mammal Animal) + (subclass Animal Entity)
            //
            // Single-pass: file1 validated before file2 is loaded → Cat can't reach Entity.
            // Two-pass:    all taxonomy built first → no false-positive path errors.
            const docMap = new Map([
                ['/test/file1.kif', createMockDocument(
                    '(subclass Cat Mammal)\n(documentation Cat EnglishLanguage "A cat.")',
                    '/test/file1.kif'
                )],
                ['/test/file2.kif', createMockDocument(
                    '(subclass Mammal Animal)\n(subclass Animal Entity)\n' +
                    '(documentation Mammal EnglishLanguage "A mammal.")\n' +
                    '(documentation Animal EnglishLanguage "An animal.")',
                    '/test/file2.kif'
                )]
            ]);

            const parseConfigStub = sinon.stub().resolves({
                knowledgeBases: { SUMO: { constituents: ['/test/file1.kif', '/test/file2.kif'] } },
                preferences: { kbDir: '/test' }
            });

            const { mod, collection } = setupNavForBuild(parseConfigStub, docMap);
            await mod.buildWorkspaceDefinitions();

            const diags = collection.get('/test/file1.kif') || [];
            const pathErrors = diags.filter(d => d.message.includes('no taxonomy path'));
            expect(pathErrors).to.have.lengthOf(0,
                'Cat should reach Entity via cross-file taxonomy with two-pass build: ' +
                pathErrors.map(d => d.message).join('; ')
            );
        });

        it('clears stale metadata from removed files on rebuild', async function () {
            // First build: a.kif + b.kif both present.
            // Second build: only a.kif (b.kif removed from KB).
            // getWorkspaceMetadata() must not contain symbols from b.kif after rebuild.
            const docMap = new Map([
                ['/test/a.kif', createMockDocument('(domain onlyInA 1 Agent)', '/test/a.kif')],
                ['/test/b.kif', createMockDocument('(domain onlyInB 1 Entity)', '/test/b.kif')]
            ]);

            // buildWorkspaceDefinitions calls parseConfigXml twice per invocation:
            // once from getKBs() and once from getKBFiles(). Use onCall() to cover
            // both calls for each of the two buildWorkspaceDefinitions() invocations.
            const bothFiles = {
                knowledgeBases: { SUMO: { constituents: ['/test/a.kif', '/test/b.kif'] } },
                preferences: { kbDir: '/test' }
            };
            const onlyA = {
                knowledgeBases: { SUMO: { constituents: ['/test/a.kif'] } },
                preferences: { kbDir: '/test' }
            };
            const parseConfigStub = sinon.stub();
            parseConfigStub.onCall(0).resolves(bothFiles); // first build: getKBs()
            parseConfigStub.onCall(1).resolves(bothFiles); // first build: getKBFiles()
            parseConfigStub.onCall(2).resolves(onlyA);     // second build: getKBs()
            parseConfigStub.onCall(3).resolves(onlyA);     // second build: getKBFiles()

            const { mod } = setupNavForBuild(parseConfigStub, docMap);

            await mod.buildWorkspaceDefinitions();
            expect(mod.getWorkspaceMetadata()).to.have.property('onlyInB'); // sanity: first build loaded b.kif

            await mod.buildWorkspaceDefinitions();
            const meta = mod.getWorkspaceMetadata();
            expect(meta).to.not.have.property('onlyInB',
                'metadata from removed b.kif must be cleared on rebuild');
            expect(meta).to.have.property('onlyInA');
        });
    });

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
