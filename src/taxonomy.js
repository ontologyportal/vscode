const vscode = require('vscode');
const path = require('path');
const { getSymbolTable } = require('./state');
const h = require('hyperscript');
const { Symbol, Term, TaxonomyEdge } = require('./parser');

/**
 * Command subscription callback to show taxonomy window for a symbol
 * @param {vscode.ExtensionContext} context 
 * @param {string} argSymbol The symbol to look for
 * @returns 
 */
async function showTaxonomyCommand(context, argSymbol) {
    let symbol = (typeof argSymbol === 'string') ? argSymbol : undefined;
    
    if (!symbol) {
        // Get the active text editor and the section to find the symbol
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
    
    // Create a new panel for the view
    const panel = vscode.window.createWebviewPanel(
        'suoKifTaxonomy',
        `Taxonomy: ${symbol}`,
        vscode.ViewColumn.Beside,
        { 
            enableScripts: true,
            localResourceRoots: [
                // The library for the mermaid diagram renderer, allow the webview to access it
                vscode.Uri.file(path.join(context.extensionPath, 'node_modules', 'mermaid', 'dist')),
                vscode.Uri.file(path.join(context.extensionPath, 'node_modules', 'svg-pan-zoom', 'dist'))
            ]
        }
    );

    // Grab the static HTML resources
    const mermaidUri = panel.webview.asWebviewUri(vscode.Uri.file(
        path.join(context.extensionPath, 'node_modules', 'mermaid', 'dist', 'mermaid.min.js')
    ));

    const svgPanZoomUri = panel.webview.asWebviewUri(vscode.Uri.file(
        path.join(context.extensionPath, 'node_modules', 'svg-pan-zoom', 'dist', 'svg-pan-zoom.min.js')
    ));

    // Keep track of the view changes so the user can go back to it
    /** @type {string[]} */
    let history = [];
    let currentIndex = -1;

    // Callback to update the panel
    /** @type {(targetSymbol: string, fromHistory: boolean) => void} */
    const updateWebview = async (targetSymbol, fromHistory = false) => {
        if (!fromHistory) {
            // We are creating a new view and NOT navigating backwards
            //  move the cursor
            if (currentIndex < history.length - 1) {
                history = history.slice(0, currentIndex + 1);
            }
            history.push(targetSymbol);
            currentIndex++;
        }

        // Panel title
        panel.title = `Taxonomy: ${targetSymbol}`;
        // Loading screen content
        const html = h('html', { lang: 'en' },
            h('body', { style: { fontFamily: 'sans-serif', padding: '10px' } },
                h('h3', `Loading taxonomy for ${targetSymbol}...`)
            )
        );
        panel.webview.html = `<!DOCTYPE html>${html.outerHTML}`;
        
        // Give the UI a moment to render the loading message
        await new Promise(resolve => setTimeout(resolve, 50));

        const sym = getSymbolTable().symbols[targetSymbol];
        if (!sym) {
            panel.webview.html = `<!DOCTYPE html>${h('html', { lang: 'en' },
                h('body', { style: { fontFamily: 'sans-serif', padding: '10px' } },
                    h('h3', `Unknown symbol: ${targetSymbol}`)
                )
            ).outerHTML}`;
            return;
        }

        const historyState = {
            canGoBack: currentIndex > 0,
            canGoForward: currentIndex < history.length - 1
        };

        // Get the symbol from the symbol table
        panel.webview.html = generateTaxonomyHtml(
            sym,
            mermaidUri,
            svgPanZoomUri,
            panel.webview.cspSource,
            historyState
        );
    };

    panel.webview.onDidReceiveMessage(
        message => {
            switch (message.command) {
                case 'openTaxonomy':
                    updateWebview(message.symbol);
                    return;
                case 'goBack':
                    if (currentIndex > 0) {
                        currentIndex--;
                        updateWebview(history[currentIndex], true);
                    }
                    return;
                case 'goForward':
                    if (currentIndex < history.length - 1) {
                        currentIndex++;
                        updateWebview(history[currentIndex], true);
                    }
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

/**
 * Generate an HTML page for a given term's taxonomy
 * @param {Symbol} symbol 
 * @param {string} mermaidUri 
 * @param {string} svgPanZoomUri 
 * @param {string} cspSource 
 * @param {{canGoBack: boolean, canGoForward: boolean}} historyState 
 * @returns {string} Generated HTML
 */
function generateTaxonomyHtml(symbol, mermaidUri, svgPanZoomUri, cspSource, historyState) {
    const targetLang = vscode.workspace.getConfiguration('sumo').get('general.language') || 'EnglishLanguage';
    const { canGoBack, canGoForward } = historyState || { canGoBack: false, canGoForward: false };
    // Build graph data for Mermaid
    /** @type {Term} */
    const term = symbol.forward;
    /** @type {Set<Term>} */
    const nodes = new Set([term]);
    /** @type {TaxonomyEdge[]} */
    const edges = [];

    // 1. Traverse Ancestors (Upwards)
    const queue = [term];
    const visited = new Set([term]);

    while (queue.length > 0) {
        /** @type {Term} */
        const curr = queue.shift();
        const parents = curr.taxonomy.incoming;
        parents.forEach(p => {
            // Add edge: Parent -> Child
            edges.push(p);
            nodes.add(p.from);

            if (!visited.has(p.from)) {
                visited.add(p.from);
                queue.push(p.from);
            }
        });
    }

    // 2. Direct Children (Downwards)
    // const children = childGraph[symbol] || [];
    // children.forEach(c => {
    //     edges.push({ from: symbol, to: c.name, label: c.type });
    //     nodes.add(c.name);
    // });

    // Get documentation
    let documentation = term.documentation.find(d => d.language === targetLang)?.text
        ?? "No documentation found in workspace.";

    // Linkify cross-references &%SYMBOL
    documentation = documentation.replace(/&%([a-zA-Z0-9_\-]+)/g, '<a href="#" onclick="openSymbol(\'$1\')">$1</a>');

    // Generate Mermaid String
    let mermaidGraph = 'graph TD\n';
    mermaidGraph += 'classDef default fill:#2d2d2d,stroke:#555,stroke-width:1px,color:#fff;\n';
    mermaidGraph += 'classDef target fill:#0e639c,stroke:#007acc,stroke-width:2px,color:#fff;\n';
    
    nodes.forEach(n => {
        const className = (n === term) ? 'target' : 'default';
        // We use the symbol itself as ID.
        mermaidGraph += `${n.name}["${n.name}"]:::${className}\n`;
        mermaidGraph += `click ${n.name} callOpenSymbol\n`;
    });

    edges.forEach(e => {
        mermaidGraph += `${e.from.name} -->|${e.relation}| ${e.to.name}\n`;
    });

    return `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' ${cspSource}; style-src 'unsafe-inline';">
            <script src="${mermaidUri}"></script>
            <script src="${svgPanZoomUri}"></script>
            <style>
                body { font-family: var(--vscode-font-family); padding: 20px; color: var(--vscode-editor-foreground); background-color: var(--vscode-editor-background); display: flex; flex-direction: column; height: 95vh; }
                h2 { color: var(--vscode-textLink-foreground); border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 5px; }
                .nav-buttons { margin-bottom: 15px; display: flex; gap: 10px; }
                .nav-btn {
                    background-color: var(--vscode-button-background);
                    color: var(--vscode-button-foreground);
                    border: none;
                    padding: 6px 12px;
                    cursor: pointer;
                }
                .nav-btn:hover:not(:disabled) { background-color: var(--vscode-button-hoverBackground); }
                .nav-btn:disabled { 
                    opacity: 0.5; cursor: default; background-color: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
                }
                .doc-block {
                    margin-bottom: 15px;
                    padding: 10px;
                    background-color: var(--vscode-textBlockQuote-background);
                    border-left: 4px solid var(--vscode-textBlockQuote-border);
                }
                .doc-block a {
                    color: var(--vscode-textLink-foreground);
                    text-decoration: none;
                }
                .doc-block a:hover {
                    text-decoration: underline;
                }
                .mermaid {
                    flex-grow: 1;
                    overflow: hidden;
                    border: 1px solid var(--vscode-panel-border);
                }
                .mermaid svg {
                    height: 100%;
                    width: 100%;
                }
            </style>
        </head>
        <body>
            <div class="nav-buttons">
                <button class="nav-btn" onclick="goBack()" ${canGoBack ? '' : 'disabled'}>&larr; Back</button>
                <button class="nav-btn" onclick="goForward()" ${canGoForward ? '' : 'disabled'}>Forward &rarr;</button>
            </div>
            <h1>Taxonomy: ${symbol.name}</h1>
            ${documentation ? `<div class="doc-block">${documentation}</div>` : ''}
            
            <div class="mermaid">
                ${mermaidGraph}
            </div>

            <script>
                const vscode = acquireVsCodeApi();
                
                // Initialize Mermaid
                const theme = document.body.classList.contains('vscode-dark') ? 'dark' : 'default';
                mermaid.initialize({ startOnLoad: false, theme: theme });

                // Global function for documentation links
                window.openSymbol = (sym) => {
                    vscode.postMessage({ command: 'openTaxonomy', symbol: sym });
                };

                // Global function for Mermaid clicks
                window.callOpenSymbol = (sym) => {
                    vscode.postMessage({ command: 'openTaxonomy', symbol: sym });
                };

                window.goBack = () => vscode.postMessage({ command: 'goBack' });
                window.goForward = () => vscode.postMessage({ command: 'goForward' });

                (async () => {
                    try {
                        await mermaid.run();
                        const svgElement = document.querySelector('.mermaid svg');
                        if (svgElement) {
                            svgElement.style.width = '100%';
                            svgElement.style.height = '100%';
                            svgElement.style.maxWidth = 'none';
                            
                            const panZoom = svgPanZoom(svgElement, {
                                zoomEnabled: true,
                                controlIconsEnabled: true,
                                fit: true,
                                center: true,
                                minZoom: 0.1
                            });
                            
                            // Force a resize and center to ensure it looks right
                            panZoom.resize();
                            panZoom.fit();
                            panZoom.center();
                            
                            window.addEventListener('resize', () => {
                                panZoom.resize();
                                panZoom.fit();
                                panZoom.center();
                            });
                        }
                    } catch (e) {
                        console.error('Mermaid/PanZoom error:', e);
                    }
                })();
            </script>
        </body>
        </html>
    `;
}

module.exports = {
    showTaxonomyCommand,
    generateTaxonomyHtml,
};
