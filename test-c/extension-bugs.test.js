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
    describe('B1 - updateFileDefinitions is not imported from navigation', function () {

        it('extension.js calls updateFileDefinitions but does not import it', function () {
            const source = fs.readFileSync(EXTENSION_SRC, 'utf-8');

            // The function is called
            expect(source).to.include('updateFileDefinitions(',
                'extension.js must call updateFileDefinitions'
            );

            // But it is NOT in the destructured require of ./src/navigation
            // The import block should contain 'updateFileDefinitions' for it to work.
            // BUG B1: it imports 'updateDocumentDefinitions' instead.
            const importBlock = source.match(/require\(['"]\.\/src\/navigation['"]\)([\s\S]*?)(?=\n\n|\nconst |\nlet )/)?.[0] || '';

            // The import destructures updateDocumentDefinitions (the wrong function)
            expect(source).to.include('updateDocumentDefinitions',
                'extension.js imports updateDocumentDefinitions from navigation'
            );

            // BUG: updateFileDefinitions is NOT in the import
            // (checking the require block specifically)
            const requireNavigation = source.match(
                /const\s*\{([^}]+)\}\s*=\s*require\(['"]\.\/src\/navigation['"]\)/
            );
            expect(requireNavigation).to.not.be.null;
            const importedNames = requireNavigation[1];
            expect(importedNames).to.not.include('updateFileDefinitions',
                'BUG B1: updateFileDefinitions is called in extension.js but never imported ' +
                'from ./src/navigation — the import only has updateDocumentDefinitions'
            );
        });

        it('navigation.js exports updateFileDefinitions (so the fix is possible)', function () {
            const navSource = fs.readFileSync(NAVIGATION_SRC, 'utf-8');

            // navigation.js exports it
            expect(navSource).to.include('updateFileDefinitions',
                'navigation.js should export updateFileDefinitions'
            );

            const exportsBlock = navSource.match(/module\.exports\s*=\s*\{([\s\S]*?)\}/)?.[1] || '';
            expect(exportsBlock).to.include('updateFileDefinitions',
                'navigation.js must include updateFileDefinitions in module.exports'
            );
        });

        it('the validate() closure in extension.js uses the unimported function name', function () {
            const source = fs.readFileSync(EXTENSION_SRC, 'utf-8');

            // Lines 160-163 define a `validate` closure that calls updateFileDefinitions.
            // This is the exact location of the bug.
            const validateClosure = source.match(/const validate[\s\S]*?updateFileDefinitions\([^)]*\)/)?.[0];
            expect(validateClosure).to.not.be.null;

            // Confirm the name is updateFileDefinitions, not updateDocumentDefinitions
            expect(validateClosure).to.include('updateFileDefinitions',
                'validate() calls updateFileDefinitions which is not imported → ReferenceError at runtime'
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
            return match[1].split(',').map(n => n.trim()).filter(Boolean);
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
