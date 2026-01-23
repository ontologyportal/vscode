# SUO-KIF VSCode Language Support

A full-featured development environment for SUO-KIF (Standard Upper Ontology Knowledge Interchange Format) in Visual Studio Code. This extension provides comprehensive support for working with SUMO ontology files, including all features from the JEdit SUMO plugin and more.

For a formal specification of SUO-KIF, see ["Standard Upper Ontology - Knowledge Interchange Format" (Pease, 2009)](suo-kif.pdf).

## Installation

Download the VSIX from the Github releases page, then install the extension via VSCode: `Ctrl-Shift-P` > `Install Extension from File`

## Features

### Syntax Highlighting

Highlights syntax according to the SUO-KIF language specification:
- Logic Operators (`and`, `or`, `not`, `=>`, `<=>`)
- Quantifiers (`forall`, `exists`)
- Functions (uppercase prefix)
- Relations (lowercase prefix)
- String and number literals
- Escaped strings
- Classes and Instances
- Variables (`?var`) and Row Variables (`@row`)
- Parenthesis matching

### Symbol Lookup

Right-click a symbol and select **"SUO-KIF: Search Symbol in Workspace"** to get a listing of all uses of that symbol. Filter by argument position to find specific usages.

**Keybinding:** Available from context menu

### Go to Definition

Navigate directly to where a term is defined. The extension looks for defining relations like `instance`, `subclass`, `subrelation`, `domain`, etc.

**Keybinding:** `F12`

**Context Menu:** Right-click > **"SUO-KIF: Go to Definition"**

### Class Taxonomy Viewer

View the class hierarchy for any symbol. Shows:
- Superclass/ancestor tree
- Direct subclasses
- Documentation strings

**Context Menu:** Right-click > **"SUO-KIF: Show Class Taxonomy"**

### Code Formatting

Reformat axioms with standard SUMO indentation style. Select an expression and format it, or format the entire document.

**Keybinding:** `Ctrl+Shift+F` (with selection) or use Document Format

**Context Menu:** Right-click > **"SUO-KIF: Format Axiom"**

Formatting follows SUMO conventions:
- Proper indentation for nested expressions
- Arguments to logical operators on separate lines
- Quantifier variables kept together

### Browse Term in Sigma

Open any term directly in the online Sigma Knowledge Base browser at ontologyportal.org.

**Keybinding:** `Ctrl+Shift+B`

**Context Menu:** Right-click > **"SUO-KIF: Browse Term in Sigma"**

### Type Hinting / Signature Help

When typing a relation, a hint window appears showing:
- Documentation from `(documentation ...)` statements
- Argument types inferred from `(domain ...)` rules

### Auto-Completion

Get intelligent completions for all symbols defined in your workspace, with type and documentation information.

### Error Checking

Real-time validation including:
- Unclosed parenthesis detection
- Class naming conventions (classes should start with uppercase)
- Logical operator operand validation
- Arity checking against domain declarations
- Variable usage validation

**Context Menu:** Right-click > **"SUO-KIF: Check for Errors"**

### Generate TPTP File

Convert your SUO-KIF knowledge base to TPTP (TPTP Problem Library) format for use with theorem provers. The generated file opens in a new editor pane without saving to disk - you can then review and save it as needed.

**Context Menu:** Right-click > **"SUO-KIF: Generate TPTP File"**

Options:
- **Current File** - Convert the current .kif file
- **Entire Workspace** - Convert all .kif files in the workspace
- **Selection Only** - Convert only the selected text

The generated TPTP includes:
- Header with source information and timestamp
- Statistics on converted/skipped expressions
- Meaningful axiom names based on statement type
- Comments for any skipped expressions

### Theorem Prover Integration

Query selected expressions using Vampire or E-Prover theorem provers. Requires external prover installation.

**Context Menu:** Right-click > **"SUO-KIF: Query with Theorem Prover"**

## Configuration

Open VSCode settings (`Ctrl+,`) and search for "SUO-KIF" to configure:

| Setting | Default | Description |
|---------|---------|-------------|
| `suo-kif.language` | `EnglishLanguage` | Language for documentation strings |
| `suo-kif.sigmaUrl` | `http://sigma.ontologyportal.org:8080/sigma/Browse.jsp` | Sigma KB browser URL |
| `suo-kif.knowledgeBase` | `SUMO` | Knowledge base name in Sigma |
| `suo-kif.proverPath` | (empty) | Path to Vampire or E-Prover executable |
| `suo-kif.proverType` | `vampire` | Prover type: `vampire` or `eprover` |
| `suo-kif.proverTimeout` | `30` | Timeout in seconds for prover queries |
| `suo-kif.formatIndentSize` | `2` | Spaces per indentation level |

## Keyboard Shortcuts

| Command | Keybinding | Description |
|---------|------------|-------------|
| Go to Definition | `F12` | Jump to symbol definition |
| Format Axiom | `Ctrl+Shift+F` | Format selected expression |
| Browse in Sigma | `Ctrl+Shift+B` | Open term in Sigma browser |

## Context Menu Commands

Right-click in the editor to access:
- Search Symbol in Workspace
- Go to Definition
- Show Class Taxonomy
- Browse Term in Sigma
- Format Axiom (when text selected)
- Check for Errors
- Query with Theorem Prover (when text selected)
- Generate TPTP File

## Setting Up Theorem Provers

### Vampire

1. Download Vampire from https://vprover.github.io/
2. Set `suo-kif.proverPath` to the Vampire executable path
3. Set `suo-kif.proverType` to `vampire`

### E-Prover

1. Download E-Prover from https://wwwlehre.dhbw-stuttgart.de/~sschulz/E/E.html
2. Set `suo-kif.proverPath` to the E-Prover executable path
3. Set `suo-kif.proverType` to `eprover`

## Resources

- [SUMO (Suggested Upper Merged Ontology)](https://www.ontologyportal.org/)
- [Sigma Knowledge Engineering Environment](https://github.com/ontologyportal/sigmakee)
- [SUO-KIF Specification](suo-kif.pdf)

## Credits

This extension is inspired by the [SUMOjEdit](https://github.com/ontologyportal/SUMOjEdit) plugin for jEdit.
