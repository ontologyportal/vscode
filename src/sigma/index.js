/**
 * Sigmakee interface code for extension
 */
const vscode = require('vscode');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { findConfigXml, parseConfigXml } = require('./config');

/**
 * Helper to get the currently selected runtime for sigma
 */
function getSigmaRuntime() {
    // Check config from vscode
    const config = vscode.workspace.getConfiguration('suo-kif');
    const runtime = config.get('sigmaRuntime');
    return {
        useDocker: runtime === 'docker',
        useLocal: runtime === 'local',
        useNativeJS: runtime.startsWith('native')
    };
}

/**
 * Helper to get path to sigma
 */
function getSigmaPath() {
    // Check config from vscode
    const config = vscode.workspace.getConfiguration('suo-kif');
    const { useLocal } = getSigmaRuntime();
    if (!useLocal) {
        // If not using a local install, this should return null
        return null;
    }
    let sigmaPath = config.get('sigmaPath');

    // If the path is not specified, check the environment variable
    if (!sigmaPath && process.env.SIGMA_SRC) {
        sigmaPath = process.env.SIGMA_SRC;
    }

    if (!sigmaPath) return null;
    if (fs.existsSync(sigmaPath)) return sigmaPath;
    return null;
}

/**
 * Check if the current workspace or file is within a configured KB directory
 * @returns {Object|null} KB info if within a KB, null otherwise
 */
function isWithinConfiguredKB() {
    const configPath = findConfigXml();
    if (!configPath) {
        return null;
    }

    const parsed = parseConfigXml(configPath);
    if (!parsed) {
        return null;
    }

    // Get kbDir from preferences
    const kbDir = parsed.preferences.kbDir || path.dirname(configPath);
    const normalizedKbDir = path.normalize(kbDir).toLowerCase();

    // Check if current workspace is within kbDir
    if (vscode.workspace.workspaceFolders) {
        for (const folder of vscode.workspace.workspaceFolders) {
            const normalizedFolder = path.normalize(folder.uri.fsPath).toLowerCase();
            if (normalizedFolder.startsWith(normalizedKbDir) || normalizedKbDir.startsWith(normalizedFolder)) {
                // Find which KB(s) the workspace overlaps with
                for (const [kbName, kb] of Object.entries(parsed.knowledgeBases)) {
                    const resolvedConstituents = kb.constituents.map(c => {
                        if (path.isAbsolute(c)) return path.normalize(c).toLowerCase();
                        return path.normalize(path.join(kbDir, c)).toLowerCase();
                    });

                    // Check if any workspace file could be a constituent
                    for (const constituent of resolvedConstituents) {
                        const constituentDir = path.dirname(constituent);
                        if (normalizedFolder.startsWith(constituentDir) || constituentDir.startsWith(normalizedFolder)) {
                            return {
                                kbName: kbName,
                                kbDir: kbDir,
                                configPath: configPath,
                                parsed: parsed
                            };
                        }
                    }
                }

                // Workspace is in kbDir but not matching specific KB constituents
                // Still allow if workspace is within the KB directory structure
                return {
                    kbName: null,  // User will need to select
                    kbDir: kbDir,
                    configPath: configPath,
                    parsed: parsed
                };
            }
        }
    }

    // Check if current active file is within kbDir
    const editor = vscode.window.activeTextEditor;
    if (editor) {
        const filePath = path.normalize(editor.document.uri.fsPath).toLowerCase();
        if (filePath.startsWith(normalizedKbDir)) {
            // Find which KB this file belongs to
            for (const [kbName, kb] of Object.entries(parsed.knowledgeBases)) {
                const resolvedConstituents = kb.constituents.map(c => {
                    if (path.isAbsolute(c)) return path.normalize(c).toLowerCase();
                    return path.normalize(path.join(kbDir, c)).toLowerCase();
                });

                if (resolvedConstituents.includes(filePath)) {
                    return {
                        kbName: kbName,
                        kbDir: kbDir,
                        configPath: configPath,
                        parsed: parsed
                    };
                }
            }

            // File is in kbDir but not a specific constituent
            return {
                kbName: null,
                kbDir: kbDir,
                configPath: configPath,
                parsed: parsed
            };
        }
    }

    return null;
}

/**
 * Get KB constituents from config.xml
 * @param {string} kbName - Name of the knowledge base (default: SUMO)
 * @returns {Array<string>|null} Array of constituent file paths or null
 */
