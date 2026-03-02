'use strict';

/**
 * Outer test runner — launches a VS Code Extension Host instance with the
 * SUMO extension loaded, then executes the Mocha suite inside it.
 *
 * Run with:
 *   npm run test:vscode
 *
 * Environment variables:
 *   SUMO_PATH        Path to the ontologyportal/sumo repository.
 *                    Defaults to ../sumo relative to the project root.
 *                    Cloned automatically if absent.
 *   SIGMAKEE_JAR     Path to the sigmakee.jar fat-jar (for Sigma-dependent tests).
 *   SIGMAKEE_LIBS    Path to the sigmakee/lib directory.
 *   PROVER_PATH      Path to the Vampire or EProver executable.
 *   VSCODE_VERSION   VS Code version to download (default: 'stable').
 */

const path = require('path');
const { runTests } = require('@vscode/test-electron');
const { ensureSumo } = require('./setup-sumo');

async function main() {
    // Clone the SUMO repo if it is not already present.
    const sumoPath = await ensureSumo();

    const extensionDevelopmentPath = path.resolve(__dirname, '..');
    const extensionTestsPath      = path.resolve(__dirname, 'suite/index');
    const workspaceFolder         = path.resolve(__dirname, '../test-fixtures/workspace');

    await runTests({
        version: process.env.VSCODE_VERSION || 'stable',
        extensionDevelopmentPath,
        extensionTestsPath,
        launchArgs: [
            workspaceFolder,
            '--disable-extensions',   // prevent interference from other installed extensions
        ],
        extensionTestsEnv: {
            SUMO_PATH:      sumoPath,
            SIGMAKEE_JAR:   process.env.SIGMAKEE_JAR  || '',
            SIGMAKEE_LIBS:  process.env.SIGMAKEE_LIBS || '',
            PROVER_PATH:    process.env.PROVER_PATH   || '',
        },
    });
}

main().catch(err => {
    console.error('VS Code integration test run failed:', err);
    process.exit(1);
});
