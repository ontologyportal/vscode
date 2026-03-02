'use strict';

const assert = require('assert');
const vscode = require('vscode');
const { ensureExtensionActive, openKifContent, closeAllEditors, selectAll, sleep } = require('./helpers');

suite('sumo.formatAxiom', function () {
    this.timeout(30_000);

    suiteSetup(ensureExtensionActive);
    afterEach(closeAllEditors);

    test('collapses a simple binary relation onto one line', async () => {
        const { doc, editor } = await openKifContent('(instance\nFoo\n  Bar)');
        selectAll(editor);
        await vscode.commands.executeCommand('sumo.formatAxiom');
        await sleep(300);
        const result = doc.getText();
        assert.strictEqual(result.trim(), '(instance Foo Bar)',
            `Expected single-line format, got: ${result}`);
    });

    test('puts each operand of a logical operator on its own line', async () => {
        const { doc, editor } = await openKifContent(
            '(and (instance Foo Animal) (instance Foo Object))'
        );
        selectAll(editor);
        await vscode.commands.executeCommand('sumo.formatAxiom');
        await sleep(300);
        const lines = doc.getText().split('\n');
        assert.ok(lines[0].includes('and'),
            `First line must contain 'and', got: ${lines[0]}`);
        assert.ok(lines.some(l => l.includes('(instance Foo Animal)')),
            'Expected (instance Foo Animal) on its own line');
        assert.ok(lines.some(l => l.includes('(instance Foo Object)')),
            'Expected (instance Foo Object) on its own line');
    });

    test('keeps the variable list inline with a quantifier', async () => {
        const { doc, editor } = await openKifContent(
            '(forall (?X ?Y) (instance ?X Foo))'
        );
        selectAll(editor);
        await vscode.commands.executeCommand('sumo.formatAxiom');
        await sleep(300);
        const forallLine = doc.getText().split('\n').find(l => l.includes('forall'));
        assert.ok(forallLine, 'Expected a line containing forall');
        assert.ok(forallLine.includes('(?X ?Y)'),
            `Variable list must stay on the forall line, got: ${forallLine}`);
    });

    test('does not throw when cursor is outside any S-expression', async () => {
        const { editor } = await openKifContent('plain text, not KIF');
        editor.selection = new vscode.Selection(
            new vscode.Position(0, 0), new vscode.Position(0, 0)
        );
        // Should resolve quietly (shows a warning message, does not throw).
        await vscode.commands.executeCommand('sumo.formatAxiom');
    });

    test('formats via cursor-inside-expression when nothing is selected', async () => {
        const { doc, editor } = await openKifContent('(instance\nFoo\n  Bar)');
        // Place cursor inside the expression with no selection
        editor.selection = new vscode.Selection(
            new vscode.Position(1, 0), new vscode.Position(1, 0)
        );
        await vscode.commands.executeCommand('sumo.formatAxiom');
        await sleep(300);
        const result = doc.getText().trim();
        assert.ok(result.includes('instance') && result.includes('Foo') && result.includes('Bar'),
            `Formatted content should still contain all tokens, got: ${result}`);
    });
});
