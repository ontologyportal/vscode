# Merge Report: `ontologyportal/vscode` → `sumo-vscode`

Comparison of two VSCode extensions targeting SUMO / SUO-KIF.

- **Source (features to migrate FROM)**: `~/projects/vscode` — `ontologyportal.sumo` v3.2.0. JavaScript. In-process parser, KB state, and Sigma runtime.
- **Target (architecture to keep)**: `~/projects/sumo-vscode` — `sumo-parser.sumo-vscode` v0.1.0. TypeScript. Thin LSP client + kernel over `sumo-lsp` / `sumo serve` (Rust).

---

## 1. High-level architecture

| Dimension | `~/projects/vscode` (source) | `~/projects/sumo-vscode` (target) |
|---|---|---|
| Language | JavaScript (CommonJS) | TypeScript (ES2022, strict) |
| Entry | `extension.js` (~11 KB) | `src/extension.ts` (1,251 LOC) |
| Language intelligence | In-process, custom parser in `src/parser/` (~3,400 LOC) | Delegated to `sumo-lsp` binary via `vscode-languageclient` |
| KB state | `state.js` + `parser-cache.js` (JSON cache, SHA-256 fingerprint) | `kbSession.ts` + LMDB cache in `kernelDb.ts` |
| Sigma execution | Pluggable runtime: `local` (Java/py4j), `docker`, `daemon` (HTTP), `native` (experimental JS) | `sumo serve` kernel binary over ndjson JSON-RPC; ask/tell/prove |
| Multi-KB model | Single process, multiple KBs switchable | One window = one KB = one `sumo-lsp` process (OS-level namespace isolation) |
| Theorem prover | Config keys remain; logic removed in commit `a23450b` | Vampire invoked via kernel (`sumo.kernel.vampirePath`) |
| Tests | 27 unit + integration + VSCode-host tests | None in-tree |
| CI | None | GitHub Actions: `ci.yml`, `release.yml` (4-platform matrix) |
| Java dependency | Yes — `lib/SigmaBridge.jar`, `py4j.jar` | No |

The target repo is an **LSP client shell**. Almost all language intelligence (hover, goto-def, references, rename, symbols, semantic tokens, formatting, completion, diagnostics) is served by the external Rust binary — so migrating "features" from source to target means splitting each source feature into (a) things the LSP already covers and (b) UI / UX concerns the extension still has to own.

---

## 2. Visual & grammar assets (straightforward copy)

These should move from source into target with minimal translation.

| Asset | Source path | Target path | Notes |
|---|---|---|---|
| SUO-KIF grammar | `res/syntaxes/suo-kif.tmLanguage.json` (122 lines) | `syntaxes/kif.tmLanguage.json` (63 lines) | Source grammar is richer. **Keep source version**, rename to `kif.tmLanguage.json` (or add as `suo-kif.tmLanguage.json`). |
| TPTP grammar | `res/syntaxes/tptp.tmLanguage.json` (256 lines) | _absent_ | **New** — add, plus register `tptp` language with `.p`, `.tptp`, `.ax`. |
| Language config | `res/lang/suo-kif-language-configuration.json` | `language-configuration.json` | Target already has one. Diff and reconcile; target's has S-expr indentation + folding. |
| TPTP language config | `res/lang/tptp-language-configuration.json` | _absent_ | **New** — add alongside TPTP grammar. |
| Extension icon | `res/icon/extension-icon.png` | _absent_ (`images/` empty) | **New** — add and wire into `package.json` `"icon"` field. |
| .kif file icon | `res/icon/kif-file-icon.png` | _absent_ | **New** — file icon theme or menu icon. |
| .tptp file icon | `res/icon/tptp-file-icon.png` | _absent_ | **New**. |
| Documentation | `doc/suo-kif.pdf`, `doc/screenshots/*.png` | _absent_ | **New** — copy for README images. |

### `contributes.languages`
Target currently contributes only `kif`. To absorb source's TPTP support, add a second language entry plus grammar + language-configuration.

---

## 3. Commands: source → target mapping

Target has 17 commands (LSP / KB / kernel lifecycle). Source has 12 (user-facing features).

