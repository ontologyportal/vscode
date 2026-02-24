const vscode = require('vscode');
const { ask, tell, getKB } = require('./sigma');
const { tokenize, parse, validateNode, validateVariables, collectMetadata } = require('./validation');

/**
 * A basic Pseudoterminal implementation for SUMO Ask/Tell interaction
 */
class SumoReplTerminal {
    constructor() {
        this.writeEmitter = new vscode.EventEmitter();
        this.onDidWrite = this.writeEmitter.event;
        this.lineBuffer = '';
        this.history = [];
        this.historyIndex = -1;
        this.currentKB = null;
    }

    open(initialDimensions) {
        this.currentKB = getKB();
        this.writeEmitter.fire('Welcome to the SUMO REPL\r\n');
        if (this.currentKB) {
            this.writeEmitter.fire(`Connected to KB: ${this.currentKB}\r\n`);
        } else {
            this.writeEmitter.fire('Warning: No Knowledge Base currently selected. Some commands may fail.\r\n');
        }
        this.writeEmitter.fire('\r\nUsage:\r\n');
        this.writeEmitter.fire('  ask <formula>  - Query the KB\r\n');
        this.writeEmitter.fire('  tell <formula> - Assert a statement to the KB\r\n');
        this.writeEmitter.fire('  help           - Show this help\r\n');
        this.writeEmitter.fire('  clear          - Clear the terminal\r\n\r\n');
        this.prompt();
    }

    close() {}

    prompt() {
        const kbPrefix = this.currentKB ? `(${this.currentKB}) ` : '';
        this.writeEmitter.fire(`\r\n${kbPrefix}> `);
    }

    handleInput(data) {
        for (let i = 0; i < data.length; i++) {
            const char = data[i];
            if (char === '\r') { // Enter
                this.writeEmitter.fire('\r\n');
                this.executeLine();
                this.lineBuffer = '';
                this.historyIndex = -1;
            } else if (char === '\x7f') { // Backspace
                if (this.lineBuffer.length > 0) {
                    this.lineBuffer = this.lineBuffer.slice(0, -1);
                    this.writeEmitter.fire('\b \b');
                }
            } else if (char === '\x1b') { // Escape sequences (arrows)
                const nextTwo = data.slice(i + 1, i + 3);
                if (nextTwo === '[A') { // Up
                    this.navigateHistory(1);
                    i += 2;
                } else if (nextTwo === '[B') { // Down
                    this.navigateHistory(-1);
                    i += 2;
                }
            } else {
                this.lineBuffer += char;
                this.writeEmitter.fire(char);
            }
        }
    }

    navigateHistory(direction) {
        if (this.history.length === 0) return;

        if (direction > 0) { // Up
            if (this.historyIndex < this.history.length - 1) {
                this.historyIndex++;
                this.updateLineFromHistory();
            }
        } else { // Down
            if (this.historyIndex > 0) {
                this.historyIndex--;
                this.updateLineFromHistory();
            } else if (this.historyIndex === 0) {
                this.historyIndex = -1;
                this.clearCurrentLine();
                this.lineBuffer = '';
            }
        }
    }

    updateLineFromHistory() {
        this.clearCurrentLine();
        this.lineBuffer = this.history[this.history.length - 1 - this.historyIndex];
        this.writeEmitter.fire(this.lineBuffer);
    }

    clearCurrentLine() {
        const backspaces = '\b \b'.repeat(this.lineBuffer.length);
        this.writeEmitter.fire(backspaces);
    }

    async executeLine() {
        const line = this.lineBuffer.trim();
        if (!line) {
            this.prompt();
            return;
        }

        this.history.push(line);
        this.currentKB = getKB();

        const firstWord = line.split(' ')[0].toLowerCase();
        const rest = line.substring(firstWord.length).trim();

        try {
            if (firstWord === 'help') {
                this.showHelp();
            } else if (firstWord === 'clear') {
                this.writeEmitter.fire('\x1bc'); // Clear terminal screen
            } else if (firstWord === 'ask') {
                await this.handleAsk(rest);
            } else if (firstWord === 'tell') {
                await this.handleTell(rest);
            } else if (line.startsWith('(')) {
                // Default to ask for formulas starting with '('
                await this.handleAsk(line);
            } else {
                this.writeEmitter.fire(`Unknown command: ${firstWord}. Type 'help' for usage.\r\n`);
            }
        } catch (e) {
            this.writeEmitter.fire(`\r\nError: ${e.message}\r\n`);
        }

        this.prompt();
    }

