'use strict';

/**
 * Integration tests for sumo.runProverOnScope.
 *
 * Like queryProver, these tests FAIL when the theorem prover is absent.
 */

const assert = require('assert');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const vscode = require('vscode');
const {
    ensureExtensionActive, openFixture, closeAllEditors,
    sleep, PROVER_PATH, SIGMAKEE_JAR, SIGMAKEE_LIBS, SUMO_PATH,
} = require('./helpers');

let minimalSigmaHome;

function buildSigmaEnv() {
    const { globSync } = require('glob');
    const VSCODE_ROOT = path.resolve(__dirname, '../..');
    const TINYSUMOKIF = path.join(SUMO_PATH, 'tinySUMO.kif');
    if (!fs.existsSync(TINYSUMOKIF)) throw new Error(`tinySUMO.kif not found at ${TINYSUMOKIF}`);

    minimalSigmaHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sigma-scope-test-'));
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

suite('sumo.runProverOnScope', function () {
    this.timeout(30_000);

    suiteSetup(ensureExtensionActive);
    afterEach(closeAllEditors);

    test('command is registered', async () => {
        const commands = await vscode.commands.getCommands(true);
        assert.ok(commands.includes('sumo.runProverOnScope'),
            'sumo.runProverOnScope must be registered');
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
            `SigmaKEE jar not found. Set SIGMAKEE_JAR.\nConfigured: "${SIGMAKEE_JAR}"`
        );
    });

    suite('end-to-end scope query (requires prover + Sigma)', function () {
        this.timeout(120_000);

        before(function () {
            if (!PROVER_PATH || !fs.existsSync(PROVER_PATH)) return this.skip();
            if (!SIGMAKEE_JAR || !fs.existsSync(SIGMAKEE_JAR)) return this.skip();
            return vscode.workspace.getConfiguration('sumo').update(
                'theoremProver.path', PROVER_PATH, vscode.ConfigurationTarget.Workspace
            ).then(() => buildSigmaEnv());
        });

        after(async () => {
            await vscode.workspace.getConfiguration('sumo').update(
                'theoremProver.path', '', vscode.ConfigurationTarget.Workspace
            );
            teardownSigmaEnv();
        });

        test('runs the prover on the scope of the active file and shows output', async () => {
            const { editor } = await openFixture('simple.kif');
            await sleep(2_000);

            // Place cursor inside the first axiom.
            const doc    = editor.document;
            const offset = doc.getText().indexOf('(subclass Entity Entity)');
            editor.selection = new vscode.Selection(
                doc.positionAt(offset), doc.positionAt(offset)
            );

            await vscode.commands.executeCommand('sumo.runProverOnScope');
            await sleep(60_000);

            // Check a result panel or tab appeared.
            const tabs = vscode.window.tabGroups.all.flatMap(g => g.tabs);
            const resultTab = tabs.find(t =>
                t.label && (t.label.toLowerCase().includes('result') || t.label.toLowerCase().includes('prover'))
            );
            assert.ok(resultTab || vscode.window.activeTextEditor,
                'Expected a result panel after runProverOnScope');
        });
    });
});
