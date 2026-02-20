const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { 
    findConfigXml, 
    isWithinConfiguredKB,
    getKBConstituentsFromConfig 
} = require('./sigma');
const { 
    addFileToConfig, 
    removeFileFromConfig, 
    parseConfigXml,
    addKBToConfig
} = require('./sigma/config');
const { buildWorkspaceDefinitions } = require('./navigation');

let kbTreeProvider;

function setKBTreeProvider(provider) {
    kbTreeProvider = provider;
}

async function openKnowledgeBaseCommand() {
    const configPath = await findConfigXml();
    if (!configPath) {
        const action = await vscode.window.showErrorMessage(
            'Could not find Sigma config.xml. Set the path in settings.',
            'Open Settings'
        );
        if (action === 'Open Settings') {
            vscode.commands.executeCommand('workbench.action.openSettings', 'sumo.sigma.configXmlPath');
        }
        return;
    }

    const parsed = await parseConfigXml(configPath);
    if (!parsed) {
        vscode.window.showErrorMessage('Failed to parse config.xml at: ' + configPath);
        return;
    }

    const kbNames = Object.keys(parsed.knowledgeBases);
    if (kbNames.length === 0) {
        vscode.window.showWarningMessage('No knowledge bases found in config.xml');
        return;
    }

    const kbDir = parsed.preferences.kbDir || path.dirname(configPath);

    const kbs = kbNames.map(name => {
        const kb = parsed.knowledgeBases[name];
        const constituents = kb.constituents.map(c =>
            path.isAbsolute(c) ? c : path.join(kbDir, c)
        ).filter(c => fs.existsSync(c));
        return { name, constituents, configPath, kbDir };
    });

    if (kbTreeProvider) {
        kbTreeProvider.refresh(kbs);
    }
    buildWorkspaceDefinitions(); 
    vscode.commands.executeCommand('sumo.kbExplorer.focus');

    const summary = kbs.map(kb =>
        `${kb.name} (${kb.constituents.length} file${kb.constituents.length !== 1 ? 's' : ''})`
    ).join(', ');
    vscode.window.showInformationMessage(
        `Opened ${kbs.length} knowledge base${kbs.length !== 1 ? 's' : ''}: ${summary}`
    );
}

async function addFileToKBCommand(node) {
    if (!node || !node.kb) return;
    const { name: kbName, configPath, kbDir } = node.kb;

    const fileUris = await vscode.window.showOpenDialog({
        canSelectFolders: false,
        canSelectFiles: true,
        canSelectMany: true,
        filters: { 'KIF Files': ['kif'], 'All Files': ['*'] },
        openLabel: `Add to ${kbName}`
    });
    if (!fileUris || fileUris.length === 0) return;

    const errors = [];
    for (const uri of fileUris) {
        const abs = uri.fsPath;
        const rel = path.relative(kbDir, abs);
        const filename = (!rel.startsWith('..')) ? rel : abs;
        try {
            addFileToConfig(configPath, kbName, filename);
        } catch (e) {
            errors.push(e.message);
        }
    }

    if (errors.length > 0) {
        vscode.window.showErrorMessage('Some files could not be added: ' + errors.join('; '));
    }

    await openKnowledgeBaseCommand();
}

async function removeFileFromKBCommand(node) {
    if (!node || !node.filePath) return;
    const { filePath, kbName, configPath, kbDir } = node;

    const confirm = await vscode.window.showWarningMessage(
        `Remove "${path.basename(filePath)}" from KB "${kbName}"?`,
        { modal: true },
        'Remove'
    );
    if (confirm !== 'Remove') return;

    const rel = path.relative(kbDir, filePath);
    const filename = (!rel.startsWith('..')) ? rel : filePath;

    try {
        removeFileFromConfig(configPath, kbName, filename);
    } catch (e) {
        try {
            removeFileFromConfig(configPath, kbName, filePath);
        } catch (e2) {
            vscode.window.showErrorMessage('Failed to remove file: ' + e.message);
            return;
        }
    }

    await openKnowledgeBaseCommand();
}

async function createKnowledgeBaseCommand() {
    const configPath = await findConfigXml();
    if (!configPath) {
        const action = await vscode.window.showErrorMessage(
            'Could not find Sigma config.xml. Set the path in settings or create one first.',
            'Open Settings'
        );
        if (action === 'Open Settings') {
            vscode.commands.executeCommand('workbench.action.openSettings', 'sumo.sigma.configXmlPath');
        }
        return;
    }

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

    const folderUris = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        openLabel: 'Select KB Folder'
    });
    if (!folderUris || folderUris.length === 0) return;

    const folderPath = folderUris[0].fsPath;

    const kifFiles = fs.readdirSync(folderPath).filter(f => f.endsWith('.kif'));
    if (kifFiles.length === 0) {
        vscode.window.showWarningMessage('No .kif files found in selected folder. The KB will have no constituents.');
    }

    const parsed = await parseConfigXml(configPath);
    const kbDir = parsed && parsed.preferences.kbDir ? parsed.preferences.kbDir : path.dirname(configPath);
    const filenames = kifFiles.map(f => {
        const abs = path.join(folderPath, f);
        const rel = path.relative(kbDir, abs);
        if (!rel.startsWith('..')) return rel;
        return abs;
    });

    try {
        addKBToConfig(configPath, kbName, filenames);
    } catch (e) {
        vscode.window.showErrorMessage('Failed to update config.xml: ' + e.message);
        return;
    }

    const action = await vscode.window.showInformationMessage(
        `Knowledge Base "${kbName}" created with ${filenames.length} constituent(s).`,
        'Open KB'
    );
    if (action === 'Open KB') {
        const folderUri = vscode.Uri.file(folderPath);
        vscode.workspace.updateWorkspaceFolders(
            (vscode.workspace.workspaceFolders || []).length, 0,
            { uri: folderUri, name: `KB: ${kbName}` }
        );
    }
}

module.exports = {
    setKBTreeProvider,
    openKnowledgeBaseCommand,
    addFileToKBCommand,
    removeFileFromKBCommand,
    createKnowledgeBaseCommand
};
