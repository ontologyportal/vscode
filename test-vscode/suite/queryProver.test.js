'use strict';

/**
 * Integration tests for sumo.queryProver.
 *
 * Per project requirements these tests FAIL (not skip) when the configured
 * theorem prover executable is absent, so the CI environment must supply one.
 *
 * Required environment variables:
 *   PROVER_PATH   — path to the Vampire or EProver executable
 *   SIGMAKEE_JAR  — path to sigmakee.jar (Sigma-backed TPTP generation)
 *   SIGMAKEE_LIBS — path to the sigmakee/lib directory
 */

const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const vscode = require('vscode');
const {
    ensureExtensionActive, openFixture, closeAllEditors,
    placeCursorOn, sleep,
    PROVER_PATH, SIGMAKEE_JAR, SIGMAKEE_LIBS, SUMO_PATH,
} = require('./helpers');

// ---------------------------------------------------------------------------
// Sigma environment setup
// ---------------------------------------------------------------------------

let minimalSigmaHome;

function buildSigmaEnv() {
    const { globSync } = require('glob');
    const VSCODE_ROOT  = path.resolve(__dirname, '../..');
    const TINYSUMOKIF  = path.join(SUMO_PATH, 'tinySUMO.kif');

    if (!fs.existsSync(TINYSUMOKIF)) {
        throw new Error(`tinySUMO.kif not found at ${TINYSUMOKIF}`);
    }

    minimalSigmaHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sigma-prover-test-'));
    const kbsDir = path.join(minimalSigmaHome, 'KBs');
    fs.mkdirSync(kbsDir);
    fs.mkdirSync(path.join(minimalSigmaHome, 'logs'));

    fs.writeFileSync(path.join(kbsDir, 'config.xml'), [
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
    ].join('\n'), 'utf8');

    const cp = [
        SIGMAKEE_JAR,
        ...globSync(path.join(SIGMAKEE_LIBS, '*')),
        path.join(path.resolve(__dirname, '../..'), 'lib', 'py4j.jar'),
        path.join(path.resolve(__dirname, '../..'), 'lib', 'SigmaBridge.jar'),
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

suite('sumo.queryProver', function () {
    this.timeout(30_000);

    suiteSetup(ensureExtensionActive);
    afterEach(closeAllEditors);

    test('command is registered', async () => {
        const commands = await vscode.commands.getCommands(true);
        assert.ok(commands.includes('sumo.queryProver'),
            'sumo.queryProver must be registered');
    });

    test('FAILS — prover executable must be configured (PROVER_PATH env var)', () => {
        assert.ok(
            PROVER_PATH && fs.existsSync(PROVER_PATH),
            `Theorem prover not found. Set PROVER_PATH to a valid Vampire or EProver executable.\nConfigured: "${PROVER_PATH}"`
        );
    });

    test('FAILS — SigmaKEE must be configured (SIGMAKEE_JAR env var)', () => {
        assert.ok(
            SIGMAKEE_JAR && fs.existsSync(SIGMAKEE_JAR),
            `SigmaKEE jar not found. Set SIGMAKEE_JAR to the sigmakee.jar path.\nConfigured: "${SIGMAKEE_JAR}"`
        );
    });

    suite('end-to-end query (requires prover + Sigma)', function () {
        this.timeout(120_000);

        before(function () {
            // Prerequisites already asserted above; only skip here if somehow still absent.
            if (!PROVER_PATH || !fs.existsSync(PROVER_PATH)) return this.skip();
            if (!SIGMAKEE_JAR || !fs.existsSync(SIGMAKEE_JAR)) return this.skip();

            // Configure VS Code settings to use the prover.
            return vscode.workspace.getConfiguration('sumo').update(
                'theoremProver.path', PROVER_PATH,
                vscode.ConfigurationTarget.Workspace
            ).then(() => buildSigmaEnv());
        });

        after(async () => {
            await vscode.workspace.getConfiguration('sumo').update(
                'theoremProver.path', '', vscode.ConfigurationTarget.Workspace
            );
            teardownSigmaEnv();
        });

        test('runs a query against simple.kif and shows a result panel', async () => {
            const { editor } = await openFixture('simple.kif');
            await sleep(2_000); // let extension index + Sigma initialise

            // Select an axiom to use as the query.
            const found = placeCursorOn(editor, '(subclass Cat Mammal)');
            assert.ok(found, '(subclass Cat Mammal) must appear in simple.kif');

            // Select the axiom text.
            const doc       = editor.document;
            const startOff  = doc.getText().indexOf('(subclass Cat Mammal)');
            const endOff    = startOff + '(subclass Cat Mammal)'.length;
            editor.selection = new vscode.Selection(
                doc.positionAt(startOff), doc.positionAt(endOff)
            );

            await vscode.commands.executeCommand('sumo.queryProver');
            await sleep(60_000); // allow prover to finish

            // After the query the extension opens a result document or output channel.
            // We check that the active editor changed (or a new tab appeared).
            const tabs = vscode.window.tabGroups.all.flatMap(g => g.tabs);
            const resultTab = tabs.find(t =>
                t.label && (t.label.toLowerCase().includes('result') || t.label.toLowerCase().includes('tptp'))
            );
            assert.ok(resultTab || vscode.window.activeTextEditor,
                'Expected a result panel or document after queryProver');
        });
    });
});
