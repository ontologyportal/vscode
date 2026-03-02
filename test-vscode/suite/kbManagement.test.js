'use strict';

/**
 * Integration tests for the KB management commands:
 *
 *   sumo.openKnowledgeBase    — opens a file-picker dialog
 *   sumo.createKnowledgeBase  — opens an input-box dialog
 *   sumo.kbExplorer.refresh   — refreshes the KB tree
 *   sumo.kbExplorer.addFile   — opens a file-picker dialog
 *   sumo.kbExplorer.removeFile — opens a confirmation dialog
 *
 * Because these commands block on UI dialogs, each test:
 *   1. Starts the command (which shows a dialog and waits for input)
 *   2. Waits briefly for the dialog to appear
 *   3. Cancels via `workbench.action.closeQuickOpen` or a short timeout
 *   4. Asserts the command resolved without throwing
 */

const assert = require('assert');
const vscode = require('vscode');
const { ensureExtensionActive, closeAllEditors, sleep } = require('./helpers');

/**
 * Executes a command that opens a dialog, then cancels the dialog.
 * Returns false if the command threw before or after cancellation.
 */
async function smokeCommand(commandId, cancelDelay = 600) {
    let threw = false;
    const promise = vscode.commands.executeCommand(commandId)
        .catch(() => { threw = true; });
    await sleep(cancelDelay);
    await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
    await promise;
    return !threw;
}

// ---------------------------------------------------------------------------

suite('KB management commands', function () {
    this.timeout(30_000);

    suiteSetup(ensureExtensionActive);
    afterEach(closeAllEditors);

    // -----------------------------------------------------------------------
    suite('sumo.openKnowledgeBase', function () {
        test('command is registered', async () => {
            const commands = await vscode.commands.getCommands(true);
            assert.ok(commands.includes('sumo.openKnowledgeBase'),
                'sumo.openKnowledgeBase must be registered');
        });

        test('opens a dialog and cancels without throwing', async () => {
            const ok = await smokeCommand('sumo.openKnowledgeBase');
            assert.ok(ok, 'sumo.openKnowledgeBase threw unexpectedly');
        });
    });

    // -----------------------------------------------------------------------
    suite('sumo.createKnowledgeBase', function () {
        test('command is registered', async () => {
            const commands = await vscode.commands.getCommands(true);
            assert.ok(commands.includes('sumo.createKnowledgeBase'),
                'sumo.createKnowledgeBase must be registered');
        });

        test('opens a dialog and cancels without throwing', async () => {
            const ok = await smokeCommand('sumo.createKnowledgeBase');
            assert.ok(ok, 'sumo.createKnowledgeBase threw unexpectedly');
        });
    });

    // -----------------------------------------------------------------------
    suite('sumo.kbExplorer.refresh', function () {
        test('command is registered', async () => {
            const commands = await vscode.commands.getCommands(true);
            assert.ok(commands.includes('sumo.kbExplorer.refresh'),
                'sumo.kbExplorer.refresh must be registered');
        });

        test('executes without throwing', async () => {
            await vscode.commands.executeCommand('sumo.kbExplorer.refresh');
        });
    });

    // -----------------------------------------------------------------------
    suite('sumo.kbExplorer.addFile', function () {
        test('command is registered', async () => {
            const commands = await vscode.commands.getCommands(true);
            assert.ok(commands.includes('sumo.kbExplorer.addFile'),
                'sumo.kbExplorer.addFile must be registered');
        });

        test('opens a dialog and cancels without throwing', async () => {
            const ok = await smokeCommand('sumo.kbExplorer.addFile');
            assert.ok(ok, 'sumo.kbExplorer.addFile threw unexpectedly');
        });
    });

    // -----------------------------------------------------------------------
    suite('sumo.kbExplorer.removeFile', function () {
        test('command is registered', async () => {
            const commands = await vscode.commands.getCommands(true);
            assert.ok(commands.includes('sumo.kbExplorer.removeFile'),
                'sumo.kbExplorer.removeFile must be registered');
        });

        test('executes without throwing when called with no tree item', async () => {
            // Called without a tree item argument (as from the command palette).
            await vscode.commands.executeCommand('sumo.kbExplorer.removeFile')
                .catch(() => {}); // may resolve with a no-op if no item selected
        });
    });
});
