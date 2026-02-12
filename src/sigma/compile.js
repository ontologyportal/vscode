const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const { PassThrough } = require('stream');
const { getSigmaRuntime, getSigmaPath } = require('./engine');
const { isWithinConfiguredKB, getKBConstituentsFromConfig } = require('./config');

/**
 * Compiles the current Knowledge Base to TPTP using Sigma
 */
async function compileKB() {
    const outputChannel = vscode.window.createOutputChannel("Sigma Compilation");
    outputChannel.show();

    const kbContext = isWithinConfiguredKB();
    if (!kbContext) {
        outputChannel.appendLine("Error: Current workspace is not a configured Knowledge Base in config.xml");
        return;
    }

    const runtime = getSigmaRuntime();
    outputChannel.appendLine(`Starting compilation for KB: ${kbContext.kbName || 'Detected in Workspace'}`);
    outputChannel.appendLine(`Runtime: ${runtime.useDocker ? 'Docker' : 'Local'}`);

    if (runtime.useDocker) {
        return await compileDocker(runtime, outputChannel);
    } else if (runtime.useNativeJS) {
        await compileNative(runtime, outputChannel);
    } else {
        return await compileLocal(runtime, outputChannel);
    }
}

function compileLocal(runtime, outputChannel) {
    return new Promise((resolve, reject) => {
        const sigmaSrc = getSigmaPath() || process.env.SIGMA_SRC;
        outputChannel.appendLine(`Located SIGMA_SRC directory: ${sigmaSrc}`);
        
        let classpath = process.env.SIGMA_CP;

        outputChannel.appendLine(`Located SIGMA_CP: ${classpath}`);
        if (!classpath && sigmaSrc) {
            const sep = path.delimiter;
            classpath = `${path.join(sigmaSrc, 'build', 'sigmakee.jar')}${sep}${path.join(sigmaSrc, 'lib', '*')}`;
        }

        if (!classpath) {
            outputChannel.appendLine("Error: SIGMA_SRC or SIGMA_CP environment variable not set for local runtime.");
            return;
        }

        const cmd = 'java';
        const args = [
            '-Xmx8g',
            '-classpath', classpath,
            'com.articulate.sigma.trans.SUMOKBtoTPTPKB'
        ];

        outputChannel.appendLine(`Executing: ${cmd} ${args.join(' ')}`);

        const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
        const proc = spawn(cmd, args, {
            cwd: cwd,
            shell: true 
        });

        let path;

        proc.stdout.on('data', (data) => {
            outputChannel.append(`STDOUT: ${data.toString()}`);
            if (`${data}`.startsWith("File written:")) {
                path = (`${data}`).split(" ")[2].trimEnd();
            }
        });
        proc.stderr.on('data', (data) => outputChannel.append(`STDERR: ${data.toString()}`));
        
        proc.on('close', (code) => {
            outputChannel.appendLine(`Compilation finished with code ${code}`);
            if (code == 0 && path !== undefined) {
                const content = fs.readFileSync(path, "utf-8");
                resolve({ content, numAxioms: content.split("\n").length });
            } else {
                reject();
            }
        });
    });
}

async function compileDocker(runtime, outputChannel) {
    const docker = runtime.docker;
    if (!docker) {
        outputChannel.appendLine("Error: Could not access Docker instance.");
        return;
    }

    const config = vscode.workspace.getConfiguration('sumo');
    const image = config.get('sigma.dockerImage') || 'apease/sigmakee';
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    if (!workspacePath) {
        outputChannel.appendLine("Error: No workspace folder open to mount.");
        return;
    }

    outputChannel.appendLine(`Mounting ${workspacePath} to /workspace`);

    const cmd = `if [ -z "$SIGMA_CP" ]; then if [ -z "$SIGMA_SRC" ]; then export SIGMA_SRC=/home/sigma/sigma; fi; export SIGMA_CP=$SIGMA_SRC/build/sigmakee.jar:$SIGMA_SRC/lib/*; fi; java -Xmx8g -classpath $SIGMA_CP com.articulate.sigma.trans.SUMOKBtoTPTPKB`;

    const stream = new PassThrough();
    stream.on('data', chunk => outputChannel.append(chunk.toString()));

    docker.run(image, ['sh', '-c', cmd], stream, {
        HostConfig: {
            Binds: [`${workspacePath}:/workspace`],
            AutoRemove: true
        },
        WorkingDir: '/workspace'
    }, (err, data) => {
        if (err) outputChannel.appendLine(`Docker Error: ${err}`);
        else outputChannel.appendLine(`Compilation finished with exit code ${data.StatusCode}`);
    });
}

async function compileFormulas(formulas) {
    const outputChannel = vscode.window.createOutputChannel("Sigma Formula Compilation");
    outputChannel.show();

    if (!formulas || formulas.length === 0) {
        outputChannel.appendLine("Error: No formulas provided for compilation.");
        return;
    }

    const combinedFormula = `(and ${formulas.join(' ')})`;
    const runtime = getSigmaRuntime();
    outputChannel.appendLine(`Compiling combined formula: ${combinedFormula}`);

    if (runtime.useDocker) {
        await compileFormulasDocker(runtime, combinedFormula, outputChannel);
    } else if (runtime.useNativeJS) {
        await compileFormulasNative(runtime, combinedFormula, outputChannel);
    } else {
        await compileFormulasLocal(runtime, combinedFormula, outputChannel);
    }
}

