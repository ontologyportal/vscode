/**
 * Theorem Prover Tests
 *
 * Unit tests for the PROVE pipeline (KIF -> TPTP with conjecture)
 * and integration tests that invoke real provers (eprover, vampire).
 *
 * Integration tests skip gracefully if provers are not installed.
 */

const { expect } = require('chai');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const {
    convertFormulas,
    parseKIFFormulas,
    setLanguage
} = require('../../src/sigma/engine/native/index.js');

// Prover paths
const EPROVER_PATH = '/home/iggy/Programs/E/PROVER/eprover';
const VAMPIRE_PATH = '/home/iggy/Programs/vampire/build/vampire';

function isProverAvailable(proverPath) {
    return fs.existsSync(proverPath);
}

/**
 * Run a theorem prover on TPTP content and return the SZS status.
 * @param {string} tptpContent - TPTP problem content
 * @param {string} proverPath - Path to prover executable
 * @param {string} proverType - 'eprover' or 'vampire'
 * @param {number} timeout - Timeout in seconds
 * @returns {string} SZS status string (e.g. 'Theorem', 'CounterSatisfiable', 'Timeout')
 */
function runProver(tptpContent, proverPath, proverType, timeout = 10) {
    const tmpFile = path.join(os.tmpdir(), `theorem-prover-test-${Date.now()}.p`);
    try {
        fs.writeFileSync(tmpFile, tptpContent, 'utf-8');

        let cmd;
        if (proverType === 'eprover') {
            cmd = `${proverPath} --auto --cpu-limit=${timeout} --proof-object ${tmpFile}`;
        } else if (proverType === 'vampire') {
            cmd = `${proverPath} --mode casc -t ${timeout} ${tmpFile}`;
        } else {
            throw new Error(`Unknown prover type: ${proverType}`);
        }

        const output = execSync(cmd, {
            timeout: (timeout + 5) * 1000,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe']
        });

        // Extract SZS status
        const szsMatch = output.match(/SZS status (\w+)/);
        return szsMatch ? szsMatch[1] : 'Unknown';
    } catch (e) {
        // Provers may exit with non-zero on timeout or counter-satisfiable
        const output = (e.stdout || '') + (e.stderr || '');
        const szsMatch = output.match(/SZS status (\w+)/);
        return szsMatch ? szsMatch[1] : 'Error';
    } finally {
        if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    }
}

