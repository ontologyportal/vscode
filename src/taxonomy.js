const vscode = require('vscode');
const { getKBFiles } = require('./navigation');
const path = require('path');
const fs = require('fs');

async function showTaxonomyCommand(argSymbol) {
    let symbol = (typeof argSymbol === 'string') ? argSymbol : undefined;
    
    if (!symbol) {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;

        const document = editor.document;
        const position = editor.selection.active;
        const range = document.getWordRangeAtPosition(position);
        if (!range) {
            vscode.window.showInformationMessage("Please select a symbol to view its taxonomy.");
            return;
        }
        symbol = document.getText(range);
    }
    
    const panel = vscode.window.createWebviewPanel(
        'suoKifTaxonomy',
        `Taxonomy: ${symbol}`,
        vscode.ViewColumn.Beside,
        { enableScripts: true }
    );

    const updateWebview = async (targetSymbol) => {
        panel.title = `Taxonomy: ${targetSymbol}`;
        panel.webview.html = `<!DOCTYPE html><html><body style="font-family: sans-serif; padding: 10px;"><h3>Loading taxonomy for ${targetSymbol}...</h3></body></html>`;
        
        const { parents, children, documentation } = await buildWorkspaceTaxonomy();
        const doc = (documentation[targetSymbol]) 
            ? documentation[targetSymbol]
            : "No documentation found in workspace.";

        panel.webview.html = generateTaxonomyHtml(targetSymbol, parents, children, doc);
    };

    panel.webview.onDidReceiveMessage(
        message => {
            switch (message.command) {
                case 'openTaxonomy':
                    updateWebview(message.symbol);
                    return;
                case 'searchSymbol':
                    vscode.commands.executeCommand('sumo.searchSymbol', message.symbol);
                    return;
            }
        },
        undefined,
        undefined
    );

    updateWebview(symbol);
}

async function buildWorkspaceTaxonomy() {
    const files = await getKBFiles();
    const parentGraph = {}; // child -> [parents]
    const childGraph = {}; // parent -> [children]
    const docMap = {}; // symbol -> { text, lang }
    const targetLang = vscode.workspace.getConfiguration('sumo').get('language') || 'EnglishLanguage';

    for (const file of files) {
        const doc = await vscode.workspace.openTextDocument(file);
        const text = doc.getText().replace(/("(?:\[\s\S]|[^"])*")|;.*$/gm, (m, g1) => g1 || '');
        
        const regex = /\(\s*(subclass|subrelation)\s+([^?\s\)][^\s\)]*)\s+([^?\s\)][^\s\)]*)/g;
        let match;
        while ((match = regex.exec(text)) !== null) {
            const child = match[2];
            const parent = match[3];
            
            if (!parentGraph[child]) parentGraph[child] = [];
            if (!parentGraph[child].includes(parent)) parentGraph[child].push(parent);

            if (!childGraph[parent]) childGraph[parent] = [];
            if (!childGraph[parent].includes(child)) childGraph[parent].push(child);
        }

        const docRegex = /\(\s*documentation\s+([^\s\)]+)\s+([^\s\)]+)\s+"((?:[^"\]|\[\s\S])*)"/g;
        let docMatch;
        while ((docMatch = docRegex.exec(text)) !== null) {
            const sym = docMatch[1];
            const lang = docMatch[2];
            let docStr = docMatch[3];
            docStr = docStr.replace(/"/g, '"');
            
            if (!docMap[sym] || lang === targetLang || docMap[sym].lang !== targetLang) {
                docMap[sym] = { text: docStr, lang: lang };
            }
        }
    }
    
    const documentation = {};
    for (const [s, d] of Object.entries(docMap)) {
        documentation[s] = d.text;
    }

    return { parents: parentGraph, children: childGraph, documentation };
}

