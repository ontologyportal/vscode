/**
 * Functionality related to sigma config.xml parsing
 * and utilization
 */

const { getSigmaHome, getSigmaPath, getSigmaRuntime } = require('./engine');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const vscode = require('vscode');

/**
 * Parse Sigma's config.xml file and extract knowledge base definitions
 * @param {string} configPath - Path to config.xml
 * @returns {Object} Parsed configuration with preferences and KBs
 */
async function parseConfigXml(configPath) {
    const runtime = getSigmaRuntime();
    const content = await runtime.readFile(configPath);

    if (!content) return null;

    const result = {
        preferences: {},
        knowledgeBases: {}
    };

    // Parse preferences - <preference name="key" value="val" />
    const prefRegex = /<preference\s+name\s*=\s*"([^"]+)"\s+value\s*=\s*"([^"]*)"\s*\/?\s*>/g;
    let match;
    while ((match = prefRegex.exec(content)) !== null) {
        result.preferences[match[1]] = match[2];
    }

    // Parse knowledge bases - <kb name="SUMO">...</kb>
    const kbRegex = /<kb\s+name\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/kb>/g;
    while ((match = kbRegex.exec(content)) !== null) {
        const kbName = match[1];
        const kbContent = match[2];

        const constituents = [];
        const constRegex = /<constituent\s+filename\s*=\s*"([^"]+)"\s*\/?\s*>/g;
        let constMatch;
        while ((constMatch = constRegex.exec(kbContent)) !== null) {
            constituents.push(constMatch[1]);
        }

        result.knowledgeBases[kbName] = {
            constituents: constituents
        };
    }

    return result;
}

/**
 * Find config.xml for Sigma installation
 * Searches in common locations
 * @returns {string|null} Path to config.xml or null
 */
async function findConfigXml(runtime) {
    const activeRuntime = getSigmaRuntime();
    const config = vscode.workspace.getConfiguration('sumo');

    // 1. Check explicit setting
    const configPath = config.get('configXmlPath');
    if (configPath && fs.existsSync(configPath)) {
        return configPath;
    }

    // Check cache
    if (activeRuntime.configCache) {
        return activeRuntime.configCache;
    }

    // 2. Check Runtime Search
    if (activeRuntime.useNativeJS) return null;

    // Search common paths
    const searchPaths = [
        '/home/sigma/KBs/config.xml',
        '/root/sigmakee/KBs/config.xml',
        '/var/lib/tomcat/webapps/sigma/KBs/config.xml',
        '/opt/sigma/KBs/config.xml'
    ];

    // Add paths from environment variables
    const sigmaHome = await activeRuntime.getEnvironmentVar('SIGMA_HOME') || await activeRuntime.getEnvironmentVar('ONTOLOGYPORTAL_GIT');
    if (sigmaHome) {
        searchPaths.push(path.join(sigmaHome, 'KBs', 'config.xml'));
        searchPaths.push(path.join(sigmaHome, '.sigmakee', 'KBs', 'config.xml'));
        searchPaths.push(path.join(sigmaHome, 'config.xml'));
    }

    for (const p of searchPaths) {
        if (await activeRuntime.existsAtPath(p)) {
            activeRuntime.configCache = p;
            return p;
        }
    }

    // 3. Check relative to sigmaPath
    const sigmaPath = getSigmaPath();
    if (sigmaPath) {
        const possiblePaths = [
            path.join(sigmaPath, '..', 'KBs', 'config.xml'),
            path.join(sigmaPath, 'KBs', 'config.xml'),
            path.join(path.dirname(sigmaPath), 'KBs', 'config.xml')
        ];
        for (const p of possiblePaths) {
            if (fs.existsSync(p)) {
                return p;
            }
        }
    }

    // 4. Check home directory
    const homeDir = os.homedir();
    const homePaths = [
        path.join(homeDir, '.sigmakee', 'KBs', 'config.xml'),
        path.join(homeDir, 'sigmakee', 'KBs', 'config.xml'),
        path.join(homeDir, 'workspace', 'KBs', 'config.xml')
    ];
    for (const p of homePaths) {
        if (fs.existsSync(p)) {
            return p;
        }
    }

    return null;
}

