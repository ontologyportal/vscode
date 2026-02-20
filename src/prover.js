const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const { getKBFiles } = require('./navigation');
const { findEnclosingSExpression } = require('./formatting');
const { 
    getSigmaRuntime, 
    isWithinConfiguredKB,
    getKBConstituentsFromConfig,
    compileFormulas
} = require('./sigma');
const { 
    parseKIFFormulas, 
    tptpParseSUOKIFString,
    setLanguage
} = require('./sigma/engine/native/index.js');

async function queryProverCommand() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const document = editor.document;
    let range = editor.selection;

    if (range.isEmpty) {
        range = findEnclosingSExpression(document, editor.selection.active);
        if (!range) {
            vscode.window.showWarningMessage('Please select an axiom to query.');
            return;
        }
    }

    const query = document.getText(range);
    const config = vscode.workspace.getConfiguration('sumo');
    const proverPath = config.get('theoremProver.path');
    const proverType = config.get('theoremProver.type') || 'vampire';
    const timeout = config.get('theoremProver.timeout') || 30;

    if (!proverPath) {
        const configure = await vscode.window.showErrorMessage(
            'Theorem prover path not configured. Please set sumo.theoremProver.path in settings.',
            'Open Settings'
        );
        if (configure === 'Open Settings') {
            vscode.commands.executeCommand('workbench.action.openSettings', 'sumo.theoremProver.path');
        }
        return;
    }

    if (!fs.existsSync(proverPath)) {
        vscode.window.showErrorMessage(`Theorem prover not found at: ${proverPath}`);
        return;
    }

    const tptpQuery = convertToTPTP(query);
    const tempDir = os.tmpdir();
    const tempFile = path.join(tempDir, `suokif-query-${Date.now()}.p`);

    const files = await getKBFiles();
    let context = '';

    for (const file of files) {
        if (file.fsPath !== document.uri.fsPath) {
            const doc = await vscode.workspace.openTextDocument(file);
            context += doc.getText() + '\n';
        }
    }

    const fullText = document.getText();
    const queryStart = document.offsetAt(range.start);
    const queryEnd = document.offsetAt(range.end);
    context += fullText.substring(0, queryStart) + fullText.substring(queryEnd);

    const tptpContext = convertKBToTPTP(context);
    const fullTPTP = tptpContext + '\n' + tptpQuery;

    fs.writeFileSync(tempFile, fullTPTP);

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Running theorem prover...',
        cancellable: true
    }, async (progress, token) => {
        return new Promise((resolve, reject) => {
            let cmd;
            if (proverType === 'vampire') {
                cmd = `"${proverPath}" --mode casc -t ${timeout} "${tempFile}"`;
            } else {
                cmd = `"${proverPath}" --auto --cpu-limit=${timeout} "${tempFile}"`;
            }

            const proc = exec(cmd, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
                try { fs.unlinkSync(tempFile); } catch (e) {}

                if (token.isCancellationRequested) {
                    resolve();
                    return;
                }

                const outputChannel = vscode.window.createOutputChannel('SUMO Prover');
                outputChannel.clear();
                outputChannel.appendLine(`Query: ${query}`);
                outputChannel.appendLine('='.repeat(60));
                outputChannel.appendLine('');

                if (error && !stdout) {
                    outputChannel.appendLine('Error running prover:');
                    outputChannel.appendLine(stderr || error.message);
                } else {
                    outputChannel.appendLine('Prover Output:');
                    outputChannel.appendLine(stdout);
                    if (stderr) {
                        outputChannel.appendLine('\nStderr:');
                        outputChannel.appendLine(stderr);
                    }

                    if (stdout.includes('Theorem') || stdout.includes('SZS status Theorem')) {
                        vscode.window.showInformationMessage('Theorem proved!');
                    } else if (stdout.includes('CounterSatisfiable') || stdout.includes('SZS status CounterSatisfiable')) {
                        vscode.window.showWarningMessage('Counter-satisfiable (theorem cannot be proved).');
                    } else if (stdout.includes('Timeout') || stdout.includes('SZS status Timeout')) {
                        vscode.window.showWarningMessage('Prover timed out.');
                    } else if (stdout.includes('Unsatisfiable') || stdout.includes('SZS status Unsatisfiable')) {
                        vscode.window.showInformationMessage('Unsatisfiable (negation is a theorem).');
                    }
                }

                outputChannel.show();
                resolve();
            });

            token.onCancellationRequested(() => {
                proc.kill();
            });
        });
    });
}