async function getKBConstituentsFromConfig(kbName = null) {
    const configPath = findConfigXml();
    if (!configPath) {
        return null;
    }

    const parsed = parseConfigXml(configPath);
    if (!parsed) {
        return null;
    }

    // Get kbDir from preferences
    const kbDir = parsed.preferences.kbDir || path.dirname(configPath);

    // If no kbName specified, let user choose or use sumokbname preference
    let targetKB = kbName;
    if (!targetKB) {
        targetKB = parsed.preferences.sumokbname;
    }

    // If still no KB, show picker
    if (!targetKB || !parsed.knowledgeBases[targetKB]) {
        const kbNames = Object.keys(parsed.knowledgeBases);
        if (kbNames.length === 0) {
            vscode.window.showWarningMessage('No knowledge bases found in config.xml');
            return null;
        }
        if (kbNames.length === 1) {
            targetKB = kbNames[0];
        } else {
            const selected = await vscode.window.showQuickPick(
                kbNames.map(name => ({
                    label: name,
                    description: `${parsed.knowledgeBases[name].constituents.length} constituent files`
                })),
                { placeHolder: 'Select Knowledge Base from config.xml' }
            );
            if (!selected) return null;
            targetKB = selected.label;
        }
    }

    const kb = parsed.knowledgeBases[targetKB];
    if (!kb) {
        vscode.window.showWarningMessage(`Knowledge base '${targetKB}' not found in config.xml`);
        return null;
    }

    // Resolve constituent paths
    const constituents = kb.constituents.map(c => {
        if (path.isAbsolute(c)) {
            return c;
        }
        return path.join(kbDir, c);
    }).filter(c => fs.existsSync(c));

    return {
        kbName: targetKB,
        constituents: constituents,
        kbDir: kbDir,
        configPath: configPath
    };
}

