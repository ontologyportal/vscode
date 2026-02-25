/** Use java bindings to utilize local sigma to perform formula translations */

const { launchGateway } = require("js4j");
const { globSync } = require("glob");
const fs = require("fs");
const path = require("path");
const vscode = require("vscode");

// const { getSigmaPath } = require("./paths");

let initialized = false;

/**
 * @class LocalRuntimeRunner class to handle invoking the sigma Java runtime
 * @property {boolean} initialized Whether the runtime bridge socket was initialized
 * @property {null|Gateway} gateway The runtime bridge gateway, set to null before initialization (and after shutdown)
 * @property {null|WorkerJarExecutor} executor The runtime executor process, set to null before initialization (and after shutdown)
 * @property {null|() => void} killProcessCallback The callback to shutdown the executor
 */
class LocalRuntimeRunner {
    constructor() {
        this.initialized = false;
        this.gateway =  null;
        this.executor = null;
        this.killProcessCallback = null;
        this.dirtyKBs = new Set();
    }
    
    /**
     * Initialize the local runtime interface
     * @param {vscode.ExtensionContext} context 
     * @param {{stdout: (string) => void, stderr: (string) => void, close: () => void}} console 
     * @returns {Promise<void>}
     */
    async initialize(context, console) {
        // Check for redundant initialization
        if (this.initialized) return;

        // We need to find Sigma class paths
        // First check if the environment variable is set    
        let sigmaCP = process.env["SIGMA_CP"] || null;
        
        // If not try to dynamically locate the required java files
        if (!sigmaCP) {
            let sigmaSRC = getSigmaPath();
            if (!sigmaSRC) {
                throw new Error("Cannot locate your local Sigma installation");
            }
            if (!fs.existsSync(path.join(sigmaSRC, "build"))) {
                throw new Error("Your local Sigma installation is missing the build directory");
            }
            if (!fs.existsSync(path.join(sigmaSRC, "build", "sigmakee.jar"))) {
                throw new Error("Your local Sigma installation is missing the sigmakee.jar file");
            }
            if (!fs.existsSync(path.join(sigmaSRC, "lib"))) {
                throw new Error("Your local Sigma installation is missing the lib directory");
            }
            sigmaCP = `${path.join(sigmaSRC, "build", "sigmakee.jar")}:${path.join(sigmaSRC, "lib", "*")}`;
        }
    
        // Split the CP up into its consituents and resolve any globbing
        const cp = sigmaCP.split(path.delimiter).map(p => globSync(p)).flat();
    
        // Get the path to the worker jar and py4j jar
        cp.push(path.join(context.extensionPath, "lib", "py4j.jar"));
        cp.push(path.join(context.extensionPath, "lib", "SigmaBridge.jar"));
        
        try {
            const { gateway, process: executor, kill } = await launchGateway({
                classpath: cp.join(path.delimiter),
                mainClass: "com.articulate.sigma.SigmaBridge",
                readyPattern: /^SIGMA_READY/g,
                killConflict: true
            });
            this.gateway = gateway; 
            this.executor = executor;
            this.killProcessCallback = kill;
        } catch (e) {
            throw new Error(`Error trying to start Sigma Java bridge: ${e}`);
        }

        this.executor.stdout.setEncoding('utf-8');
        this.executor.stdout.on('data', function(data) {
            console.stdout(data);
        });

        this.executor.stderr.setEncoding('utf-8');
        this.executor.stderr.on('data', function(data) {
            console.stderr(data);
        });

        this.executor.on('close', function(code) {
            console.close();
        });

        // Get and initialize the manager
        const KBmanager = await this.gateway.jvm.com.articulate.sigma.KBmanager;
        let mgr = await KBmanager.getMgr();
        await mgr.initializeOnce();

        this.initialized = true;
    }

    /**
     * Shutdown the Java bridge and clean everything up
     */
    async stop() {
        if (!this.initialized || !this.killProcessCallback) return;
        await this.killProcessCallback();
        this.initialized = false;
        this.executor = null;
        this.killProcessCallback = null;
        this.gateway = null;
    }
    
    /**
     * Mark a knowledge base as needing reload before the next operation
     * @param {string} kbName
     */
    markDirty(kbName) {
        this.dirtyKBs.add(kbName);
    }

