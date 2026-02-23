const vscode = require('vscode');
const path = require('path');
const { 
    findConfigXml, 
    compileKB, 
    compileFormulas 
} = require('./sigma');
const { parseConfigXml } = require('./sigma/config');
const { getTopLevelExpressions } = require('./prover');

async function generateTPTPCommand(context) {
    const editor = vscode.window.activeTextEditor;

    const options = [];
    const configPath = await findConfigXml();
    if (configPath) {
        options.push({
            label: 'Knowledge Base',
            description: `Export a KB as defined in Sigma config.xml`
        });
    }
    
    if (editor && editor.document.languageId === 'suo-kif') {
        options.push({ label: 'Current File', description: 'Convert the current file to TPTP' });
        options.push({ label: 'Selection Only', description: 'Convert selected text to TPTP' });
    }

    const pickableOptions = options.filter(o => !o.disabled);

    const selected = await vscode.window.showQuickPick(pickableOptions, {
        placeHolder: 'Select Translation Source'
    });

    if (!selected) return;
    
    try {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: `Running Sigma Translation...`,
            cancellable: false
        }, async (progress) => {
            let kifContent = '';
            let sourceName = '';
            if (selected.label === 'Knowledge Base') {
                sourceName = 'workspace';
                const cfg = await parseConfigXml(configPath);
                if (!cfg) throw new Error("Could not parse the config.xml to locate knowledge bases");
                const kbs = Object.keys(cfg.knowledgeBases).map(kb => ({ label: kb }));
                const selectedKB = await vscode.window.showQuickPick(kbs, {
                    placeHolder: 'Select Knowledge Base'
                });
                if (!selectedKB) return;
                const filename = await compileKB(context, selectedKB.label);
                // filename is the path to the generated file
                const doc = await vscode.workspace.openTextDocument(filename);
                await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
            } else {
                if (selected.label === 'Current File') {
                    if (!editor) return;
                    kifContent = editor.document.getText();
                    sourceName = path.basename(editor.document.fileName, '.kif');
                } else if (selected.label === 'Selection Only') {
                    if (!editor || editor.selection.isEmpty) {
                        vscode.window.showWarningMessage('No text selected.');
                        return;
                    }
                    kifContent = editor.document.getText(editor.selection);
                    sourceName = path.basename(editor.document.fileName, '.kif') + '-selection';
                }

                let tptpContent = await compileFormulas(context, getTopLevelExpressions(kifContent));

                const tptpDoc = await vscode.workspace.openTextDocument({
                    content: tptpContent.join("\n"),
                    language: 'tptp'
                });

                await vscode.window.showTextDocument(tptpDoc, vscode.ViewColumn.Beside);
            }
        });
    } catch (e) {
        vscode.window.showErrorMessage('Sigma not configured. Please set "sumo.sigmaPath", or enable an alternative sigma runtime. Error: ' + e.message);
        return;
    }
    
    vscode.window.showInformationMessage(
        `TPTP generated. Use File > Save As to save.`
    );
}

module.exports = {
    generateTPTPCommand
};
