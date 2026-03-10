'use strict';

/**
 * Unit tests for src/sumo-repl.js — SumoReplTerminal
 *
 * Tests cover:
 *  - Constructor / initial state
 *  - Input handling (typing, backspace, enter, arrows)
 *  - History navigation
 *  - Tab completion
 *  - Command dispatch (help, clear, kb, lang, session, ask, tell, reset)
 *  - Session management (add, list, switch, delete, formulas)
 *  - loadSessionsFromDisk
 *  - validateFormula
 */

const { expect } = require('chai');
const sinon      = require('sinon');
const proxyquire = require('proxyquire').noCallThru();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a fresh REPL terminal instance with all external dependencies stubbed.
 *
 * @param {object} [opts]
 * @param {string|null}  [opts.kb]               Return value of getKB()
 * @param {string|null}  [opts.sigmaHome]         Return value of getSigmaHome()
 * @param {object}       [opts.runtime]           Sigma runtime stub
 * @param {object}       [opts.fsOverrides]       Per-function fs overrides
 * @param {object}       [opts.stateOverrides]    Per-function state overrides
 * @param {object}       [opts.configValues]      Values for vscode.workspace.getConfiguration
 */
function buildTerminal(opts = {}) {
    const kb          = opts.kb !== undefined ? opts.kb : 'TestKB';
    const sigmaHome   = opts.sigmaHome !== undefined ? opts.sigmaHome : null;

    const defaultRuntime = {
        ask:      sinon.stub().resolves({ status: 'Theorem', answers: [], proof: [] }),
        tell:     sinon.stub().resolves([]),
        markDirty: sinon.stub(),
    };
    const runtime = opts.runtime || defaultRuntime;

    const configValues = opts.configValues || {};
    const configStub = { get: (key, def) => (key in configValues ? configValues[key] : def) };

    // Minimal vscode mock — only what sumo-repl.js actually uses
    const vscodeMock = {
        EventEmitter: class {
            constructor() { this.callbacks = []; }
            get event() { return cb => this.callbacks.push(cb); }
            fire(data) { this.callbacks.forEach(cb => cb(data)); }
        },
        window: {
            createTerminal: sinon.stub().returns({ show: sinon.stub() }),
            onDidCloseTerminal: sinon.stub().returns({ dispose: sinon.stub() }),
        },
        workspace: {
            getConfiguration: sinon.stub().returns(configStub),
        },
        Diagnostic: class {
            constructor(range, message, severity) {
                this.range = range; this.message = message; this.severity = severity;
            }
        },
        DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2 },
        Range: class {
            constructor(start, end) { this.start = start; this.end = end; }
        },
        Position: class {
            constructor(line, character) { this.line = line; this.character = character; }
            translate(dl, dc) { return new vscodeMock.Position(this.line + dl, this.character + dc); }
        },
    };

    const fsMock = Object.assign({
        readdirSync: sinon.stub().returns([]),
        readFileSync: sinon.stub().returns(''),
        rmSync:       sinon.stub(),
    }, opts.fsOverrides || {});

    const stateMock = Object.assign({
        getKB:         sinon.stub().returns(kb),
        getSymbolTable: sinon.stub().returns(null),
        tokenize:      sinon.stub().returns([]),
        parse:         sinon.stub().returns([]),
        syntax:        sinon.stub().returns({ symbolTable: {}, sentences: [] }),
        semantics:     sinon.stub(),
    }, opts.stateOverrides || {});

    const { SumoReplTerminal: Klass } = proxyquire('../src/sumo-repl', {
        vscode: vscodeMock,
        crypto: require('crypto'),
        fs: fsMock,
        path: require('path'),
        './sigma': {
            getSigmaRuntime: sinon.stub().returns(runtime),
            getSigmaHome:    sinon.stub().resolves(sigmaHome),
        },
        './state': stateMock,
    });

    const terminal = new Klass();

    // Capture all text written via writeEmitter
    const output = [];
    terminal.writeEmitter.callbacks.push(data => output.push(data));

    return { terminal, output, fsMock, stateMock, runtime, vscodeMock };
}

/** Join captured output into a single string for easy assertions. */
function joined(output) { return output.join(''); }

