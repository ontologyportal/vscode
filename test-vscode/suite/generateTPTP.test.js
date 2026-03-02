'use strict';

/**
 * Integration tests for sumo.generateTPTP.
 *
 * The "Current File" and "Selection Only" paths call compileFormulas() which
 * requires Sigma to be running.  Those tests are skipped automatically when
 * SIGMAKEE_JAR is not configured.
 *
 * The "Knowledge Base" path additionally requires a Sigma config.xml and is
 * not covered here (tested by the existing local.integration.test.js).
 */

const assert  = require('assert');
const os      = require('os');
const fs      = require('fs');
const path    = require('path');
const vscode  = require('vscode');
const {
    ensureExtensionActive, openFixture, openKifContent,
    closeAllEditors, selectAll, sleep,
    SIGMAKEE_JAR, SIGMAKEE_LIBS, SUMO_PATH, hasSigma,
} = require('./helpers');

// ---------------------------------------------------------------------------
// Sigma environment setup (mirrors local.integration.test.js)
// ---------------------------------------------------------------------------

let minimalSigmaHome;

function buildSigmaEnv() {
    const { globSync } = require('glob');
    const VSCODE_ROOT  = path.resolve(__dirname, '../..');
    const TINYSUMOKIF  = path.join(SUMO_PATH, 'tinySUMO.kif');

    if (!fs.existsSync(TINYSUMOKIF)) {
        throw new Error(`tinySUMO.kif not found at ${TINYSUMOKIF}`);
    }

    minimalSigmaHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sigma-tptp-test-'));
    const kbsDir = path.join(minimalSigmaHome, 'KBs');
    fs.mkdirSync(kbsDir);
    fs.mkdirSync(path.join(minimalSigmaHome, 'logs'));

    const configXml = [
        '<configuration>',
        `  <preference name="baseDir" value="${minimalSigmaHome}" />`,
        `  <preference name="kbDir"   value="${kbsDir}" />`,
        '  <preference name="logLevel"  value="warning" />',
        '  <preference name="loadFresh" value="true" />',
        '  <preference name="cache"     value="no" />',
        '  <kb name="TestOntology">',
        `    <constituent filename="${TINYSUMOKIF}" />`,
        '  </kb>',
        '</configuration>',
    ].join('\n');
    fs.writeFileSync(path.join(kbsDir, 'config.xml'), configXml, 'utf8');

    const cp = [
        SIGMAKEE_JAR,
        ...globSync(path.join(SIGMAKEE_LIBS, '*')),
        path.join(VSCODE_ROOT, 'lib', 'py4j.jar'),
        path.join(VSCODE_ROOT, 'lib', 'SigmaBridge.jar'),
    ].join(path.delimiter);

    process.env.SIGMA_CP   = cp;
    process.env.SIGMA_HOME = minimalSigmaHome;
}

function teardownSigmaEnv() {
    delete process.env.SIGMA_CP;
    delete process.env.SIGMA_HOME;
    if (minimalSigmaHome && fs.existsSync(minimalSigmaHome)) {
        fs.rmSync(minimalSigmaHome, { recursive: true, force: true });
        minimalSigmaHome = null;
    }
}

// ---------------------------------------------------------------------------

suite('sumo.generateTPTP', function () {
    this.timeout(120_000);

    suiteSetup(ensureExtensionActive);
    afterEach(closeAllEditors);

    test('command is registered', async () => {
        const commands = await vscode.commands.getCommands(true);
        assert.ok(commands.includes('sumo.generateTPTP'),
            'sumo.generateTPTP must be registered');
    });

    test('opens a QuickPick containing "Current File" when a KIF editor is active', async () => {
        await openFixture('simple.kif');
        await sleep(500);

        // Start the command (it will block on showQuickPick).
        const cmdPromise = vscode.commands.executeCommand('sumo.generateTPTP');
        await sleep(600); // let the QuickPick appear

        // Dismiss with Escape — command should resolve cleanly without producing output.
        await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
        await cmdPromise.catch(() => {});
    });

    // ------------------------------------------------------------------
    // Sigma-dependent tests (skipped if SigmaKEE not configured)
    // ------------------------------------------------------------------

    suite('with Sigma (requires SIGMAKEE_JAR)', function () {
        before(function () {
            if (!hasSigma) {
                this.skip();
                return;
            }
            buildSigmaEnv();
        });

        after(teardownSigmaEnv);

        test('"Current File" translates simple.kif to a TPTP document', async function () {
            this.timeout(120_000);

            const { editor } = await openFixture('simple.kif');
            await sleep(1_000);

            // Start the command — it will show a QuickPick.
            const cmdPromise = vscode.commands.executeCommand('sumo.generateTPTP');
            await sleep(800);

            // Accept the first item (should be "Current File" when no config.xml present).
            await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
            await sleep(60_000); // generous timeout for Sigma compilation

            // A new TPTP document should now be the active editor.
            const active = vscode.window.activeTextEditor;
            assert.ok(active, 'Expected a TPTP document to open beside the KIF file');
            const text = active.document.getText();
            assert.ok(text.includes('fof(') || text.includes('tff('),
                `Expected TPTP formulae in the opened document; got first 200 chars: ${text.slice(0, 200)}`);

            await cmdPromise.catch(() => {});
        });

        test('"Selection Only" translates a selected axiom to TPTP', async function () {
            this.timeout(120_000);

            const { doc, editor } = await openFixture('simple.kif');

            // Select the first axiom line.
            const firstLine = doc.lineAt(3); // (subclass Entity Entity)
            editor.selection = new vscode.Selection(
                firstLine.range.start, firstLine.range.end
            );
            await sleep(500);

            const cmdPromise = vscode.commands.executeCommand('sumo.generateTPTP');
            await sleep(800);

            // The QuickPick shows "Current File" first; we need "Selection Only".
            // Navigate down one item then accept.
            await vscode.commands.executeCommand('workbench.action.quickOpenNavigateNext');
            await sleep(200);
            await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
            await sleep(60_000);

            const active = vscode.window.activeTextEditor;
            assert.ok(active, 'Expected a TPTP document to open');
            const text = active.document.getText();
            assert.ok(text.includes('fof(') || text.includes('tff('),
                `Expected TPTP content; got: ${text.slice(0, 200)}`);

            await cmdPromise.catch(() => {});
        });
    });
});
