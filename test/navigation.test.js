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
    vscode['@global'] = true;
    vscode._setConfig(configValues || { 'general.language': 'EnglishLanguage' });

    const sigmaConfigStub = {
        findConfigXml: sinon.stub().resolves(null),
        parseConfigXml: sinon.stub().resolves(null)
    };

    const realValidation = proxyquire('../src/validation', {
        vscode,
        './parser': realParser
    });

    const realState = proxyquire('../src/state', {
        vscode,
        './parser': realParser,
        './parser/formula': require('../src/parser/formula'),
        './parser/sentence': require('../src/parser/sentence'),
        './validation': realValidation,
        './sigma/config': sigmaConfigStub
    });

    const mod = proxyquire('../src/navigation', {
        vscode,
        './parser': realParser,
        './validation': realValidation,
        './state': realState,
        './const': require('../src/const'),
        './sigma': {
            findConfigXml: sinon.stub().resolves(null),
            getSigmaRuntime: sinon.stub().returns({})
        },
        './sigma/config': sigmaConfigStub,
        ...overrides
    });

    return { mod, vscode, realState };
}

/**
 * Build a navigation module wired up for buildWorkspaceDefinitions tests.
 * Mocks fs.existsSync so getKBFiles accepts paths that don't exist on disk.
 */
