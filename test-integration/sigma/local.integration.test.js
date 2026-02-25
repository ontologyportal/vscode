'use strict';

/**
 * Integration test for LocalRuntimeRunner.writeFile()
 *
 * Creates a minimal temporary SIGMA_HOME with only the TestOntology KB so
 * initialization is fast (loads tinySUMO.kif, ~672 lines, in seconds rather
 * than minutes).
 *
 * Skips automatically if the required jars are not present.
 *
 * Run with:
 *   npm run test:integration
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { expect } = require('chai');
const proxyquire = require('proxyquire');

// ---------------------------------------------------------------------------
// Resource locations
// ---------------------------------------------------------------------------

const VSCODE_ROOT   = path.resolve(__dirname, '../..');
const SIGMAKEE_JAR  = '/home/iggy/workspace/sigmakee/build/sigmakee.jar';
const SIGMAKEE_LIBS = '/home/iggy/workspace/sigmakee/lib';
const TINYSUMOKIF   = '/home/iggy/projects/sumo/tinySUMO.kif';

const AVAILABLE = [SIGMAKEE_JAR, SIGMAKEE_LIBS, TINYSUMOKIF].every(p => fs.existsSync(p));

// ---------------------------------------------------------------------------

describe('LocalRuntimeRunner — integration (real SigmaKEE)', function () {
    this.timeout(120_000); // generous for JVM boot + tinySUMO parse

    if (!AVAILABLE) {
        it('skipped — SigmaKEE jars or tinySUMO.kif not found');
        return;
    }

    // Build the classpath
    const { globSync } = require('glob');
    const cp = [
        SIGMAKEE_JAR,
        ...globSync(path.join(SIGMAKEE_LIBS, '*')),
        path.join(VSCODE_ROOT, 'lib', 'py4j.jar'),
        path.join(VSCODE_ROOT, 'lib', 'SigmaBridge.jar'),
    ].join(path.delimiter);

    // Load LocalRuntimeRunner with only vscode stubbed out.
    const { LocalRuntimeRunner } = proxyquire('../../src/sigma/engine/local', {
        vscode: { '@noCallThru': true },
    });

    const mockContext = { extensionPath: VSCODE_ROOT };

    let minimalSigmaHome;
    let runner;
    let outFile;

    before(async function () {
        // Create a minimal SIGMA_HOME pointing only at TestOntology so that
        // KBmanager.initializeOnce() loads just tinySUMO.kif (fast) instead
        // of the full SUMO KB with WordNet (slow).
        minimalSigmaHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sigma-test-'));
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

        // SIGMA_HOME is inherited by the spawned Java process.
        process.env.SIGMA_CP   = cp;
        process.env.SIGMA_HOME = minimalSigmaHome;

        runner  = new LocalRuntimeRunner();
        outFile = path.join(os.tmpdir(), `sigma-integration-${process.pid}.tptp`);
        await runner.initialize(mockContext);
    });

    after(async function () {
        delete process.env.SIGMA_CP;
        delete process.env.SIGMA_HOME;
        if (runner) await runner.stop();
        if (outFile && fs.existsSync(outFile)) fs.unlinkSync(outFile);
        if (minimalSigmaHome && fs.existsSync(minimalSigmaHome)) {
            fs.rmSync(minimalSigmaHome, { recursive: true, force: true });
        }
    });

    // -----------------------------------------------------------------------

    it('generates a non-empty TPTP file for the TestOntology KB', async function () {
        const result = await runner.writeFile(outFile, 'TestOntology');

        expect(result).to.equal(outFile,
            'writeFile should return the output file path');
        expect(fs.existsSync(outFile),
            `Output file should exist at ${outFile}`).to.be.true;

        const content = fs.readFileSync(outFile, 'utf8');
        expect(content.length).to.be.greaterThan(0,
            'Output file must not be empty — pw.close() must have flushed the buffer to disk');
        expect(content).to.include('fof(',
            'TPTP output must contain at least one fof() formula');
    });

    it('overwrites an existing file completely (TRUNCATE_EXISTING)', async function () {
        // Pre-populate with stale content longer than any real TPTP output.
        const stale = 'STALE CONTENT THAT MUST NOT APPEAR\n'.repeat(500);
        fs.writeFileSync(outFile, stale, 'utf8');

        await runner.writeFile(outFile, 'TestOntology');

        const content = fs.readFileSync(outFile, 'utf8');
        expect(content).to.not.include('STALE CONTENT',
            'writeFile must truncate before writing — old bytes must not remain');
        expect(content).to.include('fof(',
            'Fresh TPTP content must be present after overwrite');
    });

    it('can write the same file twice in a row without error', async function () {
        await runner.writeFile(outFile, 'TestOntology');
        await runner.writeFile(outFile, 'TestOntology');

        const content = fs.readFileSync(outFile, 'utf8');
        expect(content).to.include('fof(');
    });
});