    /**
     * Reload all dirty knowledge bases and clear the dirty set
     * @returns {Promise<void>}
     */
    async reloadDirtyKBs() {
        if (!this.initialized || this.dirtyKBs.size === 0) return;
        for (const kbName of this.dirtyKBs) {
            await this.reloadKB(kbName);
        }
        this.dirtyKBs.clear();
    }

    /**
     * Reload a knowledge base (re-reads all constituent files from disk)
     * @param {string} kbName - The name of the KB to reload
     * @returns {Promise<void>}
     */
    async reloadKB(kbName) {
        if (!this.initialized) throw new Error("Cannot utilize local sigma runtime before its initialized");
        const jvm = this.gateway.jvm;
        const KBmanager = await jvm.com.articulate.sigma.KBmanager;
        const mgr = await KBmanager.getMgr();
        const kb = await mgr.getKB(kbName);
        if (!kb) throw new Error(`Unknown KB: ${kbName}`);
        await kb.reload();
    }

    /**
     * Write formulas to a TPTP file
     * @param {string} fileName - The output file path
     * @param {string} kbName - Name of the knowledge base to convert
     * @param {string|null} conjecture - Optional conjecture formula
     * @param {boolean} isQuestion - Whether the conjecture is a question
     * @returns {string} The file path written
     */
    async writeFile(fileName, kbName, conjecture = null, isQuestion = false) {
        if (!this.initialized) throw new Error("Cannot utilize local sigma runtime before its initialized");
        const jvm = this.gateway.jvm;
        const gateway = this.gateway;
        
        // Get and initialize the manager
        const KBmanager = await jvm.com.articulate.sigma.KBmanager;
        let mgr = await KBmanager.getMgr();

        // Next initialize the converstion object
        const skbtptpkb = await jvm.com.articulate.sigma.trans.SUMOKBtoTPTPKB();

        // Next find and set the appropriate KB
        mgr = await KBmanager.getMgr();
        const kb = await mgr.getKB(kbName);
        if (!kb) throw new Error(`Unknown KB: ${kbName}`);
        await gateway.setField(skbtptpkb, "kb", kb);

        // PrintWriter(String) creates or truncates the file and wraps it in a
        // BufferedWriter internally — no NIO OpenOption juggling required.
        let pw = null;
        try {
            pw = await jvm.java.io.PrintWriter(fileName);
        } catch (e) {
            const detail = e.getJavaMessage ? await e.getJavaMessage() : String(e);
            console.error(detail);
            throw new Error(`Error opening ${fileName} to write: ${detail}`);
        }

        if (!pw) throw new Error(`Error opening ${fileName} to write`);

        let conjectureFormula = null;
        if (conjecture) {
            conjectureFormula = await jvm.com.articulate.sigma.Formula(conjecture);
            // Test conjecture formula
            if (! (await conjectureFormula.toProlog())) throw new Error("Bad conjecture formula");
        }

        const outputFilename = await skbtptpkb.writeFile(fileName, conjectureFormula, isQuestion, pw);
        await pw.close();

        if (!outputFilename) throw new Error("Failed to generated TPTP for KB");

        return fileName;
    }

    /**
     * Perform a "Tell" operation to assert a statement into a knowledge base
     * @param {string} kbName - The name of the KB
     * @param {string} sessionID - The ID of the session to make the assertion to
     * @param {string} statement - The SUO-KIF statement to assert
     * @returns {Promise<string[]>} - Any errors or status messages
     */
    async tell(kbName, sessionID, statement) {
        if (!this.initialized) throw new Error("Cannot utilize local sigma runtime before its initialized");
        const jvm = this.gateway.jvm;
        const KBmanager = await jvm.com.articulate.sigma.KBmanager;
        const mgr = await KBmanager.getMgr();
        const kb = await mgr.getKB(kbName);
        if (!kb) throw new Error(`Unknown KB: ${kbName}`);

        let result;
        try {
            result = await kb.tell(statement, sessionID);
        } catch (e) {
            const detail = e.getJavaMessage ? await e.getJavaMessage() : String(e);
            if (detail && detail.includes('does not exist')) {
                throw new Error(
                    'KB.tell(String, String) is not available in your Sigma installation. ' +
                    'Please rebuild SigmaKEE from source and restart the extension.'
                );
            }
            throw new Error(`Error telling KB: ${detail}`);
        }
        return result;
    }

