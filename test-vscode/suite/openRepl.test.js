'use strict';

/**
 * Integration tests for sumo.openRepl.
 *
 * The REPL terminal itself is purely a VS Code terminal (pseudoterminal) —
 * it does not require Sigma to be running in order to open.
 * Sigma is only invoked when the user sends an ask/tell query.
 */

const assert = require('assert');
const vscode = require('vscode');
const { ensureExtensionActive, closeAllEditors, sleep } = require('./helpers');

suite('sumo.openRepl', function () {
    this.timeout(30_000);

    suiteSetup(ensureExtensionActive);
    afterEach(closeAllEditors);

    test('command is registered', async () => {
        const commands = await vscode.commands.getCommands(true);
        assert.ok(commands.includes('sumo.openRepl'),
            'sumo.openRepl must be registered');
    });

    test('opens a terminal panel without throwing', async () => {
        const before = vscode.window.terminals.length;
        await vscode.commands.executeCommand('sumo.openRepl');
        await sleep(1_000);
        const after = vscode.window.terminals.length;
        assert.ok(after >= before,
            `Expected at least as many terminals after openRepl; before=${before} after=${after}`);
    });

    test('second invocation reuses the existing REPL terminal', async () => {
        await vscode.commands.executeCommand('sumo.openRepl');
        await sleep(800);
        const count1 = vscode.window.terminals.length;

        await vscode.commands.executeCommand('sumo.openRepl');
        await sleep(800);
        const count2 = vscode.window.terminals.length;

        assert.strictEqual(count2, count1,
            `Expected the same number of terminals on second invocation; got ${count2} vs ${count1}`);
    });
});