async function compileNative(runtime, outputChannel) {
    outputChannel.appendLine("Compiling using Native JS Runtime...");
    
    const kbContext = isWithinConfiguredKB();
    if (!kbContext || !kbContext.kbName) {
        outputChannel.appendLine("Error: No Knowledge Base context detected.");
        return;
    }

    const kbConfig = await getKBConstituentsFromConfig(kbContext.kbName);
    if (!kbConfig) {
        outputChannel.appendLine(`Error: Could not load configuration for KB: ${kbContext.kbName}`);
        return;
    }

    try {
        // Lazy load native components (ESM)
        const { writeFile, readKIFFile } = await import('./engine/native/index.js');

        let allFormulas = [];
        let fileCount = 0;

        for (const file of kbConfig.constituents) {
            try {
                outputChannel.append(`Reading ${path.basename(file)}... `);
                const formulas = readKIFFile(file);
                allFormulas = allFormulas.concat(formulas);
                outputChannel.appendLine(`OK (${formulas.length} formulas)`);
                fileCount++;
            } catch (e) {
                outputChannel.appendLine(`Failed: ${e.message}`);
            }
        }

        outputChannel.appendLine(`Converting ${allFormulas.length} axioms from ${fileCount} files...`);

        const outFile = path.join(kbConfig.kbDir, `${kbConfig.kbName}.fof`);
        
        writeFile(outFile, allFormulas, kbConfig.kbName);

        outputChannel.appendLine(`Success! TPTP file written to: ${outFile}`);
    } catch (e) {
        outputChannel.appendLine(`Conversion Error: ${e.message}`);
    }
}

async function compileFormulasLocal(runtime, formula, outputChannel) {
    const sigmaSrc = getSigmaPath() || process.env.SIGMA_SRC;
    
    let classpath = process.env.SIGMA_CP;
    if (!classpath && sigmaSrc) {
        const sep = path.delimiter;
        classpath = `${path.join(sigmaSrc, 'build', 'sigmakee.jar')}${sep}${path.join(sigmaSrc, 'lib', '*')}`;
    }

    if (!classpath) {
        outputChannel.appendLine("Error: SIGMA_SRC or SIGMA_CP environment variable not set for local runtime.");
        return;
    }

    const cmd = 'java';
    // Note: We wrap the formula in quotes to ensure it's treated as a single argument by the shell/process
    const args = [
        '-Xmx8g',
        '-classpath', classpath,
        'com.articulate.sigma.trans.SUMOformulaToTPTPformula',
        '-g', `"${formula.replace(/"/g, '\\"')}"`
    ];

    outputChannel.appendLine(`Executing: ${cmd} ... -g "${formula}"`);

    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd();
    const proc = spawn(cmd, args, {
        cwd: cwd,
        shell: true 
    });

    proc.stdout.on('data', (data) => outputChannel.append(data.toString()));
    proc.stderr.on('data', (data) => outputChannel.append(data.toString()));
    
    proc.on('close', (code) => {
        outputChannel.appendLine(`Compilation finished with code ${code}`);
    });
}

async function compileFormulasDocker(runtime, formula, outputChannel) {
    const docker = runtime.docker;
    if (!docker) {
        outputChannel.appendLine("Error: Could not access Docker instance.");
        return;
    }

    const config = vscode.workspace.getConfiguration('sumo');
    const image = config.get('sigma.dockerImage') || 'apease/sigmakee';
    
    // Escape quotes for the shell command inside Docker
    const escapedFormula = formula.replace(/"/g, '\\"');
    const cmd = `if [ -z "$SIGMA_CP" ]; then if [ -z "$SIGMA_SRC" ]; then export SIGMA_SRC=/home/sigma/sigma; fi; export SIGMA_CP=$SIGMA_SRC/build/sigmakee.jar:$SIGMA_SRC/lib/*; fi; java -Xmx8g -classpath $SIGMA_CP com.articulate.sigma.trans.SUMOformulaToTPTPformula -g "${escapedFormula}"`;

    const stream = new PassThrough();
    stream.on('data', chunk => outputChannel.append(chunk.toString()));

    // We don't necessarily need to mount workspace for formula conversion, but it doesn't hurt if we are in one
    const runOptions = { AutoRemove: true };
    
    docker.run(image, ['sh', '-c', cmd], stream, runOptions, (err, data) => {
        if (err) outputChannel.appendLine(`Docker Error: ${err}`);
        else outputChannel.appendLine(`Compilation finished with exit code ${data.StatusCode}`);
    });
}

async function compileFormulasNative(runtime, formula, outputChannel) {
    try {
        const { tptpParseSUOKIFString } = await import('./engine/native/index.js');
        
        const tptp = tptpParseSUOKIFString(formula, false);
        
        if (tptp) {
            outputChannel.appendLine(tptp);
        }
    } catch (e) {
        outputChannel.appendLine(`Native Compilation Error: ${e.message}`);
    }
}

module.exports = { compileKB, compileFormulas };