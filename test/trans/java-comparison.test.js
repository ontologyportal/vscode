/**
 * Java Comparison Tests
 *
 * These tests compare the JavaScript implementation output against the Java implementation
 * by invoking the Java CLI and comparing results.
 *
 * Prerequisites:
 * - SIGMA_CP environment variable must be set with the Java classpath
 * - Java must be installed and accessible
 * - Sigma KB must be initialized (for some tests)
 *
 * Run with: npm run test:java
 */

const { expect } = require('chai');
const { exec } = require('child_process');
const { promisify } = require('util');
const { tptpParseSUOKIFString, setLang, setHideNumbers } = require('../../src/sigma/engine/native/SUMOformulaToTPTPformula');

const execAsync = promisify(exec);

// Get SIGMA_CP from environment or construct default path
const SIGMA_CP = process.env.SIGMA_CP || '';
const SIGMA_HOME = process.env.SIGMA_HOME || '/home/iggy/projects/sigmakee';

// Check if Java environment is available
async function isJavaAvailable() {
    try {
        await execAsync('java -version');
        return true;
    } catch (e) {
        return false;
    }
}

// Check if SIGMA_CP is set
function isSigmaCPSet() {
    return SIGMA_CP !== '' || process.env.SIGMA_CP;
}

/**
 * Invoke the Java SUMOformulaToTPTPformula CLI
 * @param {string} formula - The KIF formula to convert
 * @returns {Promise<string>} The TPTP output
 */
async function invokeJavaConverter(formula) {
    const classpath = SIGMA_CP || process.env.SIGMA_CP;
    if (!classpath) {
        throw new Error('SIGMA_CP environment variable not set');
    }

    // Escape the formula for shell
    const escapedFormula = formula.replace(/"/g, '\\"');

    const cmd = `java -Xmx8g -classpath "${classpath}" com.articulate.sigma.trans.SUMOformulaToTPTPformula -g "${escapedFormula}"`;

    try {
        const { stdout, stderr } = await execAsync(cmd, {
            timeout: 30000,
            env: { ...process.env, SIGMA_HOME }
        });

        // The Java output may include logging info, extract just the TPTP formula
        const lines = stdout.trim().split('\n');
        // Find the line that looks like a TPTP formula (starts with '(' or contains TPTP syntax)
        for (const line of lines) {
            if (line.trim().startsWith('(') && line.includes('s__')) {
                return line.trim();
            }
        }
        // If no specific line found, return last non-empty line
        return lines.filter(l => l.trim()).pop() || stdout.trim();
    } catch (error) {
        throw new Error(`Java invocation failed: ${error.message}`);
    }
}

/**
 * Normalize TPTP output for comparison
 * - Removes extra whitespace
 * - Sorts variable lists in quantifiers (since order may differ)
 * - Normalizes semantically equivalent parenthesization around implication consequents
 */
function normalizeTPTP(tptp) {
    if (!tptp) return '';

    // Normalize whitespace
    let normalized = tptp.replace(/\s+/g, ' ').trim();

    // Sort variable lists in quantifiers for consistent comparison
    normalized = normalized.replace(/(\[)([^\]]+)(\])/g, (match, open, vars, close) => {
        const sortedVars = vars.split(',').map(v => v.trim()).sort().join(',');
        return open + sortedVars + close;
    });

    // Normalize extra parens around implication consequent: => (pred(args)) to => pred(args)
    // Both forms are semantically equivalent in TPTP
    normalized = normalized.replace(/=> \((\w+\([^()]*\))\)/g, '=> $1');

    return normalized;
}

