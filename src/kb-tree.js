/**
 * Tree data provider for the Knowledge Base Explorer panel.
 * Displays each KB from config.xml as a collapsible group containing
 * only its constituent files.
 */

const vscode = require('vscode');
const path = require('path');

/**
 * @extends vscode.TreeItem
 * @class
 * @constructor
 * @public
 */
class KBNode extends vscode.TreeItem {
    constructor(kb) {
        super(kb.name, vscode.TreeItemCollapsibleState.Expanded);
        this.contextValue = 'kb';
        this.description = `${kb.constituents.length} file${kb.constituents.length !== 1 ? 's' : ''}`;
        this.tooltip = `Knowledge Base: ${kb.name}\n${kb.constituents.length} constituent file(s)\nConfig: ${kb.configPath}`;
        this.iconPath = new vscode.ThemeIcon('database');
        /** 
         * Keep track of the knowledge base used by this node
         * @type {{ name: string, constituents: string[], configPath: string, kbDir: string }}
         * @public
         */
        this.kb = kb;
    }
}

class KBFileNode extends vscode.TreeItem {
    constructor(filePath, kbName, configPath, kbDir) {
        super(path.basename(filePath), vscode.TreeItemCollapsibleState.None);
        this.contextValue = 'kbFile';
        this.tooltip = filePath;
        this.resourceUri = vscode.Uri.file(filePath);
        this.command = {
            command: 'vscode.open',
            title: 'Open File',
            arguments: [vscode.Uri.file(filePath)]
        };
        this.filePath = filePath;
        this.kbName = kbName;
        this.configPath = configPath;
        this.kbDir = kbDir;
    }
}

class KBTreeProvider {
    constructor() {
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        /** 
         * Keep track of the knowledge base used by this node
         * @type {{ name: string, constituents: string[], configPath: string, kbDir: string }[]}
         * @public
         */
        this.kbs = [];
    }

    /**
     * Populate the tree with KB data and fire a refresh.
     * @param {Array<{name: string, constituents: string[], configPath: string, kbDir: string}>} kbs
     */
    refresh(kbs) {
        this.kbs = kbs || [];
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element) {
        return element;
    }

    getChildren(element) {
        if (!element) {
            return this.kbs.map(kb => new KBNode(kb));
        }
        if (element instanceof KBNode) {
            return element.kb.constituents.map(
                filePath => new KBFileNode(filePath, element.kb.name, element.kb.configPath, element.kb.kbDir)
            );
        }
        return [];
    }
}

module.exports = { KBTreeProvider, KBNode, KBFileNode };
