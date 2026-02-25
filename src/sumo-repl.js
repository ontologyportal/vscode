const vscode = require('vscode');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getSigmaRuntime, getSigmaHome } = require('./sigma');
const { getKB } = require('./navigation');
const { tokenize, parse, validateNode, validateVariables, collectMetadata } = require('./validation');

/**
 * A basic Pseudoterminal implementation for SUMO Ask/Tell interaction
 */
class SumoReplTerminal {
    constructor() {
        this.writeEmitter = new vscode.EventEmitter();
        this.onDidWrite = this.writeEmitter.event;
        this.closeEmitter = new vscode.EventEmitter();
        this.onDidClose = this.closeEmitter.event;
        this.lineBuffer = '';
        this.history = [];
        this.historyIndex = -1;
        this.currentKB = null;
        // sessions: Map<id, { formulas: string[], language: string|null }>
        // language is null when no per-session override is set (falls back to VS Code setting)
        this.sessions = new Map();
        const initialSession = this.generateSessionId();
        this.sessions.set(initialSession, { formulas: [], language: null });
        this.currentSession = initialSession;
        this.completionState = null;
    }

    open(initialDimensions) {
        this.currentKB = getKB();
        this.writeEmitter.fire('Welcome to the SUMO REPL\r\n');
        if (this.currentKB) {
            this.writeEmitter.fire(`Connected to KB: ${this.currentKB}\r\n`);
        } else {
            this.writeEmitter.fire('Warning: No Knowledge Base currently selected. Some commands may fail.\r\n');
        }
        this.showHelp();
        // Load persisted sessions from disk before showing the prompt
        this.loadSessionsFromDisk()
            .catch(() => {})
            .then(() => this.prompt());
    }

    /**
     * Returns the path to $SIGMA_HOME/KBs/sessions, or null if SIGMA_HOME is not set.
     * @returns {Promise<string|null>}
     */
    async _getSessionsDir() {
        const sigmaHome = await getSigmaHome();
        if (!sigmaHome) return null;
        return path.join(sigmaHome, 'KBs', 'sessions');
    }

    /**
     * Populate this.sessions from subdirectories of $SIGMA_HOME/KBs/sessions.
     * If the directory does not exist yet (no assertions ever made) the
     * initial in-memory session is kept so the user always has one to work with.
     */
    async loadSessionsFromDisk() {
        const sessionsDir = await this._getSessionsDir();
        if (!sessionsDir) return;

        let entries;
        try {
            entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
        } catch (_) {
            return; // directory doesn't exist yet
        }

        const ids = entries
            .filter(e => e.isDirectory())
            .map(e => e.name)
            .sort();

        if (ids.length === 0) return;

        this.sessions = new Map();
        for (const id of ids) {
            this.sessions.set(id, { formulas: [], language: null });
        }
        this.currentSession = ids[0];
        this.writeEmitter.fire(`Loaded ${ids.length} session${ids.length !== 1 ? 's' : ''} from disk.\r\n`);
    }

    generateSessionId() {
        return crypto.randomUUID().substring(0, 6);
    }

    close() {
        this.closeEmitter.fire();
    }

    prompt() {
        const kbPrefix = this.currentKB ? `(KB: ${this.currentKB}) ` : '';
        const sessionPrefix = `[Session: ${this.currentSession}] `;
        this.writeEmitter.fire(`\r\n${kbPrefix}${sessionPrefix}> `);
    }

    async handleChangeKB(kb) {
        this.currentKB = kb;
    }

