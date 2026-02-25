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
    }
    
    /**
     * Initialize the local runtime interface
     * @param {vscode.ExtensionContext} context 
     * @returns {Promise<void>}
     */
    async initialize(context) {``
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
        
        // General imports
        const Files = jvm.java.nio.file.Files;
        const Paths = jvm.java.nio.file.Paths;
        const OpenOption = jvm.java.nio.file.OpenOption;
        const StandardOpenOption = jvm.java.nio.file.StandardOpenOption;
        
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

        let pw = null;
        try {
            const more = await gateway.newArray(jvm.java.lang.String, 0);
            const file = await Paths.get(fileName, more);
            const openOptions = await gateway.newArray(OpenOption, 1);
            await openOptions.set(0, await gateway.getField(StandardOpenOption, "CREATE"));
            const bufferedWriter = await Files.newBufferedWriter(file, openOptions);
            pw = await jvm.java.io.PrintWriter(bufferedWriter);
        } catch (e) {
            console.error(e);
            throw new Error(`Error opening ${fileName} to write: ${e}`);
        }

        if (!pw) throw new Error(`Error opening ${fileName} to write`);

        let conjectureFormula = null;
        if (conjecture) {
            conjectureFormula = await jvm.com.articulate.sigma.Formula(conjecture);
            // Test conjecture formula
            if (! (await conjectureFormula.toProlog())) throw new Error("Bad conjecture formula");
        }

        const outputFilename = await skbtptpkb.writeFile(fileName, conjectureFormula, isQuestion, pw);

        if (!outputFilename) throw new Error("Failed to generated TPTP for KB");

        return fileName;
    }

    /**
     * Perform a "Tell" operation to assert a statement into a knowledge base
     * @param {string} kbName - The name of the KB
     * @param {string} statement - The SUO-KIF statement to assert
     * @returns {Promise<string[]>} - Any errors or status messages
     */
    async tell(kbName, statement) {
        if (!this.initialized) throw new Error("Cannot utilize local sigma runtime before its initialized");
        console.log(this);
        const jvm = this.gateway.jvm;
        const KBmanager = await jvm.com.articulate.sigma.KBmanager;
        const mgr = await KBmanager.getMgr();
        const kb = await mgr.getKB(kbName);
        if (!kb) throw new Error(`Unknown KB: ${kbName}`);

        // sessionId can be empty or a default for extension usage
        const result = await kb.tell(statement, "");
        return result; // Usually an ArrayList of strings (errors/warnings)
    }

    /**
     * Perform an "Ask" operation to query a knowledge base
     * @param {string} kbName - The name of the KB
     * @param {string} query - The SUO-KIF query
     * @param {object} options - Options for the query (timeout, maxAnswers, engine)
     * @returns {Promise<object>} - The result including answers and proof
     */
    async ask(kbName, query, options = {}) {
        if (!this.initialized) throw new Error("Cannot utilize local sigma runtime before its initialized");

        const jvm = this.gateway.jvm;
        const KBmanager = await jvm.com.articulate.sigma.KBmanager;
        const mgr = await KBmanager.getMgr();
        const kb = await mgr.getKB(kbName);
        if (!kb) throw new Error(`Unknown KB: ${kbName}`);

        const timeout = options.timeout || 30;
        const maxAnswers = options.maxAnswers || 1;
        const engine = options.engine || 'vampire';

        let resultObj;
        if (engine === 'vampire') {
            resultObj = await kb.askVampire(query, timeout, maxAnswers, "");
        } else if (engine === 'eprover') {
            resultObj = await kb.askEProver(query, timeout, maxAnswers);
        } else {
            throw new Error(`Unsupported engine: ${engine}`);
        }

        const output = await resultObj.output;
        const qlist = await resultObj.qlist;
        const status = await resultObj.getResult();

        // Process proof if available
        const TPTP3ProofProcessor = await jvm.com.articulate.sigma.trans.TPTP3ProofProcessor;
        const tpp = await new TPTP3ProofProcessor();
        await tpp.parseProofOutput(output, query, kb, qlist);

        const answers = await tpp.answers; // ArrayList of answers
        const proof = await tpp.proof; // ArrayList of proof steps

        return {
            status,
            output,
            answers: await this.gateway.help.toArray(answers),
            proof: await this.gateway.help.toArray(proof)
        };
    }
}

module.exports = {
    LocalRuntimeRunner
}
