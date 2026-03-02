'use strict';

const assert = require('assert');
const vscode = require('vscode');
const { ensureExtensionActive, openFixture, closeAllEditors, sleep } = require('./helpers');
const { generateTaxonomyHtml } = require('../../src/taxonomy');

suite('sumo.showTaxonomy', function () {
    this.timeout(30_000);

    suiteSetup(ensureExtensionActive);
    afterEach(closeAllEditors);

    // ------------------------------------------------------------------
    // HTML generation (unit-level, no VS Code panel needed)
    // ------------------------------------------------------------------

    suite('generateTaxonomyHtml()', function () {
        const parents  = { Cat: [{ name: 'Mammal', type: 'subclass' }], Mammal: [{ name: 'Animal', type: 'subclass' }] };
        const children = { Mammal: [{ name: 'Cat', type: 'subclass' }], Animal: [{ name: 'Mammal', type: 'subclass' }] };

        test('includes the target symbol in the output', () => {
            const html = generateTaxonomyHtml('Cat', parents, children, {}, '', '', '', {});
            assert.ok(html.toString().includes('Cat'),
                'HTML must mention the target symbol "Cat"');
        });

        test('includes direct parent in the output', () => {
            const html = generateTaxonomyHtml('Cat', parents, children, {}, '', '', '', {});
            assert.ok(html.toString().includes('Mammal'),
                'HTML must mention the direct parent "Mammal"');
        });

        test('includes ancestor in the output', () => {
            const html = generateTaxonomyHtml('Cat', parents, children, {}, '', '', '', {});
            assert.ok(html.toString().includes('Animal'),
                'HTML must mention ancestor "Animal"');
        });

        test('includes a child symbol when provided', () => {
            const extParents  = { ...parents, Kitten: [{ name: 'Cat', type: 'subclass' }] };
            const extChildren = { ...children, Cat: [{ name: 'Kitten', type: 'subclass' }] };
            const html = generateTaxonomyHtml('Cat', extParents, extChildren, {}, '', '', '', {});
            assert.ok(html.toString().includes('Kitten'),
                'HTML must mention child symbol "Kitten"');
        });
    });

    // ------------------------------------------------------------------
    // Command execution (integration — verifies panel appears)
    // ------------------------------------------------------------------

    test('opens a webview panel titled "Taxonomy: Cat"', async () => {
        await openFixture('simple.kif');
        await sleep(1_500); // allow the workspace to be indexed

        await vscode.commands.executeCommand('sumo.showTaxonomy', 'Cat');
        await sleep(1_000);

        // VS Code 1.71+ exposes open tabs through window.tabGroups.
        const tabs = vscode.window.tabGroups.all.flatMap(g => g.tabs);
        const taxonomyTab = tabs.find(t => t.label && t.label.includes('Taxonomy'));
        assert.ok(taxonomyTab,
            `Expected a tab whose label includes "Taxonomy"; open tabs: ${tabs.map(t => t.label).join(', ')}`);
    });

    test('does not throw for an unrecognised symbol', async () => {
        await openFixture('simple.kif');
        await sleep(1_000);
        // Should resolve quietly (may show "no results" in the panel).
        await vscode.commands.executeCommand('sumo.showTaxonomy', 'CompletelyUnknownSymbol999');
    });
});
