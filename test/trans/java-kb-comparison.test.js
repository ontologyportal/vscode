/**
 * Java KB-Level Comparison Tests
 *
 * These tests compare the JavaScript KB conversion pipeline (convertFormulas)
 * against the Java individual formula converter (SUMOformulaToTPTPformula -g).
 *
 * Since Java's SUMOKBtoTPTPKB.main() requires full KBmanager initialization,
 * we instead:
 *   - Convert a multi-formula KB through the JS convertFormulas pipeline
 *   - Extract each axiom's TPTP body from the output
 *   - Compare each body against the Java individual formula converter
 *   - Verify filtering, deduplication, conjecture handling, and structure
 *
 * Prerequisites:
 * - SIGMA_CP environment variable must be set with the Java classpath
 * - Java must be installed and accessible
 *
 * Run with: npm run test:java
 */

const { expect } = require('chai');
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const {
    convertFormulas,
    readKIFFile,
    setLanguage,
    tptpParseSUOKIFString,
    setHideNumbers,
    setLang
} = require('../../src/sigma/engine/native/index.js');

const execAsync = promisify(exec);

// Get SIGMA_CP from environment or construct default path
const SIGMA_CP = process.env.SIGMA_CP || '';
const SIGMA_HOME = process.env.SIGMA_HOME || '/home/iggy/projects/sigmakee';

const TINY_SUMO_PATH = '/home/iggy/.sigmakee/KBs/tinySUMO.kif';

// --- Reusable helpers (same pattern as java-comparison.test.js) ---

async function isJavaAvailable() {
    try {
        await execAsync('java -version');
        return true;
    } catch (e) {
        return false;
    }
}

function isSigmaCPSet() {
    return SIGMA_CP !== '' || !!process.env.SIGMA_CP;
}

async function invokeJavaConverter(formula) {
    const classpath = SIGMA_CP || process.env.SIGMA_CP;
    if (!classpath) {
        throw new Error('SIGMA_CP environment variable not set');
    }

    const escapedFormula = formula.replace(/"/g, '\\"');
    const cmd = `java -Xmx8g -classpath "${classpath}" com.articulate.sigma.trans.SUMOformulaToTPTPformula -g "${escapedFormula}"`;

    try {
        const { stdout } = await execAsync(cmd, {
            timeout: 30000,
            env: { ...process.env, SIGMA_HOME }
        });

        const lines = stdout.trim().split('\n');
        for (const line of lines) {
            if (line.trim().startsWith('(') && line.includes('s__')) {
                return line.trim();
            }
        }
        return lines.filter(l => l.trim()).pop() || stdout.trim();
    } catch (error) {
        throw new Error(`Java invocation failed: ${error.message}`);
    }
}

function normalizeTPTP(tptp) {
    if (!tptp) return '';

    let normalized = tptp.replace(/\s+/g, ' ').trim();

    // Sort variable lists in quantifiers
    normalized = normalized.replace(/(\[)([^\]]+)(\])/g, (match, open, vars, close) => {
        const sortedVars = vars.split(',').map(v => v.trim()).sort().join(',');
        return open + sortedVars + close;
    });

    // Normalize extra parens around implication consequent
    normalized = normalized.replace(/=> \((\w+\([^()]*\))\)/g, '=> $1');

    return normalized;
}

// --- New helpers for KB-level tests ---

/**
 * Parse fof(...) lines from convertFormulas output.
 * Returns an array of {name, role, body} objects.
 */
function extractAxioms(content) {
    const axioms = [];
    const lines = content.split('\n');
    // Match: fof(name,role,(body)).
    const re = /^(fof|tff|thf)\(([^,]+),(\w+),\((.+)\)\)\.\s*$/;
    for (const line of lines) {
        const m = line.match(re);
        if (m) {
            axioms.push({ name: m[2], role: m[3], body: m[4] });
        }
    }
    return axioms;
}

