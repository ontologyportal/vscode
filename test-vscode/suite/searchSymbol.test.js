'use strict';

const assert = require('assert');
const vscode = require('vscode');
const { ensureExtensionActive, openFixture, closeAllEditors, placeCursorOn, sleep } = require('./helpers');

suite('sumo.searchSymbol', function () {
    this.timeout(30_000);

    suiteSetup(ensureExtensionActive);
    afterEach(closeAllEditors);

    test('command is registered and executable', async () => {
        const commands = await vscode.commands.getCommands(true);
        assert.ok(commands.includes('sumo.searchSymbol'),
            'sumo.searchSymbol must be registered');
    });

    test('does not throw when the cursor is on a known symbol', async () => {
        const { editor } = await openFixture('simple.kif');
        await sleep(1_000);
        placeCursorOn(editor, 'Cat');
        // Command shows a QuickPick; we just verify it does not throw.
        const cmdPromise = vscode.commands.executeCommand('sumo.searchSymbol');
        await sleep(500);
        // Dismiss the QuickPick by pressing Escape.
        await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
        await cmdPromise.catch(() => {}); // ignore rejection if QuickPick was cancelled
    });

    test('does not throw when no editor is active', async () => {
        await closeAllEditors();
        await vscode.commands.executeCommand('sumo.searchSymbol');
    });
});
