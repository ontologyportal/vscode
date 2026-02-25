/**
 * Extension imports sanity checks.
 */

'use strict';

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');

const EXTENSION_SRC = path.join(__dirname, '../extension.js');
const NAVIGATION_SRC = path.join(__dirname, '../src/navigation.js');

// ---------------------------------------------------------------------------
describe('extension.js - import / wiring checks', function () {

    // -----------------------------------------------------------------------
    // Structural checks: all imported names should exist in their respective modules
    // -----------------------------------------------------------------------
    describe('Extension imports sanity checks', function () {

        function getImportedNames(source, modulePath) {
            const re = new RegExp(
                `const\\s*\\{([^}]+)\\}\\s*=\\s*require\\(['"]${modulePath.replace(/\//g, '\\/')}['"]\\)`
            );
            const match = source.match(re);
            if (!match) return [];
            // Strip aliases: `foo: bar` → `foo` (bar is the local alias, foo is the export name)
            return match[1].split(',').map(n => n.trim().split(':')[0].trim()).filter(Boolean);
        }

        it('all navigation imports exist in navigation.js exports', function () {
            const extSource = fs.readFileSync(EXTENSION_SRC, 'utf-8');
            const navSource = fs.readFileSync(NAVIGATION_SRC, 'utf-8');

            const imported = getImportedNames(extSource, './src/navigation');
            const exportsBlock = navSource.match(/module\.exports\s*=\s*\{([\s\S]*?)\}/)?.[1] || '';

            for (const name of imported) {
                expect(exportsBlock).to.include(name,
                    `navigation.js must export '${name}' (imported by extension.js)`
                );
            }
        });

        it('all validation imports exist in validation.js exports', function () {
            const extSource = fs.readFileSync(EXTENSION_SRC, 'utf-8');
            if (!extSource.includes('./src/validation')) return; // not imported

            const valSource = fs.readFileSync(
                path.join(__dirname, '../src/validation.js'), 'utf-8'
            );
            const imported = getImportedNames(extSource, './src/validation');
            const exportsBlock = valSource.match(/module\.exports\s*=\s*\{([\s\S]*?)\}/)?.[1] || '';

            for (const name of imported) {
                expect(exportsBlock).to.include(name,
                    `validation.js must export '${name}' (imported by extension.js)`
                );
            }
        });

        it('extension.js activate function registers document change listeners', function () {
            const source = fs.readFileSync(EXTENSION_SRC, 'utf-8');
            expect(source).to.include('onDidOpenTextDocument');
            expect(source).to.include('onDidChangeTextDocument');
            expect(source).to.include('onDidSaveTextDocument');
        });

        it('extension.js registers all commands declared in package.json', function () {
            const source = fs.readFileSync(EXTENSION_SRC, 'utf-8');
            const pkg = JSON.parse(
                fs.readFileSync(path.join(__dirname, '../package.json'), 'utf-8')
            );

            const commandIds = pkg.contributes.commands.map(c => c.command);
            for (const cmd of commandIds) {
                expect(source).to.include(`'${cmd}'`,
                    `extension.js must register command '${cmd}' from package.json`
                );
            }
        });
    });
});