/**
 * Extract the conjecture (or question) entry from convertFormulas output.
 * Returns {name, role, body} or null.
 */
function extractConjecture(content) {
    const axioms = extractAxioms(content);
    return axioms.find(a => a.role === 'conjecture' || a.role === 'question') || null;
}

describe('Java KB-Level Comparison Tests', function () {
    this.timeout(120000);

    let javaAvailable = false;
    let sigmaCPSet = false;

    before(async function () {
        javaAvailable = await isJavaAvailable();
        sigmaCPSet = isSigmaCPSet();

        if (!javaAvailable) {
            console.warn('WARNING: Java not available, skipping Java KB comparison tests');
        }
        if (!sigmaCPSet) {
            console.warn('WARNING: SIGMA_CP not set, skipping Java KB comparison tests');
        }
    });

    beforeEach(function () {
        setLanguage('fof');
        setHideNumbers(true);

        if (!javaAvailable || !sigmaCPSet) {
            this.skip();
        }
    });

    // -----------------------------------------------------------
    // a. Multi-formula KB conversion
    // -----------------------------------------------------------
    describe('Multi-formula KB conversion', function () {
        const formulas = [
            '(instance Foo Bar)',
            '(subclass Human Animal)',
            '(=> (instance ?X P) (instance ?X Q))',
            '(forall (?X) (exists (?Y) (related ?X ?Y)))',
            '(instance (WhenFn ?E) TimeInterval)',
            '(equal ?X ?Y)',
            '(and (instance ?X A) (instance ?X B))',
            '(instance equal BinaryPredicate)'
        ];

        it('produces the expected number of axioms', function () {
            const result = convertFormulas(formulas, 'TestKB');
            const axioms = extractAxioms(result.content);
            expect(axioms.length).to.equal(result.axiomCount);
        });

        it('all axioms have role "axiom"', function () {
            const result = convertFormulas(formulas, 'TestKB');
            const axioms = extractAxioms(result.content);
            for (const a of axioms) {
                expect(a.role).to.equal('axiom');
            }
        });

        // Compare each axiom body against Java formula converter
        for (const kif of formulas) {
            it(`axiom body matches Java for: ${kif}`, async function () {
                const result = convertFormulas([kif], 'CmpKB');
                const axioms = extractAxioms(result.content);

                if (axioms.length === 0) {
                    // Formula may have been filtered; skip comparison
                    this.skip();
                    return;
                }

                const jsBody = axioms[0].body;

                let javaOutput;
                try {
                    javaOutput = await invokeJavaConverter(kif);
                } catch (e) {
                    console.warn(`Java invocation failed for "${kif}": ${e.message}`);
                    this.skip();
                    return;
                }

                const normalizedJS = normalizeTPTP(jsBody);
                const normalizedJava = normalizeTPTP(javaOutput);

                console.log(`KIF:       ${kif}`);
                console.log(`JS body:   ${normalizedJS}`);
                console.log(`Java:      ${normalizedJava}`);

                expect(normalizedJS).to.equal(normalizedJava);
            });
        }
    });

    // -----------------------------------------------------------
    // b. Filtering consistency
    // -----------------------------------------------------------
    describe('Filtering consistency', function () {
        const excludedFormulas = [
            '(documentation Entity EnglishLanguage "An entity")',
            '(domain instance 1 Entity)',
            '(format en instance "%1 is an instance of %2")',
            '(termFormat en Entity "entity")',
            '(externalImage Entity "http://example.com/img.png")'
        ];
        const validFormulas = [
            '(instance Foo Bar)',
            '(subclass Human Animal)'
        ];

        it('excludes documentation and filtered predicates', function () {
            const all = [...excludedFormulas, ...validFormulas];
            const result = convertFormulas(all, 'FilterKB');
            const axioms = extractAxioms(result.content);

            // Only valid formulas should produce axioms
            expect(axioms.length).to.equal(validFormulas.length);
        });

        it('excluded formulas produce no axiom lines', function () {
            const result = convertFormulas(excludedFormulas, 'FilterKB');
            const axioms = extractAxioms(result.content);
            expect(axioms.length).to.equal(0);
            expect(result.axiomCount).to.equal(0);
        });

        it('valid formulas still match Java after filtering', async function () {
            const all = [...excludedFormulas, ...validFormulas];
            const result = convertFormulas(all, 'FilterKB');
            const axioms = extractAxioms(result.content);

            for (let i = 0; i < axioms.length; i++) {
                const kif = validFormulas[i];
                const jsBody = axioms[i].body;

                let javaOutput;
                try {
                    javaOutput = await invokeJavaConverter(kif);
                } catch (e) {
                    console.warn(`Java invocation failed for "${kif}": ${e.message}`);
                    this.skip();
                    return;
                }

                const normalizedJS = normalizeTPTP(jsBody);
                const normalizedJava = normalizeTPTP(javaOutput);

                console.log(`KIF:       ${kif}`);
                console.log(`JS body:   ${normalizedJS}`);
                console.log(`Java:      ${normalizedJava}`);

                expect(normalizedJS).to.equal(normalizedJava);
            }
        });
    });

    // -----------------------------------------------------------
    // c. Duplicate deduplication
    // -----------------------------------------------------------
    describe('Duplicate deduplication', function () {
        it('emits only one axiom per unique formula', function () {
            const formulas = [
                '(instance Foo Bar)',
                '(instance Foo Bar)',
                '(subclass Human Animal)',
                '(instance Foo Bar)',
                '(subclass Human Animal)'
            ];
            const result = convertFormulas(formulas, 'DedupKB');
            const axioms = extractAxioms(result.content);

            expect(axioms.length).to.equal(2);
            expect(result.axiomCount).to.equal(2);
        });
    });

    // -----------------------------------------------------------
    // d. Conjecture and question handling
    // -----------------------------------------------------------
    describe('Conjecture and question handling', function () {
        const axioms = ['(instance Foo Bar)'];

        it('conjecture body matches Java', async function () {
            const conjectureKIF = '(instance ?X Bar)';
            const result = convertFormulas(axioms, 'ConjKB', conjectureKIF, false);
            const conj = extractConjecture(result.content);

            expect(conj).to.not.be.null;
            expect(conj.role).to.equal('conjecture');

            let javaOutput;
            try {
                javaOutput = await invokeJavaConverter(conjectureKIF);
            } catch (e) {
                console.warn(`Java invocation failed: ${e.message}`);
                this.skip();
                return;
            }

            // convertFormulas passes query=true for conjectures, so free vars
            // get existential (?) quantification. Java -g always uses universal (!).
            // Normalize the outer quantifier for comparison.
            const normalizedJS = normalizeTPTP(conj.body).replace(/\?\s*\[/, '! [');
            const normalizedJava = normalizeTPTP(javaOutput);

            console.log(`Conjecture KIF:  ${conjectureKIF}`);
            console.log(`JS body:         ${normalizedJS}`);
            console.log(`Java:            ${normalizedJava}`);

            expect(normalizedJS).to.equal(normalizedJava);
        });

        it('question role is emitted when isQuestion is true', async function () {
            const questionKIF = '(instance ?X Bar)';
            const result = convertFormulas(axioms, 'QuestKB', questionKIF, true);
            const conj = extractConjecture(result.content);

            expect(conj).to.not.be.null;
            expect(conj.role).to.equal('question');

            let javaOutput;
            try {
                javaOutput = await invokeJavaConverter(questionKIF);
            } catch (e) {
                console.warn(`Java invocation failed: ${e.message}`);
                this.skip();
                return;
            }

            // Same quantifier normalization as above
            const normalizedJS = normalizeTPTP(conj.body).replace(/\?\s*\[/, '! [');
            const normalizedJava = normalizeTPTP(javaOutput);

            console.log(`Question KIF:  ${questionKIF}`);
            console.log(`JS body:       ${normalizedJS}`);
            console.log(`Java:          ${normalizedJava}`);

            expect(normalizedJS).to.equal(normalizedJava);
        });
    });

    // -----------------------------------------------------------
    // e. KB structure verification
    // -----------------------------------------------------------
    describe('KB structure verification', function () {
        const formulas = [
            '(instance Foo Bar)',
            '(subclass Human Animal)',
            '(=> (instance ?X A) (instance ?X B))'
        ];

        it('header format is correct', function () {
            const result = convertFormulas(formulas, 'StructKB');
            expect(result.content).to.include('% Articulate Software');
            expect(result.content).to.include('www.ontologyportal.org');
            expect(result.content).to.include('KB StructKB');
        });

        it('axiom names follow kb_{name}_{N} pattern with sequential numbering', function () {
            const result = convertFormulas(formulas, 'StructKB');
            const axiomEntries = extractAxioms(result.content);

            expect(axiomEntries.length).to.equal(3);
            for (let i = 0; i < axiomEntries.length; i++) {
                expect(axiomEntries[i].name).to.equal(`kb_StructKB_${i + 1}`);
            }
        });
    });

    // -----------------------------------------------------------
    // f. Real KIF file pipeline (tinySUMO.kif)
    // -----------------------------------------------------------
    describe('Real KIF file pipeline', function () {
        it('reads tinySUMO.kif and compares first N axiom bodies against Java', async function () {
            if (!fs.existsSync(TINY_SUMO_PATH)) {
                console.warn(`WARNING: ${TINY_SUMO_PATH} not found, skipping`);
                this.skip();
                return;
            }

            const formulas = readKIFFile(TINY_SUMO_PATH);
            expect(formulas.length).to.be.greaterThan(0);

            const result = convertFormulas(formulas, 'tinySUMO');
            const axiomEntries = extractAxioms(result.content);
            expect(axiomEntries.length).to.be.greaterThan(0);

            // Compare up to the first 10 non-filtered axiom bodies
            const limit = Math.min(axiomEntries.length, 10);
            let compared = 0;

            // Build a map from TPTP body back to original KIF.
            // convertFormulas adds a comment "% f: <formatted>" before each axiom.
            // We can recover the original KIF by looking at the line before each fof line.
            const lines = result.content.split('\n');
            const axiomKIFs = [];
            for (let i = 0; i < lines.length; i++) {
                if (/^fof\(/.test(lines[i])) {
                    // The comment line with the original formula is the previous non-blank line
                    for (let j = i - 1; j >= 0; j--) {
                        if (lines[j].startsWith('% f: ')) {
                            axiomKIFs.push(lines[j].substring(5).trim());
                            break;
                        }
                    }
                }
            }

            for (let i = 0; i < limit; i++) {
                const jsBody = axiomEntries[i].body;
                const kif = axiomKIFs[i];

                if (!kif) continue;

                let javaOutput;
                try {
                    javaOutput = await invokeJavaConverter(kif);
                } catch (e) {
                    console.warn(`Java invocation failed for "${kif}": ${e.message}`);
                    continue;
                }

                const normalizedJS = normalizeTPTP(jsBody);
                const normalizedJava = normalizeTPTP(javaOutput);

                console.log(`[${i + 1}] KIF:     ${kif}`);
                console.log(`    JS body: ${normalizedJS}`);
                console.log(`    Java:    ${normalizedJava}`);

                expect(normalizedJS).to.equal(normalizedJava,
                    `Mismatch on axiom ${i + 1}: ${kif}`);
                compared++;
            }

            expect(compared).to.be.greaterThan(0, 'Should have compared at least one axiom');
            console.log(`Compared ${compared} axiom bodies from tinySUMO.kif`);
        });
    });
});