| Source command (`~/projects/vscode`) | Already in target? | Migration notes |
|---|---|---|
| `sumo.searchSymbol` | ~ (via LSP `workspace/symbol`) | Redundant if the LSP exposes workspace symbols. Drop unless source's UX adds something. |
| `sumo.showTaxonomy` | **Yes** — `sumo.showTaxonomy` | Target already has `src/taxonomy.ts` (486 LOC, Mermaid + svg-pan-zoom webview). Compare UX and decide whose webview is richer; likely keep target's but port any features (navigation history, right-click focus) from source's `src/taxonomy.js`. |
| `sumo.formatAxiom` (Ctrl/Cmd+Shift+F) | No | LSP should expose `textDocument/formatting` or `textDocument/rangeFormatting`. Preferred: delegate to LSP and wire a keybinding only. If LSP lacks range formatting for a selection, add a thin client command. |
| `sumo.browseInSigma` (Ctrl/Cmd+Shift+B) | No | Pure client concern — opens `sumo.sigma.url` with the symbol at the cursor. **Port as-is** into a new `src/browseInSigma.ts`. Add `sumo.sigma.url` config key. |
| `sumo.lookupQuery` | No | Verify what it does in source; likely a thin wrapper over ask. Map onto target's `sumo.ask.cursor`. |
| `sumo.checkErrors` | ~ (via LSP diagnostics, pushed proactively) | The LSP publishes diagnostics continuously. A manual "re-check" command is usually unnecessary. Drop unless explicitly desired as a refresh trigger. |
| `sumo.generateTPTP` | No | Kernel-side capability — expose via `sumo serve` if not already, then wire a VSCode command. If you keep JS TPTP generation as a fallback, port `src/generate-tptp.js` + `src/sigma/engine/native/` into the extension (not the LSP). |
| `sumo.openRepl` | ~ (conceptually covered by `sumo.ask.cursor` + ask webview) | Source's REPL is a full Pseudoterminal with history. Target has `src/askWebview.ts` for one-shot ask results. **Port**: add a REPL pseudo-terminal that talks to the same kernel JSON-RPC client (`src/kernelClient.ts`). |
| `sumo.openKnowledgeBase` | **Yes** — `sumo.kb.load` | Target has richer set (`sumo.kb.load`, `sumo.kb.openInNewWindow`, `sumo.kb.reloadConfig`, `sumo.kb.close`). Drop source version. |
| `sumo.createKnowledgeBase` | No | Scaffolds a new KB. **Port** — write a new `<kb>` node into `config.xml` via target's `src/config.ts` (already has preserveOrder write-back). |
| `sumo.kbExplorer.refresh` | ~ (`sumo.kb.reloadConfig`) | Drop; equivalent exists. |
| `sumo.kbExplorer.addFile` | **Yes** — `sumo.kb.addFile` | Drop. |
| `sumo.kbExplorer.removeFile` | **Yes** — `sumo.kb.removeFile` | Drop. |

### Keybindings to carry over
```
Ctrl/Cmd+Shift+F  →  sumo.formatAxiom  (when editorHasSelection && resourceLangId==kif)
Ctrl/Cmd+Shift+B  →  sumo.browseInSigma (when KB open && resourceLangId==kif)
```

---

## 4. Configuration keys

Target already owns server/kernel/diagnostics config. Source has Sigma-runtime and theorem-prover keys that don't exist in target.

### Keys to port into target's `package.json`

| Source key | Purpose | Target disposition |
|---|---|---|
| `sumo.general.language` | Documentation language | Already `sumo.documentation.language` — rename source usages or add alias. |
| `sumo.general.formatIndentSize` | Formatter indent width | New — or route into LSP via initialization options. |
| `sumo.sigma.url` | Online Sigma browser URL | **Add** (needed by `browseInSigma`). Default `https://sigma.ontologyportal.org`. |
| `sumo.sigma.knowledgeBase` | Default KB name | Likely redundant given per-window KB pinning. Drop. |
| `sumo.sigma.runtime` | `local \| docker \| daemon \| native` | **Drop** — target uses a single kernel binary. If native-JS TPTP is worth keeping, make it a kernel-independent helper. |
| `sumo.sigma.configXmlPath` | Path to `config.xml` | Already `sumo.configPath` — reconcile. |
| `sumo.sigma.srcPath`, `homePath`, `externalKBPath` | SigmaKEE layout | Drop (Java-specific). |
| `sumo.sigma.daemonUrl`, `dockerImage` | Alt-runtime specifics | Drop. |
| `sumo.sigma.enforceKBContext` | Require KB context for features | Consider porting as `sumo.kb.enforceContext`. |
| `sumo.sigma.disableKBCache` | Disable parser cache | Already `sumo.kernel.disableCache`. Alias or drop. |
| `sumo.theoremProver.path` | Prover binary | Already `sumo.kernel.vampirePath`. Reconcile. |
| `sumo.theoremProver.type` | `vampire \| eprover` | New if E-Prover support is desired; currently kernel-only. |
| `sumo.theoremProver.timeout` | Seconds | **Add** (pass as kernel ask parameter). |
| `sumo.theoremProver.tptpLang` | `fof \| tff \| thf` | **Add** if relevant for `generateTPTP`. |

---

## 5. Features present ONLY in source (port into target)

These are the items that actually need work.

