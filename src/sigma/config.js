/**
 * Functionality related to sigma config.xml parsing
 * and utilization
 */

vscode = require('vscode');

/**
 * Parse Sigma's config.xml file and extract knowledge base definitions
 * @param {string} configPath - Path to config.xml
 * @returns {Object} Parsed configuration with preferences and KBs
 */
function parseConfigXml(configPath) {
    if (!fs.existsSync(configPath)) {
        return null;
    }

    const content = fs.readFileSync(configPath, 'utf8');

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
function findConfigXml() {
    const config = vscode.workspace.getConfiguration('suo-kif');

    // 1. Check explicit setting
    const configPath = config.get('configXmlPath');
    if (configPath && fs.existsSync(configPath)) {
        return configPath;
    }

    // 2. Check SIGMA_HOME environment variable
    const sigmaHome = process.env.SIGMA_HOME || process.env.ONTOLOGYPORTAL_GIT;
    if (sigmaHome) {
        const possiblePaths = [
            path.join(sigmaHome, 'KBs', 'config.xml'),
            path.join(sigmaHome, '.sigmakee', 'KBs', 'config.xml'),
            path.join(sigmaHome, 'config.xml')
        ];
        for (const p of possiblePaths) {
            if (fs.existsSync(p)) {
                return p;
            }
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

module.exports = {
    findConfigXml,
    parseConfigXml
}