    showHelp() {
        this.writeEmitter.fire('Available commands:\r\n');
        this.writeEmitter.fire('  ask <formula>  - Query the KB\r\n');
        this.writeEmitter.fire('  tell <formula> - Assert a statement to the KB\r\n');
        this.writeEmitter.fire('  clear          - Clear terminal\r\n');
        this.writeEmitter.fire('  help           - Show this message\r\n');
    }

    async handleAsk(query) {
        if (!this.currentKB) throw new Error('No active Knowledge Base. Please open a KB first.');
        if (!query) throw new Error('No query provided.');

        const validationErrors = this.validateFormula(query);
        if (validationErrors.length > 0) {
            this.writeEmitter.fire('\x1b[33mValidation Warnings/Errors:\r\n');
            validationErrors.forEach(err => this.writeEmitter.fire(`  - ${err}\r\n`));
            this.writeEmitter.fire('\x1b[0m');
        }

        this.writeEmitter.fire(`Querying ${this.currentKB}...\r\n`);
        
        const result = await ask(this.currentKB, query);
        
        this.writeEmitter.fire(`Status: ${result.status}\r\n`);
        
        if (result.answers && result.answers.length > 0) {
            this.writeEmitter.fire('Answers:\r\n');
            result.answers.forEach((ans, i) => {
                this.writeEmitter.fire(`  ${i + 1}. ${ans}\r\n`);
            });
        } else if (result.status && (result.status.includes('Theorem') || result.status.includes('Satisfiable'))) {
            this.writeEmitter.fire(`Result: ${result.status}\r\n`);
        } else {
            this.writeEmitter.fire('No answers found.\r\n');
        }

        if (result.proof && result.proof.length > 0) {
            this.writeEmitter.fire(`Proof found with ${result.proof.length} steps.\r\n`);
        }
    }

    async handleTell(statement) {
        if (!this.currentKB) throw new Error('No active Knowledge Base. Please open a KB first.');
        if (!statement) throw new Error('No statement provided.');

        const validationErrors = this.validateFormula(statement);
        if (validationErrors.length > 0) {
            this.writeEmitter.fire('\x1b[31mCannot assert invalid formula:\r\n');
            validationErrors.forEach(err => this.writeEmitter.fire(`  - ${err}\r\n`));
            this.writeEmitter.fire('\x1b[0m');
            return;
        }

        this.writeEmitter.fire(`Asserting to ${this.currentKB}...\r\n`);
        const result = await tell(this.currentKB, statement);
        
        if (result && result.length > 0) {
            this.writeEmitter.fire('Response:\r\n');
            result.forEach(msg => this.writeEmitter.fire(`  ${msg}\r\n`));
        } else {
            this.writeEmitter.fire('Statement asserted successfully.\r\n');
        }
    }

    /**
     * Use validation logic from validation.js to check a formula string
     * @param {string} formula 
     * @returns {string[]} List of error messages
     */
    validateFormula(formula) {
        const diagnostics = [];
        try {
            const tokens = tokenize({text: formula}, diagnostics);
            // Mock document for parse()
            const mockDoc = {
                getText: () => formula,
                positionAt: (offset) => {
                    const lines = formula.substring(0, offset).split('\n');
                    return { line: lines.length - 1, character: lines[lines.length - 1].length };
                }
            };
            const ast = parse(tokens, diagnostics);
            if (ast.length > 0) {
                const metadata = collectMetadata(ast);
                ast.forEach(node => validateNode(node, diagnostics, metadata, mockDoc));
                validateVariables(ast, diagnostics);
            }
        } catch (e) {
            diagnostics.push({ message: e.message });
        }
        return diagnostics.map(d => d.message);
    }
}

let terminal = null;

function openSumoRepl() {
    if (terminal) {
        terminal.show();
        return;
    }

    const pty = new SumoReplTerminal();
    terminal = vscode.window.createTerminal({
        name: 'SUMO REPL',
        pty: pty
    });
    
    terminal.show();
}

module.exports = { openSumoRepl };