1. **TPTP language support** — grammar, language-configuration, activation for `.p` / `.tptp` / `.ax`, document-symbol provider. Entirely new in target.
2. **Format axiom (selection formatter)** — `src/formatting.js` reformats enclosing S-expr with configurable indent. Prefer pushing to `sumo-lsp` as a formatting provider; otherwise port as a client command.
3. **Browse in Sigma** — pure client-side; trivial port.
4. **Create Knowledge Base** — scaffold new `<kb>` in `config.xml`; target has the write-back primitives already (`src/config.ts`).
5. **Interactive Ask/Tell REPL** — Pseudoterminal with history. Target has one-shot ask webview; extend to a REPL using `src/kernelClient.ts`.
6. **Generate TPTP file** — expose as a kernel RPC or keep as a client-side feature that calls the kernel for compilation.
7. **Status bar with KB summary + indicator** — source has a KB status bar item. Target shows an active-KB string somewhere; verify parity.
8. **Documentation PDF + screenshots** — ship in `doc/`.
9. **Extension / file icons** — add PNGs + wire `"icon"` and `"icons"` entries in `package.json`.
10. **Signature help content** — if `sumo-lsp` already serves `textDocument/signatureHelp` this is a no-op. Confirm.
11. **Rich completion with domain-type annotations** — if LSP's completion already shows domain types in `detail`/`documentation`, no-op. Confirm.

---

## 6. Features that should NOT migrate

These duplicate what the target gets from the LSP / kernel or contradict the target's architecture.

- Entire `src/parser/` subtree (tokenizer, parser, symbol table, term semantics, formula, query, serialization, cache) — ~3,400 LOC replaced by `sumo-lsp`.
- `src/sigma/engine/local.js`, `docker.js`, `remote.js`, `native/` — alternate runtimes conflict with the single-kernel design. Kill all four. Re-expose what the native JS engine did (TPTP generation) through the kernel or a small client-side helper if essential.
- `lib/SigmaBridge.jar`, `lib/py4j.jar`, `lib/src/com/articulate/sigma/SigmaBridge.java` — Java interop, unused once Sigma runtimes are dropped.
- `src/parser-cache.js` — superseded by kernel's LMDB cache.
- `src/state.js` (workspace definitions, symbol tables) — LSP owns symbols.
- `sumo.checkErrors`, `sumo.kbExplorer.refresh` commands (duplicates of target's).
- `sumo.theoremProver.*` config keys (legacy — reconcile with `sumo.kernel.*`).

---

## 7. Tests

Target has no tests. Source has three tiers (`test/`, `test-integration/`, `test-vscode/`). Most of `test/` validates the in-process parser — obsolete once the LSP takes over. Worth keeping / porting:

- `test-vscode/suite/goToDefinition.test.js`, `searchSymbol.test.js`, `showTaxonomy.test.js`, `browseInSigma.test.js`, `formatAxiom.test.js`, `kbManagement.test.js`, `generateTPTP.test.js`, `openRepl.test.js` — behavioural tests of the VSCode surface. Translate to TypeScript and run against the new LSP-backed extension.
- `test-fixtures/workspace/simple.kif`, `errors.kif`, `.vscode/settings.json` — reusable.
- `test-vscode/runTests.js`, `setup-sumo.js` — harness adapts to TS.

Drop: `test/*.test.js` covering parser, sigma engines (local/remote/daemon), REPL internals — all replaced.

---

## 8. Proposed migration sequence

Each step should be landable on its own; nothing below forces a "big bang".

1. **Visual layer** (no behaviour change): copy `res/syntaxes/suo-kif.tmLanguage.json` over `syntaxes/kif.tmLanguage.json`; add TPTP grammar + language-configuration + `tptp` language contribution; copy icons; wire `package.json` `"icon"`.
2. **Browse in Sigma**: port `sumo.browseInSigma` + keybinding + `sumo.sigma.url` config. Trivial; zero LSP dependency.
3. **Create KB**: port `sumo.kb.create` using target's existing `config.xml` write-back.
4. **Format axiom**: confirm `sumo-lsp` exposes formatting. If yes, wire keybinding only. If no, port `src/formatting.js` as a client command.
5. **TPTP generation**: decide kernel-vs-client. Port or add an RPC.
6. **REPL terminal**: extend `askWebview.ts` to a Pseudoterminal REPL using `kernelClient.ts`.
7. **Tests**: port the `test-vscode/suite/*` cases that remain meaningful, translated to TS.
8. **Documentation**: copy `doc/suo-kif.pdf` + screenshots; update target's README to show off the ported features.
9. **Cleanup**: audit `package.json` settings; remove any leftover `sumo.theoremProver.*` / `sumo.sigma.*` keys from source that didn't make it in, and document the reconciliations in `CHANGELOG.md`.

---

## 9. Open questions for you

1. **TPTP generation**: kernel-side (add an RPC to `sumo serve`) or client-side (keep a lightweight JS converter)? The former is cleaner but needs a kernel change.
2. **E-Prover support**: source exposes it in config; target's kernel assumes Vampire. Drop E-Prover support, or plumb it through?
3. **Native JS Sigma runtime**: explicitly dropped, or preserve TPTP conversion as a fallback for users without the kernel?
4. **Command namespace**: keep target's `sumo.kb.*` / `sumo.kernel.*` prefixes, or accept some of source's shorter names (`sumo.openKnowledgeBase`)? Target's are more consistent.
5. **Publisher switch**: target is published as `sumo-parser.sumo-vscode`; source as `ontologyportal.sumo`. Which publisher/name wins post-merge?
6. **Version**: source is at 3.2.0, target at 0.1.0. Ship merged result as 3.3.0 under the target's name, or reset?