/**
 * Find config.xml on the local filesystem only (synchronous).
 * Unlike findConfigXml(), this works regardless of runtime setting.
 * @returns {string|null} Path to config.xml or null
 */
function findLocalConfigXml() {
    const config = vscode.workspace.getConfiguration('sumo');

    // 1. Check explicit setting
    const configPath = config.get('sigma.configXmlPath');
    if (configPath && fs.existsSync(configPath)) {
        return configPath;
    }

    // 2. Check $SIGMA_HOME/KBs/config.xml
    const sigmaHome = process.env.SIGMA_HOME;
    if (sigmaHome) {
        const p = path.join(sigmaHome, 'KBs', 'config.xml');
        if (fs.existsSync(p)) return p;
    }

    // 3. Check common home directory locations
    const homeDir = os.homedir();
    const homePaths = [
        path.join(homeDir, '.sigmakee', 'KBs', 'config.xml'),
        path.join(homeDir, 'sigmakee', 'KBs', 'config.xml')
    ];
    for (const p of homePaths) {
        if (fs.existsSync(p)) return p;
    }

    return null;
}

/**
 * Parse config.xml synchronously from local filesystem.
 * Same regex parsing as parseConfigXml but uses fs.readFileSync.
 * @param {string} configPath - Path to config.xml
 * @returns {Object|null} Parsed configuration with preferences and KBs
 */
function parseConfigXmlSync(configPath) {
    let content;
    try {
        content = fs.readFileSync(configPath, 'utf-8');
    } catch (e) {
        return null;
    }

    if (!content) return null;

    const result = {
        preferences: {},
        knowledgeBases: {}
    };

    // Parse preferences - <preference name="key" value="val" />
    const prefRegex = /<preference\s+name\s*=\s*"([^"]+)"\s+value\s*=\s*"([^"]*)"\s*\/?\s*>/g;
    let match;
    while ((match = prefRegex.exec(content)) !== null) {
        result.preferences[match[1]] = match[2];
    }

    // Parse knowledge bases - <kb name="SUMO">...</kb>
    const kbRegex = /<kb\s+name\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/kb>/g;
    while ((match = kbRegex.exec(content)) !== null) {
        const kbName = match[1];
        const kbContent = match[2];

        const constituents = [];
        const constRegex = /<constituent\s+filename\s*=\s*"([^"]+)"\s*\/?\s*>/g;
        let constMatch;
        while ((constMatch = constRegex.exec(kbContent)) !== null) {
            constituents.push(constMatch[1]);
        }

        result.knowledgeBases[kbName] = {
            constituents: constituents
        };
    }

    return result;
}

/**
 * Add a new KB entry to config.xml
 * @param {string} configPath - Path to config.xml
 * @param {string} kbName - Name of the new knowledge base
 * @param {string[]} constituentFilenames - Array of constituent file paths
 */
function addKBToConfig(configPath, kbName, constituentFilenames) {
    const content = fs.readFileSync(configPath, 'utf-8');

    const constituentsXml = constituentFilenames
        .map(f => `    <constituent filename="${f}" />`)
        .join('\n');

    const kbEntry = `  <kb name="${kbName}">\n${constituentsXml}\n  </kb>\n`;

    // Insert before closing </configuration> tag
    const closingTag = '</configuration>';
    const idx = content.lastIndexOf(closingTag);
    if (idx === -1) {
        throw new Error('Invalid config.xml: missing </configuration> tag');
    }

    const newContent = content.slice(0, idx) + kbEntry + closingTag + content.slice(idx + closingTag.length);
    fs.writeFileSync(configPath, newContent, 'utf-8');
}

/**
 * Check if the current workspace or file is within a configured KB directory
 * @returns {Object|null} KB info if within a KB, null otherwise
 */
function isWithinConfiguredKB() {
    const configPath = findLocalConfigXml();
    if (!configPath) {
        return null;
    }

    const parsed = parseConfigXmlSync(configPath);
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
    const configPath = findLocalConfigXml();
    if (!configPath) {
        return null;
    }

    const parsed = parseConfigXmlSync(configPath);
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

module.exports = {
    findConfigXml,
    parseConfigXml,
    findLocalConfigXml,
    parseConfigXmlSync,
    addKBToConfig,
    isWithinConfiguredKB,
    getKBConstituentsFromConfig
}