async function runSigmaDocker(filesToLoad, action, targetContent = "", tptpLang = "fof") {
    const config = vscode.workspace.getConfiguration('suo-kif');
    const image = config.get('dockerImage') || 'adampease/sigmakee';
    const tempDir = os.tmpdir();

    // 1. Prepare Wrapper Source in Temp
    const wrapperSource = path.join(tempDir, 'SigmaWrapper.java');
    const wrapperContent = `
import com.articulate.sigma.*;
import com.articulate.sigma.trans.*;
import java.nio.file.*;
import java.io.*;
import java.util.*;

public class SigmaWrapper {
    public static void main(String[] args) {
        if (args.length < 1) {
            System.err.println("Usage: SigmaWrapper <params_file>");
            System.exit(1);
        }

        try {
            PrintStream originalOut = System.out;
            System.setOut(new PrintStream(new OutputStream() { public void write(int b) {} }));

            List<String> lines = Files.readAllLines(Paths.get(args[0]));
            String action = "";
            String targetContent = "";
            String tptpLang = "fof";
            List<String> filesToLoad = new ArrayList<>();

            for (String line : lines) {
                if (line.startsWith("ACTION=")) action = line.substring(7);
                else if (line.startsWith("TARGET=")) targetContent = line.substring(7).replace("\\\\n", "\\n");
                else if (line.startsWith("LANG=")) tptpLang = line.substring(5);
                else if (line.startsWith("LOAD=")) filesToLoad.add(line.substring(5));
            }

            // Set TPTP language
            SUMOKBtoTPTPKB.lang = tptpLang;
            SUMOformulaToTPTPformula.lang = tptpLang;

            KBmanager.getMgr().initializeOnce();

            String kbName = "VSCodeKB";
            KB kb = new KB(kbName, ".");
            KBmanager.getMgr().addKB(kbName, false);
            KBmanager.getMgr().setPref("sumokbname", kbName);

            for (String f : filesToLoad) {
                kb.addConstituent(f);
            }
            kb.reload();

            System.setOut(originalOut);

            if ("EXPORT_KB".equals(action) || "PROVE".equals(action)) {
                // Export entire KB to TPTP
                SUMOKBtoTPTPKB exporter = new SUMOKBtoTPTPKB();
                exporter.kb = kb;
                // Write directly to stdout via PrintWriter
                PrintWriter pw = new PrintWriter(System.out, true);
                exporter.writeFile(null, null, false, pw);
                pw.flush();
            } else if ("CONVERT".equals(action)) {
                // Convert specific content in context of KB
                if (targetContent != null && !targetContent.isEmpty()) {
                    String tptp = SUMOformulaToTPTPformula.tptpParseSUOKIFString(targetContent, false);
                    if (tptp != null) System.out.println(tptp);
                }
            }

        } catch (Exception e) {
            e.printStackTrace();
            System.exit(1);
        }
    }
}
`;
    fs.writeFileSync(wrapperSource, wrapperContent);

    // 2. Determine Mount Points
    const mounts = [];
    const remappedFiles = [];

    // Mount Temp Dir (for Wrapper + Params) -> /wrapper
    mounts.push(`-v "${tempDir}:/wrapper"`);

    // Determine Workspace Root
    let workspaceRoot = null;
    if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
        workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
        mounts.push(`-v "${workspaceRoot}:/workspace"`);
    }

    // Determine External KB Path
    const extKBPath = config.get('externalKBPath');
    if (extKBPath && fs.existsSync(extKBPath)) {
        mounts.push(`-v "${extKBPath}:/kb"`);
    }

    // Also mount any additional directories containing files to load
    const additionalMounts = new Set();
    for (const f of filesToLoad) {
        const dir = path.dirname(f);
        if (workspaceRoot && f.startsWith(workspaceRoot)) continue;
        if (extKBPath && f.startsWith(extKBPath)) continue;
        if (f.startsWith(tempDir)) continue;
        // Need to mount this directory
        additionalMounts.add(dir);
    }

    let mountIndex = 0;
    const additionalMountMap = {};
    for (const dir of additionalMounts) {
        const mountPoint = `/mount${mountIndex++}`;
        mounts.push(`-v "${dir}:${mountPoint}"`);
        additionalMountMap[dir] = mountPoint;
    }

    // 3. Remap File Paths
    const uniqueFiles = [...new Set(filesToLoad)];
    for (const f of uniqueFiles) {
        let mapped = f;
        if (workspaceRoot && f.startsWith(workspaceRoot)) {
            const rel = path.relative(workspaceRoot, f);
            mapped = path.posix.join('/workspace', rel.replace(/\\/g, '/'));
        } else if (extKBPath && f.startsWith(extKBPath)) {
            const rel = path.relative(extKBPath, f);
            mapped = path.posix.join('/kb', rel.replace(/\\/g, '/'));
        } else if (f.startsWith(tempDir)) {
            const rel = path.relative(tempDir, f);
            mapped = path.posix.join('/wrapper', rel.replace(/\\/g, '/'));
        } else {
            // Check additional mounts
            const dir = path.dirname(f);
            if (additionalMountMap[dir]) {
                mapped = path.posix.join(additionalMountMap[dir], path.basename(f));
            }
        }
        // Normalize slashes for Linux container
        mapped = mapped.replace(/\\/g, '/');
        remappedFiles.push(mapped);
    }

    // 4. Create Params File
    const paramsFile = path.join(tempDir, `sigma-params-docker-${Date.now()}.txt`);
    let paramsContent = `ACTION=${action}\n`;
    paramsContent += `LANG=${tptpLang}\n`;
    if (targetContent) {
        paramsContent += `TARGET=${targetContent.replace(/\n/g, '\\n')}\n`;
    }
    for (const f of remappedFiles) {
        paramsContent += `LOAD=${f}\n`;
    }
    fs.writeFileSync(paramsFile, paramsContent);

    // 5. Run Docker Command
    const paramsFileName = path.basename(paramsFile);
    const cmd = `docker run --rm ${mounts.join(' ')} ${image} java -cp "/root/sigmakee/*:/root/sigmakee/sigmakee.jar" /wrapper/SigmaWrapper.java /wrapper/${paramsFileName}`;

    return new Promise((resolve, reject) => {
        exec(cmd, { maxBuffer: 100 * 1024 * 1024, timeout: 600000 }, (err, stdout, stderr) => {
            try { fs.unlinkSync(paramsFile); } catch(e){}

            if (err) {
                reject(new Error(`Docker execution failed: ${stderr || err.message}`));
            } else {
                resolve(stdout);
            }
        });
    });
}

async function runSigmaConverter(sigmaHome, filesToLoad, action, targetContent = "", tptpLang = "fof") {
    const cp = await getSigmaClasspath(sigmaHome);
    const wrapper = await ensureWrapperCompiled(cp);

    const tempDir = os.tmpdir();
    const paramsFile = path.join(tempDir, `sigma-params-${Date.now()}.txt`);

    let params = `ACTION=${action}\n`;
    params += `LANG=${tptpLang}\n`;
    if (targetContent) {
        // Escape newlines for simple parsing
        params += `TARGET=${targetContent.replace(/\n/g, '\\n')}\n`;
    }

    // Dedup files
    const uniqueFiles = [...new Set(filesToLoad)];
    for (const f of uniqueFiles) {
        params += `LOAD=${f}\n`;
    }

    fs.writeFileSync(paramsFile, params);

    return new Promise((resolve, reject) => {
        const cmd = `java -Xmx8g -cp "${cp}" SigmaWrapper "${paramsFile}"`;

        exec(cmd, { cwd: tempDir, maxBuffer: 100 * 1024 * 1024, timeout: 600000 }, (err, stdout, stderr) => {
            // Cleanup
            try { fs.unlinkSync(paramsFile); } catch(e){}

            if (err) {
                reject(new Error(`Sigma execution failed: ${stderr || err.message}`));
            } else {
                resolve(stdout);
            }
        });
    });
}