    handleInput(data) {
        for (let i = 0; i < data.length; i++) {
            const char = data[i];
            
            if (char === '\t') { // Tab
                this.handleTabCompletion();
                continue;
            }
            
            this.completionState = null;

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

    handleTabCompletion() {
        if (this.completionState) {
            const { prefix, matches, index } = this.completionState;
            const nextIndex = (index + 1) % matches.length;
            this.completionState.index = nextIndex;
            
            this.clearCurrentLine();
            this.lineBuffer = prefix + matches[nextIndex];
            this.writeEmitter.fire(this.lineBuffer);
            return;
        }

        const line = this.lineBuffer;
        const parts = line.split(/\s+/);
        const endsWithSpace = /\s$/.test(line);
        
        let matches = [];
        let prefix = '';

        // Case 1: Top-level commands
        if (parts.length === 1 && !endsWithSpace) {
            const partial = parts[0];
            const commands = ['ask', 'tell', 'kb', 'lang', 'session', 'reset', 'clear', 'help'];
            matches = commands.filter(c => c.startsWith(partial));
            prefix = '';
        }
        // Case 2: lang argument (fof/tff/thf)
        else if (parts.length === 2 && parts[0] === 'lang' && !endsWithSpace) {
            const partial = parts[1];
            matches = ['fof', 'tff', 'thf'].filter(l => l.startsWith(partial));
            prefix = 'lang ';
        }
        // Case 3: Session subcommands
        else if (parts.length === 2 && parts[0] === 'session' && !endsWithSpace) {
            const partial = parts[1];
            const subcmds = ['add', 'list', 'switch', 'delete', 'formulas'];
            matches = subcmds.filter(s => s.startsWith(partial));
            prefix = 'session ';
        }
        // Case 4: Session arguments (switch/delete/formulas)
        else if (parts.length >= 2 && parts[0] === 'session' && (parts[1] === 'switch' || parts[1] === 'delete' || parts[1] === 'formulas')) {
             if (parts.length === 3) {
                 const partial = parts[2];
                 matches = Array.from(this.sessions.keys()).filter(s => s.startsWith(partial));
                 prefix = `${parts[0]} ${parts[1]} `;
             }
        }

        if (matches.length > 0) {
            this.completionState = {
                prefix,
                matches,
                index: 0
            };
            
            this.clearCurrentLine();
            this.lineBuffer = prefix + matches[0];
            this.writeEmitter.fire(this.lineBuffer);
        }
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
            } else if (firstWord === 'kb') {
                await this.handleChangeKB(rest);
            } else if (firstWord === 'lang') {
                this.handleLang(rest);
            } else if (firstWord === 'session') {
                await this.handleSessionCommand(rest);
            } else if (firstWord === 'reset') {
                await this.handleReset();
            } else if (line.startsWith('(')) {
                // Default to ask for formulas starting with '('
                await this.handleAsk(line);
            } else {
                this.writeEmitter.fire(`Unknown command: ${firstWord}. Type 'help' for usage.\r\n`);
            }
        } catch (e) {
            this.writeEmitter.fire(`\r\nError: ${e.message}\r\n`);
            console.error(e);
        }

        this.prompt();
    }

    async handleSessionCommand(args) {
        const parts = args.split(' ').filter(s => s.length > 0);
        const subCmd = parts[0] ? parts[0].toLowerCase() : 'list';
        let sessionName = parts[1];

        if (subCmd === 'list') {
            this.writeEmitter.fire('Sessions:\r\n');
            this.sessions.forEach((data, id) => {
                const marker = id === this.currentSession ? '* ' : '  ';
                const langTag = data.language ? ` [${data.language}]` : '';
                this.writeEmitter.fire(`${marker}${id}${langTag}\r\n`);
            });
        } else if (subCmd === 'formulas') {
            const targetId = sessionName || this.currentSession;
            if (!this.sessions.has(targetId)) {
                this.writeEmitter.fire(`Error: Session '${targetId}' does not exist.\r\n`);
                return;
            }
            const sessionsDir = await this._getSessionsDir();
            if (!sessionsDir) {
                this.writeEmitter.fire('Error: Cannot locate sessions directory (SIGMA_HOME not set).\r\n');
                return;
            }
            const sessionDir = path.join(sessionsDir, targetId);
            let kifFiles;
            try {
                kifFiles = fs.readdirSync(sessionDir).filter(f => f.endsWith('_UserAssertions.kif'));
            } catch (_) {
                this.writeEmitter.fire(`No assertions found for session '${targetId}'.\r\n`);
                return;
            }
            if (kifFiles.length === 0) {
                this.writeEmitter.fire(`No assertions in session '${targetId}'.\r\n`);
                return;
            }
            for (const file of kifFiles) {
                const kbName = file.replace('_UserAssertions.kif', '');
                const content = fs.readFileSync(path.join(sessionDir, file), 'utf8');
                const lines = content.split('\n').filter(l => l.trim());
                this.writeEmitter.fire(`Assertions for ${kbName} (${lines.length}):\r\n`);
                lines.forEach((line, i) => {
                    this.writeEmitter.fire(`  ${i + 1}. ${line}\r\n`);
                });
            }
        } else if (subCmd === 'add') {
            sessionName = this.generateSessionId();
            this.sessions.set(sessionName, { formulas: [], language: null });
            this.writeEmitter.fire(`Session '${sessionName}' added.\r\n`);
        } else if (subCmd === 'switch') {
            if (!sessionName) {
                this.writeEmitter.fire('Error: Session name required.\r\n');
                return;
            }
            if (!this.sessions.has(sessionName)) {
                this.writeEmitter.fire(`Error: Session '${sessionName}' does not exist.\r\n`);
                return;
            }
            this.currentSession = sessionName;
            this.writeEmitter.fire(`Switched to session '${sessionName}'.\r\n`);
        } else if (subCmd === 'delete') {
            if (!sessionName) {
                this.writeEmitter.fire('Error: Session name required.\r\n');
                return;
            }
            if (!this.sessions.has(sessionName)) {
                this.writeEmitter.fire(`Error: Session '${sessionName}' does not exist.\r\n`);
                return;
            }
            if (sessionName === this.currentSession) {
                this.writeEmitter.fire('Error: Cannot delete active session.\r\n');
                return;
            }
            const sessionsDir = await this._getSessionsDir();
            if (sessionsDir) {
                const sessionDir = path.join(sessionsDir, sessionName);
                try {
                    fs.rmSync(sessionDir, { recursive: true, force: true });
                } catch (e) {
                    this.writeEmitter.fire(`Warning: Could not remove session directory: ${e.message}\r\n`);
                }
            }
            this.sessions.delete(sessionName);
            this.writeEmitter.fire(`Session '${sessionName}' deleted.\r\n`);
        } else {
            this.writeEmitter.fire(`Unknown session command: ${subCmd}\r\n`);
        }
    }