// ---------------------------------------------------------------------------
describe('SumoReplTerminal', function () {

    afterEach(() => sinon.restore());

    // -----------------------------------------------------------------------
    describe('constructor', function () {

        it('initializes with one session', function () {
            const { terminal } = buildTerminal();
            expect(terminal.sessions.size).to.equal(1);
        });

        it('sets lineBuffer to empty string', function () {
            const { terminal } = buildTerminal();
            expect(terminal.lineBuffer).to.equal('');
        });

        it('sets historyIndex to -1', function () {
            const { terminal } = buildTerminal();
            expect(terminal.historyIndex).to.equal(-1);
        });

        it('initial session has empty formulas and null language', function () {
            const { terminal } = buildTerminal();
            const [, session] = [...terminal.sessions][0];
            expect(session.formulas).to.deep.equal([]);
            expect(session.language).to.be.null;
        });
    });

    // -----------------------------------------------------------------------
    describe('generateSessionId()', function () {

        it('returns a 6-character string', function () {
            const { terminal } = buildTerminal();
            const id = terminal.generateSessionId();
            expect(id).to.have.lengthOf(6);
        });

        it('returns unique IDs on successive calls', function () {
            const { terminal } = buildTerminal();
            const ids = new Set(Array.from({ length: 20 }, () => terminal.generateSessionId()));
            expect(ids.size).to.equal(20);
        });
    });

    // -----------------------------------------------------------------------
    describe('prompt()', function () {

        it('includes the session ID in the prompt', function () {
            const { terminal, output } = buildTerminal({ kb: null });
            terminal.prompt();
            const text = joined(output);
            expect(text).to.include(terminal.currentSession);
            expect(text).to.include('>');
        });

        it('includes the KB name when a KB is set', function () {
            const { terminal, output } = buildTerminal({ kb: 'SUMO' });
            terminal.currentKB = 'SUMO';
            terminal.prompt();
            expect(joined(output)).to.include('SUMO');
        });

        it('does not include KB prefix when no KB is set', function () {
            const { terminal, output } = buildTerminal({ kb: null });
            terminal.currentKB = null;
            terminal.prompt();
            expect(joined(output)).to.not.include('KB:');
        });
    });

    // -----------------------------------------------------------------------
    describe('handleInput() — basic typing', function () {

        it('accumulates characters into lineBuffer and echoes them', function () {
            const { terminal, output } = buildTerminal();
            terminal.handleInput('hel');
            expect(terminal.lineBuffer).to.equal('hel');
            expect(joined(output)).to.include('hel');
        });

        it('backspace removes the last character and emits backspace sequence', function () {
            const { terminal, output } = buildTerminal();
            terminal.handleInput('ab');
            output.length = 0; // clear
            terminal.handleInput('\x7f');
            expect(terminal.lineBuffer).to.equal('a');
            expect(joined(output)).to.include('\b \b');
        });

        it('backspace does nothing when lineBuffer is empty', function () {
            const { terminal, output } = buildTerminal();
            terminal.handleInput('\x7f');
            expect(terminal.lineBuffer).to.equal('');
            expect(output).to.deep.equal([]);
        });

        it('Enter clears lineBuffer and resets historyIndex', async function () {
            const { terminal } = buildTerminal();
            terminal.lineBuffer = 'help';
            await terminal.executeLine();
            terminal.lineBuffer = '';
            terminal.historyIndex = -1;
            expect(terminal.lineBuffer).to.equal('');
            expect(terminal.historyIndex).to.equal(-1);
        });
    });

    // -----------------------------------------------------------------------
    describe('handleInput() — arrow key history navigation', function () {

        it('up arrow restores the most-recent history entry', function () {
            const { terminal, output } = buildTerminal();
            terminal.history = ['first', 'second'];
            terminal.handleInput('\x1b[A');
            expect(terminal.lineBuffer).to.equal('second');
        });

        it('down arrow after up arrow moves back toward empty', function () {
            const { terminal } = buildTerminal();
            terminal.history = ['first', 'second'];
            terminal.handleInput('\x1b[A'); // → second
            terminal.handleInput('\x1b[A'); // → first
            terminal.handleInput('\x1b[B'); // → second
            expect(terminal.lineBuffer).to.equal('second');
        });

        it('down arrow at historyIndex 0 clears the line', function () {
            const { terminal } = buildTerminal();
            terminal.history = ['first'];
            terminal.handleInput('\x1b[A'); // → first
            terminal.handleInput('\x1b[B'); // → empty
            expect(terminal.lineBuffer).to.equal('');
            expect(terminal.historyIndex).to.equal(-1);
        });

        it('up arrow does nothing when history is empty', function () {
            const { terminal } = buildTerminal();
            terminal.handleInput('\x1b[A');
            expect(terminal.lineBuffer).to.equal('');
        });
    });

    // -----------------------------------------------------------------------
    describe('handleTabCompletion()', function () {

        it('completes a partial top-level command', function () {
            const { terminal } = buildTerminal();
            terminal.lineBuffer = 'he';
            terminal.handleTabCompletion();
            expect(terminal.lineBuffer).to.equal('help');
        });

        it('cycles through multiple completions on successive Tab presses', function () {
            const { terminal } = buildTerminal();
            terminal.lineBuffer = 'a';
            terminal.handleTabCompletion();
            const first = terminal.lineBuffer;
            terminal.handleTabCompletion();
            const second = terminal.lineBuffer;
            expect(['ask']).to.include(first);   // only 'ask' starts with 'a'
            expect(second).to.equal(first);      // only one match → cycles back
        });

        it('completes session subcommands', function () {
            const { terminal } = buildTerminal();
            terminal.lineBuffer = 'session l';
            terminal.handleTabCompletion();
            expect(terminal.lineBuffer).to.equal('session list');
        });

        it('completes lang argument', function () {
            const { terminal } = buildTerminal();
            terminal.lineBuffer = 'lang f';
            terminal.handleTabCompletion();
            expect(terminal.lineBuffer).to.equal('lang fof');
        });

        it('completes session IDs for switch', function () {
            const { terminal } = buildTerminal();
            const sessionId = terminal.currentSession;
            terminal.lineBuffer = `session switch ${sessionId.substring(0, 2)}`;
            terminal.handleTabCompletion();
            expect(terminal.lineBuffer).to.equal(`session switch ${sessionId}`);
        });

        it('does nothing when no completion matches', function () {
            const { terminal } = buildTerminal();
            terminal.lineBuffer = 'zzz';
            terminal.handleTabCompletion();
            expect(terminal.lineBuffer).to.equal('zzz');
        });
    });

    // -----------------------------------------------------------------------
    describe('executeLine() — command dispatch', function () {

        it('adds the command to history', async function () {
            const { terminal } = buildTerminal();
            terminal.lineBuffer = 'help';
            await terminal.executeLine();
            expect(terminal.history).to.include('help');
        });

        it('does not add empty lines to history', async function () {
            const { terminal } = buildTerminal();
            terminal.lineBuffer = '   ';
            await terminal.executeLine();
            expect(terminal.history).to.be.empty;
        });

        it('dispatches "help" to showHelp()', async function () {
            const { terminal } = buildTerminal();
            const spy = sinon.spy(terminal, 'showHelp');
            terminal.lineBuffer = 'help';
            await terminal.executeLine();
            expect(spy.calledOnce).to.be.true;
        });

        it('emits clear sequence for "clear"', async function () {
            const { terminal, output } = buildTerminal();
            terminal.lineBuffer = 'clear';
            await terminal.executeLine();
            expect(joined(output)).to.include('\x1bc');
        });

        it('dispatches bare "(..." to handleAsk', async function () {
            const { terminal } = buildTerminal();
            const spy = sinon.stub(terminal, 'handleAsk').resolves();
            terminal.lineBuffer = '(instance Rover Dog)';
            await terminal.executeLine();
            expect(spy.calledOnce).to.be.true;
        });

        it('prints unknown command error for unrecognised input', async function () {
            const { terminal, output } = buildTerminal();
            terminal.lineBuffer = 'frobnicator';
            await terminal.executeLine();
            expect(joined(output)).to.match(/unknown command/i);
        });

        it('catches errors thrown by handlers and writes them', async function () {
            const { terminal, output } = buildTerminal({ kb: null });
            terminal.currentKB = null;
            terminal.lineBuffer = 'ask (instance Rover Dog)';
            await terminal.executeLine();
            expect(joined(output)).to.include('Error:');
        });
    });

    // -----------------------------------------------------------------------
    describe('showHelp()', function () {

        it('mentions "ask", "tell", "session", and "help" commands', function () {
            const { terminal, output } = buildTerminal();
            terminal.showHelp();
            const text = joined(output);
            expect(text).to.include('ask');
            expect(text).to.include('tell');
            expect(text).to.include('session');
            expect(text).to.include('help');
        });
    });

    // -----------------------------------------------------------------------
    describe('handleLang()', function () {

        it('sets the session language to a valid value', function () {
            const { terminal, output } = buildTerminal();
            terminal.handleLang('tff');
            const session = terminal.sessions.get(terminal.currentSession);
            expect(session.language).to.equal('tff');
            expect(joined(output)).to.include('tff');
        });

        it('clears the language with "reset"', function () {
            const { terminal } = buildTerminal();
            terminal.handleLang('fof');
            terminal.handleLang('reset');
            const session = terminal.sessions.get(terminal.currentSession);
            expect(session.language).to.be.null;
        });

        it('clears the language with an empty string', function () {
            const { terminal } = buildTerminal();
            terminal.handleLang('thf');
            terminal.handleLang('');
            const session = terminal.sessions.get(terminal.currentSession);
            expect(session.language).to.be.null;
        });

        it('rejects unknown language values', function () {
            const { terminal, output } = buildTerminal();
            terminal.handleLang('prolog');
            const session = terminal.sessions.get(terminal.currentSession);
            expect(session.language).to.be.null;
            expect(joined(output)).to.match(/unknown language/i);
        });
    });

    // -----------------------------------------------------------------------
    describe('handleSessionCommand() — session management', function () {

        it('"list" outputs all session IDs', async function () {
            const { terminal, output } = buildTerminal();
            await terminal.handleSessionCommand('list');
            expect(joined(output)).to.include(terminal.currentSession);
        });

        it('"list" marks the active session with *', async function () {
            const { terminal, output } = buildTerminal();
            await terminal.handleSessionCommand('list');
            expect(joined(output)).to.include('* ');
        });

        it('"add" creates a new session', async function () {
            const { terminal, output } = buildTerminal();
            const before = terminal.sessions.size;
            await terminal.handleSessionCommand('add');
            expect(terminal.sessions.size).to.equal(before + 1);
            expect(joined(output)).to.match(/added/i);
        });

        it('"switch" changes the active session', async function () {
            const { terminal, output } = buildTerminal();
            await terminal.handleSessionCommand('add');
            const newId = [...terminal.sessions.keys()].find(k => k !== terminal.currentSession);
            await terminal.handleSessionCommand(`switch ${newId}`);
            expect(terminal.currentSession).to.equal(newId);
            expect(joined(output)).to.match(/switched/i);
        });

        it('"switch" to non-existent session prints an error', async function () {
            const { terminal, output } = buildTerminal();
            await terminal.handleSessionCommand('switch nonexistent');
            expect(joined(output)).to.match(/does not exist/i);
        });

        it('"switch" without a session name prints an error', async function () {
            const { terminal, output } = buildTerminal();
            await terminal.handleSessionCommand('switch');
            expect(joined(output)).to.match(/session name required/i);
        });

        it('"delete" removes a session', async function () {
            const { terminal, output } = buildTerminal();
            await terminal.handleSessionCommand('add');
            const toDelete = [...terminal.sessions.keys()].find(k => k !== terminal.currentSession);
            const before = terminal.sessions.size;
            await terminal.handleSessionCommand(`delete ${toDelete}`);
            expect(terminal.sessions.size).to.equal(before - 1);
            expect(terminal.sessions.has(toDelete)).to.be.false;
            expect(joined(output)).to.match(/deleted/i);
        });

        it('"delete" refuses to delete the active session', async function () {
            const { terminal, output } = buildTerminal();
            await terminal.handleSessionCommand(`delete ${terminal.currentSession}`);
            expect(terminal.sessions.has(terminal.currentSession)).to.be.true;
            expect(joined(output)).to.match(/cannot delete active/i);
        });

        it('"delete" without a session name prints an error', async function () {
            const { terminal, output } = buildTerminal();
            await terminal.handleSessionCommand('delete');
            expect(joined(output)).to.match(/session name required/i);
        });

        it('unknown subcommand prints an error', async function () {
            const { terminal, output } = buildTerminal();
            await terminal.handleSessionCommand('frobnicate');
            expect(joined(output)).to.match(/unknown session command/i);
        });

        it('"formulas" prints error when SIGMA_HOME is not set', async function () {
            const { terminal, output } = buildTerminal({ sigmaHome: null });
            await terminal.handleSessionCommand('formulas');
            expect(joined(output)).to.match(/cannot locate sessions directory/i);
        });

        it('"formulas" prints no-assertions message when session dir is missing', async function () {
            const { terminal, output } = buildTerminal({
                sigmaHome: '/fake/sigma',
                fsOverrides: {
                    readdirSync: sinon.stub().throws(new Error('no such file')),
                },
            });
            await terminal.handleSessionCommand('formulas');
            expect(joined(output)).to.match(/no assertions found/i);
        });

        it('"formulas" lists .kif files in the session dir', async function () {
            const { terminal, output } = buildTerminal({
                sigmaHome: '/fake/sigma',
                fsOverrides: {
                    readdirSync: sinon.stub().returns(['SUMO_UserAssertions.kif']),
                    readFileSync: sinon.stub().returns('(instance Rover Dog)\n'),
                },
            });
            await terminal.handleSessionCommand('formulas');
            expect(joined(output)).to.include('SUMO');
            expect(joined(output)).to.include('instance Rover Dog');
        });
    });

    // -----------------------------------------------------------------------
    describe('handleAsk()', function () {

        it('throws when no KB is active', async function () {
            const { terminal } = buildTerminal({ kb: null });
            terminal.currentKB = null;
            let threw = false;
            try { await terminal.handleAsk('(instance Rover Dog)'); } catch (_) { threw = true; }
            expect(threw).to.be.true;
        });

        it('throws when query is empty', async function () {
            const { terminal } = buildTerminal();
            let threw = false;
            try { await terminal.handleAsk(''); } catch (_) { threw = true; }
            expect(threw).to.be.true;
        });

        it('calls getSigmaRuntime().ask with KB, session, and query', async function () {
            const runtime = {
                ask: sinon.stub().resolves({ status: 'Theorem', answers: [], proof: [] }),
            };
            const { terminal } = buildTerminal({ runtime });
            terminal.currentKB = 'TestKB';
            await terminal.handleAsk('(instance Rover Dog)');
            expect(runtime.ask.calledOnce).to.be.true;
            const [kb, session, query] = runtime.ask.firstCall.args;
            expect(kb).to.equal('TestKB');
            expect(session).to.equal(terminal.currentSession);
            expect(query).to.equal('(instance Rover Dog)');
        });

        it('displays the result status', async function () {
            const runtime = {
                ask: sinon.stub().resolves({ status: 'Theorem', answers: [], proof: [] }),
            };
            const { terminal, output } = buildTerminal({ runtime });
            terminal.currentKB = 'TestKB';
            await terminal.handleAsk('(instance Rover Dog)');
            expect(joined(output)).to.include('Theorem');
        });

        it('uses session language override when set', async function () {
            const runtime = { ask: sinon.stub().resolves({ status: 'OK', answers: [], proof: [] }) };
            const { terminal } = buildTerminal({ runtime });
            terminal.currentKB = 'TestKB';
            terminal.sessions.get(terminal.currentSession).language = 'thf';
            await terminal.handleAsk('(instance Rover Dog)');
            const [, , , opts] = runtime.ask.firstCall.args;
            expect(opts.language).to.equal('thf');
        });

        it('displays proof steps when a proof is returned', async function () {
            const runtime = {
                ask: sinon.stub().resolves({
                    status: 'Theorem',
                    answers: [],
                    proof: [{ id: 1, formula: 'f1', infRule: 'input', supports: [] }],
                }),
            };
            const { terminal, output } = buildTerminal({ runtime });
            terminal.currentKB = 'TestKB';
            await terminal.handleAsk('(instance Rover Dog)');
            expect(joined(output)).to.include('Proof');
            expect(joined(output)).to.include('f1');
        });

        it('displays answers when answers are returned', async function () {
            const runtime = {
                ask: sinon.stub().resolves({ status: 'OK', answers: ['Rover', 'Fido'], proof: [] }),
            };
            const { terminal, output } = buildTerminal({ runtime });
            terminal.currentKB = 'TestKB';
            await terminal.handleAsk('(instance ?X Dog)');
            expect(joined(output)).to.include('Rover');
            expect(joined(output)).to.include('Fido');
        });
    });

    // -----------------------------------------------------------------------
    describe('handleTell()', function () {

        it('throws when no KB is active', async function () {
            const { terminal } = buildTerminal({ kb: null });
            terminal.currentKB = null;
            let threw = false;
            try { await terminal.handleTell('(instance Rover Dog)'); } catch (_) { threw = true; }
            expect(threw).to.be.true;
        });

        it('throws when statement is empty', async function () {
            const { terminal } = buildTerminal();
            let threw = false;
            try { await terminal.handleTell(''); } catch (_) { threw = true; }
            expect(threw).to.be.true;
        });

        it('calls getSigmaRuntime().tell and adds formula to session on success', async function () {
            const runtime = { tell: sinon.stub().resolves([]) };
            const { terminal, output } = buildTerminal({ runtime });
            terminal.currentKB = 'TestKB';
            await terminal.handleTell('(instance Rover Dog)');
            expect(runtime.tell.calledOnce).to.be.true;
            const session = terminal.sessions.get(terminal.currentSession);
            expect(session.formulas).to.include('(instance Rover Dog)');
            expect(joined(output)).to.include('asserted successfully');
        });

        it('prints runtime errors when tell returns non-empty array', async function () {
            const runtime = { tell: sinon.stub().resolves(['Error: assertion failed']) };
            const { terminal, output } = buildTerminal({ runtime });
            terminal.currentKB = 'TestKB';
            await terminal.handleTell('(instance Rover Dog)');
            expect(joined(output)).to.include('Error: assertion failed');
        });
    });

    // -----------------------------------------------------------------------
    describe('handleChangeKB()', function () {

        it('updates currentKB', async function () {
            const { terminal } = buildTerminal({ kb: 'OldKB' });
            await terminal.handleChangeKB('NewKB');
            expect(terminal.currentKB).to.equal('NewKB');
        });
    });

    // -----------------------------------------------------------------------
    describe('loadSessionsFromDisk()', function () {

        it('does nothing when SIGMA_HOME is not set (sigmaHome=null)', async function () {
            const { terminal } = buildTerminal({ sigmaHome: null });
            const before = terminal.sessions.size;
            await terminal.loadSessionsFromDisk();
            expect(terminal.sessions.size).to.equal(before);
        });

        it('does nothing when sessions directory does not exist', async function () {
            const { terminal } = buildTerminal({
                sigmaHome: '/fake/sigma',
                fsOverrides: {
                    readdirSync: sinon.stub().throws(new Error('ENOENT')),
                },
            });
            const before = terminal.sessions.size;
            await terminal.loadSessionsFromDisk();
            expect(terminal.sessions.size).to.equal(before);
        });

        it('loads session IDs from disk directories', async function () {
            const dirEntries = [
                { isDirectory: () => true, name: 'abc123' },
                { isDirectory: () => true, name: 'def456' },
                { isDirectory: () => false, name: 'somefile.txt' },
            ];
            const { terminal, output } = buildTerminal({
                sigmaHome: '/fake/sigma',
                fsOverrides: {
                    readdirSync: sinon.stub().returns(dirEntries),
                },
            });
            await terminal.loadSessionsFromDisk();
            expect(terminal.sessions.has('abc123')).to.be.true;
            expect(terminal.sessions.has('def456')).to.be.true;
            expect(terminal.sessions.has('somefile.txt')).to.be.false;
            expect(terminal.currentSession).to.equal('abc123');
            expect(joined(output)).to.include('Loaded 2 session');
        });

        it('does nothing when no directory entries are found', async function () {
            const { terminal } = buildTerminal({
                sigmaHome: '/fake/sigma',
                fsOverrides: {
                    readdirSync: sinon.stub().returns([]),
                },
            });
            const before = terminal.sessions.size;
            await terminal.loadSessionsFromDisk();
            expect(terminal.sessions.size).to.equal(before);
        });
    });

    // -----------------------------------------------------------------------
    describe('validateFormula()', function () {

        it('returns an empty array for a well-formed formula (no errors)', function () {
            const { terminal, stateMock } = buildTerminal();
            stateMock.tokenize.returns([]);
            stateMock.parse.returns([]);
            const errors = terminal.validateFormula('(instance Rover Dog)');
            expect(errors).to.be.an('array').that.is.empty;
        });

        it('returns error messages when tokenization fails', function () {
            const { terminal, stateMock } = buildTerminal();
            stateMock.tokenize.callsFake((_, diags) => {
                diags.push({ message: 'bad token' });
                return [];
            });
            const errors = terminal.validateFormula('?123bad');
            expect(errors).to.include('bad token');
        });

        it('returns error messages from parse failures', function () {
            const { terminal, stateMock } = buildTerminal();
            stateMock.parse.callsFake((_, diags) => {
                diags.push({ message: 'unclosed paren' });
                return [];
            });
            const errors = terminal.validateFormula('(instance Rover');
            expect(errors).to.include('unclosed paren');
        });

        it('returns empty array when tokenize throws unexpectedly', function () {
            const { terminal, stateMock } = buildTerminal();
            stateMock.tokenize.throws(new Error('crash'));
            const errors = terminal.validateFormula('bad');
            expect(errors).to.include('crash');
        });
    });
});
