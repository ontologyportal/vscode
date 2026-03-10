/**
 * Scaling benchmark: parse Merge.kif and validate all terms.
 * Run with:  node test/parser/bench.js
 */

'use strict';

const path = require('path');
const { readFileSync } = require('fs');
const { kif, semantics } = require('../../src/parser/index.js');
const { SymbolTable } = require('../../src/parser/symbol.js');

const KIF_PATH = path.resolve(__dirname, '../Merge.kif');
const contents = readFileSync(KIF_PATH, 'utf-8');

function bench(label, fn, runs = 5) {
    fn(); // warm up
    const times = [];
    for (let i = 0; i < runs; i++) {
        const t0 = performance.now();
        fn();
        times.push(performance.now() - t0);
    }
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    const min = Math.min(...times);
    const max = Math.max(...times);
    console.log(`${label}`);
    console.log(`  avg ${avg.toFixed(1)} ms  min ${min.toFixed(1)} ms  max ${max.toFixed(1)} ms`);
    return avg;
}

// ── Phase 1: kif() ──────────────────────────────────────────────────────────
console.log('\n=== kif() — tokenize + parse + syntax ===');
let lastResult;
const kifTime = bench('kif(Merge.kif)', () => {
    lastResult = kif(contents, 'Merge.kif');
});

const { symbolTable: baseSymbolTable, errors: kifErrors } = lastResult;
console.log(`  sentences : ${baseSymbolTable.sentences.size}`);
console.log(`  symbols   : ${Object.keys(baseSymbolTable.symbols).length}`);
if (baseSymbolTable._index) {
    console.log(`  index keys: ${baseSymbolTable._index.size}`);
}
console.log(`  errors    : ${kifErrors.length}`);

// ── Phase 2: semantics() (Term construction only) ───────────────────────────
// Parse once outside the loop; measure only Term construction.
const { symbolTable: semST } = kif(contents, 'Merge.kif');

console.log('\n=== semantics() — build Term objects (no re-parse) ===');
let lastSem;
const semTime = bench('semantics(pre-parsed symbolTable)', () => {
    // Clear forward refs so Term construction is repeatable
    for (const sym of Object.values(semST.symbols)) sym.forward = undefined;
    lastSem = semantics(semST);
});
const { terms, errors: semErrors } = lastSem;
console.log(`  terms     : ${terms.size}`);
console.log(`  errors    : ${semErrors.length}`);

// Helper: cold-validate against a pre-parsed symbol table
function coldValidate(label, runs = 5) {
    // One fresh parse for this scenario
    const st = new SymbolTable(label.opts);
    kif(contents, 'Merge.kif', st);

    let lastPass = 0, lastFail = 0;
    const t = bench(label.name, () => {
        for (const sym of Object.values(st.symbols)) sym.forward = undefined;
        const { terms: freshTerms } = semantics(st);
        let pass = 0, fail = 0;
        for (const term of freshTerms.values()) {
            try { term.validate(); pass++; }
            catch (_) { fail++; }
        }
        lastPass = pass; lastFail = fail;
    }, runs);
    console.log(`  pass: ${lastPass}  fail: ${lastFail}`);
    return t;
}

// ── Phase 3a: validate() cold — level-1 index only (default) ────────────────
console.log('\n=== validate() — cold cache, level-1 index only (default) ===');
const validateL1 = coldValidate({ name: 'validate cold (L1 index)', opts: {} });

// ── Phase 3b: validate() cold — level-1 + level-2 index (deepIndex) ─────────
console.log('\n=== validate() — cold cache, level-1 + level-2 index (deepIndex: true) ===');
const validateL2 = coldValidate({ name: 'validate cold (L2 index)', opts: { deepIndex: true } });

// ── Phase 4: warm cache ──────────────────────────────────────────────────────
console.log('\n=== validate() — warm cache ===');
const warmST = new SymbolTable({ deepIndex: true });
kif(contents, 'Merge.kif', warmST);
for (const sym of Object.values(warmST.symbols)) sym.forward = undefined;
const { terms: warmTerms } = semantics(warmST);
for (const term of warmTerms.values()) { try { term.validate(); } catch (_) {} }
const warmTime = bench('validate all terms (warm cache)', () => {
    for (const term of warmTerms.values()) { try { term.validate(); } catch (_) {} }
});

// ── Summary ──────────────────────────────────────────────────────────────────
console.log('\n=== summary ===');
console.log(`  kif()                  ${kifTime.toFixed(1)} ms`);
console.log(`  semantics()            ${semTime.toFixed(1)} ms`);
console.log(`  validate() cold  L1    ${validateL1.toFixed(1)} ms`);
console.log(`  validate() cold  L2    ${validateL2.toFixed(1)} ms`);
console.log(`  validate() warm        ${warmTime.toFixed(1)} ms`);