async function getSigmaClasspath(sigmaHome) {
    const parts = [];
    
    // 1. Build directory (classes or jar)
    const buildDir = path.join(sigmaHome, 'build');
    const classesDir = path.join(buildDir, 'classes');
    
    if (fs.existsSync(classesDir)) {
        parts.push(classesDir);
    } else {
        // Look for jar
        const files = fs.existsSync(buildDir) ? fs.readdirSync(buildDir) : [];
        const jar = files.find(f => f.endsWith('.jar') && f.includes('sigma'));
        if (jar) {
            parts.push(path.join(buildDir, jar));
        }
    }
    
    // 2. Lib directory
    const libDir = path.join(sigmaHome, 'lib');
    if (fs.existsSync(libDir)) {
        parts.push(path.join(libDir, '*'));
    }
    
    // Add temp dir (for Wrapper)
    parts.push(os.tmpdir());
    
    return parts.join(path.delimiter);
}

async function ensureWrapperCompiled(classpath) {
    const tempDir = os.tmpdir();
    const wrapperSource = path.join(tempDir, 'SigmaWrapper.java');
    const wrapperClass = path.join(tempDir, 'SigmaWrapper.class');

    // Always write source to ensure it's up to date
    const sourceCode = `
import com.articulate.sigma.*;
import com.articulate.sigma.trans.*;
import java.nio.file.*;
import java.io.*;
import java.util.*;

public class SigmaWrapper {
    public static void main(String[] args) {
        if (args.length < 1) {
            System.err.println("Usage: SigmaWrapper <params_file>");
            System.exit(1);
        }

        try {
            // Silence stdout during init to prevent noise
            PrintStream originalOut = System.out;
            System.setOut(new PrintStream(new OutputStream() { public void write(int b) {} }));

            // Read Params
            List<String> lines = Files.readAllLines(Paths.get(args[0]));
            String action = "";
            String targetContent = "";
            String tptpLang = "fof";
            List<String> filesToLoad = new ArrayList<>();

            for (String line : lines) {
                if (line.startsWith("ACTION=")) action = line.substring(7);
                else if (line.startsWith("TARGET=")) targetContent = line.substring(7).replace("\\\\\\\\n", "\\n");
                else if (line.startsWith("LANG=")) tptpLang = line.substring(5);
                else if (line.startsWith("LOAD=")) filesToLoad.add(line.substring(5));
            }

            // Set TPTP language before initialization
            SUMOKBtoTPTPKB.lang = tptpLang;
            SUMOformulaToTPTPformula.lang = tptpLang;

            // Initialize minimal Sigma
            KBmanager.getMgr().initializeOnce();

            // Create Custom KB
            String kbName = "VSCodeKB";
            KB kb = new KB(kbName, ".");

            // Register KB
            KBmanager.getMgr().addKB(kbName, false);
            KBmanager.getMgr().setPref("sumokbname", kbName);

            // Add constituents
            for (String f : filesToLoad) {
                kb.addConstituent(f);
            }

            // Load/Parse (build cache)
            kb.reload();

            // Restore stdout for output
            System.setOut(originalOut);

            if ("EXPORT_KB".equals(action) || "PROVE".equals(action)) {
                // Export entire KB to TPTP
                SUMOKBtoTPTPKB exporter = new SUMOKBtoTPTPKB();
                exporter.kb = kb;
                // Write directly to stdout via PrintWriter
                PrintWriter pw = new PrintWriter(System.out, true);
                exporter.writeFile(null, null, false, pw);
                pw.flush();
            } else if ("CONVERT".equals(action)) {
                // Convert specific content in context of KB
                if (targetContent != null && !targetContent.isEmpty()) {
                    String tptp = SUMOformulaToTPTPformula.tptpParseSUOKIFString(targetContent, false);
                    if (tptp != null) System.out.println(tptp);
                }
            }

        } catch (Exception e) {
            e.printStackTrace();
            System.exit(1);
        }
    }
}
`;
    fs.writeFileSync(wrapperSource, sourceCode);

    return new Promise((resolve, reject) => {
        exec(`javac -cp "${classpath}" "${wrapperSource}"`, { cwd: tempDir }, (err, stdout, stderr) => {
            if (err) {
                reject(new Error(`Failed to compile SigmaWrapper: ${stderr || err.message}`));
            } else {
                resolve(wrapperClass);
            }
        });
    });
}

module.exports = {
    getSigmaPath,
    findConfigXml,
    isWithinConfiguredKB,
    getKBConstituentsFromConfig,
    runSigmaDocker,
    runSigmaConverter,
    getSigmaRuntime
};