    /**
     * Perform an "Ask" operation to query a knowledge base
     * @param {string} kbName - The name of the KB
     * @param {string} sessionID - The ID of the session to query for
     * @param {string} query - The SUO-KIF query
     * @param {object} options - Options for the query (timeout, maxAnswers, engine, language)
     * @returns {Promise<{status: string, output: string[], answers: string[], proof: object[]}>}
     */
    async ask(kbName, sessionID, query, options = {}) {
        if (!this.initialized) throw new Error("Cannot utilize local sigma runtime before its initialized");

        const jvm     = this.gateway.jvm;
        const gateway = this.gateway;
        const KBmanager = await jvm.com.articulate.sigma.KBmanager;
        const mgr = await KBmanager.getMgr();
        const kb  = await mgr.getKB(kbName);
        if (!kb) throw new Error(`Unknown KB: ${kbName}`);

        const timeout    = options.timeout    || 30;
        const maxAnswers = options.maxAnswers || 1;
        const engine     = options.engine     || 'vampire';
        const language   = options.language   || 'fof';

        if (engine !== 'vampire' && engine !== 'eprover') {
            throw new Error(`Unsupported engine: ${engine}`);
        }
        if (language !== 'fof' && language !== 'tff' && language !== 'thf') {
            throw new Error(`Unsupported TPTP language: ${language}. Must be fof, tff, or thf.`);
        }

        // Set SUMOKBtoTPTPKB.lang before querying so Sigma generates the query
        // formula in the correct dialect.  gateway.setField uses py4j's FIELD_SET
        // command which only works on object instances (it calls obj.getClass()
        // internally), so we use Java reflection instead: Class.getField("lang").set(null, value)
        // is the standard way to write a public static field.
        const clazz = await jvm.java.lang.Class.forName('com.articulate.sigma.trans.SUMOKBtoTPTPKB');
        const langField = await clazz.getField('lang');
        await langField.set(null, language);

        // kb.askVampire / kb.askEProver return a Vampire / EProver object with:
        //   public List<String>    output  — raw prover output lines
        //   public StringBuilder   qlist   — query variable order for answer binding
        let resultObj;
        try {
            resultObj = engine === 'vampire'
                ? await kb.askVampire(query, timeout, maxAnswers, sessionID)
                : await kb.askEProver(query, timeout, maxAnswers, sessionID);
        } catch (e) {
            const detail = e.getJavaMessage ? await e.getJavaMessage() : String(e);
            throw new Error(`Error asking KB: ${detail}`);
        }

        if (!resultObj) throw new Error(`${engine} returned no result`);

        // output and qlist are public Java fields — access via gateway.getField
        const output = await gateway.getField(resultObj, "output");
        const qlist  = await gateway.getField(resultObj, "qlist");

        // TPTP3ProofProcessor.parseProofOutput(List<String>, String, KB, StringBuilder)
        // populates .status, .bindings (List<String>), and .proof (List<TPTPFormula>)
        const tpp = await jvm.com.articulate.sigma.trans.TPTP3ProofProcessor();
        try {
            await tpp.parseProofOutput(output, query, kb, qlist);
        } catch (e) {
            const detail = e.getJavaMessage ? await e.getJavaMessage() : String(e);
            throw new Error(`Error parsing proof: ${detail}`);
        }

        // status, bindings, proof are Java fields — access via gateway.getField
        const status   = await gateway.getField(tpp, "status");
        const bindings = await gateway.getField(tpp, "bindings");  // List<String>
        const proof    = await gateway.getField(tpp, "proof");     // List<TPTPFormula>

        // Convert TPTPFormula Java objects to plain JS objects so callers
        // don't need gateway access to render them.
        const proofSteps = await proof.toArray();
        const proofFormatted = await Promise.all(proofSteps.map(async step => {
            const supportsField = await gateway.getField(step, "supports"); // List<String>
            return {
                id:       await gateway.getField(step, "id"),
                formula:  await gateway.getField(step, "formula"),
                sumo:     await gateway.getField(step, "sumo"),
                infRule:  await gateway.getField(step, "infRule"),
                supports: await supportsField.toArray(),
            };
        }));

        return {
            status,
            output:  await output.toArray(),
            answers: await bindings.toArray(),
            proof:   proofFormatted,
        };
    }
}

module.exports = {
    LocalRuntimeRunner
}
