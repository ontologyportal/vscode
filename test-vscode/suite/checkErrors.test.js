'use strict';

const assert = require('assert');
const vscode = require('vscode');
const { ensureExtensionActive, openFixture, openKifContent, closeAllEditors, sleep } = require('./helpers');

suite('sumo.checkErrors', function () {
    this.timeout(30_000);

    suiteSetup(ensureExtensionActive);
    afterEach(closeAllEditors);

    test('reports a warning when class argument of subclass starts with lowercase', async () => {
        const { doc } = await openFixture('errors.kif');
        await vscode.commands.executeCommand('sumo.checkErrors');
        await sleep(800);

        const diags = vscode.languages.getDiagnostics(doc.uri);
        assert.ok(diags.length > 0, 'Expected at least one diagnostic for errors.kif');
        assert.ok(
            diags.some(d => d.message.toLowerCase().includes('uppercase')),
            `Expected a capitalisation diagnostic; got: ${diags.map(d => d.message).join(' | ')}`
        );
    });

    test('produces no errors for well-formed KIF', async () => {
        const { doc } = await openFixture('simple.kif');
        await vscode.commands.executeCommand('sumo.checkErrors');
        await sleep(800);

        const diags = vscode.languages.getDiagnostics(doc.uri);
        const errors = diags.filter(d => d.severity === vscode.DiagnosticSeverity.Error);
        assert.strictEqual(errors.length, 0,
            `Expected no errors for simple.kif; got: ${errors.map(d => d.message).join(' | ')}`);
    });

    test('validates an in-memory document without throwing', async () => {
        const { doc } = await openKifContent('(subclass cat Mammal)');
        await vscode.commands.executeCommand('sumo.checkErrors');
        await sleep(600);

        const diags = vscode.languages.getDiagnostics(doc.uri);
        assert.ok(
            diags.some(d => d.message.toLowerCase().includes('uppercase')),
            `Expected a capitalisation diagnostic; got: ${diags.map(d => d.message).join(' | ')}`
        );
    });

    test('flags arity violations when domain declarations are present', async () => {
        // (knows Alice) — knows has domain at positions 1 and 2, so 1 arg is too few.
        const kif = '(domain knows 1 Agent)\n(domain knows 2 Entity)\n(knows Alice)';
        const { doc } = await openKifContent(kif);
        await vscode.commands.executeCommand('sumo.checkErrors');
        await sleep(600);

        const diags = vscode.languages.getDiagnostics(doc.uri);
        assert.ok(
            diags.some(d => d.message.includes('knows')),
            `Expected an arity diagnostic for 'knows'; got: ${diags.map(d => d.message).join(' | ')}`
        );
    });
});
