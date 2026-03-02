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
        ui:      'bdd',
        timeout: 60_000,
        color:   true,
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
