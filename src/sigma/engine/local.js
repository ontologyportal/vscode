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
            const { gateway, process: executor, kill } = launchGateway({
                classpath: cp.join(path.delimiter),
                mainClass: "com.articulate.sigma.SigmaBridge",
                readyPattern: /^SIGMA_READY/g
            });
            this.gateway = gateway; 
            this.executor = executor;
            this.killProcessCallback = kill;
        } catch (e) {
            throw new Error(`Error trying to start Sigma Java bridge: ${e}`);
        }

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
        await mgr.initializeOnce();

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
            const openOptions = await gateway.newArray(OpenOption, 0);
            await openOptions.set(0, await gateway.getField(StandardOpenOption, "CREATE"));
            const bufferedWriter = await Files.newBufferedWriter(file, openOptions);
            pw = await jvm.java.io.PrintWriter(bufferedWriter);
        } catch (e) {
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
}

module.exports = {
    LocalRuntimeRunner
}
