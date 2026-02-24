/**
 * Tests that verify extension.js is correctly wired up.
 *
 * Bug exposed:
 *   B1 - extension.js calls `updateFileDefinitions(document)` inside the
 *        document change/open/save listeners (via the `validate` helper at
 *        lines 160-163), but `updateFileDefinitions` is NOT in the destructured
 *        import from './src/navigation'.  The import at line 14-21 only pulls
 *        in `updateDocumentDefinitions` (a different function).  This means
 *        that whenever a document is opened or changed, a
 *        ReferenceError: updateFileDefinitions is not defined
 *        is thrown at runtime, silently swallowed by VS Code's event dispatch.
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
    // B1: updateFileDefinitions not imported
    // -----------------------------------------------------------------------
    describe('B1 (fixed) - updateFileDefinitions is now correctly imported from navigation', function () {

        it('extension.js imports and calls updateFileDefinitions', function () {
            const source = fs.readFileSync(EXTENSION_SRC, 'utf-8');

            // The function is called
            expect(source).to.include('updateFileDefinitions(',
                'extension.js must call updateFileDefinitions'
            );

            // FIX B1: updateFileDefinitions must now appear in the destructured require
            const requireNavigation = source.match(
                /const\s*\{([^}]+)\}\s*=\s*require\(['"]\.\/src\/navigation['"]\)/
            );
            expect(requireNavigation).to.not.be.null;
            const importedNames = requireNavigation[1];
            expect(importedNames).to.include('updateFileDefinitions',
                'FIX B1: updateFileDefinitions should now be imported from ./src/navigation'
            );
        });

        it('navigation.js exports updateFileDefinitions', function () {
            const navSource = fs.readFileSync(NAVIGATION_SRC, 'utf-8');

            const exportsBlock = navSource.match(/module\.exports\s*=\s*\{([\s\S]*?)\}/)?.[1] || '';
            expect(exportsBlock).to.include('updateFileDefinitions',
                'navigation.js must include updateFileDefinitions in module.exports'
            );
        });

        it('the validate() closure in extension.js calls the correctly imported updateFileDefinitions', function () {
            const source = fs.readFileSync(EXTENSION_SRC, 'utf-8');

            const validateClosure = source.match(/const validate[\s\S]*?updateFileDefinitions\([^)]*\)/)?.[0];
            expect(validateClosure).to.not.be.null;
            expect(validateClosure).to.include('updateFileDefinitions',
                'validate() should call updateFileDefinitions, which is now properly imported'
            );
        });
    });

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
