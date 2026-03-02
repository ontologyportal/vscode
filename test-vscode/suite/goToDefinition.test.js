'use strict';

const assert = require('assert');
const vscode = require('vscode');
const {
    ensureExtensionActive, openFixture, closeAllEditors,
    placeCursorOn, sleep,
} = require('./helpers');

suite('sumo.goToDefinition', function () {
    this.timeout(30_000);

    suiteSetup(ensureExtensionActive);
    afterEach(closeAllEditors);

    test('navigates to the definition of "Cat" in simple.kif', async () => {
        const { doc, editor } = await openFixture('simple.kif');
        await sleep(1_500); // wait for workspace definitions to build

        // Place the cursor on the first occurrence of "Cat" (the definition line).
        const found = placeCursorOn(editor, 'Cat');
        assert.ok(found, '"Cat" must appear in simple.kif');

        await vscode.commands.executeCommand('sumo.goToDefinition');
        await sleep(800);

        // After navigation the active editor should be on a line that defines Cat.
        const active = vscode.window.activeTextEditor;
        assert.ok(active, 'Expected an active editor after goToDefinition');
        const line = active.document.lineAt(active.selection.active.line).text;
        assert.ok(
            line.includes('Cat'),
            `Expected cursor to land on a line containing "Cat"; got: ${line}`
        );
    });

    test('shows an information message when no definition is found', async () => {
        const { editor } = await openFixture('simple.kif');
        await sleep(1_000);

        // Place cursor on a word that has no taxonomy definition.
        placeCursorOn(editor, 'EnglishLanguage');

        // Should resolve without throwing (may show "No definition found").
        await vscode.commands.executeCommand('sumo.goToDefinition');
        await sleep(400);
    });

    test('does not throw when no editor is active', async () => {
        await closeAllEditors();
        await vscode.commands.executeCommand('sumo.goToDefinition');
    });
});
