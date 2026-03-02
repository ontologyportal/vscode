'use strict';

/**
 * Shared utilities for VS Code integration tests.
 */

const vscode = require('vscode');
const path   = require('path');
const fs     = require('fs');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const WORKSPACE_PATH = path.resolve(__dirname, '../../test-fixtures/workspace');
const SUMO_PATH      = process.env.SUMO_PATH      || path.resolve(__dirname, '../../../sumo');
const SIGMAKEE_JAR   = process.env.SIGMAKEE_JAR   || '';
const SIGMAKEE_LIBS  = process.env.SIGMAKEE_LIBS  || '';
const PROVER_PATH    = process.env.PROVER_PATH    || '';

const hasSigma  = Boolean(SIGMAKEE_JAR && fs.existsSync(SIGMAKEE_JAR));
const hasProver = Boolean(PROVER_PATH  && fs.existsSync(PROVER_PATH));

// ---------------------------------------------------------------------------
// Extension activation
// ---------------------------------------------------------------------------

/**
 * Waits for the SUMO extension to activate.
 * Call this in suiteSetup() before running any command tests.
 */
async function ensureExtensionActive() {
    const ext = vscode.extensions.getExtension('ontologyportal.sumo');
    if (!ext) throw new Error('SUMO extension (ontologyportal.sumo) not found in extension host');
    if (!ext.isActive) await ext.activate();
    await sleep(800); // allow async initialisation to settle
}

// ---------------------------------------------------------------------------
// Editor helpers
// ---------------------------------------------------------------------------

/**
 * Opens a named fixture file from the test workspace and shows it in an editor.
 * @param {string} filename  Filename relative to test-fixtures/workspace
 * @returns {{ doc: vscode.TextDocument, editor: vscode.TextEditor }}
 */
async function openFixture(filename) {
    const filePath = path.join(WORKSPACE_PATH, filename);
    const doc      = await vscode.workspace.openTextDocument(filePath);
    const editor   = await vscode.window.showTextDocument(doc, { preview: false });
    await sleep(600); // let the extension index the file
    return { doc, editor };
}

/**
 * Opens an in-memory KIF document (no file on disk).
 * @param {string} content  KIF source text
 * @returns {{ doc: vscode.TextDocument, editor: vscode.TextEditor }}
 */
async function openKifContent(content) {
    const doc    = await vscode.workspace.openTextDocument({ content, language: 'suo-kif' });
    const editor = await vscode.window.showTextDocument(doc, { preview: false });
    await sleep(400);
    return { doc, editor };
}

/**
 * Closes all open editors.
 */
async function closeAllEditors() {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await sleep(200);
}

/**
 * Selects the entire content of the active document.
 */
function selectAll(editor) {
    const doc = editor.document;
    const end = doc.positionAt(doc.getText().length);
    editor.selection = new vscode.Selection(new vscode.Position(0, 0), end);
}

/**
 * Positions the cursor at the first occurrence of `word` in the document.
 * @returns {boolean} true if the word was found
 */
function placeCursorOn(editor, word) {
    const text  = editor.document.getText();
    const idx   = text.indexOf(word);
    if (idx < 0) return false;
    const pos   = editor.document.positionAt(idx);
    editor.selection = new vscode.Selection(pos, pos);
    return true;
}

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------

module.exports = {
    WORKSPACE_PATH,
    SUMO_PATH,
    SIGMAKEE_JAR,
    SIGMAKEE_LIBS,
    PROVER_PATH,
    hasSigma,
    hasProver,
    ensureExtensionActive,
    openFixture,
    openKifContent,
    closeAllEditors,
    selectAll,
    placeCursorOn,
    sleep,
};
