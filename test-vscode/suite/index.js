'use strict';

/**
 * Mocha test runner that executes inside the VS Code Extension Host.
 * All *.test.js files under this directory are discovered and added to the suite.
 */

const path  = require('path');
const Mocha = require('mocha');
const fs    = require('fs');

function collectTestFiles(dir, results = []) {
    for (const entry of fs.readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (fs.statSync(full).isDirectory()) {
            collectTestFiles(full, results);
        } else if (entry.endsWith('.test.js')) {
            results.push(full);
        }
    }
    return results;
}

function run() {
    const mocha = new Mocha({
        ui:      'tdd',
        timeout: 60_000,
        color:   true,
    });

    // TDD interface sets globals lazily via the 'pre-require' event.
    // Add aliases for BDD-style hooks (afterEach/before/after) after the TDD
    // interface registers its own listener, so our listener runs second.
    mocha.suite.on('pre-require', (context) => {
        context.beforeEach = context.setup;
        context.afterEach  = context.teardown;
        context.before     = context.suiteSetup;
        context.after      = context.suiteTeardown;
    });

    collectTestFiles(__dirname).forEach(f => mocha.addFile(f));

    return new Promise((resolve, reject) => {
        mocha.run(failures => {
            if (failures > 0) reject(new Error(`${failures} test(s) failed`));
            else resolve();
        });
    });
}

exports.run = run;