    showHelp() {
        this.writeEmitter.fire('Available commands:\r\n');
        this.writeEmitter.fire('  ask <formula>          - Query the KB\r\n');
        this.writeEmitter.fire('  tell <formula>         - Assert a statement to the KB\r\n');
        this.writeEmitter.fire('  kb <name>              - Change the current KB\r\n');
        this.writeEmitter.fire('  lang <fof|tff|thf>     - Override TPTP language for this session\r\n');
        this.writeEmitter.fire('  lang reset             - Clear override (use VS Code setting)\r\n');
        this.writeEmitter.fire('  session add            - Create a new session\r\n');
        this.writeEmitter.fire('  session list           - List sessions with assertion counts\r\n');
        this.writeEmitter.fire('  session switch <id>    - Switch to a session\r\n');
        this.writeEmitter.fire('  session delete <id>    - Delete a session\r\n');
        this.writeEmitter.fire('  session formulas [id]  - List assertions for a session\r\n');
        this.writeEmitter.fire('  clear                  - Clear terminal\r\n');
        this.writeEmitter.fire('  help                   - Show this message\r\n');
    }

    handleLang(arg) {
        const val = arg.trim().toLowerCase();
        const session = this.sessions.get(this.currentSession);
        if (val === 'reset' || val === '') {
            session.language = null;
            this.writeEmitter.fire('Language override cleared. Using VS Code setting.\r\n');
        } else if (val === 'fof' || val === 'tff' || val === 'thf') {
            session.language = val;
            this.writeEmitter.fire(`Language for session '${this.currentSession}' set to ${val}.\r\n`);
        } else {
            this.writeEmitter.fire(`Unknown language '${val}'. Valid options: fof, tff, thf.\r\n`);
        }
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

        const sessionData = this.sessions.get(this.currentSession);
        const language = sessionData.language
            || vscode.workspace.getConfiguration('sumo').get('theoremProver.tptpLang', 'fof');
        this.writeEmitter.fire(`Querying ${this.currentKB} [${language}]...\r\n`);

        const result = await getSigmaRuntime().ask(this.currentKB, this.currentSession, query, { language });

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
            this.writeEmitter.fire(`\r\nProof (${result.proof.length} steps):\r\n`);
            result.proof.forEach(step => {
                const premises = step.supports && step.supports.length > 0
                    ? ` [${step.supports.join(', ')}]`
                    : '';
                this.writeEmitter.fire(`  ${step.id}. ${step.formula}\r\n`);
                if (step.sumo) {
                    this.writeEmitter.fire(`      SUMO: ${step.sumo}\r\n`);
                }
                this.writeEmitter.fire(`      rule: ${step.infRule || 'input'}${premises}\r\n`);
            });
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
        const result = await getSigmaRuntime().tell(this.currentKB, this.currentSession, statement);

        if (result && result.length > 0) {
            this.writeEmitter.fire(`${result}\r\n`);
        } else {
            this.sessions.get(this.currentSession).formulas.push(statement);
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

    const disposable = vscode.window.onDidCloseTerminal(t => {
        if (t === terminal) {
            terminal = null;
            disposable.dispose();
        }
    });

    terminal.show();
}

module.exports = { openSumoRepl };