describe('Java Comparison Tests', function() {
    // Increase timeout for Java invocations
    this.timeout(60000);

    let javaAvailable = false;
    let sigmaCPSet = false;

    before(async function() {
        javaAvailable = await isJavaAvailable();
        sigmaCPSet = isSigmaCPSet();

        if (!javaAvailable) {
            console.warn('WARNING: Java not available, skipping Java comparison tests');
        }
        if (!sigmaCPSet) {
            console.warn('WARNING: SIGMA_CP not set, skipping Java comparison tests');
            console.warn('Set SIGMA_CP to the Sigma classpath to enable these tests');
        }
    });

    beforeEach(function() {
        setLang('fof');
        setHideNumbers(true);

        if (!javaAvailable || !sigmaCPSet) {
            this.skip();
        }
    });

    describe('Simple formulas', function() {
        const testCases = [
            {
                name: 'simple instance',
                kif: '(instance Foo Bar)'
            },
            {
                name: 'simple subclass',
                kif: '(subclass Human Animal)'
            },
            {
                name: 'implication',
                kif: '(=> (instance ?X P) (instance ?X Q))'
            },
            {
                name: 'conjunction',
                kif: '(and (instance ?X A) (instance ?X B))'
            },
            {
                name: 'disjunction',
                kif: '(or (instance ?X A) (instance ?X B))'
            },
            {
                name: 'negation',
                kif: '(not (instance ?X A))'
            }
        ];

        for (const tc of testCases) {
            it(`compares ${tc.name}`, async function() {
                const jsOutput = tptpParseSUOKIFString(tc.kif, false);

                let javaOutput;
                try {
                    javaOutput = await invokeJavaConverter(tc.kif);
                } catch (e) {
                    console.warn(`Java invocation failed for "${tc.kif}": ${e.message}`);
                    this.skip();
                    return;
                }

                const normalizedJS = normalizeTPTP(jsOutput);
                const normalizedJava = normalizeTPTP(javaOutput);

                console.log(`KIF:  ${tc.kif}`);
                console.log(`JS:   ${normalizedJS}`);
                console.log(`Java: ${normalizedJava}`);

                expect(normalizedJS).to.equal(normalizedJava);
            });
        }
    });

    describe('Complex formulas', function() {
        const testCases = [
            {
                name: 'nested implication',
                kif: '(=> (and (instance ?X A) (instance ?Y B)) (related ?X ?Y))'
            },
            {
                name: 'biconditional',
                kif: '(<=> (instance ?X A) (instance ?X B))'
            },
            {
                name: 'forall quantifier',
                kif: '(forall (?X) (instance ?X Entity))'
            },
            {
                name: 'exists quantifier',
                kif: '(exists (?X) (instance ?X Entity))'
            },
            {
                name: 'nested quantifiers',
                kif: '(forall (?X) (exists (?Y) (related ?X ?Y)))'
            },
            {
                name: 'equality',
                kif: '(equal ?X ?Y)'
            },
            {
                name: 'function term',
                kif: '(instance (WhenFn ?E) TimeInterval)'
            }
        ];

        for (const tc of testCases) {
            it(`compares ${tc.name}`, async function() {
                const jsOutput = tptpParseSUOKIFString(tc.kif, false);

                let javaOutput;
                try {
                    javaOutput = await invokeJavaConverter(tc.kif);
                } catch (e) {
                    console.warn(`Java invocation failed for "${tc.kif}": ${e.message}`);
                    this.skip();
                    return;
                }

                const normalizedJS = normalizeTPTP(jsOutput);
                const normalizedJava = normalizeTPTP(javaOutput);

                console.log(`KIF:  ${tc.kif}`);
                console.log(`JS:   ${normalizedJS}`);
                console.log(`Java: ${normalizedJava}`);

                expect(normalizedJS).to.equal(normalizedJava);
            });
        }
    });

    describe('Embedded relations (mention suffix)', function() {
        const testCases = [
            {
                name: 'equal as argument',
                kif: '(instance equal BinaryPredicate)'
            },
            {
                name: 'relation as argument',
                kif: '(domain instance 1 Entity)'
            },
            {
                name: 'function name in argument',
                kif: '(instance AdditionFn BinaryFunction)'
            }
        ];

        for (const tc of testCases) {
            it(`compares ${tc.name}`, async function() {
                const jsOutput = tptpParseSUOKIFString(tc.kif, false);

                let javaOutput;
                try {
                    javaOutput = await invokeJavaConverter(tc.kif);
                } catch (e) {
                    console.warn(`Java invocation failed for "${tc.kif}": ${e.message}`);
                    this.skip();
                    return;
                }

                const normalizedJS = normalizeTPTP(jsOutput);
                const normalizedJava = normalizeTPTP(javaOutput);

                console.log(`KIF:  ${tc.kif}`);
                console.log(`JS:   ${normalizedJS}`);
                console.log(`Java: ${normalizedJava}`);

                expect(normalizedJS).to.equal(normalizedJava);
            });
        }
    });

    describe('Numbers and special values', function() {
        const testCases = [
            {
                name: 'integer',
                kif: '(lessThan ?X 0)'
            },
            {
                name: 'decimal',
                kif: '(lessThan ?X 3.14)'
            },
            {
                name: 'negative number',
                kif: '(lessThan -5 ?X)'
            }
        ];

        for (const tc of testCases) {
            it(`compares ${tc.name}`, async function() {
                const jsOutput = tptpParseSUOKIFString(tc.kif, false);

                let javaOutput;
                try {
                    javaOutput = await invokeJavaConverter(tc.kif);
                } catch (e) {
                    console.warn(`Java invocation failed for "${tc.kif}": ${e.message}`);
                    this.skip();
                    return;
                }

                const normalizedJS = normalizeTPTP(jsOutput);
                const normalizedJava = normalizeTPTP(javaOutput);

                console.log(`KIF:  ${tc.kif}`);
                console.log(`JS:   ${normalizedJS}`);
                console.log(`Java: ${normalizedJava}`);

                expect(normalizedJS).to.equal(normalizedJava);
            });
        }
    });

    describe('Test cases from Java unit tests', function() {
        // These are the exact test cases from SUMOformulaToTPTPformulaTest.java
        const testCases = [
            {
                name: 'string1',
                kif: '(=> (instance ?X P)(instance ?X Q))'
            },
            {
                name: 'string2',
                kif: '(=> (or (instance ?X Q)(instance ?X R))(instance ?X ?T))'
            },
            {
                name: 'string3',
                kif: '(or (not (instance ?X Q))(instance ?X R))'
            },
            {
                name: 'string4',
                kif: '(<=> (instance ?NUMBER NegativeRealNumber) (and (lessThan ?NUMBER 0) (instance ?NUMBER RealNumber)))'
            },
            {
                name: 'string6',
                kif: '(<=> (temporalPart ?POS (WhenFn ?THING)) (time ?THING ?POS))'
            },
            {
                name: 'embedded',
                kif: '(instance equal BinaryPredicate)'
            }
        ];

        for (const tc of testCases) {
            it(`compares ${tc.name}`, async function() {
                const jsOutput = tptpParseSUOKIFString(tc.kif, false);

                let javaOutput;
                try {
                    javaOutput = await invokeJavaConverter(tc.kif);
                } catch (e) {
                    console.warn(`Java invocation failed for "${tc.kif}": ${e.message}`);
                    this.skip();
                    return;
                }

                const normalizedJS = normalizeTPTP(jsOutput);
                const normalizedJava = normalizeTPTP(javaOutput);

                console.log(`KIF:  ${tc.kif}`);
                console.log(`JS:   ${normalizedJS}`);
                console.log(`Java: ${normalizedJava}`);

                expect(normalizedJS).to.equal(normalizedJava);
            });
        }
    });
});

describe('Java Availability Check', function() {
    it('reports Java availability', async function() {
        const available = await isJavaAvailable();
        console.log(`Java available: ${available}`);
        console.log(`SIGMA_CP set: ${isSigmaCPSet()}`);
        if (process.env.SIGMA_CP) {
            console.log(`SIGMA_CP: ${process.env.SIGMA_CP.substring(0, 100)}...`);
        }
        // This test always passes - it's just for reporting
        expect(true).to.equal(true);
    });
});
