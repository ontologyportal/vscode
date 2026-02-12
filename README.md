# SUMO VSCode Extension

A development environment for [SUMO](sumo.pdf) and [TPTP](https://www.tptp.org/) in Visual Studio Code. Provides language support, code intelligence, SigmaKEE integration, and theorem proving for working with the [SUMO](https://www.ontologyportal.org/) ontology and related knowledge bases.

## Supported Languages

| Language | File Extensions | Description |
|----------|----------------|-------------|
| SUMO  | `.kif` | Standard Upper Ontology Knowledge Interchange Format |
| TPTP     | `.p`, `.tptp`, `.ax` | Thousands of Problems for Theorem Provers |

Both languages include syntax highlighting, bracket matching, and auto-closing pairs. TPTP files additionally support code folding for formula declarations and block comments (`/* */`).

## Commands

All commands are available from the Command Palette (`Ctrl+Shift+P`). Commands marked with **(ctx)** also appear in the editor right-click context menu when editing `.kif` files.

### Navigation & Search

| Command | Keybinding | Description |
|---------|------------|-------------|
| **Search Symbol in Workspace** **(ctx)** | | Searches all `.kif` files in the workspace for occurrences of a symbol. Allows filtering by position in expression: predicate/head position, argument 1-4, or all positions. Opens a quick pick showing every match with surrounding context, and navigates to the selected occurrence. |
| **Go to Definition** **(ctx)** | `F12` | Jumps to the definition of the symbol under the cursor. Searches for defining relations (`instance`, `subclass`, `subrelation`, `domain`, `domainSubclass`, `range`, `rangeSubclass`, `documentation`, `format`, `termFormat`). If multiple definitions exist, presents a quick pick to choose between them. |
| **Show Class Taxonomy** **(ctx)** | | Opens an interactive webview panel showing the class hierarchy for a symbol. Displays superclasses (ancestors) and direct subclasses (children) as a navigable tree. Includes documentation for each node. Detects and reports cycles in the taxonomy graph. Nodes can be right-clicked to focus on that symbol or search for it in the workspace. |
| **Browse Term in Sigma** **(ctx)** | `Ctrl+Shift+B` | Opens the selected symbol in the Sigma knowledge base browser (configurable URL, defaults to the public Sigma instance). Skips variables (`?` and `@` prefixed tokens). |

### Editing

| Command | Keybinding | Description |
|---------|------------|-------------|
| **Format Axiom** **(ctx)** | `Ctrl+Shift+F` (when selection active) | Reformats the selected S-expression with standard SUMO indentation. If nothing is selected, finds and formats the enclosing expression. Logical operators place each argument on a new line; quantifiers keep variable lists inline; regular predicates keep arguments on the same line. Indent size is configurable. |

### Validation

| Command | Description |
|---------|-------------|
| **Check for Errors** **(ctx)** | Runs extended validation on the current file beyond the real-time diagnostics. Checks node structure, variable usage, arity against `domain` declarations, relation usage patterns, and empty relation lists. Results appear in the Problems panel. |

### TPTP Generation

| Command | Description |
|---------|-------------|
| **Generate TPTP File** **(ctx)** | Converts SUMO to TPTP format. Offers multiple scope options: current file, selection only, entire workspace, full KB export from `config.xml`, or custom file selection. KB-level operations (workspace conversion, KB export) require working within a configured KB directory unless `enforceKBContext` is disabled. Opens the result in a new editor pane and reports the axiom count. Supports `fof`, `tff`, and `thf` output formats. |

### Theorem Proving

| Command | Description |
|---------|-------------|
| **Query with Theorem Prover** **(ctx)** | Takes the currently selected KIF formula as a conjecture, converts it along with the workspace files as axioms into TPTP, and invokes the configured prover. Reports the result: Theorem (proved), CounterSatisfiable, Unsatisfiable, or Timeout. Only available when text is selected. |
| **Run Prover on...** **(ctx)** | Runs the theorem prover with a selectable scope: selection/current line, current file, or entire workspace. Converts to TPTP using the configured Sigma runtime, invokes the prover, and displays the axiom count and SZS status result in a notification and output channel. |

### Knowledge Base Management

| Command | Description |
|---------|-------------|
| **Open Knowledge Base** | Reads the Sigma `config.xml` file, presents a quick pick of all configured KBs (showing name and constituent file count), and adds the selected KB's directory to the workspace as a folder. If `config.xml` is not found, offers to open settings. |
| **Create Knowledge Base** | Creates a new KB entry in Sigma's `config.xml`. Prompts for a KB name, then opens a folder picker. Scans the selected folder for `.kif` files and registers them as constituents in `config.xml`. After creation, offers to open the new KB directory in the workspace. |

## Language Providers

These features work automatically in the background while editing `.kif` files.

### Hover Information

Hovering over a symbol displays:
- **Documentation** extracted from `(documentation ...)` predicates in the workspace, filtered by the configured language (default: `EnglishLanguage`).
- **Argument types** inferred from `(domain ...)` declarations, showing what types each argument position expects.

### Autocomplete

Typing in a `.kif` file triggers completions drawn from all symbols found across the workspace. Each suggestion includes documentation and argument type information from `domain` declarations.

### Signature Help

When typing inside an S-expression (triggered by space or `(`), a signature popup shows:
- The relation or function name.
- Argument types from `domain` declarations.
- The currently active parameter is highlighted.
- The signature expands dynamically as more arguments are entered.

### Document Formatting

Full-document formatting (`Shift+Alt+F`) and range formatting are supported. All top-level S-expressions are reformatted according to SUMO conventions.

### Real-Time Diagnostics

The extension validates `.kif` files on open, edit, and save, reporting problems in the Problems panel:

- **Syntax errors** -- unclosed parentheses, invalid operands to logical operators, atoms in sentence positions.
- **Naming conventions** -- classes and types passed to `subclass`/`instance` should start with uppercase; relations should start with lowercase.
- **Arity checking** -- argument counts validated against `domain` declarations in the workspace.
- **Variable tracking** -- identifies quantified vs. free variables.
- **Relation usage** -- flags empty relation lists and validates minimum argument counts.

### TPTP Document Symbols

For `.tptp`/`.p`/`.ax` files, the extension provides an outline view and breadcrumbs. All formula declarations (`fof`, `tff`, `thf`, `cnf`, `tpi`) and `include` directives are extracted and categorized by role (axiom, conjecture, theorem, etc.).

## Status Bar

A status bar item on the right side shows the current KB context:

| Display | Meaning |
|---------|---------|
| `KB: [name]` | Working within a configured knowledge base |
| `KB: Outside` (warning) | A `config.xml` was found but the current workspace is outside any KB directory |
| `KB: Unrestricted` | KB enforcement is disabled; all operations available |
| *(hidden)* | No `config.xml` found |

Clicking the status bar item triggers TPTP generation. The status updates automatically when workspace folders, the active editor, or relevant settings change.

## Sigma Runtime Modes

The extension uses SigmaKEE to convert SUMO to TPTP. Three runtime modes are available, configured via `sumo.sigma.runtime`:

### Native JS (`native (experimental)`)

A pure JavaScript re-implementation of Sigma's conversion pipeline built into the extension. No external software required. Handles formula parsing, KB file reading, TPTP conversion, and predicate filtering. Supports `fof`, `tff`, and `thf` output.

### Local (`local`)

Uses a local SigmaKEE installation invoked via Java. Requires the `SIGMA_SRC` or `SIGMA_CP` environment variable, or the `sumo.sigma.srcPath` setting to point to the Sigma source directory.

### Docker (`docker`)

Uses a running Docker container with the Sigma image. Automatically locates a running container from the configured image (`apease/sigmakee` by default). Mounts the workspace for file access.

## Configuration

### General

| Setting | Default | Description |
|---------|---------|-------------|
| `sumo.general.language` | `EnglishLanguage` | Language for documentation strings. |
| `sumo.general.formatIndentSize` | `2` | Spaces per indentation level when formatting. |

### Sigma

| Setting | Default | Description |
|---------|---------|-------------|
| `sumo.sigma.runtime` | `local` | Runtime mode: `local`, `docker`, or `native (experimental)`. |
| `sumo.sigma.url` | `http://sigma.ontologyportal.org:8080/sigma/Browse.jsp` | URL of the Sigma KB browser for the Browse command. |
| `sumo.sigma.knowledgeBase` | `SUMO` | Knowledge base name to use in the Sigma browser. |
| `sumo.sigma.srcPath` | *(empty)* | Path to SigmaKEE source directory. Falls back to `$SIGMA_SRC`. |
| `sumo.sigma.homePath` | *(empty)* | Path to SigmaKEE home directory. Falls back to `$SIGMA_HOME`. |
| `sumo.sigma.dockerImage` | `apease/sigmakee` | Docker image for the Docker runtime. |
| `sumo.sigma.externalKBPath` | *(empty)* | Path to an external KB directory (e.g. SUMO) for integration during TPTP generation. |
| `sumo.sigma.configXmlPath` | *(empty)* | Explicit path to Sigma's `config.xml`. If unset, the extension searches `$SIGMA_HOME/KBs/`, `~/.sigmakee/KBs/`, `~/sigmakee/KBs/`, and other common locations. |
| `sumo.sigma.enforceKBContext` | `true` | When enabled, KB-level operations require the workspace to be within a configured KB directory. Disable for unrestricted access. |

### Theorem Prover

| Setting | Default | Description |
|---------|---------|-------------|
| `sumo.theoremProver.path` | *(empty)* | Path to the theorem prover executable. |
| `sumo.theoremProver.type` | `vampire` | Prover type: `vampire` or `eprover`. |
| `sumo.theoremProver.timeout` | `30` | Prover timeout in seconds. |
| `sumo.theoremProver.tptpLang` | `fof` | TPTP output format: `fof` (first-order), `tff` (typed first-order), or `thf` (typed higher-order). |

## Requirements

- **VSCode** 1.70 or later
- **Java** (for Local Sigma mode)
- **Docker** (for Docker Sigma mode)
- **Vampire** or **E-Prover** (for theorem proving commands)

The Native JS runtime mode has no external dependencies.

## Installation

Install from the VSCode Marketplace or build from source:

```
git clone https://github.com/ontologyportal/vscode
cd vscode
npm install
```

Then press `F5` in VSCode to launch an Extension Development Host, or package as a `.vsix`:

```
npx vsce package
```

## Resources

- [SUMO (Suggested Upper Merged Ontology)](https://www.ontologyportal.org/)
- [Sigma Knowledge Engineering Environment](https://github.com/ontologyportal/sigmakee)
- [SUMO Specification](sumo.pdf)
- [TPTP Problem Library](https://www.tptp.org/)
- [Vampire Theorem Prover](https://vprover.github.io/)
- [E Theorem Prover](https://wwwlehre.dhbw-stuttgart.de/~sschulz/E/E.html)

## License

MIT

## Credits

This extension builds on the [SUMOjEdit](https://github.com/ontologyportal/SUMOjEdit) plugin for jEdit and incorporates conversion logic from the [SigmaKEE](https://github.com/ontologyportal/sigmakee) project.