async function runProverOnScopeCommand() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    const document = editor.document;
    const config = vscode.workspace.getConfiguration('sumo');
    const proverPath = config.get('theoremProver.path');
    const proverType = config.get('theoremProver.type') || 'vampire';
    const timeout = config.get('theoremProver.timeout') || 30;

    if (!proverPath) {
        const configure = await vscode.window.showErrorMessage(
            'Theorem prover path not configured. Please set sumo.prover.path in settings.',
            'Open Settings'
        );
        if (configure === 'Open Settings') {
            vscode.commands.executeCommand('workbench.action.openSettings', 'sumo.prover.path');
        }
        return;
    }

    if (!fs.existsSync(proverPath)) {
        vscode.window.showErrorMessage(`Theorem prover not found at: ${proverPath}`);
        return;
    }

    const options = [
        { label: 'Selection / Current Line', description: 'Run prover on selected text or current line' },
        { label: 'Current File', description: 'Run prover on the current file' },
        { label: 'Entire Workspace', description: 'Run prover on all .kif files in workspace' }
    ];

    const selected = await vscode.window.showQuickPick(options, {
        placeHolder: 'Select scope for theorem prover'
    });

    if (!selected) return;

    let kifContent = '';
    let sourceName = '';

    if (selected.label === 'Selection / Current Line') {
        if (!editor.selection.isEmpty) {
            kifContent = document.getText(editor.selection);
            sourceName = 'selection';
        } else {
            const line = document.lineAt(editor.selection.active.line);
            kifContent = line.text;
            sourceName = 'line';
        }
    } else if (selected.label === 'Current File') {
        kifContent = document.getText();
        sourceName = path.basename(document.fileName, '.kif');
    } else if (selected.label === 'Entire Workspace') {
        const files = await getKBFiles();
        if (files.length === 0) {
            vscode.window.showWarningMessage('No .kif files found in workspace.');
            return;
        }

        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Collecting workspace files...',
            cancellable: false
        }, async (progress) => {
            for (let i = 0; i < files.length; i++) {
                progress.report({ message: `Processing ${i + 1}/${files.length} files...` });
                const doc = await vscode.workspace.openTextDocument(files[i]);
                kifContent += `; File: ${vscode.workspace.asRelativePath(files[i])}\n`;
                kifContent += doc.getText() + '\n\n';
            }
        });
        sourceName = 'workspace';
    }

    if (!kifContent.trim()) {
        vscode.window.showWarningMessage('No content to process.');
        return;
    }

    // Use compileFormulas from sigma/index.js which handles runtime-specific compilation
    const context = vscode.extensions.getExtension('articulate.sumo').extensionContext;
    const expressions = getTopLevelExpressions(kifContent);
    const tptpContent = await compileFormulas(context, expressions);
    const axiomCount = tptpContent.length;

    if (axiomCount === 0) {
        vscode.window.showWarningMessage('No valid axioms produced.');
        return;
    }

    const tempDir = os.tmpdir();
    const tempFile = path.join(tempDir, `suokif-verify-${Date.now()}.p`);
    fs.writeFileSync(tempFile, tptpContent.join('\n'));

    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Running ${proverType} on ${sourceName}...`,
        cancellable: true
    }, async (progress, token) => {
        return new Promise((resolve, reject) => {
            let cmd;
            if (proverType === 'vampire') {
                cmd = `"${proverPath}" --mode casc -t ${timeout} "${tempFile}"`;
            } else {
                cmd = `"${proverPath}" --auto --cpu-limit=${timeout} "${tempFile}"`;
            }

            const proc = exec(cmd, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
                try { fs.unlinkSync(tempFile); } catch (e) {}

                if (token.isCancellationRequested) {
                    resolve();
                    return;
                }

                const outputChannel = vscode.window.createOutputChannel('SUMO Prover');
                outputChannel.clear();
                outputChannel.appendLine(`Scope: ${selected.label}`);
                outputChannel.appendLine(`Source: ${sourceName}`);
                outputChannel.appendLine(`Axioms: ${axiomCount}`);
                outputChannel.appendLine('='.repeat(60));
                outputChannel.appendLine('');

                if (error && !stdout) {
                    outputChannel.appendLine('Error running prover:');
                    outputChannel.appendLine(stderr || error.message);
                } else {
                    outputChannel.appendLine('Prover Output:');
                    outputChannel.appendLine(stdout);
                    if (stderr) {
                        outputChannel.appendLine('\nStderr:');
                        outputChannel.appendLine(stderr);
                    }
                    
                    if (stdout.includes('Unsatisfiable') || stdout.includes('SZS status Unsatisfiable')) {
                        vscode.window.showInformationMessage('Result: Unsatisfiable (Contradiction found).');
                    } else if (stdout.includes('Satisfiable') || stdout.includes('SZS status Satisfiable')) {
                        vscode.window.showInformationMessage('Result: Satisfiable (Consistent).');
                    } else if (stdout.includes('Theorem') || stdout.includes('SZS status Theorem')) {
                        vscode.window.showInformationMessage('Result: Theorem (Proof found).');
                    } else if (stdout.includes('CounterSatisfiable') || stdout.includes('SZS status CounterSatisfiable')) {
                        vscode.window.showWarningMessage('Result: Counter-Satisfiable.');
                    } else if (stdout.includes('Timeout') || stdout.includes('SZS status Timeout')) {
                        vscode.window.showWarningMessage('Result: Timeout.');
                    } else {
                        vscode.window.showInformationMessage('Prover finished. Check output.');
                    }
                }

                outputChannel.show();
                resolve();
            });

            token.onCancellationRequested(() => {
                proc.kill();
            });
        });
    });
}

function convertToTPTP(kifExpr) {
    const tptp = tptpParseSUOKIFString(kifExpr, true);
    if (!tptp) return '';
    return tptp;
}

function convertKBToTPTP(kifText) {
    const formulas = parseKIFFormulas(kifText);
    const result = convertFormulas(formulas, 'kb', null, false);

    const lines = result.content.split('\n').filter(line =>
        line.startsWith('fof(') || line.startsWith('tff(')
    );

    return lines.join('\n');
}

function getTopLevelExpressions(text) {
    const normalized = text.replace(/\s+/g, ' ');
    let depth = 0;
    let current = "";
    const results = [];

    for (let i = 0; i < normalized.length; i++) {
        const char = normalized[i];
        if (char === '(') depth++;
        if (char === ')') depth--;

        if (depth < 0) {
            throw new Error(`Unbalanced Parentheses: Extra ')' found at character ${i}`);
        }

        current += char;

        if (depth === 0 && current.trim()) {
            results.push(current.trim());
            current = "";
        }
    }

    if (depth > 0) {
        throw new Error(`Unbalanced Parentheses: Missing ${depth} closing ')' at end of file`);
    }

    return results;
}

module.exports = {
    queryProverCommand,
    runProverOnScopeCommand,
    convertToTPTP,
    convertKBToTPTP,
    getTopLevelExpressions
};