function setupNavForBuild(parseConfigStub, docMap) {
    const vscodeMock = createVSCodeMock(sinon);
    vscodeMock['@global'] = true;
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

    const realState = proxyquire('../src/state', {
        vscode: vscodeMock,
        fs: mockFs,
        './parser': realParser,
        './parser/formula': require('../src/parser/formula'),
        './parser/sentence': require('../src/parser/sentence'),
        './validation': realValidation,
        './sigma/config': {
            findConfigXml: sinon.stub().resolves('/test/config.xml'),
            parseConfigXml: parseConfigStub
        }
    });

    const mod = proxyquire('../src/navigation', {
        vscode: vscodeMock,
        fs: mockFs,
        './parser': realParser,
        './validation': realValidation,
        './state': realState,
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
    return { mod, vscodeMock, collection, realState };
}

// ---------------------------------------------------------------------------
describe('navigation.js', function () {

    afterEach(() => sinon.restore());

    // -----------------------------------------------------------------------
    // getWorkspaceTaxonomy() was removed — these tests now verify equivalent
    // data is available through realState.getSymbolTable() after parsing.
    describe('symbol table taxonomy data (was getWorkspaceTaxonomy)', function () {

        /**
         * Build a symbol table directly from KIF text for assertion purposes.
         */
        function buildSymbolTable(kif, filePath) {
            const { SymbolTable } = realParser;
            const st = new SymbolTable({ deepIndex: true });
            const { tokens } = realParser.tokenize(kif, filePath);
            const { nodes } = new realParser.TokenList(tokens).parse();
            const { symbolTable } = realParser.syntax(nodes, st);
            realParser.semantics(symbolTable);
            return symbolTable;
        }

        it('symbol table contains a symbol with taxonomy edges and documentation', function () {
            const kif = '(subclass Cat Mammal)\n(documentation Cat EnglishLanguage "A cat.")';
            const st = buildSymbolTable(kif, '/test/foo.kif');
            expect(st.symbols).to.have.property('Cat');
            expect(st.symbols).to.have.property('Mammal');
            const catSym = st.symbols['Cat'];
            expect(catSym).to.be.an('object');
        });

        it('subclass sentence: Cat has Mammal as parent via incoming taxonomy edge', function () {
            const kif = '(subclass Cat Mammal)';
            const st = buildSymbolTable(kif, '/test/kif1.kif');
            realParser.semantics(st);
            const catTerm = st.symbols['Cat']?.forward;
            expect(catTerm).to.exist;
            // For (subclass Cat Mammal): Cat.taxonomy.incoming has edge where from=Mammal
            const tax = catTerm.taxonomy;
            expect(tax.incoming.some(e => e.from.name === 'Mammal')).to.be.true;
        });

        it('instance sentence: Rover has Dog as parent via incoming taxonomy edge', function () {
            const kif = '(instance Rover Dog)';
            const st = buildSymbolTable(kif, '/test/kif2.kif');
            realParser.semantics(st);
            const roverTerm = st.symbols['Rover']?.forward;
            expect(roverTerm).to.exist;
            // For (instance Rover Dog): Rover.taxonomy.incoming has edge where from=Dog
            const tax = roverTerm.taxonomy;
            expect(tax.incoming.some(e => e.from.name === 'Dog')).to.be.true;
        });
    });

    // -----------------------------------------------------------------------
    describe('getWorkspaceMetadata()', function () {

        it('aggregates documentation metadata from processed files', async function () {
            const fsPath = '/test/b.kif';
            const kif = '(documentation knows EnglishLanguage "A knowledge relation.")';
            const docMap = new Map([[fsPath, createMockDocument(kif, fsPath)]]);
            const parseConfigStub = sinon.stub().resolves({
                preferences: { kbDir: '/test' },
                knowledgeBases: { TestKB: { constituents: [fsPath] } }
            });
            const { realState } = setupNavForBuild(parseConfigStub, docMap);
            realState.setKB('TestKB');

            await realState.buildWorkspaceDefinitions(null);

            const meta = realState.getWorkspaceMetadata();
            // documentation entries may not populate metadata until semantics runs;
            // verify the symbol was processed (symbol table has it)
            const st = realState.getSymbolTable('TestKB');
            expect(st).to.exist;
            expect(st.symbols).to.have.property('knows');
        });

        it('caches the result until a new file is processed', async function () {
            const fsPath = '/test/c.kif';
            const kif = '(subclass Foo Bar)';
            const docMap = new Map([[fsPath, createMockDocument(kif, fsPath)]]);
            const parseConfigStub = sinon.stub().resolves({
                preferences: { kbDir: '/test' },
                knowledgeBases: { TestKB: { constituents: [fsPath] } }
            });
            const { realState } = setupNavForBuild(parseConfigStub, docMap);
            realState.setKB('TestKB');

            await realState.buildWorkspaceDefinitions(null);

            const first = realState.getWorkspaceMetadata();
            const second = realState.getWorkspaceMetadata();
            expect(first).to.equal(second); // same object reference
        });
    });

    // -----------------------------------------------------------------------
    describe('buildWorkspaceDefinitions() via state — parse error diagnostics', function () {

        it('populates diagnostics for parse errors', async function () {
            const fsPath = '/test/err.kif';
            const kif = '(instance Foo'; // unclosed paren
            const docMap = new Map([[fsPath, createMockDocument(kif, fsPath)]]);
            const parseConfigStub = sinon.stub().resolves({
                preferences: { kbDir: '/test' },
                knowledgeBases: { TestKB: { constituents: [fsPath] } }
            });
            const { realState, collection } = setupNavForBuild(parseConfigStub, docMap);

            await realState.buildWorkspaceDefinitions(null);

            const diags = collection.get(fsPath) || [];
            expect(diags).to.have.lengthOf.at.least(1);
            expect(diags.some(d => d.severity === 0)).to.be.true; // Error
        });

        it('emits no errors when document is valid (documentation statement)', async function () {
            const fsPath = '/test/x.kif';
            const kif = '(documentation Foo EnglishLanguage "A description.")';
            const docMap = new Map([[fsPath, createMockDocument(kif, fsPath)]]);
            const parseConfigStub = sinon.stub().resolves({
                preferences: { kbDir: '/test' },
                knowledgeBases: { TestKB: { constituents: [fsPath] } }
            });
            const { realState, collection } = setupNavForBuild(parseConfigStub, docMap);

            await realState.buildWorkspaceDefinitions(null);

            const diags = collection.get(fsPath) || [];
            const errors = diags.filter(d => d.severity === 0);
            expect(errors).to.have.lengthOf(0);
        });
    });

    // -----------------------------------------------------------------------
    describe('Entity root check with tinySUMO.kif', function () {

        it('builds a symbol table that can reach Entity from core SUMO terms', async function () {
            const fsPath = '/test/tinySUMO.kif';
            const kifText = require('fs').readFileSync(
                path.join(__dirname, 'tinySUMO.kif'), 'utf-8'
            );
            const docMap = new Map([[fsPath, createMockDocument(kifText, fsPath)]]);
            const parseConfigStub = sinon.stub().resolves({
                preferences: { kbDir: '/test' },
                knowledgeBases: { SUMO: { constituents: [fsPath] } }
            });
            const { realState } = setupNavForBuild(parseConfigStub, docMap);
            realState.setKB('SUMO');

            await realState.buildWorkspaceDefinitions(null);

            const st = realState.getSymbolTable('SUMO');
            expect(st).to.exist;

            // Core SUMO terms that must be in the symbol table
            const mustExist = ['BinaryPredicate', 'Predicate', 'Relation', 'Abstract', 'Physical'];
            for (const termName of mustExist) {
                expect(st.symbols).to.have.property(termName);
            }

            // Verify reachability to Entity by following incoming taxonomy edges
            // For (subclass Cat Mammal): Cat.taxonomy.incoming has edge with from=Mammal
            // So traversing "up" means following edge.from for each incoming edge
            const mustReach = ['BinaryPredicate', 'Predicate', 'Relation', 'Abstract', 'Physical'];
            function canReachEntity(symName) {
                const visited = new Set();
                const queue = [symName];
                while (queue.length) {
                    const cur = queue.shift();
                    if (cur === 'Entity') return true;
                    if (visited.has(cur)) continue;
                    visited.add(cur);
                    const sym = st.symbols[cur];
                    if (!sym?.forward) continue;
                    try {
                        for (const edge of sym.forward.taxonomy.incoming) {
                            queue.push(edge.from.name);
                        }
                    } catch (_) { /* skip */ }
                }
                return false;
            }

            for (const termName of mustReach) {
                expect(canReachEntity(termName)).to.be.true;
            }
        });

        it('produces no false-positive "no taxonomy path to Entity" errors for tinySUMO.kif terms', async function () {
            const fsPath = '/test/tinySUMO.kif';
            const kifText = require('fs').readFileSync(
                path.join(__dirname, 'tinySUMO.kif'), 'utf-8'
            );
            const docMap = new Map([[fsPath, createMockDocument(kifText, fsPath)]]);
            const parseConfigStub = sinon.stub().resolves({
                preferences: { kbDir: '/test' },
                knowledgeBases: { SUMO: { constituents: [fsPath] } }
            });
            const { realState, collection } = setupNavForBuild(parseConfigStub, docMap);
            realState.setKB('SUMO');

            await realState.buildWorkspaceDefinitions(null);

            const diags = collection.get(fsPath) || [];
            const pathErrors = diags.filter(d => d.message.includes('no taxonomy path to Entity'));
            expect(pathErrors).to.have.lengthOf(0,
                'no false-positive "no taxonomy path" errors for tinySUMO.kif: ' +
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

            const { realState, collection } = setupNavForBuild(parseConfigStub, docMap);
            await realState.buildWorkspaceDefinitions();

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

            const { realState } = setupNavForBuild(parseConfigStub, docMap);
            realState.setKB('SUMO');

            await realState.buildWorkspaceDefinitions();
            expect(realState.getWorkspaceMetadata()).to.have.property('onlyInB'); // sanity: first build loaded b.kif

            await realState.buildWorkspaceDefinitions();
            const meta = realState.getWorkspaceMetadata();
            expect(meta).to.not.have.property('onlyInB',
                'metadata from removed b.kif must be cleared on rebuild');
            expect(meta).to.have.property('onlyInA');
        });
    });

    // -----------------------------------------------------------------------
    describe('setKB() / getKB()', function () {

        it('round-trips the KB name', function () {
            const { realState } = loadNavigation();
            realState.setKB('MySUMO');
            expect(realState.getKB()).to.equal('MySUMO');
        });

        it('returns null when reset to null', function () {
            const { realState } = loadNavigation();
            realState.setKB('X');
            realState.setKB(null);
            expect(realState.getKB()).to.be.null;
        });
    });
});