function generateTaxonomyHtml(symbol, parentGraph, childGraph, documentation) {
    const renderTree = (curr, graph, visited = new Set()) => {
        if (visited.has(curr)) return `<li><strong class="symbol-node" data-symbol="${curr}">${curr}</strong> (cycle)</li>`;
        visited.add(curr);
        
        const nextNodes = graph[curr] || [];
        if (nextNodes.length === 0) return `<li><strong class="symbol-node" data-symbol="${curr}">${curr}</strong></li>`;
        
        let html = `<li><strong class="symbol-node" data-symbol="${curr}">${curr}</strong><ul>`;
        nextNodes.forEach(n => {
            html += renderTree(n, graph, new Set(visited));
        });
        html += `</ul></li>`;
        return html;
    };

    const { tree: ancestorTree, roots: ancestorRoots } = buildAncestorGraph(symbol, parentGraph);

    const directChildren = childGraph[symbol] || [];
    const childrenHtml = directChildren.length > 0 
        ? `<ul>${directChildren.map(c => `<li><strong class="symbol-node" data-symbol="${c}">${c}</strong></li>`).join('')}</ul>` 
        : '<em>No direct subclasses found.</em>';

    return `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <style>
                body { font-family: var(--vscode-font-family); padding: 20px; color: var(--vscode-editor-foreground); background-color: var(--vscode-editor-background); }
                h2 { color: var(--vscode-textLink-foreground); border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 5px; }
                ul { list-style-type: none; border-left: 1px solid var(--vscode-tree-indentGuidesStroke); padding-left: 15px; }
                li { margin: 5px 0; }
                li > strong {
                    transition: transform 0.2s ease, color 0.2s ease;
                    display: inline-block;
                    cursor: context-menu;
                }
                li > strong:hover { transform: translateX(5px); color: var(--vscode-textLink-activeForeground); cursor: default; }
                
                #context-menu {
                    display: none;
                    position: absolute;
                    z-index: 1000;
                    background-color: var(--vscode-menu-background);
                    color: var(--vscode-menu-foreground);
                    border: 1px solid var(--vscode-menu-border);
                    box-shadow: 0 2px 8px rgba(0,0,0,0.15);
                    padding: 4px 0;
                    min-width: 150px;
                }
                .menu-item {
                    padding: 4px 12px;
                    cursor: pointer;
                    display: block;
                    font-size: 13px;
                }
                .menu-item:hover {
                    background-color: var(--vscode-menu-selectionBackground);
                    color: var(--vscode-menu-selectionForeground);
                }
                .doc-block {
                    margin-bottom: 15px;
                    padding: 10px;
                    background-color: var(--vscode-textBlockQuote-background);
                    border-left: 4px solid var(--vscode-textBlockQuote-border);
                }
            </style>
        </head>
        <body>
            <h1>Taxonomy: ${symbol}</h1>
            ${documentation ? `<div class="doc-block">${documentation}</div>` : ''}
            <h2>Superclasses (Ancestors)</h2>
            <ul>
                ${ancestorRoots.map(r => renderTree(r, ancestorTree)).join('') || '<li><em>No superclasses found.</em></li>'}
            </ul>
            <h2>Direct Subclasses (Children)</h2>
            ${childrenHtml}

            <div id="context-menu">
                <div class="menu-item" id="menu-focus">Focus Symbol</div>
                <div class="menu-item" id="menu-search">Search in Workspace</div>
            </div>

            <script>
                const vscode = acquireVsCodeApi();
                const menu = document.getElementById('context-menu');
                let currentSymbol = null;

                document.addEventListener('contextmenu', (e) => {
                    const target = e.target;
                    if (target.tagName === 'STRONG' && target.classList.contains('symbol-node')) {
                        e.preventDefault();
                        currentSymbol = target.getAttribute('data-symbol');
                        menu.style.display = 'block';
                        menu.style.left = e.pageX + 'px';
                        menu.style.top = e.pageY + 'px';
                    } else {
                        menu.style.display = 'none';
                    }
                });

                document.addEventListener('click', () => {
                    menu.style.display = 'none';
                });

                document.getElementById('menu-focus').addEventListener('click', () => {
                    if (currentSymbol) {
                        vscode.postMessage({ command: 'openTaxonomy', symbol: currentSymbol });
                    }
                });

                document.getElementById('menu-search').addEventListener('click', () => {
                    if (currentSymbol) {
                        vscode.postMessage({ command: 'searchSymbol', symbol: currentSymbol });
                    }
                });
            </script>
        </body>
        </html>
    `;
}

function buildAncestorGraph(symbol, parentGraph) {
    const tree = {}; 
    const visited = new Set();
    const queue = [symbol];
    const nodesInTree = new Set([symbol]);

    while (queue.length > 0) {
        const child = queue.shift();
        if (visited.has(child)) continue;
        visited.add(child);

        const parents = parentGraph[child] || [];
        parents.forEach(p => {
            if (!tree[p]) tree[p] = [];
            if (!tree[p].includes(child)) tree[p].push(child);
            
            nodesInTree.add(p);
            queue.push(p);
        });
    }

    const roots = [];
    const allChildren = new Set();
    Object.values(tree).forEach(children => children.forEach(c => allChildren.add(c)));

    nodesInTree.forEach(node => {
        if (!allChildren.has(node) && node !== symbol) {
            roots.push(node);
        }
    });

    return { tree, roots };
}

module.exports = {
    showTaxonomyCommand,
    buildWorkspaceTaxonomy,
    generateTaxonomyHtml,
    buildAncestorGraph
};