describe('Theorem Prover Tests', function () {
    this.timeout(30000);

    describe('PROVE pipeline unit tests', () => {
        beforeEach(() => {
            setLanguage('fof');
        });

        it('should produce a conjecture line for PROVE action', () => {
            const axioms = parseKIFFormulas('(instance Human Animal)');
            const conjecture = '(instance John Animal)';

            const result = convertFormulas(axioms, 'TestKB', conjecture, false);

            expect(result.content).to.include('conjecture');
            expect(result.content).to.match(/fof\(prove_from_TestKB/);
        });

        it('should include axiom lines alongside the conjecture', () => {
            const axioms = parseKIFFormulas(
                '(instance Human Animal)\n(subclass Human Mammal)'
            );
            const conjecture = '(instance John Animal)';

            const result = convertFormulas(axioms, 'TestKB', conjecture, false);

            // Should have both axiom and conjecture lines
            const lines = result.content.split('\n').filter(l => l.startsWith('fof('));
            const axiomLines = lines.filter(l => l.includes(',axiom,'));
            const conjectureLines = lines.filter(l => l.includes(',conjecture,'));

            expect(axiomLines.length).to.be.greaterThan(0);
            expect(conjectureLines.length).to.be.greaterThan(0);
        });

        it('should use existential quantification for free variables in conjecture', () => {
            const axioms = parseKIFFormulas('(instance Human Animal)');
            const conjecture = '(instance ?X Animal)';

            const result = convertFormulas(axioms, 'TestKB', conjecture, false);

            // Free variables in conjecture get existential quantification
            expect(result.content).to.include('?');
        });

        it('should still produce axioms when conjecture is null', () => {
            const axioms = parseKIFFormulas(
                '(instance Human Animal)\n(subclass Dog Animal)'
            );

            const result = convertFormulas(axioms, 'TestKB', null, false);

            expect(result.axiomCount).to.be.greaterThan(0);
            const lines = result.content.split('\n').filter(l => l.startsWith('fof('));
            expect(lines.length).to.be.greaterThan(0);
            // No conjecture line
            expect(result.content).to.not.include(',conjecture,');
        });

        it('should produce syntactically valid TPTP fof lines', () => {
            const axioms = parseKIFFormulas(
                '(=> (instance ?X Human) (instance ?X Animal))\n' +
                '(instance John Human)'
            );
            const conjecture = '(instance John Animal)';

            const result = convertFormulas(axioms, 'TestKB', conjecture, false);

            const fofLines = result.content.split('\n').filter(l => l.startsWith('fof('));
            expect(fofLines.length).to.be.greaterThan(0);

            for (const line of fofLines) {
                // Each fof line should end with ).
                expect(line.trimEnd()).to.match(/\)\.\s*$/);
                // Balanced parentheses
                let depth = 0;
                for (const ch of line) {
                    if (ch === '(') depth++;
                    if (ch === ')') depth--;
                    expect(depth).to.be.at.least(0, `Unbalanced parens in: ${line}`);
                }
            }
        });

        it('should combine formulas from multiple sources in output', () => {
            const formulas1 = parseKIFFormulas('(instance Human Animal)');
            const formulas2 = parseKIFFormulas('(subclass Dog Animal)');
            const combined = formulas1.concat(formulas2);

            const result = convertFormulas(combined, 'CombinedKB', null, false);

            expect(result.content).to.include('s__Human');
            expect(result.content).to.include('s__Dog');
            expect(result.axiomCount).to.equal(2);
        });
    });

    describe('Integration tests with real provers', function () {
        let eproverAvailable = false;
        let vampireAvailable = false;

        before(function () {
            eproverAvailable = isProverAvailable(EPROVER_PATH);
            vampireAvailable = isProverAvailable(VAMPIRE_PATH);

            if (!eproverAvailable && !vampireAvailable) {
                console.warn('WARNING: No theorem provers found, skipping prover integration tests');
                console.warn(`  eprover checked at: ${EPROVER_PATH}`);
                console.warn(`  vampire checked at: ${VAMPIRE_PATH}`);
            }
        });

        beforeEach(function () {
            setLanguage('fof');
        });

        it('should prove a simple theorem with eprover', function () {
            if (!eproverAvailable) this.skip();

            const axioms = parseKIFFormulas(
                '(=> (instance ?X Human) (instance ?X Animal))\n' +
                '(instance John Human)'
            );
            const conjecture = '(instance John Animal)';
            const result = convertFormulas(axioms, 'TestKB', conjecture, false);

            const status = runProver(result.content, EPROVER_PATH, 'eprover');
            expect(status).to.equal('Theorem');
        });

        it('should prove a simple theorem with vampire', function () {
            if (!vampireAvailable) this.skip();

            const axioms = parseKIFFormulas(
                '(=> (instance ?X Human) (instance ?X Animal))\n' +
                '(instance John Human)'
            );
            const conjecture = '(instance John Animal)';
            const result = convertFormulas(axioms, 'TestKB', conjecture, false);

            const status = runProver(result.content, VAMPIRE_PATH, 'vampire');
            expect(status).to.equal('Theorem');
        });

        it('should not prove an unprovable conjecture', function () {
            if (!eproverAvailable && !vampireAvailable) this.skip();

            const axioms = parseKIFFormulas(
                '(=> (instance ?X Human) (instance ?X Animal))\n' +
                '(instance John Human)'
            );
            // Unrelated conjecture - cannot be derived from axioms
            const conjecture = '(instance John Plant)';
            const result = convertFormulas(axioms, 'TestKB', conjecture, true);

            const proverPath = eproverAvailable ? EPROVER_PATH : VAMPIRE_PATH;
            const proverType = eproverAvailable ? 'eprover' : 'vampire';
            const status = runProver(result.content, proverPath, proverType, 5);

            expect(status).to.not.equal('Theorem');
        });

        it('should find axioms satisfiable (consistency check)', function () {
            if (!eproverAvailable && !vampireAvailable) this.skip();

            const axioms = parseKIFFormulas(
                '(instance Human Animal)\n' +
                '(subclass Dog Animal)\n' +
                '(instance Fido Dog)'
            );
            // No conjecture - just check axioms are satisfiable
            const result = convertFormulas(axioms, 'TestKB', null, false);

            const proverPath = eproverAvailable ? EPROVER_PATH : VAMPIRE_PATH;
            const proverType = eproverAvailable ? 'eprover' : 'vampire';
            const status = runProver(result.content, proverPath, proverType, 5);

            // Without a conjecture, should be Satisfiable (not Unsatisfiable)
            expect(status).to.not.equal('Unsatisfiable');
        });
    });
});
