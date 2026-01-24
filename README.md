# SUO-KIF VSCode Language Support

A full-featured development environment for SUO-KIF (Standard Upper Ontology Knowledge Interchange Format) in Visual Studio Code. This extension provides comprehensive support for working with SUMO ontology files, including all features from the JEdit SUMO plugin and advanced theorem proving capabilities.

For a formal specification of SUO-KIF, see ["Standard Upper Ontology - Knowledge Interchange Format" (Pease, 2009)](suo-kif.pdf).

## Features

### Syntax Highlighting & Code Intelligence
*   **Syntax Highlighting:** Full support for logic operators, quantifiers, variables (`?var`, `@row`), and string literals.
*   **Symbol Lookup:** Right-click > **"SUO-KIF: Search Symbol in Workspace"** to find usages.
*   **Go to Definition:** (`F12`) Jump to defining relations like `instance`, `subclass`, `domain`.
*   **Class Taxonomy:** Right-click > **"SUO-KIF: Show Class Taxonomy"** to visualize class hierarchies.
*   **Type Hinting:** Hover over relations to see argument types inferred from `(domain ...)` rules.
*   **Formatting:** (`Ctrl+Shift+F`) Reformat axioms with standard SUMO indentation.

### TPTP Generation & Theorem Proving
This extension integrates with **SigmaKEE** to convert SUO-KIF to TPTP, allowing you to run consistency checks and proof queries using provers like **Vampire** or **E-Prover**.

*   **Generate TPTP:** Convert your workspace or specific files to TPTP format for analysis.
*   **Run Prover:** Directly invoke a theorem prover on your ontology to check for logical consistency or prove theorems.

#### Modes of Operation
1.  **Docker (Recommended):** Uses the official `adampease/sigmakee` Docker image. Requires Docker installed.
2.  **Local Sigma:** Uses a local installation of SigmaKEE (requires Java).
3.  **Context Aware:** Can integrate your current workspace with an **External Knowledge Base** (like the standard SUMO library) for full context validation.

## Installation & Setup

1.  Install the extension from the VSCode Marketplace or VSIX.
2.  **Theorem Prover:** Download [Vampire](https://vprover.github.io/) or [E-Prover](https://wwwlehre.dhbw-stuttgart.de/~sschulz/E/E.html) and set the path in settings (`suo-kif.proverPath`).

### Configuring SigmaKEE (Required for TPTP/Proving)

To generate valid TPTP, the extension uses SigmaKEE. You can choose one of two methods:

**Option A: Docker (Easiest)**
1.  Install Docker Desktop.
2.  In VSCode Settings, enable `suo-kif.useDocker`.
3.  (Optional) Set `suo-kif.dockerImage` (default: `adampease/sigmakee`).

**Option B: Local Installation**
1.  Clone and build [SigmaKEE](https://github.com/ontologyportal/sigmakee).
2.  In VSCode Settings, set `suo-kif.sigmaPath` to your SigmaKEE directory (the folder containing `build/` or `lib/`).

## Usage

### 1. Generating TPTP
Right-click in an editor and select **"SUO-KIF: Generate TPTP File"**.
*   **Selection/File/Workspace:** Choose the scope of conversion.
*   **Context:** Choose **"Standalone"** (just your files) or **"Integrate with External KB"** (e.g., merge your work with SUMO).

### 2. Running the Theorem Prover
Open the Command Palette (`Ctrl+Shift+P`) or Right-click and select **"SUO-KIF: Run Prover on..."**.
*   **Scope:** Select **Selection**, **Current File**, or **Entire Workspace**.
*   **Result:** The extension converts the content (plus any external KB context) to TPTP, runs the prover, and reports if the logical theory is **Satisfiable** (Consistent), **Unsatisfiable** (Contradiction), or if a **Theorem** was proved.

### 3. External Knowledge Base Integration
When working on extensions to SUMO, you usually want to verify your files *in the context of SUMO*.
1.  Download the SUMO .kif files (e.g., from the [SUMO repo](https://github.com/ontologyportal/sumo)).
2.  When running Prover/TPTP commands, select **"Integrate with External KB"**.
3.  Select the folder containing the SUMO .kif files. The extension will remember this path (`suo-kif.externalKBPath`).

## Configuration Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `suo-kif.proverPath` | (empty) | Path to Vampire or E-Prover executable (Required for proving). |
| `suo-kif.proverType` | `vampire` | `vampire` or `eprover`. |
| `suo-kif.proverTimeout` | `30` | Timeout in seconds. |
| `suo-kif.useDocker` | `false` | Enable Docker mode for SigmaKEE. |
| `suo-kif.dockerImage` | `adampease/sigmakee` | Docker image to use. |
| `suo-kif.sigmaPath` | (empty) | Path to local SigmaKEE installation (if not using Docker). |
| `suo-kif.externalKBPath`| (empty) | Path to external ontology files (e.g. SUMO) for integration. |
| `suo-kif.useNativeJS` | `false` | **Experimental:** Use legacy JS converter (not recommended). |
| `suo-kif.formatIndentSize`| `2` | Indentation size for formatting. |

## Requirements

*   **VSCode** 1.70+
*   **Java 21+** (If using Local Sigma mode)
*   **Docker** (If using Docker mode)
*   **Theorem Prover** (Vampire or E-Prover) for proof capabilities.

## Resources

- [SUMO (Suggested Upper Merged Ontology)](https://www.ontologyportal.org/)
- [Sigma Knowledge Engineering Environment](https://github.com/ontologyportal/sigmakee)
- [SUO-KIF Specification](suo-kif.pdf)

## Credits

This extension is inspired by the [SUMOjEdit](https://github.com/ontologyportal/SUMOjEdit) plugin for jEdit and utilizes code from the [SigmaKEE](https://github.com/ontologyportal/sigmakee) project.