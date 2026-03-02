'use strict';

const assert = require('assert');
const vscode = require('vscode');
const { ensureExtensionActive, openFixture, closeAllEditors, placeCursorOn, sleep } = require('./helpers');

suite('sumo.browseInSigma', function () {
    this.timeout(30_000);

    suiteSetup(ensureExtensionActive);
    afterEach(closeAllEditors);

    test('command is registered', async () => {
        const commands = await vscode.commands.getCommands(true);
        assert.ok(commands.includes('sumo.browseInSigma'),
            'sumo.browseInSigma must be registered');
    });

    test('does not throw when cursor is on a known symbol', async () => {
        const { editor } = await openFixture('simple.kif');
        await sleep(800);
        placeCursorOn(editor, 'Cat');
        await vscode.commands.executeCommand('sumo.browseInSigma');
        await sleep(400);
    });

    test('does not throw when no editor is active', async () => {
        await closeAllEditors();
        await vscode.commands.executeCommand('sumo.browseInSigma');
    });
});
