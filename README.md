# SUO-KIF VSCode Language Support

This is an extension for VSCode to provide language support for SUO-KIF. Note, for a formal specification of SUO-KIF, see ["Standard Upper Ontology - Knowledge Interchange Format" (Pease, 2009)](suo-kif.pdf). 

## Installation

Download the VSIX from the Github releases page, then install the extension via VSCode: `Ctrl-Shift-P` > `Install Extension from File`

## Features

### Syntax Highlighting

Highlights syntax according to language specification:
- Logic Operators
- Functions 
- Relations
- String and number literals
- Escaped strings
- Classes
- Instances
- Variables
- Row Variables
- Parenthesis matching

### Symbol Lookup

Right click a symbol and select "Search Symbol in Workspace" to get a listing of all uses of that symbol in your current workspace. Then scroll through them to quickly jump to that location in your knowledge base.

### Type Hinting

When typing out a relation, a hint window appears which shows the `documentation` command and infers the argument types using the `domain` rules for that relation / function. 
