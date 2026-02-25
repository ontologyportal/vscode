const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { 
    findConfigXml,
    getSigmaRuntime
} = require('./sigma');
const { KBTreeProvider, KBNode } = require('./kb-tree');
const { 
    addFileToConfig, 
    removeFileFromConfig, 
    parseConfigXml,
    addKBToConfig
} = require('./sigma/config');
const { buildWorkspaceDefinitions, setKB } = require('./navigation');

/** @type {KBTreeProvider} */
let kbTreeProvider;

function setKBTreeProvider(provider) {
    kbTreeProvider = provider;
}

/**
 * Attempt to parse config.xml to find all the knowledge bases available on the system
 * @returns {Promise<void>}
 */
async function openKnowledgeBaseCommand() {
    // Get the config path
    const configPath = await findConfigXml();
    if (!configPath) {
        // Could not find the path, prompt the user
        const action = await vscode.window.showErrorMessage(
            'Could not find Sigma config.xml. Try manually setting the path in settings.',
            'Open Settings'
        );
        if (action === 'Open Settings') {
            vscode.commands.executeCommand('workbench.action.openSettings', 'sumo.sigma.configXmlPath');
        }
        return;
    }

    // Parse the config file
    const parsed = await parseConfigXml(configPath);
    if (!parsed) {
        vscode.window.showErrorMessage('Failed to parse config.xml at: ' + configPath);
        return;
    }

    // Get all the knowledge bases
    const kbNames = Object.keys(parsed.knowledgeBases);
    if (kbNames.length === 0) {
        vscode.window.showWarningMessage('No knowledge bases found in config.xml');
        return;
    }
    // Also get the directory where the knowledge base is stored
    const kbDir = parsed.preferences.kbDir || path.dirname(configPath);
    // Get all the composite files from the knowledge base
    const kbs = kbNames.map(name => {
        const kb = parsed.knowledgeBases[name];
        const constituents = kb.constituents.map(c =>
            // If its an absolute path, take it for face value, otherwise append the kbDir
            path.isAbsolute(c) ? c : path.join(kbDir, c)
        ).filter(c => fs.existsSync(c));
        return { name, constituents, configPath, kbDir };
    });

    if (kbTreeProvider) { // this should be set by now, but just in case
        kbTreeProvider.refresh(kbs); // Populate the knowledge bases in the tree
    }

    // Load the definitions for use with hinting, taxonomy, etc.
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Running Sigma Translation...`,
        cancellable: false
    }, async (progress) => {
        await buildWorkspaceDefinitions();
    });
    await vscode.commands.executeCommand('sumo.kbExplorer.focus');
    await vscode.commands.executeCommand('setContext', 'sumo.KBOpened', true);

    const summary = kbs.map(kb =>
        `${kb.name} (${kb.constituents.length} file${kb.constituents.length !== 1 ? 's' : ''})`
    ).join(', ');
    // Show a summary of the openned knowledge bases
    vscode.window.showInformationMessage(
        `Opened ${kbs.length} knowledge base${kbs.length !== 1 ? 's' : ''}: ${summary}`
    );
}

/**
 * Add a new file to a knowledge base
 * @param {KBNode} node 
 * @returns {Promise<int>} The number of files added
 */
async function addFileToKBCommand(node) {
    if (!node || !node.kb) return;
    const { name: kbName, kbDir } = node.kb;

    // File picker
    const fileUris = await vscode.window.showOpenDialog({
        canSelectFolders: false,
        canSelectFiles: true,
        canSelectMany: true,
        filters: { 'KIF Files': ['kif'], 'All Files': ['*'] },
        openLabel: `Add to ${kbName}`
    });
    // If cancelled
    if (!fileUris || fileUris.length === 0) return;
    // Ask whether to copy the files into the KB folder
    const input = await vscode.window.showQuickPick([
        { label: "Yes", description: "Make a new copy of the file into your KB folder"},
        { label: "No", description: "Just point the config to your file, keeping it in its original location"},
    ], {
        title: "Copy files into KB folder?",
        canPickMany: false
    });

    if (!input) return;
    const copyFile = input.label === "Yes";

    const errors = [];
    let files = 0;
    for (const uri of fileUris) {
        let filename;
        if (!copyFile) { // If not copying, just get the selected path
            const abs = uri.fsPath;
            const rel = path.relative(kbDir, abs);
            // If the file is already inside of the kbfolder, just pass the relative path, otherwise get absolute path
            filename = (!rel.startsWith('..')) ? rel : abs;
        } else { // If copying, actually copy the file
            const runtime = getSigmaRuntime();
            filename = path.basename(uri.fsPath);
            try {
                const content = fs.readFileSync(uri.fsPath, "utf-8");
                let destPath = path.join(kbDir, filename);
                let i = 1;
                while (await runtime.existsAtPath(destPath)) {
                    // File exists there already, add a new integer to the end (like Sigma does)
                    destPath = path.join(kbDir, `${filename}-${i}`);
                    i++;
                }
                // copy the file
                await runtime.writeFile(destPath, content);
                files++;
            } catch (e) {
                errors.push(`Failed to copy the file: ${e}`)
                continue;
            }
        }
        try {
            // Add the file to the config.xml
            await addFileToConfig(kbName, filename);
        } catch (e) {
            errors.push(e.message);
        }
    }

    if (errors.length > 0) {
        vscode.window.showErrorMessage('Some files could not be added: ' + errors.join('; '));
    }

    // Refresh the knowledge base listing
    await openKnowledgeBaseCommand();

    return files;
}

/**
 * Remove a constituent file from the KB
 * @param {KBNode} node 
 * @returns {Promise<void>}
 */
async function removeFileFromKBCommand(node) {
    if (!node || !node.filePath) return;
    const { filePath, kbName, configPath, kbDir } = node;

    // Prompt the user
    const confirm = await vscode.window.showWarningMessage(
        `Remove "${path.basename(filePath)}" from KB "${kbName}"?`,
        { modal: true },
        'Remove'
    );
    if (confirm !== 'Remove') return;

    try {
        // Actually remove the file
        await removeFileFromConfig(kbName, filePath);
    } catch (e) {
        vscode.window.showErrorMessage('Failed to remove file: ' + e.message);
        return;
    }

    // Refresh the knowledge base listing
    await openKnowledgeBaseCommand();
}

/**
 * Create a new knowledge base entry in the config.xml file
 * @returns {Promise<void>}
 */
async function createKnowledgeBaseCommand() {
    const kbName = await vscode.window.showInputBox({
        prompt: 'Enter a name for the new Knowledge Base',
        placeHolder: 'e.g. MyOntology',
        validateInput: (value) => {
            if (!value || !value.trim()) return 'Name is required';
            if (/[<>"&]/.test(value)) return 'Name cannot contain XML special characters';
            return null;
        }
    });
    if (!kbName) return;
    let kbDir;
    try {
        kbDir = await addKBToConfig(kbName);
    } catch (e) {
        vscode.window.showErrorMessage('Failed to update config.xml: ' + e.message);
        return;
    }

    const numFiles = await addFileToKBCommand({kb: { name: kbName, kbDir }});

    const action = await vscode.window.showInformationMessage(
        `Knowledge Base "${kbName}" created with ${numFiles} constituent(s).`,
        'Open KB'
    );
    if (action === 'Open KB') {
        const folderUri = vscode.Uri.file(kbDir);
        vscode.workspace.updateWorkspaceFolders(
            (vscode.workspace.workspaceFolders || []).length, 0,
            { uri: folderUri, name: `KB: ${kbName}` }
        );
    }
}

/**
 * Update the current app state when the current editor is changed
 * @param {vscode.TextEditor} editor
 * @returns 
 */
function updateActiveEditorContext(editor) {
    if (!kbTreeProvider || !editor) {
        vscode.commands.executeCommand('setContext', 'sumo.inKB', false);
        setKB(null);
        return
    }
    const kbNodes = kbTreeProvider.kbs;
    const openPath = editor.document.uri.fsPath;
    for (const kb of kbNodes) {
        for (const filePath of kb.constituents) {
            if (filePath == openPath) {
                vscode.commands.executeCommand('setContext', 'sumo.inKB', true);
                vscode.commands.executeCommand('setContext', 'sumo.currentKB', kb.name);
                setKB(kb.name)
                return;
            }
        }
    }
    vscode.commands.executeCommand('setContext', 'sumo.inKB', false);
    setKB(null);
}

module.exports = {
    setKBTreeProvider,
    openKnowledgeBaseCommand,
    addFileToKBCommand,
    removeFileFromKBCommand,
    createKnowledgeBaseCommand,
    updateActiveEditorContext
};
